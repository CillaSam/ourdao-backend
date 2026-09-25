import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { pool, query } from '../src/db/index.js'
import { applyEvent } from '../src/indexer/handlers.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'
import type { MemberRow, NotificationRow, TreasuryProposalRow } from '../src/types.js'

describe('indexer handlers: treasury', () => {
  let client: PoolClient

  beforeEach(async () => {
    await resetDb()
    client = await pool.connect()
  })
  afterEach(() => client.release())

  it('tre_prop creates a pending treasury proposal', async () => {
    await applyEvent(
      client,
      decodedEvent('tre_prop', { id: 1, amount: '5000', destination: 'GDEST', private: false })
    )
    const rows = await query<TreasuryProposalRow>('SELECT * FROM treasury_proposals WHERE id = 1')
    expect(rows[0]?.status).toBe('pending')
    expect(rows[0]?.amount).toBe('5000')
    expect(rows[0]?.private).toBe(false)
  })

  it('tre_vote tallies for- and against-votes', async () => {
    await applyEvent(
      client,
      decodedEvent('tre_prop', { id: 2, amount: '5000', destination: 'GDEST', private: false })
    )
    await applyEvent(client, decodedEvent('tre_vote', { id: 2, voter: 'GV1', support: true }))
    await applyEvent(client, decodedEvent('tre_vote', { id: 2, voter: 'GV2', support: false }))
    await applyEvent(client, decodedEvent('tre_vote', { id: 2, voter: 'GV3', support: false }))

    const rows = await query<TreasuryProposalRow>('SELECT * FROM treasury_proposals WHERE id = 2')
    expect(rows[0]?.votes_for).toBe('1')
    expect(rows[0]?.votes_against).toBe('2')
    expect(rows[0]?.voter_count).toBe(3)
  })

  it('tre_vote sums stake-weighted power once the event carries a weight', async () => {
    await applyEvent(
      client,
      decodedEvent('tre_prop', { id: 20, amount: '5000', destination: 'GDEST', private: false })
    )
    await applyEvent(client, decodedEvent('tre_vote', { id: 20, voter: 'GV1', support: true, weight: '4' }))
    await applyEvent(client, decodedEvent('tre_vote', { id: 20, voter: 'GV2', support: true, weight: '2' }))

    const rows = await query<TreasuryProposalRow>('SELECT * FROM treasury_proposals WHERE id = 20')
    expect(rows[0]?.votes_for).toBe('6')
    expect(rows[0]?.voter_count).toBe(2)
  })

  it('tre_wait marks the proposal approved_pending_disbursement and notifies the destination (issue #125)', async () => {
    await applyEvent(
      client,
      decodedEvent('tre_prop', { id: 30, amount: '5000', destination: 'GDEST', private: false })
    )
    await applyEvent(client, decodedEvent('tre_wait', { id: 30, amount: '5000' }))

    const rows = await query<TreasuryProposalRow>('SELECT * FROM treasury_proposals WHERE id = 30')
    expect(rows[0]?.status).toBe('approved_pending_disbursement')

    const notifs = await query<NotificationRow>('SELECT * FROM notifications WHERE address = $1', ['GDEST'])
    expect(notifs.map((n) => n.title)).toContain('Treasury withdrawal approved, awaiting funds')
  })

  it('a later tre_exec resolves an approved_pending_disbursement proposal (issue #125)', async () => {
    await applyEvent(
      client,
      decodedEvent('tre_prop', { id: 31, amount: '5000', destination: 'GDEST', private: false })
    )
    await applyEvent(client, decodedEvent('tre_wait', { id: 31, amount: '5000' }))
    await applyEvent(client, decodedEvent('tre_exec', { id: 31, amount: '5000', destination: 'GDEST' }))

    const rows = await query<TreasuryProposalRow>('SELECT * FROM treasury_proposals WHERE id = 31')
    expect(rows[0]?.status).toBe('executed')
  })

  it('tre_rej marks the proposal rejected and notifies the destination (issue #124)', async () => {
    await applyEvent(
      client,
      decodedEvent('tre_prop', { id: 32, amount: '5000', destination: 'GDEST', private: false })
    )
    await applyEvent(client, decodedEvent('tre_rej', { id: 32, for_votes: '1', against_votes: '4' }))

    const rows = await query<TreasuryProposalRow>('SELECT * FROM treasury_proposals WHERE id = 32')
    expect(rows[0]?.status).toBe('rejected')

    const notifs = await query<NotificationRow>('SELECT * FROM notifications WHERE address = $1', ['GDEST'])
    expect(notifs.map((n) => n.title)).toContain('Treasury proposal rejected')
  })

  it('re-delivering tre_rej is idempotent', async () => {
    await applyEvent(
      client,
      decodedEvent('tre_prop', { id: 33, amount: '5000', destination: 'GDEST', private: false })
    )
    const rejEv = decodedEvent('tre_rej', { id: 33, for_votes: '1', against_votes: '4' })
    await applyEvent(client, rejEv)
    await applyEvent(client, rejEv)

    const notifs = await query<NotificationRow>('SELECT * FROM notifications WHERE address = $1', ['GDEST'])
    expect(notifs).toHaveLength(1)
  })

  it('tre_exec marks the proposal executed and notifies the destination', async () => {
    await applyEvent(
      client,
      decodedEvent('tre_prop', { id: 3, amount: '5000', destination: 'GDEST', private: false })
    )
    const execEv = decodedEvent('tre_exec', { id: 3, amount: '5000', destination: 'GDEST' })
    await applyEvent(client, execEv)

    const rows = await query<TreasuryProposalRow>('SELECT * FROM treasury_proposals WHERE id = 3')
    expect(rows[0]?.status).toBe('executed')
    expect(rows[0]?.executed_ledger).toBe(execEv.ledger)

    const notifs = await query<NotificationRow>('SELECT * FROM notifications WHERE address = $1', ['GDEST'])
    expect(notifs).toHaveLength(1)
  })

  it('revealed (commit-reveal) tallies onto the same proposal as an open tre_vote would', async () => {
    await applyEvent(
      client,
      decodedEvent('tre_prop', { id: 4, amount: '5000', destination: 'GDEST', private: true })
    )
    await applyEvent(client, decodedEvent('revealed', { proposal_id: 4, voter: 'GV1', support: true }))

    const rows = await query<TreasuryProposalRow>('SELECT * FROM treasury_proposals WHERE id = 4')
    expect(rows[0]?.votes_for).toBe('1')
    expect(rows[0]?.voter_count).toBe(1)
  })

  it('committed only notifies the voter; it does not tally a vote', async () => {
    await applyEvent(
      client,
      decodedEvent('tre_prop', { id: 5, amount: '5000', destination: 'GDEST', private: true })
    )
    await applyEvent(client, decodedEvent('committed', { proposal_id: 5, voter: 'GV1' }))

    const rows = await query<TreasuryProposalRow>('SELECT * FROM treasury_proposals WHERE id = 5')
    expect(rows[0]?.votes_for).toBe('0')
    expect(rows[0]?.votes_against).toBe('0')

    const notifs = await query<NotificationRow>('SELECT * FROM notifications WHERE address = $1', ['GV1'])
    expect(notifs).toHaveLength(1)
  })
})

