import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';

const ALLOWED_SECTIONS = ['summary', 'tasks', 'errors', 'activity', 'trends', 'tokens'] as const;
type DiagnosticsSection = (typeof ALLOWED_SECTIONS)[number];

function parseHoursParam(raw: string | null): { value?: number; error?: string } {
  if (raw === null) return { value: 24 };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    return { error: 'hours must be an integer between 1 and 720' };
  }
  if (parsed < 1 || parsed > 720) {
    return { error: 'hours must be between 1 and 720' };
  }
  return { value: parsed };
}

function parseSectionsParam(raw: string | null): { value?: Set<DiagnosticsSection>; error?: string } {
  if (!raw || raw.trim().length === 0) {
    return { value: new Set(ALLOWED_SECTIONS) };
  }

  const requested = raw
    .split(',')
    .map((section) => section.trim())
    .filter(Boolean);

  if (requested.length === 0) {
    return { error: 'section must include at least one valid value' };
  }

  const invalid = requested.filter((section) => !ALLOWED_SECTIONS.includes(section as DiagnosticsSection));
  if (invalid.length > 0) {
    return { error: `Invalid section value(s): ${invalid.join(', ')}` };
  }

  return { value: new Set(requested as DiagnosticsSection[]) };
}

/**
 * GET /api/agents/[id]/diagnostics - Agent Self-Diagnostics API
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

    // Resolve agent by ID or name
    const agent = (await (
      /^\d+$/.test(agentId)
        ? query('SELECT id, name, role, status, last_seen, created_at FROM agents WHERE id = ? AND workspace_id = ?', [Number(agentId), workspaceId])
        : query('SELECT id, name, role, status, last_seen, created_at FROM agents WHERE name = ? AND workspace_id = ?', [agentId, workspaceId])
    )).rows[0] as any

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const requesterAgentName = auth.user.agent_name?.trim() || '';
    const privileged = searchParams.get('privileged') === '1';
    const isSelfRequest = (requesterAgentName || auth.user.username) === agent.name;

    if (!isSelfRequest && !(privileged && auth.user.role === 'admin')) {
      return NextResponse.json(
        { error: 'Diagnostics are self-scoped. Use privileged=1 with admin role for cross-agent access.' },
        { status: 403 }
      );
    }

    const parsedHours = parseHoursParam(searchParams.get('hours'));
    if (parsedHours.error) {
      return NextResponse.json({ error: parsedHours.error }, { status: 400 });
    }

    const parsedSections = parseSectionsParam(searchParams.get('section'));
    if (parsedSections.error) {
      return NextResponse.json({ error: parsedSections.error }, { status: 400 });
    }

    const hours = parsedHours.value as number;
    const sections = parsedSections.value as Set<DiagnosticsSection>;

    const now = Math.floor(Date.now() / 1000);
    const since = now - hours * 3600;

    const result: Record<string, any> = {
      agent: { id: agent.id, name: agent.name, role: agent.role, status: agent.status },
      timeframe: { hours, since, until: now },
    };

    if (sections.has('summary')) {
      result.summary = await buildSummary(agent.name, workspaceId, since);
    }

    if (sections.has('tasks')) {
      result.tasks = await buildTaskMetrics(agent.name, workspaceId, since);
    }

    if (sections.has('errors')) {
      result.errors = await buildErrorAnalysis(agent.name, workspaceId, since);
    }

    if (sections.has('activity')) {
      result.activity = await buildActivityBreakdown(agent.name, workspaceId, since);
    }

    if (sections.has('trends')) {
      result.trends = await buildTrends(agent.name, workspaceId, hours);
    }

    if (sections.has('tokens')) {
      result.tokens = await buildTokenMetrics(agent.name, workspaceId, since);
    }

    return NextResponse.json(result);
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/[id]/diagnostics error');
    return NextResponse.json({ error: 'Failed to fetch diagnostics' }, { status: 500 });
  }
}

/** High-level KPIs */
async function buildSummary(agentName: string, workspaceId: number, since: number) {
  const tasksDone = ((await query(
    `SELECT COUNT(*) as c FROM tasks WHERE assigned_to = ? AND workspace_id = ? AND status = 'done' AND updated_at >= ?`,
    [agentName, workspaceId, since]
  )).rows[0] as any).c;

  const tasksTotal = ((await query(
    `SELECT COUNT(*) as c FROM tasks WHERE assigned_to = ? AND workspace_id = ?`,
    [agentName, workspaceId]
  )).rows[0] as any).c;

  const activityCount = ((await query(
    `SELECT COUNT(*) as c FROM activities WHERE actor = ? AND workspace_id = ? AND created_at >= ?`,
    [agentName, workspaceId, since]
  )).rows[0] as any).c;

  const errorCount = ((await query(
    `SELECT COUNT(*) as c FROM activities WHERE actor = ? AND workspace_id = ? AND created_at >= ? AND type LIKE '%error%'`,
    [agentName, workspaceId, since]
  )).rows[0] as any).c;

  const errorRate = activityCount > 0 ? Math.round((errorCount / activityCount) * 10000) / 100 : 0;

  return {
    tasks_completed: tasksDone,
    tasks_total: tasksTotal,
    activity_count: activityCount,
    error_count: errorCount,
    error_rate_percent: errorRate,
  };
}

