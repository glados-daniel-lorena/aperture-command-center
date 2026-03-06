import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { query } from '@/lib/db'

function safeParseJson(str: string): any {
  try { return JSON.parse(str) } catch { return str }
}

/**
 * GET /api/audit - Query audit log (admin only)
 * Query params: action, actor, limit, offset, since, until
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action')
  const actor = searchParams.get('actor')
  const limit = Math.min(parseInt(searchParams.get('limit') || '1000'), 10000)
  const offset = parseInt(searchParams.get('offset') || '0')
  const since = searchParams.get('since')
  const until = searchParams.get('until')

  const conditions: string[] = []
  const params: any[] = []

  if (action) {
    conditions.push('action = ?')
    params.push(action)
  }
  if (actor) {
    conditions.push('actor = ?')
    params.push(actor)
  }
  if (since) {
    conditions.push('created_at >= ?')
    params.push(parseInt(since))
  }
  if (until) {
    conditions.push('created_at <= ?')
    params.push(parseInt(until))
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const { rows: [countRow] } = await query(`SELECT COUNT(*) as count FROM audit_log ${where}`, params)
  const total = (countRow as any).count

  const { rows } = await query(
    `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  )

  return NextResponse.json({
    events: rows.map((row: any) => ({
      ...row,
      detail: row.detail ? safeParseJson(row.detail) : null,
    })),
    total,
    limit,
    offset,
  })
}
