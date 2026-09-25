-- Migration: Add auth_nonces table for shared nonce storage across API instances (issue #66)
-- This table stores short-lived nonces used in the authentication challenge-response flow.
-- Nonces are consumed atomically via DELETE ... WHERE ... AND expires_at > now() RETURNING *
--
-- IF NOT EXISTS throughout (issue #161): this file was originally numbered
-- 0014 alongside two other unrelated migrations that also claimed version
-- 14. A deployment that happened to apply this one's SQL under that scheme
-- before the collision was caught needs re-running this file (now correctly
-- numbered) to be a no-op, not an error.

CREATE TABLE IF NOT EXISTS auth_nonces (
  address TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),

  -- Unique constraint ensures only one nonce per address at a time
  UNIQUE (address)
);

-- Index to support cleanup of expired nonces
CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires_at ON auth_nonces (expires_at);

-- Index to support lookups by nonce (if needed for debugging)
CREATE INDEX IF NOT EXISTS idx_auth_nonces_nonce ON auth_nonces (nonce);
