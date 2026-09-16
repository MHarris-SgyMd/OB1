-- ============================================================================
-- 036 — delete_thought joins the writers' lock order: it takes the supersession
--        advisory lock before its DELETE, so an accept racing a delete of the
--        superseded thought no longer deadlocks (SMD-1462)
--
-- Why
--   033 put every writer of thoughts.supersedes on one lock order — the
--   supersession advisory lock (hashtext('ob1:supersession-review')), then the
--   fingerprint lock, then the row — and its second review pass named the one
--   writer left outside it: delete_thought (009). The function takes no
--   advisory lock. Its DELETE holds the thought's row, and 029's ON DELETE
--   CASCADE from thoughts onto supersession_proposals reaches every proposal
--   that names the row and waits to remove it.
--
--   review_supersession_proposal(P, 'accept') (032) locks the proposal row P
--   FOR UPDATE, takes the supersession advisory lock, locks the superseding
--   thought S FOR NO KEY UPDATE, then calls update_thought to write
--   S.supersedes = Z, whose FK check (thoughts_supersedes_fkey, 025) takes
--   KEY SHARE on the superseded thought Z. delete_thought(Z) holds Z (the
--   DELETE) and, through the cascade, waits on P; the review holds P and waits
--   on KEY SHARE of Z. A cycle of two shipped functions — reproduced 23 times
--   in 40 against a real server by 033's pass, the delete the 40P01 victim
--   each time. Pre-existing since 029/032; 033's header and FORK change 62
--   state it as the residue outside the order rather than claiming the order
--   is universal.
--
-- What — two changes, and both are needed (the run proved it)
--   1. delete_thought takes pg_advisory_xact_lock(hashtext('ob1:supersession-review'))
--      before the DELETE — the identical key review_supersession_proposal,
--      update_thought and upsert_thought take. One hash entry, transaction-
--      scoped, released at commit; taken whether or not a proposal names the
--      row, because the function cannot know that before the row is gone, and
--      the acquire is cheap.
--   2. review_supersession_proposal takes the SAME lock BEFORE it locks the
--      proposal row P (it took it after, in the accept path, since 029/032).
--
--   The ticket proposed (1) alone and warned that reordering the review's
--   proposal-row lock "is not enough on its own". Running it showed (1) alone
--   is not enough either: with only the delete fixed, a delete holds the
--   advisory lock and then waits on P through 029's cascade, while a review
--   holds P (locked before it reaches the lock) and waits on the advisory lock
--   — a fresh cycle of the same two functions, seen 10 of 40 while building
--   this migration with the delete fixed but the review not. (The shipped
--   db/test-live.ts [6g] does not reproduce that intermediate state; its arm 2
--   and test-schema [36] guard the reorder.) The two orderings only meet if
--   BOTH writers take the advisory lock before any row the other needs. With
--   (1)+(2) they do: a delete and a review contend on the lock first, and
--   whichever wins runs to commit — the review writing its pointer, or the
--   delete removing Z and cascading P — before the other touches a row. Forty
--   tries, no 40P01.
--
--   The lock's cost, stated honestly: because delete_thought takes it
--   unconditionally, deletes of UNRELATED thoughts now serialise with each
--   other and with every supersedes-write on this one lock. A human-paced
--   delete pays nothing that shows; a bulk cleanup deleting in parallel loses
--   concurrency it had. Making the acquire conditional would mean reading the
--   proposals for the row before the DELETE — its own cost, and a lock the
--   delete would then have to take anyway — so unconditional is the right call
--   for a path that is not hot. SMD-1502 tracks the bulk case.
--
-- The 23503 the same lock closes
--   033's header carried a second, smaller thing from the same probe: a
--   supersedes target deleted between update_thought's existence walk (a plain
--   SELECT that answers SUPERSEDES_NOT_FOUND) and its UPDATE (where the FK
--   fires) surfaced as a raw 23503 thoughts_supersedes_fkey, not the
--   SUPERSEDES_NOT_FOUND its COMMENT promises for "a target deleted in the
--   instant". This lock closes that window too, and from the same edge:
--   update_thought holds the supersession advisory lock across BOTH its walk
--   and its UPDATE whenever supersedes is named (033), and delete_thought now
--   contends on it. So through the shipped functions the two orderings are:
--     * update first — it holds the lock; delete(Z) waits; the walk finds Z,
--       the UPDATE takes KEY SHARE on a Z that is still there, commit, then the
--       delete's ON DELETE SET NULL (025's FK) clears the pointer. No 23503.
--     * delete first — it holds the lock, removes Z, commits; update then
--       acquires the lock, walks Z under a fresh READ COMMITTED snapshot, finds
--       it gone, and returns SUPERSEDES_NOT_FOUND. No 23503.
--   So the COMMENT's promise is now honoured rather than tightened — the walk
--   is authoritative because a delete cannot slip past it. No change to
--   update_thought: its body stays 033's byte for byte, and re-issuing a
--   280-line function to catch a violation the lock already prevents would add
--   risk, not safety.
--
--   The residue, stated: a raw `DELETE FROM thoughts` around delete_thought
--   takes no advisory lock and could still race update_thought's walk into a
--   23503 — exactly as a raw UPDATE of content around update_thought escapes
--   the fingerprint lock (033's header says as much). The lock order is a
--   contract among the shipped functions; a caller that writes thoughts by
--   hand is outside it by construction.
--
-- Carries forward
--   009's delete_thought body verbatim (the audit that 008's trigger writes on
--   the DELETE, with previous_content preserved, is unchanged), plus the one
--   advisory-lock line and a COMMENT clause naming it. And 032's
--   review_supersession_proposal body verbatim, with only the advisory-lock
--   acquisition relocated to the top — the two update_thought calls, the
--   no-UPDATE-of-its-own and no-walk-of-its-own shape are 032's. Both
--   signatures unchanged: delete_thought(uuid, jsonb) and
--   review_supersession_proposal(uuid, text, text, text, jsonb, boolean) — the
--   stores and the tools call them as before.
--
-- Verify
--   db/test-live.ts [6g]: the review-vs-delete race, forty tries each — the
--   pre-036 lockless delete deadlocks, the shipped pair does not, and the
--   cascade still removes the proposal. [6h]: the update-supersedes-vs-delete
--   race, forty tries, never a raw 23503 — always SUPERSEDES_NOT_FOUND or a
--   clean write. db/test-schema.ts [36] pins 036 as the last definer of both
--   functions and the lock before the row; [32]'s definer assertion moves
--   review_supersession_proposal 032 -> 036 (its behaviour assertions are
--   unchanged); [28] unchanged. server-portable/test-update-delete.ts
--   unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION delete_thought(
  p_id    uuid,
  p_actor jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted uuid;
BEGIN
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;

  -- 036: take the supersession advisory lock before the DELETE — the key
  -- review_supersession_proposal and update_thought take (029/032/033) — so a
  -- delete of a superseded thought serialises with an acceptance writing that
  -- pointer instead of deadlocking against it through 029's cascade. Taken
  -- unconditionally: the function cannot know whether a proposal names this row
  -- before the row is gone, and the acquire is one cheap hash entry. Held until
  -- the transaction ends, as every taker of this lock holds it.
  PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));

  DELETE FROM thoughts WHERE id = p_id RETURNING id INTO v_deleted;

  IF v_deleted IS NULL THEN
    -- A distinct outcome, not a silent success. The caller asked to remove a
    -- specific thing; not finding it is information.
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_deleted);
END;
$$;

