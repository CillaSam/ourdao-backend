import { scValToNative, type rpc, type xdr } from '@stellar/stellar-sdk'

// The complete catalog of events the OurDAO contract publishes, keyed by the
// first-topic symbol. `fields` names the positional entries of the published
// data tuple so downstream handlers read `data.borrower` instead of `data[1]`.
// Kept in sync with ourdao-contracts (membership/loans/treasury/staking/
// registry/privacy .rs `env.events().publish(...)` calls).
export const EVENT_FIELDS = {
  joined: ['member', 'fee'],
  exited: ['member', 'share'],
  claimed: ['member', 'pending'],
  loan_req: ['id', 'borrower', 'amount', 'total_repayment'],
  loan_edit: ['proposal_id', 'borrower', 'new_amount', 'total_repayment'],
  // `weight` is not yet published by ourdao-contracts — the contract applies
  // stake-weighted voting power internally (util::voting_weight) but only
  // publishes `support`. Named here ahead of time so that once the contract
  // adds it as a 4th tuple entry, it decodes automatically with no change to
  // this file; until then it decodes as `null` and handlers.ts treats that
  // as a weight of 1.
  loan_vote: ['proposal_id', 'voter', 'support', 'weight'],
  // Published from inside loans.rs::vote_on_loan_proposal, right after the
  // vote that pushes the proposal past quorum, when the treasury can't cover
  // the disbursement yet (approve_and_disburse fails). The contract has
  // already moved the proposal to ApprovedPendingDisbursement — that state
  // was previously invisible off-chain (issue #125). A later permissionless
  // `disburse_approved_loan` call resolves it and republishes `loan_appr`,
  // which the existing handler below already folds unconditionally.
  loan_wait: ['id', 'amount'],
  // Published from the same function when the votes still outstanding can no
  // longer mathematically reach quorum — an early rejection, distinct from
  // `loan_exp`'s permissionless-keeper-call-after-the-window path below.
  // `for_votes`/`against_votes` are the contract's final stake-weighted tally
  // at the moment of rejection (issue #124).
  loan_rej: ['id', 'for_votes', 'against_votes'],
  // `id` here is the disbursed loan's id, which the contract deliberately
  // reuses as the originating proposal's id (loans.rs::approve_and_disburse
  // sets `id = proposal.id` rather than drawing from a separate counter) —
  // a proposal produces at most one loan, so this is a real invariant, not
  // a coincidence. The loan_appr handler below relies on it to update both
  // loan_proposals and loans with the same `id`.
  // `due_time` is likewise not yet published by ourdao-contracts (the
  // contract computes it in approve_and_disburse but doesn't publish it) —
  // named ahead of time for the same forward-compat reason as `loan_vote`'s
  // `weight` above.
  loan_appr: ['id', 'borrower', 'amount', 'due_time'],
  loan_rpy: ['loan_id', 'borrower', 'outstanding'],
  loan_dflt: ['loan_id', 'borrower', 'penalty'],
  // Permissionless keeper call that transitions a loan proposal whose voting
  // window closed without reaching quorum. Fields match the contract's
  // publish order in loans.rs::expire_loan_proposal exactly:
  // env.events().publish((symbol_short!("loan_exp"),), (proposal_id, proposal.borrower)).
  // The contract doc says it "succeeds exactly once per proposal — subsequent
  // calls are a no-op (no double event)", so re-delivery is safe to guard at
  // the DB level (WHERE status = 'pending').
  // Introduced in ourdao-contracts @ the commit that added expire_loan_proposal
  // (loans.rs). Fixes issue #38.
  loan_exp: ['proposal_id', 'borrower'],
  interest: ['interest', 'active'],
  tre_prop: ['id', 'amount', 'destination', 'private'],
  tre_vote: ['id', 'voter', 'support', 'weight'],
  // Treasury equivalent of `loan_wait` above — published from treasury.rs's
  // vote-tally path when the proposal reaches quorum but `execute` fails
  // because the treasury can't cover it yet (issue #125). A later
  // `execute_treasury_proposal` call resolves it and republishes `tre_exec`.
  tre_wait: ['id', 'amount'],
  // Treasury equivalent of `loan_rej` above (issue #124).
  tre_rej: ['id', 'for_votes', 'against_votes'],
  tre_exec: ['id', 'amount', 'destination'],
  staked: ['member', 'amount', 'new_stake'],
  unstaked: ['member', 'amount', 'new_stake'],
  name_reg: ['name', 'owner'],
  committed: ['proposal_id', 'voter'],
  revealed: ['proposal_id', 'voter', 'support', 'weight'],
  doc_attn: ['kind', 'proposal_id', 'caller'],
  // Admin/governance events. `policy`, `paused`, and `unpaused` carry no data
  // tuple (the contract publishes `()`), so they have no named fields.
  init: ['admins', 'consensus_threshold', 'membership_fee', 'token'],
  admin_add: ['admin'],
  admin_rem: ['admin'],
  threshold: ['threshold'],
  policy: [],
  paused: [],
  unpaused: [],
} as const

