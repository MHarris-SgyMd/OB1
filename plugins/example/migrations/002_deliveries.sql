-- The example webhook's delivery ids (SMD-2755): a sender that names each
-- delivery (Slack's event_id, Telegram's update_id) has the capture hook claim
-- the id before it captures, so a delivery resent inside the signature's
-- tolerance runs nothing a second time. A row is a claim until thought_id is
-- set, and is pruned by the hook once older than twice the tolerance — when a
-- resend of it would be refused as stale anyway — so the table holds about
-- ten minutes of deliveries.

CREATE TABLE IF NOT EXISTS deliveries (
  id          text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  -- The thought the delivery captured, once it has; null while the capture runs.
  thought_id  uuid,
  claimed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deliveries_by_age ON deliveries (claimed_at);
