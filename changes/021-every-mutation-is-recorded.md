# 21. Every mutation is recorded — `thought_audit`

Ported from `schemas/thought-audit` as migration 008 (Linear SMD-926). Nothing
recorded who changed what, and audit only ever describes events that happened
after it existed — so every capture made before this was permanently
unattributed. That asymmetry is why it is core rather than an extension.

Three departures from the extension, each a correctness fix rather than a
preference:

- **Append-only is enforced by a trigger, not by grants.** Upstream grants
  `SELECT, INSERT` to `service_role` and withholds `UPDATE`/`DELETE`. That works
  on Supabase, where the application role does not own the table. Off Supabase
  the application owns the schema, and **an owner's privileges cannot be
  revoked** — so the grant approach would have offered no protection while
  appearing to. A `BEFORE UPDATE OR DELETE` trigger refuses both for every role.
- **No RLS, no `service_role`**, consistent with migration 004's precedent and
  with what `db/test-schema.ts` already asserts.
- **The audit row is written inside the mutating transaction.** Upstream
  describes audit writes as "fire-and-forget… failures here never block the main
  operation", which for an audit log means silently losing the events it exists
  to record. A trigger on `thoughts` cannot fail separately from the mutation,
  and it covers every path in — including the tools SMD-927 will add.

The actor reaches the trigger on a transaction-local setting (`ob1.actor`, set
with `set_config(..., true)`), carrying the access key's *name* from `auth.ts`.
Transaction-local rather than session-level so it cannot leak to the next request
on a pooled connection — `test-audit.ts` asserts that directly. `actor_name` is a
first-class column rather than a key in `actor_context` so SMD-928 can promote it
to a canonical id: promoting a column is a migration, promoting a JSON key is
archaeology. Fix 23 did exactly that, adding `canonical_agent_id` beside it
rather than replacing it — the name records what the agent was *called* at the
time of writing, which a later rename would otherwise erase.

`thought_id` is deliberately not a foreign key, so audit rows outlive their
subject — the delete event being the one most worth keeping.

The actor rides in `p_payload`, which has been an **envelope** since migration
004 — that function reads only `p_payload->'metadata'` and ignores every other
key — so `p_payload.actor` needed no new overload and works identically on both
stores. The first version set the setting from `store-sql.ts` alone, which left
every audit row written through PostgREST with a NULL actor: present, plausible,
and wrong. `test-store-postgrest.ts` now asserts attribution on that path, and
that the actor does not leak into the thought's own metadata.

Redefining `upsert_thought` from a later migration has one trap worth naming:
`CREATE OR REPLACE` takes the whole body, so **every change made to it in
between is silently reverted**. Writing 008 without migration 005's
payload-validation guard dropped it, and `db/test-schema.ts` caught it on the
next run. Anything redefining that function again must carry both 005's guard
and 008's actor setting forward.

Two things a second review pass caught, both the same shape — the feature
working while quietly doing the wrong thing:

**A duplicate re-capture was logged as an update that changed nothing.** The
fingerprint dedup exists so a bulk re-import is idempotent, and a re-capture of
identical content takes the `ON CONFLICT` branch, moving `updated_at` and nothing
else. That wrote one audit row per duplicate with an empty diff, so re-running a
10,000-thought import produced 10,000 rows saying nothing happened — unbounded
growth on the operation designed to be repeatable, and a log too noisy to answer
the question it exists for. The trigger now returns early when the diff is empty:
`updated_at` moving alone is bookkeeping, not history.

**`preflight.ts` reported OK on a database with no audit table.** Captures
succeeded and went unrecorded, and the only symptom was history that never
existed. Now a `fail`, matching how migration 004's absence is treated — and it
checks the *trigger*, not the table, because the table alone would pass while
nothing wrote to it. Serving unaudited for a week is a week that cannot be
reconstructed, which is worse than a crashloop because it is invisible.

One incidental finding, recorded because it changed the implementation: **Bun's
Postgres client returns the `HINT` field as UTF-16 bytes with interleaved nulls**
(`"T\0o\0 \0p\0r\0u\0n\0e\0…"`). Guidance put in `USING HINT` is unreadable to
the runtime this server uses, so it lives in the exception message instead. A
hint nobody can read is worse than none, because it looks like it worked.
