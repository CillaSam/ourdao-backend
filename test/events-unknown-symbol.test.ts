import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { pool, query } from '../src/db/index.js'
import { applyEvent } from '../src/indexer/handlers.js'
import {
  EVENT_FIELDS,
  namedFields,
  resetUnknownSymbolWarningsForTest,
} from '../src/stellar/events.js'
import { DERIVED_TABLES } from '../src/indexer/derived-tables.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'

async function ingest(client: PoolClient, ev: ReturnType<typeof decodedEvent>): Promise<void> {
  await client.query(
    `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
    [ev.id, ev.ledger, ev.closedAt, ev.contractId, ev.symbol,
     JSON.stringify(ev.topics), JSON.stringify(ev.data), ev.txHash]
  )
  await applyEvent(client, ev)
}

describe('unknown event symbols (issue #39)', () => {
  let client: PoolClient
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    await resetDb()
    resetUnknownSymbolWarningsForTest()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    client = await pool.connect()
  })
  afterEach(() => {
    warn.mockRestore()
    try { client.release() } catch { /* already released */ }
  })
  afterAll(closeDb)

  it('persists the raw event, changes no derived state, and warns exactly once per symbol', async () => {
    await ingest(client, decodedEvent('brand_new_symbol', { whatever: 1 }, { ledger: 500, id: '500-0' }))
    await ingest(client, decodedEvent('brand_new_symbol', { whatever: 2 }, { ledger: 501, id: '501-0' }))

    const raw = await query<{ symbol: string }>(`SELECT symbol FROM events WHERE symbol = 'brand_new_symbol'`)
    expect(raw).toHaveLength(2)

    for (const table of DERIVED_TABLES) {
      const rows = await query(`SELECT * FROM ${table}`)
      expect(rows, `${table} should be untouched`).toEqual([])
    }

    const unknownWarnings = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('brand_new_symbol'))
    expect(unknownWarnings).toHaveLength(1)
    expect(String(unknownWarnings[0]![0])).toContain('ledger 500')
    expect(String(unknownWarnings[0]![0])).toContain('event 500-0')
  })

  it('warns again for a different unknown symbol', async () => {
    await ingest(client, decodedEvent('symbol_a', {}, { ledger: 1, id: 'a' }))
    await ingest(client, decodedEvent('symbol_b', {}, { ledger: 2, id: 'b' }))
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('unknown event symbol'))).toHaveLength(2)
  })

  it('does not warn for a known symbol that has no fold handler (e.g. `paused`)', async () => {
    await ingest(client, decodedEvent('paused', {}, { ledger: 3, id: 'p' }))
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('unknown event symbol'))).toBe(false)
  })

  it('namedFields still returns {} for an unknown symbol (behaviour unchanged)', () => {
    expect(namedFields('nope', [1, 2, 3])).toEqual({})
  })
})

describe('EVENT_FIELDS catalog is pinned (issue #39)', () => {
  it('adding or removing a symbol requires a deliberate edit to this list', () => {
    expect(Object.keys(EVENT_FIELDS)).toEqual([
      'joined',
      'exited',
      'claimed',
      'loan_req',
      'loan_edit',
      'loan_vote',
      'loan_wait',
      'loan_rej',
      'loan_appr',
      'loan_rpy',
      'loan_dflt',
      'loan_exp',
      'interest',
      'tre_prop',
      'tre_vote',
      'tre_wait',
      'tre_rej',
      'tre_exec',
      'staked',
      'unstaked',
      'name_reg',
      'committed',
      'revealed',
      'doc_attn',
      'init',
      'admin_add',
      'admin_rem',
      'threshold',
      'policy',
      'paused',
      'unpaused',
    ])
  })
})
