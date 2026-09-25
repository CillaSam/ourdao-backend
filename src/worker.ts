import { migrate } from './db/migrate.js'
import { pool } from './db/index.js'
import { runIndexer, stopIndexer } from './indexer/poller.js'

const SHUTDOWN_TIMEOUT_MS = 10_000

async function main(): Promise<void> {
  await migrate()

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[indexer] received ${signal} — waiting for current page to complete`)

    // Wait for the indexer loop to finish its current page and exit,
    // bounded so a wedged RPC call can't hang shutdown forever (issue #47).
    const stopPromise = stopIndexer()
    let timedOut = false
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true
        resolve()
      }, SHUTDOWN_TIMEOUT_MS)
    })
    await Promise.race([stopPromise, timeout])

    if (timedOut) {
      // stopIndexer() never resolved within the budget — closing the pool
      // now risks doing so mid-transaction (issue #122). The backoff sleep
      // is abort-aware (issue #121), so runIndexer's loop should exit almost
      // immediately once signaled; hitting this budget instead means
      // something else is stuck (a wedged RPC call, a long-running query)
      // and is worth investigating, not a normal shutdown path.
      console.error(
        `[indexer] shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — closing the pool anyway; ` +
          `the indexer loop may still have been mid-transaction`
      )
    }

    console.log('[indexer] closing database pool')
    await pool.end()
    console.log('[indexer] shutdown complete')
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await runIndexer()
}

main().catch((err) => {
  console.error('[indexer] fatal:', err)
  process.exit(1)
})
