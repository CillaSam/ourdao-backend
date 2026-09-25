import type { rpc } from '@stellar/stellar-sdk'
import type { PoolClient } from 'pg'
import { config, assertContractConfigured } from '../config.js'
import { pool, queryOne } from '../db/index.js'
import { server, getLatestLedger, getLatestLedgerInfo } from '../stellar/rpc.js'
import { decodeEvent, type DecodedEvent } from '../stellar/events.js'
import { applyEvent } from './handlers.js'
import { DERIVED_TABLES, resetDaoTotals } from './derived-tables.js'
import { REINDEX_LOCK_KEY } from './reindex.js'

interface CursorRow {
  paging_token: string | null
  last_ledger: number | null
  last_ledger_hash: string | null
  // RPC-observed chain tip, distinct from `last_ledger` (issue #45) — see
  // the comment on the `documents`/schema migration and fetchOnce below.
  observed_tip_ledger: number | null
  contract_id: string | null
}

// Per-run abort controller — replaced on each runIndexer() call so the flag
// doesn't persist across runs (issue #48). An AbortController also gives the
// drain loop (issue #47) a way to check for shutdown between pages.
let abortController: AbortController | null = null
let running = false

/** Thrown when the ledger sequence the indexer sees stops being monotonic —
 *  the RPC's reported tip fell below our cursor, or a fetched page contains
 *  an event from a ledger we already advanced past. It means history diverged
 *  from what we folded (issue #23). The poll loop halts on this rather than
 *  retrying; an operator re-indexes from the raw log (`npm run reindex`)
 *  after confirming the true chain state. */
export class ReorgDetectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReorgDetectedError'
  }
}

/** Wipe the cursor and every derived table so the indexer can re-index a new
 *  deployment from an empty slate. Destructive — only reached when
 *  INDEXER_RESET_ON_CONTRACT_CHANGE is set. */
export async function resetForContractChange(): Promise<void> {
  const client = await pool.connect()
  let lockAcquired = false
  try {
    const lockRes = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1)',
      [REINDEX_LOCK_KEY]
    )
    if (!lockRes.rows[0]?.pg_try_advisory_lock) {
      throw new Error(
        'Cannot reset database for contract change: reindex or fold operation is currently in progress (advisory lock held)'
      )
    }
    lockAcquired = true

    await client.query('BEGIN')
    await client.query(`TRUNCATE ${DERIVED_TABLES.join(', ')} RESTART IDENTITY`)
    await resetDaoTotals(client)
    await client.query('DELETE FROM indexer_cursor WHERE id = 1')
    await client.query('COMMIT')
  } catch (err) {
    if (lockAcquired) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Rollback failure ignored
      }
    }
    throw err
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [REINDEX_LOCK_KEY])
      } catch (err) {
        console.error('[indexer] failed to release advisory lock:', err)
      }
    }
    client.release()
  }
}

/**
 * Guard against silently merging two deployments' state (issue #16). The
 * OurDAO contract has no upgrade path, so every fix is a fresh deployment
 * with a new CONTRACT_ID — and proposal/loan ids restart at 0, so the new
 * contract's rows would collide with the old one's under `ON CONFLICT (id)
 * DO UPDATE`.
 *
 * If the saved cursor was last advanced for a different contract, refuse to
 * start with an actionable error. Setting INDEXER_RESET_ON_CONTRACT_CHANGE
 * instead wipes the cursor + derived tables and re-indexes from scratch.
 * No-op when the cursor is absent or already matches.
 */
