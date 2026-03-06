'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClientLogger } from '@/lib/client-logger'

const log = createClientLogger('TerminalPanel')

interface Agent {
  id: number
  name: string
  role: string
  status: string
  current_task?: string
  current_ticket?: string
  last_active?: number
  last_seen?: number
  avatar_url?: string
  session_key?: string
}

interface Escalation {
  id: number
  agent_name: string
  priority: 'blocked' | 'question' | 'fyi'
  title: string
  status: string
  created_at: number
}

interface Activity {
  id: number
  type: string
  actor: string
  description: string
  created_at: number
}

const STATUS_CONFIG: Record<string, { label: string; dot: string; ring: string; text: string }> = {
  active:   { label: 'ACTIVE',   dot: 'bg-green-400',  ring: 'ring-green-400/30',  text: 'text-green-400' },
  working:  { label: 'WORKING',  dot: 'bg-blue-400',   ring: 'ring-blue-400/30',   text: 'text-blue-400' },
  busy:     { label: 'WORKING',  dot: 'bg-blue-400',   ring: 'ring-blue-400/30',   text: 'text-blue-400' },
  blocked:  { label: 'BLOCKED',  dot: 'bg-red-400',    ring: 'ring-red-400/30',    text: 'text-red-400' },
  error:    { label: 'ERROR',    dot: 'bg-red-500',    ring: 'ring-red-500/30',    text: 'text-red-400' },
  idle:     { label: 'IDLE',     dot: 'bg-amber-400',  ring: 'ring-amber-400/30',  text: 'text-amber-400' },
  offline:  { label: 'OFFLINE',  dot: 'bg-zinc-500',   ring: 'ring-zinc-500/30',   text: 'text-zinc-400' },
}

const PRIORITY_EMOJI: Record<string, string> = {
  blocked: '🔴',
  question: '🟡',
  fyi: '🟢',
}

function formatAge(timestamp?: number): string {
  if (!timestamp) return 'never'
  const diff = Date.now() - timestamp * 1000
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  if (seconds < 10) return 'just now'
  return `${seconds}s ago`
}

