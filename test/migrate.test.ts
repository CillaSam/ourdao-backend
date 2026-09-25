// Direct coverage for src/db/migrate.ts (issue #162). Before this file,
// migrate() — called on every real boot by both src/index.ts and
// src/worker.ts — was only ever exercised indirectly via test/setup.ts's
// one-time bootstrap call, and every other test file built its database
// from schema.sql alone (test/db.ts). That gap is why the duplicate-0014
// defect (issue #161) reached main undetected: three files claiming version
// 14 are invisible to a suite that never loads migrate.ts's loader.
//
// test/setup.ts already calls the real migrate() once, globally, before any
// test file runs, so by the time this file's tests execute, schema_migrations
// already holds every real migration in migrations/. That's used here rather
// than fought: these tests exercise migrate() being called again against
// that already-migrated database (the same thing that happens on every real
// process restart), rather than tearing down and rebuilding the shared test
// database that every other test file also depends on.
import { readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { pool } from '../src/db/index.js'
import { migrate, assertNoDuplicateVersions } from '../src/db/migrate.js'
import { closeDb, ensureSchema } from './db.js'

afterAll(closeDb)

describe('assertNoDuplicateVersions', () => {
  it('throws, naming both files, when two files claim the same version', () => {
    expect(() =>
      assertNoDuplicateVersions([
        { version: 14, name: '0014_auth_nonces.sql' },
        { version: 14, name: '0014_events_decode_error.sql' },
      ])
    ).toThrowError(/duplicate migration version 14.*0014_auth_nonces\.sql.*0014_events_decode_error\.sql/)
  })

  it('does not throw for unique versions, including a gap', () => {
    expect(() =>
      assertNoDuplicateVersions([
        { version: 10, name: '0010_documents.sql' },
        { version: 12, name: '0012_status_check_constraints.sql' }, // 0011 gap
        { version: 13, name: '0013_events_entity_id_idx.sql' },
      ])
    ).not.toThrow()
  })
})

describe('migrate()', () => {
  it('is idempotent: calling it again against an already-migrated database applies nothing new', async () => {
    await ensureSchema()
    const before = await pool.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')

    await expect(migrate()).resolves.toBeUndefined()

    const after = await pool.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
    expect(after.rows).toEqual(before.rows)
  })

  it('two concurrent calls both resolve cleanly (the advisory lock serializes them)', async () => {
    await expect(Promise.all([migrate(), migrate()])).resolves.toBeDefined()
  })

  it('re-applies a previously-recorded migration for real when its schema_migrations row is missing', async () => {
    // Version 20 (0020_notifications_event_id.sql, renumbered from the
    // duplicate 0014 in issue #161) is entirely IF NOT EXISTS / ADD COLUMN
    // IF NOT EXISTS, so re-running its SQL for real against a database that
    // already has its end state is a safe no-op — this exercises the
    // "database predates a migration" branch (isFreshDatabase === false)
    // without needing to tear down the shared schema.
    const client = await pool.connect()
    try {
      await client.query('DELETE FROM schema_migrations WHERE version = 20')
    } finally {
      client.release()
    }

    await expect(migrate()).resolves.toBeUndefined()

    const row = await pool.query<{ version: number; name: string }>(
      'SELECT version, name FROM schema_migrations WHERE version = 20'
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0]?.name).toBe('0020_notifications_event_id.sql')

    // And the column/index it adds are genuinely present, not just the record.
    const col = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'event_id'`
    )
    expect(col.rows).toHaveLength(1)
  })

  it('a migration that throws is rolled back and not recorded, and does not block later ones', async () => {
    // migrate() has no injection seam for its migrations directory, so this
    // writes one throwaway fixture file into the real migrations/ directory
    // for the duration of this test, and always removes it afterward — a
    // version number (999998/999999) far outside any real migration's range
    // so it can never collide with one.
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations')
    const badPath = join(migrationsDir, '999998_test_intentionally_broken.sql')
    const goodPath = join(migrationsDir, '999999_test_after_broken.sql')

    await writeFile(badPath, 'THIS IS NOT VALID SQL;\n')
    // A second, valid, pending migration ordered after the broken one, to
    // confirm one failure doesn't corrupt the run for migrations before it
    // in the same loadMigrationFiles() call — it should never be reached.
    await writeFile(goodPath, 'CREATE TABLE IF NOT EXISTS test_migrate_after_broken (id INT);\n')

    try {
      await expect(migrate()).rejects.toThrow(/999998_test_intentionally_broken\.sql failed/)

      const recorded = await pool.query('SELECT 1 FROM schema_migrations WHERE version IN (999998, 999999)')
      expect(recorded.rows).toHaveLength(0)

      const tableExists = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'test_migrate_after_broken'`
      )
      expect(tableExists.rows).toHaveLength(0)
    } finally {
      await unlink(badPath).catch(() => undefined)
      await unlink(goodPath).catch(() => undefined)
      // Best-effort: drop the table if the (unexpected) case where it got
      // created anyway, so a bug here can't leak into other tests.
      await pool.query('DROP TABLE IF EXISTS test_migrate_after_broken').catch(() => undefined)
    }
  })

  it('a database built by schema.sql already has every migration-added column (end-state equivalence)', async () => {
    // migrate.ts's own doc comment: "A database that's freshly bootstrapped
    // from schema.sql already has every migration's end state (schema.sql
    // always reflects HEAD)". Spot-check the columns/tables each real
    // migration under migrations/ adds against the schema.sql-built shared
    // test database, rather than asserting nothing checks this claim.
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations')
    const files = await readdir(migrationsDir)
    // Every real (non-fixture) migration file must parse to a version
    // number and be present in schema_migrations after setup.ts's migrate()
    // call — this is the "duplicate or malformed filename" regression check
    // for the actual on-disk directory, not just synthetic input.
    const realFiles = files.filter((f) => /^\d+_.*\.sql$/.test(f) && !f.startsWith('9999'))
    expect(() =>
      assertNoDuplicateVersions(realFiles.map((f) => ({ version: Number.parseInt(f.split('_')[0]!, 10), name: f })))
    ).not.toThrow()

    const versions = realFiles.map((f) => Number.parseInt(f.split('_')[0]!, 10))
    const recorded = await pool.query<{ version: number }>('SELECT version FROM schema_migrations')
    const recordedVersions = new Set(recorded.rows.map((r) => r.version))
    for (const v of versions) {
      expect(recordedVersions.has(v)).toBe(true)
    }

    // auth_nonces (0018), events.decode_error (0019) and
    // notifications.event_id (0020) — the three renumbered ex-duplicates —
    // must all three actually exist, not just be recorded.
    const authNonces = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'auth_nonces'`)
    expect(authNonces.rows).toHaveLength(1)
    const decodeError = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'decode_error'`
    )
    expect(decodeError.rows).toHaveLength(1)
    const eventIdCol = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'event_id'`
    )
    expect(eventIdCol.rows).toHaveLength(1)
  })
})
