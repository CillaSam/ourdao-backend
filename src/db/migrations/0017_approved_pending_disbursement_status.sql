-- #125 — `loan_wait`/`tre_wait` (added to the EVENT_FIELDS catalog alongside
-- this migration) mark a proposal that reached quorum but couldn't be
-- disbursed yet because the treasury was too small. The contract leaves it
-- `ApprovedPendingDisbursement`, awaiting a later `disburse_approved_loan` /
-- `execute_treasury_proposal` call — previously that state had nowhere to go
-- off-chain at all.
--
-- Widen the existing status CHECK constraints (see
-- 0012_status_check_constraints.sql) to accept the new value, matching the
-- inline constraints in schema.sql (fresh databases) and the TypeScript
-- unions in src/types.ts; test/status-constraints.test.ts fails if any of the
-- three drift apart.

ALTER TABLE loan_proposals
  DROP CONSTRAINT loan_proposals_status_check;
ALTER TABLE loan_proposals
  ADD CONSTRAINT loan_proposals_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'approved_pending_disbursement'));

ALTER TABLE treasury_proposals
  DROP CONSTRAINT treasury_proposals_status_check;
ALTER TABLE treasury_proposals
  ADD CONSTRAINT treasury_proposals_status_check
  CHECK (status IN ('pending', 'executed', 'rejected', 'approved_pending_disbursement'));
