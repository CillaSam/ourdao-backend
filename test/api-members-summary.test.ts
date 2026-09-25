import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

const MEMBER_A = Keypair.random().publicKey()
const MEMBER_B = Keypair.random().publicKey()
const NOBODY = Keypair.random().publicKey()

describe('API: /members/:address/summary', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
    
    // Seed dao_totals
    await query(`
      INSERT INTO dao_totals (id, interest_collected, principal_lent, principal_repaid, value_defaulted)
      VALUES (1, '1000', '5000', '2000', '0')
      ON CONFLICT DO NOTHING
    `)
  })
  afterAll(closeDb)

  it('GET /api/members/:address/summary returns 404 for unknown address', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/members/GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3/summary' })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/members/:address/summary returns unified member data', async () => {
    await query(`
      INSERT INTO members (address, joined_ledger, contribution, stake, exited)
      VALUES 
      ('GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3', 100, '5000', '1000', false),
      ('GD2XX', 100, '5000', '1000', false)
    `)

    await query(`
      INSERT INTO loans (id, borrower, amount, outstanding, total_repayment, status)
      VALUES 
      (1, 'GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3', '1000', '1000', '1100', 'active'),
      (2, 'GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3', '500', '0', '550', 'repaid')
    `)

    await query(`
      INSERT INTO notifications (address, type, title, message, read)
      VALUES 
      ('GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3', 'info', 'Test', 'Msg', false),
      ('GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3', 'info', 'Test 2', 'Msg 2', true)
    `)

    const res = await app.inject({ method: 'GET', url: '/api/members/GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3/summary' })
    expect(res.statusCode).toBe(200)
    
    const body = res.json()
    expect(body.member.address).toBe('GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3')
    expect(body.loans).toHaveLength(2)
    const loan1 = body.loans.find((l: { id: number }) => l.id === 1)
    const loan2 = body.loans.find((l: { id: number }) => l.id === 2)
    expect(loan1.interest_charge).toBe('100') // Derived via withLoanDerived
    expect(loan2.interest_charge).toBe('50')
    expect(body.unread_notifications).toBe(1)

    // Position assertions
    expect(body.position.contribution_share_bps).toBe('5000') // 5000 / 10000 = 50%
    expect(body.position.stake_share_bps).toBe('5000')
    expect(body.position.repaid_loans_count).toBe(1)
    expect(body.position.defaulted_loans_count).toBe(0)
    expect(body.position.defaulted_loans_value).toBe('0')

    // Issue #165: the embedded list is well under LOANS_EMBED_LIMIT, so
    // nothing is truncated.
    expect(body.loans_total_count).toBe(2)
    expect(body.loans_truncated).toBe(false)
  })

  it('GET /api/members/:address/summary handles exited member position correctly', async () => {
    await query(`
      INSERT INTO members (address, joined_ledger, contribution, stake, exited)
      VALUES ('GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3', 100, '5000', '1000', true)
    `)
    const res = await app.inject({ method: 'GET', url: '/api/members/GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3/summary' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.position.stake_share_bps).toBe('0') // Exited member has 0% stake share
    // Issue #164: an exited member's claim is 0 under the contract's
    // calculate_exit_share (it early-returns 0 for any non-ActiveMember),
    // so contribution_share_bps must be 0 too, not the exited member's
    // stale share of a denominator that (before this fix) still counted
    // their own contribution.
    expect(body.position.contribution_share_bps).toBe('0')
  })

  // Issue #164: a mix of active and exited members, with hand-computed
  // expectations matching ourdao-contracts' calculate_exit_share —
  // treasury_share = contribution / total_active_contributions, 0 for any
  // exited member — rather than the previous total_contribution
  // denominator, which counted every member who ever joined.
  it('GET /api/members/:address/summary computes contribution_share_bps against the active-only denominator', async () => {
    await query(`
      INSERT INTO members (address, joined_ledger, contribution, stake, exited)
      VALUES
      ('GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3', 100, '3000', '0', false),
      ('GD2XX', 100, '7000', '0', false),
      ('GD3YY', 100, '9000', '0', true)
    `)
    // Active-only total_contribution = 3000 + 7000 = 10000 (the exited
    // member's 9000 must not count).
    const active = await app.inject({ method: 'GET', url: '/api/members/GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3/summary' })
    expect(active.json().position.contribution_share_bps).toBe('3000') // 3000 / 10000

    const other = await app.inject({ method: 'GET', url: '/api/members/GD2XX/summary' })
    expect(other.json().position.contribution_share_bps).toBe('7000') // 7000 / 10000

    const exited = await app.inject({ method: 'GET', url: '/api/members/GD3YY/summary' })
    expect(exited.json().position.contribution_share_bps).toBe('0') // exited -> 0, regardless of their own contribution
  })

  // Issue #165: with more loans than LOANS_EMBED_LIMIT, the aggregate counts
  // must still reflect every loan, and the truncation must be visible.
  it('GET /api/members/:address/summary reports correct aggregates and visible truncation beyond the embed limit', async () => {
    const address = 'GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3'
    await query(`
      INSERT INTO members (address, joined_ledger, contribution, stake, exited)
      VALUES ($1, 100, '0', '0', false)
    `, [address])

    // 105 loans: 3 defaulted (seeded with the lowest ids, so they fall
    // outside the `ORDER BY id DESC LIMIT 100` embedded window), the rest
    // active — proving the aggregate counts don't come from the truncated
    // embedded set.
    for (let i = 1; i <= 105; i++) {
      const status = i <= 3 ? 'defaulted' : 'active'
      const outstanding = i <= 3 ? '100' : '0'
      await query(
        `INSERT INTO loans (id, borrower, amount, outstanding, total_repayment, status)
         VALUES ($1, $2, '10', $3, '10', $4)`,
        [i, address, outstanding, status]
      )
    }

    const res = await app.inject({ method: 'GET', url: `/api/members/${address}/summary` })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.loans_total_count).toBe(105)
    expect(body.loans_truncated).toBe(true)
    expect(body.loans).toHaveLength(100)

    // The 3 defaulted loans (ids 1-3) are outside the embedded newest-100
    // window (ids 6-105), so this only passes if the aggregate is computed
    // over the full set, not the embedded page.
    expect(body.position.defaulted_loans_count).toBe(3)
    expect(body.position.defaulted_loans_value).toBe('300')
  })
})
