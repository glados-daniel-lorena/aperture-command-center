import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/postgres'
import { ensureInitialized } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

const VALID_PRIORITIES = ['blocked', 'question', 'fyi'] as const
const VALID_STATUSES = ['open', 'responded', 'resolved', 'all'] as const

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
 * Create a new escalation (called by agents)
 * Body: { agent_name, project?, priority, title, description, context? }
 */
export async function POST(request: NextRequest) {
  // Allow agents calling with API key OR logged-in users
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    await ensureInitialized()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()

    const { agent_name, project, priority, title, description, context } = body

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
      `INSERT INTO escalations (workspace_id, agent_name, project, priority, title, description, context, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', EXTRACT(EPOCH FROM NOW())::INTEGER)
       RETURNING *`,
      [workspaceId, agent_name, project ?? null, priority, title, description, context ?? null]
    )

    return NextResponse.json({ escalation: rows[0] }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/escalations error')
    return NextResponse.json({ error: 'Failed to create escalation' }, { status: 500 })
  }
}
