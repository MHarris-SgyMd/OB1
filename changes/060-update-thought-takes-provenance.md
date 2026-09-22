# 60. `update_thought` takes provenance — `supersedes` and `derived_from` can be set, changed and cleared through the one edit function, and the review path writes through it (SMD-1323)

Change 46 put `derived_from` and `supersedes` on `thoughts` and let
`capture_thought` set them through the payload envelope, and deferred the other
half in the function's own body: a re-capture *adds* provenance and never
clears it — "removing or changing provenance is `update_thought`'s job (a
follow-up)". Nothing took the follow-up. A supersession recorded wrong at
capture had two ways out, a raw `UPDATE` or `delete_thought`; and when change
54 needed to write `supersedes` on an accepted proposal, its ticket's
"accepting one calls `update_thought`" could not be honoured, so
`review_supersession_proposal` set `ob1.actor`, locked the row and wrote the
column in one `UPDATE` of its own — the audit outcome the same as an edit's,
018's "one writer stays one writer" bent by one function, and 029's header
saying so.

**Migration 032.** `update_thought` gains a ninth, defaulted parameter,
`p_provenance jsonb` — the envelope shape `upsert_thought` has read since 025,
`{"supersedes": <uuid> | null, "derived_from": [<uuid>…] | null}`. An absent
key leaves its column alone; a JSON null clears it; a value sets it, validated
as 025 validates at capture. The 8-argument form is **dropped first** and its
ACL replayed onto the new one (021's mechanism, 020's block), since an overload
beside it would make every call with eight arguments or fewer `function is not
unique` — and 018's 7-argument form is dropped `IF EXISTS` too, so a brain
where 018 was re-applied by hand ends with one function. 021's body is carried
forward verbatim (`test-schema` [32] reads each earlier migration's piece out
of `pg_proc` by name, as [19] and [22] do). Three things the redefinition adds:

- **`validate_derived_from(jsonb)`**, 025's element rule as one function —
  null, JSON null and `[]` are NULL; otherwise an array whose every element is
  a UUID string naming an existing thought, returned lowercased, de-duplicated
  and sorted, or one of 025's three exceptions. `upsert_thought` keeps its
  inline copy until its next redefinition (SMD-1043, change 63) takes this one — the
  shape 016's `content_fingerprint_of` took, with 018 the first caller — and
  [32] holds the two equal meanwhile, input by input, message by message.
- **The `supersedes` checks.** Shape by regex (an exception, as capture);
  existence answered as a refusal, `SUPERSEDES_NOT_FOUND`, where the ticket
  said "by the self-FK" — the cycle walk reads the target's row anyway, so the
  answer is free, and the function's contract is refusals as objects
  (`NOT_FOUND`, `STALE_READ`, `DUPLICATE_CONTENT`), where a 23503 at the tool
  boundary is the opaque error 009 removed; the FK still stands behind it for
  the race and for every other writer. And 029's cycle walk, moved here:
  `WOULD_CYCLE` when the target is the thought itself or the chain of pointers
  from the target reaches it, bounded at 1000 steps. A supersedes write takes
  029's advisory lock **before** the row lock, so every path acquires in one
  order — supersession lock, row, fingerprint lock (change 63 moves the
  fingerprint lock before the row, for every writer) — and a hand edit and an
  acceptance are serialised with each other; the header states the order and
  why no pair crosses.
