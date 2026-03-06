import { query, withTransaction } from './postgres'
import { runMigrations } from './migrations'
import { eventBus } from './event-bus'
import { hashPassword } from './password'
import { logger } from './logger'
import { parseMentions as parseMentionTokens } from './mentions'

export { query } from './postgres'

// Lazy migration guard — runs once per process
let _initialized = false
let _initPromise: Promise<void> | null = null

export async function ensureInitialized(): Promise<void> {
  if (_initialized) return
  if (!_initPromise) {
    _initPromise = (async () => {
      await runMigrations()
      // Skip seeding during next build
      if (process.env.NEXT_PHASE !== 'phase-production-build') {
        await seedAdminUserFromEnv(process.env)
      }
      _initialized = true
    })()
  }
  return _initPromise
}

interface CountRow { count: number }

const INSECURE_PASSWORDS = new Set([
  'admin',
  'password',
  'change-me-on-first-login',
  'changeme',
  'testpass123',
])

export function resolveSeedAuthPassword(env: NodeJS.ProcessEnv = process.env): string | null {
  const b64 = env.AUTH_PASS_B64
  if (b64 && b64.trim().length > 0) {
    const normalized = b64.trim()
    const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
    if (!base64Pattern.test(normalized)) {
      logger.warn('AUTH_PASS_B64 is not valid base64; falling back to AUTH_PASS')
      return env.AUTH_PASS || null
    }

    try {
      const decoded = Buffer.from(normalized, 'base64').toString('utf8')
      const canonical = Buffer.from(decoded, 'utf8').toString('base64')
      if (canonical !== normalized) {
        logger.warn('AUTH_PASS_B64 failed base64 verification; falling back to AUTH_PASS')
        return env.AUTH_PASS || null
      }
      if (decoded.length > 0) return decoded
      logger.warn('AUTH_PASS_B64 is set but decoded to an empty value; falling back to AUTH_PASS')
    } catch {
      logger.warn('AUTH_PASS_B64 is not valid base64; falling back to AUTH_PASS')
    }
  }

  return env.AUTH_PASS || null
}

async function seedAdminUserFromEnv(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.NEXT_PHASE === 'phase-production-build') return

  const { rows } = await query<CountRow>('SELECT COUNT(*) as count FROM users')
  const count = rows[0]?.count ?? 0
  if (Number(count) > 0) return

  const username = env.AUTH_USER || 'admin'
  const password = resolveSeedAuthPassword(env)

  if (!password) {
    logger.warn(
      'AUTH_PASS is not set — skipping admin user seeding. ' +
      'Set AUTH_PASS (quote values containing #) or AUTH_PASS_B64 in your environment.'
    )
    return
  }

  if (INSECURE_PASSWORDS.has(password)) {
    logger.warn(
      `AUTH_PASS matches a known insecure default ("${password}"). ` +
      'Please set a strong, unique password in your .env file. ' +
      'Skipping admin user seeding until credentials are changed.'
    )
    return
  }

  const displayName = username.charAt(0).toUpperCase() + username.slice(1)

  await query(
    `INSERT INTO users (username, display_name, password_hash, role)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (username) DO NOTHING`,
    [username, displayName, hashPassword(password), 'admin']
  )

  logger.info(`Seeded admin user: ${username}`)
}

// Type definitions for database entities
export interface Task {
  id: number;
  title: string;
  description?: string;
  status: 'inbox' | 'assigned' | 'in_progress' | 'review' | 'quality_review' | 'done';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  project_id?: number;
  project_ticket_no?: number;
  project_name?: string;
  project_prefix?: string;
  ticket_ref?: string;
  assigned_to?: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  due_date?: number;
  estimated_hours?: number;
  actual_hours?: number;
  outcome?: 'success' | 'failed' | 'partial' | 'abandoned';
  error_message?: string;
  resolution?: string;
  feedback_rating?: number;
  feedback_notes?: string;
  retry_count?: number;
  completed_at?: number;
  tags?: string;
  metadata?: string;
}

