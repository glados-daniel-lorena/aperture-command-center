import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/postgres'
import { ensureInitialized } from '@/lib/db'
import { logger } from '@/lib/logger'

const VALID_STATUSES = ['active', 'working', 'blocked', 'offline', 'idle', 'busy', 'error'] as const
type AgentStatus = typeof VALID_STATUSES[number]

/** Check x-api-key against AGENT_API_KEY env var */
function checkAgentApiKey(request: NextRequest): boolean {
  const agentKey = (process.env.AGENT_API_KEY || '').trim()
  const provided = (request.headers.get('x-api-key') || '').trim()
  logger.info({
    hasEnvKey: !!agentKey,
    envKeyLen: agentKey.length,
    providedLen: provided.length,
    envKeyPrefix: agentKey.substring(0, 12),
    providedPrefix: provided.substring(0, 12),
    match: provided.length > 0 && provided === agentKey,
  }, 'AGENT_API_KEY auth check')
  if (!agentKey) return false
  return provided.length > 0 && provided === agentKey
}

/**
 * PATCH /api/agents/[id]/status
 * Agents call this to update their live status, current task, and current ticket.
 * Also checks for pending cold escalation responses to deliver to the agent.
 *
 * Auth: x-api-key (AGENT_API_KEY env var) OR session cookie (operator+)
 * Body: { status?, current_task?, current_ticket?, session_key? }
 * Response: { agent, pendingResponses? }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureInitialized()

  const agentKeyOk = checkAgentApiKey(request)
  if (!agentKeyOk) {
    // Fall back to session auth
    const { requireRole } = await import('@/lib/auth')
    const auth = await requireRole(request, 'operator')
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  try {
    const { id } = await params
    const workspaceId = 1  // TODO: derive from auth when multi-workspace

    // Accept both numeric id and agent name slug
    const numericId = parseInt(id)
    let agentRow: { id: number; name: string; session_key?: string } | undefined

    if (!isNaN(numericId)) {
      const { rows } = await query<{ id: number; name: string; session_key?: string }>(
        'SELECT id, name, session_key FROM agents WHERE id = ? AND workspace_id = ?',
        [numericId, workspaceId]
      )
      agentRow = rows[0]
    } else {
      // Try by name (case-insensitive slug: "atlas", "p-body", etc.)
      const { rows } = await query<{ id: number; name: string; session_key?: string }>(
        'SELECT id, name, session_key FROM agents WHERE LOWER(name) = LOWER(?) AND workspace_id = ?',
        [id, workspaceId]
      )
      agentRow = rows[0]
    }

    if (!agentRow) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const { status, current_task, current_ticket, session_key } = body

    if (status && !VALID_STATUSES.includes(status as AgentStatus)) {
      return NextResponse.json(
        { error: `status must be one of: ${VALID_STATUSES.join(', ')}` },
        { status: 400 }
      )
    }

    const now = Math.floor(Date.now() / 1000)
    const setParts: string[] = ['last_active = ?', 'last_seen = ?', 'updated_at = ?']
    const updateValues: any[] = [now, now, now]

    if (status) { setParts.push('status = ?'); updateValues.push(status) }
    if (current_task !== undefined) { setParts.push('current_task = ?'); updateValues.push(current_task) }
    if (current_ticket !== undefined) { setParts.push('current_ticket = ?'); updateValues.push(current_ticket) }
    if (session_key !== undefined) { setParts.push('session_key = ?'); updateValues.push(session_key) }

    updateValues.push(agentRow.id, workspaceId)
    const { rows: updated } = await query(
      `UPDATE agents SET ${setParts.join(', ')} WHERE id = ? AND workspace_id = ? RETURNING *`,
      updateValues
    )

    // Check for pending cold escalation responses (delivery_status = 'cold')
    // and return them so the agent can act on them
    const { rows: pendingEscalations } = await query(
      `SELECT id, response, title FROM escalations
       WHERE session_key = ? AND delivery_status = 'cold' AND status = 'responded' AND workspace_id = ?
       ORDER BY responded_at ASC
       LIMIT 5`,
      [session_key || agentRow.session_key || '', workspaceId]
    )

    const result: Record<string, any> = { agent: updated[0] }

    if (pendingEscalations.length > 0) {
      result.pendingResponses = pendingEscalations.map((e: any) => ({
        escalationId: e.id,
        title: e.title,
        message: `[ESCALATION RESPONSE from Daniel] ${e.response}. Escalation ID: ${e.id}. Resume your task.`,
      }))

      // Mark them as delivered now that we're returning them
      const ids = pendingEscalations.map((e: any) => e.id)
      for (const eid of ids) {
        await query(
          `UPDATE escalations SET delivery_status = 'delivered' WHERE id = ? AND workspace_id = ?`,
          [eid, workspaceId]
        ).catch(() => {})
      }
    }

    return NextResponse.json(result)
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/agents/[id]/status error')
    return NextResponse.json({ error: 'Failed to update agent status' }, { status: 500 })
  }
}
