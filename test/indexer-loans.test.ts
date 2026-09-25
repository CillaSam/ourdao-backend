import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { pool, query } from '../src/db/index.js'
import { applyEvent } from '../src/indexer/handlers.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'
import type { LoanProposalRow, LoanRow, MemberRow } from '../src/types.js'

describe('indexer handlers: loans', () => {
  let client: PoolClient

  beforeEach(async () => {
    await resetDb()
    client = await pool.connect()
  })
  afterEach(() => client.release())
  afterAll(closeDb)

  it('loan_req creates a pending proposal and notifies the borrower', async () => {
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 1, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )
    const rows = await query<LoanProposalRow>('SELECT * FROM loan_proposals WHERE id = 1')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('pending')
    expect(rows[0]?.amount).toBe('1000')
    expect(rows[0]?.total_repayment).toBe('1100')
    expect(rows[0]?.votes_for).toBe('0')
    expect(rows[0]?.voter_count).toBe(0)
  })

  it('loan_edit updates the amount and total_repayment on an existing proposal', async () => {
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 2, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )
    await applyEvent(
      client,
      decodedEvent('loan_edit', { proposal_id: 2, borrower: 'GBORROWER', new_amount: '2000', total_repayment: '2200' })
    )
    const rows = await query<LoanProposalRow>('SELECT * FROM loan_proposals WHERE id = 2')
    expect(rows[0]?.amount).toBe('2000')
    expect(rows[0]?.total_repayment).toBe('2200')
  })

  it('loan_vote tallies for- and against-votes on the right proposal, with an unweighted event counting as weight 1', async () => {
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 3, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )
    await applyEvent(client, decodedEvent('loan_vote', { proposal_id: 3, voter: 'GV1', support: true }))
    await applyEvent(client, decodedEvent('loan_vote', { proposal_id: 3, voter: 'GV2', support: true }))
    await applyEvent(client, decodedEvent('loan_vote', { proposal_id: 3, voter: 'GV3', support: false }))

    const rows = await query<LoanProposalRow>('SELECT * FROM loan_proposals WHERE id = 3')
    expect(rows[0]?.votes_for).toBe('2')
    expect(rows[0]?.votes_against).toBe('1')
    expect(rows[0]?.voter_count).toBe(3)
  })

  it('loan_vote sums stake-weighted power once the event carries a weight, matching what the contract would compute', async () => {
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 30, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )
    // Mirrors util::voting_weight: 1 base vote + a capped stake bonus.
    await applyEvent(client, decodedEvent('loan_vote', { proposal_id: 30, voter: 'GV1', support: true, weight: '1' }))
    await applyEvent(client, decodedEvent('loan_vote', { proposal_id: 30, voter: 'GV2', support: true, weight: '6' }))
    await applyEvent(client, decodedEvent('loan_vote', { proposal_id: 30, voter: 'GV3', support: false, weight: '3' }))

    const rows = await query<LoanProposalRow>('SELECT * FROM loan_proposals WHERE id = 30')
    expect(rows[0]?.votes_for).toBe('7') // 1 + 6, matching a contract-side sum of the same weights
    expect(rows[0]?.votes_against).toBe('3')
    expect(rows[0]?.voter_count).toBe(3) // distinct voters, independent of weight
  })

  it('loan_wait marks the proposal approved_pending_disbursement and notifies the borrower (issue #125)', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBORROWER', fee: '500' }))
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 90, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )
    await applyEvent(client, decodedEvent('loan_wait', { id: 90, amount: '1000' }))

    const proposals = await query<LoanProposalRow>('SELECT * FROM loan_proposals WHERE id = 90')
    expect(proposals[0]?.status).toBe('approved_pending_disbursement')

    const notifs = await query<{ title: string }>(
      'SELECT title FROM notifications WHERE address = $1 AND type = $2',
      ['GBORROWER', 'info']
    )
    expect(notifs.map((n) => n.title)).toContain('Loan approved, awaiting funds')
  })

  it('a later loan_appr resolves an approved_pending_disbursement proposal (issue #125)', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBORROWER', fee: '500' }))
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 91, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )
    await applyEvent(client, decodedEvent('loan_wait', { id: 91, amount: '1000' }))
    await applyEvent(client, decodedEvent('loan_appr', { id: 91, borrower: 'GBORROWER', amount: '1000' }))

    const proposals = await query<LoanProposalRow>('SELECT * FROM loan_proposals WHERE id = 91')
    expect(proposals[0]?.status).toBe('approved')

    const loans = await query<LoanRow>('SELECT * FROM loans WHERE id = 91')
    expect(loans[0]?.status).toBe('active')
  })

  it('re-delivering loan_wait is idempotent', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBORROWER', fee: '500' }))
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 92, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )
    const waitEv = decodedEvent('loan_wait', { id: 92, amount: '1000' })
    await applyEvent(client, waitEv)
    await applyEvent(client, waitEv)

    const notifs = await query(
      'SELECT * FROM notifications WHERE address = $1 AND title = $2',
      ['GBORROWER', 'Loan approved, awaiting funds']
    )
    expect(notifs).toHaveLength(1)
  })

  it('loan_rej marks the proposal rejected with the contract-final tally in the raw event, and notifies the borrower (issue #124)', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBORROWER', fee: '500' }))
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 93, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )
    await applyEvent(client, decodedEvent('loan_rej', { id: 93, for_votes: '2', against_votes: '5' }))

    const proposals = await query<LoanProposalRow>('SELECT * FROM loan_proposals WHERE id = 93')
    expect(proposals[0]?.status).toBe('rejected')

    const notifs = await query<{ title: string }>(
      'SELECT title FROM notifications WHERE address = $1 AND type = $2',
      ['GBORROWER', 'warning']
    )
    expect(notifs.map((n) => n.title)).toContain('Loan proposal rejected')
  })

  it('re-delivering loan_rej is idempotent and loan_rej for an unknown proposal is a no-op', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBORROWER', fee: '500' }))
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 94, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )
    const rejEv = decodedEvent('loan_rej', { id: 94, for_votes: '2', against_votes: '5' })
    await applyEvent(client, rejEv)
    await applyEvent(client, rejEv)

    const notifs = await query(
      'SELECT * FROM notifications WHERE address = $1 AND title = $2',
      ['GBORROWER', 'Loan proposal rejected']
    )
    expect(notifs).toHaveLength(1)

    await expect(
      applyEvent(client, decodedEvent('loan_rej', { id: 99998, for_votes: '1', against_votes: '1' }))
    ).resolves.toBeUndefined()
  })

  it('loan_appr marks the proposal approved, opens a loan seeded with total_repayment (not the bare principal), and flags the borrower as having an active loan', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBORROWER', fee: '10' }))
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 4, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )
    await applyEvent(client, decodedEvent('loan_appr', { id: 4, borrower: 'GBORROWER', amount: '1000' }))

    const proposals = await query<LoanProposalRow>('SELECT * FROM loan_proposals WHERE id = 4')
    expect(proposals[0]?.status).toBe('approved')

    const loans = await query<LoanRow>('SELECT * FROM loans WHERE id = 4')
    expect(loans).toHaveLength(1)
    expect(loans[0]?.amount).toBe('1000')
    expect(loans[0]?.total_repayment).toBe('1100')
    // Outstanding is what the contract would actually collect via repay_loan
    // (total_repayment - amount_repaid, with amount_repaid still 0) — the
    // principal alone understates it by the interest charge.
    expect(loans[0]?.outstanding).toBe('1100')
    expect(loans[0]?.status).toBe('active')

    const members = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GBORROWER'])
    expect(members[0]?.has_active_loan).toBe(true)
  })

  it('loan_appr falls back to the principal when no matching proposal row exists', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBORROWER', fee: '10' }))
    await applyEvent(client, decodedEvent('loan_appr', { id: 40, borrower: 'GBORROWER', amount: '500' }))

    const loans = await query<LoanRow>('SELECT * FROM loans WHERE id = 40')
    expect(loans[0]?.total_repayment).toBe('500')
    expect(loans[0]?.outstanding).toBe('500')
  })

  it('loan_rpy with zero outstanding marks the loan repaid and clears has_active_loan', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBORROWER', fee: '10' }))
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 5, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )
    await applyEvent(client, decodedEvent('loan_appr', { id: 5, borrower: 'GBORROWER', amount: '1000' }))
    await applyEvent(client, decodedEvent('loan_rpy', { loan_id: 5, borrower: 'GBORROWER', outstanding: '0' }))

    const loans = await query<LoanRow>('SELECT * FROM loans WHERE id = 5')
    expect(loans[0]?.status).toBe('repaid')

    const members = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GBORROWER'])
    expect(members[0]?.has_active_loan).toBe(false)
  })

  it('loan_rpy with remaining outstanding keeps the loan active', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBORROWER', fee: '10' }))
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 6, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )
    await applyEvent(client, decodedEvent('loan_appr', { id: 6, borrower: 'GBORROWER', amount: '1000' }))
    await applyEvent(client, decodedEvent('loan_rpy', { loan_id: 6, borrower: 'GBORROWER', outstanding: '400' }))

    const loans = await query<LoanRow>('SELECT * FROM loans WHERE id = 6')
    expect(loans[0]?.status).toBe('active')
    expect(loans[0]?.outstanding).toBe('400')

    const members = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GBORROWER'])
    expect(members[0]?.has_active_loan).toBe(true)
  })

  it('loan_dflt marks the loan defaulted, clears has_active_loan, slashes contribution by the penalty, and records defaulted_ledger', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBORROWER', fee: '1000' }))
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 7, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )
    await applyEvent(client, decodedEvent('loan_appr', { id: 7, borrower: 'GBORROWER', amount: '1000' }))
    await applyEvent(client, decodedEvent('loan_dflt', { loan_id: 7, borrower: 'GBORROWER', penalty: '200' }))

    const loans = await query<LoanRow>('SELECT * FROM loans WHERE id = 7')
    expect(loans[0]?.status).toBe('defaulted')
    expect(loans[0]?.defaulted_ledger).not.toBeNull()

    const members = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GBORROWER'])
    expect(members[0]?.has_active_loan).toBe(false)
    expect(members[0]?.contribution).toBe('800')
    expect(members[0]?.defaults_count).toBe(1)
  })

  it('loan_dflt never lets contribution go negative, clamping the penalty at the member\'s remaining contribution', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBORROWER', fee: '50' }))
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 70, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )
    await applyEvent(client, decodedEvent('loan_appr', { id: 70, borrower: 'GBORROWER', amount: '1000' }))
    await applyEvent(client, decodedEvent('loan_dflt', { loan_id: 70, borrower: 'GBORROWER', penalty: '9999' }))

    const members = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GBORROWER'])
    expect(members[0]?.contribution).toBe('0')
  })

  it('re-delivering the same loan_dflt event does not slash contribution twice', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBORROWER', fee: '1000' }))
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 71, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )
    await applyEvent(client, decodedEvent('loan_appr', { id: 71, borrower: 'GBORROWER', amount: '1000' }))
    const dfltEv = decodedEvent('loan_dflt', { loan_id: 71, borrower: 'GBORROWER', penalty: '200' })
    await applyEvent(client, dfltEv)
    await applyEvent(client, dfltEv) // simulated re-delivery of the same page

    const members = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GBORROWER'])
    expect(members[0]?.contribution).toBe('800')
    expect(members[0]?.defaults_count).toBe(1)

    const notifs = await query('SELECT * FROM notifications WHERE address = $1 AND type = $2', ['GBORROWER', 'error'])
    expect(notifs).toHaveLength(1)
  })

  it('loan_exp transitions proposal status from pending to rejected and notifies borrower', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBORROWER', fee: '500' }))
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 80, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )

    const expEv = decodedEvent('loan_exp', { proposal_id: 80, borrower: 'GBORROWER' })
    await applyEvent(client, expEv)

    const proposals = await query<LoanProposalRow>('SELECT * FROM loan_proposals WHERE id = 80')
    expect(proposals[0]?.status).toBe('rejected')

    const notifs = await query<{ title: string; type: string }>(
      'SELECT title, type FROM notifications WHERE address = $1 AND type = $2',
      ['GBORROWER', 'warning']
    )
    expect(notifs).toHaveLength(1)
    expect(notifs[0]?.title).toBe('Loan proposal expired')
  })

  it('re-delivering loan_exp is idempotent and loan_exp for unknown proposal is a no-op', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBORROWER', fee: '500' }))
    await applyEvent(
      client,
      decodedEvent('loan_req', { id: 81, borrower: 'GBORROWER', amount: '1000', total_repayment: '1100' })
    )

    const expEv = decodedEvent('loan_exp', { proposal_id: 81, borrower: 'GBORROWER' })
    await applyEvent(client, expEv)
    await applyEvent(client, expEv) // re-delivery

    const proposals = await query<LoanProposalRow>('SELECT * FROM loan_proposals WHERE id = 81')
    expect(proposals[0]?.status).toBe('rejected')

    const notifs = await query('SELECT * FROM notifications WHERE address = $1 AND type = $2', ['GBORROWER', 'warning'])
    expect(notifs).toHaveLength(1)

    // Unknown proposal id is a no-op, doesn't throw
    await expect(
      applyEvent(client, decodedEvent('loan_exp', { proposal_id: 99999, borrower: 'GBORROWER' }))
    ).resolves.toBeUndefined()
  })

  it('interest is a documented no-op (no per-member payload to apply)', async () => {
    await expect(
      applyEvent(client, decodedEvent('interest', { interest: '500', active: 10 }))
    ).resolves.toBeUndefined()
  })
})
