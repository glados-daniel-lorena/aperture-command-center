import { query } from './postgres'

export interface MentionTarget {
  handle: string
  recipient: string
  type: 'user' | 'agent'
  display: string
  role?: string
}

export interface MentionResolution {
  tokens: string[]
  unresolved: string[]
  recipients: string[]
  resolved: MentionTarget[]
}

const MENTION_PATTERN = /(^|[^A-Za-z0-9._-])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g

function normalizeAgentHandle(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

export function parseMentions(text: string): string[] {
  if (!text || typeof text !== 'string') return []

  const found: string[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null

  while ((match = MENTION_PATTERN.exec(text)) !== null) {
    const token = String(match[2] || '').trim()
    if (!token) continue
    const key = token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    found.push(token)
  }

  return found
}

export async function getMentionTargets(workspaceId: number): Promise<MentionTarget[]> {
  const targets: MentionTarget[] = []
  const seenHandles = new Set<string>()

  const { rows: users } = await query<{ username: string; display_name?: string | null }>(
    `SELECT username, display_name FROM users WHERE workspace_id = ? ORDER BY username ASC`,
    [workspaceId]
  )

  for (const user of users) {
    const username = String(user.username || '').trim()
    if (!username) continue
    const handle = username.toLowerCase()
    if (seenHandles.has(handle)) continue
    seenHandles.add(handle)
    targets.push({
      handle,
      recipient: username,
      type: 'user',
      display: user.display_name?.trim() || username,
    })
  }

  const { rows: agents } = await query<{ name: string; role?: string | null; config?: string | null }>(
    `SELECT name, role, config FROM agents WHERE workspace_id = ? ORDER BY name ASC`,
    [workspaceId]
  )

  for (const agent of agents) {
    const recipient = String(agent.name || '').trim()
    if (!recipient) continue

    let openclawId: string | null = null
    try {
      const parsed = agent.config ? JSON.parse(agent.config) : null
      if (parsed && typeof parsed.openclawId === 'string' && parsed.openclawId.trim()) {
        openclawId = parsed.openclawId.trim()
      }
    } catch {
      // ignore invalid config JSON for mention indexing
    }

    const candidateHandles = [openclawId, normalizeAgentHandle(recipient), recipient.toLowerCase()]
      .filter((value): value is string => Boolean(value))

    for (const rawHandle of candidateHandles) {
      const handle = rawHandle.toLowerCase()
      if (!handle || seenHandles.has(handle)) continue
      seenHandles.add(handle)
      targets.push({
        handle,
        recipient,
        type: 'agent',
        display: recipient,
        role: agent.role || undefined,
      })
    }
  }

  return targets
}

export async function resolveMentionRecipients(text: string, workspaceId: number): Promise<MentionResolution> {
  const tokens = parseMentions(text)
  if (tokens.length === 0) {
    return { tokens: [], unresolved: [], recipients: [], resolved: [] }
  }

  const targets = await getMentionTargets(workspaceId)
  const byHandle = new Map<string, MentionTarget>()
  for (const target of targets) {
    byHandle.set(target.handle.toLowerCase(), target)
  }

  const resolved: MentionTarget[] = []
  const unresolved: string[] = []
  const recipientSeen = new Set<string>()

  for (const token of tokens) {
    const key = token.toLowerCase()
    const target = byHandle.get(key)
    if (!target) {
      unresolved.push(token)
      continue
    }
    if (!recipientSeen.has(target.recipient)) {
      recipientSeen.add(target.recipient)
      resolved.push(target)
    }
  }

  return {
    tokens,
    unresolved,
    recipients: resolved.map((item) => item.recipient),
    resolved,
  }
}
