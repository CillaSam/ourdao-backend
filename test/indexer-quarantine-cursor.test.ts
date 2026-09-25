// Covers issue #43 (quarantine path for a deterministically-throwing
// handler), issue #45 (the empty-page cursor conflation that produced a
// false ReorgDetectedError), issue #119 (a crash between the raw insert and
// the fold could strand an event unfolded forever) and issue #120 (a
// failure recording a quarantined event must not abort the rest of the
// page or strand the event silently). All four live in
// src/indexer/poller.ts and share the same mock setup, so one file.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, query, queryOne } from '../src/db/index.js'
import { fetchOnce, ReorgDetectedError } from '../src/indexer/poller.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'
import type { DecodedEvent } from '../src/stellar/events.js'

// The handlers only ever read ev.fields/ev.ledger/ev.txHash (see
// test/fixtures.ts), so bypass real ScVal decoding here too — the fixture
// events built by decodedEvent() are already full DecodedEvents.
vi.mock('../src/stellar/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/stellar/events.js')>()
  return { ...actual, decodeEvent: (raw: unknown) => raw as DecodedEvent }
})

const getEventsMock = vi.fn()
// Constant across every ledger sequence — these tests don't care about hash
// mismatches (that's covered separately in indexer-ledger-hash-reorg.test.ts),
// they just need saveCursor's `getLedgerHash` lookup to resolve to something.
vi.mock('../src/stellar/rpc.js', () => ({
  server: { getEvents: (...args: unknown[]) => getEventsMock(...(args as [unknown])) },
  getLatestLedger: vi.fn().mockResolvedValue(100_000),
  getLatestLedgerInfo: vi.fn().mockResolvedValue({ sequence: 100_000, hash: 'HASH_TIP' }),
  getLedgerHash: vi.fn().mockResolvedValue('HASH_FOR_LEDGER'),
}))

async function cursorRow() {
  return queryOne<{ last_ledger: number | null; observed_tip_ledger: number | null; paging_token: string | null }>(
    'SELECT last_ledger, observed_tip_ledger, paging_token FROM indexer_cursor WHERE id = 1'
  )
}

