import { describe, expect, it } from 'vitest'
import { Address, Keypair, nativeToScVal, xdr, type rpc } from '@stellar/stellar-sdk'
import { ADMIN_EVENT_SYMBOLS, EVENT_FIELDS, decodeEvent, toJsonSafe } from '../src/stellar/events.js'

const ADDR = Keypair.random().publicKey()

/** Build a minimal getEvents response entry, shaped like the real RPC would
 *  return it. `data` is what the contract published as the event's value
 *  tuple (already ScVal-encoded); pass `undefined` for unit-value events
 *  (e.g. `paused`, published with `()`). */
function makeEvent(symbol: string, data?: xdr.ScVal): rpc.Api.EventResponse {
  return {
    id: '0000012345-0000000001',
    type: 'contract',
    ledger: 12345,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    contractId: 'CCONTRACTIDPLACEHOLDER00000000000000000000000000000000000000',
    topic: [xdr.ScVal.scvSymbol(symbol)],
    value: data ?? xdr.ScVal.scvVoid(),
  } as unknown as rpc.Api.EventResponse
}

function tuple(...vals: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(vals)
}

describe('decodeEvent', () => {
  it('decodes a known symbol into named fields', () => {
    const data = tuple(new Address(ADDR).toScVal(), nativeToScVal(500n, { type: 'i128' }))
    const ev = decodeEvent(makeEvent('joined', data))

    expect(ev.symbol).toBe('joined')
    expect(ev.fields.member).toBe(ADDR)
    expect(ev.fields.fee).toBe('500')
  })

  it('names every field for every catalog entry that has data', () => {
    // amount/fee/etc are i128 -> bigint at decode time, which must survive
    // JSON/JSONB round-tripping as a string (toJsonSafe).
    const data = tuple(
      nativeToScVal(7, { type: 'u32' }),
      new Address(ADDR).toScVal(),
      nativeToScVal(1_000_000_000_000n, { type: 'i128' }),
      nativeToScVal(1_100_000_000_000n, { type: 'i128' })
    )
    const ev = decodeEvent(makeEvent('loan_req', data))
    expect(Object.keys(ev.fields)).toEqual(EVENT_FIELDS.loan_req)
    expect(typeof ev.fields.amount).toBe('string')
  })

  it('decodes loan_vote without a weight field as a missing (null) weight, not an error', () => {
    // The current contract publishes only (proposal_id, voter, support) —
    // `weight` is reserved in EVENT_FIELDS for once ourdao-contracts adds it.
    const data = tuple(
      nativeToScVal(1, { type: 'u32' }),
      new Address(ADDR).toScVal(),
      nativeToScVal(true)
    )
    const ev = decodeEvent(makeEvent('loan_vote', data))
    expect(ev.fields.support).toBe(true)
    expect(ev.fields.weight).toBeNull()
  })

  it('decodes loan_wait/tre_wait (id, amount) and loan_rej/tre_rej (id, for_votes, against_votes) (issues #123-125)', () => {
    const waitData = tuple(nativeToScVal(7, { type: 'u32' }), nativeToScVal(1_000_000_000_000n, { type: 'i128' }))
    for (const symbol of ['loan_wait', 'tre_wait'] as const) {
      const ev = decodeEvent(makeEvent(symbol, waitData))
      expect(Object.keys(ev.fields)).toEqual(EVENT_FIELDS[symbol])
      expect(ev.fields.id).toBe(7)
      expect(typeof ev.fields.amount).toBe('string')
    }

    const rejData = tuple(
      nativeToScVal(8, { type: 'u32' }),
      nativeToScVal(200_000_000_000n, { type: 'i128' }),
      nativeToScVal(500_000_000_000n, { type: 'i128' })
    )
    for (const symbol of ['loan_rej', 'tre_rej'] as const) {
      const ev = decodeEvent(makeEvent(symbol, rejData))
      expect(Object.keys(ev.fields)).toEqual(EVENT_FIELDS[symbol])
      expect(ev.fields.id).toBe(8)
      expect(ev.fields.for_votes).toBe('200000000000')
      expect(ev.fields.against_votes).toBe('500000000000')
    }
  })

  it('falls back to an empty fields map for an unknown symbol, but keeps the raw data', () => {
    const data = tuple(nativeToScVal(1, { type: 'u32' }))
    const ev = decodeEvent(makeEvent('totally_unknown_symbol', data))
    expect(ev.fields).toEqual({})
    expect(ev.data).toEqual([1])
  })

  it('decodes unit-value (no-data) admin events without throwing', () => {
    const ev = decodeEvent(makeEvent('paused'))
    expect(ev.symbol).toBe('paused')
    expect(EVENT_FIELDS.paused).toEqual([])
  })

  it('every ADMIN_EVENT_SYMBOLS entry is present in EVENT_FIELDS', () => {
    for (const sym of ADMIN_EVENT_SYMBOLS) {
      expect(Object.prototype.hasOwnProperty.call(EVENT_FIELDS, sym)).toBe(true)
    }
  })

  it('captures topic decode error and flags the event', () => {
    const data = tuple(nativeToScVal(1, { type: 'u32' }))
    const evRaw = makeEvent('some_symbol', data)
    evRaw.topic = [{} as xdr.ScVal]
    const ev = decodeEvent(evRaw)
    expect(ev.decodeError).toBeTruthy()
    expect(ev.symbol).toBe('')
  })

  it('captures data decode error and flags the event', () => {
    const evRaw = makeEvent('some_symbol', {} as xdr.ScVal)
    const ev = decodeEvent(evRaw)
    expect(ev.decodeError).toBeTruthy()
  })
})

describe('toJsonSafe', () => {
  it('stringifies bigints recursively, including inside arrays and objects', () => {
    expect(toJsonSafe(42n)).toBe('42')
    expect(toJsonSafe([1n, 'x', { a: 2n }])).toEqual(['1', 'x', { a: '2' }])
  })

  it('passes non-bigint primitives through untouched', () => {
    expect(toJsonSafe('hi')).toBe('hi')
    expect(toJsonSafe(true)).toBe(true)
    expect(toJsonSafe(null)).toBe(null)
  })
})
