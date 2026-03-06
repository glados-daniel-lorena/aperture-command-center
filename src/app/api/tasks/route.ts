import { NextRequest, NextResponse } from 'next/server';
import { Task, db_helpers } from '@/lib/db';
import { query, withTransaction } from '@/lib/postgres';
import { eventBus } from '@/lib/event-bus';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { validateBody, createTaskSchema, bulkUpdateTaskStatusSchema } from '@/lib/validation';
import { resolveMentionRecipients } from '@/lib/mentions';
import { normalizeTaskCreateStatus } from '@/lib/task-status';

function formatTicketRef(prefix?: string | null, num?: number | null): string | undefined {
  if (!prefix || typeof num !== 'number' || !Number.isFinite(num) || num <= 0) return undefined
  return `${prefix}-${String(num).padStart(3, '0')}`
}

function mapTaskRow(task: any): Task & { tags: string[]; metadata: Record<string, unknown> } {
  return {
    ...task,
    tags: task.tags ? JSON.parse(task.tags) : [],
    metadata: task.metadata ? JSON.parse(task.metadata) : {},
    ticket_ref: formatTicketRef(task.project_prefix, task.project_ticket_no),
  }
}

async function resolveProjectId(q: typeof query, workspaceId: number, requestedProjectId?: number): Promise<number> {
  if (typeof requestedProjectId === 'number' && Number.isFinite(requestedProjectId)) {
    const project = (await q(`
      SELECT id FROM projects
      WHERE id = ? AND workspace_id = ? AND status = 'active'
      LIMIT 1
    `, [requestedProjectId, workspaceId])).rows[0] as { id: number } | undefined
    if (project) return project.id
  }

  const fallback = (await q(`
    SELECT id FROM projects
    WHERE workspace_id = ? AND status = 'active'
    ORDER BY CASE WHEN slug = 'general' THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `, [workspaceId])).rows[0] as { id: number } | undefined

  if (!fallback) {
    throw new Error('No active project available in workspace')
  }
  return fallback.id
}

async function hasAegisApproval(taskId: number, workspaceId: number): Promise<boolean> {
  const review = (await query(`
    SELECT status FROM quality_reviews
    WHERE task_id = ? AND reviewer = 'aegis' AND workspace_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `, [taskId, workspaceId])).rows[0] as { status?: string } | undefined
  return review?.status === 'approved'
}

