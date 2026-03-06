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