export async function ensureCursorContract(contractId: string): Promise<void> {
  const row = await queryOne<{ contract_id: string | null }>(
    'SELECT contract_id FROM indexer_cursor WHERE id = 1'
  )
  const saved = row?.contract_id ?? null
  if (saved === null || saved === contractId) return

  if (config.indexer.resetOnContractChange) {
    console.warn(
      `[indexer] CONTRACT_ID changed (${saved} -> ${contractId}) and ` +
        `INDEXER_RESET_ON_CONTRACT_CHANGE is set: wiping the cursor, derived ` +
        `tables (${DERIVED_TABLES.join(', ')}), and dao_totals — re-indexing the ` +
        `new contract from scratch. The raw events log is left intact.`
    )
    await resetForContractChange()
    return
  }

  throw new Error(
    `Indexer cursor belongs to contract ${saved}, but CONTRACT_ID is now ${contractId}. ` +
      `Resuming would merge two deployments' derived state in one database. ` +
      `To repoint at a new deployment: start once with INDEXER_RESET_ON_CONTRACT_CHANGE=true ` +
      `to wipe the cursor and derived tables, or point DATABASE_URL at a fresh database. ` +
      `See the README's "Redeploying the contract" section.`
  )
}

/** Loads the saved cursor, but only if it belongs to `contractId` — a
 *  cursor saved under a different contract (CONTRACT_ID changed since the
 *  last run) is treated as absent so the indexer cold-starts instead of
 *  resuming with another contract's paging_token. */
async function loadCursor(contractId: string): Promise<CursorRow | null> {
  const row = await queryOne<CursorRow>(
    'SELECT paging_token, last_ledger, last_ledger_hash, observed_tip_ledger, contract_id FROM indexer_cursor WHERE id = 1'
  )
  if (row && row.contract_id != null && row.contract_id !== contractId) return null
  return row
}

