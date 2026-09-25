import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Pool } from 'pg'
import type { PoolClient } from 'pg'

/**
 * Server-Sent Events stream for real-time updates (issue #63).
 *
 * Clients connect to GET /api/stream and receive change notifications as events are
 * folded by the indexer. The stream uses Postgres LISTEN/NOTIFY to coordinate
 * between the indexer and connected clients.
 *
 * The stream sends lightweight change signals like "loan_proposals changed" rather
 * than full payloads — clients refetch what they need via existing endpoints.
 *
 * Multiple API instances each LISTEN independently and fan out to their own clients,
 * which is correct without coordination.
 */

export interface StreamMessage {
  type: 'heartbeat' | 'notification' | 'error'
  channel?: string
  payload?: Record<string, unknown>
  timestamp: number
}

/**
 * Event channels for notifications (issue #63).
 * Sent by the indexer via NOTIFY when state changes.
 *
 * Issue #160: this deliberately does NOT include a `notifications_changed`
 * channel. `/api/stream` is unauthenticated and broadcasts to every
 * connected client; the five channels below describe DAO-wide state (fine
 * to broadcast to anyone), but per-member data belongs only on the
 * authenticated GET /api/notifications, which is exactly why that endpoint
 * requires authentication in the first place. A prior version of this file
 * did LISTEN on a `notifications_changed` channel, but nothing anywhere in
 * this codebase ever NOTIFYs it — it was dead wiring, not a live leak — but
 * leaving it in place was a trap: adding a real per-member NOTIFY later
 * would have silently broadcast it to anyone, unauthenticated, with no
 * additional review forcing the question. Clients poll their own feed via
 * GET /api/notifications instead. See README's Security Notes section for
 * the stream's full privacy properties.
 */
export const STREAM_CHANNELS = {
  members: 'members_changed',
  loan_proposals: 'loan_proposals_changed',
  loans: 'loans_changed',
  treasury_proposals: 'treasury_proposals_changed',
  interest: 'interest_changed',
} as const

export type StreamChannel = typeof STREAM_CHANNELS[keyof typeof STREAM_CHANNELS]

// Issue #157: bound what is queued per client rather than letting a stalled
// reader's backlog grow without limit. A client further behind than this
// many messages is dropped — a consumer that can't keep up is better cut
// off than buffered forever. Exported so tests can drive exactly this many
// messages rather than hardcoding a duplicate magic number.
export const MAX_QUEUED_MESSAGES = 200

// Issue #157: if a write has been backpressured (paused, awaiting 'drain')
// for longer than this with no progress, the client is dropped even if its
// queue hasn't hit MAX_QUEUED_MESSAGES yet — e.g. a socket that receives
// only occasional low-volume notifications could otherwise sit paused
// indefinitely, holding its dedicated LISTEN/NOTIFY Postgres connection
// forever without ever growing its queue enough to trip that bound.
export const DRAIN_STALL_DISCONNECT_MS = 30_000

// Issue #157: transport-level backstop. A healthy connection always has
// outbound traffic at least every 30s (the heartbeat), so this never fires
// for one; a genuinely stalled socket (suspended mobile browser, slept
// laptop, dead link) is eventually closed by Node itself even if nothing
// above ever notices.
export const SOCKET_IDLE_TIMEOUT_MS = 60_000

/**
 * Manage a single SSE client connection.
 * Handles LISTEN subscriptions and sends events as they arrive.
 */
export class StreamClient {
  private reply: FastifyReply
  private client: PoolClient
  private channels: Set<StreamChannel> = new Set()
  private heartbeatTimer: NodeJS.Timeout | null = null
  private closed = false
  // Issue #157: `false` from reply.raw.write() means the stream's internal
  // buffer is above its high-water mark — the caller (us) is supposed to
  // stop writing until 'drain'. `paused` tracks that; frames sent while
  // paused go to `queue` instead of straight to the socket.
  private paused = false
  private queue: string[] = []
  private stallTimer: NodeJS.Timeout | null = null