/**
 * GET /api/tasks - List all tasks with optional filtering
 * Query params: status, assigned_to, priority, project_id, limit, offset
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const workspaceId = auth.user.workspace_id;
    const { searchParams } = new URL(request.url);

    // Parse query parameters
    const status = searchParams.get('status');
    const assigned_to = searchParams.get('assigned_to');
    const priority = searchParams.get('priority');
    const projectIdParam = Number.parseInt(searchParams.get('project_id') || '', 10);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
    const offset = parseInt(searchParams.get('offset') || '0');

    // Build dynamic query
    let sql = `
      SELECT t.*, p.name as project_name, p.ticket_prefix as project_prefix
      FROM tasks t
      LEFT JOIN projects p
        ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      WHERE t.workspace_id = ?
    `;
    const params: any[] = [workspaceId];

    if (status) {
      sql += ' AND t.status = ?';
      params.push(status);
    }

    if (assigned_to) {
      sql += ' AND t.assigned_to = ?';
      params.push(assigned_to);
    }

    if (priority) {
      sql += ' AND t.priority = ?';
      params.push(priority);
    }

    if (Number.isFinite(projectIdParam)) {
      sql += ' AND t.project_id = ?';
      params.push(projectIdParam);
    }

    sql += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const tasks = (await query(sql, params)).rows as Task[];

    // Parse JSON fields
    const tasksWithParsedData = tasks.map(mapTaskRow);

    // Get total count for pagination
    let countSql = 'SELECT COUNT(*) as total FROM tasks WHERE workspace_id = ?';
    const countParams: any[] = [workspaceId];
    if (status) {
      countSql += ' AND status = ?';
      countParams.push(status);
    }
    if (assigned_to) {
      countSql += ' AND assigned_to = ?';
      countParams.push(assigned_to);
    }
    if (priority) {
      countSql += ' AND priority = ?';
      countParams.push(priority);
    }
    if (Number.isFinite(projectIdParam)) {
      countSql += ' AND project_id = ?';
      countParams.push(projectIdParam);
    }
    const countRow = (await query(countSql, countParams)).rows[0] as { total: number };

    return NextResponse.json({ tasks: tasksWithParsedData, total: countRow.total, page: Math.floor(offset / limit) + 1, limit });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks error');
    return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }
}

/**
 * POST /api/tasks - Create a new task
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const workspaceId = auth.user.workspace_id;
    const validated = await validateBody(request, createTaskSchema);
    if ('error' in validated) return validated.error;
    const body = validated.data;

    const user = auth.user
    const actor = user.display_name || user.username || 'system'
    const {
      title,
      description,
      status,
      priority = 'medium',
      project_id,
      assigned_to,
      due_date,
      estimated_hours,
      actual_hours,
      outcome,
      error_message,
      resolution,
      feedback_rating,
      feedback_notes,
      retry_count = 0,
      completed_at,
      tags = [],
      metadata = {}
    } = body;
    const normalizedStatus = normalizeTaskCreateStatus(status, assigned_to)

    // Check for duplicate title
    const existingTask = (await query('SELECT id FROM tasks WHERE title = ? AND workspace_id = ?', [title, workspaceId])).rows[0];
    if (existingTask) {
      return NextResponse.json({ error: 'Task with this title already exists' }, { status: 409 });
    }

    const now = Math.floor(Date.now() / 1000);
    const mentionResolution = await resolveMentionRecipients(description || '', workspaceId);
    if (mentionResolution.unresolved.length > 0) {
      return NextResponse.json({
        error: `Unknown mentions: ${mentionResolution.unresolved.map((m) => `@${m}`).join(', ')}`,
        missing_mentions: mentionResolution.unresolved
      }, { status: 400 });
    }

    const resolvedCompletedAt = completed_at ?? (normalizedStatus === 'done' ? now : null)

    const taskId = await withTransaction(async (txQuery) => {
      const resolvedProjectId = await resolveProjectId(txQuery, workspaceId, project_id)
      await txQuery(`
        UPDATE projects
        SET ticket_counter = ticket_counter + 1, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER
        WHERE id = ? AND workspace_id = ?
      `, [resolvedProjectId, workspaceId])
      const row = (await txQuery(`
        SELECT ticket_counter FROM projects
        WHERE id = ? AND workspace_id = ?
      `, [resolvedProjectId, workspaceId])).rows[0] as { ticket_counter: number } | undefined
      if (!row || !row.ticket_counter) throw new Error('Failed to allocate project ticket number')

      const result = await txQuery(`
        INSERT INTO tasks (
          title, description, status, priority, project_id, project_ticket_no, assigned_to, created_by,
          created_at, updated_at, due_date, estimated_hours, actual_hours,
          outcome, error_message, resolution, feedback_rating, feedback_notes, retry_count, completed_at,
          tags, metadata, workspace_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [
        title,
        description,
        normalizedStatus,
        priority,
        resolvedProjectId,
        row.ticket_counter,
        assigned_to,
        actor,
        now,
        now,
        due_date,
        estimated_hours,
        actual_hours,
        outcome,
        error_message,
        resolution,
        feedback_rating,
        feedback_notes,
        retry_count,
        resolvedCompletedAt,
        JSON.stringify(tags),
        JSON.stringify(metadata),
        workspaceId,
      ])
      return result.rows[0].id as number
    })

    // Log activity
    await db_helpers.logActivity('task_created', 'task', taskId, actor, `Created task: ${title}`, {
      title,
      status: normalizedStatus,
      priority,
      assigned_to,
      ...(outcome ? { outcome } : {})
    }, workspaceId);

    if (actor) {
      await db_helpers.ensureTaskSubscription(taskId, actor, workspaceId)
    }

    for (const recipient of mentionResolution.recipients) {
      await db_helpers.ensureTaskSubscription(taskId, recipient, workspaceId);
      if (recipient === actor) continue;
      await db_helpers.createNotification(
        recipient,
        'mention',
        'You were mentioned in a task description',
        `${actor} mentioned you in task "${title}"`,
        'task',
        taskId,
        workspaceId
      );
    }

    // Create notification if assigned
    if (assigned_to) {
      await db_helpers.ensureTaskSubscription(taskId, assigned_to, workspaceId)
      await db_helpers.createNotification(
        assigned_to,
        'assignment',
        'Task Assigned',
        `You have been assigned to task: ${title}`,
        'task',
        taskId,
        workspaceId
      );
    }

    // Fetch the created task
    const createdTask = (await query(`
      SELECT t.*, p.name as project_name, p.ticket_prefix as project_prefix
      FROM tasks t
      LEFT JOIN projects p
        ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      WHERE t.id = ? AND t.workspace_id = ?
    `, [taskId, workspaceId])).rows[0] as Task;
    const parsedTask = mapTaskRow(createdTask);

    // Broadcast to SSE clients
    eventBus.broadcast('task.created', parsedTask);

    return NextResponse.json({ task: parsedTask }, { status: 201 });
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks error');
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}

/**
 * PUT /api/tasks - Update multiple tasks (for drag-and-drop status changes)
 */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const workspaceId = auth.user.workspace_id;
    const validated = await validateBody(request, bulkUpdateTaskStatusSchema);
    if ('error' in validated) return validated.error;
    const { tasks } = validated.data;

    const now = Math.floor(Date.now() / 1000);
    const actor = auth.user.username

    const activityLogs: Array<{ taskId: number; oldStatus: string; newStatus: string }> = []

    await withTransaction(async (txQuery) => {
      for (const task of tasks) {
        const oldTask = (await txQuery('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?', [task.id, workspaceId])).rows[0] as Task;
        if (!oldTask) continue;

        if (task.status === 'done') {
          const review = (await txQuery(`
            SELECT status FROM quality_reviews
            WHERE task_id = ? AND reviewer = 'aegis' AND workspace_id = ?
            ORDER BY created_at DESC LIMIT 1
          `, [task.id, workspaceId])).rows[0] as { status?: string } | undefined
          if (review?.status !== 'approved') {
            throw new Error(`Aegis approval required for task ${task.id}`)
          }
          await txQuery(`
            UPDATE tasks
            SET status = ?, updated_at = ?, completed_at = COALESCE(completed_at, ?)
            WHERE id = ? AND workspace_id = ?
          `, [task.status, now, now, task.id, workspaceId]);
        } else {
          await txQuery(`
            UPDATE tasks
            SET status = ?, updated_at = ?
            WHERE id = ? AND workspace_id = ?
          `, [task.status, now, task.id, workspaceId]);
        }

        if (oldTask.status !== task.status) {
          activityLogs.push({ taskId: task.id, oldStatus: oldTask.status, newStatus: task.status })
        }
      }
    });

    // Log activities after transaction
    for (const { taskId, oldStatus, newStatus } of activityLogs) {
      await db_helpers.logActivity(
        'task_updated',
        'task',
        taskId,
        actor,
        `Task moved from ${oldStatus} to ${newStatus}`,
        { oldStatus, newStatus },
        workspaceId
      );
    }

    // Broadcast status changes to SSE clients
    for (const task of tasks) {
      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: task.status,
        updated_at: Math.floor(Date.now() / 1000),
      });
    }

    return NextResponse.json({ success: true, updated: tasks.length });
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/tasks error');
    const message = error instanceof Error ? error.message : 'Failed to update tasks'
    if (message.includes('Aegis approval required')) {
      return NextResponse.json({ error: message }, { status: 403 });
    }
    return NextResponse.json({ error: 'Failed to update tasks' }, { status: 500 });
  }
}
