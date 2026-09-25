import type { PoolClient } from 'pg'
import { isKnownSymbol, warnUnknownSymbol, type DecodedEvent } from '../stellar/events.js'
import { notifyStreamClients, STREAM_CHANNELS, type StreamChannel } from '../api/stream.js'
import type { NotificationType } from '../types.js'

// Helpers ------------------------------------------------------------------
//
// `str`/`num`/`addr` below coerce a missing/malformed field into a plausible
// default ('0', null, ''). That's the right call for a genuinely optional
// field (weight, due_time, tx_hash) — but used on a field a derived row
// depends on, it turns "this event didn't decode" into "silently write a
// zero-amount row" or "UPDATE ... WHERE id = NULL", which commits and looks
// like legitimate data (issue #42). `requireAddr`/`requireId`/`requireAmount`/
// `requireBool` below are for exactly those required fields: they throw
// instead of coercing, so the transaction (whole-page or, once quarantined,
// single-event — see poller.ts) rolls back rather than writing a wrong row.

const str = (v: unknown): string => (v == null ? '0' : String(v))
const num = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const addr = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''))

/** Thrown by a handler when a field it needs to write a derived row failed to
 *  decode. Distinguishes "this event is malformed" from a transient DB/RPC
 *  error — see poller.ts's quarantine path, which is where this ultimately
 *  gets logged (with this event's id/symbol) and recorded. */
export class FieldValidationError extends Error {
  constructor(ev: DecodedEvent, field: string, reason: string) {
    super(`event ${ev.id} (${ev.symbol}): field "${field}" ${reason}`)
    this.name = 'FieldValidationError'
  }
}

function requireAddr(ev: DecodedEvent, field: string): string {
  const v = ev.fields[field]
  if (typeof v !== 'string' || v === '') {
    throw new FieldValidationError(ev, field, `must be a non-empty address string, got ${JSON.stringify(v)}`)
  }
  return v
}

function requireId(ev: DecodedEvent, field: string): number {
  const v = ev.fields[field]
  const n = Number(v)
  if (v == null || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw new FieldValidationError(ev, field, `must be a finite integer id, got ${JSON.stringify(v)}`)
  }
  return n
}

/** i128 amounts arrive as decimal-integer strings (bigints are stringified
 *  upstream in toJsonSafe) or, for small values, as a JS number. Never
 *  negative — every amount field here is a magnitude, not a signed delta. */
function requireAmount(ev: DecodedEvent, field: string): string {
  const v = ev.fields[field]
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : v
  if (typeof s !== 'string' || !/^\d+$/.test(s)) {
    throw new FieldValidationError(ev, field, `must be a non-negative decimal-integer amount, got ${JSON.stringify(v)}`)
  }
  return s
}

function requireBool(ev: DecodedEvent, field: string): boolean {
  const v = ev.fields[field]
  if (typeof v !== 'boolean') {
    throw new FieldValidationError(ev, field, `must be a boolean, got ${JSON.stringify(v)}`)
  }
  return v
}

// ourdao-contracts' ProposalKind (contracts/dao/src/storage.rs) is a
// fieldless enum — `Loan` or `Treasury`, no associated data. soroban-sdk's
// #[contracttype] derive encodes that as a Symbol carrying the variant name;
// depending on stellar-sdk version, scValToNative surfaces it as the bare
// string, a single-element array, or a `{ tag, values }` object. Handle all
// three rather than guessing one.
function normalizeProposalKind(v: unknown): 'loan' | 'treasury' | null {
  let tag: unknown = v
  if (Array.isArray(v)) tag = v[0]
  else if (v && typeof v === 'object' && 'tag' in v) tag = (v as { tag: unknown }).tag
  if (typeof tag !== 'string') return null
  const lower = tag.toLowerCase()
  return lower === 'loan' || lower === 'treasury' ? lower : null
}

function requireProposalKind(ev: DecodedEvent, field: string): 'loan' | 'treasury' {
  const kind = normalizeProposalKind(ev.fields[field])
  if (kind === null) {
    throw new FieldValidationError(ev, field, `must be a ProposalKind ("Loan"/"Treasury"), got ${JSON.stringify(ev.fields[field])}`)
  }
  return kind
}

