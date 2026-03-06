import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/postgres'
import { requireRole } from '@/lib/auth'
import { randomBytes } from 'crypto'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { validateBody, createWebhookSchema } from '@/lib/validation'

/**
 * GET /api/webhooks - List all webhooks with delivery stats
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const workspaceId = auth.user.workspace_id ?? 1
    const webhooks = (await query(`
      SELECT w.*,
        (SELECT COUNT(*) FROM webhook_deliveries wd WHERE wd.webhook_id = w.id AND wd.workspace_id = w.workspace_id) as total_deliveries,
        (SELECT COUNT(*) FROM webhook_deliveries wd WHERE wd.webhook_id = w.id AND wd.workspace_id = w.workspace_id AND wd.status_code BETWEEN 200 AND 299) as successful_deliveries,
        (SELECT COUNT(*) FROM webhook_deliveries wd WHERE wd.webhook_id = w.id AND wd.workspace_id = w.workspace_id AND (wd.error IS NOT NULL OR wd.status_code NOT BETWEEN 200 AND 299)) as failed_deliveries
      FROM webhooks w
      WHERE w.workspace_id = ?
      ORDER BY w.created_at DESC
    `, [workspaceId])).rows as any[]

    const maxRetries = parseInt(process.env.MC_WEBHOOK_MAX_RETRIES || '5', 10) || 5
    const result = webhooks.map((wh) => ({
      ...wh,
      events: JSON.parse(wh.events || '["*"]'),
      secret: wh.secret ? '••••••' + wh.secret.slice(-4) : null,
      enabled: !!wh.enabled,
      consecutive_failures: wh.consecutive_failures ?? 0,
      circuit_open: (wh.consecutive_failures ?? 0) >= maxRetries,
    }))

    return NextResponse.json({ webhooks: result })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/webhooks error')
    return NextResponse.json({ error: 'Failed to fetch webhooks' }, { status: 500 })
  }
}

/**
 * POST /api/webhooks - Create a new webhook
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const workspaceId = auth.user.workspace_id ?? 1
    const validated = await validateBody(request, createWebhookSchema)
    if ('error' in validated) return validated.error
    const body = validated.data
    const { name, url, events, generate_secret } = body

    const secret = generate_secret !== false ? randomBytes(32).toString('hex') : null
    const eventsJson = JSON.stringify(events || ['*'])

    const dbResult = await query(`
      INSERT INTO webhooks (name, url, secret, events, created_by, workspace_id)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [name, url, secret, eventsJson, auth.user.username, workspaceId])

    return NextResponse.json({
      id: dbResult.rows[0].id,
      name,
      url,
      secret, // Show full secret only on creation
      events: events || ['*'],
      enabled: true,
      message: 'Webhook created. Save the secret - it won\'t be shown again in full.',
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/webhooks error')
    return NextResponse.json({ error: 'Failed to create webhook' }, { status: 500 })
  }
}

/**
 * PUT /api/webhooks - Update a webhook
 */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()
    const { id, name, url, events, enabled, regenerate_secret, reset_circuit } = body

    if (!id) {
      return NextResponse.json({ error: 'Webhook ID is required' }, { status: 400 })
    }

    const existing = (await query(
      'SELECT * FROM webhooks WHERE id = ? AND workspace_id = ?',
      [id, workspaceId]
    )).rows[0] as any
    if (!existing) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    if (url) {
      try { new URL(url) } catch {
        return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
      }
    }

    const updates: string[] = ['updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER']
    const params: any[] = []

    if (name !== undefined) { updates.push('name = ?'); params.push(name) }
    if (url !== undefined) { updates.push('url = ?'); params.push(url) }
    if (events !== undefined) { updates.push('events = ?'); params.push(JSON.stringify(events)) }
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0) }

    if (reset_circuit) {
      updates.push('consecutive_failures = 0')
      updates.push('enabled = 1')
    }

    let newSecret: string | null = null
    if (regenerate_secret) {
      newSecret = randomBytes(32).toString('hex')
      updates.push('secret = ?')
      params.push(newSecret)
    }

    params.push(id, workspaceId)
    await query(`UPDATE webhooks SET ${updates.join(', ')} WHERE id = ? AND workspace_id = ?`, params)

    return NextResponse.json({
      success: true,
      ...(newSecret ? { secret: newSecret, message: 'New secret generated. Save it now.' } : {}),
    })
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/webhooks error')
    return NextResponse.json({ error: 'Failed to update webhook' }, { status: 500 })
  }
}

/**
 * DELETE /api/webhooks - Delete a webhook
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const workspaceId = auth.user.workspace_id ?? 1
    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Request body required' }, { status: 400 }) }
    const id = body.id

    if (!id) {
      return NextResponse.json({ error: 'Webhook ID is required' }, { status: 400 })
    }

    await query('DELETE FROM webhook_deliveries WHERE webhook_id = ? AND workspace_id = ?', [id, workspaceId])
    const result = await query('DELETE FROM webhooks WHERE id = ? AND workspace_id = ?', [id, workspaceId])

    if ((result.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true, deleted: result.rowCount })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/webhooks error')
    return NextResponse.json({ error: 'Failed to delete webhook' }, { status: 500 })
  }
}
