import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/postgres'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * GET /api/webhooks/deliveries - Get delivery history for a webhook
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const workspaceId = auth.user.workspace_id ?? 1
    const { searchParams } = new URL(request.url)
    const webhookId = searchParams.get('webhook_id')
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200)
    const offset = parseInt(searchParams.get('offset') || '0')

    let sql = `
      SELECT wd.*, w.name as webhook_name, w.url as webhook_url
      FROM webhook_deliveries wd
      JOIN webhooks w ON wd.webhook_id = w.id AND w.workspace_id = wd.workspace_id
      WHERE wd.workspace_id = ?
    `
    const params: any[] = [workspaceId]

    if (webhookId) {
      sql += ' AND wd.webhook_id = ?'
      params.push(webhookId)
    }

    sql += ' ORDER BY wd.created_at DESC LIMIT ? OFFSET ?'
    params.push(limit, offset)

    const deliveries = (await query(sql, params)).rows

    let countSql = 'SELECT COUNT(*) as count FROM webhook_deliveries WHERE workspace_id = ?'
    const countParams: any[] = [workspaceId]
    if (webhookId) {
      countSql += ' AND webhook_id = ?'
      countParams.push(webhookId)
    }
    const { count: total } = (await query(countSql, countParams)).rows[0] as { count: number }

    return NextResponse.json({ deliveries, total })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/webhooks/deliveries error')
    return NextResponse.json({ error: 'Failed to fetch deliveries' }, { status: 500 })
  }
}
