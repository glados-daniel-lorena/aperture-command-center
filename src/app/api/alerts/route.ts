import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { query } from '@/lib/postgres'
import { mutationLimiter } from '@/lib/rate-limit'
import { createAlertSchema } from '@/lib/validation'

interface AlertRule {
  id: number
  name: string
  description: string | null
  enabled: number
  entity_type: string
  condition_field: string
  condition_operator: string
  condition_value: string
  action_type: string
  action_config: string
  cooldown_minutes: number
  last_triggered_at: number | null
  trigger_count: number
  created_by: string
  created_at: number
  updated_at: number
}

/**
 * GET /api/alerts - List all alert rules
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const workspaceId = auth.user.workspace_id ?? 1
  try {
    const rules = (await query(
      'SELECT * FROM alert_rules WHERE workspace_id = ? ORDER BY created_at DESC',
      [workspaceId]
    )).rows as AlertRule[]
    return NextResponse.json({ rules })
  } catch {
    return NextResponse.json({ rules: [] })
  }
}

/**
 * POST /api/alerts - Create a new alert rule or evaluate rules
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const workspaceId = auth.user.workspace_id ?? 1

  let rawBody: any
  try { rawBody = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (rawBody.action === 'evaluate') {
    return evaluateRules(workspaceId)
  }

  // Validate for create using schema
  const parseResult = createAlertSchema.safeParse(rawBody)
  if (!parseResult.success) {
    const messages = parseResult.error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`)
    return NextResponse.json({ error: 'Validation failed', details: messages }, { status: 400 })
  }

  const { name, description, entity_type, condition_field, condition_operator, condition_value, action_type, action_config, cooldown_minutes } = parseResult.data

  try {
    const insertResult = await query(`
      INSERT INTO alert_rules (name, description, entity_type, condition_field, condition_operator, condition_value, action_type, action_config, cooldown_minutes, created_by, workspace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [
      name,
      description || null,
      entity_type,
      condition_field,
      condition_operator,
      condition_value,
      action_type || 'notification',
      JSON.stringify(action_config || {}),
      cooldown_minutes || 60,
      auth.user?.username || 'system',
      workspaceId
    ])

    const newId = insertResult.rows[0].id

    try {
      await query(
        'INSERT INTO audit_log (action, actor, detail) VALUES (?, ?, ?)',
        ['alert_rule_created', auth.user?.username || 'system', `Created alert rule: ${name}`]
      )
    } catch { /* audit table might not exist */ }

    const rule = (await query(
      'SELECT * FROM alert_rules WHERE id = ? AND workspace_id = ?',
      [newId, workspaceId]
    )).rows[0] as AlertRule
    return NextResponse.json({ rule }, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to create rule' }, { status: 500 })
  }
}

/**
 * PUT /api/alerts - Update an alert rule
 */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const workspaceId = auth.user.workspace_id ?? 1
  const body = await request.json()
  const { id, ...updates } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const existing = (await query(
    'SELECT * FROM alert_rules WHERE id = ? AND workspace_id = ?',
    [id, workspaceId]
  )).rows[0] as AlertRule | undefined
  if (!existing) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })

  const allowed = ['name', 'description', 'enabled', 'entity_type', 'condition_field', 'condition_operator', 'condition_value', 'action_type', 'action_config', 'cooldown_minutes']
  const sets: string[] = []
  const values: any[] = []

  for (const key of allowed) {
    if (key in updates) {
      sets.push(`${key} = ?`)
      values.push(key === 'action_config' ? JSON.stringify(updates[key]) : updates[key])
    }
  }

  if (sets.length === 0) return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })

  sets.push('updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER')
  values.push(id, workspaceId)

  await query(`UPDATE alert_rules SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`, values)

  const updated = (await query(
    'SELECT * FROM alert_rules WHERE id = ? AND workspace_id = ?',
    [id, workspaceId]
  )).rows[0] as AlertRule
  return NextResponse.json({ rule: updated })
}

/**
 * DELETE /api/alerts - Delete an alert rule
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const workspaceId = auth.user.workspace_id ?? 1
  const body = await request.json()
  const { id } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const result = await query(
    'DELETE FROM alert_rules WHERE id = ? AND workspace_id = ?',
    [id, workspaceId]
  )

  try {
    await query(
      'INSERT INTO audit_log (action, actor, detail) VALUES (?, ?, ?)',
      ['alert_rule_deleted', auth.user?.username || 'system', `Deleted alert rule #${id}`]
    )
  } catch { /* audit table might not exist */ }

  return NextResponse.json({ deleted: (result.rowCount ?? 0) > 0 })
}

/**
 * Evaluate all enabled alert rules against current data
 */
async function evaluateRules(workspaceId: number) {
  let rules: AlertRule[]
  try {
    rules = (await query(
      'SELECT * FROM alert_rules WHERE enabled = 1 AND workspace_id = ?',
      [workspaceId]
    )).rows as AlertRule[]
  } catch {
    return NextResponse.json({ evaluated: 0, triggered: 0, results: [] })
  }

  const now = Math.floor(Date.now() / 1000)
  const results: { rule_id: number; rule_name: string; triggered: boolean; reason?: string }[] = []

  for (const rule of rules) {
    if (rule.last_triggered_at && (now - rule.last_triggered_at) < rule.cooldown_minutes * 60) {
      results.push({ rule_id: rule.id, rule_name: rule.name, triggered: false, reason: 'In cooldown' })
      continue
    }

    const triggered = await evaluateRule(rule, now, workspaceId)
    results.push({ rule_id: rule.id, rule_name: rule.name, triggered, reason: triggered ? 'Condition met' : 'Condition not met' })

    if (triggered) {
      await query(
        'UPDATE alert_rules SET last_triggered_at = ?, trigger_count = trigger_count + 1 WHERE id = ?',
        [now, rule.id]
      )

      try {
        const config = JSON.parse(rule.action_config || '{}')
        const recipient = config.recipient || 'system'
        await query(`
          INSERT INTO notifications (recipient, type, title, message, source_type, source_id, workspace_id)
          VALUES (?, 'alert', ?, ?, 'alert_rule', ?, ?)
        `, [recipient, `Alert: ${rule.name}`, rule.description || `Rule "${rule.name}" triggered`, rule.id, workspaceId])
      } catch { /* notification creation failed */ }
    }
  }

  const triggered = results.filter(r => r.triggered).length
  return NextResponse.json({ evaluated: rules.length, triggered, results })
}

