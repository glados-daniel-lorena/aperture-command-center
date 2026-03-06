import { NextRequest, NextResponse } from 'next/server'
import { db_helpers } from '@/lib/db'
import { query } from '@/lib/postgres'
import { requireRole } from '@/lib/auth'
import { validateBody, createWorkflowSchema } from '@/lib/validation'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

export interface WorkflowTemplate {
  id: number
  name: string
  description: string | null
  model: string
  task_prompt: string
  timeout_seconds: number
  agent_role: string | null
  tags: string | null
  created_by: string
  created_at: number
  updated_at: number
  last_used_at: number | null
  use_count: number
}

/**
 * GET /api/workflows - List all workflow templates
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const workspaceId = auth.user.workspace_id ?? 1
    const templates = (await query(
      'SELECT * FROM workflow_templates WHERE workspace_id = ? ORDER BY use_count DESC, updated_at DESC',
      [workspaceId]
    )).rows as WorkflowTemplate[]

    const parsed = templates.map(t => ({
      ...t,
      tags: t.tags ? JSON.parse(t.tags) : [],
    }))

    return NextResponse.json({ templates: parsed })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/workflows error')
    return NextResponse.json({ error: 'Failed to fetch templates' }, { status: 500 })
  }
}

/**
 * POST /api/workflows - Create a new workflow template
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const result = await validateBody(request, createWorkflowSchema)
    if ('error' in result) return result.error
    const { name, description, model, task_prompt, timeout_seconds, agent_role, tags } = result.data

    const user = auth.user
    const workspaceId = auth.user.workspace_id ?? 1

    const insertResult = await query(`
      INSERT INTO workflow_templates (name, description, model, task_prompt, timeout_seconds, agent_role, tags, created_by, workspace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [
      name,
      description || null,
      model,
      task_prompt,
      timeout_seconds,
      agent_role || null,
      JSON.stringify(tags),
      user?.username || 'system',
      workspaceId
    ])

    const newId = insertResult.rows[0].id

    const template = (await query(
      'SELECT * FROM workflow_templates WHERE id = ? AND workspace_id = ?',
      [newId, workspaceId]
    )).rows[0] as WorkflowTemplate

    await db_helpers.logActivity(
      'workflow_created',
      'workflow',
      newId,
      user?.username || 'system',
      `Created workflow template: ${name}`,
      undefined,
      workspaceId
    )

    return NextResponse.json({
      template: { ...template, tags: template.tags ? JSON.parse(template.tags) : [] }
    }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/workflows error')
    return NextResponse.json({ error: 'Failed to create template' }, { status: 500 })
  }
}

/**
 * PUT /api/workflows - Update a workflow template
 */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()
    const { id, ...updates } = body

    if (!id) {
      return NextResponse.json({ error: 'Template ID is required' }, { status: 400 })
    }

    const existing = (await query(
      'SELECT * FROM workflow_templates WHERE id = ? AND workspace_id = ?',
      [id, workspaceId]
    )).rows[0] as WorkflowTemplate | undefined
    if (!existing) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }

    const fields: string[] = []
    const params: any[] = []

    if (updates.name !== undefined) { fields.push('name = ?'); params.push(updates.name) }
    if (updates.description !== undefined) { fields.push('description = ?'); params.push(updates.description) }
    if (updates.model !== undefined) { fields.push('model = ?'); params.push(updates.model) }
    if (updates.task_prompt !== undefined) { fields.push('task_prompt = ?'); params.push(updates.task_prompt) }
    if (updates.timeout_seconds !== undefined) { fields.push('timeout_seconds = ?'); params.push(updates.timeout_seconds) }
    if (updates.agent_role !== undefined) { fields.push('agent_role = ?'); params.push(updates.agent_role) }
    if (updates.tags !== undefined) { fields.push('tags = ?'); params.push(JSON.stringify(updates.tags)) }

    if (fields.length === 0) {
      fields.push('use_count = use_count + 1')
      fields.push('last_used_at = ?')
      params.push(Math.floor(Date.now() / 1000))
    }

    fields.push('updated_at = ?')
    params.push(Math.floor(Date.now() / 1000))
    params.push(id, workspaceId)

    await query(`UPDATE workflow_templates SET ${fields.join(', ')} WHERE id = ? AND workspace_id = ?`, params)

    const updated = (await query(
      'SELECT * FROM workflow_templates WHERE id = ? AND workspace_id = ?',
      [id, workspaceId]
    )).rows[0] as WorkflowTemplate
    return NextResponse.json({ template: { ...updated, tags: updated.tags ? JSON.parse(updated.tags) : [] } })
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/workflows error')
    return NextResponse.json({ error: 'Failed to update template' }, { status: 500 })
  }
}

/**
 * DELETE /api/workflows - Delete a workflow template
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const workspaceId = auth.user.workspace_id ?? 1
    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Request body required' }, { status: 400 }) }
    const id = body.id

    if (!id) {
      return NextResponse.json({ error: 'Template ID is required' }, { status: 400 })
    }

    const result = await query(
      'DELETE FROM workflow_templates WHERE id = ? AND workspace_id = ?',
      [parseInt(id), workspaceId]
    )
    if ((result.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/workflows error')
    return NextResponse.json({ error: 'Failed to delete template' }, { status: 500 })
  }
}
