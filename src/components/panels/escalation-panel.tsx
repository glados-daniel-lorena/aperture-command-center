'use client'

import { useState, useCallback, useEffect } from 'react'
import { createClientLogger } from '@/lib/client-logger'

const log = createClientLogger('EscalationPanel')

interface Escalation {
  id: number
  workspace_id: number
  agent_name: string
  agent_id?: string
  session_key?: string
  project?: string
  priority: 'blocked' | 'question' | 'fyi'
  title: string
  description: string
  context?: string
  status: 'open' | 'responded' | 'resolved'
  response?: string
  delivery_status?: 'delivered' | 'cold' | 'no_session'
  created_at: number
  responded_at?: number
  resolved_at?: number
}

const PRIORITY_CONFIG = {
  blocked: {
    label: 'BLOCKED',
    color: 'text-red-400',
    bg: 'bg-red-500/10',
    border: 'border-red-500/30',
    dot: 'bg-red-500',
    bar: 'border-l-red-500',
    emoji: '🔴',
  },
  question: {
    label: 'QUESTION',
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    dot: 'bg-amber-500',
    bar: 'border-l-amber-500',
    emoji: '🟡',
  },
  fyi: {
    label: 'FYI',
    color: 'text-green-400',
    bg: 'bg-green-500/10',
    border: 'border-green-500/30',
    dot: 'bg-green-500',
    bar: 'border-l-green-500',
    emoji: '🟢',
  },
}

const STATUS_CONFIG = {
  open: { label: 'Open', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' },
  responded: { label: 'Responded', color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20' },
  resolved: { label: 'Resolved', color: 'text-green-400', bg: 'bg-green-500/10 border-green-500/20' },
}

function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp * 1000
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  return 'just now'
}

export function EscalationPanel() {
  const [escalations, setEscalations] = useState<Escalation[]>([])
  const [openCount, setOpenCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<'open' | 'responded' | 'resolved' | 'all'>('open')
  const [priorityFilter, setPriorityFilter] = useState<'all' | 'blocked' | 'question' | 'fyi'>('all')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [responseText, setResponseText] = useState<Record<number, string>>({})
  const [submitting, setSubmitting] = useState<number | null>(null)
  const [deliveryNotice, setDeliveryNotice] = useState<Record<number, { message: string; ok: boolean }>>({})


  const fetchEscalations = useCallback(async () => {
    try {
      setError(null)
      const params = new URLSearchParams({ status: statusFilter, priority: priorityFilter })
      const res = await fetch(`/api/escalations?${params}`)
      if (!res.ok) throw new Error('Failed to fetch escalations')
      const data = await res.json()
      setEscalations(data.escalations || [])
      setOpenCount(data.openCount ?? 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      log.error('Failed to fetch escalations:', err)
    } finally {
      setLoading(false)
    }
  }, [statusFilter, priorityFilter])

  useEffect(() => {
    setLoading(true)
    fetchEscalations()
  }, [fetchEscalations])

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(fetchEscalations, 30000)
    return () => clearInterval(interval)
  }, [fetchEscalations])

  const handleRespond = async (esc: Escalation, newStatus: 'responded' | 'resolved') => {
    const response = responseText[esc.id] || ''
    if (newStatus === 'responded' && !response.trim()) {
      alert('Please enter a response before sending.')
      return
    }
    setSubmitting(esc.id)
    try {
      const res = await fetch(`/api/escalations/${esc.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: response.trim() || undefined, status: newStatus }),
      })
      if (!res.ok) throw new Error('Failed to update')
      await fetchEscalations()
      setExpandedId(null)
      setResponseText(prev => { const n = { ...prev }; delete n[esc.id]; return n })
    } catch (err) {
      log.error('Failed to update escalation:', err)
      setError('Failed to update escalation')
    } finally {
      setSubmitting(null)
    }
  }

  const handleReopen = async (esc: Escalation) => {
    setSubmitting(esc.id)
    try {
      const res = await fetch(`/api/escalations/${esc.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'open' }),
      })
      if (!res.ok) throw new Error('Failed to reopen')
      await fetchEscalations()
    } catch (err) {
      log.error('Failed to reopen escalation:', err)
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-foreground">Escalations</h1>
            {openCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-bold bg-red-500/20 text-red-400 border border-red-500/30">
                {openCount}
              </span>
            )}
          </div>
          <button
            onClick={fetchEscalations}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded border border-border hover:border-border/80"
          >
            Refresh
          </button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          {/* Status filter */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground mr-1">Status:</span>
            {(['open', 'responded', 'resolved', 'all'] as const).map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                  statusFilter === s
                    ? 'bg-primary/20 text-primary border border-primary/30'
                    : 'text-muted-foreground hover:text-foreground border border-transparent hover:border-border'
                }`}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>

          {/* Priority filter */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground mr-1">Priority:</span>
            {(['all', 'blocked', 'question', 'fyi'] as const).map(p => (
              <button
                key={p}
                onClick={() => setPriorityFilter(p)}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                  priorityFilter === p
                    ? 'bg-primary/20 text-primary border border-primary/30'
                    : 'text-muted-foreground hover:text-foreground border border-transparent hover:border-border'
                }`}
              >
                {p === 'all' ? 'All' : PRIORITY_CONFIG[p].emoji + ' ' + PRIORITY_CONFIG[p].label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg p-3 text-sm flex justify-between items-center">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-300 hover:text-red-100 ml-3">×</button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            <span className="ml-3 text-sm text-muted-foreground">Loading escalations...</span>
          </div>
        ) : escalations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center mb-3">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-6 h-6 text-muted-foreground">
                <path d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="text-sm font-medium text-foreground">No escalations</p>
            <p className="text-xs text-muted-foreground mt-1">
              {statusFilter === 'open'
                ? 'All clear — no open escalations from agents.'
                : `No ${statusFilter} escalations found.`}
            </p>
          </div>
        ) : (
          escalations.map(esc => (
            <EscalationCard
              key={esc.id}
              escalation={esc}
              expanded={expandedId === esc.id}
              onToggle={() => setExpandedId(expandedId === esc.id ? null : esc.id)}
              responseText={responseText[esc.id] || ''}
              onResponseChange={(text) => setResponseText(prev => ({ ...prev, [esc.id]: text }))}
              onRespond={(status) => handleRespond(esc, status)}
              onReopen={() => handleReopen(esc)}
              submitting={submitting === esc.id}
            />
          ))
        )}
      </div>
    </div>
  )
}

