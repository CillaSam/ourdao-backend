// Issue #121: the backoff delay after a failed poll (up to POLL_MAX_BACKOFF_MS,
// 60s by default) used to be a bare setTimeout with no signal wired to it, so
// a shutdown arriving just after a failed poll wasn't noticed until the full
// backoff elapsed. That's also the root cause behind issue #122 (worker.ts
// closing the pool mid-transaction): SHUTDOWN_TIMEOUT_MS is only 10s, so the
// timeout branch would win whenever shutdown landed during backoff.
//
// `sleep` is exported from poller.ts specifically for this — runIndexer()
// itself requires CONTRACT_ID to be configured, which the test suite doesn't
// set (other indexer tests exercise fetchOnce() directly instead, passing the
// contract id as an argument), so this is the direct way to pin the fixed
// behavior down.
import { describe, expect, it } from 'vitest'
import { sleep } from '../src/indexer/poller.js'

describe('indexer: backoff sleep is abort-aware (issue #121)', () => {
  it('resolves almost immediately when the signal aborts partway through a long delay, instead of waiting it out', async () => {
    const controller = new AbortController()
    const start = Date.now()
    const pending = sleep(5_000, controller.signal)
    setTimeout(() => controller.abort(), 20)
    await pending
    // Well under the 5s delay — an unfixed sleep would only resolve at ~5000ms.
    expect(Date.now() - start).toBeLessThan(1_000)
  })

  it('resolves immediately if the signal is already aborted before the call', async () => {
    const controller = new AbortController()
    controller.abort()
    const start = Date.now()
    await sleep(5_000, controller.signal)
    expect(Date.now() - start).toBeLessThan(100)
  })

  it('still waits out the full delay when the signal never aborts', async () => {
    const controller = new AbortController()
    const start = Date.now()
    await sleep(60, controller.signal)
    expect(Date.now() - start).toBeGreaterThanOrEqual(55)
  })

  it('still waits out the full delay when called with no signal at all', async () => {
    const start = Date.now()
    await sleep(60)
    expect(Date.now() - start).toBeGreaterThanOrEqual(55)
  })
})
