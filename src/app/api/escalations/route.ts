import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/postgres'
import { ensureInitialized } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { gatewaySend } from '@/lib/gateway'

const VALID_PRIORITIES = ['blocked', 'question', 'fyi'] as const
const VALID_STATUSES = ['open', 'responded', 'resolved', 'all'] as const

/** Emoji prefix by priority for Discord notifications */
const PRIORITY_EMOJI: Record<string, string> = {
  blocked: '🔴 BLOCKED',
  question: '🟡 QUESTION',
  fyi: '🟢 FYI',
}

/**
 * Checks x-api-key against AGENT_API_KEY env var for agent access.
 * Returns true if the key matches.
 */
function checkAgentApiKey(request: NextRequest): boolean {
  const agentKey = (process.env.AGENT_API_KEY || '').trim()
  if (!agentKey) return false
  const provided = (request.headers.get('x-api-key') || '').trim()
  return provided.length > 0 && provided === agentKey
}

/**
 * GET /api/escalations
 * Query params: status, priority, limit, offset
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    await ensureInitialized()
    const { searchParams } = new URL(request.url)
    const workspaceId = auth.user.workspace_id ?? 1
    const status = searchParams.get('status') || 'open'
    const priority = searchParams.get('priority') || 'all'
    const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 500)
    const offset = parseInt(searchParams.get('offset') || '0')

    let sql = 'SELECT * FROM escalations WHERE workspace_id = ?'
    const params: any[] = [workspaceId]

    if (status !== 'all') {
      sql += ' AND status = ?'
      params.push(status)
    }

    if (priority !== 'all' && VALID_PRIORITIES.includes(priority as any)) {
      sql += ' AND priority = ?'
      params.push(priority)
    }

    // Sort by priority order then date
    sql += ` ORDER BY CASE priority WHEN 'blocked' THEN 0 WHEN 'question' THEN 1 ELSE 2 END, created_at DESC`
    sql += ' LIMIT ? OFFSET ?'
    params.push(limit, offset)

    const { rows } = await query(sql, params)

    // Count open escalations for badge
    const { rows: countRows } = await query(
      `SELECT COUNT(*) as count FROM escalations WHERE workspace_id = ? AND status = 'open'`,
      [workspaceId]
    )
    const openCount = parseInt(String(countRows[0]?.count ?? 0))

    return NextResponse.json({ escalations: rows, openCount })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/escalations error')
    return NextResponse.json({ error: 'Failed to fetch escalations' }, { status: 500 })
  }
}

/**
 * POST /api/escalations
 * Create a new escalation (called by agents or UI)
 * Body: { agent_name, agent_id?, session_key?, project?, priority, title, description, context? }
 *
 * Auth: session cookie (operator+) OR x-api-key (AGENT_API_KEY env var)
 */
export async function POST(request: NextRequest) {
  await ensureInitialized()

  // Allow agents calling with AGENT_API_KEY or logged-in users
  const agentKeyOk = checkAgentApiKey(request)
  let workspaceId = 1

  if (!agentKeyOk) {
    const auth = await requireRole(request, 'viewer')
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
    workspaceId = auth.user.workspace_id ?? 1
  }

  try {
    const body = await request.json()
    const { agent_name, agent_id, session_key, project, priority, title, description, context } = body

    if (!agent_name || typeof agent_name !== 'string') {
      return NextResponse.json({ error: 'agent_name is required' }, { status: 400 })
    }
    if (!title || typeof title !== 'string') {
      return NextResponse.json({ error: 'title is required' }, { status: 400 })
    }
    if (!description || typeof description !== 'string') {
      return NextResponse.json({ error: 'description is required' }, { status: 400 })
    }
    if (!priority || !VALID_PRIORITIES.includes(priority)) {
      return NextResponse.json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` }, { status: 400 })
    }

    const { rows } = await query(
      `INSERT INTO escalations
         (workspace_id, agent_name, agent_id, session_key, project, priority, title, description, context, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', EXTRACT(EPOCH FROM NOW())::INTEGER)
       RETURNING *`,
      [
        workspaceId,
        agent_name,
        agent_id ?? null,
        session_key ?? null,
        project ?? null,
        priority,
        title,
        description,
        context ?? null,
      ]
    )

    const escalation = rows[0]

    // Fire-and-forget Discord notification to Daniel
    void notifyDaniel(escalation).catch((err) => {
      logger.warn({ err }, 'Failed to notify Daniel of new escalation')
    })

    return NextResponse.json({ escalation }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/escalations error')
    return NextResponse.json({ error: 'Failed to create escalation' }, { status: 500 })
  }
}

/**
 * Sends a Discord notification to Daniel when an agent submits an escalation.
 * Routes through the OpenClaw gateway sessions_send to GLaDOS session
 * (which relays to #glados-daniel Discord channel).
 */
async function notifyDaniel(escalation: any): Promise<void> {
  const prefix = PRIORITY_EMOJI[escalation.priority] || '⚪'
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://aperture-command-center-silk.vercel.app'

  // Send to GLaDOS session — GLaDOS will route to Daniel's Discord
  // Target: #glados-daniel channel (1479291940548776049)
  const message = `${prefix} — **${escalation.agent_name}** needs your input: ${escalation.title}\nRespond at ${appUrl}/escalations`

  // Use the gateway to sessions_send to GLaDOS
  // GLaDOS session key for discord channel
  const gladosSessionKey = 'agent:glados:discord:channel:1479291940548776049'
  await gatewaySend(gladosSessionKey, `[ESCALATION ALERT] ${message}`)
}