describe('indexer handlers: staking', () => {
  let client: PoolClient

  beforeEach(async () => {
    await resetDb()
    client = await pool.connect()
  })
  afterEach(() => client.release())

  it('staked updates the stake on an existing member', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GSTAKER', fee: '10' }))
    await applyEvent(client, decodedEvent('staked', { member: 'GSTAKER', amount: '100', new_stake: '100' }))
    const rows = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GSTAKER'])
    expect(rows[0]?.stake).toBe('100')
  })

  it('staked for an address with no join event creates no member row (issue #14)', async () => {
    await applyEvent(client, decodedEvent('staked', { member: 'GNOTAMEMBER', amount: '100', new_stake: '100' }))
    const rows = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GNOTAMEMBER'])
    expect(rows).toHaveLength(0)
  })

  it('unstaked lowers the stake on an existing member', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GSTAKER', fee: '10' }))
    await applyEvent(client, decodedEvent('staked', { member: 'GSTAKER', amount: '100', new_stake: '100' }))
    await applyEvent(client, decodedEvent('unstaked', { member: 'GSTAKER', amount: '40', new_stake: '60' }))
    const rows = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GSTAKER'])
    expect(rows[0]?.stake).toBe('60')
  })
})

describe('indexer handlers: registry', () => {
  let client: PoolClient

  beforeEach(async () => {
    await resetDb()
    client = await pool.connect()
  })
  afterEach(() => client.release())

  it('name_reg sets the name on an existing member', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GALICE', fee: '10' }))
    await applyEvent(client, decodedEvent('name_reg', { name: 'alice.our', owner: 'GALICE' }))
    const rows = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GALICE'])
    expect(rows[0]?.name).toBe('alice.our')
  })

  it('name_reg for an address with no join event creates no member row (issue #14)', async () => {
    await applyEvent(client, decodedEvent('name_reg', { name: 'phantom.our', owner: 'GPHANTOM' }))
    const rows = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GPHANTOM'])
    expect(rows).toHaveLength(0)
  })

  it('re-registering overwrites the previous name for the same owner', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GALICE', fee: '10' }))
    await applyEvent(client, decodedEvent('name_reg', { name: 'alice.our', owner: 'GALICE' }))
    await applyEvent(client, decodedEvent('name_reg', { name: 'alice2.our', owner: 'GALICE' }))
    const rows = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GALICE'])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('alice2.our')
  })
})

// One shared `pool` (src/db/index.ts) backs every describe block in this
// file, so it must only be closed once, after all of them finish.
afterAll(closeDb)
