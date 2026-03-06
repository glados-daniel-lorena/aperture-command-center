import { logAuditEvent } from './db'
import { query } from './postgres'
import { syncAgentsFromConfig } from './agent-sync'
import { config, ensureDirExists } from './config'
import { join, dirname } from 'path'
import { readdirSync, statSync, unlinkSync } from 'fs'
import { logger } from './logger'
import { processWebhookRetries } from './webhooks'
import { syncClaudeSessions } from './claude-sessions'
import { pruneGatewaySessionsOlderThan } from './sessions'

const BACKUP_DIR = join(dirname(config.dbPath), 'backups')

interface ScheduledTask {
  name: string
  intervalMs: number
  lastRun: number | null
  nextRun: number
  enabled: boolean
  running: boolean
  lastResult?: { ok: boolean; message: string; timestamp: number }
}

const tasks: Map<string, ScheduledTask> = new Map()
let tickInterval: ReturnType<typeof setInterval> | null = null

async function isSettingEnabled(key: string, defaultValue: boolean): Promise<boolean> {
  try {
    const { rows } = await query<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
    if (rows[0]) return rows[0].value === 'true'
    return defaultValue
  } catch {
    return defaultValue
  }
}

async function getSettingNumber(key: string, defaultValue: number): Promise<number> {
  try {
    const { rows } = await query<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
    if (rows[0]) return parseInt(rows[0].value) || defaultValue
    return defaultValue
  } catch {
    return defaultValue
  }
}

/** Run a database backup (not supported with Neon Postgres — use Neon's built-in backups) */
async function runBackup(): Promise<{ ok: boolean; message: string }> {
  return { ok: true, message: 'Database backups are managed by Neon Postgres' }
}

/** Run data cleanup based on retention settings */
async function runCleanup(): Promise<{ ok: boolean; message: string }> {
  try {
    const now = Math.floor(Date.now() / 1000)
    const ret = config.retention
    let totalDeleted = 0

    const targets = [
      { table: 'activities', column: 'created_at', days: ret.activities },
      { table: 'audit_log', column: 'created_at', days: ret.auditLog },
      { table: 'notifications', column: 'created_at', days: ret.notifications },
      { table: 'pipeline_runs', column: 'created_at', days: ret.pipelineRuns },
    ]

    for (const { table, column, days } of targets) {
      if (days <= 0) continue
      const cutoff = now - days * 86400
      try {
        const { rowCount } = await query(`DELETE FROM ${table} WHERE ${column} < ?`, [cutoff])
        totalDeleted += rowCount
      } catch {
        // Table might not exist
      }
    }

    // Clean token usage file
    if (ret.tokenUsage > 0) {
      try {
        const { readFile, writeFile } = require('fs/promises')
        const raw = await readFile(config.tokensPath, 'utf-8')
        const data = JSON.parse(raw)
        const cutoffMs = Date.now() - ret.tokenUsage * 86400000
        const kept = data.filter((r: any) => r.timestamp >= cutoffMs)
        const removed = data.length - kept.length

        if (removed > 0) {
          await writeFile(config.tokensPath, JSON.stringify(kept, null, 2))
          totalDeleted += removed
        }
      } catch {
        // No token file
      }
    }

    if (ret.gatewaySessions > 0) {
      const sessionCleanup = pruneGatewaySessionsOlderThan(ret.gatewaySessions)
      totalDeleted += sessionCleanup.deleted
    }

    if (totalDeleted > 0) {
      void logAuditEvent({
        action: 'auto_cleanup',
        actor: 'scheduler',
        detail: { total_deleted: totalDeleted },
      })
    }

    return { ok: true, message: `Cleaned ${totalDeleted} stale record${totalDeleted === 1 ? '' : 's'}` }
  } catch (err: any) {
    return { ok: false, message: `Cleanup failed: ${err.message}` }
  }
}

/** Check agent liveness - mark agents offline if not seen recently */
async function runHeartbeatCheck(): Promise<{ ok: boolean; message: string }> {
  try {
    const now = Math.floor(Date.now() / 1000)
    const timeoutMinutes = await getSettingNumber('general.agent_timeout_minutes', 10)
    const threshold = now - timeoutMinutes * 60

    const { rows: staleAgents } = await query<{ id: number; name: string; status: string; last_seen: number | null }>(
      `SELECT id, name, status, last_seen FROM agents
       WHERE status != 'offline' AND (last_seen IS NULL OR last_seen < ?)`,
      [threshold]
    )

    if (staleAgents.length === 0) {
      return { ok: true, message: 'All agents healthy' }
    }

    const names: string[] = []
    for (const agent of staleAgents) {
      await query('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', ['offline', now, agent.id])
      await query(
        `INSERT INTO activities (type, entity_type, entity_id, actor, description)
         VALUES ('agent_status_change', 'agent', ?, 'heartbeat', ?)`,
        [agent.id, `Agent "${agent.name}" marked offline (no heartbeat for ${timeoutMinutes}m)`]
      )
      names.push(agent.name)

      try {
        await query(
          `INSERT INTO notifications (recipient, type, title, message, source_type, source_id)
           VALUES ('system', 'heartbeat', ?, ?, 'agent', ?)`,
          [
            `Agent offline: ${agent.name}`,
            `Agent "${agent.name}" was marked offline after ${timeoutMinutes} minutes without heartbeat`,
            agent.id,
          ]
        )
      } catch { /* notification creation failed */ }
    }

    void logAuditEvent({
      action: 'heartbeat_check',
      actor: 'scheduler',
      detail: { marked_offline: names },
    })

    return { ok: true, message: `Marked ${staleAgents.length} agent(s) offline: ${names.join(', ')}` }
  } catch (err: any) {
    return { ok: false, message: `Heartbeat check failed: ${err.message}` }
  }
}

