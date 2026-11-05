-- The Readwise highlights the webhook captured (SMD-2690): one row per highlight,
-- naming the thought it became and keeping what Readwise sent beside the text.
-- The text itself is the thought's alone: deleting the thought leaves no copy of
-- it here. The thought carries two metadata keys (readwise_highlight_id and
-- readwise_book_id), as many as capture_thought's limits leave room for; the
-- rest of what Readwise sent is here, keyed by the highlight. Ported from
-- integrations/readwise-capture, which wrote all of it into the thought's
-- metadata.

CREATE TABLE IF NOT EXISTS highlights (
  -- Readwise's highlight id, the delivery's id.
  highlight_id    bigint      PRIMARY KEY CHECK (highlight_id > 0),
  -- The brain's thought it was captured as (or the one already holding its text). No foreign key into the core.
  thought_id      uuid        NOT NULL,
  -- Readwise's book id: its title and author are not looked up (a plugin makes no outbound call).
  book_id         bigint      NOT NULL CHECK (book_id > 0),
  note            text,
  location        double precision,
  location_type   text,
  color           text,
  url             text,
  tags            text[]      NOT NULL DEFAULT '{}',
  highlighted_at  timestamptz,
  -- Readwise's own last-updated time for the highlight, as it sent it.
  updated_at      timestamptz,
  captured_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS highlights_by_book ON highlights (book_id, highlighted_at DESC NULLS LAST, highlight_id DESC);
CREATE INDEX IF NOT EXISTS highlights_by_time ON highlights (highlighted_at DESC NULLS LAST, highlight_id DESC);
