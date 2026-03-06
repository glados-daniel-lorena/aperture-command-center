import { NextRequest, NextResponse } from 'next/server'
import { db_helpers } from '@/lib/db'
import { query } from '@/lib/postgres'
import { requireRole } from '@/lib/auth'
import { eventBus } from '@/lib/event-bus'
import { logger } from '@/lib/logger'

interface PipelineStep {
  template_id: number
  on_failure: 'stop' | 'continue'
}

interface RunStepState {
  step_index: number
  template_id: number
  template_name: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  spawn_id: string | null
  started_at: number | null
  completed_at: number | null
  error: string | null
}

interface PipelineRun {
  id: number
  pipeline_id: number
  status: string
  current_step: number
  steps_snapshot: string
  started_at: number | null
  completed_at: number | null
  triggered_by: string
  created_at: number
}

/**
 * GET /api/pipelines/run - Get pipeline runs
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = auth.user.workspace_id ?? 1
    const pipelineId = searchParams.get('pipeline_id')
    const runId = searchParams.get('id')
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 200)

    if (runId) {
      const run = (await query(
        'SELECT * FROM pipeline_runs WHERE id = ? AND workspace_id = ?',
        [parseInt(runId), workspaceId]
      )).rows[0] as PipelineRun | undefined
      if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
      return NextResponse.json({ run: { ...run, steps_snapshot: JSON.parse(run.steps_snapshot) } })
    }

    let sql = 'SELECT * FROM pipeline_runs WHERE workspace_id = ?'
    const params: any[] = [workspaceId]

    if (pipelineId) {
      sql += ' AND pipeline_id = ?'
      params.push(parseInt(pipelineId))
    }

    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)

    const runs = (await query(sql, params)).rows as PipelineRun[]

    const pipelineIds = [...new Set(runs.map(r => r.pipeline_id))]
    const pipelines = pipelineIds.length > 0
      ? (await query(
          `SELECT id, name FROM workflow_pipelines WHERE workspace_id = ? AND id IN (${pipelineIds.map(() => '?').join(',')})`,
          [workspaceId, ...pipelineIds]
        )).rows as Array<{ id: number; name: string }>
      : []
    const nameMap = new Map(pipelines.map(p => [p.id, p.name]))

    const parsed = runs.map(r => ({
      ...r,
      pipeline_name: nameMap.get(r.pipeline_id) || 'Deleted Pipeline',
      steps_snapshot: JSON.parse(r.steps_snapshot),
    }))

    return NextResponse.json({ runs: parsed })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/pipelines/run error')
    return NextResponse.json({ error: 'Failed to fetch runs' }, { status: 500 })
  }
}

/**
 * POST /api/pipelines/run - Start a pipeline run or advance a running one
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()
    const { action, pipeline_id, run_id } = body

    if (action === 'start') {
      return startPipeline(pipeline_id, auth.user?.username || 'system', workspaceId)
    } else if (action === 'advance') {
      return advanceRun(run_id, body.success ?? true, body.error, workspaceId)
    } else if (action === 'cancel') {
      return cancelRun(run_id, workspaceId)
    }

    return NextResponse.json({ error: 'Invalid action. Use: start, advance, cancel' }, { status: 400 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/pipelines/run error')
    return NextResponse.json({ error: 'Failed to process pipeline run' }, { status: 500 })
  }
}

/** Spawn a single pipeline step using `openclaw agent` */
async function spawnStep(
  pipelineName: string,
  template: { name: string; model: string; task_prompt: string; timeout_seconds: number },
  steps: RunStepState[],
  stepIdx: number,
  runId: number,
  workspaceId: number
): Promise<{ success: boolean; stdout?: string; error?: string }> {
  try {
    const { runOpenClaw } = await import('@/lib/command')
    const args = [
      'agent',
      '--message', `[Pipeline: ${pipelineName} | Step ${stepIdx + 1}] ${template.task_prompt}`,
      '--timeout', String(template.timeout_seconds),
      '--json',
    ]
    const { stdout } = await runOpenClaw(args, { timeoutMs: 15000 })

    const spawnId = `pipeline-${runId}-step-${stepIdx}-${Date.now()}`
    steps[stepIdx].spawn_id = spawnId
    await query(
      'UPDATE pipeline_runs SET steps_snapshot = ? WHERE id = ? AND workspace_id = ?',
      [JSON.stringify(steps), runId, workspaceId]
    )

    return { success: true, stdout: stdout.trim() }
  } catch (err: any) {
    steps[stepIdx].error = err.message
    await query(
      'UPDATE pipeline_runs SET steps_snapshot = ? WHERE id = ? AND workspace_id = ?',
      [JSON.stringify(steps), runId, workspaceId]
    )

    return { success: false, error: err.message }
  }
}

