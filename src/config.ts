import 'dotenv/config'

export function str(env: NodeJS.ProcessEnv, name: string, fallback = ''): string {
  const v = env[name]
  return v === undefined || v === '' ? fallback : v
}

export function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v.trim())
  return Number.isFinite(n) && Number.isInteger(n) ? n : fallback
}

export function bool(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const v = env[name]
  if (v === undefined || v === '') return fallback
  return v === 'true' || v === '1'
}

/** Pino log levels as documented at https://getpino.io/#/docs/api?id=level */
const PINO_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])

/** Parse a log level string, falling back to 'info' if invalid or empty. */
export function logLevel(env: NodeJS.ProcessEnv, name: string, fallback = 'info'): string {
  const v = env[name]
  if (v === undefined || v === '') return fallback
  const level = v.trim().toLowerCase()
  return PINO_LEVELS.has(level) ? level : fallback
}

const NONCE_STORES = new Set(['postgres', 'memory'])

/**
 * Parse the NONCE_STORE env var, falling back to 'postgres' (with a logged
 * warning) for anything unrecognized. An unvalidated typo here used to
 * silently downgrade to the in-memory store — the exact multi-instance auth
 * failure issue #66 was filed to fix (issue #118).
 */
export function nonceStore(env: NodeJS.ProcessEnv, name: string, fallback: 'postgres' | 'memory' = 'postgres'): 'postgres' | 'memory' {
  const v = env[name]
  if (v === undefined || v === '') return fallback
  const value = v.trim().toLowerCase()
  if (NONCE_STORES.has(value)) return value as 'postgres' | 'memory'
  console.warn(`[config] Invalid NONCE_STORE "${v}" — falling back to "${fallback}". Expected one of: ${[...NONCE_STORES].join(', ')}`)
  return fallback
}

/**
 * Parse the CORS_ORIGIN env var into a Fastify-compatible origin value.
 *
 * - `"*"` → `"*"` (opt-in to wide-open CORS, triggers a warning)
 * - Comma-separated list → trimmed, de-deduplicated, empty entries dropped
 * - Unset / empty → `"http://localhost:3000"` (safe default)
 *
 * Exported so tests can exercise it without fighting import-time side effects.
 */
export function parseCorsOrigin(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return 'http://localhost:3000'
  if (trimmed === '*') return '*'
  const origins = [...new Set(trimmed.split(',').map((o) => o.trim()).filter(Boolean))]
  return origins.length === 1 ? origins[0]! : origins.join(',')
}

/** Resolved runtime configuration, read once at import time. */
export function resolveConfig(env: NodeJS.ProcessEnv) {
  return {
  http: {
    port: int(env, 'PORT', 4000),
    host: str(env, 'HOST', '0.0.0.0'),
    corsOrigin: parseCorsOrigin(env.CORS_ORIGIN),
    rateLimitMax: int(env, 'RATE_LIMIT_MAX', 100),
    rateLimitWindowMs: int(env, 'RATE_LIMIT_WINDOW_MS', 60_000),
    rateLimitEventsMax: int(env, 'RATE_LIMIT_EVENTS_MAX', 30),
    trustProxy: str(env, 'TRUST_PROXY', 'false'),
    // How long (ms) an in-process /api/stats result is reused before it is
    // recomputed (issue #18). A burst of polls inside this window collapses
    // to one set of queries. The reported figures — counts and the freshness
    // signal alike — are then at most this stale, which is well under
    // INDEXER_STALE_AFTER_MS. In-process only: with more than one API
    // instance they may briefly disagree.
    statsCacheMs: int(env, 'STATS_CACHE_MS', 5_000),
    // Pino log level for the Fastify server (fatal, error, warn, info, debug, trace, silent).
    // 'silent' suppresses all request logging, which the test harness uses.
    logLevel: logLevel(env, 'LOG_LEVEL', 'info'),
  },
  db: {
    // pg reads PG* env vars automatically; connectionString wins when set.
    connectionString: str(env, 'DATABASE_URL') || undefined,
    // Nonce store implementation: 'postgres' for production (multi-instance), 'memory' for testing (issue #66)
    nonceStore: nonceStore(env, 'NONCE_STORE', 'postgres'),
  },
  stellar: {
    contractId: str(env, 'CONTRACT_ID'),
    rpcUrl: str(env, 'SOROBAN_RPC_URL', 'https://soroban-testnet.stellar.org'),
    networkPassphrase: str(env, 'NETWORK_PASSPHRASE', 'Test SDF Network ; September 2015'),
  },
  indexer: {
    startLedger: int(env, 'START_LEDGER', 0),
    startLookbackLedgers: int(env, 'START_LOOKBACK_LEDGERS', 17280),
    pollIntervalMs: int(env, 'POLL_INTERVAL_MS', 5000),
    pageLimit: int(env, 'EVENTS_PAGE_LIMIT', 100),
    // Cap for the exponential backoff applied after consecutive poll failures.
    maxBackoffMs: int(env, 'POLL_MAX_BACKOFF_MS', 60_000),
    // Max pages to drain per poll iteration (issue #3).
    maxDrainPages: int(env, 'DRAIN_MAX_PAGES', 20),
    // Max wall-clock ms for a single drain cycle (issue #3).
    maxDrainMs: int(env, 'DRAIN_MAX_MS', 30_000),
    // How long (ms) the indexer cursor can be idle before /ready reports stale.
    staleAfterMs: int(env, 'INDEXER_STALE_AFTER_MS', 120_000),
    // After this many consecutive whole-page failures with the same error on
    // the same page, the poller treats the failure as deterministic rather
    // than transient and quarantines the offending event(s) instead of
    // retrying forever (issue #43).
    quarantineAfterFailures: int(env, 'INDEXER_QUARANTINE_AFTER_FAILURES', 3),
    // When CONTRACT_ID no longer matches the contract the saved cursor was
    // last advanced for (a redeploy — the contract has no upgrade path), the
    // indexer refuses to start so two deployments' state can't merge (issue
    // #16). Set this to `true` for exactly one boot to wipe the cursor and
    // every derived table and re-index the new contract from scratch. The
    // raw `events` log is left intact as an audit trail.
    resetOnContractChange: bool(env, 'INDEXER_RESET_ON_CONTRACT_CHANGE', false),
  },
  } as const
}

/** Resolved runtime configuration, read once at import time. */
export const config = resolveConfig(process.env)

export type Config = typeof config

export function assertContractConfigured(resolvedConfig: Config = config): string {
  if (!resolvedConfig.stellar.contractId) {
    throw new Error(
      'CONTRACT_ID is not set. The indexer needs the deployed OurDAO contract id to poll events.'
    )
  }
  return resolvedConfig.stellar.contractId
}
