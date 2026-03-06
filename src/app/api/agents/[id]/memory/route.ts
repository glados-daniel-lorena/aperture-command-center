import { NextRequest, NextResponse } from 'next/server';
import { db_helpers } from '@/lib/db';
import { query } from '@/lib/postgres';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';

async function resolveAgent(agentId: string, workspaceId: number) {
  if (isNaN(Number(agentId))) {
    return (await query('SELECT * FROM agents WHERE name = ? AND workspace_id = ?', [agentId, workspaceId])).rows[0] as any;
  } else {
    return (await query('SELECT * FROM agents WHERE id = ? AND workspace_id = ?', [Number(agentId), workspaceId])).rows[0] as any;
  }
}

/**
 * GET /api/agents/[id]/memory - Get agent's working memory
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'viewer');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const resolvedParams = await params;
    const agentId = resolvedParams.id;
    const workspaceId = auth.user.workspace_id ?? 1;

    const agent = await resolveAgent(agentId, workspaceId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const col = isNaN(Number(agentId)) ? 'name' : 'id'
    const result = (await query(
      `SELECT working_memory FROM agents WHERE ${col} = ? AND workspace_id = ?`,
      [agentId, workspaceId]
    )).rows[0] as any;

    const workingMemory = result?.working_memory || '';

    return NextResponse.json({
      agent: { id: agent.id, name: agent.name, role: agent.role },
      working_memory: workingMemory,
      updated_at: agent.updated_at,
      size: workingMemory.length
    });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/[id]/memory error');
    return NextResponse.json({ error: 'Failed to fetch working memory' }, { status: 500 });
  }
}

/**
 * PUT /api/agents/[id]/memory - Update agent's working memory
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const resolvedParams = await params;
    const agentId = resolvedParams.id;
    const workspaceId = auth.user.workspace_id ?? 1;
    const body = await request.json();
    const { working_memory, append } = body;

    const agent = await resolveAgent(agentId, workspaceId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const col = isNaN(Number(agentId)) ? 'name' : 'id'
    let newContent = working_memory || '';

    if (append) {
      const current = (await query(
        `SELECT working_memory FROM agents WHERE ${col} = ? AND workspace_id = ?`,
        [agentId, workspaceId]
      )).rows[0] as any;
      const currentContent = current?.working_memory || '';

      const timestamp = new Date().toISOString();
      newContent = currentContent + (currentContent ? '\n\n' : '') +
                   `## ${timestamp}\n${working_memory}`;
    }

    const now = Math.floor(Date.now() / 1000);

    await query(
      `UPDATE agents SET working_memory = ?, updated_at = ? WHERE ${col} = ? AND workspace_id = ?`,
      [newContent, now, agentId, workspaceId]
    );

    await db_helpers.logActivity(
      'agent_memory_updated',
      'agent',
      agent.id,
      agent.name,
      `Working memory ${append ? 'appended' : 'updated'} for agent ${agent.name}`,
      { content_length: newContent.length, append_mode: append || false, timestamp: now },
      workspaceId
    );

    return NextResponse.json({
      success: true,
      message: `Working memory ${append ? 'appended' : 'updated'} for ${agent.name}`,
      working_memory: newContent,
      updated_at: now,
      size: newContent.length
    });
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/agents/[id]/memory error');
    return NextResponse.json({ error: 'Failed to update working memory' }, { status: 500 });
  }
}

/**
 * DELETE /api/agents/[id]/memory - Clear agent's working memory
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const resolvedParams = await params;
    const agentId = resolvedParams.id;
    const workspaceId = auth.user.workspace_id ?? 1;

    const agent = await resolveAgent(agentId, workspaceId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const col = isNaN(Number(agentId)) ? 'name' : 'id'
    const now = Math.floor(Date.now() / 1000);

    await query(
      `UPDATE agents SET working_memory = '', updated_at = ? WHERE ${col} = ? AND workspace_id = ?`,
      [now, agentId, workspaceId]
    );

    await db_helpers.logActivity(
      'agent_memory_cleared',
      'agent',
      agent.id,
      agent.name,
      `Working memory cleared for agent ${agent.name}`,
      { timestamp: now },
      workspaceId
    );

    return NextResponse.json({
      success: true,
      message: `Working memory cleared for ${agent.name}`,
      working_memory: '',
      updated_at: now
    });
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/agents/[id]/memory error');
    return NextResponse.json({ error: 'Failed to clear working memory' }, { status: 500 });
  }
}
