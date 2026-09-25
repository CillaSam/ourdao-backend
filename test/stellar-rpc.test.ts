// getLedgerHash (issues #127/#128) must never reject — the RPC's own
// getLedgers throws (rather than returning an empty page) once `sequence`
// has aged out of its retention window, and poller.ts's hash-based reorg
// check treats a rejection the same as an explicit "unverifiable" null. If
// this resolved to a rejection instead, a single old/pruned ledger would
// wedge fetchOnce in permanent retry even though its events are already
// safely folded and committed.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { server, getLedgerHash } from '../src/stellar/rpc.js'

describe('getLedgerHash', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const baseResponse = {
    latestLedger: 0,
    latestLedgerCloseTime: 0,
    oldestLedger: 0,
    oldestLedgerCloseTime: 0,
    cursor: '',
  }

  it('resolves to the ledger hash on a normal response', async () => {
    vi.spyOn(server, 'getLedgers').mockResolvedValue({
      ...baseResponse,
      ledgers: [{ hash: 'HASH_123' } as Awaited<ReturnType<typeof server.getLedgers>>['ledgers'][number]],
    })

    await expect(getLedgerHash(123)).resolves.toBe('HASH_123')
  })

  it('resolves to null when the RPC throws — e.g. the ledger aged out of its retention window', async () => {
    vi.spyOn(server, 'getLedgers').mockRejectedValue(
      new Error('startLedger 100 is before oldest ledger 5000')
    )

    await expect(getLedgerHash(100)).resolves.toBeNull()
  })

  it('resolves to null on an empty ledgers array, without throwing', async () => {
    vi.spyOn(server, 'getLedgers').mockResolvedValue({ ...baseResponse, ledgers: [] })

    await expect(getLedgerHash(999)).resolves.toBeNull()
  })
})