describe('indexer: quarantine after repeated same-page failures (issue #43)', () => {
  beforeEach(async () => {
    await resetDb()
    getEventsMock.mockReset()
  })
  afterAll(closeDb)

  it('quarantines the offending event after the configured threshold, folding the rest of the page and keeping the raw log intact', async () => {
    const good1 = decodedEvent('joined', { member: 'GA', fee: '10' })
    // loan_dflt with no penalty field — FieldValidationError (issue #42),
    // deterministic every time this exact page is retried.
    const bad = decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GA' })
    const good2 = decodedEvent('joined', { member: 'GB', fee: '20' })
    const page = [good1, bad, good2]
    getEventsMock.mockResolvedValue({ events: page, cursor: 'tok-after', latestLedger: 100_000 })

    // Default INDEXER_QUARANTINE_AFTER_FAILURES is 3: the first two attempts
    // are still treated as possibly-transient and rethrow so runIndexer's
    // normal backoff gets a chance.
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)
    // Third consecutive identical failure on the same page — quarantine.
    await expect(fetchOnce('CTESTCONTRACT')).resolves.toBeUndefined()

    const members = await query<{ address: string }>('SELECT address FROM members ORDER BY address')
    expect(members.map((m) => m.address)).toEqual(['GA', 'GB'])

    const failed = await query<{ event_id: string; symbol: string; error: string }>(
      'SELECT event_id, symbol, error FROM failed_events'
    )
    expect(failed).toHaveLength(1)
    expect(failed[0]?.symbol).toBe('loan_dflt')
    expect(failed[0]?.event_id).toBe(bad.id)
    expect(failed[0]?.error).toMatch(/penalty/)

    // The raw log is untouched/complete for all three events, including the
    // quarantined one — CONTRIBUTING: never mutate or delete an events row.
    const rawIds = await query<{ id: string }>('SELECT id FROM events ORDER BY id')
    expect(rawIds.map((r) => r.id).sort()).toEqual([good1.id, bad.id, good2.id].sort())

    // The cursor advanced past the quarantined event — indexing continues.
    // (Cursor token prefers the last event's own id over the page response's
    // cursor — see fetchOnce's `nextToken` derivation.)
    const row = await cursorRow()
    expect(row?.paging_token).toBe(good2.id)
  })

  it('does not quarantine before the failure threshold — a fresh page attempt each poll still rolls back and retries as transient', async () => {
    const bad = decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GA' })
    getEventsMock.mockResolvedValue({ events: [bad], cursor: 'tok', latestLedger: 100_000 })

    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)

    expect(await query('SELECT * FROM failed_events')).toHaveLength(0)
    // Whole-page transaction rolled back — nothing persisted for a failure
    // that hasn't hit the quarantine threshold yet.
    expect(await query('SELECT * FROM events')).toHaveLength(0)
  })

  it('a transient failure that clears before the threshold is never quarantined', async () => {
    const bad = decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GA' })
    const good = decodedEvent('joined', { member: 'GA', fee: '10' })
    // Two failures (below the threshold of 3), then the underlying problem
    // clears — e.g. a redelivered RPC page that decodes cleanly this time.
    getEventsMock
      .mockResolvedValueOnce({ events: [bad], cursor: 'tok', latestLedger: 100_000 })
      .mockResolvedValueOnce({ events: [bad], cursor: 'tok', latestLedger: 100_000 })
      .mockResolvedValueOnce({ events: [good], cursor: 'tok', latestLedger: 100_000 })

    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)
    await expect(fetchOnce('CTESTCONTRACT')).resolves.toBeUndefined()

    // Recovered on its own — nothing was ever quarantined, and the failure
    // counter reset (a later unrelated failure would need to start over).
    expect(await query('SELECT * FROM failed_events')).toHaveLength(0)
    expect(await query<{ address: string }>('SELECT address FROM members')).toHaveLength(1)
  })

  it('a genuine rewind still halts the indexer and is never quarantined', async () => {
    await pool.query(
      `INSERT INTO indexer_cursor (id, paging_token, last_ledger, contract_id)
       VALUES (1, 'tok', 500, 'CTESTCONTRACT')`
    )
    const reorgEv = decodedEvent('joined', { member: 'GX', fee: '1' }, { ledger: 100 })
    getEventsMock.mockResolvedValue({ events: [reorgEv], cursor: 'tok2', latestLedger: 100_000 })

    // Repeat past the quarantine threshold — a reorg must keep throwing every
    // time, never falling into per-event quarantine mode.
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toBeInstanceOf(ReorgDetectedError)
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toBeInstanceOf(ReorgDetectedError)
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toBeInstanceOf(ReorgDetectedError)

    expect(await query('SELECT * FROM failed_events')).toHaveLength(0)
    expect(await query('SELECT * FROM events')).toHaveLength(0)
  })

  it('an event whose raw row was inserted but never folded — a crash between the two — is still folded on retry via the quarantine path (issue #119)', async () => {
    const bad = decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GB' })
    // loan_dflt with no penalty field — deterministic FieldValidationError,
    // same as the other tests in this file, needed to drive the page into
    // per-event quarantine mode.
    const crashed = decodedEvent('joined', { member: 'GA', fee: '10' })
    const page = [bad, crashed]
    getEventsMock.mockResolvedValue({ events: page, cursor: 'tok-after', latestLedger: 100_000 })

    // Simulate an earlier attempt that got as far as insertRawEvent's own
    // autocommitting INSERT but crashed before the fold's COMMIT: the raw
    // row exists, folded_at is unset, and no derived state exists for it.
    await pool.query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crashed.id, crashed.ledger, crashed.closedAt, crashed.contractId, crashed.symbol,
       JSON.stringify(crashed.topics), JSON.stringify(crashed.data), crashed.txHash]
    )

    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)
    // Quarantine kicks in on the third attempt. `crashed`'s raw row already
    // exists, but it must still be folded — insertRawEvent now keys "needs
    // folding" off folded_at, not off whether this call did the inserting.
    await expect(fetchOnce('CTESTCONTRACT')).resolves.toBeUndefined()

    const members = await query<{ address: string }>('SELECT address FROM members ORDER BY address')
    expect(members.map((m) => m.address)).toEqual(['GA'])

    const rows = await query<{ id: string; folded_at: string | null }>(
      'SELECT id, folded_at FROM events ORDER BY id'
    )
    expect(rows.find((r) => r.id === crashed.id)?.folded_at).not.toBeNull()
  })

  it('a failure recording the quarantined event in failed_events does not strand it or abort the rest of the page (issue #120)', async () => {
    const bad = decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GA' })
    const good = decodedEvent('joined', { member: 'GB', fee: '20' })
    const page = [bad, good]
    getEventsMock.mockResolvedValue({ events: page, cursor: 'tok-after', latestLedger: 100_000 })

    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)

    // Make the failed_events bookkeeping insert itself fail — a real
    // database-level failure (table briefly unavailable), standing in for
    // the constraint violation / disk full / dropped connection the issue
    // names. Restored in `finally` so later tests' resetDb() (which
    // truncates failed_events by name) isn't broken by this.
    await pool.query('ALTER TABLE failed_events RENAME TO failed_events_missing_120')
    try {
      // Third consecutive identical failure — quarantine kicks in. Recording
      // `bad` in failed_events fails, but this must still resolve (not
      // throw) and must still fold `good`, the event after it in the page.
      await expect(fetchOnce('CTESTCONTRACT')).resolves.toBeUndefined()
    } finally {
      await pool.query('ALTER TABLE failed_events_missing_120 RENAME TO failed_events')
    }

    const members = await query<{ address: string }>('SELECT address FROM members ORDER BY address')
    expect(members.map((m) => m.address)).toEqual(['GB'])

    // The bookkeeping insert failed, so nothing landed in failed_events...
    expect(await query('SELECT * FROM failed_events')).toHaveLength(0)

    // ...but the raw row for the un-recordable event is still there, marked
    // as not-yet-folded — the forensic trail an operator needs (issue #119)
    // now that a fold failure can't hide behind a failed_events row either.
    const badRow = await queryOne<{ folded_at: string | null }>(
      'SELECT folded_at FROM events WHERE id = $1',
      [bad.id]
    )
    expect(badRow?.folded_at).toBeNull()

    // The indexer still made progress — cursor advanced past the page.
    const row = await cursorRow()
    expect(row?.paging_token).toBe(good.id)
  })
})

