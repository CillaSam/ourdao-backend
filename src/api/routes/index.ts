import type { FastifyInstance } from 'fastify'
import { StrKey } from '@stellar/stellar-sdk'
import { query, queryOne } from '../../db/index.js'
import { config } from '../../config.js'
import {
  ADMIN_EVENT_SYMBOLS,
  LOAN_TIMELINE_SYMBOLS,
  TREASURY_TIMELINE_SYMBOLS,
  MEMBER_ACTIVITY_SYMBOLS,
  namedFields,
} from '../../stellar/events.js'
import type {
  DAOStats,
  LoanProposalRow,
  LoanRow,
  MemberRow,
  MemberSummary,
  NotificationRow,
  TreasuryProposalRow,
  EventRow,
  InterestDistributionRow,
  DocumentRow,
  FailedEventRow,
  TimelineEntry,
} from '../../types.js'
import { authenticateRequest, classifyStellarAddress, type NonceStore } from '../../auth.js'

function parseLimit(v: unknown, def = 50, max = 200): number | null {
  if (v === undefined || v === null || v === '') return def
  const raw = String(v).trim()
  if (!/^[0-9]+$/.test(raw)) return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) return null
  return n
}

function invalidLimit(v: unknown, def = 50, max = 200): boolean {
  return parseLimit(v, def, max) === null
}

// Issue #165: how many of a member's loans /members/:address/summary embeds
// inline. The full history is always available, paginated, from
// GET /api/loans?borrower=<address> — this cap only bounds the size of the
// summary payload itself. Named so the LIMIT and the has-more comparison
// it's checked against can never drift apart.
const LOANS_EMBED_LIMIT = 100

// Small helper: clamp a `limit` query param to a sane range.
function limit(v: unknown, def = 50, max = 200): number {
  return parseLimit(v, def, max) ?? def
}

// Parse an optional numeric pagination cursor (e.g. `?before=`). Returns null
// when absent or invalid, meaning "start from the newest row."
function cursor(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const raw = String(v).trim()
  if (!/^[0-9]+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function invalidCursor(v: unknown): boolean {
  return v !== undefined && cursor(v) === null
}

function eventCursor(v: unknown): { ledger: number, id?: string } | null {
  if (v === undefined || v === null || v === '') return null
  const raw = String(v).trim()
  if (/^[0-9]+-[0-9]+$/.test(raw)) {
    const ledger = Number(raw.split('-')[0])
    return { ledger, id: raw }
  }
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? { ledger: n } : null
}

function invalidEventCursor(v: unknown): boolean {
  return v !== undefined && eventCursor(v) === null
}

function validAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address)
}

// Validate a positive integer path param (loan / proposal id). Returns the
// trimmed decimal string on success (kept as a string so it compares
// directly against the JSONB-extracted `data->>0`), or null.
function entityIdParam(v: string): string | null {
  const raw = v.trim()
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) return null
  return raw
}

// Decode one raw `events` row into a timeline entry (issue #26): named fields
// via the EVENT_FIELDS catalog rather than the raw positional tuple, so a
// client doesn't reimplement the decoder.
function toTimelineEntry(row: EventRow): TimelineEntry {
  const data = Array.isArray(row.data) ? (row.data as unknown[]) : []
  return {
    id: row.id,
    symbol: row.symbol,
    ledger: row.ledger,
    timestamp: row.closed_at,
    tx_hash: row.tx_hash,
    fields: namedFields(row.symbol, data),
  }
}

// A single loan / treasury proposal produces a bounded lifecycle (a request,
// an approval, an execution, and one vote per member), but "one vote per
// member" is only bounded by the membership size — so cap the timeline query
// defensively rather than leaving it unbounded. Comfortably above any real
// DAO's per-proposal event count; a client that hits it can page /api/events.
const TIMELINE_MAX_ROWS = 2000

