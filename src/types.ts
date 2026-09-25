// Domain types for the indexed off-chain view of the OurDAO contract.
// These mirror the shapes the frontend (ourdao-frontend/src/types/dao.ts)
// consumes, but represent large integers as strings so they survive JSON.

// The complete set of values each status column may hold, in one place (#73).
// The database CHECK constraints — inline in src/db/schema.sql and added to
// existing databases by src/db/migrations/0012_status_check_constraints.sql —
// must accept exactly these, and test/status-constraints.test.ts fails if the
// two drift. `'cancelled'` is a declared loan-proposal state that no handler
// writes yet; it is kept deliberately (the loan_exp work will use it for
// expired proposals) rather than dropped.
export const LOAN_PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const
export const LOAN_STATUSES = ['active', 'repaid', 'defaulted'] as const
export const TREASURY_PROPOSAL_STATUSES = ['pending', 'executed', 'rejected'] as const

export type LoanProposalStatus = (typeof LOAN_PROPOSAL_STATUSES)[number]
export type LoanStatus = (typeof LOAN_STATUSES)[number]
export type TreasuryProposalStatus = (typeof TREASURY_PROPOSAL_STATUSES)[number]

export interface MemberRow {
  address: string
  joined_ledger: number | null
  contribution: string
  exited: boolean
  exit_share: string | null
  exited_ledger: number | null
  pending_claimed: string
  stake: string
  has_active_loan: boolean
  name: string | null
  defaults_count: number
  updated_at: string
}

export interface MemberSummary {
  member: MemberRow
  // Capped at LOANS_EMBED_LIMIT (issue #165) — loans_truncated is true when
  // the member has more than that; the full history is paginated separately
  // via GET /api/loans?borrower=<address>. The aggregate counts in
  // `position` below are computed over ALL of the member's loans regardless
  // of this cap, never just the embedded page.
  loans: (LoanRow & { interest_charge: string; repaid_amount: string })[]
  loans_total_count: number
  loans_truncated: boolean
  unread_notifications: number
  position: {
    // Share of currently-active total contribution/stake (issue #164) —
    // matches ourdao-contracts' calculate_exit_share, which is 0 for any
    // non-active member and otherwise contribution / total_active_contributions.
    contribution_share_bps: string
    stake_share_bps: string
    repaid_loans_count: number
    defaulted_loans_count: number
    defaulted_loans_value: string
  }
}

export interface LoanProposalRow {
  id: number
  borrower: string
  amount: string
  total_repayment: string
  status: LoanProposalStatus
  // Stake-weighted voting power (matches the contract's i128 for_votes /
  // against_votes), not a headcount — see voter_count for that.
  votes_for: string
  votes_against: string
  voter_count: number
  tallies_weighted: boolean
  created_ledger: number | null
  updated_at: string
}

export interface LoanRow {
  id: number
  borrower: string
  amount: string
  outstanding: string
  total_repayment: string
  status: LoanStatus
  approved_ledger: number | null
  due_time: string | null
  repaid_ledger: number | null
  defaulted_ledger: number | null
  updated_at: string
}

export interface TreasuryProposalRow {
  id: number
  amount: string
  destination: string
  private: boolean
  status: TreasuryProposalStatus
  votes_for: string
  votes_against: string
  voter_count: number
  tallies_weighted: boolean
  created_ledger: number | null
  executed_ledger: number | null
  updated_at: string
}

export type NotificationType = 'success' | 'error' | 'warning' | 'info'

export interface NotificationRow {
  id: number
  address: string
  type: NotificationType
  title: string
  message: string
  ledger: number | null
  tx_hash: string | null
  read: boolean
  created_at: string
}

export interface EventRow {
  id: string
  ledger: number
  closed_at: string
  contract_id: string
  symbol: string
  topics: unknown
  data: unknown
  tx_hash: string | null
  decode_error: string | null
  created_at: string
}

/** One event on a per-entity timeline (issue #26): a raw `events` row decoded
 *  into its named fields via the `EVENT_FIELDS` catalog, so a client reads
 *  `fields.amount` instead of re-deriving the data tuple's shape. */
export interface TimelineEntry {
  /** Soroban event paging id (globally unique, encodes ledger + index). */
  id: string
  /** First topic, e.g. `loan_vote`. */
  symbol: string
  ledger: number
  /** Ledger close time (ISO 8601). */
  timestamp: string
  tx_hash: string | null
  /** Named view of the event's data tuple; `{}` for an uncatalogued symbol. */
  fields: Record<string, unknown>
}

export interface InterestDistributionRow {
  id: number
  ledger: number
  amount: string
  active_members: number | null
  tx_hash: string | null
  created_at: string
}

export type ProposalKind = 'loan' | 'treasury'

export interface DocumentRow {
  id: number
  proposal_id: number
  kind: ProposalKind
  caller: string
  ledger: number
  tx_hash: string | null
  attached_at: string
}

export interface FailedEventRow {
  id: number
  event_id: string
  symbol: string
  ledger: number
  error: string
  created_at: string
}

export interface DAOStats {
  totalMembers: number
  activeMembers: number
  totalLoanProposals: number
  totalLoans: number
  activeLoans: number
  defaultedLoans: number
  totalDefaultedValue: string
  totalTreasuryProposals: number
  totalStaked: string
  // Lifetime money figures (issue #24), as decimal strings like every other
  // on-chain amount. `interestCollected` is interest the treasury took in;
  // the amount actually credited to members is slightly less because the
  // contract keeps the indivisible division remainder.
  interestCollected: string
  principalLent: string
  principalRepaid: string
  valueDefaulted: string
  // Quarantined-event count (issue #43) — a handler that deterministically
  // throws no longer wedges the indexer forever; this is the "we quarantined
  // N events" signal a dashboard needs so that isn't invisible.
  quarantinedEvents: number
  // `lastIndexedLedger` is the highest ledger actually folded; `observedTipLedger`
  // is the RPC's most recently observed chain tip (issue #45) — "folded to X,
  // chain is at Y" is the useful pair for gauging indexer lag.
  lastIndexedLedger: number | null
  observedTipLedger: number | null
  /** Number of ledgers the indexer is behind the chain tip. null when unknown (cold start). */
  ledgersBehind: number | null
  /** Estimated wall-clock lag in seconds (ledgersBehind * ~5s). null when unknown. */
  estimatedLagSeconds: number | null
  secondsSinceUpdate: number | null
  indexerStale: boolean
}
