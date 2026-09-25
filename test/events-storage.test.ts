import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { pool, query, queryOne } from '../src/db/index.js'
import { applyEvent } from '../src/indexer/handlers.js'
import { reindexFromEventLog } from '../src/indexer/reindex.js'
import { DERIVED_TABLES } from '../src/indexer/derived-tables.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'
import type { DecodedEvent } from '../src/stellar/events.js'

// Issue #75 — the events log has no storage strategy. This change is
// "measured it, here's the threshold, no schema change yet"
// (docs/events-storage.md). These tests pin the current storage shape so any
// future change to it is deliberate, and pin the property that makes a
// change safe: a rebuild from the raw log must reproduce derived state
// byte-for-byte.

async function ingest(client: PoolClient, ev: DecodedEvent): Promise<void> {
  await client.query(
    `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
    [ev.id, ev.ledger, ev.closedAt, ev.contractId, ev.symbol,
     JSON.stringify(ev.topics), JSON.stringify(ev.data), ev.txHash]
  )
  await applyEvent(client, ev)
}

async function derivedSnapshot(): Promise<Record<string, unknown[]>> {
  const snap: Record<string, unknown[]> = {}
  snap.members = await query('SELECT address, joined_ledger, contribution, exited, exit_share, exited_ledger, pending_claimed, stake, has_active_loan, name, defaults_count FROM members ORDER BY address')
  snap.loan_proposals = await query('SELECT id, borrower, amount, total_repayment, status, votes_for, votes_against, voter_count, created_ledger FROM loan_proposals ORDER BY id')
  snap.loans = await query('SELECT id, borrower, amount, outstanding, total_repayment, status, approved_ledger, due_time, repaid_ledger, defaulted_ledger FROM loans ORDER BY id')
  snap.treasury_proposals = await query('SELECT id, amount, destination, private, status, votes_for, votes_against, voter_count, created_ledger, executed_ledger FROM treasury_proposals ORDER BY id')
  snap.notifications = await query('SELECT address, type, title, message, ledger, tx_hash, read FROM notifications ORDER BY id')
  snap.interest_distributions = await query('SELECT event_id, ledger, amount, active_members, tx_hash FROM interest_distributions ORDER BY id')
  snap.documents = await query('SELECT event_id, proposal_id, kind, caller, ledger, tx_hash FROM documents ORDER BY id')
  snap.dao_totals = await query('SELECT interest_collected, principal_lent, principal_repaid, value_defaulted FROM dao_totals WHERE id = 1')
  return snap
}

describe('events log — storage shape is pinned (issue #75)', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  it('has exactly the documented columns', async () => {
    const cols = await query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'events' ORDER BY ordinal_position`
    )
    expect(cols).toEqual([
      { column_name: 'id', data_type: 'text' },
      { column_name: 'ledger', data_type: 'bigint' },
      { column_name: 'closed_at', data_type: 'timestamp with time zone' },
      { column_name: 'contract_id', data_type: 'text' },
      { column_name: 'symbol', data_type: 'text' },
      { column_name: 'topics', data_type: 'jsonb' },
      { column_name: 'data', data_type: 'jsonb' },
      { column_name: 'tx_hash', data_type: 'text' },
      { column_name: 'decode_error', data_type: 'text' },
      { column_name: 'created_at', data_type: 'timestamp with time zone' },
      { column_name: 'folded_at', data_type: 'timestamp with time zone' },
    ])
  })

  it('has exactly the three secondary indexes evaluated in docs/events-storage.md', async () => {
    const idx = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'events' ORDER BY indexname`
    )
    expect(idx.map((r) => r.indexname).sort()).toEqual([
      'events_contract_id_idx',
      'events_data_gin_idx',
      'events_entity_id_idx',
      'events_ledger_idx',
      'events_pkey',
      'events_symbol_idx',
    ])
  })
})

describe('events log — rebuild reproduces derived state exactly (issue #75)', () => {
  let client: PoolClient
  beforeEach(async () => {
    await resetDb()
    client = await pool.connect()
  })
  afterEach(() => {
    try { client.release() } catch { /* already released */ }
  })
  afterAll(closeDb)

  it('reindex is byte-identical to the incremental fold, and idempotent, across a multi-contract log', async () => {
    // resetForContractChange() keeps events while wiping derived tables, so
    // one database can hold >1 deployment's history. Any storage change must
    // survive that — exercise it here.
    const events: DecodedEvent[] = [
      decodedEvent('joined', { member: 'GA', fee: '100' }, { contractId: 'CONE', ledger: 10, id: '10-0' }),
      decodedEvent('loan_req', { id: 1, borrower: 'GA', amount: '1000', total_repayment: '1100' }, { contractId: 'CONE', ledger: 11, id: '11-0' }),
      decodedEvent('loan_appr', { id: 1, borrower: 'GA', amount: '1000' }, { contractId: 'CONE', ledger: 12, id: '12-0' }),
      decodedEvent('loan_rpy', { loan_id: 1, borrower: 'GA', outstanding: '0' }, { contractId: 'CONE', ledger: 13, id: '13-0' }),
      decodedEvent('interest', { interest: '90', active: 1 }, { contractId: 'CONE', ledger: 14, id: '14-0' }),
      decodedEvent('joined', { member: 'GB', fee: '50' }, { contractId: 'CTWO', ledger: 20, id: '20-0' }),
      decodedEvent('staked', { member: 'GB', amount: '400', new_stake: '400' }, { contractId: 'CTWO', ledger: 21, id: '21-0' }),
      decodedEvent('unknown_future_symbol', { x: 1 }, { contractId: 'CTWO', ledger: 22, id: '22-0' }),
    ]
    for (const ev of events) await ingest(client, ev)

    const incremental = await derivedSnapshot()
    client.release()

    const first = await reindexFromEventLog()
    expect(first.events).toBe(events.length)
    const rebuilt = await derivedSnapshot()
    expect(rebuilt).toEqual(incremental)

    // Idempotent: a second rebuild changes nothing.
    await reindexFromEventLog()
    expect(await derivedSnapshot()).toEqual(incremental)

    client = await pool.connect()

    // The raw log kept every event, including the unknown one.
    const count = await queryOne<{ n: string }>('SELECT count(*)::text AS n FROM events')
    expect(count!.n).toBe(String(events.length))
  })
})