function AgentCard({ agent }: { agent: Agent }) {
  const cfg = STATUS_CONFIG[agent.status] || STATUS_CONFIG.offline
  const initials = agent.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

  return (
    <div className={`relative bg-card border border-border rounded-xl p-4 flex flex-col gap-3 ring-1 ${cfg.ring} transition-all`}>
      {/* Avatar + status */}
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          {agent.avatar_url ? (
            <img
              src={agent.avatar_url}
              alt={agent.name}
              className="w-10 h-10 rounded-full object-cover"
            />
          ) : (
            <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-xs font-bold text-foreground">
              {initials}
            </div>
          )}
          {/* Status dot */}
          <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-card ${cfg.dot}`} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-semibold text-foreground truncate">{agent.name}</p>
            <span className={`text-2xs font-bold uppercase tracking-wider ${cfg.text}`}>{cfg.label}</span>
          </div>
          <p className="text-2xs text-muted-foreground truncate">{agent.role}</p>
        </div>
      </div>

      {/* Current task */}
      <div className="min-h-[2.5rem]">
        {agent.current_task ? (
          <div>
            <p className="text-2xs text-muted-foreground uppercase tracking-wide mb-0.5">Current Task</p>
            <p className="text-xs text-foreground/90 line-clamp-2">{agent.current_task}</p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground/50 italic">No active task</p>
        )}
      </div>

      {/* Ticket + Last active */}
      <div className="flex items-center justify-between text-2xs">
        <span className="text-muted-foreground">
          {agent.current_ticket ? (
            <span className="font-mono text-blue-400/80 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded">
              {agent.current_ticket}
            </span>
          ) : (
            <span className="text-muted-foreground/40">—</span>
          )}
        </span>
        <span className="text-muted-foreground/60">{formatAge(agent.last_active ?? agent.last_seen)}</span>
      </div>
    </div>
  )
}

function ActivityItem({ item, isEscalation }: { item: any; isEscalation?: boolean }) {
  if (isEscalation) {
    return (
      <div className="flex items-start gap-2.5 py-2 border-b border-border/30 last:border-0">
        <span className="text-sm shrink-0 mt-px">{PRIORITY_EMOJI[item.priority] || '⚪'}</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-foreground/90 truncate">
            <span className="font-medium">{item.agent_name}</span> escalated: {item.title}
          </p>
          <p className="text-2xs text-muted-foreground">{formatAge(item.created_at)}</p>
        </div>
        <span className={`text-2xs px-1.5 py-0.5 rounded border shrink-0 ${
          item.status === 'open'
            ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
            : 'text-green-400 bg-green-500/10 border-green-500/20'
        }`}>
          {item.status}
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-2.5 py-2 border-b border-border/30 last:border-0">
      <div className="w-1.5 h-1.5 rounded-full bg-primary/50 shrink-0 mt-1.5" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-foreground/80 line-clamp-2">{item.description}</p>
        <p className="text-2xs text-muted-foreground">{item.actor} · {formatAge(item.created_at)}</p>
      </div>
    </div>
  )
}

export function TerminalPanel() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [escalations, setEscalations] = useState<Escalation[]>([])
  const [activities, setActivities] = useState<Activity[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/agents?limit=20')
      if (!res.ok) throw new Error('Failed to fetch agents')
      const data = await res.json()
      setAgents(data.agents || [])
    } catch (err) {
      log.error('Failed to fetch agents:', err)
    }
  }, [])

  const fetchEscalations = useCallback(async () => {
    try {
      const res = await fetch('/api/escalations?status=open&limit=10')
      if (!res.ok) return
      const data = await res.json()
      setEscalations(data.escalations || [])
    } catch (err) {
      log.error('Failed to fetch escalations:', err)
    }
  }, [])

  const fetchActivities = useCallback(async () => {
    try {
      const res = await fetch('/api/activities?limit=30')
      if (!res.ok) return
      const data = await res.json()
      setActivities(data.activities || [])
    } catch (err) {
      log.error('Failed to fetch activities:', err)
    }
  }, [])

  const refresh = useCallback(async () => {
    await Promise.all([fetchAgents(), fetchEscalations(), fetchActivities()])
    setLastUpdated(new Date())
    setLoading(false)
  }, [fetchAgents, fetchEscalations, fetchActivities])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Poll every 10s for agents, 5s for escalations
  useEffect(() => {
    const agentTimer = setInterval(fetchAgents, 10_000)
    const escTimer = setInterval(fetchEscalations, 5_000)
    const actTimer = setInterval(fetchActivities, 15_000)
    return () => {
      clearInterval(agentTimer)
      clearInterval(escTimer)
      clearInterval(actTimer)
    }
  }, [fetchAgents, fetchEscalations, fetchActivities])

  // Merge feed: recent escalations + recent activities, sorted newest-first
  const feedItems = [
    ...escalations.map(e => ({ ...e, _type: 'escalation', _ts: e.created_at })),
    ...activities.map(a => ({ ...a, _type: 'activity', _ts: a.created_at })),
  ].sort((a, b) => b._ts - a._ts).slice(0, 40)

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Agent Terminal</h1>
          <p className="text-xs text-muted-foreground">Live status — all agents</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-2xs text-muted-foreground/60">
              Updated {formatAge(Math.floor(lastUpdated.getTime() / 1000))}
            </span>
          )}
          <button
            onClick={refresh}
            className="text-xs text-muted-foreground hover:text-foreground border border-border rounded px-2 py-1 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Body: agent grid + feed */}
      <div className="flex-1 overflow-hidden flex gap-0 divide-x divide-border">
        {/* Agent grid */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="bg-card border border-border rounded-xl p-4 flex flex-col gap-3 animate-pulse">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-secondary shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 bg-secondary rounded w-24" />
                      <div className="h-2.5 bg-secondary/60 rounded w-16" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <div className="h-2 bg-secondary/60 rounded w-20" />
                    <div className="h-3 bg-secondary rounded w-full" />
                    <div className="h-3 bg-secondary/60 rounded w-3/4" />
                  </div>
                  <div className="flex justify-between">
                    <div className="h-4 bg-secondary rounded w-14" />
                    <div className="h-2.5 bg-secondary/40 rounded w-12" />
                  </div>
                </div>
              ))}
            </div>
          ) : agents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <p className="text-sm font-medium text-foreground">No agents registered</p>
              <p className="text-xs text-muted-foreground mt-1">Agents appear here once they check in.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {agents.map(agent => (
                <AgentCard key={agent.id} agent={agent} />
              ))}
            </div>
          )}
        </div>

        {/* Activity feed */}
        <div className="w-72 shrink-0 flex flex-col">
          <div className="px-4 py-3 border-b border-border">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Live Feed</p>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-2">
            {feedItems.length === 0 ? (
              <p className="text-xs text-muted-foreground/50 italic py-4 text-center">No activity yet</p>
            ) : (
              feedItems.map((item: any) => (
                <ActivityItem
                  key={`${item._type}-${item.id}`}
                  item={item}
                  isEscalation={item._type === 'escalation'}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
