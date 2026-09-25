-- IF NOT EXISTS (issue #161): originally numbered 0014 alongside two other
-- unrelated migrations that also claimed version 14 — re-running this file
-- (now correctly numbered) against a database that already got this column
-- applied under the old scheme must be a no-op, not an error.
ALTER TABLE events ADD COLUMN IF NOT EXISTS decode_error TEXT;
