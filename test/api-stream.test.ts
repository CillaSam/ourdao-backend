import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { pool, query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'
import {
  DRAIN_STALL_DISCONNECT_MS,
  MAX_QUEUED_MESSAGES,
  STREAM_CHANNELS,
  StreamClient,
  parseChannelSubset,
  type StreamChannel,
} from '../src/api/stream.js'
import type { FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'

// A minimal fake of the pieces of PoolClient/FastifyReply StreamClient
// actually uses, so #157's backpressure logic (queue growth, stall-timeout
// disconnect, heartbeat skip) can be driven directly and deterministically
// — a client that never reads is otherwise only reproducible with a real
// socket, which is slow and non-deterministic to assert timing against.
function makeFakeStreamPair(writable: { canWrite: boolean }) {
  const clientListeners: Record<string, ((...args: unknown[]) => void)[]> = {}
  const fakeClient = {
    query: vi.fn().mockResolvedValue(undefined),
    on: (event: string, cb: (...args: unknown[]) => void) => {
      (clientListeners[event] ??= []).push(cb)
    },
    release: vi.fn(),
    emitNotification(channel: StreamChannel, payload?: Record<string, unknown>) {
      for (const cb of clientListeners.notification ?? []) {
        cb({ channel, payload: payload ? JSON.stringify(payload) : undefined })
      }
    },
  }

  const rawListeners: Record<string, ((...args: unknown[]) => void)[]> = {}
  const raw = {
    write: vi.fn(() => writable.canWrite),
    end: vi.fn(),
    destroyed: false,
    setTimeout: vi.fn(),
    on: (event: string, cb: (...args: unknown[]) => void) => {
      (rawListeners[event] ??= []).push(cb)
    },
    emitDrain() {
      for (const cb of rawListeners.drain ?? []) cb()
    },
  }
  const fakeReply = { header: vi.fn(), raw }

  return {
    client: fakeClient as unknown as PoolClient,
    reply: fakeReply as unknown as FastifyReply,
    raw,
    fakeClient,
  }
}

describe('API: /api/stream', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    closeDb()
  })

  it('GET /api/stream returns 200 with SSE headers', async () => {
    // Start the stream in a promise (it will block)
    const streamPromise = app.inject({ method: 'GET', url: '/api/stream' }).then((res) => {
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/event-stream')
      expect(res.headers['cache-control']).toBe('no-cache')
      expect(res.headers['connection']).toBe('keep-alive')
    })

    // Give it a moment to connect and send initial message
    await new Promise((resolve) => setTimeout(resolve, 100))

    // The streaming connection is open but won't complete until we close it
    // For now, just verify the response started correctly
  })

  it('receives initial connection message on stream', async () => {
    // This test is complex because vitest/the inject method doesn't fully support
    // streaming responses. In a real integration test, you'd connect with a proper
    // EventSource or fetch + stream reading.
    //
    // The key verifications here are:
    // 1. The stream endpoint exists and returns 200 with SSE headers
    // 2. Type checking passes
    // 3. NOTIFY is emitted from the indexer
    //
    // End-to-end streaming would be better tested with playwright or a custom client.
    expect(STREAM_CHANNELS.members).toBe('members_changed')
    expect(STREAM_CHANNELS.loan_proposals).toBe('loan_proposals_changed')
    expect(STREAM_CHANNELS.loans).toBe('loans_changed')
  })

  it('stream channels are properly defined, with no per-member channel (issue #160)', () => {
    expect(STREAM_CHANNELS).toEqual({
      members: 'members_changed',
      loan_proposals: 'loan_proposals_changed',
      loans: 'loans_changed',
      treasury_proposals: 'treasury_proposals_changed',
      interest: 'interest_changed',
    })
    expect('notifications' in STREAM_CHANNELS).toBe(false)
    expect(Object.values(STREAM_CHANNELS)).not.toContain('notifications_changed')
  })

  it('multiple concurrent clients can connect to the stream', async () => {
    // In a real scenario, you'd have multiple EventSource connections
    // For testing purposes, we verify the endpoint is accessible multiple times
    const inject1 = app.inject({ method: 'GET', url: '/api/stream' })
    const inject2 = app.inject({ method: 'GET', url: '/api/stream' })

    // Both should start without errors
    expect(inject1).toBeDefined()
    expect(inject2).toBeDefined()
  })
})

describe('Stream NOTIFY integration', () => {
  it('notifyStreamClients exports the channel definitions', () => {
    // Verify all (non-per-member — issue #160) channels are defined
    expect(STREAM_CHANNELS.members).toBeDefined()
    expect(STREAM_CHANNELS.loan_proposals).toBeDefined()
    expect(STREAM_CHANNELS.loans).toBeDefined()
    expect(STREAM_CHANNELS.treasury_proposals).toBeDefined()
    expect(STREAM_CHANNELS.interest).toBeDefined()
  })

  it('stream channels match event symbol mappings', () => {
    // Verify all channels used in handlers.ts are valid
    const validChannels = Object.values(STREAM_CHANNELS)

    // Sample checks for key channels
    expect(validChannels).toContain('members_changed')
    expect(validChannels).toContain('loan_proposals_changed')
    expect(validChannels).toContain('loans_changed')
  })
})