  constructor(reply: FastifyReply, client: PoolClient) {
    this.reply = reply
    this.client = client
  }

  /**
   * Set up the SSE response headers and begin listening for notifications.
   *
   * `channels` lets a client subscribe to a subset (issue #160's query
   * parameter) — defaults to every broadcast channel, matching the
   * previous unconditional-subscribe behavior for a client that doesn't ask.
   */
  async start(channels: readonly StreamChannel[] = Object.values(STREAM_CHANNELS)): Promise<void> {
    this.reply.header('Content-Type', 'text/event-stream')
    this.reply.header('Cache-Control', 'no-cache')
    this.reply.header('Connection', 'keep-alive')
    this.reply.header('X-Accel-Buffering', 'no') // Disable nginx buffering

    // Issue #157: transport-level backstop — closed automatically by Node
    // if the socket sits idle (no reads or writes) this long, independent
    // of anything below noticing.
    this.reply.raw.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => {
      void this.close()
    })

    // Issue #157: resume writing once the stream's buffer has drained below
    // its low-water mark.
    this.reply.raw.on('drain', () => {
      this.paused = false
      this.clearStallTimer()
      this.flushQueue()
    })

    // Subscribe to the requested channels (all of them, if unspecified)
    for (const channel of channels) {
      await this.client.query(`LISTEN "${channel}"`)
      this.channels.add(channel)
    }

    // Send an initial message
    this.sendMessage({
      type: 'notification',
      payload: { message: 'Connected to stream' },
      timestamp: Date.now(),
    })

    // Start heartbeat to keep connection alive (every 30 seconds)
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return
      // Issue #157: skip heartbeats for a client that's already backed up —
      // adding more unflushable writes to a stalled socket only makes the
      // eventual queue overflow arrive sooner for no benefit.
      if (this.paused) return
      this.sendMessage({
        type: 'heartbeat',
        timestamp: Date.now(),
      })
    }, 30_000)
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref()
    }

    // Attach listeners to the client
    this.client.on('notification', (msg) => {
      if (!this.closed) {
        this.sendMessage({
          type: 'notification',
          channel: msg.channel,
          payload: msg.payload ? JSON.parse(msg.payload) : {},
          timestamp: Date.now(),
        })
      }
    })

    // Handle client errors
    this.client.on('error', (err) => {
      if (!this.closed) {
        console.error('[stream] client error:', err)
        this.sendMessage({
          type: 'error',
          payload: { error: 'Stream error' },
          timestamp: Date.now(),
        })
        void this.close()
      }
    })
  }

  /**
   * Send a message to the client via SSE, respecting backpressure (issue #157).
   */
  private sendMessage(msg: StreamMessage): void {
    if (this.closed) return

    const eventType = msg.type
    const id = `${msg.timestamp}`
    const data = JSON.stringify({
      type: msg.type,
      channel: msg.channel,
      payload: msg.payload,
      timestamp: msg.timestamp,
    })
    // SSE format: event type, id, and data, as a single write so exactly
    // one write() return value governs this whole frame's backpressure.
    const frame = `event: ${eventType}\nid: ${id}\ndata: ${data}\n\n`

    if (this.paused) {
      this.enqueue(frame)
      return
    }
    this.writeFrame(frame)
  }

  private writeFrame(frame: string): void {
    try {
      const ok = this.reply.raw.write(frame)
      if (!ok) {
        this.paused = true
        this.armStallTimer()
      }
    } catch (err) {
      // Ignore write errors (client disconnected)
      if (this.reply.raw.destroyed) {
        this.closed = true
      }
    }
  }

  private enqueue(frame: string): void {
    if (this.queue.length >= MAX_QUEUED_MESSAGES) {
      // Already over the bound: a consumer that cannot keep up is better
      // dropped than buffered forever (issue #157).
      void this.close()
      return
    }
    this.queue.push(frame)
  }

  private flushQueue(): void {
    while (!this.paused && !this.closed && this.queue.length > 0) {
      const frame = this.queue.shift()
      if (frame !== undefined) this.writeFrame(frame)
    }
  }

  private armStallTimer(): void {
    if (this.stallTimer) return
    this.stallTimer = setTimeout(() => {
      // Backpressured for too long with no drain: a stalled reader is
      // better dropped than buffered forever (issue #157).
      void this.close()
    }, DRAIN_STALL_DISCONNECT_MS)
    if (this.stallTimer.unref) this.stallTimer.unref()
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer)
      this.stallTimer = null
    }
  }

  /**
   * Clean up resources and close the connection.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.queue = []
    this.clearStallTimer()

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    // Unlisten from all channels
    for (const channel of this.channels) {
      try {
        await this.client.query(`UNLISTEN "${channel}"`)
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.channels.clear()

    // Close the client
    try {
      this.client.release()
    } catch {
      // Ignore errors during cleanup
    }

    // End the response
    try {
      this.reply.raw.end()
    } catch {
      // Already ended
    }
  }
}

/**
 * Register the /api/stream endpoint.
 * Returns a Server-Sent Events stream of change notifications.
 */
