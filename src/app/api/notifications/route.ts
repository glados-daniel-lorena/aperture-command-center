import { NextRequest, NextResponse } from 'next/server';
import { Notification } from '@/lib/db';
import { query } from '@/lib/postgres';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { validateBody, notificationActionSchema } from '@/lib/validation';
import { logger } from '@/lib/logger';

/**
 * GET /api/notifications - Get notifications for a specific recipient
 * Query params: recipient, unread_only, type, limit, offset
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = auth.user.workspace_id ?? 1;

    // Parse query parameters
    const recipient = searchParams.get('recipient');
    const unread_only = searchParams.get('unread_only') === 'true';
    const type = searchParams.get('type');
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 500);
    const offset = parseInt(searchParams.get('offset') || '0');

    if (!recipient) {
      return NextResponse.json({ error: 'Recipient is required' }, { status: 400 });
    }

    // Build dynamic query
    let sql = 'SELECT * FROM notifications WHERE recipient = ? AND workspace_id = ?';
    const params: any[] = [recipient, workspaceId];

    if (unread_only) {
      sql += ' AND read_at IS NULL';
    }

    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const notifications = (await query(sql, params)).rows as Notification[];

    // Enhance notifications with related entity data
    const enhancedNotifications = []
    for (const notification of notifications) {
      let sourceDetails = null;

      try {
        if (notification.source_type && notification.source_id) {
          switch (notification.source_type) {
            case 'task': {
              const task = (await query('SELECT id, title, status FROM tasks WHERE id = ? AND workspace_id = ?', [notification.source_id, workspaceId])).rows[0] as any;
              if (task) {
                sourceDetails = { type: 'task', ...task };
              }
              break;
            }
            case 'comment': {
              const comment = (await query(`
                SELECT c.id, c.content, c.task_id, t.title as task_title
                FROM comments c
                LEFT JOIN tasks t ON c.task_id = t.id
                WHERE c.id = ? AND c.workspace_id = ? AND t.workspace_id = ?
              `, [notification.source_id, workspaceId, workspaceId])).rows[0] as any;
              if (comment) {
                sourceDetails = {
                  type: 'comment',
                  ...comment,
                  content_preview: comment.content?.substring(0, 100) || ''
                };
              }
              break;
            }
            case 'agent': {
              const agent = (await query('SELECT id, name, role, status FROM agents WHERE id = ? AND workspace_id = ?', [notification.source_id, workspaceId])).rows[0] as any;
              if (agent) {
                sourceDetails = { type: 'agent', ...agent };
              }
              break;
            }
          }
        }
      } catch (error) {
        logger.warn({ err: error, notificationId: notification.id }, 'Failed to fetch source details for notification');
      }

      enhancedNotifications.push({ ...notification, source: sourceDetails });
    }

    // Get unread count for this recipient
    const unreadRow = (await query(`
      SELECT COUNT(*) as count
      FROM notifications
      WHERE recipient = ? AND read_at IS NULL AND workspace_id = ?
    `, [recipient, workspaceId])).rows[0] as { count: number };

    // Get total count for pagination
    let countSql = 'SELECT COUNT(*) as total FROM notifications WHERE recipient = ? AND workspace_id = ?';
    const countParams: any[] = [recipient, workspaceId];
    if (unread_only) {
      countSql += ' AND read_at IS NULL';
    }
    if (type) {
      countSql += ' AND type = ?';
      countParams.push(type);
    }
    const countRow = (await query(countSql, countParams)).rows[0] as { total: number };

    return NextResponse.json({
      notifications: enhancedNotifications,
      total: countRow.total,
      page: Math.floor(offset / limit) + 1,
      limit,
      unreadCount: unreadRow.count
    });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/notifications error');
    return NextResponse.json({ error: 'Failed to fetch notifications' }, { status: 500 });
  }
}

/**
 * PUT /api/notifications - Mark notifications as read
 * Body: { ids: number[] } or { recipient: string } (mark all as read)
 */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const workspaceId = auth.user.workspace_id ?? 1;
    const body = await request.json();
    const { ids, recipient, markAllRead } = body;

    const now = Math.floor(Date.now() / 1000);

    if (markAllRead && recipient) {
      // Mark all notifications as read for this recipient
      const result = await query(`
        UPDATE notifications
        SET read_at = ?
        WHERE recipient = ? AND read_at IS NULL AND workspace_id = ?
      `, [now, recipient, workspaceId]);

      return NextResponse.json({
        success: true,
        markedAsRead: result.rowCount ?? 0
      });
    } else if (ids && Array.isArray(ids)) {
      // Mark specific notifications as read
      const placeholders = ids.map(() => '?').join(',');
      const result = await query(`
        UPDATE notifications
        SET read_at = ?
        WHERE id IN (${placeholders}) AND read_at IS NULL AND workspace_id = ?
      `, [now, ...ids, workspaceId]);

      return NextResponse.json({
        success: true,
        markedAsRead: result.rowCount ?? 0
      });
    } else {
      return NextResponse.json({
        error: 'Either provide ids array or recipient with markAllRead=true'
      }, { status: 400 });
    }
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/notifications error');
    return NextResponse.json({ error: 'Failed to update notifications' }, { status: 500 });
  }
}

