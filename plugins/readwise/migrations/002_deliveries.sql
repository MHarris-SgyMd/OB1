-- The webhook's delivery ids (SMD-2690), for the SDK's onceById: the highlight
-- id is claimed before its capture, so a highlight Readwise sends again runs
-- nothing a second time and is answered with the thought the first captured. A
-- row is a claim until thought_id is set (a retry takes one left unfinished past
-- its lease). Readwise signs nothing and sends no time, so a delivery could be
-- resent at any time: its ids are kept for good (keepSeconds: Infinity) and never
-- pruned, one row per highlight. The shape is
-- plugins/example/migrations/002_deliveries.sql's.

CREATE TABLE IF NOT EXISTS deliveries (
  id          text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  -- The thought the delivery captured, once it has; null while the capture runs.
  thought_id  uuid,
  claimed_at  timestamptz NOT NULL DEFAULT now()
);