- **`review_supersession_proposal` redefined** (029's body) to call
  `update_thought`: accept passes `{"supersedes": <older>}` on the superseding
  thought, reject passes `{"supersedes": null}` when the pointer it wrote still
  stands. Its own `UPDATE`s of `thoughts` and its walk are gone; a refusal
  `update_thought` returns comes back through the proposal with the pair
  named, so `consolidate.ts --accept` prints the same sentence. The
  proposal-level rules — `DIRECTION_REQUIRED`, `ALREADY_ACCEPTED`,
  `EDITED_SINCE`, `ALREADY_SUPERSEDES`, `pointer_written`, "undo only your own
  write" — are untouched, and [28] passes over the new body unchanged.

A provenance-only edit is an edit: the row is locked, `if_unchanged_since` is
a predicate on the write, `updated_at` moves, and the audit row carries the
diff with the actor — what 029's `UPDATE` did under the triggers, now by the
one path. Content, vector, label, fingerprint and windows are untouched unless
`content` arrived. `derived_from` through the envelope **replaces** the array;
a merge would be a second verb, and 025's re-capture already does "add if
empty" (until change 66, which drops the fill).

**The row lock is `FOR NO KEY UPDATE` now, not 018's `FOR UPDATE`** — the one
line of 018's this migration changes, found by the first review pass. Writing
`supersedes` is the first time `update_thought` writes a foreign-key column,
and the FK check takes `FOR KEY SHARE` on the *target* row: a fourth lock, on
another row, taken last. `KEY SHARE` conflicts with `FOR UPDATE` and not with
`FOR NO KEY UPDATE`. So under 018's lock: A edits Q with content T and
`supersedes` Z (holds the supersession lock, Q, the fingerprint lock for T); B
edits Z with content T (holds Z, waits on the fingerprint lock); A's `UPDATE`
waits for `KEY SHARE` on Z — a deadlock, and one caller gets 40P01 where 018
promised `DUPLICATE_CONTENT`. `FOR NO KEY UPDATE` still conflicts with itself,
with `FOR UPDATE` and with `FOR SHARE`, so two edits of one row serialise as
before, 022's read in `upsert_thought` is still ordered against it, and
`delete_thought` still waits; the id never changes, so `KEY SHARE` is the only
lock it lets through. `test-live` [6d] holds both arms: a `FOR UPDATE` holder
in B's place deadlocks, the function does not.

**Callers.** `UPDATE_THOUGHT_SIGNATURE` names the 9-argument form and
`SUPERSEDED_SIGNATURES` the 8-argument one (the schema reset drops it, as a
test re-applies 021). Both stores send `p_provenance` — `provenanceEnvelope()`
in `store.ts` builds it for the SQL positional call and the PostgREST named one
alike, so an absent key reaches the function absent (null means *clear* there)
and an edit naming nothing sends NULL. `reembed.ts`'s positional eight resolve
through the default; its refusal names the nine-argument form and asks the
ledger about 032 when the column is there and the body is not. Preflight's
`edit signature` reads for the 9-argument form alone, over both connections:
018's or 021's form beside it fails the start with the exact `DROP` — the state
SMD-1323's verify names, and the one 021 re-applied by hand puts a brain in —
and a form from before 032 fails naming 032. The MCP `update_thought` tool
takes `supersedes`: an id sets, `null` clears, omitted leaves, and a
supersedes-only edit is no longer "would do nothing"; the two refusals are
explained in the tool's words, and a value that is not an id is refused at the
tool before the database sees it. `derived_from` is not offered on the tool —
an edit to a synthesis's source list is a store-level operation with no client
asking for it yet; the stores take it.

**Every checkout that runs against the brain upgrades together** (the second
review pass). A pre-032 checkout's preflight refuses a 032 database with a
message naming 021 (it looks for the 8-argument form and finds none), its
`reembed.ts` refuses the same way and sends the operator to `--reapply` — and a
pre-032 `migrate.ts --reapply` re-runs 001–031, where 021 re-creates the
8-argument form *beside* 032's: the two-form state above, every call with eight
arguments or fewer `function is not unique`, until a 032 checkout re-applies.
The compose stack is in lockstep; a hand-run server, a second workstation or a
Supabase brain migrated from one laptop and served from another is not.
`server-portable/README.md` §4 says so. The migrator cannot see the hazard
today — it reads the directory, never a ledger row with no file — and refusing
`--reapply` when the ledger names a file the checkout lacks is SMD-1451.

**Verify.** `test-schema` [32]: one function of nine parameters, neither older
form beside it, 032 the last definer of the three names it touches, every
earlier migration's piece in the body by name; set, leave, replace and clear
for both keys with the audit row per change and nothing else moved; a ghost, a
self-pointer, a direct loop and a loop through a chain refused with nothing
written; the four exceptions; the envelope double-encoded refused as 005
refuses a payload; `if_unchanged_since` guarding a provenance edit;
`validate_derived_from` against `upsert_thought`'s inline copy on four inputs;
the review path's acceptance producing `update_thought`'s audit row and its
`WOULD_CYCLE` naming the pair; 021 re-applied leaving the 8-argument form
beside the 9-argument one (an 8-argument call `not unique`), 032 dropping it,
and a revoke and a grant on the 8-argument form carried across the `DROP`.
[22] and [23] follow the last definer ([23] restores `update_thought` after
its 021 re-apply, which now matters). `test-preflight`: the 9-argument form
alone ok; 018 beside it, then 021 beside it, each refused with its own `DROP`
and only that one; 018's form alone and 021's form alone each refused naming
032. Both store suites round-trip set, leave, clear and the two refusals as the
union rather than a throw. `test-update-delete` [9] drives the tool: set with
the reply naming the pointer and the audit row under the key's name, a loop
and a ghost refused in the tool's words, omit leaves, null clears.
`test-live` [16] is unchanged in outcome; [6d] holds the lock-order arms.
`test-upgrade` [10] applies 032 through the migrator onto a populated 031
with a hardened 8-argument form: one 9-argument function afterwards, the ACL
carried, no row and no audit row moved, an 8-argument positional call still
resolving, the envelope clearing a capture-time pointer, a re-run a no-op —
and [7]'s `--reapply` assertion follows the arity (the first review pass found
it still saying eight; CI runs that suite). Green: `test-schema`
749/749, `test-preflight` 191/191, `test-upgrade` 119/119,
`test-live` 457/457, `test-store-sql`, `test-store-postgrest`,
`test-update-delete`, `test-e2e-sql`, `tsc`, the consistency checker.

**Not done, and why.** `upsert_thought` still carries its inline copy of the
derived_from rule — switching it is a redefinition of the other function, which
SMD-1043 owns (change 63 does); whichever of the two lands second carries the first's body. No
`derived_from` input on the MCP tool (above). The three audit reads in the test
suites that ordered by the audit table's uuid key now order by `created_at` —
one of them, [28]'s, was a latent flake this section's twin assertion exposed.
[32]'s reads later left `created_at` too (SMD-1514): separate transactions do
not promise distinct values of it — PGlite's clock has millisecond grain
(change 65's [34] note, SMD-1498) — so each read is now the set difference of
the thought's audit ids across the one write, and the `updated_at` compare
sleeps 2 ms first, since 001's trigger re-stamps the column on any UPDATE and
disabling it would disarm what [9] tests; [9]'s own compare, `>=` across two
statements, passed with the trigger dropped and now sleeps the same 2 ms and
asserts `>`. [28]'s read is unordered and asserts what makes it safe: its
thought has one update row when it is read.

Upstream status: **not applicable** — upstream's `update_thought` (the
`integrations/*-thought-mcp` recipe 009 ported) has neither the provenance
columns nor the review table.