// Shared implementation for the two per-entity timeline endpoints. `symbols`
// is the lifecycle set for the entity family; the id is matched against the
// first `data` tuple entry (`data->>0`), which every symbol in these sets
// carries — see LOAN_TIMELINE_SYMBOLS / TREASURY_TIMELINE_SYMBOLS.
async function entityTimeline(symbols: readonly string[], id: string): Promise<TimelineEntry[]> {
  const rows = await query<EventRow>(
    `SELECT * FROM events
       WHERE symbol = ANY($1) AND data->>0 = $2
       ORDER BY ledger ASC, id ASC
       LIMIT $3`,
    [symbols as string[], id, TIMELINE_MAX_ROWS]
  )
  return rows.map(toTimelineEntry)
}

// A loan's interest charge and repayment progress aren't stored columns —
// both derive from total_repayment, which issue #11 added — so compute them
// at read time rather than duplicating state that could drift out of sync.
// BigInt (not Number) because these are NUMERIC(40,0) decimal strings that
// can exceed Number.MAX_SAFE_INTEGER.
function withLoanDerived(loan: LoanRow): LoanRow & { interest_charge: string; repaid_amount: string } {
  const totalRepayment = BigInt(loan.total_repayment)
  const amount = BigInt(loan.amount)
  const outstanding = BigInt(loan.outstanding)
  return {
    ...loan,
    interest_charge: (totalRepayment - amount).toString(),
    repaid_amount: (totalRepayment - outstanding).toString(),
  }
}

