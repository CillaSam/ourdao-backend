import { afterEach, describe, expect, it, vi } from 'vitest'
import { Account, Keypair, MuxedAccount, StrKey } from '@stellar/stellar-sdk'
import {
  authenticateRequest,
  classifyStellarAddress,
  extractAuthHeaders,
  isValidStellarAddress,
  verifySignature,
  MemoryNonceStore,
  type NonceStore,
} from '../src/auth.js'

// Direct coverage for the whole auth/authz surface (#72). Pure logic, no
// database. Real Keypair.random() keys and real signatures throughout, never
// mocked verification. The classifyStellarAddress / verifySignature (#71) and
// authenticateRequest (#70) blocks below landed with those issues; #72 adds
// MemoryNonceStore, extractAuthHeaders, isValidStellarAddress, and the
// characterization cases that pin exact behaviour (including anything that
// looks off — noted, not fixed).

const keypair = Keypair.random()
const G = keypair.publicKey()
const M = new MuxedAccount(new Account(G, '0'), '42').accountId()
const C = StrKey.encodeContract(Buffer.alloc(32, 7))

function sign(nonce: string, address: string): string {
  return keypair.sign(Buffer.from(`${nonce}:${address}`, 'utf8')).toString('base64')
}

/** A NonceStore that always accepts, so signature-path assertions don't need a DB. */
const alwaysValidNonce: NonceStore = {
  issue: async () => 'n',
  consume: async () => true,
}

describe('classifyStellarAddress', () => {
  it('distinguishes ed25519, muxed, contract, and invalid', () => {
    expect(classifyStellarAddress(G)).toBe('ed25519')
    expect(classifyStellarAddress(M)).toBe('muxed')
    expect(classifyStellarAddress(C)).toBe('contract')
    expect(classifyStellarAddress('not-a-strkey')).toBe('invalid')
  })
})

describe('verifySignature (issue #71)', () => {
  it('accepts a valid G… signature', () => {
    const r = verifySignature(G, 'nonce1', sign('nonce1', G))
    expect(r).toEqual({ ok: true, ed25519Address: G })
  })

  it('rejects a valid-length but wrong signature as 401 "Invalid signature"', () => {
    const wrong = Keypair.random().sign(Buffer.from('x')).toString('base64')
    expect(verifySignature(G, 'nonce1', wrong)).toEqual({
      ok: false,
      status: 401,
      error: 'Invalid signature',
    })
  })

  it('reports a contract (C…) account as unsupported with a 400, not "Invalid signature"', () => {
    const r = verifySignature(C, 'nonce1', sign('nonce1', C))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(400)
    expect(r.error).toMatch(/contract/i)
    expect(r.error).not.toMatch(/invalid signature/i)
  })

  it('resolves a muxed (M…) address to its underlying G… account and verifies against it', () => {
    const r = verifySignature(M, 'nonce1', sign('nonce1', M))
    expect(r).toEqual({ ok: true, ed25519Address: G })
  })

  it('rejects an unrecognized address format with a 400', () => {
    const r = verifySignature('GARBAGE', 'nonce1', sign('nonce1', 'GARBAGE'))
    expect(r).toMatchObject({ ok: false, status: 400 })
  })

  it('treats a malformed-length signature as invalid without throwing', () => {
    expect(verifySignature(G, 'nonce1', 'not-base64-!!!')).toMatchObject({
      ok: false,
      status: 401,
    })
  })
})

