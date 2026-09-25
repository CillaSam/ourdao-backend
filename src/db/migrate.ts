import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from './index.js'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, 'migrations')

// Arbitrary fixed key for a session-level advisory lock, scoped to this
// database. The API and worker both call migrate() on startup; without a
// lock they'd race to apply the same pending migration concurrently.
// IF NOT EXISTS makes that harmless for schema.sql's CREATE statements, but
// a real ALTER (see migrations/) is not safe to run twice in parallel.
const MIGRATION_LOCK_KEY = 0x0d40_0000

export interface MigrationFile {
  version: number
  name: string
  path: string
}

// Issue #161: three files once silently shared version 14 — only one was
// ever recorded in schema_migrations (ON CONFLICT DO NOTHING swallowed the
// other two inserts), and readdir's filesystem-dependent order meant which
// file "won", and which two ran with no record they had, varied by
// environment. Exported (and factored out of loadMigrationFiles) so it can
// be unit tested directly against synthetic filenames, without needing a
// real migrations/ directory on disk.
export function assertNoDuplicateVersions(files: readonly Pick<MigrationFile, 'version' | 'name'>[]): void {
  const seenBy = new Map<number, string>()
  for (const file of files) {
    const prior = seenBy.get(file.version)
    if (prior) {
      throw new Error(
        `duplicate migration version ${file.version}: ${prior} and ${file.name} both claim it`
      )
    }
    seenBy.set(file.version, file.name)
  }
}

async function loadMigrationFiles(): Promise<MigrationFile[]> {
  let entries: string[]
  try {
    entries = await readdir(migrationsDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const files = entries
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => ({ version: Number.parseInt(f.split('_')[0]!, 10), name: f, path: join(migrationsDir, f) }))
    .sort((a, b) => a.version - b.version)

  assertNoDuplicateVersions(files)

  // Gaps (version 0011 is missing — a migration was renamed or lost at some
  // point before this repo's current history) are allowed deliberately.
  // loadMigrationFiles only needs versions to be unique and applied in
  // increasing order; unlike a duplicate, a gap can't cause a migration to
  // be skipped or mis-recorded, so it isn't worth failing the boot over.
  return files
}

/**
 * Apply the schema.
 *
 * schema.sql is the bootstrap baseline: idempotent CREATE ... IF NOT EXISTS
 * statements describing the *current* desired shape, safe to run on every
 * boot. It's sufficient for a brand-new database, but IF NOT EXISTS cannot
 * express changing something that already exists — an added column, a
 * widened type. Those live as numbered files in migrations/ and are applied
 * here, in order, exactly once per database, tracked in schema_migrations.
 *
 * A database that's freshly bootstrapped from schema.sql already has every
 * migration's end state (schema.sql always reflects HEAD), so pending
 * migrations are recorded as applied without re-running their SQL. A
 * database that predates a migration gets that migration's SQL executed for
 * real. Serialized across the API/worker with a Postgres advisory lock.
 */
export async function migrate(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    try {
      const schemaSql = await readFile(join(here, 'schema.sql'), 'utf8')
      await client.query(schemaSql)

      const migrations = await loadMigrationFiles()
      if (migrations.length === 0) return

      const applied = await client.query<{ version: number }>('SELECT version FROM schema_migrations')
      const appliedVersions = new Set(applied.rows.map((r) => r.version))
      const isFreshDatabase = appliedVersions.size === 0

      for (const migration of migrations) {
        if (appliedVersions.has(migration.version)) continue

        if (isFreshDatabase) {
          // schema.sql just created this migration's end state directly;
          // record it as applied without re-running its SQL.
          await client.query(
            'INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
            [migration.version, migration.name]
          )
          // Issue #161: keep the in-memory set current so a later iteration
          // of this same loop can never be misled by a stale snapshot —
          // defense in depth now that versions are guaranteed unique, not a
          // fix in itself (this loop only ever visits each version once).
          appliedVersions.add(migration.version)
          continue
        }

        const sql = await readFile(migration.path, 'utf8')
        await client.query('BEGIN')
        try {
          await client.query(sql)
          await client.query(
            'INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
            [migration.version, migration.name]
          )
          await client.query('COMMIT')
          appliedVersions.add(migration.version)
          console.log(`[db] applied migration ${migration.name}`)
        } catch (err) {
          await client.query('ROLLBACK')
          throw new Error(`migration ${migration.name} failed: ${(err as Error).message}`, { cause: err })
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
    }
  } finally {
    client.release()
  }
}

// Allow running directly: `npm run migrate`.
/* v8 ignore start -- run-directly entrypoint, exercised as a subprocess not by vitest (#79) */
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => {
      console.log('[db] schema applied')
      return pool.end()
    })
    .catch((err) => {
      console.error('[db] migration failed:', err)
      process.exit(1)
    })
}
/* v8 ignore stop */
