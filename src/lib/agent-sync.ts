/**
 * Agent Config Sync
 *
 * Reads agents from openclaw.json and upserts them into the MC database.
 * Used by both the /api/agents/sync endpoint and the startup scheduler.
 */

import { config } from './config'
import { query } from './postgres'
import { logAuditEvent } from './db'
import { eventBus } from './event-bus'
import { join, isAbsolute, resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { resolveWithin } from './paths'
import { logger } from './logger'
import { parseJsonRelaxed } from './json-relaxed'

interface OpenClawAgent {
  id: string
  name?: string
  default?: boolean
  workspace?: string
  agentDir?: string
  model?: {
    primary?: string
    fallbacks?: string[]
  }
  identity?: {
    name?: string
    theme?: string
    emoji?: string
  }
  subagents?: any
  sandbox?: {
    mode?: string
    workspaceAccess?: string
    scope?: string
    docker?: any
  }
  tools?: {
    allow?: string[]
    deny?: string[]
  }
  memorySearch?: any
}

export interface SyncResult {
  synced: number
  created: number
  updated: number
  agents: Array<{
    id: string
    name: string
    action: 'created' | 'updated' | 'unchanged'
  }>
  error?: string
}

export interface SyncDiff {
  inConfig: number
  inMC: number
  newAgents: string[]
  updatedAgents: string[]
  onlyInMC: string[]
}

function parseIdentityFromFile(content: string): { name?: string; theme?: string; emoji?: string; content?: string } {
  if (!content.trim()) return {}
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean)
  let name: string | undefined
  let theme: string | undefined
  let emoji: string | undefined

  for (const line of lines) {
    if (!name && line.startsWith('#')) {
      name = line.replace(/^#+\s*/, '').trim()
      continue
    }

    if (!theme) {
      const themeMatch = line.match(/^theme\s*:\s*(.+)$/i)
      if (themeMatch?.[1]) {
        theme = themeMatch[1].trim()
        continue
      }
    }

    if (!emoji) {
      const emojiMatch = line.match(/^emoji\s*:\s*(.+)$/i)
      if (emojiMatch?.[1]) {
        emoji = emojiMatch[1].trim()
      }
    }
  }

  return {
    ...(name ? { name } : {}),
    ...(theme ? { theme } : {}),
    ...(emoji ? { emoji } : {}),
    content: lines.slice(0, 8).join('\n'),
  }
}

function parseToolsFromFile(content: string): { allow?: string[]; raw?: string } {
  if (!content.trim()) return {}

  const parsedTools = new Set<string>()
  for (const line of content.split('\n')) {
    const cleaned = line.trim()
    if (!cleaned || cleaned.startsWith('#')) continue

    const listMatch = cleaned.match(/^[-*]\s+`?([^`]+?)`?\s*$/)
    if (listMatch?.[1]) {
      parsedTools.add(listMatch[1].trim())
      continue
    }

    const inlineMatch = cleaned.match(/^`([^`]+)`$/)
    if (inlineMatch?.[1]) {
      parsedTools.add(inlineMatch[1].trim())
    }
  }

  const allow = [...parsedTools].filter(Boolean)
  return {
    ...(allow.length > 0 ? { allow } : {}),
    raw: content.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 24).join('\n'),
  }
}

function getConfigPath(): string | null {
  return config.openclawConfigPath || null
}

function resolveAgentWorkspacePath(workspace: string): string {
  if (isAbsolute(workspace)) return resolve(workspace)
  if (!config.openclawStateDir) {
    throw new Error('OPENCLAW_STATE_DIR not configured')
  }
  return resolveWithin(config.openclawStateDir, workspace)
}

function readWorkspaceFile(workspace: string | undefined, filename: string): string | null {
  if (!workspace) return null
  try {
    const safeWorkspace = resolveAgentWorkspacePath(workspace)
    const safePath = resolveWithin(safeWorkspace, filename)
    if (existsSync(safePath)) {
      return readFileSync(safePath, 'utf-8')
    }
  } catch (err) {
    logger.warn({ err, workspace, filename }, 'Failed to read workspace file')
  }
  return null
}

export function enrichAgentConfigFromWorkspace(configData: any): any {
  if (!configData || typeof configData !== 'object') return configData
  const workspace = typeof configData.workspace === 'string' ? configData.workspace : undefined
  if (!workspace) return configData

  const identityFile = readWorkspaceFile(workspace, 'identity.md')
  const toolsFile = readWorkspaceFile(workspace, 'TOOLS.md')

  const mergedIdentity = {
    ...parseIdentityFromFile(identityFile || ''),
    ...((configData.identity && typeof configData.identity === 'object') ? configData.identity : {}),
  }
  const mergedTools = {
    ...parseToolsFromFile(toolsFile || ''),
    ...((configData.tools && typeof configData.tools === 'object') ? configData.tools : {}),
  }

  return {
    ...configData,
    identity: Object.keys(mergedIdentity).length > 0 ? mergedIdentity : configData.identity,
    tools: Object.keys(mergedTools).length > 0 ? mergedTools : configData.tools,
  }
}

async function readOpenClawAgents(): Promise<OpenClawAgent[]> {
  const configPath = getConfigPath()
  if (!configPath) throw new Error('OPENCLAW_CONFIG_PATH not configured')

  const { readFile } = require('fs/promises')
  const raw = await readFile(configPath, 'utf-8')
  const parsed = parseJsonRelaxed<any>(raw)
  return parsed?.agents?.list || []
}

