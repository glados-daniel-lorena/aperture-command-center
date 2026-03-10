/**
 * gateway.ts — OpenClaw gateway URL utility
 *
 * Queries the Neon DB gateways table to get the live gateway URL.
 * Caches result for 30 seconds to avoid hammering the DB.
 * Used by API routes that need to call the OpenClaw gateway (sessions_send, etc.)
 */
import { query } from '@/lib/postgres'

interface GatewayRow {
  id: number
  name: string
  host: string
  port: number
  token: string
  is_primary: number
}

let cachedUrl: string | null = null
let cachedToken: string | null = null
let cacheExpiresAt = 0

const CACHE_TTL_MS = 30_000

/**
 * Returns the live OpenClaw gateway base URL (e.g. https://tunnel.example.com)
 * Queries the primary gateway from the gateways table, with 30s caching.
 */
export async function getGatewayUrl(): Promise<string> {
  const now = Date.now()
  if (cachedUrl && now < cacheExpiresAt) {
    return cachedUrl
  }

  const { rows } = await query<GatewayRow>(
    `SELECT id, name, host, port, token, is_primary FROM gateways ORDER BY is_primary DESC, id ASC LIMIT 1`
  )

  const gw = rows[0]
  if (!gw) {
    throw new Error('No gateway configured in gateways table. Run update-tunnel-db.js or add a gateway.')
  }

  // Build URL: if host already includes protocol, use as-is
  // Otherwise construct from host + port
  let url: string
  if (gw.host.startsWith('http://') || gw.host.startsWith('https://')) {
    url = gw.host.replace(/\/$/, '')
  } else {
    // Default to https for Cloudflare tunnels; use port 443 implicitly
    const usePort = gw.port && gw.port !== 443 && gw.port !== 80
    url = `https://${gw.host}${usePort ? `:${gw.port}` : ''}`
  }

  cachedUrl = url
  cachedToken = gw.token || null
  cacheExpiresAt = now + CACHE_TTL_MS

  return url
}

/**
 * Returns the gateway bearer token (cached alongside URL).
 */
export async function getGatewayToken(): Promise<string | null> {
  // Ensure cache is populated
  await getGatewayUrl()
  return cachedToken
}

/**
 * Sends a message to an OpenClaw session via the gateway sessions_send endpoint.
 * Returns true on success, throws on failure.
 */
export async function gatewaySend(sessionKey: string, message: string): Promise<boolean> {
  const baseUrl = await getGatewayUrl()
  const token = await getGatewayToken()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(`${baseUrl}/api/sessions/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionKey, message }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Gateway sessions_send failed: ${res.status} ${text}`)
  }

  return true
}

/**
 * Invalidates the gateway URL cache (e.g. after a known tunnel restart).
 */
export function invalidateGatewayCache(): void {
  cachedUrl = null
  cachedToken = null
  cacheExpiresAt = 0
}

/**
 * Invoke a tool via the OpenClaw gateway HTTP tools/invoke endpoint.
 * Uses POST /tools/invoke (always enabled, gated by auth + tool policy).
 * Note: sessions_send and sessions_spawn are hard-denied by default.
 * The `cron` tool is NOT denied — use this to fire at-jobs for agent wake-up.
 */
export async function gatewayInvoke(
  tool: string,
  args: Record<string, unknown>,
  sessionKey = 'main'
): Promise<unknown> {
  const baseUrl = await getGatewayUrl()
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || (await getGatewayToken())

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${baseUrl}/tools/invoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tool, args, sessionKey }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`gatewayInvoke(${tool}) failed: ${res.status} ${text}`)
  }

  return res.json()
}

/**
 * Wake an agent immediately by creating a one-shot "at" cron job that fires in 30 seconds.
 * Used by the escalation response handler so agents spin back up without waiting
 * for their next scheduled cron run.
 *
 * @param agentId    - OpenClaw agent ID (e.g. "atlas", "p-body")
 * @param message    - The agentTurn message to inject (should include the escalation response)
 */
/**
 * Agent channel IDs on Discord (Aperture Science Enrichment Center).
 * Used to send wake-up messages via the gateway message tool.
 * The cron tool is blocked on HTTP /tools/invoke; message tool is allowed.
 */
const AGENT_DISCORD_CHANNELS: Record<string, string> = {
  glados:        '1479291940548776049',
  'p-body':      '1479558658122842244',
  atlas:         '1479558740490326160',
  wheatley:      '1479558793183367299',
  'cave-johnson':'1479558850884665407',
}

/**
 * Wake an agent immediately by sending a Discord message to their channel
 * via the gateway message tool (POST /tools/invoke with tool=message).
 *
 * The cron tool is blocked on HTTP /tools/invoke, but message is allowed.
 * The agent sees the message from GLaDOS and processes it as a regular turn
 * with the escalation response embedded.
 *
 * @param agentId    - OpenClaw agent ID (e.g. "atlas", "p-body")
 * @param message    - The message to send (should include the escalation response)
 * @param sessionKey - Agent session key (used to extract channel ID as fallback)
 */
export async function wakeAgentWithResponse(
  agentId: string,
  message: string,
  sessionKey?: string
): Promise<void> {
  // Resolve channel ID: lookup table first, then parse from session key
  let channelId = AGENT_DISCORD_CHANNELS[agentId]
  if (!channelId && sessionKey) {
    // session key format: agent:{id}:discord:channel:{channelId}
    const match = sessionKey.match(/:channel:(\d+)$/)
    if (match) channelId = match[1]
  }

  if (!channelId) {
    throw new Error(`No Discord channel ID for agent: ${agentId}`)
  }

  // Send via gateway message tool — immediate delivery, no cron delay
  await gatewayInvoke('message', {
    action: 'send',
    channel: 'discord',
    target: channelId,
    message,
  })
}
