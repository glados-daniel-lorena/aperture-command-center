import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/debug-auth - Temporary debug endpoint to check AGENT_API_KEY env var status
 * REMOVE AFTER DEBUGGING
 */
export async function GET(request: NextRequest) {
  const agentKey = (process.env.AGENT_API_KEY || '').trim()
  const provided = (request.headers.get('x-api-key') || '').trim()
  
  return NextResponse.json({
    hasEnvKey: !!agentKey,
    envKeyLen: agentKey.length,
    envKeyPrefix: agentKey.substring(0, 15),
    envKeySuffix: agentKey.substring(agentKey.length - 10),
    providedLen: provided.length,
    providedPrefix: provided.substring(0, 15),
    providedSuffix: provided.substring(provided.length - 10),
    exactMatch: provided === agentKey,
    envKeyCharCodes: Array.from(agentKey.substring(0, 20)).map(c => c.charCodeAt(0)),
    providedCharCodes: Array.from(provided.substring(0, 20)).map(c => c.charCodeAt(0)),
  })
}