async function saveCursor(
  contractId: string,
  pagingToken: string | null,
  lastLedger: number,
  observedTipLedger: number,
  lastLedgerHash: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO indexer_cursor (id, paging_token, last_ledger, last_ledger_hash, observed_tip_ledger, contract_id, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET paging_token = $1, last_ledger = $2, last_ledger_hash = $3, observed_tip_ledger = $4, contract_id = $5, updated_at = now()`,
    [pagingToken, lastLedger, lastLedgerHash, observedTipLedger, contractId]
  )
}

/** Touch updated_at without changing data — keeps freshness signal alive on idle contracts. */
async function touchCursor(): Promise<void> {
  await pool.query('UPDATE indexer_cursor SET updated_at = now() WHERE id = 1')
}

/** Determine the ledger to start from on a cold start (no saved cursor). */
async function resolveStartLedger(): Promise<number> {
  if (config.indexer.startLedger > 0) return config.indexer.startLedger
  const latest = await getLatestLedger()
  return Math.max(1, latest - config.indexer.startLookbackLedgers)
}

/** Insert one event's raw log row (idempotent on its unique id) and report
 *  whether it still needs folding — i.e. `folded_at IS NULL` on the row that
 *  now exists, regardless of whether *this* call did the inserting.
 *
 *  Fold completion is tracked independently of raw-row existence (issue
 *  #119): the quarantine path commits this insert on its own, separately
 *  from the fold that follows, so a crash in between leaves a raw row with
 *  no fold. Keying "needs fold" off the row's own `folded_at` (rather than
 *  off whether this INSERT was the one that created the row) means that on
 *  retry the row is found to still need folding instead of being skipped.
 *
 *  Shared by the whole-page path and the per-event quarantine path (issue
 *  #43) so both write the same row the same way. */
async function insertRawEvent(client: PoolClient, ev: DecodedEvent): Promise<boolean> {
  const res = await client.query<{ folded_at: string | null }>(
    `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash, decode_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET id = events.id
     RETURNING folded_at`,
    [ev.id, ev.ledger, ev.closedAt, ev.contractId, ev.symbol, JSON.stringify(ev.topics), JSON.stringify(ev.data), ev.txHash, ev.decodeError ?? null]
  )
  return res.rows[0]?.folded_at == null
}

/** Mark an event's row as folded — set in the same transaction as the fold
 *  itself so `folded_at` is never non-null for a fold that didn't commit
 *  (issue #119). */
async function markFolded(client: PoolClient, id: string): Promise<void> {
  await client.query('UPDATE events SET folded_at = now() WHERE id = $1', [id])
}

/** Persist a page of events + their derived side effects atomically.
 *  `lastLedger` is the highest ledger already folded — used for the
 *  continuity check (issue #23). Whole-page-transaction is the fast path:
 *  it's what runs on every normal poll. When a page can't be folded this way
 *  — one event's handler throws deterministically — the caller
 *  (`ingestPageWithQuarantine`) falls back to folding one event per
 *  transaction so the rest of the page isn't held hostage (issue #43). */
async function ingestPage(events: rpc.Api.EventResponse[], lastLedger: number): Promise<void> {
  if (events.length === 0) return
  const client = await pool.connect()
  let lockAcquired = false
  try {
    const lockRes = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1)',
      [REINDEX_LOCK_KEY]
    )
    if (!lockRes.rows[0]?.pg_try_advisory_lock) {
      throw new Error(
        'Cannot ingest events: reindex is currently in progress (advisory lock held)'
      )
    }
    lockAcquired = true

    await client.query('BEGIN')
    for (const raw of events) {
      const ev = decodeEvent(raw)
      // Continuity check (issue #23): getEvents returns events in ascending
      // ledger order and we resume from a paging token, so a fetched event
      // from *below* the ledger we already folded past means history diverged
      // from what was applied. Halt rather than fold from a diverged chain.
      if (typeof ev.ledger === 'number' && lastLedger > 0 && ev.ledger < lastLedger) {
        throw new ReorgDetectedError(
          `event ${ev.id} is from ledger ${ev.ledger}, below the last folded ledger ${lastLedger}`
        )
      }
      // Raw log first (idempotent on the unique event id), then derived state.
      const needsFold = await insertRawEvent(client, ev)
      // Fold only on first sight of an event id. A re-delivered page then
      // can't re-apply increments (issue #24, and the vote-tally hazard) —
      // raw insert, fold, and the folded_at update are all in one
      // transaction here, so needsFold accurately reflects "not yet folded"
      // (issue #119).
      if (needsFold) {
        await applyEvent(client, ev)
        await markFolded(client, ev.id)
      }
    }
    await client.query('COMMIT')
  } catch (err) {
    if (lockAcquired) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Rollback failure ignored
      }
    }
    throw err
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [REINDEX_LOCK_KEY])
      } catch (err) {
        console.error('[indexer] failed to release advisory lock:', err)
      }
    }
    client.release()
  }
}

async function recordQuarantinedEvent(ev: DecodedEvent, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  await pool.query(
    `INSERT INTO failed_events (event_id, symbol, ledger, error) VALUES ($1, $2, $3, $4)`,
    [ev.id, ev.symbol, ev.ledger, message]
  )
  console.error(`[indexer] quarantined event ${ev.id} (${ev.symbol}) at ledger ${ev.ledger}: ${message}`)
}

/** Record a quarantined event, tolerating a failure of the bookkeeping
 *  insert itself (issue #120). Without this guard, an error here — a
 *  constraint violation, disk full, a dropped connection — propagates out of
 *  `ingestEventQuarantined`, aborting the `for` loop in
 *  `ingestPageWithQuarantine` before it reaches any later event in the page
 *  and before it resets `quarantineState`. The page is retried from the top
 *  on the next poll, so nothing is stranded (`insertRawEvent`'s `folded_at`
 *  check — issue #119 — still sees this event as needing a fold), but every
 *  event after the one that hit the bookkeeping failure sits unfolded for
 *  an extra pass, and the failure itself would otherwise go unlogged.
 *
 *  Swallowing it here instead lets the loop finish the rest of the page and
 *  logs the failure loudly, so it isn't silent. */
async function recordQuarantinedEventSafely(ev: DecodedEvent, error: unknown): Promise<void> {
  try {
    await recordQuarantinedEvent(ev, error)
  } catch (recordErr) {
    const recordMsg = recordErr instanceof Error ? recordErr.message : String(recordErr)
    console.error(
      `[indexer] failed to record quarantined event ${ev.id} (${ev.symbol}) in failed_events — ` +
        `it was NOT folded and will be retried next pass: ${recordMsg}`
    )
  }
}

/** Fold exactly one event, each side in its own transaction (issue #43):
 *  the raw log insert commits on its own, so it survives untouched even if
 *  folding fails below — the append-only `events` row is never rolled back
 *  along with a broken fold. If applying the event throws, that one
 *  transaction rolls back (no partial derived-table writes) and the event is
 *  recorded in `failed_events` instead — the rest of the page's events are
 *  unaffected, and the cursor still advances past this one. A ReorgDetectedError
 *  is never caught here; it propagates so the indexer still halts on a
 *  genuine rewind.
 *
 *  Because the raw insert and the fold commit separately, a crash between
 *  them (deploy, OOM, SIGKILL) would previously strand the row unfolded
 *  forever — on restart the row already existed, so it looked already
 *  handled (issue #119). `insertRawEvent`'s `folded_at` check makes
 *  "needs folding" independent of "row exists", so that crash window is
 *  just retried on the next pass instead. */
async function ingestEventQuarantined(ev: DecodedEvent, lastLedger: number): Promise<void> {
  if (typeof ev.ledger === 'number' && lastLedger > 0 && ev.ledger < lastLedger) {
    throw new ReorgDetectedError(
      `event ${ev.id} is from ledger ${ev.ledger}, below the last folded ledger ${lastLedger}`
    )
  }

  const client = await pool.connect()
  let lockAcquired = false
  try {
    const lockRes = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1)',
      [REINDEX_LOCK_KEY]
    )
    if (!lockRes.rows[0]?.pg_try_advisory_lock) {
      throw new Error(
        'Cannot fold quarantined event: reindex is currently in progress (advisory lock held)'
      )
    }
    lockAcquired = true

    const needsFold = await insertRawEvent(client, ev)
    if (!needsFold) return // already folded by an earlier attempt at this page

    try {
      await client.query('BEGIN')
      await applyEvent(client, ev)
      await markFolded(client, ev.id)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      await recordQuarantinedEventSafely(ev, err)
    }
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [REINDEX_LOCK_KEY])
      } catch (err) {
        console.error('[indexer] failed to release advisory lock:', err)
      }
    }
    client.release()
  }
}

interface QuarantineState {
  pageKey: string
  errorMessage: string
  failures: number
}

// Tracks consecutive whole-page failures across poll iterations so a
// transient error (RPC hiccup, DB restart — expected to clear on retry) is
// told apart from a deterministic one (issue #43). Single indexer instance
// per README, so in-memory state here is fine — it doesn't need to survive a
// restart, and a restart just starts the same count over at the same page.
let quarantineState: QuarantineState | null = null

function pageKeyFor(events: rpc.Api.EventResponse[]): string {
  if (events.length === 0) return ''
  return `${events[0]!.id}..${events[events.length - 1]!.id}:${events.length}`
}

/** Wraps `ingestPage`'s whole-page-transaction fast path with the quarantine
 *  fallback (issue #43). A `ReorgDetectedError` always propagates immediately
 *  — never quarantined, on either path. Any other error is compared against
 *  the previous failure on the same page: once the *same* error has recurred
 *  `INDEXER_QUARANTINE_AFTER_FAILURES` times running on what
 *  `server.getEvents` deterministically returns for the same unmoved cursor
 *  (i.e. the same page), it's treated as deterministic and the page is
 *  retried one event per transaction so the rest of it can still fold. */
async function ingestPageWithQuarantine(events: rpc.Api.EventResponse[], lastLedger: number): Promise<void> {
  try {
    await ingestPage(events, lastLedger)
    quarantineState = null
    return
  } catch (err) {
    if (err instanceof ReorgDetectedError) throw err

    const pageKey = pageKeyFor(events)
    const errorMessage = err instanceof Error ? err.message : String(err)
    if (quarantineState && quarantineState.pageKey === pageKey && quarantineState.errorMessage === errorMessage) {
      quarantineState.failures += 1
    } else {
      quarantineState = { pageKey, errorMessage, failures: 1 }
    }

    if (quarantineState.failures < config.indexer.quarantineAfterFailures) {
      // Might still be transient — let runIndexer's normal backoff-and-retry
      // give it another chance before concluding it's deterministic.
      throw err
    }

    console.error(
      `[indexer] page failed ${quarantineState.failures} consecutive times with the same error — ` +
        `switching to per-event quarantine mode. ${errorMessage}`
    )
    for (const raw of events) {
      const ev = decodeEvent(raw)
      await ingestEventQuarantined(ev, lastLedger)
    }
    quarantineState = null
  }
}

/**
 * Fetch events from the Soroban RPC and ingest them into Postgres.
 *
 * Issue #3: drains multiple pages when behind — keeps requesting while the
 * previous page came back full (events.length === pageLimit), bounded by
 * DRAIN_MAX_PAGES and DRAIN_MAX_MS. The cursor is advanced after every page
 * so progress survives a mid-drain crash.
 */
export async function fetchOnce(contractId: string): Promise<void> {
  const cursor = await loadCursor(contractId)

  // Coarse rewind check (issue #23): if the RPC's reported tip is below the
  // ledger we already folded to, the chain rewound past applied history.
  const tip = await getLatestLedgerInfo()
  const priorLedger = cursor?.last_ledger ?? 0
  if (priorLedger > 0 && tip.sequence < priorLedger) {
    throw new ReorgDetectedError(
      `RPC latest ledger ${tip.sequence} is below the last folded ledger ${priorLedger} — the chain rewound past applied history`
    )
  }

  const base = {
    filters: [{ type: 'contract' as const, contractIds: [contractId], topics: [] as string[][] }],
    limit: config.indexer.pageLimit,
  }
  const request: Parameters<typeof server.getEvents>[0] = cursor?.paging_token
    ? { ...base, cursor: cursor.paging_token }
    : { ...base, startLedger: await resolveStartLedger() }

  let currentRequest = request
  let totalPages = 0
  const drainStart = Date.now()
  let totalEvents = 0
  let lastLedger = cursor?.last_ledger ?? 0
  let observedTipLedger = cursor?.observed_tip_ledger ?? tip.sequence
  let cursorWritten = false

  for (;;) {
    // Check for shutdown signal between pages (issue #47): a SIGTERM
    // arriving mid-drain should stop after the in-flight page, not after
    // the full drain cap.
    if (abortController?.signal.aborted) {
      console.log(`[indexer] drain interrupted by shutdown after ${totalPages} page(s), ${totalEvents} event(s)`)
      break
    }

    const res = await server.getEvents(currentRequest)
    const events = res.events ?? []
    const pageCount = events.length

    await ingestPageWithQuarantine(events, lastLedger)
    totalPages += 1
    totalEvents += pageCount

    // Advance cursor after every page (issue #3: per-page cursor advancement).
    const last = events[events.length - 1]
    const nextToken = last?.id ?? res.cursor ?? currentRequest.cursor ?? null
    // Highest ledger actually folded (issue #45): only advances when this
    // page had events. An empty page must never fall through to the RPC tip
    // here — that conflated "folded to" with "chain is at", and a single
    // empty page during catch-up could jump this past ledgers a later, real
    // page would legitimately arrive at, tripping a false ReorgDetectedError.
    const foldedLedger = last?.ledger ?? lastLedger
    // RPC-observed chain tip, tracked separately — freshness reporting only,
    // never fed into the continuity check above or in ingestPage.
    const newObservedTip = res.latestLedger ?? observedTipLedger
    if (nextToken !== cursor?.paging_token || foldedLedger !== lastLedger || newObservedTip !== observedTipLedger) {
      await saveCursor(contractId, nextToken, foldedLedger, newObservedTip, tip.hash)
      lastLedger = foldedLedger
      observedTipLedger = newObservedTip
      cursorWritten = true
    }

    // Log catch-up progress distinctly from steady-state (issue #3).
    if (pageCount > 0) {
      console.log(`[indexer] page ${totalPages}: ingested ${pageCount} event(s) up to ledger ${foldedLedger}`)
    }

    // Stop draining if:
    //  - short page (tail reached)
    //  - max pages hit
    //  - wall-clock budget exhausted
    const isFullPage = pageCount >= config.indexer.pageLimit
    const pagesExhausted = totalPages >= config.indexer.maxDrainPages
    const timeExhausted = Date.now() - drainStart >= config.indexer.maxDrainMs

    if (!isFullPage || pagesExhausted || timeExhausted) {
      if (pagesExhausted || timeExhausted) {
        console.log(`[indexer] drain cap reached: ${totalPages} pages, ${totalEvents} events, ${Date.now() - drainStart}ms`)
      }
      break
    }

    // Build next request from the response cursor
    currentRequest = { ...base, cursor: res.cursor }
  }

  // On a genuinely idle contract with nothing new to report (no events, and
  // the observed tip/cursor didn't move either), touch updated_at so /ready
  // doesn't falsely report stale (issue #2 context note).
  if (totalEvents === 0 && !cursorWritten) {
    await touchCursor()
  } else if (totalPages > 1) {
    console.log(`[indexer] drain complete: ${totalPages} pages, ${totalEvents} events in ${Date.now() - drainStart}ms`)
  }
}

/** Resolves after `ms`, or immediately if `signal` aborts first (issue
 *  #121). The backoff delay after a failed poll can be up to
 *  `POLL_MAX_BACKOFF_MS` (60s by default) — without racing it against the
 *  abort signal, a SIGTERM arriving just after a failed poll would wait out
 *  the entire backoff before the loop in `runIndexer` re-checks and exits.
 *
 *  Exported so this can be tested directly: `runIndexer` itself needs
 *  CONTRACT_ID configured, which the test suite doesn't set. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Run the poll loop until stopped. Errors are logged and retried with
 *  exponential backoff (capped at `POLL_MAX_BACKOFF_MS`) so a stuck or down
 *  RPC endpoint doesn't get hammered every `pollIntervalMs`. The delay resets
 *  to the normal interval as soon as a poll succeeds. */
export async function runIndexer(): Promise<void> {
  if (running) {
    throw new Error('Indexer is already running — cannot start a second instance')
  }
  running = true
  abortController = new AbortController()

  const contractId = assertContractConfigured()
  await ensureCursorContract(contractId)
  console.log(`[indexer] watching ${contractId} on ${config.stellar.rpcUrl}`)
  let consecutiveFailures = 0
  try {
    while (!abortController.signal.aborted) {
      let delay = config.indexer.pollIntervalMs
      try {
        await fetchOnce(contractId)
        consecutiveFailures = 0
      } catch (err) {
        // A ledger discontinuity is not a transient error — retrying would
        // fold events from a diverged history. Halt loudly (issue #23).
        if (err instanceof ReorgDetectedError) {
          console.error(`[indexer] LEDGER DISCONTINUITY DETECTED — halting the indexer. ${err.message}`)
          console.error(
            `[indexer] Recovery: confirm the true chain state, then run \`npm run reindex\` to rebuild ` +
              `the derived tables from the raw events log. See README "Reorg detection".`
          )
          // Reorg halt is deliberate and permanent for this run — don't
          // reset, so the caller must explicitly restart (issue #48).
          throw err
        }
        const msg = err instanceof Error ? err.message : String(err)
        consecutiveFailures += 1
        delay = Math.min(
          config.indexer.pollIntervalMs * 2 ** consecutiveFailures,
          config.indexer.maxBackoffMs
        )
        console.error(
          `[indexer] poll error (${consecutiveFailures} consecutive): ${msg} — retrying in ${delay}ms`
        )
      }
      await sleep(delay, abortController.signal)
    }
  } finally {
    running = false
    abortController = null
  }
}

/** Signal the indexer to stop after the current page completes.
 *  Returns a promise that resolves once runIndexer() has fully exited. */
export function stopIndexer(): Promise<void> {
  console.log('[indexer] shutdown signal received — waiting for current page to complete')
  if (!abortController || !running) return Promise.resolve()
  abortController.abort()

  // Poll until the run loop has fully exited so callers (worker.ts) can
  // safely close the connection pool after this resolves.
  return new Promise<void>((resolve) => {
    const check = () => {
      if (!running) { resolve(); return }
      setTimeout(check, 50)
    }
    check()
  })
}