export async function registerRoutes(app: FastifyInstance, opts: { nonceStore: NonceStore }): Promise<void> {
  const { nonceStore } = opts
  
  // --- Authentication challenge (issue #65) ---
  // Stricter rate limit on this endpoint to prevent DoS attacks
  app.get<{ Querystring: { address: string } }>('/auth/challenge', {
    config: {
      rateLimit: {
        max: config.http.rateLimitEventsMax, // Use the same stricter limit as /events
        timeWindow: config.http.rateLimitWindowMs,
      },
    },
  }, async (req, reply) => {
    const { address } = req.query
    if (!address) {
      return reply.code(400).send({ error: 'address query param is required' })
    }
    
    // Validate address is a well-formed Stellar address (issue #65). Accept
    // both families verifySignature can resolve — ed25519 and muxed (issue
    // #116) — and reject contract (C…) and anything malformed.
    const addressType = classifyStellarAddress(address)
    if (addressType !== 'ed25519' && addressType !== 'muxed') {
      return reply.code(400).send({ error: 'invalid Stellar address' })
    }

    try {
      const nonce = await nonceStore.issue(address)
      return { nonce }
    } catch (error) {
      // Nonce store capacity exceeded
      return reply.code(503).send({ error: 'Service temporarily unavailable' })
    }
  })
  
  // --- Members ---
  // `joined_ledger IS NOT NULL` filters out phantom rows — an address that
  // only ever appeared in a `name_reg`/`staked` event and never actually
  // joined the DAO (issue #14). A real member always has a join ledger.
  app.get('/members', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=5, must-revalidate')
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    return query<MemberRow>(
      `SELECT * FROM members
        WHERE exited = false AND joined_ledger IS NOT NULL
        ORDER BY joined_ledger DESC NULLS LAST LIMIT $1`,
      [l]
    )
  })

  app.get<{ Params: { address: string } }>('/members/:address', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=5, must-revalidate')
    if (!validAddress(req.params.address)) {
      return reply.code(400).send({ error: 'invalid Stellar address' })
    }
    const m = await queryOne<MemberRow>('SELECT * FROM members WHERE address = $1', [req.params.address])
    if (!m) return reply.code(404).send({ error: 'member not found' })
    return m
  })

  app.get<{ Params: { address: string } }>('/members/:address/summary', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-cache')
    if (!validAddress(req.params.address)) {
      return reply.code(400).send({ error: 'invalid Stellar address' })
    }

    const summary = await queryOne<{ summary: MemberSummary }>(`
      WITH m AS (
        SELECT * FROM members WHERE address = $1
      ),
      totals AS (
        -- Issue #164: both denominators must match the contract's own
        -- definition of a member's claim. calculate_exit_share() in
        -- ourdao-contracts (contracts/dao/src/membership.rs) computes
        -- treasury * contribution / total_active_contributions, where
        -- total_active_contributions sums 'contribution' only over members
        -- with MemberStatus::ActiveMember — the same exited = false this
        -- table already (correctly) uses for total_stake, and for
        -- active_members/total_staked in /api/stats. contribution_share_bps
        -- is therefore a member's share of *currently active* contribution,
        -- matching what the contract would actually pay on exit, not a
        -- share of every contribution ever made including exited members'.
        SELECT
          (SELECT COALESCE(SUM(contribution), 0) FROM members WHERE exited = false) as total_contribution,
          (SELECT COALESCE(SUM(stake), 0) FROM members WHERE exited = false) as total_stake
      ),
      unread_notifs AS (
        SELECT COUNT(*) as unread_count FROM notifications WHERE address = $1 AND read = false
      ),
      -- Issue #165: aggregates run over the member's *entire* loan history —
      -- independent of ${LOANS_EMBED_LIMIT}, the cap on the embedded list
      -- below — so a long-tenured member's repaid/defaulted counts and
      -- defaulted value are never silently wrong just because they have
      -- more than ${LOANS_EMBED_LIMIT} loans.
      member_loans_agg AS (
        SELECT COUNT(*) as total_count,
               COUNT(*) FILTER (WHERE status = 'repaid') as repaid_loans_count,
               COUNT(*) FILTER (WHERE status = 'defaulted') as defaulted_loans_count,
               COALESCE(SUM(outstanding) FILTER (WHERE status = 'defaulted'), 0) as defaulted_loans_value
        FROM loans WHERE borrower = $1
      ),
      -- The embedded list itself stays capped at ${LOANS_EMBED_LIMIT} (full
      -- history is available, paginated, from GET /api/loans?borrower=) but
      -- now with an explicit column list instead of SELECT *, and the
      -- truncation is now visible via loans_total_count/loans_truncated
      -- below rather than silent.
      member_loans_embed AS (
        SELECT COALESCE(json_agg(row_to_json(l)), '[]'::json) as loans
        FROM (
          SELECT id, borrower, amount, outstanding, total_repayment, status,
                 approved_ledger, due_time, repaid_ledger, defaulted_ledger, updated_at
          FROM loans WHERE borrower = $1 ORDER BY id DESC LIMIT ${LOANS_EMBED_LIMIT}
        ) l
      )
      SELECT
        json_build_object(
          'member', row_to_json(m.*),
          'loans', (SELECT loans FROM member_loans_embed),
          'loans_total_count', (SELECT total_count::int FROM member_loans_agg),
          'loans_truncated', (SELECT total_count > ${LOANS_EMBED_LIMIT} FROM member_loans_agg),
          'unread_notifications', (SELECT unread_count::int FROM unread_notifs),
          'position', json_build_object(
            'contribution_share_bps', CASE
              WHEN (SELECT total_contribution FROM totals) > 0 AND m.exited = false
              THEN TRUNC((m.contribution * 10000) / (SELECT total_contribution FROM totals))::text
              ELSE '0'
            END,
            'stake_share_bps', CASE
              WHEN (SELECT total_stake FROM totals) > 0 AND m.exited = false
              THEN TRUNC((m.stake * 10000) / (SELECT total_stake FROM totals))::text
              ELSE '0'
            END,
            'repaid_loans_count', COALESCE((SELECT repaid_loans_count::int FROM member_loans_agg), 0),
            'defaulted_loans_count', COALESCE((SELECT defaulted_loans_count::int FROM member_loans_agg), 0),
            'defaulted_loans_value', COALESCE((SELECT defaulted_loans_value FROM member_loans_agg), 0)::text
          )
        ) as summary
      FROM m
    `, [req.params.address])

    if (!summary || !summary.summary) return reply.code(404).send({ error: 'member not found' })

    const result = summary.summary
    if (result.loans && Array.isArray(result.loans)) {
      result.loans = result.loans.map(withLoanDerived)
    }

    return result
  })

  // --- A member's cross-entity activity feed (issue #26) ---
  // The obvious sibling of the per-loan / per-proposal timelines: every event
  // that names this address as a participant, newest first, across joins,
  // stakes, loans and votes. Matches the address in any position of the
  // JSONB `data` tuple (it sits at a different offset per symbol) and
  // restricts to MEMBER_ACTIVITY_SYMBOLS so an address that only appears as
  // e.g. a treasury `destination` doesn't show up here. `?before=<ledger>`
  // cursor, like the other historical feeds.
  app.get<{ Params: { address: string } }>('/members/:address/activity', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=5, must-revalidate')
    if (!validAddress(req.params.address)) {
      return reply.code(400).send({ error: 'invalid Stellar address' })
    }
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const before = cursor(q.before)
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })

    const params: unknown[] = [MEMBER_ACTIVITY_SYMBOLS as unknown as string[], req.params.address]
    let where = `WHERE symbol = ANY($1) AND data @> to_jsonb($2::text)`
    if (before !== null) {
      params.push(before)
      where += ` AND ledger < $${params.length}`
    }
    params.push(l)
    const rows = await query<EventRow>(
      `SELECT * FROM events ${where} ORDER BY ledger DESC, id DESC LIMIT $${params.length}`,
      params
    )
    return { activity: rows.map(toTimelineEntry) }
  })

  // --- Loan proposals ---
  app.get('/proposals/loan', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=5, must-revalidate')
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    return query<LoanProposalRow>('SELECT * FROM loan_proposals ORDER BY id DESC LIMIT $1', [l])
  })

  // --- Loans (optional ?borrower= filter, ?before=<id> cursor) ---
  app.get('/loans', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=5, must-revalidate')
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const before = cursor(q.before)
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })
    if (q.borrower !== undefined && q.borrower !== null && q.borrower !== '') {
      if (typeof q.borrower !== 'string' || !validAddress(q.borrower)) {
        return reply.code(400).send({ error: 'invalid Stellar address' })
      }
    }
    const borrower = typeof q.borrower === 'string' && q.borrower ? q.borrower : null

    const conditions: string[] = []
    const params: unknown[] = []
    if (borrower) {
      params.push(borrower)
      conditions.push(`borrower = $${params.length}`)
    }
    if (before !== null) {
      params.push(before)
      conditions.push(`id < $${params.length}`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(l)
    const loans = await query<LoanRow>(`SELECT * FROM loans ${where} ORDER BY id DESC LIMIT $${params.length}`, params)
    return loans.map(withLoanDerived)
  })

  app.get<{ Params: { id: string } }>('/loans/:id', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=5, must-revalidate')
    const rawId = req.params.id.trim()
    if (!/^[0-9]+$/.test(rawId) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) <= 0) {
      return reply.code(400).send({ error: 'invalid loan id' })
    }
    const loan = await queryOne<LoanRow>('SELECT * FROM loans WHERE id = $1', [Number(rawId)])
    if (!loan) return reply.code(404).send({ error: 'loan not found' })
    return withLoanDerived(loan)
  })

  // --- A loan's full event history (issue #26) ---
  // Every state change to a loan — requested, edited, voted on, approved,
  // repaid or defaulted — is in the raw event log already, but reconstructing
  // it meant paging the whole `/api/events` feed and filtering client-side on
  // an id buried in the JSONB `data` column. This is the query on-chain state
  // can't answer (the contract keeps no queryable history) and this service
  // exists for. `loans.id == loan_proposals.id` by contract invariant, so one
  // id covers the whole lifecycle. A nonexistent id returns an empty timeline
  // (200), not a 404 — the loan may simply have no events yet, and the caller
  // asked "what happened to this id", which is legitimately "nothing".
  app.get<{ Params: { id: string } }>('/loans/:id/timeline', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=5, must-revalidate')
    const id = entityIdParam(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid loan id' })
    return { timeline: await entityTimeline(LOAN_TIMELINE_SYMBOLS, id) }
  })

  // --- Treasury proposals ---
  app.get('/proposals/treasury', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=5, must-revalidate')
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    return query<TreasuryProposalRow>('SELECT * FROM treasury_proposals ORDER BY id DESC LIMIT $1', [l])
  })

  // --- A treasury proposal's full event history (issue #26) ---
  // The treasury-lifecycle equivalent of `/loans/:id/timeline`: proposed,
  // voted on, committed and revealed (the commit–reveal path for private
  // proposals), executed. Loan and treasury proposal ids are drawn from
  // independent sequences and collide, so this is a distinct route rather
  // than a shared `/proposals/:id/timeline`. Same empty-not-404 contract.
  app.get<{ Params: { id: string } }>('/proposals/treasury/:id/timeline', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=5, must-revalidate')
    const id = entityIdParam(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid proposal id' })
    return { timeline: await entityTimeline(TREASURY_TIMELINE_SYMBOLS, id) }
  })

  // --- Notifications for an address ---
  app.get('/notifications', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-cache')
    const q = req.query as Record<string, unknown>
    if (typeof q.address !== 'string' || !q.address || !validAddress(q.address)) {
      return reply.code(400).send({ error: 'invalid Stellar address' })
    }
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    return query<NotificationRow>(
      'SELECT * FROM notifications WHERE address = $1 ORDER BY id DESC LIMIT $2',
      [q.address, l]
    )
  })

  // --- Raw event feed (optional ?symbol= filter, ?before=<ledger> cursor) ---
  // Stricter rate limit on this heavy endpoint (issue #5).
  app.get('/events', {
    config: {
      rateLimit: {
        max: config.http.rateLimitEventsMax,
        timeWindow: config.http.rateLimitWindowMs,
      },
    },
  }, async (req, reply) => {
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const before = eventCursor(q.before)
    const after = eventCursor(q.after)
    
    if (invalidEventCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })
    if (invalidEventCursor(q.after)) return reply.code(400).send({ error: 'invalid after cursor' })
    if (before !== null && after !== null) return reply.code(400).send({ error: 'cannot use before and after together' })
    
    const order = typeof q.order === 'string' && q.order === 'asc' ? 'ASC' : 'DESC'

    if (before !== null || after !== null) {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    } else {
      reply.header('Cache-Control', 'public, max-age=5, must-revalidate')
    }

    const symbol = typeof q.symbol === 'string' && q.symbol ? q.symbol : null
    const contract = typeof q.contract === 'string' && q.contract ? q.contract : null
    const decodeError = q.decode_error === 'true'

    const conditions: string[] = []
    const params: unknown[] = []
    if (symbol) {
      params.push(symbol)
      conditions.push(`symbol = $${params.length}`)
    }
    if (contract) {
      params.push(contract)
      conditions.push(`contract_id = $${params.length}`)
    }
    if (decodeError) {
      conditions.push(`decode_error IS NOT NULL`)
    }
    if (before !== null) {
      if (before.id) {
        params.push(before.ledger, before.id)
        conditions.push(`(ledger, id) < ($${params.length - 1}, $${params.length})`)
      } else {
        params.push(before.ledger)
        conditions.push(`ledger < $${params.length}`)
      }
    }
    if (after !== null) {
      if (after.id) {
        params.push(after.ledger, after.id)
        conditions.push(`(ledger, id) > ($${params.length - 1}, $${params.length})`)
      } else {
        params.push(after.ledger)
        conditions.push(`ledger > $${params.length}`)
      }
    }
    
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(l)
    
    const events = await query<EventRow>(
      `SELECT * FROM events ${where} ORDER BY ledger ${order}, id ${order} LIMIT $${params.length}`,
      params
    )
    
    const response: { events: EventRow[], nextCursor?: string } = { events }
    const lastEvent = events[events.length - 1]
    if (lastEvent) {
      response.nextCursor = lastEvent.id
    }
    return response
  })

  // --- Mark a single notification as read ---
  app.patch<{ Params: { id: string } }>('/notifications/:id/read', async (req, reply) => {
    // First authenticate the request
    const auth = await authenticateRequest(req.headers, nonceStore)
    if (!auth.authenticated) {
      return reply.code(auth.status).send({ error: auth.error || 'Authentication required' })
    }

    const rawId = req.params.id.trim()
    if (!/^[0-9]+$/.test(rawId) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) <= 0) {
      return reply.code(400).send({ error: 'invalid notification id' })
    }
    const id = Number(rawId)

    // Get the notification to check ownership
    const notification = await queryOne<NotificationRow>(
      'SELECT * FROM notifications WHERE id = $1',
      [id]
    )
    if (!notification) return reply.code(404).send({ error: 'notification not found' })

    // Ownership check uses the address `authenticateRequest` proved control
    // of — never a second parse of the raw header (issue #70).
    if (notification.address !== auth.address) {
      return reply.code(403).send({ error: 'Cannot modify notifications for another address' })
    }
    
    const row = await queryOne<NotificationRow>(
      'UPDATE notifications SET read = true WHERE id = $1 RETURNING *',
      [id]
    )
    if (!row) return reply.code(404).send({ error: 'notification not found' })
    return row
  })

  // --- Mark all of an address's notifications as read ---
  app.patch('/notifications/read-all', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    if (typeof q.address !== 'string' || !q.address || !validAddress(q.address)) {
      return reply.code(400).send({ error: 'invalid Stellar address' })
    }
    
    // Authenticate the request and verify the address matches
    const auth = await authenticateRequest(req.headers, nonceStore, q.address)
    if (!auth.authenticated) {
      return reply.code(auth.status).send({ error: auth.error || 'Authentication required' })
    }
    
    const rows = await query<NotificationRow>(
      'UPDATE notifications SET read = true WHERE address = $1 AND read = false RETURNING id',
      [q.address]
    )
    return { updated: rows.length }
  })

  // --- Admin/governance audit log (init, admin add/remove, threshold,
  // policy, pause/unpause) ---
  app.get('/admin/log', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const before = cursor(q.before)
    
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })
    
    if (before !== null) {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    } else {
      reply.header('Cache-Control', 'public, max-age=5, must-revalidate')
    }
    // `?contract=<C...>` scopes to one deployment, same as /events (issue #16).
    const contract = typeof q.contract === 'string' && q.contract ? q.contract : null
    const params: unknown[] = [ADMIN_EVENT_SYMBOLS as unknown as string[]]
    let where = `WHERE symbol = ANY($1)`
    if (contract) {
      params.push(contract)
      where += ` AND contract_id = $${params.length}`
    }
    params.push(l)
    return query<EventRow>(
      `SELECT * FROM events ${where} ORDER BY ledger DESC LIMIT $${params.length}`,
      params
    )
  })

  // --- Interest distribution history (issue #24, ?before=<ledger> cursor) ---
  // One row per `interest` event: the amount the treasury collected and the
  // active-member count at that distribution, so per-member share per
  // distribution is derivable. `amount` is interest *collected* — the
  // contract keeps the indivisible remainder, so it is slightly more than the
  // sum credited to members (documented in the README).
  app.get('/interest', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const before = cursor(q.before)
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })
    
    if (before !== null) {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    } else {
      reply.header('Cache-Control', 'public, max-age=5, must-revalidate')
    }
    
    const params: unknown[] = []
    let where = ''
    if (before !== null) {
      params.push(before)
      where = `WHERE ledger < $${params.length}`
    }
    params.push(l)
    return query<InterestDistributionRow>(
      `SELECT id, ledger, amount, active_members, tx_hash, created_at
         FROM interest_distributions ${where}
        ORDER BY ledger DESC, id DESC LIMIT $${params.length}`,
      params
    )
  })

  // --- Documents attached to a proposal (issue #44, ?before=<ledger> cursor) ---
  // One row per `doc_attn` event — existence/history only, never the content
  // hash (still read live from the contract via get_document). A single
  // `?kind=&proposal_id=` endpoint rather than two per-family routes: loan
  // and treasury proposal ids are drawn from independent sequences and
  // collide, so `kind` is required alongside `proposal_id` either way, and
  // one route keeps the pagination/validation logic in one place.
  app.get('/documents', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const before = cursor(q.before)
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })
    
    if (before !== null) {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    } else {
      reply.header('Cache-Control', 'public, max-age=5, must-revalidate')
    }
    
    const kind = q.kind
    if (kind !== 'loan' && kind !== 'treasury') {
      return reply.code(400).send({ error: 'kind query param must be "loan" or "treasury"' })
    }
    if (typeof q.proposal_id !== 'string' || !/^[0-9]+$/.test(q.proposal_id)) {
      return reply.code(400).send({ error: 'proposal_id query param is required' })
    }
    const proposalId = Number(q.proposal_id)
    const params: unknown[] = [kind, proposalId]
    let where = `WHERE kind = $1 AND proposal_id = $2`
    if (before !== null) {
      params.push(before)
      where += ` AND ledger < $${params.length}`
    }
    params.push(l)
    return query<DocumentRow>(
      `SELECT id, proposal_id, kind, caller, ledger, tx_hash, attached_at
         FROM documents ${where}
        ORDER BY ledger DESC, id DESC LIMIT $${params.length}`,
      params
    )
  })

  // --- Quarantined events (issue #43) ---
  // A deterministically-throwing handler no longer wedges the indexer
  // forever — the poller isolates the offending event, records it here
  // (without touching the append-only `events` row), and moves on. This is
  // the operator-facing view of that; `/api/stats.quarantinedEvents` is the
  // dashboard-facing count.
  app.get('/admin/failed-events', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=5, must-revalidate')
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    return query<FailedEventRow>(
      'SELECT * FROM failed_events ORDER BY id DESC LIMIT $1',
      [l]
    )
  })

  // --- Aggregate stats (with indexer freshness — issue #2) ---
  //
  // Issue #18: /api/stats is the hottest endpoint (the frontend polls it
  // every 15s from every tab, and proposal enumeration depends on it) and the
  // most expensive (eight uncached counts). A short-lived in-process cache
  // collapses a burst of polls to one set of queries. Scoped to this server
  // instance — a fresh registerRoutes() closure per buildServer() — so it
  // never leaks across tests or restarts.
  let statsCache: { at: number; value: DAOStats } | null = null

  async function computeStats(): Promise<DAOStats> {
    const row = await queryOne<{
      total_members: string
      active_members: string
      total_loan_proposals: string
      total_loans: string
      active_loans: string
      defaulted_loans: string
      total_defaulted_value: string | null
      total_treasury_proposals: string
      total_staked: string | null
      interest_collected: string | null
      principal_lent: string | null
      principal_repaid: string | null
      value_defaulted: string | null
      quarantined_events: string
      last_ledger: number | null
      observed_tip_ledger: number | null
      cursor_updated_at: string | null
    }>(
      // Member counts mirror the contract's two distinct getters:
      // get_total_members (all-time) vs get_active_members (current). Both
      // require a real join event — `joined_ledger IS NOT NULL` — so phantom
      // rows from a name/stake event never count (issue #14). total_staked
      // sums only non-exited members: the `exited` handler now zeroes stake
      // (issue #13), and this WHERE is defence in depth so a future handler
      // gap can't re-inflate the figure.
      `SELECT
         (SELECT count(*) FROM members WHERE joined_ledger IS NOT NULL)             AS total_members,
         (SELECT count(*) FROM members WHERE joined_ledger IS NOT NULL AND exited = false) AS active_members,
         (SELECT count(*) FROM loan_proposals)                                     AS total_loan_proposals,
         (SELECT count(*) FROM loans)                                              AS total_loans,
         (SELECT count(*) FROM loans WHERE status = 'active')                      AS active_loans,
         (SELECT count(*) FROM loans WHERE status = 'defaulted')                   AS defaulted_loans,
         (SELECT COALESCE(sum(outstanding), 0) FROM loans WHERE status = 'defaulted') AS total_defaulted_value,
         (SELECT count(*) FROM treasury_proposals)                                 AS total_treasury_proposals,
         (SELECT COALESCE(sum(stake), 0) FROM members WHERE exited = false)         AS total_staked,
         (SELECT interest_collected FROM dao_totals WHERE id = 1)                  AS interest_collected,
         (SELECT principal_lent     FROM dao_totals WHERE id = 1)                  AS principal_lent,
         (SELECT principal_repaid   FROM dao_totals WHERE id = 1)                  AS principal_repaid,
         (SELECT value_defaulted    FROM dao_totals WHERE id = 1)                  AS value_defaulted,
         (SELECT count(*) FROM failed_events)                                     AS quarantined_events,
         (SELECT last_ledger FROM indexer_cursor WHERE id = 1)                     AS last_ledger,
         (SELECT observed_tip_ledger FROM indexer_cursor WHERE id = 1)             AS observed_tip_ledger,
         (SELECT updated_at FROM indexer_cursor WHERE id = 1)                      AS cursor_updated_at`
    )
    const cursorUpdatedAt = row?.cursor_updated_at
    const secondsSinceUpdate = cursorUpdatedAt
      ? Math.floor((Date.now() - new Date(cursorUpdatedAt).getTime()) / 1000)
      : null
    const isStale = cursorUpdatedAt != null &&
      Date.now() - new Date(cursorUpdatedAt).getTime() > config.indexer.staleAfterMs

    const lastLedger = row?.last_ledger ?? null
    const tipLedger = row?.observed_tip_ledger ?? null
    const ledgersBehind = lastLedger != null && tipLedger != null && tipLedger > lastLedger
      ? tipLedger - lastLedger
      : null
    const estimatedLagSeconds = ledgersBehind != null ? ledgersBehind * 5 : null

    return {
      totalMembers: Number(row?.total_members ?? 0),
      activeMembers: Number(row?.active_members ?? 0),
      totalLoanProposals: Number(row?.total_loan_proposals ?? 0),
      totalLoans: Number(row?.total_loans ?? 0),
      activeLoans: Number(row?.active_loans ?? 0),
      defaultedLoans: Number(row?.defaulted_loans ?? 0),
      totalDefaultedValue: String(row?.total_defaulted_value ?? '0'),
      totalTreasuryProposals: Number(row?.total_treasury_proposals ?? 0),
      totalStaked: String(row?.total_staked ?? '0'),
      interestCollected: String(row?.interest_collected ?? '0'),
      principalLent: String(row?.principal_lent ?? '0'),
      principalRepaid: String(row?.principal_repaid ?? '0'),
      valueDefaulted: String(row?.value_defaulted ?? '0'),
      quarantinedEvents: Number(row?.quarantined_events ?? 0),
      lastIndexedLedger: lastLedger,
      observedTipLedger: tipLedger,
      ledgersBehind,
      estimatedLagSeconds,
      secondsSinceUpdate,
      indexerStale: isStale,
    }
  }

  app.get('/stats', async (_req, reply): Promise<DAOStats> => {
    const ttl = config.http.statsCacheMs
    reply.header('Cache-Control', `public, max-age=${Math.max(0, Math.floor(ttl / 1000))}`)
    if (statsCache && Date.now() - statsCache.at < ttl) {
      return statsCache.value
    }
    const value = await computeStats()
    statsCache = { at: Date.now(), value }
    return value
  })
}