async function startPipeline(pipelineId: number, triggeredBy: string, workspaceId: number) {
  const pipeline = (await query(
    'SELECT * FROM workflow_pipelines WHERE id = ? AND workspace_id = ?',
    [pipelineId, workspaceId]
  )).rows[0] as any
  if (!pipeline) return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 })

  const steps: PipelineStep[] = JSON.parse(pipeline.steps || '[]')
  if (steps.length === 0) return NextResponse.json({ error: 'Pipeline has no steps' }, { status: 400 })

  const templateIds = steps.map(s => s.template_id)
  const placeholders = templateIds.map(() => '?').join(',')
  const templates = (await query(
    `SELECT id, name, model, task_prompt, timeout_seconds FROM workflow_templates WHERE id IN (${placeholders})`,
    templateIds
  )).rows as Array<{ id: number; name: string; model: string; task_prompt: string; timeout_seconds: number }>
  const templateMap = new Map(templates.map(t => [t.id, t]))

  const stepsSnapshot: RunStepState[] = steps.map((s, i) => ({
    step_index: i,
    template_id: s.template_id,
    template_name: templateMap.get(s.template_id)?.name || 'Unknown',
    on_failure: s.on_failure,
    status: i === 0 ? 'running' : 'pending',
    spawn_id: null,
    started_at: i === 0 ? Math.floor(Date.now() / 1000) : null,
    completed_at: null,
    error: null,
  }))

  const now = Math.floor(Date.now() / 1000)
  const insertResult = await query(`
    INSERT INTO pipeline_runs (pipeline_id, status, current_step, steps_snapshot, started_at, triggered_by, workspace_id)
    VALUES (?, 'running', 0, ?, ?, ?, ?)
    RETURNING id
  `, [pipelineId, JSON.stringify(stepsSnapshot), now, triggeredBy, workspaceId])

  const runId = insertResult.rows[0].id

  await query(`
    UPDATE workflow_pipelines SET use_count = use_count + 1, last_used_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?
  `, [now, now, pipelineId, workspaceId])

  const firstTemplate = templateMap.get(steps[0].template_id)
  let spawnResult: any = null
  if (firstTemplate) {
    spawnResult = await spawnStep(pipeline.name, firstTemplate, stepsSnapshot, 0, runId, workspaceId)
  }

  await db_helpers.logActivity('pipeline_started', 'pipeline', pipelineId, triggeredBy, `Started pipeline: ${pipeline.name}`, { run_id: runId }, workspaceId)

  eventBus.broadcast('activity.created', {
    type: 'pipeline_started',
    entity_type: 'pipeline',
    entity_id: pipelineId,
    description: `Pipeline "${pipeline.name}" started`,
    data: { run_id: runId },
  })

  return NextResponse.json({
    run: {
      id: runId,
      pipeline_id: pipelineId,
      status: stepsSnapshot[0].status === 'failed' ? 'failed' : 'running',
      current_step: 0,
      steps_snapshot: stepsSnapshot,
      spawn: spawnResult,
    }
  }, { status: 201 })
}

