import { NextRequest, NextResponse } from 'next/server'
import { db_helpers } from '@/lib/db'
import { query } from '@/lib/postgres'
import { requireRole } from '@/lib/auth'
import { validateBody, qualityReviewSchema } from '@/lib/validation'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { eventBus } from '@/lib/event-bus'

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = auth.user.workspace_id ?? 1;
    const taskIdsParam = searchParams.get('taskIds')
    const taskId = parseInt(searchParams.get('taskId') || '')

    if (taskIdsParam) {
      const ids = taskIdsParam
        .split(',')
        .map((id) => parseInt(id.trim()))
        .filter((id) => !Number.isNaN(id))

      if (ids.length === 0) {
        return NextResponse.json({ error: 'taskIds must include at least one numeric id' }, { status: 400 })
      }

      const placeholders = ids.map(() => '?').join(',')
      const rows = (await query(`
        SELECT * FROM quality_reviews
        WHERE task_id IN (${placeholders}) AND workspace_id = ?
        ORDER BY task_id ASC, created_at DESC
      `, [...ids, workspaceId])).rows as Array<{ task_id: number; reviewer?: string; status?: string; created_at?: number }>

      const byTask: Record<number, { status?: string; reviewer?: string; created_at?: number } | null> = {}
      for (const id of ids) {
        byTask[id] = null
      }

      for (const row of rows) {
        const existing = byTask[row.task_id]
        if (!existing || (row.created_at || 0) > (existing.created_at || 0)) {
          byTask[row.task_id] = { status: row.status, reviewer: row.reviewer, created_at: row.created_at }
        }
      }

      return NextResponse.json({ latest: byTask })
    }

    if (isNaN(taskId)) {
      return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
    }

    const reviews = (await query(`
      SELECT * FROM quality_reviews
      WHERE task_id = ? AND workspace_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `, [taskId, workspaceId])).rows

    return NextResponse.json({ reviews })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/quality-review error')
    return NextResponse.json({ error: 'Failed to fetch quality reviews' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const validated = await validateBody(request, qualityReviewSchema)
    if ('error' in validated) return validated.error
    const { taskId, reviewer, status, notes } = validated.data

    const workspaceId = auth.user.workspace_id ?? 1;

    const task = (await query(
      'SELECT id, title FROM tasks WHERE id = ? AND workspace_id = ?',
      [taskId, workspaceId]
    )).rows[0] as any
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    const result = await query(`
      INSERT INTO quality_reviews (task_id, reviewer, status, notes, workspace_id)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id
    `, [taskId, reviewer, status, notes, workspaceId])

    await db_helpers.logActivity(
      'quality_review',
      'task',
      taskId,
      reviewer,
      `Quality review ${status} for task: ${task.title}`,
      { status, notes },
      workspaceId
    )

    // Auto-advance task to 'done' when aegis approves
    if (status === 'approved' && reviewer === 'aegis') {
      await query(
        'UPDATE tasks SET status = ?, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ? AND workspace_id = ?',
        ['done', taskId, workspaceId]
      )
      eventBus.broadcast('task.status_changed', {
        id: taskId,
        status: 'done',
        updated_at: Math.floor(Date.now() / 1000),
      })
    }

    return NextResponse.json({ success: true, id: result.rows[0].id })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/quality-review error')
    return NextResponse.json({ error: 'Failed to create quality review' }, { status: 500 })
  }
}