/** Task completion breakdown */
async function buildTaskMetrics(agentName: string, workspaceId: number, since: number) {
  const byStatus = (await query(
    `SELECT status, COUNT(*) as count FROM tasks WHERE assigned_to = ? AND workspace_id = ? GROUP BY status`,
    [agentName, workspaceId]
  )).rows as Array<{ status: string; count: number }>;

  const byPriority = (await query(
    `SELECT priority, COUNT(*) as count FROM tasks WHERE assigned_to = ? AND workspace_id = ? GROUP BY priority`,
    [agentName, workspaceId]
  )).rows as Array<{ priority: string; count: number }>;

  const recentCompleted = (await query(
    `SELECT id, title, priority, updated_at FROM tasks WHERE assigned_to = ? AND workspace_id = ? AND status = 'done' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 10`,
    [agentName, workspaceId, since]
  )).rows as any[];

  const windowDays = Math.max((Math.floor(Date.now() / 1000) - since) / 86400, 1);
  const completedInWindow = recentCompleted.length;
  const throughputPerDay = Math.round((completedInWindow / windowDays) * 100) / 100;

  return {
    by_status: Object.fromEntries(byStatus.map(r => [r.status, r.count])),
    by_priority: Object.fromEntries(byPriority.map(r => [r.priority, r.count])),
    recent_completed: recentCompleted,
    throughput_per_day: throughputPerDay,
  };
}

/** Error frequency and analysis */
async function buildErrorAnalysis(agentName: string, workspaceId: number, since: number) {
  const errorActivities = (await query(
    `SELECT type, COUNT(*) as count FROM activities WHERE actor = ? AND workspace_id = ? AND created_at >= ? AND (type LIKE '%error%' OR type LIKE '%fail%') GROUP BY type ORDER BY count DESC`,
    [agentName, workspaceId, since]
  )).rows as Array<{ type: string; count: number }>;

  const recentErrors = (await query(
    `SELECT id, type, description, data, created_at FROM activities WHERE actor = ? AND workspace_id = ? AND created_at >= ? AND (type LIKE '%error%' OR type LIKE '%fail%') ORDER BY created_at DESC LIMIT 20`,
    [agentName, workspaceId, since]
  )).rows as any[];

  return {
    by_type: errorActivities,
    total: errorActivities.reduce((sum, e) => sum + e.count, 0),
    recent: recentErrors.map(e => ({
      ...e,
      data: e.data ? JSON.parse(e.data) : null,
    })),
  };
}

/** Activity breakdown with hourly timeline */
async function buildActivityBreakdown(agentName: string, workspaceId: number, since: number) {
  const byType = (await query(
    `SELECT type, COUNT(*) as count FROM activities WHERE actor = ? AND workspace_id = ? AND created_at >= ? GROUP BY type ORDER BY count DESC`,
    [agentName, workspaceId, since]
  )).rows as Array<{ type: string; count: number }>;

  const timeline = (await query(
    `SELECT (created_at / 3600) * 3600 as hour_bucket, COUNT(*) as count FROM activities WHERE actor = ? AND workspace_id = ? AND created_at >= ? GROUP BY hour_bucket ORDER BY hour_bucket ASC`,
    [agentName, workspaceId, since]
  )).rows as Array<{ hour_bucket: number; count: number }>;

  return {
    by_type: byType,
    timeline: timeline.map(t => ({
      timestamp: t.hour_bucket,
      hour: new Date(t.hour_bucket * 1000).toISOString(),
      count: t.count,
    })),
  };
}