async function evaluateRule(rule: AlertRule, now: number, workspaceId: number): Promise<boolean> {
  try {
    switch (rule.entity_type) {
      case 'agent': return evaluateAgentRule(rule, now, workspaceId)
      case 'task': return evaluateTaskRule(rule, workspaceId)
      case 'session': return evaluateSessionRule(rule, workspaceId)
      case 'activity': return evaluateActivityRule(rule, now, workspaceId)
      default: return false
    }
  } catch {
    return false
  }
}

async function evaluateAgentRule(rule: AlertRule, now: number, workspaceId: number): Promise<boolean> {
  const { condition_field, condition_operator, condition_value } = rule

  if (condition_operator === 'count_above' || condition_operator === 'count_below') {
    const count = ((await query(
      `SELECT COUNT(*) as c FROM agents WHERE workspace_id = ? AND ${safeColumn('agents', condition_field)} = ?`,
      [workspaceId, condition_value]
    )).rows[0] as any)?.c || 0
    return condition_operator === 'count_above' ? count > parseInt(condition_value) : count < parseInt(condition_value)
  }

  if (condition_operator === 'age_minutes_above') {
    const threshold = now - parseInt(condition_value) * 60
    const count = ((await query(
      `SELECT COUNT(*) as c FROM agents WHERE workspace_id = ? AND status != 'offline' AND ${safeColumn('agents', condition_field)} < ?`,
      [workspaceId, threshold]
    )).rows[0] as any)?.c || 0
    return count > 0
  }

  const agents = (await query(
    `SELECT ${safeColumn('agents', condition_field)} as val FROM agents WHERE workspace_id = ? AND status != 'offline'`,
    [workspaceId]
  )).rows as any[]
  return agents.some(a => compareValue(a.val, condition_operator, condition_value))
}

async function evaluateTaskRule(rule: AlertRule, workspaceId: number): Promise<boolean> {
  const { condition_field, condition_operator, condition_value } = rule

  if (condition_operator === 'count_above') {
    const count = ((await query(
      `SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ? AND ${safeColumn('tasks', condition_field)} = ?`,
      [workspaceId, condition_value]
    )).rows[0] as any)?.c || 0
    return count > parseInt(condition_value)
  }

  if (condition_operator === 'count_below') {
    const count = ((await query(
      'SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ?',
      [workspaceId]
    )).rows[0] as any)?.c || 0
    return count < parseInt(condition_value)
  }

  const tasks = (await query(
    `SELECT ${safeColumn('tasks', condition_field)} as val FROM tasks WHERE workspace_id = ?`,
    [workspaceId]
  )).rows as any[]
  return tasks.some(t => compareValue(t.val, condition_operator, condition_value))
}

async function evaluateSessionRule(rule: AlertRule, workspaceId: number): Promise<boolean> {
  const { condition_operator, condition_value } = rule

  if (condition_operator === 'count_above') {
    const count = ((await query(
      `SELECT COUNT(*) as c FROM agents WHERE workspace_id = ? AND status = 'busy'`,
      [workspaceId]
    )).rows[0] as any)?.c || 0
    return count > parseInt(condition_value)
  }

  return false
}

async function evaluateActivityRule(rule: AlertRule, now: number, workspaceId: number): Promise<boolean> {
  const { condition_field, condition_operator, condition_value } = rule

  if (condition_operator === 'count_above') {
    const hourAgo = now - 3600
    const count = ((await query(
      `SELECT COUNT(*) as c FROM activities WHERE workspace_id = ? AND created_at > ? AND ${safeColumn('activities', condition_field)} = ?`,
      [workspaceId, hourAgo, condition_value]
    )).rows[0] as any)?.c || 0
    return count > parseInt(condition_value)
  }

  return false
}

function compareValue(actual: any, operator: string, expected: string): boolean {
  if (actual == null) return false
  const strActual = String(actual)
  switch (operator) {
    case 'equals': return strActual === expected
    case 'not_equals': return strActual !== expected
    case 'greater_than': return Number(actual) > Number(expected)
    case 'less_than': return Number(actual) < Number(expected)
    case 'contains': return strActual.toLowerCase().includes(expected.toLowerCase())
    default: return false
  }
}

// Whitelist of columns per table to prevent SQL injection
const SAFE_COLUMNS: Record<string, Set<string>> = {
  agents: new Set(['status', 'role', 'name', 'last_seen', 'last_activity']),
  tasks: new Set(['status', 'priority', 'assigned_to', 'title']),
  activities: new Set(['type', 'actor', 'entity_type']),
}

function safeColumn(table: string, column: string): string {
  if (SAFE_COLUMNS[table]?.has(column)) return column
  return 'id' // fallback to safe column
}