async function notify(
  client: PoolClient,
  ev: DecodedEvent,
  address: string,
  type: NotificationType,
  title: string,
  message: string
): Promise<void> {
  if (!address) return
  await client.query(
    `INSERT INTO notifications (address, type, title, message, ledger, tx_hash, event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [address, type, title, message, ev.ledger, ev.txHash, ev.id]
  )
}

// Per-event handlers -------------------------------------------------------
// Each mutates derived tables for one decoded event. `f` is ev.fields.
//
// Rule of thumb (see issue #10): a handler must mirror the contract's own
// state transition for the field it's writing — assign where the contract
// assigns a fresh value onto the record, accumulate only where the contract
// itself accumulates. `joined` is the clearest example: register_member
// builds an entirely new `Member` record on every call, including a rejoin,
// so the indexer must overwrite rather than add. `claimed`'s `pending_claimed`
// is different on purpose — it's an indexer-only lifetime counter with no
// on-chain equivalent to mirror, so accumulating there is correct.

// Contract-published voting weight, once ourdao-contracts adds it to the vote
// events (see the linked issue there). Until then the field decodes as
// null/undefined and every vote counts as weight 1, same as before.
const weightOf = (f: Record<string, unknown>): string => (f.weight == null ? '1' : str(f.weight))

type Handler = (client: PoolClient, ev: DecodedEvent) => Promise<void>

const handlers: Record<string, Handler> = {
  async joined(client, ev) {
    const member = requireAddr(ev, 'member')
    const fee = requireAmount(ev, 'fee')
    // membership.rs::register_member stores a brand-new Member record on
    // every join, including a rejoin after exit — contribution is *set* to
    // the fee, never added to what was there before, and every other bit of
    // membership state (exited, exit_share, exited_ledger, has_active_loan)
    // starts fresh too. Mirror that exactly: overwrite, don't accumulate.
    await client.query(
      `INSERT INTO members (address, joined_ledger, contribution, exited, exit_share, exited_ledger, has_active_loan, updated_at)
       VALUES ($1, $2, $3, false, NULL, NULL, false, now())
       ON CONFLICT (address) DO UPDATE
         SET joined_ledger   = EXCLUDED.joined_ledger,
             contribution    = EXCLUDED.contribution,
             exited          = false,
             exit_share      = NULL,
             exited_ledger   = NULL,
             has_active_loan = false,
             updated_at      = now()`,
      [member, ev.ledger, fee]
    )
    await notify(client, ev, member, 'success', 'Welcome to OurDAO', 'Your membership is active.')
  },

  async exited(client, ev) {
    const member = requireAddr(ev, 'member')
    const share = requireAmount(ev, 'share')
    // Mirror the contract's exit_dao (issue #13): it zeroes the member's
    // stake (and decrements total_staked), and exit requires no active loan,
    // so the indexer row must reflect both. `pending_claimed` is left as-is
    // on purpose — it's an indexer-only *lifetime* counter of yield ever
    // claimed, with no on-chain equivalent to reset; the pending yield the
    // contract pays out on exit was already surfaced by its own `claimed`
    // events, so clearing the lifetime total here would lose history.
    await client.query(
      `UPDATE members
         SET exited = true, exit_share = $2, exited_ledger = $3,
             stake = 0, has_active_loan = false, updated_at = now()
       WHERE address = $1`,
      [member, share, ev.ledger]
    )
    await notify(client, ev, member, 'info', 'Membership ended', `You withdrew your share of ${share}.`)
  },

  async claimed(client, ev) {
    const member = requireAddr(ev, 'member')
    const pending = requireAmount(ev, 'pending')
    await client.query(
      `UPDATE members
         SET pending_claimed = pending_claimed + $2, updated_at = now()
       WHERE address = $1`,
      [member, pending]
    )
    await notify(client, ev, member, 'success', 'Yield claimed', `You claimed ${pending} in rewards.`)
  },

  async loan_req(client, ev) {
    const id = requireId(ev, 'id')
    const borrower = requireAddr(ev, 'borrower')
    const amount = requireAmount(ev, 'amount')
    const totalRepayment = requireAmount(ev, 'total_repayment')
    await client.query(
      `INSERT INTO loan_proposals (id, borrower, amount, total_repayment, status, created_ledger, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, now())
       ON CONFLICT (id) DO UPDATE
         SET amount = EXCLUDED.amount,
             total_repayment = EXCLUDED.total_repayment,
             updated_at = now()`,
      [id, borrower, amount, totalRepayment, ev.ledger]
    )
    await notify(client, ev, borrower, 'info', 'Loan requested', `Proposal #${id} is open for voting.`)
  },

  async loan_edit(client, ev) {
    const proposalId = requireId(ev, 'proposal_id')
    const newAmount = requireAmount(ev, 'new_amount')
    const totalRepayment = requireAmount(ev, 'total_repayment')
    await client.query(
      `UPDATE loan_proposals
         SET amount = $2, total_repayment = $3, updated_at = now()
       WHERE id = $1`,
      [proposalId, newAmount, totalRepayment]
    )
  },

  async loan_vote(client, ev) {
    const proposalId = requireId(ev, 'proposal_id')
    const support = requireBool(ev, 'support')
    const f = ev.fields
    const column = support ? 'votes_for' : 'votes_against'
    await client.query(
      `UPDATE loan_proposals
         SET ${column} = ${column} + $2, voter_count = voter_count + 1, updated_at = now()
       WHERE id = $1`,
      [proposalId, weightOf(f)]
    )
  },

  async loan_wait(client, ev) {
    const id = requireId(ev, 'id')
    // The proposal reached quorum but the treasury couldn't cover the
    // disbursement yet (loans.rs::vote_on_loan_proposal / approve_and_disburse)
    // — issue #125. A later permissionless `disburse_approved_loan` call
    // resolves this and republishes `loan_appr`, which the handler above
    // already folds unconditionally regardless of the proposal's prior
    // status. Guard on `pending` so a re-delivered `loan_wait` is a no-op.
    const updated = await client.query<{ borrower: string }>(
      `UPDATE loan_proposals SET status = 'approved_pending_disbursement', updated_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING borrower`,
      [id]
    )
    const borrower = updated.rows[0]?.borrower
    if (borrower) {
      await notify(
        client,
        ev,
        borrower,
        'info',
        'Loan approved, awaiting funds',
        `Proposal #${id} reached quorum but the treasury can't cover it yet — it will be disbursed once funds are available.`
      )
    }
  },

  async loan_rej(client, ev) {
    const id = requireId(ev, 'id')
    // Early rejection from inside the same vote call as loan_wait above, when
    // the votes still outstanding can no longer mathematically reach quorum
    // (issue #124) — distinct from loan_exp's permissionless-keeper path
    // below. Guard on `pending` so a re-delivered `loan_rej` is a no-op.
    const updated = await client.query<{ borrower: string }>(
      `UPDATE loan_proposals SET status = 'rejected', updated_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING borrower`,
      [id]
    )
    const borrower = updated.rows[0]?.borrower
    if (borrower) {
      await notify(
        client,
        ev,
        borrower,
        'warning',
        'Loan proposal rejected',
        `Proposal #${id} could no longer reach quorum and was rejected.`
      )
    }
  },

  async loan_appr(client, ev) {
    const f = ev.fields
    const id = requireId(ev, 'id')
    const borrower = requireAddr(ev, 'borrower')
    const amount = requireAmount(ev, 'amount')
    await client.query(
      `UPDATE loan_proposals SET status = 'approved', updated_at = now() WHERE id = $1`,
      [id]
    )
    // `loan_appr` only carries the disbursed principal, not the repayment
    // total — outstanding debt from day one is total_repayment (principal +
    // interest), not the principal alone (issue #11). ourdao-contracts
    // doesn't publish total_repayment on this event, but `loan.id ==
    // proposal.id` is a documented invariant, so the just-approved proposal
    // row (already carrying total_repayment from `loan_req`/`loan_edit`) is
    // a reliable interim source. This depends on that proposal row existing,
    // which it will unless the indexer started mid-history.
    const proposal = await client.query<{ total_repayment: string }>(
      `SELECT total_repayment FROM loan_proposals WHERE id = $1`,
      [id]
    )
    const totalRepayment = proposal.rows[0]?.total_repayment ?? amount
    // due_time is a unix-seconds timestamp on the contract side; convert for
    // the TIMESTAMPTZ column. Always null today since the event doesn't
    // carry it yet (see the comment on EVENT_FIELDS.loan_appr) — genuinely
    // optional, so it keeps the coercion-friendly reading.
    const dueTime = f.due_time == null ? null : new Date(Number(f.due_time) * 1000)
    const loanIns = await client.query<{ is_new: boolean }>(
      `INSERT INTO loans (id, borrower, amount, total_repayment, outstanding, status, approved_ledger, due_time, updated_at)
       VALUES ($1, $2, $3, $4, $4, 'active', $5, $6, now())
       ON CONFLICT (id) DO UPDATE
         SET status = 'active', approved_ledger = EXCLUDED.approved_ledger, updated_at = now()
       RETURNING (xmax = 0) AS is_new`,
      [id, borrower, amount, totalRepayment, ev.ledger, dueTime]
    )
    // Fold principal lent once per loan (issue #24). `xmax = 0` is true only
    // when this was a fresh INSERT, not the ON CONFLICT UPDATE branch — so a
    // re-delivered `loan_appr` doesn't double-count.
    if (loanIns.rows[0]?.is_new) {
      await client.query(
        `UPDATE dao_totals SET principal_lent = principal_lent + $1, updated_at = now() WHERE id = 1`,
        [amount]
      )
    }
    await client.query(
      `UPDATE members SET has_active_loan = true WHERE address = $1`,
      [borrower]
    )
    await notify(client, ev, borrower, 'success', 'Loan approved', `Loan #${id} of ${amount} was approved.`)
  },

  async loan_rpy(client, ev) {
    const loanId = requireId(ev, 'loan_id')
    const borrower = requireAddr(ev, 'borrower')
    const outstanding = requireAmount(ev, 'outstanding')
    const status = outstanding === '0' ? 'repaid' : 'active'
    // `FROM loans AS prev` captures the pre-update row so we can tell whether
    // this repayment is the one that clears the loan (issue #24: fold the
    // principal into `principal_repaid` exactly once — a re-delivered final
    // `loan_rpy` finds `prev.status = 'repaid'` and is skipped).
    const upd = await client.query<{ amount: string; was_repaid: boolean }>(
      `UPDATE loans AS l
         SET outstanding = $2, status = $3,
             repaid_ledger = CASE WHEN $3 = 'repaid' THEN $4 ELSE l.repaid_ledger END,
             updated_at = now()
       FROM loans AS prev
       WHERE l.id = $1 AND prev.id = $1
       RETURNING l.amount::text AS amount, (prev.status = 'repaid') AS was_repaid`,
      [loanId, outstanding, status, ev.ledger]
    )
    const loan = upd.rows[0]
    if (status === 'repaid' && loan && !loan.was_repaid) {
      await client.query(
        `UPDATE dao_totals SET principal_repaid = principal_repaid + $1, updated_at = now() WHERE id = 1`,
        [loan.amount]
      )
    }
    if (status === 'repaid') {
      await client.query(`UPDATE members SET has_active_loan = false WHERE address = $1`, [borrower])
    }
    const type: NotificationType = status === 'repaid' ? 'success' : 'info'
    const msg = status === 'repaid' ? `Loan #${loanId} is fully repaid.` : `Repayment received; ${outstanding} remaining.`
    await notify(client, ev, borrower, type, 'Loan repayment', msg)
  },

  async loan_dflt(client, ev) {
    const id = requireId(ev, 'loan_id')
    const borrower = requireAddr(ev, 'borrower')
    const penalty = requireAmount(ev, 'penalty')
    // Guard on the loan's own status rather than trusting the poll loop
    // never redelivers a page (it can — see the event re-delivery issue in
    // this repo). `loans.rs::mark_loan_defaulted` only ever transitions a
    // loan out of `Active` once, so re-running this UPDATE for an
    // already-defaulted loan is a no-op (`rowCount === 0`), and that's the
    // signal used below to skip re-applying the penalty and re-notifying.
    const updated = await client.query<{ outstanding: string }>(
      `UPDATE loans SET status = 'defaulted', defaulted_ledger = $2, updated_at = now()
       WHERE id = $1 AND status <> 'defaulted'
       RETURNING outstanding::text AS outstanding`,
      [id, ev.ledger]
    )
    if (updated.rowCount === 0) return

    // The status guard above already makes this fold idempotent (issue #24):
    // value defaulted is the loan's outstanding balance at the moment it
    // defaulted.
    await client.query(
      `UPDATE dao_totals SET value_defaulted = value_defaulted + $1, updated_at = now() WHERE id = 1`,
      [updated.rows[0]?.outstanding ?? '0']
    )

    await client.query(
      `UPDATE members
         SET contribution    = GREATEST(contribution - $2, 0),
             has_active_loan = false,
             defaults_count  = defaults_count + 1,
             updated_at      = now()
       WHERE address = $1`,
      [borrower, penalty]
    )
    await notify(
      client,
      ev,
      borrower,
      'error',
      'Loan defaulted',
      `Loan #${id} was marked defaulted; a penalty of ${penalty} was applied to your contribution.`
    )
  },

  async loan_exp(client, ev) {
    const proposalId = requireId(ev, 'proposal_id')
    const borrower = requireAddr(ev, 'borrower')
    // Guard on `status = 'pending'` so a re-delivered `loan_exp` event is a clean no-op.
    const updated = await client.query(
      `UPDATE loan_proposals SET status = 'rejected', updated_at = now() WHERE id = $1 AND status = 'pending'`,
      [proposalId]
    )
    if (updated.rowCount === 0) return

    await notify(
      client,
      ev,
      borrower,
      'warning',
      'Loan proposal expired',
      `Proposal #${proposalId} expired without reaching quorum.`
    )
  },

  async interest(client, ev) {
    // Interest distribution carries no per-member breakdown, so there is still
    // nothing to attribute (per-member yield is surfaced via `claimed`). But
    // the aggregate it *does* carry is the DAO's revenue line — fold it into
    // the distribution history and the lifetime total (issue #24).
    //
    // `f.interest` is interest *collected*: distribute_interest divides it by
    // active members and the indivisible remainder stays in the treasury, so
    // this is slightly more than what members were credited. `f.active` is the
    // active-member count at this distribution — genuinely optional (a nullable
    // column, no row depends on it), kept so per-member share is derivable
    // historically when present.
    //
    // Idempotent on the raw event id: a re-delivered `interest` event does not
    // double-count (ON CONFLICT DO NOTHING + the rowCount guard).
    const f = ev.fields
    const amount = requireAmount(ev, 'interest')
    const inserted = await client.query(
      `INSERT INTO interest_distributions (event_id, ledger, amount, active_members, tx_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id) DO NOTHING`,
      [ev.id, ev.ledger, amount, num(f.active), ev.txHash]
    )
    if (inserted.rowCount === 1) {
      await client.query(
        `UPDATE dao_totals
            SET interest_collected = interest_collected + $1, updated_at = now()
          WHERE id = 1`,
        [amount]
      )
    }
  },

  async tre_prop(client, ev) {
    const f = ev.fields
    const id = requireId(ev, 'id')
    const amount = requireAmount(ev, 'amount')
    const destination = requireAddr(ev, 'destination')
    await client.query(
      `INSERT INTO treasury_proposals (id, amount, destination, private, status, created_ledger, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, now())
       ON CONFLICT (id) DO UPDATE
         SET amount = EXCLUDED.amount, destination = EXCLUDED.destination,
             private = EXCLUDED.private, updated_at = now()`,
      [id, amount, destination, f.private === true, ev.ledger]
    )
  },

  async tre_vote(client, ev) {
    const id = requireId(ev, 'id')
    const support = requireBool(ev, 'support')
    const f = ev.fields
    const column = support ? 'votes_for' : 'votes_against'
    await client.query(
      `UPDATE treasury_proposals
         SET ${column} = ${column} + $2, voter_count = voter_count + 1, updated_at = now()
       WHERE id = $1`,
      [id, weightOf(f)]
    )
  },

  async tre_wait(client, ev) {
    const id = requireId(ev, 'id')
    // Treasury equivalent of loan_wait above (issue #125) — reached quorum
    // but `execute` failed because the treasury can't cover it yet. A later
    // `execute_treasury_proposal` call resolves this and republishes
    // `tre_exec`, folded unconditionally by the handler below.
    const updated = await client.query<{ destination: string }>(
      `UPDATE treasury_proposals SET status = 'approved_pending_disbursement', updated_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING destination`,
      [id]
    )
    const destination = updated.rows[0]?.destination
    if (destination) {
      await notify(
        client,
        ev,
        destination,
        'info',
        'Treasury withdrawal approved, awaiting funds',
        `Proposal #${id} reached quorum but the treasury can't cover it yet — it will execute once funds are available.`
      )
    }
  },

  async tre_rej(client, ev) {
    const id = requireId(ev, 'id')
    // Treasury equivalent of loan_rej above (issue #124).
    const updated = await client.query<{ destination: string }>(
      `UPDATE treasury_proposals SET status = 'rejected', updated_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING destination`,
      [id]
    )
    const destination = updated.rows[0]?.destination
    if (destination) {
      await notify(
        client,
        ev,
        destination,
        'warning',
        'Treasury proposal rejected',
        `Proposal #${id} could no longer reach quorum and was rejected.`
      )
    }
  },

  async tre_exec(client, ev) {
    const id = requireId(ev, 'id')
    const destination = requireAddr(ev, 'destination')
    const f = ev.fields
    await client.query(
      `UPDATE treasury_proposals
         SET status = 'executed', executed_ledger = $2, updated_at = now()
       WHERE id = $1`,
      [id, ev.ledger]
    )
    await notify(client, ev, destination, 'success', 'Treasury withdrawal executed', `${str(f.amount)} was sent to your address.`)
  },

  async staked(client, ev) {
    // UPDATE only, never INSERT (issue #14). The contract requires membership
    // to stake, but this indexer can't enforce that guarantee, and a read
    // model shouldn't materialise a member row just because an event named an
    // address. A `staked` for an unknown address is still in the raw `events`
    // log; it just doesn't create a phantom member. Same reasoning as
    // `name_reg`, and identical to `unstaked` now.
    const member = requireAddr(ev, 'member')
    const newStake = requireAmount(ev, 'new_stake')
    await client.query(
      `UPDATE members SET stake = $2, updated_at = now() WHERE address = $1`,
      [member, newStake]
    )
  },

  async unstaked(client, ev) {
    const member = requireAddr(ev, 'member')
    const newStake = requireAmount(ev, 'new_stake')
    await client.query(
      `UPDATE members SET stake = $2, updated_at = now() WHERE address = $1`,
      [member, newStake]
    )
  },

  async name_reg(client, ev) {
    // UPDATE only, never INSERT (issue #14). The contract's register_name
    // authorizes the caller but does *not* check membership, unlike every
    // other member-facing entrypoint — so anyone on the network can register
    // a name. Upserting here let a non-member insert itself into `members`
    // (contribution 0, joined_ledger NULL) and be served by /api/members and
    // counted by /api/stats. The name is still recorded in the raw `events`
    // log; it just no longer creates a member.
    //
    // Ordering edge case: if `name_reg` somehow arrives before the `joined`
    // event for the same address (possible only on a cold start whose start
    // ledger was clamped past the join), this UPDATE is a no-op and the name
    // is lost. We accept that rather than carry a pending-names side table:
    // `register_member` builds a fresh Member record on join and the name is
    // re-registrable at any time, so the fix is a re-register, and the raw
    // event is retained regardless.
    const owner = requireAddr(ev, 'owner')
    const f = ev.fields
    await client.query(
      `UPDATE members SET name = $2, updated_at = now() WHERE address = $1`,
      [owner, typeof f.name === 'string' ? f.name : String(f.name ?? '')]
    )
  },

  async committed(client, ev) {
    const f = ev.fields
    await notify(client, ev, addr(f.voter), 'info', 'Private vote committed', `Your commitment for proposal #${str(f.proposal_id)} was recorded.`)
  },

  async doc_attn(client, ev) {
    // Existence/history of a proposal's attached documents (issue #44) — not
    // the content hash, which stays read live from the contract via
    // get_document (see the README's Event catalog). Doesn't touch
    // loan_proposals/treasury_proposals: the contract already validated
    // proposal_exists before publishing this event, and this handler has no
    // reason to materialize or check a proposal row for it.
    const proposalId = requireId(ev, 'proposal_id')
    const caller = requireAddr(ev, 'caller')
    const kind = requireProposalKind(ev, 'kind')
    await client.query(
      `INSERT INTO documents (event_id, proposal_id, kind, caller, ledger, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_id) DO NOTHING`,
      [ev.id, proposalId, kind, caller, ev.ledger, ev.txHash]
    )
  },

  async revealed(client, ev) {
    // A revealed commit-reveal ballot counts like a treasury vote.
    const proposalId = requireId(ev, 'proposal_id')
    const support = requireBool(ev, 'support')
    const f = ev.fields
    const column = support ? 'votes_for' : 'votes_against'
    await client.query(
      `UPDATE treasury_proposals
         SET ${column} = ${column} + $2, voter_count = voter_count + 1, updated_at = now()
       WHERE id = $1`,
      [proposalId, weightOf(f)]
    )
  },
}

