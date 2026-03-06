import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { query } from '@/lib/postgres'

interface GatewayEntry {
  id: number
  name: string
  host: string
  port: number
  token: string
  is_primary: number
  status: string
  last_seen: number | null
  latency: number | null
  sessions_count: number
  agents_count: number
  created_at: number
  updated_at: number
}

/**
 * GET /api/gateways - List all registered gateways
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const gateways = (await query('SELECT * FROM gateways ORDER BY is_primary DESC, name ASC')).rows as GatewayEntry[]

  // If no gateways exist, seed defaults from environment
  if (gateways.length === 0) {
    const name = String(process.env.MC_DEFAULT_GATEWAY_NAME || 'primary')
    const host = String(process.env.OPENCLAW_GATEWAY_HOST || '127.0.0.1')
    const mainPort = parseInt(process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || process.env.NEXT_PUBLIC_GATEWAY_PORT || '18789')
    const mainToken =
      process.env.OPENCLAW_GATEWAY_TOKEN ||
      process.env.GATEWAY_TOKEN ||
      ''

    await query(
      `INSERT INTO gateways (name, host, port, token, is_primary) VALUES (?, ?, ?, ?, 1)`,
      [name, host, mainPort, mainToken]
    )

    const seeded = (await query('SELECT * FROM gateways ORDER BY is_primary DESC, name ASC')).rows as GatewayEntry[]
    return NextResponse.json({ gateways: redactTokens(seeded) })
  }

  return NextResponse.json({ gateways: redactTokens(gateways) })
}

/**
 * POST /api/gateways - Add a new gateway
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const body = await request.json()

  const { name, host, port, token, is_primary } = body

  if (!name || !host || !port) {
    return NextResponse.json({ error: 'name, host, and port are required' }, { status: 400 })
  }

  try {
    // If marking as primary, unset other primaries
    if (is_primary) {
      await query('UPDATE gateways SET is_primary = 0')
    }

    const result = await query(
      `INSERT INTO gateways (name, host, port, token, is_primary) VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [name, host, port, token || '', is_primary ? 1 : 0]
    )

    try {
      await query('INSERT INTO audit_log (action, actor, detail) VALUES (?, ?, ?)', [
        'gateway_added', auth.user?.username || 'system', `Added gateway: ${name} (${host}:${port})`
      ])
    } catch { /* audit might not exist */ }

    const gw = (await query('SELECT * FROM gateways WHERE id = ?', [result.rows[0].id])).rows[0] as GatewayEntry
    return NextResponse.json({ gateway: redactToken(gw) }, { status: 201 })
  } catch (err: any) {
    if (err.message?.includes('unique') || err.message?.includes('UNIQUE')) {
      return NextResponse.json({ error: 'A gateway with that name already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: err.message || 'Failed to add gateway' }, { status: 500 })
  }
}

/**
 * PUT /api/gateways - Update a gateway
 */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const body = await request.json()
  const { id, ...updates } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const existing = (await query('SELECT * FROM gateways WHERE id = ?', [id])).rows[0] as GatewayEntry | undefined
  if (!existing) return NextResponse.json({ error: 'Gateway not found' }, { status: 404 })

  // If setting as primary, unset others
  if (updates.is_primary) {
    await query('UPDATE gateways SET is_primary = 0')
  }

  const allowed = ['name', 'host', 'port', 'token', 'is_primary', 'status', 'last_seen', 'latency', 'sessions_count', 'agents_count']
  const sets: string[] = []
  const values: any[] = []

  for (const key of allowed) {
    if (key in updates) {
      sets.push(`${key} = ?`)
      values.push(updates[key])
    }
  }

  if (sets.length === 0) return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })

  sets.push('updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER')
  values.push(id)

  await query(`UPDATE gateways SET ${sets.join(', ')} WHERE id = ?`, values)

  const updated = (await query('SELECT * FROM gateways WHERE id = ?', [id])).rows[0] as GatewayEntry
  return NextResponse.json({ gateway: redactToken(updated) })
}

/**
 * DELETE /api/gateways - Remove a gateway
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const body = await request.json()
  const { id } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const gw = (await query('SELECT * FROM gateways WHERE id = ?', [id])).rows[0] as GatewayEntry | undefined
  if (gw?.is_primary) {
    return NextResponse.json({ error: 'Cannot delete the primary gateway' }, { status: 400 })
  }

  const result = await query('DELETE FROM gateways WHERE id = ?', [id])

  try {
    await query('INSERT INTO audit_log (action, actor, detail) VALUES (?, ?, ?)', [
      'gateway_removed', auth.user?.username || 'system', `Removed gateway: ${gw?.name}`
    ])
  } catch { /* audit might not exist */ }

  return NextResponse.json({ deleted: (result.rowCount ?? 0) > 0 })
}

function redactToken(gw: GatewayEntry): GatewayEntry & { token_set: boolean } {
  return { ...gw, token: gw.token ? '--------' : '', token_set: !!gw.token }
}

function redactTokens(gws: GatewayEntry[]) {
  return gws.map(redactToken)
}