/** Loan lifecycle event symbols, in the order a loan moves through them
 *  (issue #26). For every one, the loan / proposal id is the *first* data
 *  tuple entry — named `id` on `loan_req`/`loan_appr`, `proposal_id` on
 *  `loan_edit`/`loan_vote`, `loan_id` on `loan_rpy`/`loan_dflt` — because
 *  `loans.id == loan_proposals.id` is a contract invariant, so one id keys
 *  the whole timeline. Consumed by `GET /api/loans/:id/timeline`, which
 *  filters `events` on `data->>0`. */
export const LOAN_TIMELINE_SYMBOLS = [
  'loan_req',
  'loan_edit',
  'loan_vote',
  'loan_wait',
  'loan_rej',
  'loan_appr',
  'loan_rpy',
  'loan_dflt',
  'loan_exp',
] as const

/** Treasury proposal lifecycle event symbols (issue #26). The proposal id is
 *  likewise the first data tuple entry on every one (`id` on `tre_prop`/
 *  `tre_vote`/`tre_exec`, `proposal_id` on `committed`/`revealed`). Consumed
 *  by `GET /api/proposals/treasury/:id/timeline`. */
export const TREASURY_TIMELINE_SYMBOLS = [
  'tre_prop',
  'tre_vote',
  'committed',
  'revealed',
  'tre_wait',
  'tre_rej',
  'tre_exec',
] as const

/** Event symbols that name a member address as a participant somewhere in
 *  their data tuple (issue #26). The address position differs per symbol —
 *  `data[0]` for `joined`/`staked`/…, `data[1]` for `loan_req`/`loan_vote`/…
 *  — so `GET /api/members/:address/activity` matches with JSONB containment
 *  (`data @> '"G…"'`) rather than a fixed offset, and restricts to this set
 *  so an address that only appears as e.g. a treasury `destination` doesn't
 *  register as member activity. */
export const MEMBER_ACTIVITY_SYMBOLS = [
  'joined',
  'exited',
  'claimed',
  'staked',
  'unstaked',
  'name_reg',
  'loan_req',
  'loan_edit',
  'loan_vote',
  'loan_appr',
  'loan_rpy',
  'loan_dflt',
  'loan_exp',
  'tre_vote',
  'committed',
  'revealed',
] as const

/** Event symbols that represent governance/admin actions rather than DAO
 *  member activity. Used to power the admin audit log endpoint. */
export const ADMIN_EVENT_SYMBOLS = [
  'init',
  'admin_add',
  'admin_rem',
  'threshold',
  'policy',
  'paused',
  'unpaused',
] as const

export type EventSymbol = keyof typeof EVENT_FIELDS

/** A raw contract event decoded into JSON-safe primitives. */
export interface DecodedEvent {
  id: string
  ledger: number
  closedAt: string
  contractId: string
  txHash: string | null
  symbol: string
  topics: unknown[]
  /** Positional data tuple, JSON-safe (bigints -> strings). */
  data: unknown[]
  /** Named view of `data` when the symbol is in the catalog. */
  fields: Record<string, unknown>
  decodeError?: string | null
}