function EscalationCard({
  escalation: esc,
  expanded,
  onToggle,
  responseText,
  onResponseChange,
  onRespond,
  onReopen,
  submitting,
}: {
  escalation: Escalation
  expanded: boolean
  onToggle: () => void
  responseText: string
  onResponseChange: (text: string) => void
  onRespond: (status: 'responded' | 'resolved') => void
  onReopen: () => void
  submitting: boolean
}) {
  const p = PRIORITY_CONFIG[esc.priority]
  const s = STATUS_CONFIG[esc.status]

  return (
    <div className={`rounded-lg border bg-card border-l-2 ${p.bar} ${
      esc.status !== 'open' ? 'opacity-70' : ''
    } border-border transition-all`}>
      {/* Card header — always visible */}
      <button
        onClick={onToggle}
        className="w-full text-left p-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              {/* Priority badge */}
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-bold border ${p.bg} ${p.color} ${p.border}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${p.dot}`} />
                {p.label}
              </span>

              {/* Status badge */}
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium border ${s.bg} ${s.color}`}>
                {s.label}
              </span>

              {/* Agent name */}
              <span className="text-xs font-mono text-muted-foreground">{esc.agent_name}</span>
              {esc.project && (
                <span className="text-2xs text-muted-foreground/70">· {esc.project}</span>
              )}
            </div>

            {/* Title */}
            <p className="text-sm font-semibold text-foreground truncate">{esc.title}</p>

            {/* Description preview */}
            {!expanded && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{esc.description}</p>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-2xs text-muted-foreground">{formatAge(esc.created_at)}</span>
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              className={`w-4 h-4 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
            >
              <polyline points="4,6 8,10 12,6" />
            </svg>
          </div>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-border/50 pt-3">
          {/* Full description */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wide">Description</p>
            <p className="text-sm text-foreground whitespace-pre-wrap">{esc.description}</p>
          </div>

          {/* Context */}
          {esc.context && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wide">Context</p>
              <pre className="text-xs text-foreground/80 bg-secondary rounded-md p-3 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed">
                {esc.context}
              </pre>
            </div>
          )}

          {/* Existing response */}
          {esc.response && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wide">Response</p>
              <div className="bg-blue-500/5 border border-blue-500/20 rounded-md p-3">
                <p className="text-sm text-foreground whitespace-pre-wrap">{esc.response}</p>
                {esc.responded_at && (
                  <p className="text-2xs text-muted-foreground mt-1">{formatAge(esc.responded_at)}</p>
                )}
              </div>
            </div>
          )}

          {/* Action area */}
          {esc.status !== 'resolved' ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {esc.status === 'responded' ? 'Update Response' : 'Send Response'}
              </p>
              <textarea
                value={responseText}
                onChange={(e) => onResponseChange(e.target.value)}
                placeholder="Type your response to the agent..."
                rows={3}
                className="w-full bg-secondary border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 resize-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => onRespond('responded')}
                  disabled={submitting}
                  className="flex-1 py-1.5 text-sm font-medium rounded-md bg-blue-500/15 text-blue-400 border border-blue-500/30 hover:bg-blue-500/25 disabled:opacity-50 transition-colors"
                >
                  {submitting ? 'Sending...' : 'Send Response'}
                </button>
                <button
                  onClick={() => onRespond('resolved')}
                  disabled={submitting}
                  className="flex-1 py-1.5 text-sm font-medium rounded-md bg-green-500/15 text-green-400 border border-green-500/30 hover:bg-green-500/25 disabled:opacity-50 transition-colors"
                >
                  {submitting ? '...' : 'Mark Resolved'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-green-400">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="w-4 h-4">
                  <path d="M3 8l3.5 3.5L13 5" />
                </svg>
                Resolved {esc.resolved_at ? formatAge(esc.resolved_at) : ''}
              </div>
              <button
                onClick={onReopen}
                disabled={submitting}
                className="text-xs text-muted-foreground hover:text-foreground border border-border rounded px-2 py-1 transition-colors"
              >
                Reopen
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
