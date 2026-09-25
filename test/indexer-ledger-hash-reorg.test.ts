// Issue #127: `last_ledger_hash` used to store the RPC tip's hash at the
// time the cursor advanced, not the hash of the ledger actually folded to —
// so it described something other than what it sat beside.
// Issue #128: the column was then never read back, so a same-height fork
// (history diverging without the ledger sequence moving backwards) went
// undetected — only a sequence rewind halted the indexer. Both live in
// src/indexer/poller.ts / src/stellar/rpc.ts, share the same mock setup as
// test/indexer-quarantine-cursor.test.ts, so one file.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryOne } from '../src/db/index.js'
import { fetchOnce, ReorgDetectedError } from '../src/indexer/poller.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'
import type { DecodedEvent } from '../src/stellar/events.js'

vi.mock('../src/stellar/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/stellar/events.js')>()
  return { ...actual, decodeEvent: (raw: unknown) => raw as DecodedEvent }
})

const getEventsMock = vi.fn()
const getLedgerHashMock = vi.fn()
vi.mock('../src/stellar/rpc.js', () => ({
  server: { getEvents: (...args: unknown[]) => getEventsMock(...(args as [unknown])) },
  getLatestLedger: vi.fn().mockResolvedValue(100_000),
  // Distinct from any per-ledger hash below, so a test that accidentally
  // stored the tip's hash instead of the folded ledger's is caught.
  getLatestLedgerInfo: vi.fn().mockResolvedValue({ sequence: 100_000, hash: 'HASH_TIP' }),
  getLedgerHash: (...args: unknown[]) => getLedgerHashMock(...(args as [number])),
}))

async function cursorRow() {
  return queryOne<{ last_ledger: number | null; last_ledger_hash: string | null }>(
    'SELECT last_ledger, last_ledger_hash FROM indexer_cursor WHERE id = 1'
  )
}

describe('indexer: last_ledger_hash stores the folded ledger\'s own hash (issue #127)', () => {
  beforeEach(async () => {
    await resetDb()
    getEventsMock.mockReset()
    getLedgerHashMock.mockReset()
  })
  afterAll(closeDb)

  it('stores the hash of the ledger actually folded to, not the RPC tip\'s hash', async () => {
    getLedgerHashMock.mockResolvedValueOnce('HASH_LEDGER_700')
    const ev = decodedEvent('joined', { member: 'GA', fee: '10' }, { ledger: 700 })
    getEventsMock.mockResolvedValueOnce({ events: [ev], cursor: 'tok', latestLedger: 100_000 })

    await fetchOnce('CTESTCONTRACT')

    expect(getLedgerHashMock).toHaveBeenCalledWith(700)
    const row = await cursorRow()
    expect(row?.last_ledger).toBe(700)
    expect(row?.last_ledger_hash).toBe('HASH_LEDGER_700')
    expect(row?.last_ledger_hash).not.toBe('HASH_TIP')
  })

  it('does not re-fetch the hash on a poll that does not advance the folded ledger', async () => {
    getLedgerHashMock.mockResolvedValueOnce('HASH_LEDGER_700')
    const ev = decodedEvent('joined', { member: 'GA', fee: '10' }, { ledger: 700 })
    getEventsMock.mockResolvedValueOnce({ events: [ev], cursor: 'tok', latestLedger: 100_000 })
    await fetchOnce('CTESTCONTRACT')
    getLedgerHashMock.mockClear()

    // Empty page — nothing new folded, so the stored hash is still correct
    // and shouldn't need re-fetching from the RPC.
    getLedgerHashMock.mockResolvedValueOnce('HASH_LEDGER_700') // for the verification check below
    getEventsMock.mockResolvedValueOnce({ events: [], cursor: 'tok', latestLedger: 100_000 })
    await fetchOnce('CTESTCONTRACT')

    // The one call that did happen was the verification check for ledger
    // 700 (issue #128), not a re-fetch to (re)populate the cursor row.
    expect(getLedgerHashMock).toHaveBeenCalledTimes(1)
    expect(getLedgerHashMock).toHaveBeenCalledWith(700)
    expect((await cursorRow())?.last_ledger_hash).toBe('HASH_LEDGER_700')
  })
})

describe('indexer: same-height fork detection via ledger hash (issue #128)', () => {
  beforeEach(async () => {
    await resetDb()
    getEventsMock.mockReset()
    getLedgerHashMock.mockReset()
  })
  afterAll(closeDb)

  it('halts with ReorgDetectedError when the RPC reports a different hash for the last folded ledger, even though the sequence never moved backwards', async () => {
    getLedgerHashMock.mockResolvedValueOnce('HASH_V1')
    const ev = decodedEvent('joined', { member: 'GA', fee: '10' }, { ledger: 700 })
    getEventsMock.mockResolvedValueOnce({ events: [ev], cursor: 'tok', latestLedger: 100_000 })
    await fetchOnce('CTESTCONTRACT')
    expect((await cursorRow())?.last_ledger_hash).toBe('HASH_V1')

    // Next poll: the RPC's reported tip (100_000) is still well above 700 —
    // the coarse sequence check alone would see nothing wrong — but ledger
    // 700 itself now hashes differently: history diverged at the same height.
    getLedgerHashMock.mockResolvedValueOnce('HASH_V2')
    getEventsMock.mockResolvedValueOnce({ events: [], cursor: 'tok', latestLedger: 100_000 })

    await expect(fetchOnce('CTESTCONTRACT')).rejects.toBeInstanceOf(ReorgDetectedError)
  })

  it('treats a pruned ledger (RPC has no hash for it any more) as unverifiable, not as a fork', async () => {
    getLedgerHashMock.mockResolvedValueOnce('HASH_V1')
    const ev = decodedEvent('joined', { member: 'GA', fee: '10' }, { ledger: 700 })
    getEventsMock.mockResolvedValueOnce({ events: [ev], cursor: 'tok', latestLedger: 100_000 })
    await fetchOnce('CTESTCONTRACT')

    getLedgerHashMock.mockResolvedValueOnce(null)
    getEventsMock.mockResolvedValueOnce({ events: [], cursor: 'tok', latestLedger: 100_000 })

    await expect(fetchOnce('CTESTCONTRACT')).resolves.toBeUndefined()
    // Unverifiable, not a mismatch — the stored hash is left untouched.
    expect((await cursorRow())?.last_ledger_hash).toBe('HASH_V1')
  })

  it('skips the hash check on a cold start (no prior cursor to verify against)', async () => {
    const ev = decodedEvent('joined', { member: 'GA', fee: '10' }, { ledger: 700 })
    getLedgerHashMock.mockResolvedValueOnce('HASH_V1') // only the post-fold store, no pre-check call
    getEventsMock.mockResolvedValueOnce({ events: [ev], cursor: 'tok', latestLedger: 100_000 })

    await expect(fetchOnce('CTESTCONTRACT')).resolves.toBeUndefined()
    expect(getLedgerHashMock).toHaveBeenCalledTimes(1)
    expect(getLedgerHashMock).toHaveBeenCalledWith(700)
  })
})
