import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/postgres'
import { ensureInitialized } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * PUT /api/escalations/[id]
 * Respond to or resolve an escalation.
 * Body: { response?, status? } — status: 'responded' | 'resolved'
 *
 * Delivery model: poll-based.
 * Session injection via gateway is not possible (sessions_send is internal only).
 * Agents poll GET /api/escalations?agent_id=X&status=responded on each cron run.
 * delivery_status is always 'pending_poll' after a response is saved.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    await ensureInitialized()
    const { id } = await params
    const escalationId = parseInt(id)
    if (!Number.isFinite(escalationId)) {
      return NextResponse.json({ error: 'Invalid escalation id' }, { status: 400 })
    }

    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()
    const { response, status } = body

    // Fetch the existing escalation
    const { rows: existing } = await query(
      'SELECT * FROM escalations WHERE id = ? AND workspace_id = ?',
      [escalationId, workspaceId]
    )
    if (existing.length === 0) {
      return NextResponse.json({ error: 'Escalation not found' }, { status: 404 })
    }
    const escalation = existing[0] as {
      id: number
      agent_name: string
      agent_id?: string
      session_key?: string
      title: string
      status: string
      [key: string]: any
    }

    const now = Math.floor(Date.now() / 1000)
    let sql = 'UPDATE escalations SET'
    const setParts: string[] = []
    const updateParams: any[] = []

    if (response !== undefined) {
      setParts.push(' response = ?')
      updateParams.push(response)
    }

    if (status === 'responded') {
      setParts.push(' status = ?', ' responded_at = ?')
      updateParams.push('responded', now)
    } else if (status === 'resolved') {
      setParts.push(' status = ?', ' resolved_at = ?')
      updateParams.push('resolved', now)
    } else if (status === 'open') {
      setParts.push(' status = ?')
      updateParams.push('open')
    }

    if (setParts.length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    // Delivery is poll-based — agent picks up response on next cron run
    const deliveryStatus = response !== undefined ? 'pending_poll' : escalation.delivery_status
    if (response !== undefined) {
      setParts.push(' delivery_status = ?')
      updateParams.push(deliveryStatus)
    }

    sql += setParts.join(',') + ' WHERE id = ? AND workspace_id = ? RETURNING *'
    updateParams.push(escalationId, workspaceId)

    const { rows } = await query(sql, updateParams)

    return NextResponse.json({
      escalation: rows[0],
      delivery: {
        status: deliveryStatus ?? 'no_session',
        message: response !== undefined
          ? `Response saved. ${escalation.agent_name} will pick it up on their next cron run via polling.`
          : 'Status updated.',
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/escalations/[id] error')
    return NextResponse.json({ error: 'Failed to update escalation' }, { status: 500 })
  }
}

/**
 * GET /api/escalations/[id]
 * Fetch a single escalation by ID.
 * Used by agents polling for their response after submitting an escalation.
 * Auth: session cookie OR x-api-key (AGENT_API_KEY)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureInitialized()

  // Allow agents with API key OR logged-in users
  const agentKey = (process.env.AGENT_API_KEY || '').trim()
  const providedKey = (request.headers.get('x-api-key') || '').trim()
  const agentKeyOk = agentKey && providedKey === agentKey

  if (!agentKeyOk) {
    const auth = await requireRole(request, 'viewer')
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  try {
    const { id } = await params
    const escalationId = parseInt(id)
    if (!Number.isFinite(escalationId)) {
      return NextResponse.json({ error: 'Invalid escalation id' }, { status: 400 })
    }

    const { rows } = await query(
      'SELECT * FROM escalations WHERE id = ?',
      [escalationId]
    )

    if (rows.length === 0) {
      return NextResponse.json({ error: 'Escalation not found' }, { status: 404 })
    }

    return NextResponse.json({ escalation: rows[0] })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/escalations/[id] error')
    return NextResponse.json({ error: 'Failed to fetch escalation' }, { status: 500 })
  }
}