async function advanceRun(runId: number, success: boolean, errorMsg: string | undefined, workspaceId: number) {
  if (!runId) return NextResponse.json({ error: 'run_id required' }, { status: 400 })

  const run = (await query(
    'SELECT * FROM pipeline_runs WHERE id = ? AND workspace_id = ?',
    [runId, workspaceId]
  )).rows[0] as PipelineRun | undefined
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  if (run.status !== 'running') return NextResponse.json({ error: `Run is ${run.status}, not running` }, { status: 400 })

  const steps: (RunStepState & { on_failure?: string })[] = JSON.parse(run.steps_snapshot)
  const currentIdx = run.current_step
  const now = Math.floor(Date.now() / 1000)

  steps[currentIdx].status = success ? 'completed' : 'failed'
  steps[currentIdx].completed_at = now
  if (errorMsg) steps[currentIdx].error = errorMsg

  const nextIdx = currentIdx + 1
  const onFailure = steps[currentIdx].on_failure || 'stop'

  if (!success && onFailure === 'stop') {
    for (let i = nextIdx; i < steps.length; i++) steps[i].status = 'skipped'
    await query(
      'UPDATE pipeline_runs SET status = ?, current_step = ?, steps_snapshot = ?, completed_at = ? WHERE id = ? AND workspace_id = ?',
      ['failed', currentIdx, JSON.stringify(steps), now, runId, workspaceId]
    )
    return NextResponse.json({ run: { id: runId, status: 'failed', steps_snapshot: steps } })
  }

  if (nextIdx >= steps.length) {
    const finalStatus = 'completed'
    await query(
      'UPDATE pipeline_runs SET status = ?, current_step = ?, steps_snapshot = ?, completed_at = ? WHERE id = ? AND workspace_id = ?',
      [finalStatus, currentIdx, JSON.stringify(steps), now, runId, workspaceId]
    )

    eventBus.broadcast('activity.created', {
      type: 'pipeline_completed',
      entity_type: 'pipeline',
      entity_id: run.pipeline_id,
      description: `Pipeline run #${runId} completed`,
    })

    return NextResponse.json({ run: { id: runId, status: finalStatus, steps_snapshot: steps } })
  }

  steps[nextIdx].status = 'running'
  steps[nextIdx].started_at = now

  const template = (await query(
    'SELECT id, name, model, task_prompt, timeout_seconds FROM workflow_templates WHERE id = ?',
    [steps[nextIdx].template_id]
  )).rows[0] as any

  let spawnResult: any = null
  if (template) {
    const pipeline = (await query(
      'SELECT name FROM workflow_pipelines WHERE id = ? AND workspace_id = ?',
      [run.pipeline_id, workspaceId]
    )).rows[0] as any
    spawnResult = await spawnStep(pipeline?.name || '?', template, steps, nextIdx, runId, workspaceId)
  }

  await query(
    'UPDATE pipeline_runs SET current_step = ?, steps_snapshot = ? WHERE id = ? AND workspace_id = ?',
    [nextIdx, JSON.stringify(steps), runId, workspaceId]
  )

  return NextResponse.json({
    run: { id: runId, status: 'running', current_step: nextIdx, steps_snapshot: steps, spawn: spawnResult }
  })
}

async function cancelRun(runId: number, workspaceId: number) {
  if (!runId) return NextResponse.json({ error: 'run_id required' }, { status: 400 })

  const run = (await query(
    'SELECT * FROM pipeline_runs WHERE id = ? AND workspace_id = ?',
    [runId, workspaceId]
  )).rows[0] as PipelineRun | undefined
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  if (run.status !== 'running' && run.status !== 'pending') {
    return NextResponse.json({ error: `Run is ${run.status}, cannot cancel` }, { status: 400 })
  }

  const steps: RunStepState[] = JSON.parse(run.steps_snapshot)
  const now = Math.floor(Date.now() / 1000)

  for (const step of steps) {
    if (step.status === 'pending' || step.status === 'running') {
      step.status = 'skipped'
      step.completed_at = now
    }
  }

  await query(
    'UPDATE pipeline_runs SET status = ?, steps_snapshot = ?, completed_at = ? WHERE id = ? AND workspace_id = ?',
    ['cancelled', JSON.stringify(steps), now, runId, workspaceId]
  )

  return NextResponse.json({ run: { id: runId, status: 'cancelled', steps_snapshot: steps } })
}
