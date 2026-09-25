import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'
import { parseCorsOrigin } from '../src/config.js'

describe('parseCorsOrigin', () => {
  it('returns localhost:3000 when unset', () => {
    expect(parseCorsOrigin(undefined)).toBe('http://localhost:3000')
  })

  it('returns localhost:3000 when empty string', () => {
    expect(parseCorsOrigin('')).toBe('http://localhost:3000')
  })

  it('returns a single origin as-is', () => {
    expect(parseCorsOrigin('https://app.ourdao.org')).toBe('https://app.ourdao.org')
  })

  it('trims whitespace in comma-separated list', () => {
    expect(parseCorsOrigin('https://a.com, https://b.com , https://c.com')).toBe(
      'https://a.com,https://b.com,https://c.com'
    )
  })

  it('drops empty entries from comma-separated list', () => {
    expect(parseCorsOrigin('https://a.com,, ,https://b.com,')).toBe(
      'https://a.com,https://b.com'
    )
  })

  it('de-duplicates identical origins', () => {
    expect(parseCorsOrigin('https://a.com,https://a.com')).toBe('https://a.com')
  })

  it('returns * when explicitly set', () => {
    expect(parseCorsOrigin('*')).toBe('*')
  })
})

describe('API: /health and /ready', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('GET /health returns 200 without touching Postgres', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
  })

  it('GET /version returns 200 with version info', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.version).toBe('string')
    expect(typeof body.commit).toBe('string')
    expect(typeof body.buildDate).toBe('string')
    // Should have sensible defaults when env vars are not set
    expect(body.commit).toBe('unknown')
    expect(body.buildDate).toBe('unknown')
  })

  it('GET /version reports the real package.json version, not "unknown" (issue #166)', async () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string }
    const res = await app.inject({ method: 'GET', url: '/version' })
    expect(res.json().version).toBe(pkg.version)
  })

  it('GET /version returns the same value across repeated calls (read once at module load, not per request)', async () => {
    const first = (await app.inject({ method: 'GET', url: '/version' })).json()
    const second = (await app.inject({ method: 'GET', url: '/version' })).json()
    expect(second.version).toBe(first.version)
    expect(first.version).not.toBe('unknown')
  })

  it('GET /ready returns 200 with cold start when no cursor exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ready')
    expect(body.indexer).toBe('cold_start')
    expect(body.lastIndexedLedger).toBeNull()
  })

  it('GET /ready returns 200 when cursor is fresh', async () => {
    await query(
      `INSERT INTO indexer_cursor (id, last_ledger, updated_at) VALUES (1, 100, now())`
    )
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ready')
    expect(body.indexer).toBe('ok')
    expect(body.lastIndexedLedger).toBe(100)
    expect(typeof body.secondsSinceUpdate).toBe('number')
  })

  it('GET /ready returns 503 when cursor is stale', async () => {
    // Set updated_at to 10 minutes ago (well past default 120s threshold)
    await query(
      `INSERT INTO indexer_cursor (id, last_ledger, updated_at) VALUES (1, 100, now() - interval '10 minutes')`
    )
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.status).toBe('not ready')
    expect(body.reason).toBe('indexer_stale')
    expect(body.lastIndexedLedger).toBe(100)
  })
})

describe('API: /api/stats includes freshness', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('GET /api/stats returns freshness fields', async () => {
    await query(
      `INSERT INTO indexer_cursor (id, last_ledger, updated_at) VALUES (1, 500, now())`
    )
    const res = await app.inject({ method: 'GET', url: '/api/stats' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.lastIndexedLedger).toBe(500)
    expect(typeof body.secondsSinceUpdate).toBe('number')
    expect(body.indexerStale).toBe(false)
  })

  it('GET /api/stats reports stale when cursor is old', async () => {
    await query(
      `INSERT INTO indexer_cursor (id, last_ledger, updated_at) VALUES (1, 500, now() - interval '3 minutes')`
    )
    const res = await app.inject({ method: 'GET', url: '/api/stats' })
    const body = res.json()
    expect(body.indexerStale).toBe(true)
    expect(body.secondsSinceUpdate).toBeGreaterThanOrEqual(180)
  })
})