function mapAgentToMC(agent: OpenClawAgent): {
  name: string
  role: string
  config: any
  soul_content: string | null
} {
  const name = agent.identity?.name || agent.name || agent.id
  const role = agent.identity?.theme || 'agent'
  const configData = enrichAgentConfigFromWorkspace({
    openclawId: agent.id,
    model: agent.model,
    identity: agent.identity,
    sandbox: agent.sandbox,
    tools: agent.tools,
    subagents: agent.subagents,
    memorySearch: agent.memorySearch,
    workspace: agent.workspace,
    agentDir: agent.agentDir,
    isDefault: agent.default || false,
  })

  const soul_content = readWorkspaceFile(agent.workspace, 'soul.md')

  return { name, role, config: configData, soul_content }
}

export async function syncAgentsFromConfig(actor: string = 'system'): Promise<SyncResult> {
  let agents: OpenClawAgent[]
  try {
    agents = await readOpenClawAgents()
  } catch (err: any) {
    return { synced: 0, created: 0, updated: 0, agents: [], error: err.message }
  }

  if (agents.length === 0) {
    return { synced: 0, created: 0, updated: 0, agents: [] }
  }

  const now = Math.floor(Date.now() / 1000)
  let created = 0
  let updated = 0
  const results: SyncResult['agents'] = []

  for (const agent of agents) {
    const mapped = mapAgentToMC(agent)
    const configJson = JSON.stringify(mapped.config)

    const { rows: existingRows } = await query<{ id: number; name: string; role: string; config: string; soul_content: string | null }>(
      'SELECT id, name, role, config, soul_content FROM agents WHERE name = ?',
      [mapped.name]
    )
    const existing = existingRows[0]

    if (existing) {
      const existingConfig = existing.config || '{}'
      const existingSoul = existing.soul_content || null
      const configChanged = existingConfig !== configJson || existing.role !== mapped.role
      const soulChanged = mapped.soul_content !== null && mapped.soul_content !== existingSoul

      if (configChanged || soulChanged) {
        const soulToWrite = mapped.soul_content ?? existingSoul
        await query(
          `UPDATE agents SET role = ?, config = ?, soul_content = ?, updated_at = ? WHERE name = ?`,
          [mapped.role, configJson, soulToWrite, now, mapped.name]
        )
        results.push({ id: agent.id, name: mapped.name, action: 'updated' })
        updated++
      } else {
        results.push({ id: agent.id, name: mapped.name, action: 'unchanged' })
      }
    } else {
      await query(
        `INSERT INTO agents (name, role, soul_content, status, created_at, updated_at, config)
         VALUES (?, ?, ?, 'offline', ?, ?, ?)`,
        [mapped.name, mapped.role, mapped.soul_content, now, now, configJson]
      )
      results.push({ id: agent.id, name: mapped.name, action: 'created' })
      created++
    }
  }

  const synced = agents.length

  if (created > 0 || updated > 0) {
    void logAuditEvent({
      action: 'agent_config_sync',
      actor,
      detail: { synced, created, updated, agents: results.filter(a => a.action !== 'unchanged').map(a => a.name) },
    })

    eventBus.broadcast('agent.created', { type: 'sync', synced, created, updated })
  }

  logger.info({ synced, created, updated }, 'Agent sync complete')
  return { synced, created, updated, agents: results }
}

export async function previewSyncDiff(): Promise<SyncDiff> {
  let agents: OpenClawAgent[]
  try {
    agents = await readOpenClawAgents()
  } catch {
    return { inConfig: 0, inMC: 0, newAgents: [], updatedAgents: [], onlyInMC: [] }
  }

  const { rows: allMCAgents } = await query<{ name: string; role: string; config: string }>(
    'SELECT name, role, config FROM agents'
  )
  const mcNames = new Set(allMCAgents.map(a => a.name))

  const newAgents: string[] = []
  const updatedAgents: string[] = []
  const configNames = new Set<string>()

  for (const agent of agents) {
    const mapped = mapAgentToMC(agent)
    configNames.add(mapped.name)

    const existing = allMCAgents.find(a => a.name === mapped.name)
    if (!existing) {
      newAgents.push(mapped.name)
    } else {
      const configJson = JSON.stringify(mapped.config)
      if (existing.config !== configJson || existing.role !== mapped.role) {
        updatedAgents.push(mapped.name)
      }
    }
  }

  const onlyInMC = allMCAgents
    .map(a => a.name)
    .filter(name => !configNames.has(name))

  return {
    inConfig: agents.length,
    inMC: allMCAgents.length,
    newAgents,
    updatedAgents,
    onlyInMC,
  }
}

export async function writeAgentToConfig(agentConfig: any): Promise<void> {
  const configPath = getConfigPath()
  if (!configPath) throw new Error('OPENCLAW_CONFIG_PATH not configured')

  const { readFile, writeFile } = require('fs/promises')
  const raw = await readFile(configPath, 'utf-8')
  const parsed = parseJsonRelaxed<any>(raw)

  if (!parsed.agents) parsed.agents = {}
  if (!parsed.agents.list) parsed.agents.list = []

  const idx = parsed.agents.list.findIndex((a: any) => a.id === agentConfig.id)
  if (idx >= 0) {
    parsed.agents.list[idx] = deepMerge(parsed.agents.list[idx], agentConfig)
  } else {
    parsed.agents.list.push(agentConfig)
  }

  await writeFile(configPath, JSON.stringify(parsed, null, 2) + '\n')
}

function deepMerge(target: any, source: any): any {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key])
    } else {
      result[key] = source[key]
    }
  }
  return result
}
