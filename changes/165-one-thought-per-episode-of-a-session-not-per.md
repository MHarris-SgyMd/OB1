# 165. One thought per episode of a session, not per session — the hook segments a transcript at compactions, moves and new tickets, each piece with its own provenance and its own chain (SMD-2013)

**What changed.** `recipes/session-capture-hook/session-capture.mjs`: both
transcript parsers now emit events in transcript order — a line's time,
directory and branch, then its ask, outcome, files, commits, pushes, PR links
and the brain's ids — and `segment` folds them into the session's summary and
its episodes. An episode ends, and the next begins at the next ask, at a
compaction (the harness's summary line, by its flag or its first sentence),
when the session moves to another branch or to another directory that is not
inside the one it was in, or at an ask that names a ticket none of the
episode's asks, its branch or its directory named. The session's place is
followed on every line; an episode's is where it runs, and a move away is
the next episode's, never the ended one's. Refinements from the fork's own
transcripts: the harness records the shell's directory per command, so a
`cd` within the checkout, or out of it with the branch unchanged, is no move,
nor is a move the session came back from before the next ask, nor a detached
`HEAD`; the branch is made a few lines after the ask that names its ticket, so
a move to a branch or directory naming a ticket the episode is ABOUT — its
opening ask's, its first ask's, its home's — is its own, and one made under an
episode about nothing gives the work its name, while a ticket an ask merely
mentioned makes no move its own; on a branch that names a ticket, such a
mention does not end the episode — only an ask followed, before the next ask,
by the move to the new ticket's branch does, and the episode opens at that
ask; a key in an ask counts for a team the session's branches or directories
have named so far, in capitals before any is known. A compaction and a move
between two asks are both recorded. Work
between a boundary and the next ask belongs to the ask that caused it.
Boundaries are fixed once written, so an episode's ordinal, text and
fingerprint stand;
`renderSummary` puts the episode's tickets first in the head and, when the
session has more than one episode or the episode is over, an `Episode N of the
session, begun …, ended …` line before the closing lines — a session of one
episode reads as before. Each episode chains under its own key
(`episodeChain`: the session's id for the first, `<id>#e<n>` after), so the
state files, the payload names, and every rule of SMD-2035's queue — the
step-aside, the obsolete rule, the pointer, the follow-up — key on `chain_id`
(`chainOf`, the session's id for a payload from before this change). `prepare`
writes one payload per episode whose summary changed, skips one unchanged or
already queued by fingerprint, refuses one carrying a secret alone (exit 1,
the others still post), and hands every one to the run's one child (`--post`
repeated; `postPending` takes a list); the five per run (`RUN_MAX`) bound the
payloads that waited from before. `--dry-run` prints the segmentation first — one
line per episode with its tickets, branch, asks, span and bounds — then each
episode's text. Version 1.2.0; the README, the catalogue row and the skill's
coexistence note say episode; the CI comment names the ticket.

**Why.** The first dogfood session ran two days across nine tickets, and its
one summary was the last compression of all of them: titled for the first
task, its `derived_from` every task's sources mixed, and no search for any
one ticket landed on it. Run over that transcript, `--dry-run` now prints nine
episodes, one per ticket in the order they were worked, each on its own
branch, with the compaction that closed each.

**Held.** `bun recipes/session-capture-hook/test-session-capture.mjs`,
484 assertions (from 414), three runs: the ticket-key shape and what it is
not; each boundary rule alone on events (the subdirectory, the branch that
names the ticket, the adoption, the mention on an anchored branch, the ask
followed by its move, compactions before, between and after asks); the
ticket's fixture — two compactions, a move, three tickets — cut into four
episodes with the expected asks, outcomes, files, spans and `derived_from`
split, rendered with the tickets first and the episode line; every prefix of
that transcript segmenting into a prefix of the whole's episodes, the closed
ones word for word; one payload per episode on its own chain, posted and
recorded as four states; a re-ending with one more ask preparing and posting
the last episode alone, superseding its own, the others untouched; the
checkpoint line on the open episode alone; a secret in one episode refused
alone; seven episodes handed to the child five at a time; the hook end to end
synchronous and detached; the dry run's segmentation, checkpoint preview and
refusal by episode. The shared fixture stays one episode — its compaction line
sits after its last ask, a boundary armed and never opened — so the 414 hold
as the compatibility path. Fifteen mutants on the segmenter and the
per-episode capture, fourteen killed; the fifteenth — the compaction flag
read by the sentence alone — given a tooth and killed.

**Review passes.**

| Pass | Finding | Caught by | Fix |
| --- | --- | --- | --- |
| 3 | Both reviewers reached the stop signal — no code defect, only edges: a `<sid>#e2` chain's state file could cross-read a session id ending `_e2` (the `#`-to-`_` sanitisation this change introduced), so an episode superseded the wrong thought; the pairing's `HEAD` guard and the unanchored branch of `began` were unpinned | cold-read + run-it + mutant | a state file records its `chain_id` and a read rejects another chain's; two teeth |
| 2 | The team set was built from the whole transcript, so a keyed branch made later made an earlier lower-case mention a key and moved a boundary already captured; a line's cwd-first return from a nested worktree settled onto the episode it ended before its branch arrived, so a closed episode's text moved as the transcript grew; an ex-home key lingered in `about`, so a return to the branch an episode began on was absorbed; an ancestor of the checkout counted as inside it; a run's own episodes beyond five waited for a run that might never come; a key an ask merely named beside a move was stamped as the boundary's ticket and joined `about`; `AES-256` split an unanchored episode; a closed episode's payload carried the open one's event; a stale comment | cold-read + run-it | teams gathered as the walk goes; a line's cwd and branch as one move; `own` reads the home live; `below` a root; every own payload posts; `began`; the team rule once a team is known; no event on a closed episode; twelve mutants, all killed |
| 1 | A move was applied to the episode it ended, so a closed episode's head named the branch, project and — when its asks named none — the ticket the session moved TO (33 of 69 episodes of a real transcript read `OB1 (main)`); a cd between two subdirectories of one checkout split, as did a round trip and a rebase's detached `HEAD`; a plan that mentioned the next ticket made the later move to its branch the episode's own, so it never split; `node-22` was a ticket; a compaction beside a move kept only the later reason; the Stop gate read the open chain alone; the queue was walked once per episode; `flag` and `flagAll` were two copies; seven surviving mutants | cold-read + run-it + mutant | the session's place against the episode's, `about`, teams, `moved`, one listing, the gate across chains, `flag` as `flagAll`'s last; twelve mutants, eleven killed, one equivalent |

**Not taken.** Merging across a compaction when the ticket continues: the
ticket names a compaction as a boundary, and this session's own transcript
shows why — its compactions fell between tickets. One state file per session
with an episode map (the ticket's sketch): one file per chain reuses every
rule of the queue unchanged. A `metadata.episode` marker on the capture (the
ticket's note): the wire contract stays `content`, `source`, `derived_from`,
`supersedes`; the episode line in the text says it. A configurable ticket
shape: the key shape with a short deny list covers Linear-style keys under
any team. Codex has no compaction line this hook knows; its boundaries are
moves and tickets. Sizing the drain room from the run's own payloads that
still exist rather than the count it prepared (a review pass raised it): the
difference is one wasted drain slot when a sibling took an own payload,
self-correcting the next run, and not worth a fragile test. `detachPost`'s one
`--post` per episode on the child's command line: bounded by a session's pieces
of work.

**Boyscout.** After the stop signal, what the passes left spelled more than
once, no behaviour changed (the dry run over the fork's own transcripts is
byte-identical): the team a branch or directory names is learned in one place
(`learnTeams`), spelled at the two events that carry a branch; the head's
tickets and the dry run's segmentation line read the `anchorOf` helper rather
than respelling its branch-and-directory union; and prepare's re-set of an
episode's session id, which segment set from the transcript, says the hook's
id wins. The suite and the checker held.

**Follow-ups.** None filed. Dogfood: re-copy the script to
`~/.local/share/open-brain/session-capture.mjs` after this merges; the
printed hook pair is unchanged, so nothing is re-pasted. The next end of a
long-running session posts one thought per episode, superseding the old
whole-session thought from the first episode's chain.

**Upstream status.** Not upstream.
