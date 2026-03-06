import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/postgres'
import { ensureInitialized } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * PUT /api/escalations/[id]
 * Respond to or resolve an escalation
 * Body: { response?, status? } — status: 'responded' | 'resolved'
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
      if (response !== undefined && !setParts.includes(' response = ?')) {
        setParts.push(' response = ?')
        updateParams.push(response)
      }
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

    sql += setParts.join(',') + ' WHERE id = ? AND workspace_id = ? RETURNING *'
    updateParams.push(escalationId, workspaceId)

    const { rows } = await query(sql, updateParams)

    return NextResponse.json({ escalation: rows[0] })
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/escalations/[id] error')
    return NextResponse.json({ error: 'Failed to update escalation' }, { status: 500 })
  }
}