/**
 * DELETE /api/notifications - Delete notifications
 * Body: { ids: number[] } or { recipient: string, olderThan: number }
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, 'admin');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const workspaceId = auth.user.workspace_id ?? 1;
    const body = await request.json();
    const { ids, recipient, olderThan } = body;

    if (ids && Array.isArray(ids)) {
      // Delete specific notifications
      const placeholders = ids.map(() => '?').join(',');
      const result = await query(`
        DELETE FROM notifications
        WHERE id IN (${placeholders}) AND workspace_id = ?
      `, [...ids, workspaceId]);

      return NextResponse.json({
        success: true,
        deleted: result.rowCount ?? 0
      });
    } else if (recipient && olderThan) {
      // Delete old notifications for recipient
      const result = await query(`
        DELETE FROM notifications
        WHERE recipient = ? AND created_at < ? AND workspace_id = ?
      `, [recipient, olderThan, workspaceId]);

      return NextResponse.json({
        success: true,
        deleted: result.rowCount ?? 0
      });
    } else {
      return NextResponse.json({
        error: 'Either provide ids array or recipient with olderThan timestamp'
      }, { status: 400 });
    }
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/notifications error');
    return NextResponse.json({ error: 'Failed to delete notifications' }, { status: 500 });
  }
}

/**
 * POST /api/notifications/mark-delivered - Mark notifications as delivered to agent
 * Body: { agent: string }
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const workspaceId = auth.user.workspace_id ?? 1;

    const result = await validateBody(request, notificationActionSchema);
    if ('error' in result) return result.error;
    const { agent, action } = result.data;

    if (action === 'mark-delivered') {
      const now = Math.floor(Date.now() / 1000);

      // Mark undelivered notifications as delivered
      const updateResult = await query(`
        UPDATE notifications
        SET delivered_at = ?
        WHERE recipient = ? AND delivered_at IS NULL AND workspace_id = ?
      `, [now, agent, workspaceId]);

      // Get the notifications that were just marked as delivered
      const deliveredNotifications = (await query(`
        SELECT * FROM notifications
        WHERE recipient = ? AND delivered_at = ? AND workspace_id = ?
        ORDER BY created_at DESC
      `, [agent, now, workspaceId])).rows as Notification[];

      return NextResponse.json({
        success: true,
        delivered: updateResult.rowCount ?? 0,
        notifications: deliveredNotifications
      });
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    logger.error({ err: error }, 'POST /api/notifications error');
    return NextResponse.json({ error: 'Failed to process notification action' }, { status: 500 });
  }
}
