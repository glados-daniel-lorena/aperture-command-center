import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/postgres'
import { ensureInitialized } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { gatewaySend } from '@/lib/gateway'

/**
 * PUT /api/escalations/[id]
 * Respond to or resolve an escalation.
 * Body: { response?, status? } — status: 'responded' | 'resolved'
 *
 * After saving the response, attempts to deliver it to the agent's session
 * via the OpenClaw gateway sessions_send. Sets delivery_status accordingly.
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

    // Fetch the existing escalation (includes session_key for delivery)
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

    // Attempt delivery to agent session before persisting delivery_status
    let deliveryStatus: 'delivered' | 'cold' | 'no_session' = 'no_session'
    let deliveryError: string | undefined

    if (response !== undefined && escalation.session_key) {
      const deliveryMessage =
        `[ESCALATION RESPONSE from Daniel] ${response}. Escalation ID: ${escalationId}. Resume your task.`

      try {
        await gatewaySend(escalation.session_key, deliveryMessage)
        deliveryStatus = 'delivered'
      } catch (err: any) {
        deliveryStatus = 'cold'
        deliveryError = err?.message || String(err)
        logger.warn({ err, escalationId, sessionKey: escalation.session_key }, 'Gateway delivery failed — agent session cold')
      }
    }

    // Persist delivery_status
    setParts.push(' delivery_status = ?')
    updateParams.push(deliveryStatus)

    sql += setParts.join(',') + ' WHERE id = ? AND workspace_id = ? RETURNING *'
    updateParams.push(escalationId, workspaceId)

    const { rows } = await query(sql, updateParams)

    return NextResponse.json({
      escalation: rows[0],
      delivery: {
        status: deliveryStatus,
        error: deliveryError,
        message:
          deliveryStatus === 'delivered'
            ? `Response delivered to ${escalation.agent_name}`
            : deliveryStatus === 'cold'
              ? `Agent session cold — response saved, will deliver on next contact`
              : `No session key on record for this escalation — response saved only`,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/escalations/[id] error')
    return NextResponse.json({ error: 'Failed to update escalation' }, { status: 500 })
  }
}