export interface Agent {
  id: number;
  name: string;
  role: string;
  session_key?: string;
  soul_content?: string;
  status: 'offline' | 'idle' | 'busy' | 'error';
  last_seen?: number;
  last_activity?: string;
  created_at: number;
  updated_at: number;
  config?: string;
  avatar_url?: string;
}

export interface Comment {
  id: number;
  task_id: number;
  author: string;
  content: string;
  created_at: number;
  parent_id?: number;
  mentions?: string;
}

export interface Activity {
  id: number;
  type: string;
  entity_type: string;
  entity_id: number;
  actor: string;
  description: string;
  data?: string;
  created_at: number;
}

export interface Message {
  id: number;
  conversation_id: string;
  from_agent: string;
  to_agent?: string;
  content: string;
  message_type: string;
  metadata?: string;
  read_at?: number;
  created_at: number;
}

export interface Notification {
  id: number;
  recipient: string;
  type: string;
  title: string;
  message: string;
  source_type?: string;
  source_id?: number;
  read_at?: number;
  delivered_at?: number;
  created_at: number;
}

export interface Tenant {
  id: number
  slug: string
  display_name: string
  linux_user: string
  plan_tier: string
  status: 'pending' | 'provisioning' | 'active' | 'suspended' | 'error'
  openclaw_home: string
  workspace_root: string
  gateway_port?: number
  dashboard_port?: number
  config?: string
  created_by: string
  owner_gateway?: string
  created_at: number
  updated_at: number
}

export interface ProvisionJob {
  id: number
  tenant_id: number
  job_type: 'bootstrap' | 'update' | 'decommission'
  status: 'queued' | 'approved' | 'running' | 'completed' | 'failed' | 'rejected' | 'cancelled'
  dry_run: 0 | 1
  requested_by: string
  approved_by?: string
  runner_host?: string
  idempotency_key?: string
  request_json?: string
  plan_json?: string
  result_json?: string
  error_text?: string
  started_at?: number
  completed_at?: number
  created_at: number
  updated_at: number
}

export interface ProvisionEvent {
  id: number
  job_id: number
  level: 'info' | 'warn' | 'error'
  step_key?: string
  message: string
  data?: string
  created_at: number
}

