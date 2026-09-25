-- #52 — preserve notification read state across reindex by linking notifications
-- to their source event_id and recipient address.

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS event_id TEXT;
CREATE INDEX IF NOT EXISTS notifications_event_id_address_idx ON notifications (event_id, address);