/** Apply one decoded event's side effects. Unknown symbols are a no-op
 *  (the raw event is still persisted by the caller). */
export async function applyEvent(client: PoolClient, ev: DecodedEvent): Promise<void> {
  // A symbol the catalog doesn't know is a deliberate no-op (raw event already
  // stored by the caller) — but announce it once so a new contract event
  // can't quietly leave derived state incomplete (issue #39).
  if (!isKnownSymbol(ev.symbol)) warnUnknownSymbol(ev)

  const handler = handlers[ev.symbol]
  if (handler) await handler(client, ev)

  // Emit NOTIFY for stream subscribers (issue #63)
  // Map event symbols to stream channels
  const channelMap: Record<string, StreamChannel> = {
    joined: STREAM_CHANNELS.members,
    exited: STREAM_CHANNELS.members,
    staked: STREAM_CHANNELS.members,
    unstaked: STREAM_CHANNELS.members,
    claimed: STREAM_CHANNELS.members,
    
    loan_req: STREAM_CHANNELS.loan_proposals,
    loan_edit: STREAM_CHANNELS.loan_proposals,
    loan_vote: STREAM_CHANNELS.loan_proposals,
    loan_wait: STREAM_CHANNELS.loan_proposals,
    loan_rej: STREAM_CHANNELS.loan_proposals,
    loan_appr: STREAM_CHANNELS.loan_proposals,
    loan_exp: STREAM_CHANNELS.loan_proposals,
    loan_reject: STREAM_CHANNELS.loan_proposals,
    loan_disburse: STREAM_CHANNELS.loans,
    loan_repay: STREAM_CHANNELS.loans,
    loan_default: STREAM_CHANNELS.loans,

    treasury_req: STREAM_CHANNELS.treasury_proposals,
    treasury_vote: STREAM_CHANNELS.treasury_proposals,
    treasury_appr: STREAM_CHANNELS.treasury_proposals,
    treasury_reject: STREAM_CHANNELS.treasury_proposals,
    tre_wait: STREAM_CHANNELS.treasury_proposals,
    tre_rej: STREAM_CHANNELS.treasury_proposals,

    interest: STREAM_CHANNELS.interest,
  }

  const channel = channelMap[ev.symbol]
  if (channel) {
    await notifyStreamClients(client, channel, {
      symbol: ev.symbol,
      ledger: ev.ledger,
      timestamp: Date.now(),
    })
  }
}
