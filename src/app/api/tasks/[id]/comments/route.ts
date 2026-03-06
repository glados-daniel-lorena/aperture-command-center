import { NextRequest, NextResponse } from 'next/server';
import { Comment, db_helpers } from '@/lib/db';
import { query } from '@/lib/postgres';
import { requireRole } from '@/lib/auth';
import { validateBody, createCommentSchema } from '@/lib/validation';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { resolveMentionRecipients } from '@/lib/mentions';

/**
 * GET /api/tasks/[id]/comments - Get all comments for a task
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'viewer');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const resolvedParams = await params;
    const taskId = parseInt(resolvedParams.id);
    const workspaceId = auth.user.workspace_id ?? 1;

    if (isNaN(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });
    }

    // Verify task exists
    const task = (await query('SELECT id FROM tasks WHERE id = ? AND workspace_id = ?', [taskId, workspaceId])).rows[0];
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Get comments ordered by creation time
    const comments = (await query(`
      SELECT * FROM comments
      WHERE task_id = ? AND workspace_id = ?
      ORDER BY created_at ASC
    `, [taskId, workspaceId])).rows as Comment[];

    // Parse JSON fields and build thread structure
    const commentsWithParsedData = comments.map(comment => ({
      ...comment,
      mentions: comment.mentions ? JSON.parse(comment.mentions) : []
    }));

    // Organize into thread structure (parent comments with replies)
    const commentMap = new Map();
    const topLevelComments: any[] = [];

    // First pass: create all comment objects
    commentsWithParsedData.forEach(comment => {
      commentMap.set(comment.id, { ...comment, replies: [] });
    });

    // Second pass: organize into threads
    commentsWithParsedData.forEach(comment => {
      const commentWithReplies = commentMap.get(comment.id);

      if (comment.parent_id) {
        // This is a reply, add to parent's replies
        const parent = commentMap.get(comment.parent_id);
        if (parent) {
          parent.replies.push(commentWithReplies);
        }
      } else {
        // This is a top-level comment
        topLevelComments.push(commentWithReplies);
      }
    });

    return NextResponse.json({
      comments: topLevelComments,
      total: comments.length
    });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/[id]/comments error');
    return NextResponse.json({ error: 'Failed to fetch comments' }, { status: 500 });
  }
}

/**
 * POST /api/tasks/[id]/comments - Add a new comment to a task
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const resolvedParams = await params;
    const taskId = parseInt(resolvedParams.id);
    const workspaceId = auth.user.workspace_id ?? 1;

    if (isNaN(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });
    }

    const result = await validateBody(request, createCommentSchema);
    if ('error' in result) return result.error;
    const { content, parent_id } = result.data;
    const author = auth.user.display_name || auth.user.username || 'system';

    // Verify task exists
    const task = (await query('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?', [taskId, workspaceId])).rows[0] as any;
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Verify parent comment exists if specified
    if (parent_id) {
      const parentComment = (await query('SELECT id FROM comments WHERE id = ? AND task_id = ? AND workspace_id = ?', [parent_id, taskId, workspaceId])).rows[0];
      if (!parentComment) {
        return NextResponse.json({ error: 'Parent comment not found' }, { status: 404 });
      }
    }

    const mentionResolution = await resolveMentionRecipients(content, workspaceId);
    if (mentionResolution.unresolved.length > 0) {
      return NextResponse.json({
        error: `Unknown mentions: ${mentionResolution.unresolved.map((m) => `@${m}`).join(', ')}`,
        missing_mentions: mentionResolution.unresolved
      }, { status: 400 });
    }

    const now = Math.floor(Date.now() / 1000);

    // Insert comment
    const insertResult = await query(`
      INSERT INTO comments (task_id, author, content, created_at, parent_id, mentions, workspace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [
      taskId,
      author,
      content,
      now,
      parent_id || null,
      mentionResolution.tokens.length > 0 ? JSON.stringify(mentionResolution.tokens) : null,
      workspaceId,
    ]);

    const commentId = insertResult.rows[0].id as number;

    // Log activity
    const activityDescription = parent_id
      ? `Replied to comment on task: ${task.title}`
      : `Added comment to task: ${task.title}`;

    await db_helpers.logActivity(
      'comment_added',
      'comment',
      commentId,
      author,
      activityDescription,
      {
        task_id: taskId,
        task_title: task.title,
        parent_id,
        mentions: mentionResolution.tokens,
        content_preview: content.substring(0, 100)
      },
      workspaceId
    );

    // Ensure subscriptions for author, mentions, and assignee
    await db_helpers.ensureTaskSubscription(taskId, author, workspaceId);
    const mentionRecipients = mentionResolution.recipients;
    for (const mentionedRecipient of mentionRecipients) {
      await db_helpers.ensureTaskSubscription(taskId, mentionedRecipient, workspaceId);
    }
    if (task.assigned_to) {
      await db_helpers.ensureTaskSubscription(taskId, task.assigned_to, workspaceId);
    }

    // Notify subscribers
    const subscriberList = await db_helpers.getTaskSubscribers(taskId, workspaceId);
    const subscribers = new Set(subscriberList);
    subscribers.delete(author);
    const mentionSet = new Set(mentionRecipients);

    for (const subscriber of subscribers) {
      const isMention = mentionSet.has(subscriber);
      await db_helpers.createNotification(
        subscriber,
        isMention ? 'mention' : 'comment',
        isMention ? 'You were mentioned' : 'New comment on a subscribed task',
        isMention
          ? `${author} mentioned you in a comment on "${task.title}": ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`
          : `${author} commented on "${task.title}": ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`,
        'comment',
        commentId,
        workspaceId
      );
    }

    // Fetch the created comment
    const createdComment = (await query('SELECT * FROM comments WHERE id = ? AND workspace_id = ?', [commentId, workspaceId])).rows[0] as Comment;

    return NextResponse.json({
      comment: {
        ...createdComment,
        mentions: createdComment.mentions ? JSON.parse(createdComment.mentions) : [],
        replies: []
      }
    }, { status: 201 });
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/[id]/comments error');
    return NextResponse.json({ error: 'Failed to add comment' }, { status: 500 });
  }
}