const DAILY_MS = 24 * 60 * 60 * 1000
const FIVE_MINUTES_MS = 5 * 60 * 1000
const TICK_MS = 60 * 1000 // Check every minute

/** Initialize the scheduler */
export function initScheduler() {
  if (tickInterval) return // Already running

  // Auto-sync agents from openclaw.json on startup
  syncAgentsFromConfig('startup').catch(err => {
    logger.warn({ err }, 'Agent auto-sync failed')
  })

  // Register tasks
  const now = Date.now()
  // Stagger the initial runs: backup at ~3 AM, cleanup at ~4 AM (relative to process start)
  const msUntilNextBackup = getNextDailyMs(3)
  const msUntilNextCleanup = getNextDailyMs(4)

  tasks.set('auto_backup', {
    name: 'Auto Backup',
    intervalMs: DAILY_MS,
    lastRun: null,
    nextRun: now + msUntilNextBackup,
    enabled: true,
    running: false,
  })

  tasks.set('auto_cleanup', {
    name: 'Auto Cleanup',
    intervalMs: DAILY_MS,
    lastRun: null,
    nextRun: now + msUntilNextCleanup,
    enabled: true,
    running: false,
  })

  tasks.set('agent_heartbeat', {
    name: 'Agent Heartbeat Check',
    intervalMs: FIVE_MINUTES_MS,
    lastRun: null,
    nextRun: now + FIVE_MINUTES_MS,
    enabled: true,
    running: false,
  })

  tasks.set('webhook_retry', {
    name: 'Webhook Retry',
    intervalMs: TICK_MS, // Every 60s, matching scheduler tick resolution
    lastRun: null,
    nextRun: now + TICK_MS,
    enabled: true,
    running: false,
  })

  tasks.set('claude_session_scan', {
    name: 'Claude Session Scan',
    intervalMs: TICK_MS, // Every 60s — lightweight file stat checks
    lastRun: null,
    nextRun: now + 5_000, // First scan 5s after startup
    enabled: true,
    running: false,
  })

  // Start the tick loop
  tickInterval = setInterval(tick, TICK_MS)
  logger.info('Scheduler initialized - backup at ~3AM, cleanup at ~4AM, heartbeat every 5m, webhook retry every 60s, claude scan every 60s')
}

/** Calculate ms until next occurrence of a given hour (UTC) */
function getNextDailyMs(hour: number): number {
  const now = new Date()
  const next = new Date(now)
  next.setUTCHours(hour, 0, 0, 0)
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next.getTime() - now.getTime()
}

/** Check and run due tasks */
async function tick() {
  const now = Date.now()

  for (const [id, task] of tasks) {
    if (task.running || now < task.nextRun) continue

    // Check if this task is enabled in settings (heartbeat is always enabled)
    const settingKey = id === 'auto_backup' ? 'general.auto_backup'
      : id === 'auto_cleanup' ? 'general.auto_cleanup'
      : id === 'webhook_retry' ? 'webhooks.retry_enabled'
      : id === 'claude_session_scan' ? 'general.claude_session_scan'
      : 'general.agent_heartbeat'
    const defaultEnabled = id === 'agent_heartbeat' || id === 'webhook_retry' || id === 'claude_session_scan'
    if (!(await isSettingEnabled(settingKey, defaultEnabled))) continue

    task.running = true
    try {
      const result = id === 'auto_backup' ? await runBackup()
        : id === 'agent_heartbeat' ? await runHeartbeatCheck()
        : id === 'webhook_retry' ? await processWebhookRetries()
        : id === 'claude_session_scan' ? await syncClaudeSessions()
        : await runCleanup()
      task.lastResult = { ...result, timestamp: now }
    } catch (err: any) {
      task.lastResult = { ok: false, message: err.message, timestamp: now }
    } finally {
      task.running = false
      task.lastRun = now
      task.nextRun = now + task.intervalMs
    }
  }
}

/** Get scheduler status (for API) */
export async function getSchedulerStatus() {
  const result: Array<{
    id: string
    name: string
    enabled: boolean
    lastRun: number | null
    nextRun: number
    running: boolean
    lastResult?: { ok: boolean; message: string; timestamp: number }
  }> = []

  for (const [id, task] of tasks) {
    const settingKey = id === 'auto_backup' ? 'general.auto_backup'
      : id === 'auto_cleanup' ? 'general.auto_cleanup'
      : id === 'webhook_retry' ? 'webhooks.retry_enabled'
      : id === 'claude_session_scan' ? 'general.claude_session_scan'
      : 'general.agent_heartbeat'
    const defaultEnabled = id === 'agent_heartbeat' || id === 'webhook_retry' || id === 'claude_session_scan'
    result.push({
      id,
      name: task.name,
      enabled: await isSettingEnabled(settingKey, defaultEnabled),
      lastRun: task.lastRun,
      nextRun: task.nextRun,
      running: task.running,
      lastResult: task.lastResult,
    })
  }

  return result
}

/** Manually trigger a scheduled task */
export async function triggerTask(taskId: string): Promise<{ ok: boolean; message: string }> {
  if (taskId === 'auto_backup') return runBackup()
  if (taskId === 'auto_cleanup') return runCleanup()
  if (taskId === 'agent_heartbeat') return runHeartbeatCheck()
  if (taskId === 'webhook_retry') return processWebhookRetries()
  if (taskId === 'claude_session_scan') return syncClaudeSessions()
  return { ok: false, message: `Unknown task: ${taskId}` }
}

/** Stop the scheduler */
export function stopScheduler() {
  if (tickInterval) {
    clearInterval(tickInterval)
    tickInterval = null
  }
}
