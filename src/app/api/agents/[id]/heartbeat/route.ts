import { NextRequest, NextResponse } from 'next/server';
import { db_helpers } from '@/lib/db';
import { query } from '@/lib/postgres';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';

/**
 * GET /api/agents/[id]/heartbeat - Agent heartbeat check
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const resolvedParams = await params;
    const agentId = resolvedParams.id;
    const workspaceId = auth.user.workspace_id ?? 1;

    let agent: any;
    if (isNaN(Number(agentId))) {
      agent = (await query('SELECT * FROM agents WHERE name = ? AND workspace_id = ?', [agentId, workspaceId])).rows[0];
    } else {
      agent = (await query('SELECT * FROM agents WHERE id = ? AND workspace_id = ?', [Number(agentId), workspaceId])).rows[0];
    }

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const workItems: any[] = [];
    const now = Math.floor(Date.now() / 1000);
    const fourHoursAgo = now - (4 * 60 * 60);

    // 1. Check for @mentions in recent comments
    const mentions = (await query(`
      SELECT c.*, t.title as task_title
      FROM comments c
      JOIN tasks t ON c.task_id = t.id
      WHERE c.mentions LIKE ?
      AND c.workspace_id = ?
      AND t.workspace_id = ?
      AND c.created_at > ?
      ORDER BY c.created_at DESC
      LIMIT 10
    `, [`%"${agent.name}"%`, workspaceId, workspaceId, fourHoursAgo])).rows;

    if (mentions.length > 0) {
      workItems.push({
        type: 'mentions',
        count: mentions.length,
        items: mentions.map((m: any) => ({
          id: m.id,
          task_title: m.task_title,
          author: m.author,
          content: m.content.substring(0, 100) + '...',
          created_at: m.created_at
        }))
      });
    }

    // 2. Check for assigned tasks
    const assignedTasks = (await query(`
      SELECT * FROM tasks
      WHERE assigned_to = ?
      AND workspace_id = ?
      AND status IN ('assigned', 'in_progress')
      ORDER BY priority DESC, created_at ASC
      LIMIT 10
    `, [agent.name, workspaceId])).rows;

    if (assignedTasks.length > 0) {
      workItems.push({
        type: 'assigned_tasks',
        count: assignedTasks.length,
        items: assignedTasks.map((t: any) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          due_date: t.due_date
        }))
      });
    }

    // 3. Check for unread notifications
    const notifications = await db_helpers.getUnreadNotifications(agent.name, workspaceId);

    if (notifications.length > 0) {
      workItems.push({
        type: 'notifications',
        count: notifications.length,
        items: notifications.slice(0, 5).map(n => ({
          id: n.id,
          type: n.type,
          title: n.title,
          message: n.message,
          created_at: n.created_at
        }))
      });
    }

    // 4. Check for urgent activities that might need attention
    const urgentActivities = (await query(`
      SELECT * FROM activities
      WHERE type IN ('task_created', 'task_assigned', 'high_priority_alert')
      AND workspace_id = ?
      AND created_at > ?
      AND description LIKE ?
      ORDER BY created_at DESC
      LIMIT 5
    `, [workspaceId, fourHoursAgo, `%${agent.name}%`])).rows;

    if (urgentActivities.length > 0) {
      workItems.push({
        type: 'urgent_activities',
        count: urgentActivities.length,
        items: urgentActivities.map((a: any) => ({
          id: a.id,
          type: a.type,
          description: a.description,
          created_at: a.created_at
        }))
      });
    }

    await db_helpers.updateAgentStatus(agent.name, 'idle', 'Heartbeat check', workspaceId);

    await db_helpers.logActivity(
      'agent_heartbeat',
      'agent',
      agent.id,
      agent.name,
      `Heartbeat check completed - ${workItems.length > 0 ? `${workItems.length} work items found` : 'no work items'}`,
      { workItemsCount: workItems.length, workItemTypes: workItems.map(w => w.type) },
      workspaceId
    );

    if (workItems.length === 0) {
      return NextResponse.json({
        status: 'HEARTBEAT_OK',
        agent: agent.name,
        checked_at: now,
        message: 'No work items found'
      });
    }

    return NextResponse.json({
      status: 'WORK_ITEMS_FOUND',
      agent: agent.name,
      checked_at: now,
      work_items: workItems,
      total_items: workItems.reduce((sum, item) => sum + item.count, 0)
    });

  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/[id]/heartbeat error');
    return NextResponse.json({ error: 'Failed to perform heartbeat check' }, { status: 500 });
  }
}

/**
 * POST /api/agents/[id]/heartbeat - Enhanced heartbeat
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    // No body is fine
  }

  const { connection_id, token_usage } = body;
  const now = Math.floor(Date.now() / 1000);
  const workspaceId = auth.user.workspace_id ?? 1;

  if (connection_id) {
    await query(
      'UPDATE direct_connections SET last_heartbeat = ?, updated_at = ? WHERE connection_id = ? AND status = ? AND workspace_id = ?',
      [now, now, connection_id, 'connected', workspaceId]
    );
  }

  let tokenRecorded = false;
  if (token_usage && token_usage.model && token_usage.inputTokens != null && token_usage.outputTokens != null) {
    const resolvedParams = await params;
    const agentId = resolvedParams.id;
    let agent: any;
    if (isNaN(Number(agentId))) {
      agent = (await query('SELECT * FROM agents WHERE name = ? AND workspace_id = ?', [agentId, workspaceId])).rows[0];
    } else {
      agent = (await query('SELECT * FROM agents WHERE id = ? AND workspace_id = ?', [Number(agentId), workspaceId])).rows[0];
    }

    if (agent) {
      const sessionId = `${agent.name}:cli`;
      const parsedTaskId =
        token_usage.taskId != null && Number.isFinite(Number(token_usage.taskId))
          ? Number(token_usage.taskId)
          : null

      let taskId: number | null = null
      if (parsedTaskId && parsedTaskId > 0) {
        const taskRow = (await query(
          'SELECT id FROM tasks WHERE id = ? AND workspace_id = ?',
          [parsedTaskId, workspaceId]
        )).rows[0] as { id?: number } | undefined
        if (taskRow?.id) {
          taskId = taskRow.id
        } else {
          logger.warn({ taskId: parsedTaskId, workspaceId, agent: agent.name }, 'Ignoring token usage with unknown taskId')
        }
      }

      await query(
        `INSERT INTO token_usage (model, session_id, input_tokens, output_tokens, created_at, workspace_id, task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [token_usage.model, sessionId, token_usage.inputTokens, token_usage.outputTokens, now, workspaceId, taskId]
      );
      tokenRecorded = true;
    }
  }

  const getResponse = await GET(request, { params });
  const getBody = await getResponse.json();

  return NextResponse.json({
    ...getBody,
    token_recorded: tokenRecorded,
  });
}
