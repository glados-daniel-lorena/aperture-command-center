import { query, withTransaction } from './postgres'

type MigrationFn = (q: typeof query) => Promise<void>

type Migration = {
  id: string
  up: MigrationFn
}

/** Execute multiple semicolon-separated SQL statements */
async function execStmts(q: typeof query, sql: string): Promise<void> {
  const stmts = sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'))
  for (const stmt of stmts) {
    await q(stmt)
  }
}

async function tableExists(q: typeof query, name: string): Promise<boolean> {
  const { rows } = await q<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [name]
  )
  return rows[0]?.exists === true
}

async function columnExists(q: typeof query, table: string, column: string): Promise<boolean> {
  const { rows } = await q<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS exists`,
    [table, column]
  )
  return rows[0]?.exists === true
}

const unixNow = `EXTRACT(EPOCH FROM NOW())::INTEGER`

const migrations: Migration[] = [
  {
    id: '001_init',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS tasks (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'inbox',
          priority TEXT NOT NULL DEFAULT 'medium',
          assigned_to TEXT,
          created_by TEXT NOT NULL DEFAULT 'system',
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          updated_at INTEGER NOT NULL DEFAULT (${unixNow}),
          due_date INTEGER,
          estimated_hours INTEGER,
          actual_hours INTEGER,
          tags TEXT,
          metadata TEXT
        );

        CREATE TABLE IF NOT EXISTS agents (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL,
          session_key TEXT UNIQUE,
          soul_content TEXT,
          status TEXT NOT NULL DEFAULT 'offline',
          last_seen INTEGER,
          last_activity TEXT,
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          updated_at INTEGER NOT NULL DEFAULT (${unixNow}),
          config TEXT
        );

        CREATE TABLE IF NOT EXISTS comments (
          id SERIAL PRIMARY KEY,
          task_id INTEGER NOT NULL,
          author TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          parent_id INTEGER,
          mentions TEXT,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS activities (
          id SERIAL PRIMARY KEY,
          type TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id INTEGER NOT NULL,
          actor TEXT NOT NULL,
          description TEXT NOT NULL,
          data TEXT,
          created_at INTEGER NOT NULL DEFAULT (${unixNow})
        );

        CREATE TABLE IF NOT EXISTS notifications (
          id SERIAL PRIMARY KEY,
          recipient TEXT NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          source_type TEXT,
          source_id INTEGER,
          read_at INTEGER,
          delivered_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (${unixNow})
        );

        CREATE TABLE IF NOT EXISTS task_subscriptions (
          id SERIAL PRIMARY KEY,
          task_id INTEGER NOT NULL,
          agent_name TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          UNIQUE(task_id, agent_name),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS standup_reports (
          date TEXT PRIMARY KEY,
          report TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (${unixNow})
        );

        CREATE TABLE IF NOT EXISTS quality_reviews (
          id SERIAL PRIMARY KEY,
          task_id INTEGER NOT NULL,
          reviewer TEXT NOT NULL,
          status TEXT NOT NULL,
          notes TEXT,
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
        CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
        CREATE INDEX IF NOT EXISTS idx_comments_task_id ON comments(task_id);
        CREATE INDEX IF NOT EXISTS idx_comments_created_at ON comments(created_at);
        CREATE INDEX IF NOT EXISTS idx_activities_created_at ON activities(created_at);
        CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type);
        CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient);
        CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
        CREATE INDEX IF NOT EXISTS idx_agents_session_key ON agents(session_key);
        CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
        CREATE INDEX IF NOT EXISTS idx_task_subscriptions_task_id ON task_subscriptions(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_subscriptions_agent_name ON task_subscriptions(agent_name);
        CREATE INDEX IF NOT EXISTS idx_standup_reports_created_at ON standup_reports(created_at);
        CREATE INDEX IF NOT EXISTS idx_quality_reviews_task_id ON quality_reviews(task_id);
        CREATE INDEX IF NOT EXISTS idx_quality_reviews_reviewer ON quality_reviews(reviewer)
      `)
    }
  },
  {
    id: '002_quality_reviews',
    up: async (q) => {
      // quality_reviews already created in 001, this is a no-op for Postgres
    }
  },
  {
    id: '003_quality_review_status_backfill',
    up: async (q) => {
      await q(`UPDATE tasks SET status = 'quality_review' WHERE status = 'review'`)
    }
  },
  {
    id: '004_messages',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          from_agent TEXT NOT NULL,
          to_agent TEXT,
          content TEXT NOT NULL,
          message_type TEXT DEFAULT 'text',
          metadata TEXT,
          read_at INTEGER,
          created_at INTEGER DEFAULT (${unixNow})
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_agents ON messages(from_agent, to_agent)
      `)
    }
  },
  {
    id: '005_users',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'operator',
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          updated_at INTEGER NOT NULL DEFAULT (${unixNow}),
          last_login_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS user_sessions (
          id SERIAL PRIMARY KEY,
          token TEXT NOT NULL UNIQUE,
          user_id INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          ip_address TEXT,
          user_agent TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at)
      `)
    }
  },
  {
    id: '006_workflow_templates',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS workflow_templates (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          model TEXT NOT NULL DEFAULT 'sonnet',
          task_prompt TEXT NOT NULL,
          timeout_seconds INTEGER NOT NULL DEFAULT 300,
          agent_role TEXT,
          tags TEXT,
          created_by TEXT NOT NULL DEFAULT 'system',
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          updated_at INTEGER NOT NULL DEFAULT (${unixNow}),
          last_used_at INTEGER,
          use_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_templates_name ON workflow_templates(name);
        CREATE INDEX IF NOT EXISTS idx_workflow_templates_created_by ON workflow_templates(created_by)
      `)
    }
  },
  {
    id: '007_audit_log',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS audit_log (
          id SERIAL PRIMARY KEY,
          action TEXT NOT NULL,
          actor TEXT NOT NULL,
          actor_id INTEGER,
          target_type TEXT,
          target_id INTEGER,
          detail TEXT,
          ip_address TEXT,
          user_agent TEXT,
          created_at INTEGER NOT NULL DEFAULT (${unixNow})
        );
        CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
        CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor);
        CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at)
      `)
    }
  },
  {
    id: '008_webhooks',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS webhooks (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          secret TEXT,
          events TEXT NOT NULL DEFAULT '["*"]',
          enabled INTEGER NOT NULL DEFAULT 1,
          last_fired_at INTEGER,
          last_status INTEGER,
          created_by TEXT NOT NULL DEFAULT 'system',
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          updated_at INTEGER NOT NULL DEFAULT (${unixNow})
        );

        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id SERIAL PRIMARY KEY,
          webhook_id INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          status_code INTEGER,
          response_body TEXT,
          error TEXT,
          duration_ms INTEGER,
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_at ON webhook_deliveries(created_at);
        CREATE INDEX IF NOT EXISTS idx_webhooks_enabled ON webhooks(enabled)
      `)
    }
  },
  {
    id: '009_pipelines',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS workflow_pipelines (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          steps TEXT NOT NULL DEFAULT '[]',
          created_by TEXT NOT NULL DEFAULT 'system',
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          updated_at INTEGER NOT NULL DEFAULT (${unixNow}),
          use_count INTEGER NOT NULL DEFAULT 0,
          last_used_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS pipeline_runs (
          id SERIAL PRIMARY KEY,
          pipeline_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          current_step INTEGER NOT NULL DEFAULT 0,
          steps_snapshot TEXT NOT NULL DEFAULT '[]',
          started_at INTEGER,
          completed_at INTEGER,
          triggered_by TEXT NOT NULL DEFAULT 'system',
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          FOREIGN KEY (pipeline_id) REFERENCES workflow_pipelines(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline_id ON pipeline_runs(pipeline_id);
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);
        CREATE INDEX IF NOT EXISTS idx_workflow_pipelines_name ON workflow_pipelines(name)
      `)
    }
  },
  {
    id: '010_settings',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          description TEXT,
          category TEXT NOT NULL DEFAULT 'general',
          updated_by TEXT,
          updated_at INTEGER NOT NULL DEFAULT (${unixNow})
        );
        CREATE INDEX IF NOT EXISTS idx_settings_category ON settings(category)
      `)
    }
  },
  {
    id: '011_alert_rules',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS alert_rules (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          entity_type TEXT NOT NULL,
          condition_field TEXT NOT NULL,
          condition_operator TEXT NOT NULL,
          condition_value TEXT NOT NULL,
          action_type TEXT NOT NULL DEFAULT 'notification',
          action_config TEXT NOT NULL DEFAULT '{}',
          cooldown_minutes INTEGER NOT NULL DEFAULT 60,
          last_triggered_at INTEGER,
          trigger_count INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL DEFAULT 'system',
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          updated_at INTEGER NOT NULL DEFAULT (${unixNow})
        );
        CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);
        CREATE INDEX IF NOT EXISTS idx_alert_rules_entity_type ON alert_rules(entity_type)
      `)
    }
  },
  {
    id: '012_super_admin_tenants',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS tenants (
          id SERIAL PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          linux_user TEXT NOT NULL UNIQUE,
          plan_tier TEXT NOT NULL DEFAULT 'standard',
          status TEXT NOT NULL DEFAULT 'pending',
          openclaw_home TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          gateway_port INTEGER,
          dashboard_port INTEGER,
          config TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL DEFAULT 'system',
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          updated_at INTEGER NOT NULL DEFAULT (${unixNow})
        );

        CREATE TABLE IF NOT EXISTS provision_jobs (
          id SERIAL PRIMARY KEY,
          tenant_id INTEGER NOT NULL,
          job_type TEXT NOT NULL DEFAULT 'bootstrap',
          status TEXT NOT NULL DEFAULT 'queued',
          dry_run INTEGER NOT NULL DEFAULT 1,
          requested_by TEXT NOT NULL DEFAULT 'system',
          approved_by TEXT,
          runner_host TEXT,
          idempotency_key TEXT,
          request_json TEXT NOT NULL DEFAULT '{}',
          plan_json TEXT NOT NULL DEFAULT '[]',
          result_json TEXT,
          error_text TEXT,
          started_at INTEGER,
          completed_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          updated_at INTEGER NOT NULL DEFAULT (${unixNow}),
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS provision_events (
          id SERIAL PRIMARY KEY,
          job_id INTEGER NOT NULL,
          level TEXT NOT NULL DEFAULT 'info',
          step_key TEXT,
          message TEXT NOT NULL,
          data TEXT,
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          FOREIGN KEY (job_id) REFERENCES provision_jobs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
        CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
        CREATE INDEX IF NOT EXISTS idx_provision_jobs_tenant_id ON provision_jobs(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_provision_jobs_status ON provision_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_provision_jobs_created_at ON provision_jobs(created_at);
        CREATE INDEX IF NOT EXISTS idx_provision_events_job_id ON provision_events(job_id);
        CREATE INDEX IF NOT EXISTS idx_provision_events_created_at ON provision_events(created_at)
      `)
    }
  },
  {
    id: '013_tenant_owner_gateway',
    up: async (q) => {
      if (!(await tableExists(q, 'tenants'))) return

      const hasOwnerGateway = await columnExists(q, 'tenants', 'owner_gateway')
      if (!hasOwnerGateway) {
        await q(`ALTER TABLE tenants ADD COLUMN owner_gateway TEXT`)
      }

      const defaultGatewayName =
        String(process.env.MC_DEFAULT_OWNER_GATEWAY || process.env.MC_DEFAULT_GATEWAY_NAME || 'primary').trim() ||
        'primary'

      const hasGateways = await tableExists(q, 'gateways')

      if (hasGateways) {
        await q(`
          UPDATE tenants
          SET owner_gateway = COALESCE(
            (SELECT name FROM gateways ORDER BY is_primary DESC, id ASC LIMIT 1),
            $1
          )
          WHERE owner_gateway IS NULL OR trim(owner_gateway) = ''
        `, [defaultGatewayName])
      } else {
        await q(`
          UPDATE tenants
          SET owner_gateway = $1
          WHERE owner_gateway IS NULL OR trim(owner_gateway) = ''
        `, [defaultGatewayName])
      }

      await q(`CREATE INDEX IF NOT EXISTS idx_tenants_owner_gateway ON tenants(owner_gateway)`)
    }
  },
  {
    id: '014_auth_google_approvals',
    up: async (q) => {
      if (!(await columnExists(q, 'users', 'provider')))
        await q(`ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'local'`)
      if (!(await columnExists(q, 'users', 'provider_user_id')))
        await q(`ALTER TABLE users ADD COLUMN provider_user_id TEXT`)
      if (!(await columnExists(q, 'users', 'email')))
        await q(`ALTER TABLE users ADD COLUMN email TEXT`)
      if (!(await columnExists(q, 'users', 'avatar_url')))
        await q(`ALTER TABLE users ADD COLUMN avatar_url TEXT`)
      if (!(await columnExists(q, 'users', 'is_approved')))
        await q(`ALTER TABLE users ADD COLUMN is_approved INTEGER NOT NULL DEFAULT 1`)
      if (!(await columnExists(q, 'users', 'approved_by')))
        await q(`ALTER TABLE users ADD COLUMN approved_by TEXT`)
      if (!(await columnExists(q, 'users', 'approved_at')))
        await q(`ALTER TABLE users ADD COLUMN approved_at INTEGER`)

      await q(`
        UPDATE users
        SET provider = COALESCE(NULLIF(provider, ''), 'local'),
            is_approved = COALESCE(is_approved, 1)
      `)

      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS access_requests (
          id SERIAL PRIMARY KEY,
          provider TEXT NOT NULL DEFAULT 'google',
          email TEXT NOT NULL,
          provider_user_id TEXT,
          display_name TEXT,
          avatar_url TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          requested_at INTEGER NOT NULL DEFAULT (${unixNow}),
          last_attempt_at INTEGER NOT NULL DEFAULT (${unixNow}),
          attempt_count INTEGER NOT NULL DEFAULT 1,
          reviewed_by TEXT,
          reviewed_at INTEGER,
          review_note TEXT,
          approved_user_id INTEGER,
          FOREIGN KEY (approved_user_id) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_access_requests_email_provider ON access_requests(email, provider);
        CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status);
        CREATE INDEX IF NOT EXISTS idx_users_provider ON users(provider);
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)
      `)
    }
  },
  {
    id: '015_missing_indexes',
    up: async (q) => {
      await execStmts(q, `
        CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications(read_at);
        CREATE INDEX IF NOT EXISTS idx_notifications_recipient_read ON notifications(recipient, read_at);
        CREATE INDEX IF NOT EXISTS idx_activities_actor ON activities(actor);
        CREATE INDEX IF NOT EXISTS idx_activities_entity ON activities(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_messages_read_at ON messages(read_at)
      `)
    }
  },
  {
    id: '016_direct_connections',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS direct_connections (
          id SERIAL PRIMARY KEY,
          agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          tool_name TEXT NOT NULL,
          tool_version TEXT,
          connection_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'connected',
          last_heartbeat INTEGER,
          metadata TEXT,
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          updated_at INTEGER NOT NULL DEFAULT (${unixNow})
        );
        CREATE INDEX IF NOT EXISTS idx_direct_connections_agent_id ON direct_connections(agent_id);
        CREATE INDEX IF NOT EXISTS idx_direct_connections_connection_id ON direct_connections(connection_id);
        CREATE INDEX IF NOT EXISTS idx_direct_connections_status ON direct_connections(status)
      `)
    }
  },
  {
    id: '017_github_sync',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS github_syncs (
          id SERIAL PRIMARY KEY,
          repo TEXT NOT NULL,
          last_synced_at INTEGER NOT NULL DEFAULT (${unixNow}),
          issue_count INTEGER NOT NULL DEFAULT 0,
          sync_direction TEXT NOT NULL DEFAULT 'inbound',
          status TEXT NOT NULL DEFAULT 'success',
          error TEXT,
          created_at INTEGER NOT NULL DEFAULT (${unixNow})
        );
        CREATE INDEX IF NOT EXISTS idx_github_syncs_repo ON github_syncs(repo);
        CREATE INDEX IF NOT EXISTS idx_github_syncs_created_at ON github_syncs(created_at)
      `)
    }
  },
  {
    id: '018_token_usage',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS token_usage (
          id SERIAL PRIMARY KEY,
          model TEXT NOT NULL,
          session_id TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (${unixNow})
        );
        CREATE INDEX IF NOT EXISTS idx_token_usage_session_id ON token_usage(session_id);
        CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage(created_at);
        CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(model)
      `)
    }
  },
  {
    id: '019_webhook_retry',
    up: async (q) => {
      if (!(await columnExists(q, 'webhook_deliveries', 'attempt')))
        await q(`ALTER TABLE webhook_deliveries ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0`)
      if (!(await columnExists(q, 'webhook_deliveries', 'next_retry_at')))
        await q(`ALTER TABLE webhook_deliveries ADD COLUMN next_retry_at INTEGER`)
      if (!(await columnExists(q, 'webhook_deliveries', 'is_retry')))
        await q(`ALTER TABLE webhook_deliveries ADD COLUMN is_retry INTEGER NOT NULL DEFAULT 0`)
      if (!(await columnExists(q, 'webhook_deliveries', 'parent_delivery_id')))
        await q(`ALTER TABLE webhook_deliveries ADD COLUMN parent_delivery_id INTEGER`)
      if (!(await columnExists(q, 'webhooks', 'consecutive_failures')))
        await q(`ALTER TABLE webhooks ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`)

      await q(`CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at) WHERE next_retry_at IS NOT NULL`)
    }
  },
  {
    id: '020_claude_sessions',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS claude_sessions (
          id SERIAL PRIMARY KEY,
          session_id TEXT NOT NULL UNIQUE,
          project_slug TEXT NOT NULL,
          project_path TEXT,
          model TEXT,
          git_branch TEXT,
          user_messages INTEGER NOT NULL DEFAULT 0,
          assistant_messages INTEGER NOT NULL DEFAULT 0,
          tool_uses INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          estimated_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
          first_message_at TEXT,
          last_message_at TEXT,
          last_user_prompt TEXT,
          is_active INTEGER NOT NULL DEFAULT 0,
          scanned_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          updated_at INTEGER NOT NULL DEFAULT (${unixNow})
        );
        CREATE INDEX IF NOT EXISTS idx_claude_sessions_active ON claude_sessions(is_active) WHERE is_active = 1;
        CREATE INDEX IF NOT EXISTS idx_claude_sessions_project ON claude_sessions(project_slug)
      `)
    }
  },
  {
    id: '021_workspace_isolation_phase1',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS workspaces (
          id SERIAL PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          updated_at INTEGER NOT NULL DEFAULT (${unixNow})
        )
      `)

      await q(`
        INSERT INTO workspaces (id, slug, name, created_at, updated_at)
        VALUES (1, 'default', 'Default Workspace', ${unixNow}, ${unixNow})
        ON CONFLICT (id) DO NOTHING
      `)

      const scopedTables = [
        'users', 'user_sessions', 'tasks', 'agents', 'comments',
        'activities', 'notifications', 'quality_reviews', 'standup_reports',
      ]

      for (const table of scopedTables) {
        if (!(await tableExists(q, table))) continue
        if (!(await columnExists(q, table, 'workspace_id'))) {
          await q(`ALTER TABLE ${table} ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1`)
        }
        await q(`UPDATE ${table} SET workspace_id = COALESCE(workspace_id, 1)`)
      }

      await execStmts(q, `
        CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);
        CREATE INDEX IF NOT EXISTS idx_users_workspace_id ON users(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_workspace_id ON user_sessions(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id ON tasks(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_agents_workspace_id ON agents(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_comments_workspace_id ON comments(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_activities_workspace_id ON activities(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_notifications_workspace_id ON notifications(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_quality_reviews_workspace_id ON quality_reviews(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_standup_reports_workspace_id ON standup_reports(workspace_id)
      `)
    }
  },
  {
    id: '022_workspace_isolation_phase2',
    up: async (q) => {
      const scopedTables = [
        'messages', 'alert_rules', 'direct_connections',
        'github_syncs', 'workflow_pipelines', 'pipeline_runs',
      ]

      for (const table of scopedTables) {
        if (!(await tableExists(q, table))) continue
        if (!(await columnExists(q, table, 'workspace_id'))) {
          await q(`ALTER TABLE ${table} ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1`)
        }
        await q(`UPDATE ${table} SET workspace_id = COALESCE(workspace_id, 1)`)
      }

      await execStmts(q, `
        CREATE INDEX IF NOT EXISTS idx_messages_workspace_id ON messages(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_alert_rules_workspace_id ON alert_rules(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_direct_connections_workspace_id ON direct_connections(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_github_syncs_workspace_id ON github_syncs(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_workflow_pipelines_workspace_id ON workflow_pipelines(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_workspace_id ON pipeline_runs(workspace_id)
      `)
    }
  },
  {
    id: '023_workspace_isolation_phase3',
    up: async (q) => {
      const scopedTables = [
        'workflow_templates', 'webhooks', 'webhook_deliveries', 'token_usage',
      ]

      for (const table of scopedTables) {
        if (!(await tableExists(q, table))) continue
        if (!(await columnExists(q, table, 'workspace_id'))) {
          await q(`ALTER TABLE ${table} ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1`)
        }
        await q(`UPDATE ${table} SET workspace_id = COALESCE(workspace_id, 1)`)
      }

      await execStmts(q, `
        CREATE INDEX IF NOT EXISTS idx_workflow_templates_workspace_id ON workflow_templates(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_webhooks_workspace_id ON webhooks(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_workspace_id ON webhook_deliveries(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_token_usage_workspace_id ON token_usage(workspace_id)
      `)
    }
  },
  {
    id: '024_projects_support',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS projects (
          id SERIAL PRIMARY KEY,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          name TEXT NOT NULL,
          slug TEXT NOT NULL,
          description TEXT,
          ticket_prefix TEXT NOT NULL,
          ticket_counter INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          updated_at INTEGER NOT NULL DEFAULT (${unixNow}),
          UNIQUE(workspace_id, slug),
          UNIQUE(workspace_id, ticket_prefix)
        );
        CREATE INDEX IF NOT EXISTS idx_projects_workspace_status ON projects(workspace_id, status)
      `)

      if (!(await columnExists(q, 'tasks', 'project_id')))
        await q(`ALTER TABLE tasks ADD COLUMN project_id INTEGER`)
      if (!(await columnExists(q, 'tasks', 'project_ticket_no')))
        await q(`ALTER TABLE tasks ADD COLUMN project_ticket_no INTEGER`)
      await q(`CREATE INDEX IF NOT EXISTS idx_tasks_workspace_project ON tasks(workspace_id, project_id)`)

      const { rows: workspaceRows } = await q<{ id: number }>(`SELECT id FROM workspaces ORDER BY id ASC`)

      for (const workspace of workspaceRows) {
        await q(`
          INSERT INTO projects (workspace_id, name, slug, description, ticket_prefix, ticket_counter, status, created_at, updated_at)
          VALUES ($1, 'General', 'general', 'Default project for uncategorized tasks', 'TASK', 0, 'active', ${unixNow}, ${unixNow})
          ON CONFLICT (workspace_id, slug) DO NOTHING
        `, [workspace.id])

        const { rows: [defaultProject] } = await q<{ id: number; ticket_counter: number }>(
          `SELECT id, ticket_counter FROM projects WHERE workspace_id = $1 AND slug = 'general' LIMIT 1`,
          [workspace.id]
        )
        if (!defaultProject) continue

        await q(
          `UPDATE tasks SET project_id = $1 WHERE workspace_id = $2 AND (project_id IS NULL OR project_id = 0)`,
          [defaultProject.id, workspace.id]
        )

        const { rows: projectRows } = await q<{ id: number }>(
          `SELECT id FROM projects WHERE workspace_id = $1 ORDER BY id ASC`,
          [workspace.id]
        )

        for (const project of projectRows) {
          const { rows: tasks } = await q<{ id: number }>(
            `SELECT id FROM tasks WHERE workspace_id = $1 AND project_id = $2 ORDER BY created_at ASC, id ASC`,
            [workspace.id, project.id]
          )
          let counter = 0
          for (const task of tasks) {
            counter += 1
            await q(`UPDATE tasks SET project_ticket_no = $1 WHERE id = $2`, [counter, task.id])
          }
          await q(`UPDATE projects SET ticket_counter = $1, updated_at = ${unixNow} WHERE id = $2`, [counter, project.id])
        }
      }
    }
  },
  {
    id: '025_token_usage_task_attribution',
    up: async (q) => {
      if (!(await tableExists(q, 'token_usage'))) return
      if (!(await columnExists(q, 'token_usage', 'task_id')))
        await q(`ALTER TABLE token_usage ADD COLUMN task_id INTEGER`)
      await execStmts(q, `
        CREATE INDEX IF NOT EXISTS idx_token_usage_task_id ON token_usage(task_id);
        CREATE INDEX IF NOT EXISTS idx_token_usage_workspace_task_time ON token_usage(workspace_id, task_id, created_at)
      `)
    }
  },
  {
    id: '026_task_outcome_tracking',
    up: async (q) => {
      if (!(await tableExists(q, 'tasks'))) return
      if (!(await columnExists(q, 'tasks', 'outcome')))
        await q(`ALTER TABLE tasks ADD COLUMN outcome TEXT`)
      if (!(await columnExists(q, 'tasks', 'error_message')))
        await q(`ALTER TABLE tasks ADD COLUMN error_message TEXT`)
      if (!(await columnExists(q, 'tasks', 'resolution')))
        await q(`ALTER TABLE tasks ADD COLUMN resolution TEXT`)
      if (!(await columnExists(q, 'tasks', 'feedback_rating')))
        await q(`ALTER TABLE tasks ADD COLUMN feedback_rating INTEGER`)
      if (!(await columnExists(q, 'tasks', 'feedback_notes')))
        await q(`ALTER TABLE tasks ADD COLUMN feedback_notes TEXT`)
      if (!(await columnExists(q, 'tasks', 'retry_count')))
        await q(`ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`)
      if (!(await columnExists(q, 'tasks', 'completed_at')))
        await q(`ALTER TABLE tasks ADD COLUMN completed_at INTEGER`)

      await execStmts(q, `
        CREATE INDEX IF NOT EXISTS idx_tasks_outcome ON tasks(outcome);
        CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_workspace_outcome ON tasks(workspace_id, outcome, completed_at)
      `)
    }
  },
  {
    id: '027_agent_api_keys',
    up: async (q) => {
      if (!(await tableExists(q, 'agents'))) return
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS agent_api_keys (
          id SERIAL PRIMARY KEY,
          agent_id INTEGER NOT NULL,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          name TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          key_prefix TEXT NOT NULL,
          scopes TEXT NOT NULL DEFAULT '["viewer"]',
          expires_at INTEGER,
          revoked_at INTEGER,
          created_by TEXT,
          last_used_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          updated_at INTEGER NOT NULL DEFAULT (${unixNow}),
          FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_api_keys_agent_id ON agent_api_keys(agent_id);
        CREATE INDEX IF NOT EXISTS idx_agent_api_keys_workspace_id ON agent_api_keys(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_agent_api_keys_expires_at ON agent_api_keys(expires_at);
        CREATE INDEX IF NOT EXISTS idx_agent_api_keys_revoked_at ON agent_api_keys(revoked_at)
      `)
    }
  },
  {
    id: '028_agent_avatar_url',
    up: async (q) => {
      if (!(await columnExists(q, 'agents', 'avatar_url')))
        await q(`ALTER TABLE agents ADD COLUMN avatar_url TEXT`)

      // Seed existing agents with their Discord avatar URLs
      const avatars: Record<string, string> = {
        'GLaDOS': 'https://cdn.discordapp.com/avatars/1479306655014588560/d5eb7cdb0cf3a585f788ec4f4a10522e.png?size=256',
        'P-Body': 'https://cdn.discordapp.com/avatars/1479554972377944286/ac6ac7d5462d36a8530a33d6429839c8.png?size=256',
        'Atlas': 'https://cdn.discordapp.com/avatars/1479568371304497243/f7984a6f4686751e5ff9224fbfd609d6.png?size=256',
        'Wheatley': 'https://cdn.discordapp.com/avatars/1479568994171097339/7ab0b8c0ebf2796cc0eab9d16f7a53ee.png?size=256',
        'Cave Johnson': 'https://cdn.discordapp.com/avatars/1479569855656231126/17a9924784981cf8543703f618a7e0dd.png?size=256',
      }
      for (const [name, url] of Object.entries(avatars)) {
        await q(`UPDATE agents SET avatar_url = $1 WHERE name = $2 AND (avatar_url IS NULL OR avatar_url = '')`, [url, name])
      }
    }
  },
  {
    id: '029_escalations',
    up: async (q) => {
      await execStmts(q, `
        CREATE TABLE IF NOT EXISTS escalations (
          id SERIAL PRIMARY KEY,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          agent_name TEXT NOT NULL,
          project TEXT,
          priority TEXT NOT NULL DEFAULT 'fyi',
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          context TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          response TEXT,
          created_at INTEGER NOT NULL DEFAULT (${unixNow}),
          responded_at INTEGER,
          resolved_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);
        CREATE INDEX IF NOT EXISTS idx_escalations_priority ON escalations(priority);
        CREATE INDEX IF NOT EXISTS idx_escalations_workspace_id ON escalations(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_escalations_created_at ON escalations(created_at)
      `)
    }
  }
]

let migrationPromise: Promise<void> | null = null

export async function runMigrations(): Promise<void> {
  if (migrationPromise) return migrationPromise
  migrationPromise = _runMigrations()
  return migrationPromise
}

async function _runMigrations(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (${unixNow})
    )
  `)

  const { rows } = await query<{ id: string }>('SELECT id FROM schema_migrations')
  const applied = new Set(rows.map((r) => r.id))

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue
    await withTransaction(async (txQuery) => {
      await migration.up(txQuery as typeof query)
      await txQuery(
        'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
        [migration.id]
      )
    })
  }
}