// Issue #160: parse an optional `?channels=members,loans` query param into a
// validated subset of STREAM_CHANNELS keys, so a client that only cares
// about e.g. loans isn't also subscribed to (and billed, bandwidth-wise,
// for) every other channel. Returns null for "no filter" (subscribe to
// everything, the previous behavior), or throws with the bad key(s) named
// for an unrecognized channel.
export function parseChannelSubset(v: unknown): StreamChannel[] | null {
  if (v === undefined || v === null || v === '') return null
  const raw = typeof v === 'string' ? v : String(v)
  const keys = raw.split(',').map((k) => k.trim()).filter((k) => k.length > 0)
  if (keys.length === 0) return null

  const known = STREAM_CHANNELS as Record<string, StreamChannel>
  const unknownKeys = keys.filter((k) => !(k in known))
  if (unknownKeys.length > 0) {
    throw new Error(`unknown channel(s): ${unknownKeys.join(', ')}`)
  }
  return keys.map((k) => known[k]!)
}

export async function registerStreamEndpoint(app: FastifyInstance, pool: Pool): Promise<void> {
  // Track connected clients for optional metrics/admin
  const connectedClients = new Set<StreamClient>()

  app.get('/api/stream', async (request, reply) => {
    let streamClient: StreamClient | null = null

    let channels: StreamChannel[] | null
    try {
      const q = request.query as Record<string, unknown>
      channels = parseChannelSubset(q.channels)
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }

    try {
      // Dedicated connection for LISTEN/NOTIFY; StreamClient owns its release.
      const client = await pool.connect()
      streamClient = new StreamClient(reply, client)
      connectedClients.add(streamClient)

      // Handle client disconnect
      reply.raw.on('close', async () => {
        connectedClients.delete(streamClient!)
        await streamClient!.close()
      })

      reply.raw.on('error', async () => {
        connectedClients.delete(streamClient!)
        await streamClient!.close()
      })

      // Start the stream
      await streamClient.start(channels ?? undefined)
    } catch (err) {
      connectedClients.delete(streamClient!)
      if (streamClient) {
        await streamClient.close()
      }
      console.error('[stream] error setting up client:', err)
      return reply.code(500).send({ error: 'Failed to establish stream' })
    }
  })
}

/**
 * Emit a NOTIFY to all listening clients (called from the indexer after a transaction commits).
 * This is non-blocking and safe to call from within a transaction — the NOTIFY will be
 * sent when the transaction commits.
 */
export async function notifyStreamClients(
  client: PoolClient,
  channel: StreamChannel,
  payload?: Record<string, unknown>
): Promise<void> {
  try {
    const payloadJson = payload ? JSON.stringify(payload) : ''
    const escapedPayload = payloadJson.replace(/'/g, "''")
    await client.query(`NOTIFY "${channel}", '${escapedPayload}'`)
  } catch (err) {
    // Log but don't throw — notification failure shouldn't break the indexer
    console.error('[stream] NOTIFY error:', err)
  }
}