export const db_helpers = {
  logActivity: async (
    type: string,
    entity_type: string,
    entity_id: number,
    actor: string,
    description: string,
    data?: any,
    workspaceId: number = 1
  ) => {
    const { rows } = await query(
      `INSERT INTO activities (type, entity_type, entity_id, actor, description, data, workspace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      [type, entity_type, entity_id, actor, description, data ? JSON.stringify(data) : null, workspaceId]
    )

    const activityPayload = {
      id: rows[0]?.id,
      type,
      entity_type,
      entity_id,
      actor,
      description,
      data: data || null,
      created_at: Math.floor(Date.now() / 1000),
      workspace_id: workspaceId,
    }

    eventBus.broadcast('activity.created', activityPayload)
  },

  createNotification: async (
    recipient: string,
    type: string,
    title: string,
    message: string,
    source_type?: string,
    source_id?: number,
    workspaceId: number = 1
  ) => {
    const { rows } = await query(
      `INSERT INTO notifications (recipient, type, title, message, source_type, source_id, workspace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      [recipient, type, title, message, source_type, source_id, workspaceId]
    )

    const notificationPayload = {
      id: rows[0]?.id,
      recipient,
      type,
      title,
      message,
      source_type: source_type || null,
      source_id: source_id || null,
      created_at: Math.floor(Date.now() / 1000),
      workspace_id: workspaceId,
    }

    eventBus.broadcast('notification.created', notificationPayload)

    return rows[0]
  },

  parseMentions: (text: string): string[] => {
    return parseMentionTokens(text)
  },

  updateAgentStatus: async (agentName: string, status: Agent['status'], activity?: string, workspaceId: number = 1) => {
    const now = Math.floor(Date.now() / 1000)

    const { rows: agentRows } = await query<{ id: number }>(
      'SELECT id FROM agents WHERE name = ? AND workspace_id = ?',
      [agentName, workspaceId]
    )
    const agent = agentRows[0]

    await query(
      `UPDATE agents SET status = ?, last_seen = ?, last_activity = ?, updated_at = ?
       WHERE name = ? AND workspace_id = ?`,
      [status, now, activity, now, agentName, workspaceId]
    )

    if (agent) {
      eventBus.broadcast('agent.status_changed', {
        id: agent.id,
        name: agentName,
        status,
        last_seen: now,
        last_activity: activity || null,
      })
    }

    void db_helpers.logActivity(
      'agent_status_change', 'agent', agent?.id || 0, agentName,
      `Agent status changed to ${status}`, { status, activity }, workspaceId
    )
  },

  getRecentActivities: async (limit: number = 50): Promise<Activity[]> => {
    const { rows } = await query<Activity>(
      `SELECT * FROM activities ORDER BY created_at DESC LIMIT ?`,
      [limit]
    )
    return rows
  },

  getUnreadNotifications: async (recipient: string, workspaceId: number = 1): Promise<Notification[]> => {
    const { rows } = await query<Notification>(
      `SELECT * FROM notifications
       WHERE recipient = ? AND read_at IS NULL AND workspace_id = ?
       ORDER BY created_at DESC`,
      [recipient, workspaceId]
    )
    return rows
  },

  markNotificationRead: async (notificationId: number, workspaceId: number = 1) => {
    await query(
      `UPDATE notifications SET read_at = ? WHERE id = ? AND workspace_id = ?`,
      [Math.floor(Date.now() / 1000), notificationId, workspaceId]
    )
  },

  ensureTaskSubscription: async (taskId: number, agentName: string, workspaceId: number = 1) => {
    if (!agentName) return
    await query(
      `INSERT INTO task_subscriptions (task_id, agent_name)
       SELECT t.id, ?
       FROM tasks t
       WHERE t.id = ? AND t.workspace_id = ?
       ON CONFLICT (task_id, agent_name) DO NOTHING`,
      [agentName, taskId, workspaceId]
    )
  },

  getTaskSubscribers: async (taskId: number, workspaceId: number = 1): Promise<string[]> => {
    const { rows } = await query<{ agent_name: string }>(
      `SELECT ts.agent_name
       FROM task_subscriptions ts
       JOIN tasks t ON t.id = ts.task_id
       WHERE ts.task_id = ? AND t.workspace_id = ?`,
      [taskId, workspaceId]
    )
    return rows.map((row) => row.agent_name)
  }
}

export async function logAuditEvent(event: {
  action: string
  actor: string
  actor_id?: number
  target_type?: string
  target_id?: number
  detail?: any
  ip_address?: string
  user_agent?: string
}) {
  await query(
    `INSERT INTO audit_log (action, actor, actor_id, target_type, target_id, detail, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.action,
      event.actor,
      event.actor_id ?? null,
      event.target_type ?? null,
      event.target_id ?? null,
      event.detail ? JSON.stringify(event.detail) : null,
      event.ip_address ?? null,
      event.user_agent ?? null,
    ]
  )

  const securityEvents = ['login_failed', 'user_created', 'user_deleted', 'password_change']
  if (securityEvents.includes(event.action)) {
    eventBus.broadcast('audit.security', {
      action: event.action,
      actor: event.actor,
      target_type: event.target_type ?? null,
      target_id: event.target_id ?? null,
      timestamp: Math.floor(Date.now() / 1000),
    })
  }
}

export async function appendProvisionEvent(event: {
  job_id: number
  level?: 'info' | 'warn' | 'error'
  step_key?: string
  message: string
  data?: any
}) {
  await query(
    `INSERT INTO provision_events (job_id, level, step_key, message, data)
     VALUES (?, ?, ?, ?, ?)`,
    [
      event.job_id,
      event.level || 'info',
      event.step_key ?? null,
      event.message,
      event.data ? JSON.stringify(event.data) : null,
    ]
  )
}

// Initialize on server side (non-blocking — runs migrations in background)
if (typeof window === 'undefined' && process.env.NEXT_PHASE !== 'phase-production-build') {
  ensureInitialized().catch((err) => {
    logger.error({ err }, 'Failed to initialize database')
  })
}
