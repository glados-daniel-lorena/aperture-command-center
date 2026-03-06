import { neon } from '@neondatabase/serverless'
import { Pool } from '@neondatabase/serverless'

function getConnectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  return url
}

let _neon: ReturnType<typeof neon> | null = null
let _pool: Pool | null = null

function getSql() {
  if (!_neon) _neon = neon(getConnectionString())
  return _neon
}

function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: getConnectionString() })
  return _pool
}

/** Convert ? placeholders to $1, $2, ... for Postgres */
function toPgSql(sql: string): string {
  let i = 0
  return sql.replace(/\?/g, () => `$${++i}`)
}

export interface QueryResult<T = Record<string, any>> {
  rows: T[]
  rowCount: number
}

/** Execute a SQL query with optional parameters. Supports both ? and $N placeholders. */
export async function query<T = Record<string, any>>(
  sql: string,
  params: any[] = []
): Promise<QueryResult<T>> {
  const pgSql = toPgSql(sql)
  const sqlFn = getSql()
  const result = (await (sqlFn as any)(pgSql, params, { fullResults: true })) as any
  return {
    rows: (result.rows ?? result) as T[],
    rowCount: result.rowCount ?? result.rows?.length ?? 0,
  }
}

/** Run multiple SQL statements split by semicolons. */
export async function execStatements(sql: string): Promise<void> {
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'))
  for (const stmt of statements) {
    if (stmt) await query(stmt)
  }
}

/**
 * Run multiple queries in a single Postgres transaction.
 * The callback receives a query function bound to the same connection.
 */
export async function withTransaction<T>(
  fn: (q: <R = Record<string, any>>(sql: string, params?: any[]) => Promise<QueryResult<R>>) => Promise<T>
): Promise<T> {
  const pool = getPool()
  const client = await pool.connect()
  const txQuery = async <R = Record<string, any>>(sql: string, params: any[] = []): Promise<QueryResult<R>> => {
    const pgSql = toPgSql(sql)
    const result = await client.query(pgSql, params)
    return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 }
  }
  try {
    await client.query('BEGIN')
    const result = await fn(txQuery)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}