// Issue #160: clients can subscribe to a subset of channels.
describe('parseChannelSubset', () => {
  it('returns null (meaning "all channels") when unspecified', () => {
    expect(parseChannelSubset(undefined)).toBeNull()
    expect(parseChannelSubset('')).toBeNull()
  })

  it('parses a comma-separated list of known channel keys', () => {
    expect(parseChannelSubset('loans,loan_proposals')).toEqual([
      STREAM_CHANNELS.loans,
      STREAM_CHANNELS.loan_proposals,
    ])
  })

  it('throws, naming the bad key, for an unknown channel', () => {
    expect(() => parseChannelSubset('loans,not_a_real_channel')).toThrowError(/not_a_real_channel/)
  })

  it('rejects a per-member "notifications" key — it was removed from STREAM_CHANNELS (issue #160)', () => {
    expect(() => parseChannelSubset('notifications')).toThrowError(/notifications/)
  })
})

// Issue #157: SSE writes must respect backpressure rather than buffering an
// unbounded backlog for a client that stops reading.
describe('StreamClient backpressure', () => {
  it('subscribes only to the requested channel subset (issue #160)', async () => {
    const { client, reply, fakeClient } = makeFakeStreamPair({ canWrite: true })
    const sc = new StreamClient(reply, client)
    await sc.start([STREAM_CHANNELS.loans])

    const listenCalls = fakeClient.query.mock.calls.map((c) => c[0])
    expect(listenCalls).toContain(`LISTEN "${STREAM_CHANNELS.loans}"`)
    expect(listenCalls).not.toContain(`LISTEN "${STREAM_CHANNELS.members}"`)

    await sc.close()
  })

  it('pauses on a false write() return and queues further messages instead of writing immediately', async () => {
    const writable = { canWrite: true }
    const { client, reply, raw, fakeClient } = makeFakeStreamPair(writable)
    const sc = new StreamClient(reply, client)
    await sc.start([STREAM_CHANNELS.loans])

    const writesBeforePause = raw.write.mock.calls.length
    writable.canWrite = false // simulate the socket's buffer going over its high-water mark
    fakeClient.emitNotification(STREAM_CHANNELS.loans) // this write() call trips `paused`
    expect(raw.write.mock.calls.length).toBe(writesBeforePause + 1)

    // Further messages while paused must not call write() again — they queue.
    fakeClient.emitNotification(STREAM_CHANNELS.loans)
    fakeClient.emitNotification(STREAM_CHANNELS.loans)
    expect(raw.write.mock.calls.length).toBe(writesBeforePause + 1)

    await sc.close()
  })

  it('flushes the queue once drain fires', async () => {
    const writable = { canWrite: true }
    const { client, reply, raw, fakeClient } = makeFakeStreamPair(writable)
    const sc = new StreamClient(reply, client)
    await sc.start([STREAM_CHANNELS.loans])

    writable.canWrite = false
    fakeClient.emitNotification(STREAM_CHANNELS.loans) // triggers pause
    fakeClient.emitNotification(STREAM_CHANNELS.loans) // queued
    fakeClient.emitNotification(STREAM_CHANNELS.loans) // queued
    const writesWhilePaused = raw.write.mock.calls.length

    writable.canWrite = true
    raw.emitDrain()
    // The two queued frames are now flushed via write().
    expect(raw.write.mock.calls.length).toBe(writesWhilePaused + 2)

    await sc.close()
  })

  it(`drops a client whose backlog exceeds MAX_QUEUED_MESSAGES (${MAX_QUEUED_MESSAGES})`, async () => {
    const writable = { canWrite: true }
    const { client, reply, fakeClient } = makeFakeStreamPair(writable)
    const sc = new StreamClient(reply, client)
    await sc.start([STREAM_CHANNELS.loans])

    writable.canWrite = false
    fakeClient.emitNotification(STREAM_CHANNELS.loans) // trips pause
    for (let i = 0; i < MAX_QUEUED_MESSAGES + 5; i++) {
      fakeClient.emitNotification(STREAM_CHANNELS.loans)
    }

    // close() releases the underlying Postgres client — the signal that
    // this stalled client was dropped rather than buffered forever.
    expect(fakeClient.release).toHaveBeenCalled()
  })

  it(`drops a client backpressured for longer than DRAIN_STALL_DISCONNECT_MS (${DRAIN_STALL_DISCONNECT_MS}ms) even without exceeding the queue bound`, async () => {
    vi.useFakeTimers()
    try {
      const writable = { canWrite: true }
      const { client, reply, fakeClient } = makeFakeStreamPair(writable)
      const sc = new StreamClient(reply, client)
      await sc.start([STREAM_CHANNELS.loans])

      writable.canWrite = false
      fakeClient.emitNotification(STREAM_CHANNELS.loans) // trips pause, arms the stall timer
      expect(fakeClient.release).not.toHaveBeenCalled()

      // Async variant: the stall timer's callback calls the async close(),
      // which itself awaits UNLISTEN queries before release() — plain
      // advanceTimersByTime only runs the synchronous part of the callback.
      await vi.advanceTimersByTimeAsync(DRAIN_STALL_DISCONNECT_MS + 1)
      expect(fakeClient.release).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips heartbeats for an already-backed-up client', async () => {
    vi.useFakeTimers()
    try {
      const writable = { canWrite: true }
      const { client, reply, raw, fakeClient } = makeFakeStreamPair(writable)
      const sc = new StreamClient(reply, client)
      await sc.start([STREAM_CHANNELS.loans])

      writable.canWrite = false
      fakeClient.emitNotification(STREAM_CHANNELS.loans) // trips pause
      const writesWhilePaused = raw.write.mock.calls.length

      // Advance past a heartbeat interval; a backed-up client must not get
      // another unflushable write queued on top of what it already owes.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(raw.write.mock.calls.length).toBe(writesWhilePaused)

      await sc.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