COMMENT ON FUNCTION delete_thought(uuid, jsonb) IS
  'Hard-delete a thought by id. Chunks go by cascade; migration 008 audits the delete with previous_content preserved, which is what makes a hard delete recoverable. Takes the supersession advisory lock before the DELETE (036) — the one review_supersession_proposal and update_thought take — so a delete of a superseded thought serialises with an acceptance writing that pointer rather than deadlocking against 029''s ON DELETE CASCADE. Returns {ok:false, error:NOT_FOUND} rather than succeeding silently.';


-- ---------------------------------------------------------------------------
-- review_supersession_proposal — 032's body, verbatim, with the supersession
-- advisory lock relocated to BEFORE the proposal row lock (SMD-1462).
--
-- 032 took the lock in the accept path, after locking the proposal row P FOR
-- UPDATE. That left the deadlock this migration closes only half-shut: with
-- delete_thought now taking the lock before its DELETE, a delete holding the
-- lock still waited on P (029's ON DELETE CASCADE) while a review holding P
-- waited on the lock — a fresh cycle of the same two functions, reproduced
-- 10 of 40 by db/test-live.ts [6g] with delete_thought fixed but the review
-- not. Taking the lock before P closes it: a delete and a review now contend
-- on the lock first, and whichever wins runs to commit before the other
-- touches P. The ticket said the review reorder "is not enough on its own";
-- the delete-side lock is not either — both are needed, and here they are.
--
-- Nothing else moves: the two update_thought calls, the no-UPDATE-of-its-own
-- and no-walk-of-its-own shape ([32] asserts them) are 032's. The lock is now
-- acquired once, at the top, for accept and reject alike.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION review_supersession_proposal(
  p_id        uuid,
  p_decision  text,
  p_note      text  DEFAULT NULL,
  p_direction text  DEFAULT NULL,
  p_actor     jsonb DEFAULT NULL,
  p_force     boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  r           supersession_proposals%ROWTYPE;
  v_dir       text;
  v_old_edited boolean;
  v_new_edited boolean;
  v_sup       uuid;
  v_old       uuid;
  v_current   uuid;
  v_n         int;
  v_r         jsonb;
BEGIN
  IF p_decision NOT IN ('accept', 'reject') THEN
    RAISE EXCEPTION 'review_supersession_proposal: p_decision must be accept or reject, got %', p_decision;
  END IF;
  IF p_direction IS NOT NULL AND p_direction NOT IN ('newer', 'older') THEN
    RAISE EXCEPTION 'review_supersession_proposal: p_direction must be newer or older, got %', p_direction;
  END IF;
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;

  -- 036 (SMD-1462): the supersession advisory lock BEFORE the proposal row.
  -- delete_thought now takes this same lock before its DELETE, and 029's ON
  -- DELETE CASCADE from a deleted thought reaches the proposals that name it;
  -- taking the lock before P — not only at the acceptance below — is what keeps
  -- a delete of the superseded thought from holding P's row (through the
  -- cascade) while this review holds P and waits on the lock. Held for reject
  -- too: one order for every path, and cheap. See db/test-live.ts [6g].
  PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));

  SELECT * INTO r FROM supersession_proposals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND', 'id', p_id);
  END IF;

  IF p_decision = 'reject' THEN
    v_n := 0;
    IF r.status = 'accepted' AND r.pointer_written THEN
      -- Undo this proposal's OWN write while it still stands, and no further:
      -- a pointer the acceptance found already there (set at capture) is not
      -- this proposal's to clear, nor one a later edit pointed elsewhere
      -- (029, review pass 1). Read under the row lock, cleared through
      -- update_thought (032) — the edit path, audited as one.
      v_old := CASE WHEN r.superseding_id = r.newer_id THEN r.older_id ELSE r.newer_id END;
      SELECT supersedes INTO v_current FROM thoughts WHERE id = r.superseding_id FOR NO KEY UPDATE;
      IF FOUND AND v_current = v_old THEN
        v_r := update_thought(r.superseding_id, p_actor => p_actor, p_provenance => '{"supersedes": null}'::jsonb);
        IF (v_r->>'ok')::boolean THEN
          v_n := 1;
        END IF;
      END IF;
    END IF;
    UPDATE supersession_proposals
       SET status = 'rejected', reviewed_at = now(), review_note = p_note, superseding_id = NULL, pointer_written = false
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', 'rejected', 'cleared', v_n > 0);
  END IF;

  -- accept
  IF r.status = 'accepted' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_ACCEPTED', 'id', p_id, 'superseding_id', r.superseding_id);
  END IF;
  v_dir := COALESCE(p_direction,
                    CASE r.verdict WHEN 'newer_supersedes_older' THEN 'newer'
                                   WHEN 'older_supersedes_newer' THEN 'older' END);
  IF v_dir IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DIRECTION_REQUIRED', 'id', p_id, 'verdict', r.verdict);
  END IF;
  IF v_dir = 'newer' THEN v_sup := r.newer_id; v_old := r.older_id;
  ELSE                    v_sup := r.older_id; v_old := r.newer_id;
  END IF;

  -- Acceptances are serialised on the advisory lock taken at the top of this
  -- function since 036 (before 036 it was taken here, after the proposal row):
  -- the walk in update_thought reads other rows' pointers, and two accepts
  -- running at once — A over B in one, B over A in the other — would each walk a
  -- chain the other has not committed yet and both write, closing the loop the
  -- check exists to refuse (029, review pass 1). update_thought takes the same
  -- lock for a supersedes write, re-entrant here, so a hand edit and an
  -- acceptance are serialised with each other too. A reviewer's call is
  -- human-paced; one lock for all of them costs nothing that shows.
  -- The superseding row, locked; its current pointer decides. update_thought
  -- takes the same lock on it again inside this transaction — held already.
  SELECT supersedes INTO v_current FROM thoughts WHERE id = v_sup FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND', 'id', p_id, 'thought_id', v_sup);
  END IF;
  -- The verdict was about the texts as judged. Either edited since (016's
  -- fingerprint differs; an unknown fingerprint counts as unchanged) is
  -- refused unless the reviewer, shown both texts, says p_force (029, review
  -- pass 3). Read here, under the advisory lock and after the superseding
  -- row is locked, so that row's text is what the write will see; the
  -- superseded thought's text is read unlocked, and an edit landing in that
  -- instant under a human-paced call is the residue (029, review pass 4).
  -- updated_at is not the signal: this function moves it itself.
  SELECT r.older_fingerprint IS NOT NULL AND r.older_fingerprint IS DISTINCT FROM content_fingerprint_of(content)
    INTO v_old_edited FROM thoughts WHERE id = r.older_id;
  SELECT r.newer_fingerprint IS NOT NULL AND r.newer_fingerprint IS DISTINCT FROM content_fingerprint_of(content)
    INTO v_new_edited FROM thoughts WHERE id = r.newer_id;
  IF NOT COALESCE(p_force, false) AND (COALESCE(v_old_edited, false) OR COALESCE(v_new_edited, false)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'EDITED_SINCE', 'id', p_id,
                              'older_edited', COALESCE(v_old_edited, false), 'newer_edited', COALESCE(v_new_edited, false));
  END IF;
  IF v_current IS NOT NULL AND v_current <> v_old THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_SUPERSEDES', 'id', p_id,
                              'superseding_id', v_sup, 'current', v_current);
  END IF;

  -- The write, when there is one: through update_thought (032), which walks
  -- the chain for a loop (WOULD_CYCLE) and answers a target deleted in the
  -- instant (SUPERSEDES_NOT_FOUND); a refusal is returned as it came, with
  -- this proposal's id and pair added. A pointer already holding the value
  -- is not written again — updated_at and the audit stay as they are, and
  -- pointer_written says so (029, review pass 1).
  IF v_current IS DISTINCT FROM v_old THEN
    v_r := update_thought(v_sup, p_actor => p_actor, p_provenance => jsonb_build_object('supersedes', v_old));
    IF NOT (v_r->>'ok')::boolean THEN
      RETURN v_r || jsonb_build_object('id', p_id, 'superseding_id', v_sup, 'superseded_id', v_old);
    END IF;
  END IF;
  UPDATE supersession_proposals
     SET status = 'accepted', reviewed_at = now(), review_note = p_note, superseding_id = v_sup,
         pointer_written = (v_current IS DISTINCT FROM v_old)
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', 'accepted',
                            'superseding_id', v_sup, 'superseded_id', v_old,
                            'written', v_current IS DISTINCT FROM v_old);
END;
$$;

COMMENT ON FUNCTION review_supersession_proposal(uuid, text, text, text, jsonb, boolean) IS
  'The reviewer''s decision on one proposal, and the only path from the table to thoughts.supersedes — through update_thought since migration 032, so every edit of the column goes through the one edit function (a capture''s add-if-empty through upsert_thought aside): accept sets the pointer on the thought the verdict (or p_direction, required for an undirected verdict) names as current, refusing a pointer at a third thought, one that would close a loop (update_thought''s walk), or a pair whose text changed since it was judged unless p_force; reject marks the row and clears an accepted write of its own while it still stands. p_actor is set on ob1.actor for the audit trigger. The supersession advisory lock moved before the proposal row in 036, so a delete of the superseded thought (which takes the same lock before its DELETE) cannot deadlock the review through 029''s cascade. Migration 029 / 032 / 036.';