describe('indexer: last_ledger vs observed_tip_ledger (issue #45)', () => {
  beforeEach(async () => {
    await resetDb()
    getEventsMock.mockReset()
  })
  afterAll(closeDb)

  it('an empty page never advances last_ledger to the RPC tip, so a later real page below that tip is not a false reorg', async () => {
    // 1. Cold start, non-empty page at ledger 600.
    const first = decodedEvent('joined', { member: 'GA', fee: '10' }, { ledger: 600 })
    getEventsMock.mockResolvedValueOnce({ events: [first], cursor: 'tok-1', latestLedger: 100_000 })
    await fetchOnce('CTESTCONTRACT')
    expect((await cursorRow())?.last_ledger).toBe(600)

    // 2. Empty page — must NOT pull last_ledger up to the chain tip.
    getEventsMock.mockResolvedValueOnce({ events: [], cursor: 'tok-1', latestLedger: 100_000 })
    await fetchOnce('CTESTCONTRACT')
    const afterEmpty = await cursorRow()
    expect(afterEmpty?.last_ledger).toBe(600)
    expect(afterEmpty?.observed_tip_ledger).toBe(100_000)

    // 3. A real page arrives at ledger 650 — legitimately below the chain
    // tip (100000), and below what the old conflated last_ledger would have
    // become. Must fold cleanly, not raise ReorgDetectedError.
    const second = decodedEvent('joined', { member: 'GB', fee: '10' }, { ledger: 650 })
    getEventsMock.mockResolvedValueOnce({ events: [second], cursor: 'tok-2', latestLedger: 100_000 })
    await expect(fetchOnce('CTESTCONTRACT')).resolves.toBeUndefined()
    expect((await cursorRow())?.last_ledger).toBe(650)

    const members = await query<{ address: string }>('SELECT address FROM members ORDER BY address')
    expect(members.map((m) => m.address)).toEqual(['GA', 'GB'])
  })

  it('a genuine rewind — an event below the actual folded high-water mark — still raises ReorgDetectedError', async () => {
    const first = decodedEvent('joined', { member: 'GA', fee: '10' }, { ledger: 600 })
    getEventsMock.mockResolvedValueOnce({ events: [first], cursor: 'tok-1', latestLedger: 100_000 })
    await fetchOnce('CTESTCONTRACT')
    expect((await cursorRow())?.last_ledger).toBe(600)

    const rewound = decodedEvent('joined', { member: 'GB', fee: '10' }, { ledger: 590 })
    getEventsMock.mockResolvedValueOnce({ events: [rewound], cursor: 'tok-2', latestLedger: 100_000 })
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toBeInstanceOf(ReorgDetectedError)
  })
})
