import { NextRequest, NextResponse } from 'next/server'
import { query, Message } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * GET /api/chat/messages/[id] - Get a single message
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { id } = await params
    const workspaceId = auth.user.workspace_id ?? 1

    const message = (await query(
      'SELECT * FROM messages WHERE id = ? AND workspace_id = ?',
      [parseInt(id), workspaceId]
    )).rows[0] as Message | undefined

    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    return NextResponse.json({
      message: {
        ...message,
        metadata: message.metadata ? JSON.parse(message.metadata) : null
      }
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/chat/messages/[id] error')
    return NextResponse.json({ error: 'Failed to fetch message' }, { status: 500 })
  }
}

/**
 * PATCH /api/chat/messages/[id] - Mark message as read
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { id } = await params
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()

    const message = (await query(
      'SELECT * FROM messages WHERE id = ? AND workspace_id = ?',
      [parseInt(id), workspaceId]
    )).rows[0] as Message | undefined

    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    if (body.read) {
      const now = Math.floor(Date.now() / 1000)
      await query(
        'UPDATE messages SET read_at = ? WHERE id = ? AND workspace_id = ?',
        [now, parseInt(id), workspaceId]
      )
    }

    const updated = (await query(
      'SELECT * FROM messages WHERE id = ? AND workspace_id = ?',
      [parseInt(id), workspaceId]
    )).rows[0] as Message

    return NextResponse.json({
      message: {
        ...updated,
        metadata: updated.metadata ? JSON.parse(updated.metadata) : null
      }
    })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/chat/messages/[id] error')
    return NextResponse.json({ error: 'Failed to update message' }, { status: 500 })
  }
}
