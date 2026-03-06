import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { query } from '@/lib/postgres'
import { buildGatewayWebSocketUrl } from '@/lib/gateway-url'

interface GatewayEntry {
  id: number
  host: string
  port: number
  token: string
}

/**
 * POST /api/gateways/connect
 * Resolves websocket URL and token for a selected gateway without exposing tokens in list payloads.
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let id: number | null = null
  try {
    const body = await request.json()
    id = Number(body?.id)
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!id || !Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const gateway = (await query('SELECT id, host, port, token FROM gateways WHERE id = ?', [id])).rows[0] as GatewayEntry | undefined
  if (!gateway) {
    return NextResponse.json({ error: 'Gateway not found' }, { status: 404 })
  }

  const ws_url = buildGatewayWebSocketUrl({
    host: gateway.host,
    port: gateway.port,
    browserProtocol: request.nextUrl.protocol,
  })

  const envToken = (process.env.NEXT_PUBLIC_GATEWAY_TOKEN || process.env.NEXT_PUBLIC_WS_TOKEN || '').trim()
  const token = (gateway.token || '').trim() || envToken

  return NextResponse.json({
    id: gateway.id,
    ws_url,
    token,
    token_set: token.length > 0,
  })
}
