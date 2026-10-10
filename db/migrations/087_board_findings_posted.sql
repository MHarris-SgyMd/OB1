-- =============================================================================
-- Migration 087: what consolidation's findings between two tickets the board
--                does not link were posted to the board as — one row per
--                ticket pair and word, so a re-run, a restart or a second
--                poster on this brain posts nothing again (SMD-2681)
-- =============================================================================
--
-- WHY
--   A pending `outdates` proposal (029) or a standing judged relation (084)
--   between two Linear tickets the board does not link stays in the brain
--   until someone reads the queue; SMD-2680 made it countable, not seen.
--   db/board-findings.ts posts one Linear comment on the newer ticket of
--   such a pair, proposing only — it never adds a link or moves a status.
--   A poster without a record of what it posted would post the same pair
--   every pass, so the record is here.
--
-- WHAT
--   * board_findings_posted — one row per (ticket pair, word): the pair in
--     order (ticket_a < ticket_b, by coalesce(ticket, issue), 079's
--     identity), the word (outdates for a proposal; related, evolves or
--     duplicate for a relation), the ticket commented on, and the
--     proposal and relation-facet ids the comment named. The key is the
--     pair and the word, not a finding's id: a relation a re-judge replaces
--     has a new facet id and the same word, and is not a new finding; five
--     proposals between two tickets are one comment.
--   * origin: `posted` — this brain posted the comment, and it counts
--     against the poster's daily cap; `found` — the comment's marker line
--     was already on the ticket (another brain posted it, or this one did
--     and lost the row), recorded so the ticket is not read again, and
--     never counted against the cap.
--   * Rows are only ever inserted — a posted one after Linear answers, in the
--     transaction that posted, under one advisory lock for the brain — so a
--     failed post records nothing and the next pass tries again. No UPDATE,
--     no DELETE.
--   * Grants: none here. db/config.mjs's `structure` group (board-sync's)
--     holds SELECT and INSERT on it.
--
-- Idempotent: the table and the index IF NOT EXISTS; the comments replaced.
-- =============================================================================

CREATE TABLE IF NOT EXISTS board_findings_posted (
  ticket_a     text        NOT NULL,
  ticket_b     text        NOT NULL,
  word         text        NOT NULL,
  posted_on    text        NOT NULL,
  origin       text        NOT NULL,
  comment_id   text,
  finding_ids  uuid[]      NOT NULL,
  posted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_a, ticket_b, word),
  CONSTRAINT board_findings_posted_pair_ordered CHECK (ticket_a < ticket_b),
  CONSTRAINT board_findings_posted_word CHECK (word IN ('outdates', 'related', 'evolves', 'duplicate')),
  CONSTRAINT board_findings_posted_on_the_pair CHECK (posted_on IN (ticket_a, ticket_b)),
  CONSTRAINT board_findings_posted_origin CHECK (origin IN ('posted', 'found')),
  CONSTRAINT board_findings_posted_names_a_finding CHECK (cardinality(finding_ids) > 0)
);

-- The cap's read: comments this brain posted in the last day.
CREATE INDEX IF NOT EXISTS board_findings_posted_at_idx
  ON board_findings_posted (posted_at) WHERE origin = 'posted';

COMMENT ON TABLE board_findings_posted IS
  'What db/board-findings.ts posted to the Linear board: one row per (ticket pair, word) — a pending outdates proposal or a standing judged relation between two tickets the board does not link, posted as one comment on the newer ticket. Inserted in the transaction that posts, so a failed post records nothing; never updated or deleted. Migration 087 / SMD-2681.';
COMMENT ON COLUMN board_findings_posted.ticket_a IS
  'The pair''s lesser ticket identity, coalesce(metadata->>''ticket'', metadata->>''issue'') (079''s); ticket_a < ticket_b.';
COMMENT ON COLUMN board_findings_posted.word IS
  'outdates (a pending supersession proposal), or related, evolves or duplicate (a standing relation facet).';
COMMENT ON COLUMN board_findings_posted.posted_on IS
  'The ticket the comment is on: the newer side of the pair''s first-ranked finding.';
COMMENT ON COLUMN board_findings_posted.origin IS
  'posted: this brain posted the comment, counted against the daily cap. found: the comment''s marker line was already on the ticket, so nothing was posted and nothing is counted.';
COMMENT ON COLUMN board_findings_posted.comment_id IS
  'Linear''s id for the comment posted; NULL for a found row.';
COMMENT ON COLUMN board_findings_posted.finding_ids IS
  'The supersession_proposals ids and relation thought_facets ids the comment named for this word.';