/** Recursively convert bigints to strings so values survive JSON/JSONB. */
export function toJsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(toJsonSafe)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, toJsonSafe(val)])
    )
  }
  return v
}

function safeNative(scv: xdr.ScVal, evInfo: { id: string, ledger: number }, pos: string): { val: unknown; err?: string } {
  try {
    return { val: toJsonSafe(scValToNative(scv)) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[events] decode error at ledger ${evInfo.ledger}, event ${evInfo.id}, ${pos}: ${msg}`)
    return { val: null, err: msg }
  }
}

/** Map a positional data tuple to the named fields for its symbol, using the
 *  `EVENT_FIELDS` catalog. Unknown symbols get `{}`. Shared by the live
 *  decoder and the re-index path (issue #23), which rebuilds `fields` from a
 *  stored `data` tuple. */
export function namedFields(symbol: string, data: unknown[]): Record<string, unknown> {
  const names = EVENT_FIELDS[symbol as EventSymbol] as readonly string[] | undefined
  const fields: Record<string, unknown> = {}
  if (names) names.forEach((name, i) => (fields[name] = data[i] ?? null))
  return fields
}

// --- Unknown-symbol observability (issue #39) --------------------------------
//
// An event whose symbol isn't in EVENT_FIELDS is still persisted and still
// no-ops in the fold — that behavior is correct and unchanged. What was
// missing is any signal that it happened: a new contract event would leave
// derived state quietly incomplete. `warnUnknownSymbol` logs the first
// sighting of each unknown symbol, once per process (a backlog drain or a
// full `npm run reindex` must not emit thousands of identical lines).

const seenUnknownSymbols = new Set<string>()

/** Log a one-time warning for an event symbol missing from the catalog.
 *  Called from the fold (indexer/handlers.ts `applyEvent`), so it fires on
 *  the live path and on a rebuild alike. */
export function warnUnknownSymbol(ev: { symbol: string; ledger: number; id: string }): void {
  if (seenUnknownSymbols.has(ev.symbol)) return
  seenUnknownSymbols.add(ev.symbol)
  console.warn(
    `[events] unknown event symbol "${ev.symbol}" — not in the EVENT_FIELDS catalog ` +
      `(first seen at ledger ${ev.ledger}, event ${ev.id}). The raw event is stored ` +
      `but no derived table was updated. Add its topic-symbol → data-tuple mapping ` +
      `to src/stellar/events.ts.`
  )
}

/** Test-only: forget which unknown symbols have already been warned about, so
 *  each test starts from a clean slate. */
export function resetUnknownSymbolWarningsForTest(): void {
  seenUnknownSymbols.clear()
}

/** Whether a symbol is present in the event catalog. */
export function isKnownSymbol(symbol: string): symbol is EventSymbol {
  return Object.prototype.hasOwnProperty.call(EVENT_FIELDS, symbol)
}

/** Decode one getEvents response entry into a JSON-safe DecodedEvent. */
export function decodeEvent(ev: rpc.Api.EventResponse): DecodedEvent {
  const evInfo = { id: ev.id, ledger: ev.ledger }
  let decodeError: string | null = null
  const topics: unknown[] = []
  
  ;(ev.topic ?? []).forEach((t, i) => {
    const res = safeNative(t, evInfo, `topic ${i}`)
    if (res.err && !decodeError) decodeError = res.err
    topics.push(res.val)
  })

  const symbol = typeof topics[0] === 'string' && topics[0] !== '' ? topics[0] : String(topics[0] ?? '')

  const dataRes = safeNative(ev.value, evInfo, 'data')
  if (dataRes.err && !decodeError) decodeError = dataRes.err
  const nativeValue = dataRes.val
  const data = Array.isArray(nativeValue) ? nativeValue : [nativeValue]

  const fields = namedFields(symbol, data)

  return {
    id: ev.id,
    ledger: ev.ledger,
    closedAt: ev.ledgerClosedAt,
    contractId: typeof ev.contractId === 'string' ? ev.contractId : (ev.contractId?.toString() ?? ''),
    txHash: ev.txHash ?? null,
    symbol,
    topics,
    data,
    fields,
    decodeError,
  }
}
