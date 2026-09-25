<p align="center">
  <img src="assets/logo.png" alt="OurDAO logo" width="96" />
</p>

# OurDAO Backend

[![CI](https://github.com/ourdao/ourdao-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/ourdao/ourdao-backend/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Off-chain **indexer + read API** for the [OurDAO](https://github.com/ourdao) lending DAO on Stellar/Soroban.

The Soroban contract ([`ourdao-contracts`](https://github.com/ourdao/ourdao-contracts)) is the single source of truth for all state, but on-chain data has [state expiration (TTL)](https://developers.stellar.org/docs/learn/encyclopedia/storage/state-archival) and keeps no queryable history — there's no way to ask the contract "list every loan proposal" or "show me this address's notification feed." This service fills that gap: it tails the contract's emitted events into Postgres and serves fast, aggregated, history-aware read APIs that [`ourdao-frontend`](https://github.com/ourdao/ourdao-frontend) consumes.

It is **strictly read-only and event-driven** — it never holds keys, never signs a transaction, and cannot move funds. Every state change still happens on-chain via the user's own wallet; this service only mirrors what already happened.

This repository is one of three that make up OurDAO:

| Repo | Role |
|---|---|
| [`ourdao-contracts`](https://github.com/ourdao/ourdao-contracts) | The Soroban contract — the single source of truth for all DAO state |
| **`ourdao-backend`** (this repo) | Off-chain indexer + read API |
| [`ourdao-frontend`](https://github.com/ourdao/ourdao-frontend) | Next.js web app members actually use |

## Table of contents

- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Database schema](#database-schema)
- [Event catalog](#event-catalog)
- [API reference](#api-reference)
  - [Reorg detection](#reorg-detection)
  - [Quarantine](#quarantine)
- [Testing](#testing)
- [Security notes](#security-notes)
- [Status](#status)
- [Contributing](#contributing)
- [License](#license)

## Architecture

```
Soroban RPC ──getEvents──▶ indexer (worker.ts) ──▶ Postgres ──▶ REST API (index.ts) ──▶ frontend
```

- **`src/indexer`** — a poll loop over the Soroban RPC `getEvents`, resuming from a persisted cursor (`indexer_cursor` table) rather than re-scanning from genesis on every restart. Each raw event is written to an append-only `events` log, then folded into the relevant derived table (`members`, `loan_proposals`, `loans`, `treasury_proposals`, `notifications`) inside a single database transaction, so a crash mid-poll can never leave the derived tables and the raw log inconsistent. Poll failures back off exponentially (capped, configurable) instead of hammering the RPC endpoint. The `events` log is never pruned; its growth per unit of DAO activity, the secondary-index costs, and the point at which partitioning becomes worthwhile are documented in [`docs/events-storage.md`](./docs/events-storage.md) (measure with `npm run bench:events`).
- **`src/stellar/events.ts`** — the event catalog: the exact topic-symbol → data-tuple mapping the contract publishes, decoded via `scValToNative` and converted to JSON-safe primitives (bigints become strings, since JSON has no native 128-bit integer type).
- **`src/api`** — a [Fastify](https://fastify.dev) server exposing the read endpoints in the [API reference](#api-reference) below.
- **`src/db`** — the Postgres schema (applied idempotently on boot by both the API and worker processes) and a thin query helper over [`pg`](https://node-postgres.com/).

The API process and the indexer worker are separate entrypoints (`index.ts` / `worker.ts`) so they can be scaled or deployed independently — e.g. one long-running indexer worker behind several stateless, horizontally-scaled API instances.

## Quick start

```bash
# 1. Install
npm install

# 2. Start Postgres (or point DATABASE_URL at your own instance)
docker compose up -d

# 3. Configure
cp .env.example .env
#   set CONTRACT_ID to your deployed OurDAO contract id (starts with C)

# 4. Run the API (http://localhost:4000)
npm run dev

# 5. In another terminal, run the indexer
npm run dev:worker
```

Production build:

```bash
npm run build
npm start              # API
npm run start:worker   # indexer
```

## Deployment

The full deployment guide is in **[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md)**. Key points that are easy to get wrong:

- **The worker must run as a singleton.** Running two workers concurrently corrupts vote tallies through non-idempotent increments — the failure is silent. The API is stateless and can scale horizontally; the worker cannot.
- **Set `START_LEDGER` before the first boot.** The public Soroban RPC retains roughly 24 hours of event history. If your contract was deployed before that window, set `START_LEDGER` to the contract's deploy ledger. Events older than the RPC window are permanently unavailable — you cannot fetch them later.
- **Set `CORS_ORIGIN` to the real frontend origin.** It defaults to `http://localhost:3000`. Leaving it at the default silently blocks every browser request from the production frontend.
- **`events` is the only table you must back up.** All other tables (`members`, `loan_proposals`, `loans`, etc.) are derived from it and can be rebuilt with `npm run reindex`.
- **Repointing at a new `CONTRACT_ID` requires an explicit reset step.** The worker refuses to start if the configured contract id doesn't match the one stored in the cursor — see [Redeploying the contract](./docs/DEPLOYMENT.md#redeploying-the-contract) for options.

## Configuration

All configuration is environment-driven — see [`.env.example`](./.env.example) for the full annotated list. Key values:

| Variable | Purpose |
|---|---|
| `CONTRACT_ID` | Deployed OurDAO contract id. **Required** for the indexer to run. |
| `SOROBAN_RPC_URL` | Soroban RPC endpoint (defaults to public testnet). |
| `NETWORK_PASSPHRASE` | Testnet by default; switch for mainnet. |
| `DATABASE_URL` | Postgres connection string (or set the individual `PG*` vars). |
| `START_LEDGER` / `START_LOOKBACK_LEDGERS` | Where to start indexing on a cold start. Public Soroban RPC only retains ~24h of events, so an old start ledger gets clamped to the oldest the RPC still serves. |
| `POLL_INTERVAL_MS` / `EVENTS_PAGE_LIMIT` | Indexer poll cadence and page size. |
| `POLL_MAX_BACKOFF_MS` | Cap for exponential backoff after consecutive poll failures (default 60s). |
| `DRAIN_MAX_PAGES` | Max pages per poll drain cycle when catching up (default 20). |
| `DRAIN_MAX_MS` | Max wall-clock ms for a single drain cycle (default 30s). |
| `INDEXER_STALE_AFTER_MS` | How long (ms) the cursor can be idle before `/ready` reports stale (default 120s). |
| `INDEXER_QUARANTINE_AFTER_FAILURES` | After this many consecutive whole-page failures with the same error on the same page, the poller quarantines the offending event(s) instead of retrying forever (default 3). See [Quarantine](#quarantine). |
| `INDEXER_RESET_ON_CONTRACT_CHANGE` | `true` for one boot to wipe the cursor + derived tables when `CONTRACT_ID` changes (redeploy). Default `false` — a mismatch refuses to start. See [Redeploying the contract](#redeploying-the-contract). |
| `CORS_ORIGIN` | Comma-separated allowed origins for the API (the frontend's URL). Defaults to `http://localhost:3000`. Set to `*` to allow all origins (a warning is logged at startup). |
| `RATE_LIMIT_MAX` | Global rate limit: max requests per window per IP (default 100). |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window in milliseconds (default 60000). |
| `RATE_LIMIT_EVENTS_MAX` | Stricter rate limit for `GET /api/events` (default 30). |
| `STATS_CACHE_MS` | How long (ms) an `/api/stats` result is cached in-process before it is recomputed (default 5000; `0` disables). Reported figures are at most this stale. |
| `TRUST_PROXY` | Set to `"true"` behind a reverse proxy so rate limits apply per client IP. |
| `LOG_LEVEL` | Pino log level for the Fastify server (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`). Default `info` (logs a line per request). `silent` suppresses all request logging, which the test harness uses. |
| `TEST_DATABASE_URL` | Separate database `npm test` runs against — never the dev DB. |

**Note:** The indexer (worker process) uses `console.log`/`console.error` directly and does not respect `LOG_LEVEL`. Its output is always shown regardless of this setting.

## Database schema

Postgres, applied by `src/db/migrate.ts` on every boot — both the API and the worker call it at startup, so it's safe with no separate migration-runner step to remember to run.

`src/db/schema.sql` is the bootstrap baseline: idempotent `CREATE TABLE/INDEX IF NOT EXISTS` statements describing the *current* desired shape. That's sufficient for a brand-new database, but `IF NOT EXISTS` silently no-ops on a table that already exists — including when a column was added or a type changed. Those changes instead live as numbered files in `src/db/migrations/` (e.g. `0001_widen_vote_columns.sql`), applied in order and tracked in a `schema_migrations` table so each one runs exactly once per database. A fresh database created from `schema.sql` already has every migration's end state, so its migrations are recorded as applied without re-running their SQL; an existing database gets the real `ALTER` statements. A Postgres advisory lock serializes `migrate()` across the API and worker so they don't race to apply the same migration concurrently on startup.

To add a schema change: update `schema.sql` to the new desired shape (for fresh databases) *and* add a new numbered file under `src/db/migrations/` with the `ALTER`/`CREATE`/etc. needed to get an existing database there (for everyone else).

| Table | Purpose | Notable columns |
|---|---|---|
| `schema_migrations` | Tracks which numbered migrations have been applied | `version`, `name`, `applied_at` |
| `indexer_cursor` | Single-row resume state for the poll loop | `paging_token`, `last_ledger` (highest ledger actually folded), `observed_tip_ledger` (RPC-observed chain tip — freshness only, kept separate from `last_ledger` since issue #45), `contract_id` (cursor is discarded on a cold start if it belongs to a different contract) |
| `events` | Append-only raw event log — the source everything else is derived from | `symbol`, `topics` (JSONB), `data` (JSONB), `tx_hash` |
| `members` | Current membership state | `contribution`, `stake`, `has_active_loan`, `pending_claimed`, `name` (from the registry), `defaults_count` |
| `loan_proposals` | Loan votes in flight | `status` (`pending`/`approved`/`rejected`), `votes_for`, `votes_against`, `voter_count` |
| `loans` | Disbursed loans | `status` (`active`/`repaid`/`defaulted`), `total_repayment`, `outstanding`, `due_time`. **`id` doubles as the originating `loan_proposals.id`** — the contract reuses the proposal's own id for the disbursed loan rather than a separate counter, since a proposal produces at most one loan. |
| `treasury_proposals` | Treasury withdrawal votes | `private` (routed through commit-reveal instead of open voting), `status`, `votes_for`, `votes_against`, `voter_count` |
| `notifications` | Per-address notification feed | `type`, `read`, indexed on `(address, read)` |
| `documents` | Existence/history of a proposal's attached documents (issue #44) — one row per `doc_attn` event, never the content hash itself | `proposal_id`, `kind` (`loan`/`treasury` — loan and treasury proposal ids collide, drawn from independent sequences), `caller`, `ledger` |
| `failed_events` | Quarantine record for a handler that failed deterministically (issue #43) — additive, never mutates the `events` row it came from | `event_id`, `symbol`, `ledger`, `error` |

On-chain `i128` amounts are stored as `NUMERIC(40,0)` (an i128's max value is ~1.7×10³⁸, which fits under 10³⁹) and returned from the API as **decimal strings**, never JSON numbers, to avoid silent precision loss — this was in fact a real bug found and fixed during development: `pg` returns Postgres `BIGINT` columns as JS strings by default, and the original code assumed they came back as numbers.

**Column-type rule for amounts vs. sequences.** On-chain `i128` amounts are `NUMERIC(40,0)` and cross the API boundary as strings. Ledger sequence numbers are `BIGINT` and are returned as JSON numbers — `src/db/index.ts` registers a `BIGINT → number` parser **scoped to this repo's connection pool**, not on the process-wide `pg.types` registry (a global parser silently truncated any `BIGINT` above 2⁵³, for every pg consumer in the process). Nothing else should be `BIGINT`: a token amount stored as `BIGINT` would be parsed to a `number` by that pool parser and lose precision above 2⁵³ with no error. Use `NUMERIC(40,0)` for any new amount column, and only `BIGINT` for a genuine ledger/sequence value.

**Vote tallies are stake-weighted, not a headcount.** The contract grants each voter `1 + min(stake / STAKE_WEIGHT_UNIT, MAX_STAKE_BONUS)` voting power (currently up to 6) and sums that into `for_votes`/`against_votes`. `votes_for`/`votes_against` mirror that (hence `NUMERIC(40,0)`, matching the contract's own field width, not a plain vote count); `voter_count` is the distinct-voter headcount alongside it, so a client can show both "7 members voted" and "carrying 19 voting power." **The contract doesn't publish the weight it applied yet** — `loan_vote`/`tre_vote`/`revealed` currently carry only `support` — so today every vote folds in as weight 1 regardless of stake, and `votes_for`/`votes_against` under-count for any staked voter until [the upstream fix](https://github.com/ourdao/ourdao-contracts) lands. The API explicitly surfaces a `tallies_weighted: false` flag on proposals until this is resolved. The decoder and handlers already read a `weight` field the moment the contract adds one, with no further backend change needed.

**A loan's `outstanding` balance starts at `total_repayment`, not the principal.** The contract collects `total_repayment = amount + interest` on `repay_loan`, so a loan is never worth just its principal from a borrower's perspective. `loan_appr` doesn't publish `total_repayment` (only the disbursed `amount`), so the indexer sources it from the just-approved `loan_proposals` row instead — `loans.id == loan_proposals.id` is a documented contract invariant, and that row already carries `total_repayment` from `loan_req`/`loan_edit`. This depends on that proposal row existing, which it will unless the indexer started mid-history; if it's missing, `total_repayment` falls back to the principal. `due_time` has the same gap — the contract computes it but doesn't publish it on `loan_appr` — so it's `NULL` until that's fixed upstream. `GET /api/loans` and `/api/loans/:id` also expose `interest_charge` and `repaid_amount`, both derived from `total_repayment` at read time.

**Required fields are validated, not coerced (issue #42).** Every handler in `src/indexer/handlers.ts` reads its decoded fields through either the `require*` helpers (`requireAddr`/`requireId`/`requireAmount`/`requireBool`/`requireProposalKind`) or the older `str`/`num`/`addr` coercion helpers. The `require*` helpers are for a field a derived row depends on — a missing or malformed one throws instead of silently coercing into a plausible-looking default (a missing amount becoming `'0'`, a bad id becoming `NULL` and matching zero rows, a non-string address becoming `''`). `str`/`num`/`addr` are kept only for genuinely optional fields with no on-chain equivalent yet (`weight`, `due_time`) or that no stored row depends on. A thrown `FieldValidationError` rolls back the write and is handled the same way any other deterministic handler error is — see [Quarantine](#quarantine).

### Redeploying the contract

The OurDAO contract has **no upgrade path** — every fix is a fresh deployment with a new `CONTRACT_ID`. Proposal and loan ids restart at 0 for a new deployment, and `loans.id` / `loan_proposals.id` are primary keys, so pointing an existing database at a new contract would silently merge two deployments' state (the new contract's proposal 0 overwriting the old one's under `ON CONFLICT (id) DO UPDATE`, members' contributions blending, and so on).

The indexer records which contract its cursor belongs to (`indexer_cursor.contract_id`). When `CONTRACT_ID` no longer matches, it **refuses to start** rather than resume. To repoint at a new deployment, choose one:

- **Fresh database (recommended):** point `DATABASE_URL` at a new, empty database. The old deployment's indexed history stays queryable where it is.
- **Reuse the database:** start the worker once with `INDEXER_RESET_ON_CONTRACT_CHANGE=true`. This truncates the cursor and every derived table (`members`, `loan_proposals`, `loans`, `treasury_proposals`, `notifications`) and re-indexes the new contract from scratch. The append-only `events` log is **kept** — pass `?contract=<C...>` to `GET /api/events` and `GET /api/admin/log` to scope the raw log to one deployment. Unset the flag again after the first successful boot.

Running one database against multiple contracts simultaneously is deliberately not supported — the derived tables are single-contract by construction.

## Event catalog

The full topic-symbol → data-tuple mapping this service decodes (kept in sync with `ourdao-contracts`'s `env.events().publish(...)` calls):

| Symbol | Fields | Derived-table effect |
|---|---|---|
| `joined` | `member, fee` | upserts `members`, notifies the member |
| `exited` | `member, share` | marks the member exited |
| `claimed` | `member, pending` | tracks claimed yield |
| `loan_req` | `id, borrower, amount, total_repayment` | inserts a pending `loan_proposals` row |
| `loan_edit` | `proposal_id, borrower, new_amount, total_repayment` | updates the proposal |
| `loan_vote` | `proposal_id, voter, support`, plus a reserved `weight` not yet published (see above) | adds the vote's weight to the tally, bumps `voter_count` |
| `loan_wait` | `id, amount` | the proposal reached quorum but the treasury can't cover it yet — marks it `approved_pending_disbursement` (issue #125). A later `disburse_approved_loan` call resolves this and republishes `loan_appr` |
| `loan_rej` | `id, for_votes, against_votes` | an early rejection when the votes still outstanding can no longer reach quorum (issue #124) — marks the proposal `rejected`, distinct from `loan_exp`'s post-window keeper path below |
| `loan_appr` | `id, borrower, amount`, plus a reserved `due_time` not yet published | marks the proposal approved, opens a `loans` row seeded with `total_repayment` from the matching proposal (not the bare principal — see below), flags the borrower's `has_active_loan` |
| `loan_rpy` | `loan_id, borrower, outstanding` | updates outstanding balance; marks `repaid` when it hits zero |
| `loan_dflt` | `loan_id, borrower, penalty` | marks the loan `defaulted`, slashes the borrower's `contribution` by the penalty (clamped at zero), bumps `defaults_count`, clears `has_active_loan` — idempotent, so redelivering the same event is a no-op past the first application |
| `interest` | `interest, active` | no per-member breakdown to attribute, but folded into `dao_totals.interest_collected` and one `interest_distributions` row (issue #24). `interest` is interest *collected* — the contract keeps the indivisible per-member remainder, so it slightly exceeds what members were credited. Per-member yield is still surfaced via `claimed`. |
| `tre_prop` | `id, amount, destination, private` | inserts a pending `treasury_proposals` row |
| `tre_vote` | `id, voter, support`, plus a reserved `weight` not yet published | adds the vote's weight to the tally, bumps `voter_count` |
| `tre_wait` | `id, amount` | treasury equivalent of `loan_wait` above (issue #125) — marks the proposal `approved_pending_disbursement` |
| `tre_rej` | `id, for_votes, against_votes` | treasury equivalent of `loan_rej` above (issue #124) — marks the proposal `rejected` |
| `tre_exec` | `id, amount, destination` | marks the proposal executed, notifies the recipient |
| `staked` / `unstaked` | `member, amount, new_stake` | updates the member's stake |
| `name_reg` | `name, owner` | updates the member's registered name |
| `committed` | `proposal_id, voter` | notifies the voter their commit was recorded |
| `revealed` | `proposal_id, voter, support`, plus a reserved `weight` not yet published | tallies the same as an open vote |
| `doc_attn` | `kind, proposal_id, caller` | inserts a `documents` history row (issue #44) — existence/history only; the content hash itself is still read live from the contract via `get_document`, never indexed |
| `init`, `admin_add`, `admin_rem`, `threshold`, `policy`, `paused`, `unpaused` | varies | admin/governance events — surfaced via `/api/admin/log`, not folded into a derived table |

## API reference

Base path: `/api`.

| Method & path | Description |
|---|---|
| `GET /health` | Liveness check + the currently configured contract id. No DB round trip. |
| `GET /ready` | Readiness probe — checks Postgres reachability and indexer freshness. Returns `503` with a `reason` when Postgres is down or the indexer cursor is stale. |
| `GET /api/stats` | Aggregate counts (members, loans, proposals) + defaulted-loan count/value + lifetime money figures (`interestCollected`, `principalLent`, `principalRepaid`, `valueDefaulted`, all decimal strings) + `quarantinedEvents` (issue #43) + `lastIndexedLedger` (highest ledger actually folded) and `observedTipLedger` (RPC-observed chain tip, issue #45) as the useful "folded to X, chain is at Y" pair. Cached in-process for `STATS_CACHE_MS`; sets `Cache-Control`. With more than one API instance the cached figures may briefly disagree. |
| `GET /api/interest` | Interest-distribution history — one row per `interest` event (`amount` collected, `active_members` at that distribution). `?before=<ledger>` cursor. |
| `GET /api/members` | Active members. |
| `GET /api/members/:address` | Single member. |
| `GET /api/members/:address/summary` | Member's dashboard data, including the member row, up to 100 loans, unread notification count, and their relative position to DAO totals (share percentages in basis points) in a single consistent snapshot. |
| `GET /api/members/:address/activity` | Every event that names this address as a participant (joins, stakes, loan actions, votes), newest first (issue #26). `?before=<ledger>` cursor. Each entry is the decoded event: `id`, `symbol`, `ledger`, `timestamp`, `tx_hash`, and named `fields`. |
| `GET /api/proposals/loan` | Loan proposals with vote tallies (`votes_for`/`votes_against`), a distinct `voter_count`, and an explicit `tallies_weighted: false` flag. |
| `GET /api/loans` | Loans. Optional `?borrower=`, `?before=<id>` for pagination. `status` is `active`, `repaid`, or `defaulted` — a loan is marked defaulted once it's past due plus the policy's grace period (permissionless on-chain, see `ourdao-contracts`). Each loan includes derived `interest_charge` and `repaid_amount` fields. |
| `GET /api/loans/:id` | Single loan, with the same derived `interest_charge`/`repaid_amount` fields. |
| `GET /api/loans/:id/timeline` | A loan's full lifecycle in chronological order (issue #26): `loan_req`, `loan_edit`, `loan_vote`, `loan_wait`, `loan_rej`, `loan_appr`, `loan_rpy`, `loan_dflt`, `loan_exp`. Returns `{ "timeline": [...] }` where each entry is the decoded event — `id`, `symbol`, `ledger`, `timestamp`, `tx_hash`, and named `fields` (not raw JSONB). A nonexistent id returns an empty timeline (`200`), not a `404`. |
| `GET /api/proposals/treasury` | Treasury proposals with vote tallies, a distinct `voter_count`, and an explicit `tallies_weighted: false` flag. |
| `GET /api/proposals/treasury/:id/timeline` | A treasury proposal's full lifecycle in chronological order (issue #26): `tre_prop`, `tre_vote`, `committed`, `revealed`, `tre_wait`, `tre_rej`, `tre_exec`. Same shape and empty-not-404 behaviour as the loan timeline. |
| `GET /api/notifications?address=` | Notifications for an address. |
| `PATCH /api/notifications/:id/read` | Mark one notification read. |
| `PATCH /api/notifications/read-all?address=` | Mark every unread notification for an address read. |
| `GET /api/events` | Raw event feed. Optional `?symbol=`, `?before=<id|ledger>`, `?after=<id|ledger>`, `?order=asc|desc`. |
| `GET /api/admin/log` | Admin/governance audit trail — init, admin add/remove, threshold changes, policy changes, pause/unpause. |
| `GET /api/documents?kind=&proposal_id=` | A proposal's attached-document history (issue #44) — existence/history only, never the content hash (still read live from the contract via `get_document`). `kind` (`loan` or `treasury`) and `proposal_id` are both required, since loan and treasury proposal ids are drawn from independent sequences and collide. `?before=<ledger>` cursor. |
| `GET /api/admin/failed-events` | Quarantined events (issue #43) — the operator-facing detail behind `/api/stats.quarantinedEvents`. Each row has the event id, symbol, ledger, and the error that quarantined it; the raw `events` row itself is left untouched. |
| `GET /api/stream` | Server-Sent Events stream of real-time change notifications (issue #63). Sends lightweight change signals like `members_changed`, `loan_proposals_changed` as the indexer folds events — clients refetch via the endpoints above. Each message includes the channel name and timestamp. Optional `?channels=members,loans` subscribes to only that subset instead of every channel (issue #160) — see [Security notes](#security-notes) for why there is no per-member channel. The stream uses Postgres `LISTEN`/`NOTIFY` under the hood, so multiple API instances each fan out to their own clients independently without coordination. Reconnecting clients can check `Last-Event-ID` to detect missed notifications. The server enforces its own backpressure and idle limits (issue #157): a client that stops reading is disconnected rather than buffered without bound, and the socket has a server-side idle timeout as a backstop. |

All list endpoints accept `?limit=` (default 50, max 200). `?before=` and `?after=` are cursors: pass the `id` (or `ledger`) of the last row you saw to page. For `/api/events`, the cursor can be a deterministic `(ledger, id)` value (the event `id` string itself contains both) and ordering is strictly deterministic (`ledger DESC, id DESC` by default, or `ASC`). On-chain `i128` amounts are returned as decimal **strings** to preserve precision (see [Database schema](#database-schema)); ledger sequence numbers are returned as regular JSON numbers.

### Errors

Every error response — a deliberate `4xx` from a route, a failed request body, or anything thrown while handling the request — uses one shape:

```json
{ "error": "loan not found", "correlationId": "b1f2c3d4-..." }
```

- **`error`** is a short, safe, human-readable string. It never contains a stack trace, SQL, or raw database driver text. Deliberate `4xx` messages (`invalid loan id`, `address query param is required`, …) are passed through unchanged; every `5xx` is a generic string (`internal server error`) with the real cause written only to the server log.
- **`correlationId`** is the request id. It is also returned in the `x-correlation-id` response header (on success and failure alike) and printed as `reqId` on the matching server-side log line, so a user-reported failure can be traced to its log entry.

Postgres failures are mapped to a sensible status rather than an opaque `500`: a unique violation → `409`, a check violation or missing required value → `422`, and a connection failure → `503`. The driver's message (which would name columns, constraints and types) is logged, never returned.

> `429` responses from the rate limiter (`@fastify/rate-limit`) keep that plugin's own body shape (`{ statusCode, error, message }`) and are the one exception to the envelope above.

### Caching

All `GET` endpoints support `ETag` and conditional requests (`If-None-Match`), returning `304 Not Modified` when the underlying data is unchanged. `Cache-Control` headers are set appropriately:
- **Historical immutable queries** (`/events`, `/admin/log`, `/interest`, `/documents` with a `?before=` or `?after=` cursor) are cached indefinitely (`public, max-age=31536000, immutable`).
- **Live tip queries** use a short TTL (`public, max-age=5, must-revalidate`).
- **Per-address queries** (`/notifications`, `/members/:address/summary`) are never cached by shared caches (`private, no-cache`).

### Reorg detection

Stellar's consensus gives fast finality, so a deep reorg is genuinely unlikely — but the indexer now *notices* one rather than silently folding events from a diverged history (issue #23):

- The cursor stores `last_ledger` and `last_ledger_hash` — the hash of that same ledger, fetched by sequence from the RPC (Soroban's `getEvents` exposes no per-event ledger hash, so this is the only way to get one).
- Each poll checks continuity two ways: if the RPC's reported latest ledger is **below** the last folded ledger, or a fetched page contains an event from a ledger already folded past, the indexer **halts** with a loud log line instead of retrying. It also re-fetches the RPC's current hash for `last_ledger` and compares it against what's stored (issue #128) — this catches a **same-height fork**, where history diverges without the ledger sequence ever moving backwards, which the sequence-only checks can't see. A ledger the RPC has since pruned is treated as unverifiable, not as a fork.
- **Recovery:** stop the indexer worker (`node dist/worker.js`) and run `npm run reindex` (`node dist/indexer/reindex.js` in the container). It truncates the derived tables and rebuilds them from the raw `events` log in one transaction — the log is authoritative and untouched. A rebuild produces state identical to the incremental fold (asserted by a test), so `reindex` is also the repair path for the historical-data bugs tracked in other issues.
- **Worker serialization (Advisory Lock):** Both `reindex` and the worker's event fold loops acquire a dedicated session-level Postgres advisory lock (`0x0d400001`). If a reindex is attempted while a worker is running or folding, it fails immediately with an actionable error rather than racing to corrupt derived state.
- **Streaming & Memory Bounds:** The rebuild streams the event log via keyset pagination over `(ledger, id)` in batches (default 1,000) inside a single transaction, keeping Node.js memory flat (~40–60 MB RSS) regardless of event log size (e.g., 100k+ events). Progress is logged periodically with event counts, percentage, throughput (events/s), and estimated ETA.
- **Rebuild Performance Expectations:**
  - **10k events:** ~1–2 seconds, ~45 MB peak RSS.
  - **100k events:** ~10–20 seconds, ~55 MB peak RSS.
  - **500k events:** ~50–90 seconds, ~60 MB peak RSS.
- **Unrecoverable:** events that were orphaned *and* already pruned from the RPC's ~24h window can't be re-fetched; `reindex` rebuilds from whatever the raw log holds.
- **`last_ledger` only ever advances to a ledger whose events were actually folded (issue #45).** An earlier version fell back to the RPC's reported chain tip on an empty `getEvents` page, which conflated "highest ledger folded" with "how current the RPC is" — during catch-up, one empty page could jump `last_ledger` to the tip, and the very next real (but still historically-earlier) page would then look like a rewind and trigger a false halt. The RPC-observed tip is tracked in its own column, `observed_tip_ledger` — freshness reporting only (`/ready`, `/api/stats.observedTipLedger`), never fed into the continuity check above.

### Quarantine

A handler bug used to be able to wedge the indexer permanently: `ingestPage` folds a whole page in one transaction, so one event whose handler throws rolled back the entire page, and the poll loop retried the *same* page forever behind exponential backoff (capped at `POLL_MAX_BACKOFF_MS`) — the process stayed up and kept logging the same error, but indexed nothing (issue #43).

- The poller can't tell a transient failure (RPC hiccup, a DB restart — expected to clear on retry) from a deterministic one (a handler bug, a value that overflows its column) from the error alone. It infers it from repetition: if the *same* page fails with the *same* error `INDEXER_QUARANTINE_AFTER_FAILURES` times in a row (default 3), that's not transient.
- Once that threshold is hit, the page is retried **one event per transaction** instead of the whole page at once. Each event's raw log row is written (and stays written) regardless of whether folding it succeeds; if folding throws, that one transaction rolls back and the event is recorded in `failed_events` (id, symbol, ledger, error) instead — every other event in the page still folds normally, and the cursor advances past all of them.
- On this per-event path, the raw log write and the fold necessarily commit as two separate transactions (the raw write has to survive a fold that then fails). `events.folded_at` tracks fold completion independently of the row's own existence (issue #119), so a crash between the two — the raw row committed, the fold didn't — is retried on the next pass instead of being mistaken for an already-handled event. A failure recording an event to `failed_events` itself (issue #120) is logged and does not stop the rest of the page from folding.
- A `ReorgDetectedError` is never quarantined, on either path — a genuine rewind still halts the indexer immediately, exactly as in [Reorg detection](#reorg-detection) above.
- Once the handler bug is fixed, `npm run reindex` folds a previously-quarantined event correctly with no extra step — it replays the raw log directly through `applyEvent`, independent of the poller's quarantine bookkeeping.
- Quarantined events are visible at `GET /api/admin/failed-events` and counted in `GET /api/stats.quarantinedEvents`.

### Docker

```bash
docker build -t ourdao-backend .
docker run --env-file .env -p 4000:4000 ourdao-backend            # API (default CMD)
docker run --env-file .env ourdao-backend node dist/worker.js      # indexer
docker run --env-file .env ourdao-backend node dist/indexer/reindex.js   # one-off rebuild
```

The image runs as the non-root `node` user, uses `tini` as PID 1, and has a `HEALTHCHECK` against `/health`. Both processes migrate on startup, so no separate migrate step is needed.

## Testing

```bash
# One-time: create the test database (separate from the dev DB above)
docker exec <postgres-container> psql -U ourdao -d postgres -c "CREATE DATABASE ourdao_test;"

npm test          # vitest, against ourdao_test — never touches dev data
npm run lint
npm run typecheck
```

145 tests across 18 files, covering:
- Event decode logic (`decodeEvent`, `toJsonSafe`) in isolation.
- Every indexer handler (membership, loan lifecycle including defaults, treasury, staking, registry, commit-reveal privacy, document attachments) against a real Postgres instance — not mocked.
- Required-field validation per handler (issue #42) and the poller's quarantine path for a deterministically-failing handler (issue #43), including that a genuine reorg is still never quarantined.
- The `last_ledger`/`observed_tip_ledger` split (issue #45): an empty page during catch-up doesn't produce a false reorg halt.
- Every API route, exercised through a real Fastify instance via `.inject()`.

Tests apply the real `schema.sql` and truncate all tables between runs (`test/db.ts`). CI runs all of the above plus `npm run build` against a Postgres service container on every push and PR (`.github/workflows/ci.yml`).

## Security notes

- **No custody, ever.** This service holds no private keys and has no code path that constructs, signs, or submits a transaction. It is a read model over public on-chain events.
- **Fail-soft, not fail-open.** If the indexer falls behind or the RPC endpoint is unreachable, reads degrade to stale/empty data (surfaced to the frontend as such) rather than the API crashing or serving incorrect state.
- **CORS is explicit.** `CORS_ORIGIN` defaults to `http://localhost:3000` in both code and config — a production deployment should set this to the real frontend origin. Setting it to `*` is supported as an explicit opt-in but logs a warning at startup.
- **Input handling.** All route parameters (addresses, ids, cursors) are validated before being used in parameterized queries — no raw string interpolation into SQL anywhere in the codebase.
- **Supported authentication address types.** The signature-based auth on the notification mutation endpoints accepts:
  - **`G…` (ed25519)** — verified directly against the account's public key.
  - **`M…` (muxed)** — resolved to the underlying `G…` account and verified against its key. Sign the same `"<nonce>:<address>"` payload using the `M…` address as it appears in the header.
  - **`C…` (contract) accounts are not supported.** A Soroban contract account has no ed25519 key and authorizes through its `__check_auth` entrypoint, which requires an on-chain RPC call to verify. Authenticating with a `C…` address returns `400` with an explicit message rather than a misleading `401 "Invalid signature"`. If contract-wallet auth is needed, open an issue — it needs an RPC call in the auth path and a caching strategy.
- **Dependency Scanning.** Dependencies are scanned weekly via Dependabot, and `npm audit` is run in CI to report on vulnerabilities.
- **Rate limiting.** Global rate limiting (`@fastify/rate-limit`) is applied to all API endpoints, with a stricter per-route limit on `GET /api/events`. Health and readiness probes are exempt. Behind a reverse proxy, set `TRUST_PROXY=true` so limits apply per client IP. With in-process limiting, the effective global limit is `RATE_LIMIT_MAX × instance count`.
- **`GET /api/stream` is unauthenticated by design, and broadcasts only DAO-wide state (issue #160).** It never requires a wallet signature — any client can connect and `LISTEN` — but every channel it can subscribe to (`members`, `loan_proposals`, `loans`, `treasury_proposals`, `interest`) describes state that's already public via the corresponding `GET` endpoints; a connected client learns nothing an unauthenticated caller couldn't already fetch directly. There is deliberately no per-member channel: a member's own notification feed (loan amounts, defaults, private-vote participation) is only ever available from the authenticated `GET /api/notifications`, and clients are expected to poll that themselves rather than have it pushed over an unauthenticated stream. A client that only cares about a subset of state can request it with `?channels=loans,loan_proposals` (comma-separated `STREAM_CHANNELS` keys) instead of receiving every channel.

## Status

MVP — the indexer and read API are implemented for the full event catalog, including loan defaults, with test coverage across every indexer handler and API route. Known gaps:

- Reorg handling is *detection only* — the indexer halts on a ledger discontinuity and an operator rebuilds derived state from the raw log with `npm run reindex` (see [Reorg detection](#reorg-detection)). There is no automatic rollback and replay of orphaned events.
- Single indexer instance — no leader-election or multi-instance coordination if you wanted to run more than one worker for redundancy.
- IPFS pinning for document metadata is a frontend/contract-facing concern (`ourdao-frontend`'s `lib/ipfs.ts`) — this service indexes `doc_attn`'s existence/history (`documents`, `GET /api/documents`) but never the content hash or its content.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, how to run the test suite against a real Postgres, and the backend-specific rules (read-only boundary, append-only event log, transactional event folding). Please claim an issue before opening a pull request.

Found a security vulnerability? Don't open a public issue — use GitHub's private vulnerability reporting on this repo.

## License

MIT