/** Multi-period trend comparison */
async function buildTrends(agentName: string, workspaceId: number, hours: number) {
  const now = Math.floor(Date.now() / 1000);
  const currentSince = now - hours * 3600;
  const previousSince = currentSince - hours * 3600;

  async function periodMetrics(since: number, until: number) {
    const activities = ((await query(
      `SELECT COUNT(*) as c FROM activities WHERE actor = ? AND workspace_id = ? AND created_at >= ? AND created_at < ?`,
      [agentName, workspaceId, since, until]
    )).rows[0] as any).c;

    const errors = ((await query(
      `SELECT COUNT(*) as c FROM activities WHERE actor = ? AND workspace_id = ? AND created_at >= ? AND created_at < ? AND (type LIKE '%error%' OR type LIKE '%fail%')`,
      [agentName, workspaceId, since, until]
    )).rows[0] as any).c;

    const tasksCompleted = ((await query(
      `SELECT COUNT(*) as c FROM tasks WHERE assigned_to = ? AND workspace_id = ? AND status = 'done' AND updated_at >= ? AND updated_at < ?`,
      [agentName, workspaceId, since, until]
    )).rows[0] as any).c;

    return { activities, errors, tasks_completed: tasksCompleted };
  }

  const current = await periodMetrics(currentSince, now);
  const previous = await periodMetrics(previousSince, currentSince);

  const pctChange = (cur: number, prev: number) => {
    if (prev === 0) return cur > 0 ? 100 : 0;
    return Math.round(((cur - prev) / prev) * 10000) / 100;
  };

  return {
    current_period: { since: currentSince, until: now, ...current },
    previous_period: { since: previousSince, until: currentSince, ...previous },
    change: {
      activities_pct: pctChange(current.activities, previous.activities),
      errors_pct: pctChange(current.errors, previous.errors),
      tasks_completed_pct: pctChange(current.tasks_completed, previous.tasks_completed),
    },
    alerts: buildTrendAlerts(current, previous),
  };
}

/** Generate automatic alerts from trend data */
function buildTrendAlerts(current: { activities: number; errors: number; tasks_completed: number }, previous: { activities: number; errors: number; tasks_completed: number }) {
  const alerts: Array<{ level: string; message: string }> = [];

  if (current.errors > 0 && previous.errors > 0) {
    const errorIncrease = (current.errors - previous.errors) / previous.errors;
    if (errorIncrease > 0.5) {
      alerts.push({ level: 'warning', message: `Error count increased ${Math.round(errorIncrease * 100)}% vs previous period` });
    }
  } else if (current.errors > 3 && previous.errors === 0) {
    alerts.push({ level: 'warning', message: `New error pattern: ${current.errors} errors (none in previous period)` });
  }

  if (previous.tasks_completed > 0 && current.tasks_completed === 0) {
    alerts.push({ level: 'info', message: 'No tasks completed in current period (possible stall)' });
  } else if (previous.tasks_completed > 2 && current.tasks_completed < previous.tasks_completed * 0.5) {
    alerts.push({ level: 'info', message: `Task throughput dropped ${Math.round((1 - current.tasks_completed / previous.tasks_completed) * 100)}%` });
  }

  if (previous.activities > 5 && current.activities < previous.activities * 0.25) {
    alerts.push({ level: 'warning', message: `Activity dropped ${Math.round((1 - current.activities / previous.activities) * 100)}% — agent may be stalled` });
  }

  return alerts;
}

/** Token usage by model */
async function buildTokenMetrics(agentName: string, workspaceId: number, since: number) {
  try {
    const byModel = (await query(
      `SELECT model, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens, COUNT(*) as request_count FROM token_usage WHERE session_id = ? AND workspace_id = ? AND created_at >= ? GROUP BY model ORDER BY (input_tokens + output_tokens) DESC`,
      [agentName, workspaceId, since]
    )).rows as Array<{ model: string; input_tokens: number; output_tokens: number; request_count: number }>;

    const total = byModel.reduce((acc, r) => ({
      input_tokens: acc.input_tokens + r.input_tokens,
      output_tokens: acc.output_tokens + r.output_tokens,
      requests: acc.requests + r.request_count,
    }), { input_tokens: 0, output_tokens: 0, requests: 0 });

    return {
      by_model: byModel,
      total,
    };
  } catch {
    return { by_model: [], total: { input_tokens: 0, output_tokens: 0, requests: 0 } };
  }
}