describe('authenticateRequest (issue #70)', () => {
  function headersFor(address: string, nonce = 'nonce1'): Record<string, unknown> {
    return { authorization: `StellarSignature ${address}:${sign(nonce, address)}:${nonce}` }
  }

  it('returns the authenticated address on success', async () => {
    const res = await authenticateRequest(headersFor(G), alwaysValidNonce)
    expect(res).toEqual({ authenticated: true, address: G })
  })

  it('never carries an address on failure — the union makes it a type error to read one', async () => {
    const res = await authenticateRequest({ authorization: 'StellarSignature bad' }, alwaysValidNonce)
    expect(res.authenticated).toBe(false)
    // @ts-expect-error address is not present on the failure branch
    expect(res.address).toBeUndefined()
  })

  it('surfaces the 400 status for a contract account rather than a blanket 401', async () => {
    const res = await authenticateRequest(headersFor(C), alwaysValidNonce)
    expect(res).toMatchObject({ authenticated: false, status: 400 })
  })

  it('keeps existing 401 behaviour for a bad nonce and a bad signature', async () => {
    const rejectingNonce: NonceStore = { issue: async () => 'n', consume: async () => false }
    const badNonce = await authenticateRequest(headersFor(G), rejectingNonce)
    expect(badNonce).toMatchObject({ authenticated: false, status: 401 })

    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)
    const badSig = await authenticateRequest(
      { authorization: `StellarSignature ${G}:${Keypair.random().sign(Buffer.from('x')).toString('base64')}:${nonce}` },
      store,
    )
    expect(badSig).toMatchObject({ authenticated: false, status: 401, error: 'Invalid signature' })
    await store.shutdown()
  })

  it('rejects a target-address mismatch (unchanged 401 behaviour)', async () => {
    const other = Keypair.random().publicKey()
    const res = await authenticateRequest(headersFor(G), alwaysValidNonce, other)
    expect(res).toMatchObject({ authenticated: false, status: 401 })
  })
})

describe('MemoryNonceStore (#72)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('issue() returns the same nonce for the same address if not expired, distinct for different addresses', async () => {
    const store = new MemoryNonceStore()
    const a1 = await store.issue('GA')
    const a2 = await store.issue('GA')
    const b1 = await store.issue('GB')
    for (const n of [a1, a2, b1]) expect(n).toMatch(/^[0-9a-f]{64}$/)
    // a1 and a2 should be the same (nonce not expired)
    expect(a1).toBe(a2)
    // b1 should be different (different address)
    expect(b1).not.toBe(a1)
    await store.shutdown()
  })

  it('consume() succeeds exactly once for a valid (address, nonce) pair', async () => {
    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)
    expect(await store.consume(G, nonce)).toBe(true)
    expect(await store.consume(G, nonce)).toBe(false)
    await store.shutdown()
  })

  it('consume() fails for the wrong nonce and for an unknown address', async () => {
    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)
    expect(await store.consume(G, 'not-the-nonce')).toBe(false)
    expect(await store.consume('GUNKNOWN', nonce)).toBe(false)
    await store.shutdown()
  })

  it("consume() rejects address A's nonce presented for address B", async () => {
    const store = new MemoryNonceStore()
    const nonceForA = await store.issue('GA')
    expect(await store.consume('GB', nonceForA)).toBe(false)
    await store.shutdown()
  })

  it('an entry past its 5-minute TTL fails on consume — expiry is evaluated at consume time', async () => {
    vi.useFakeTimers()
    const store = new MemoryNonceStore()
    await store.shutdown() // stop the periodic sweep so `consume` is what detects expiry
    const nonce = await store.issue(G)
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(await store.consume(G, nonce)).toBe(false)
  })

  it('the periodic sweep evicts expired entries without a consume call', async () => {
    vi.useFakeTimers()
    const store = new MemoryNonceStore()
    await store.issue(G)
    vi.advanceTimersByTime(6 * 60 * 1000) // sweep runs every 60s; entry expires at 300s
    const internal = (store as unknown as { store: Map<string, unknown> }).store
    expect(internal.size).toBe(0)
    await store.shutdown()
  })
})

