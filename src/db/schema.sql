-- OurDAO backend schema. This file is the bootstrap baseline: it always
-- describes the *current* desired shape (CREATE ... IF NOT EXISTS), so a
-- brand-new database gets that shape directly. It is safe to run on every
-- boot, but on an *existing* database IF NOT EXISTS silently no-ops for any
-- table/index whose definition changed underneath it — it cannot add a
-- column, change a type, or otherwise alter something that already exists.
-- Changes of that kind go in src/db/migrations/ instead and are applied,
-- exactly once and in order, by src/db/migrate.ts. See README's "Database
-- schema" section for the full mechanics.
--
-- i128 on-chain amounts are stored as NUMERIC(40,0) (i128 max ~1.7e38 < 10^39).

-- Tracks which numbered migrations (src/db/migrations/NNNN_*.sql) have been
-- applied to this database. Bootstrapped here so it exists before
-- migrate.ts needs to read or write it.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexer resume state (single row, id = 1).
-- `last_ledger_hash` is the ledger-hash of the RPC's reported tip at the time
-- the cursor was last advanced (Soroban getEvents exposes no per-event hash);
-- it is forensic context for a detected discontinuity, not a verified
-- processed-ledger hash. See issue #23 / README "Reorg detection".
-- `observed_tip_ledger` (issue #45) is the RPC's most recently observed chain
-- tip — freshness/reporting only, distinct from `last_ledger` (the highest
-- ledger actually folded, which the reorg continuity check uses). An empty
-- getEvents page must never advance `last_ledger` from this value; see
-- README "Reorg detection" and src/indexer/poller.ts.
CREATE TABLE IF NOT EXISTS indexer_cursor (
  id                  SMALLINT PRIMARY KEY DEFAULT 1,
  paging_token        TEXT,
  last_ledger         BIGINT,
  last_ledger_hash    TEXT,
  observed_tip_ledger BIGINT,
  contract_id         TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT indexer_cursor_singleton CHECK (id = 1)
);

-- Raw event log — the append-only source every derived table is built from.
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,          -- Soroban event paging id (globally unique)
  ledger      BIGINT NOT NULL,
  closed_at   TIMESTAMPTZ NOT NULL,
  contract_id TEXT NOT NULL,
  symbol      TEXT NOT NULL,             -- first topic, e.g. 'loan_req'
  topics      JSONB NOT NULL,
  data        JSONB NOT NULL,
  tx_hash     TEXT,
  decode_error TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when this event's derived-state fold has committed — independent of
  -- the row's own existence, so a crash between the raw insert and the fold
  -- (quarantine path) can be detected and retried rather than silently
  -- skipped (issue #119). Declared last, matching where the
  -- 0016_events_folded_at.sql ALTER TABLE physically appends it on a
  -- database that already had this table (schema.sql's own column order
  -- only governs a truly fresh bootstrap).
  folded_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS events_symbol_idx ON events (symbol);
CREATE INDEX IF NOT EXISTS events_ledger_idx ON events (ledger);
-- Supports the ?contract= filter on /api/events and /api/admin/log, added so
-- a database that has held more than one CONTRACT_ID can be read per
-- deployment (issue #16).
CREATE INDEX IF NOT EXISTS events_contract_id_idx ON events (contract_id);
-- Per-entity timelines (issue #26). Every loan- and treasury-lifecycle event
-- carries its entity id as the first `data` tuple entry (data->>0) — see
-- LOAN_TIMELINE_SYMBOLS / TREASURY_TIMELINE_SYMBOLS in src/stellar/events.ts
-- — so a btree expression index on that extracted value turns
-- `GET /api/loans/:id/timeline` into an index scan over the handful of
-- matching rows instead of a seq scan of the whole log. EXPLAIN output on a
-- seeded dataset is in the PR.
CREATE INDEX IF NOT EXISTS events_entity_id_idx ON events ((data->>0));
-- Supports `GET /api/members/:address/activity`, which matches an address in
-- any position of the `data` tuple with JSONB containment (`data @> '"G…"'`).
CREATE INDEX IF NOT EXISTS events_data_gin_idx ON events USING GIN (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS members (
  address         TEXT PRIMARY KEY,
  joined_ledger   BIGINT,
  contribution    NUMERIC(40,0) NOT NULL DEFAULT 0,
  exited          BOOLEAN NOT NULL DEFAULT false,
  exit_share      NUMERIC(40,0),
  exited_ledger   BIGINT,
  pending_claimed NUMERIC(40,0) NOT NULL DEFAULT 0,
  stake           NUMERIC(40,0) NOT NULL DEFAULT 0,
  has_active_loan BOOLEAN NOT NULL DEFAULT false,
  name            TEXT,
  defaults_count  INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Partial index for the /api/stats active-member count (issue #18): only
-- non-exited rows, so `count(*) ... WHERE exited = false` is an index-only
-- scan over the small live set rather than a seq scan of every member ever.
CREATE INDEX IF NOT EXISTS members_active_idx ON members (address) WHERE exited = false;

-- `votes_for`/`votes_against` hold stake-weighted voting power (see the
-- Event catalog section of the README), which can exceed what INTEGER was
-- originally sized for once every voter's weight is summed — matched to the
-- contract's own i128 `for_votes`/`against_votes` fields.
CREATE TABLE IF NOT EXISTS loan_proposals (
  id              INTEGER PRIMARY KEY,
  borrower        TEXT NOT NULL,
  amount          NUMERIC(40,0) NOT NULL,
  total_repayment NUMERIC(40,0) NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CONSTRAINT loan_proposals_status_check
                  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'approved_pending_disbursement')),
  votes_for       NUMERIC(40,0) NOT NULL DEFAULT 0,
  votes_against   NUMERIC(40,0) NOT NULL DEFAULT 0,
  voter_count     INTEGER NOT NULL DEFAULT 0,
  created_ledger  BIGINT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loan_proposals_borrower_idx ON loan_proposals (borrower);

-- `id` doubles as the originating loan_proposals.id: the contract reuses the
-- proposal's own id for the disbursed loan (see ourdao-contracts'
-- loans.rs::approve_and_disburse) rather than a separate counter, since a
-- proposal produces at most one loan.
CREATE TABLE IF NOT EXISTS loans (
  id             INTEGER PRIMARY KEY,
  borrower       TEXT NOT NULL,
  amount         NUMERIC(40,0) NOT NULL,
  outstanding    NUMERIC(40,0) NOT NULL DEFAULT 0,
  total_repayment NUMERIC(40,0) NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active'
                 CONSTRAINT loans_status_check
                 CHECK (status IN ('active', 'repaid', 'defaulted')),
  approved_ledger BIGINT,
  due_time       TIMESTAMPTZ,
  repaid_ledger  BIGINT,
  defaulted_ledger BIGINT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loans_borrower_idx ON loans (borrower);
CREATE INDEX IF NOT EXISTS loans_status_idx ON loans (status);

CREATE TABLE IF NOT EXISTS treasury_proposals (
  id              INTEGER PRIMARY KEY,
  amount          NUMERIC(40,0) NOT NULL,
  destination     TEXT NOT NULL,
  private         BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CONSTRAINT treasury_proposals_status_check
                  CHECK (status IN ('pending', 'executed', 'rejected', 'approved_pending_disbursement')),
  votes_for       NUMERIC(40,0) NOT NULL DEFAULT 0,
  votes_against   NUMERIC(40,0) NOT NULL DEFAULT 0,
  voter_count     INTEGER NOT NULL DEFAULT 0,
  created_ledger  BIGINT,
  executed_ledger BIGINT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  address    TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  message    TEXT NOT NULL,
  ledger     BIGINT,
  tx_hash    TEXT,
  read       BOOLEAN NOT NULL DEFAULT false,
  event_id   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_address_idx ON notifications (address, read);
CREATE INDEX IF NOT EXISTS notifications_event_id_address_idx ON notifications (event_id, address);

-- Lifetime money aggregates folded from the raw event log (issue #24).
-- Single row (id = 1). O(1) to read; kept in sync as events fold, and
-- rebuilt exactly by `npm run reindex`. `interest_collected` is interest the
-- treasury took in; the contract keeps the indivisible per-member division
-- remainder, so it slightly exceeds what members were actually credited.
CREATE TABLE IF NOT EXISTS dao_totals (
  id                 SMALLINT PRIMARY KEY DEFAULT 1,
  interest_collected NUMERIC(40,0) NOT NULL DEFAULT 0,
  principal_lent     NUMERIC(40,0) NOT NULL DEFAULT 0,
  principal_repaid   NUMERIC(40,0) NOT NULL DEFAULT 0,
  value_defaulted    NUMERIC(40,0) NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dao_totals_singleton CHECK (id = 1)
);
INSERT INTO dao_totals (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- One row per `interest` event: the distribution history (issue #24).
-- `event_id` is the raw events.id and is UNIQUE so a re-delivered event
-- folds exactly once.
CREATE TABLE IF NOT EXISTS interest_distributions (
  id             BIGSERIAL PRIMARY KEY,
  event_id       TEXT NOT NULL UNIQUE,
  ledger         BIGINT NOT NULL,
  amount         NUMERIC(40,0) NOT NULL,
  active_members INTEGER,
  tx_hash        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interest_distributions_ledger_idx ON interest_distributions (ledger);

-- Quarantine record for a `doc_attn`-style deterministic handler failure
-- (issue #43). The append-only `events` row for a quarantined event is never
-- mutated or deleted — this is a separate, additive record of what the
-- poller gave up on folding and why, so the rest of the page can proceed and
-- the cursor can advance past it. Not a derived table: never truncated by
-- npm run reindex, since a reindex re-attempts every raw event fresh and
-- either folds it (if the handler's since been fixed) or doesn't touch this
-- table at all (reindex runs applyEvent directly, not the poller's
-- quarantine path).
CREATE TABLE IF NOT EXISTS failed_events (
  id         BIGSERIAL PRIMARY KEY,
  event_id   TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  ledger     BIGINT NOT NULL,
  error      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS failed_events_event_id_idx ON failed_events (event_id);
CREATE INDEX IF NOT EXISTS failed_events_ledger_idx ON failed_events (ledger);

-- One row per `doc_attn` event (issue #44): the existence and history of a
-- proposal's attached documents, not the content hash itself (that's read
-- live from the contract via get_document — see the README's Event catalog).
-- `kind` distinguishes loan vs treasury proposals, since their ids are drawn
-- from independent sequences and collide (loan proposal 3 and treasury
-- proposal 3 are different entities) — mirrors ourdao-contracts'
-- ProposalKind. `event_id UNIQUE` is the same re-delivery-safe idempotency
-- key `interest_distributions` uses.
CREATE TABLE IF NOT EXISTS documents (
  id          BIGSERIAL PRIMARY KEY,
  event_id    TEXT NOT NULL UNIQUE,
  proposal_id INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  caller      TEXT NOT NULL,
  ledger      BIGINT NOT NULL,
  tx_hash     TEXT,
  attached_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_proposal_idx ON documents (kind, proposal_id, ledger DESC);

-- Authentication nonces for Stellar-signed login (issues #63, #66)
CREATE TABLE IF NOT EXISTS auth_nonces (
  address    TEXT PRIMARY KEY,
  nonce      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_nonces_expires_at_idx ON auth_nonces (expires_at);