describe('extractAuthHeaders (#72)', () => {
  const NULLS = { address: null, signature: null, nonce: null }

  it('returns nulls for an absent header', () => {
    expect(extractAuthHeaders({})).toEqual(NULLS)
  })

  it('returns nulls for a non-string header', () => {
    expect(extractAuthHeaders({ authorization: 12345 })).toEqual(NULLS)
  })

  it('returns nulls for the wrong scheme prefix', () => {
    expect(extractAuthHeaders({ authorization: 'Bearer abc:def:ghi' })).toEqual(NULLS)
  })

  it('returns nulls for too few colon-separated parts', () => {
    expect(extractAuthHeaders({ authorization: 'StellarSignature addr:sig' })).toEqual(NULLS)
  })

  it('returns nulls for too many colon-separated parts', () => {
    expect(extractAuthHeaders({ authorization: 'StellarSignature a:b:c:d' })).toEqual(NULLS)
  })

  it('parses a well-formed header into its three components', () => {
    expect(extractAuthHeaders({ authorization: 'StellarSignature GABC:c2ln:n0nce' })).toEqual({
      address: 'GABC',
      signature: 'c2ln',
      nonce: 'n0nce',
    })
  })

  it('pins current behaviour: empty components come back as empty strings, not null', () => {
    expect(extractAuthHeaders({ authorization: 'StellarSignature ::' })).toEqual({
      address: '',
      signature: '',
      nonce: '',
    })
  })
})

describe('isValidStellarAddress (#72)', () => {
  it('accepts a real G-address and rejects junk and non-ed25519 strkeys', () => {
    expect(isValidStellarAddress(G)).toBe(true)
    expect(isValidStellarAddress('not-an-address')).toBe(false)
    expect(isValidStellarAddress(C)).toBe(false)
  })
})

describe('authenticateRequest — characterization (#72)', () => {
  function headersFor(address: string, nonce: string): Record<string, unknown> {
    return { authorization: `StellarSignature ${address}:${sign(nonce, address)}:${nonce}` }
  }

  it('authenticates a request with a real nonce and signature', async () => {
    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)
    expect(await authenticateRequest(headersFor(G, nonce), store)).toEqual({
      authenticated: true,
      address: G,
    })
    await store.shutdown()
  })

  it('returns the exact client-facing error string for each failure', async () => {
    expect(await authenticateRequest({}, alwaysValidNonce)).toMatchObject({
      error: 'Missing authentication headers',
    })
    expect(
      await authenticateRequest(headersFor(G, 'n'), { issue: async () => 'n', consume: async () => false }),
    ).toMatchObject({ error: 'Invalid or expired nonce' })
    expect(
      await authenticateRequest({ authorization: `StellarSignature ${G}:bm90LXNpZw:n` }, alwaysValidNonce),
    ).toMatchObject({ error: 'Invalid signature' })

    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)
    expect(
      await authenticateRequest(headersFor(G, nonce), store, Keypair.random().publicKey()),
    ).toMatchObject({ error: 'Cannot modify notifications for another address' })
    await store.shutdown()
  })

  // The actual authorization control: one member cannot act on another's data.
  // Deleting the `if (targetAddress && targetAddress !== address)` block in
  // src/auth.ts makes this test return `{ authenticated: true, address: G }`.
  it('rejects a targetAddress that is not the authenticated address', async () => {
    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)
    const res = await authenticateRequest(headersFor(G, nonce), store, Keypair.random().publicKey())
    expect(res).toEqual({
      authenticated: false,
      status: 401,
      error: 'Cannot modify notifications for another address',
    })
    await store.shutdown()
  })

  it('verifies the signature before consuming the nonce, so a bad-signature request never spends it (issue #115)', async () => {
    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)
    const first = await authenticateRequest(
      { authorization: `StellarSignature ${G}:bm90LXNpZw:${nonce}` },
      store,
    )
    expect(first).toMatchObject({ authenticated: false, error: 'Invalid signature' })
    // The nonce must still be alive: a correctly-signed follow-up succeeds.
    const second = await authenticateRequest(headersFor(G, nonce), store)
    expect(second).toEqual({ authenticated: true, address: G })
    await store.shutdown()
  })
})
