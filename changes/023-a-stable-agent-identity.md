# 23. A stable agent identity — `ob1_agents`

Ported from `schemas/per-agent-identity` as migration 010 plus `agents.ts`
(Linear SMD-928). Start with the unflattering part, because it changes the
size of the feature.

**The property the extension exists to provide, this fork already had.** Its
pitch is that rotating an agent's key must not orphan its history. Migration 008
records `thought_audit.actor_name` — the *name* of the access key, never its
digest — so swapping the hash in `laptop:write:<sha256>` already left every prior
row correctly attributed. Nothing needed to change for rotation to survive.

What binding to a name does **not** survive, and what 010 actually buys:

1. **A rename.** `laptop` becomes `macbook` and the history is stranded under a
   name nothing points at. Nothing records that they are one agent, and after the
   fact nothing ever can.
2. **Name reuse.** Retire `laptop`, hand the name to an unrelated client six
   months later, and two agents' histories silently merge.
3. **A typo.** `actor_name` is free text arriving from an environment variable.
   `labtop:write:…` invents an agent indistinguishable from a real one.
4. **Revocation as an event.** `MCP_ACCESS_KEYS` holds only currently-valid keys.
   It is a configuration, not a history: deleting the line is the whole record.
5. **Revoking without a redeploy.** Killing a leaked key meant editing a secret
   and restarting.

So the honest framing is not "attribution now survives rotation" but "attribution
now survives a *rename*, distinguishes reuse, and leaves a record of the
credential itself".

**The environment stays the authenticator.** Upstream's design has the server
hash a presented key and ask the database whether it is valid. Doing that here
would give the deployment two sources of truth for which keys work, and the
failure mode of disagreement is a key that authenticates against one and not the
other. `auth.ts` is unchanged in what it decides: the env says whether a key is
valid and what scope it has, with no database round trip, so `tools/list` still
answers against a dead Postgres. The registry answers only *who* the key belongs
to — plus one veto, `revoked_at`, which can only ever be **more** restrictive than
the environment, never less. That direction is what makes a second gate safe
rather than a second source of truth.

**Name and digest together, so a rename and a rotation are distinguishable.**
The digest is what stays constant when the name changes; the name is what stays
constant when the key is rotated. `resolve_agent(hash, label, scope)` holds both:
hash known and label new is a rename, label known and hash new is a rotation, and
both preserve the id. Registration happens on first sight, so an existing
deployment needs no admin step — the registry fills itself as clients connect.

One ambiguity is stated rather than hidden: renaming **and** rotating in the same
step is indistinguishable from a new agent and is treated as one, because both
identifiers changed at once and nothing is left to join on. Do the two separately
and the chain holds.

Departures from the extension, each a consequence of running off Supabase:

- **No `SECURITY DEFINER`.** Upstream's lookup RPC is a definer function so a
  low-privilege `service_role` can read a table it has no rights to. Here the
  application connects as the role that *owns* those tables, so a definer
  function grants nothing it does not already hold — while adding the
  `search_path` attack surface that makes `SECURITY DEFINER` worth avoiding when
  it buys nothing. Migrations 004 and 008 set the precedent; `db/test-schema.ts`
  enforces it.
- **No RLS, no `service_role` grant, no `REVOKE … FROM PUBLIC`.** A policy that
  never evaluates is not security, it is the appearance of it.
- **One field for revocation, not two.** Upstream carries `active boolean` *and*
  `revoked_at timestamptz` with a CHECK keeping them consistent — two columns
  encoding one fact, which is the pair that drifts the first time something
  updates one and not the other. `revoked_at IS NULL` means active.
- **Prefixed names.** `openbrain_agents` becomes `ob1_agents`, matching
  `ob1_config`. `agents` unqualified is too generic for a database that may not
  belong exclusively to this application.

**Failure is not a refusal.** If the registry is unreachable — or migration 010
simply has not been applied — `agents.ts` returns no id rather than throwing, and
attribution falls back to the key's name, exactly where it was before 010.
Denying instead would buy nothing: with the registry down every tool this server
exposes is also down, since they all read the same database. A *definitive*
`REVOKED`, by contrast, is an answer, and it is enforced at the request boundary
so a revoked read-only key cannot read either — a leaked connector URL being the
likeliest thing anyone ever revokes. Failed lookups are cached for ten seconds so
a dead database costs one connection attempt per interval rather than one per
request.

Successful resolutions are cached for `OB1_AGENT_CACHE_TTL_MS` (default 60s),
which *is* the delay between setting `revoked_at` and the key stopping — the one
number an operator revoking a leaked credential cares about. The cache is keyed
by digest **and** name: keyed on the digest alone, the first request after a
rename would return the cached entry, the rename would never reach the database,
and `ob1_agents` would keep the stale label until the TTL happened to lapse.

Two small things this shook out elsewhere. `auth.ts` now **rejects two key names
sharing one digest** — dead config before, a genuine ambiguity once a digest
identifies an agent. And the actor is serialised through one `actorPayload()`
rather than passed through: the trigger reads `actor->>'agent_id'` while the
TypeScript field is `agentId`, so passing the object unchanged type-checks, runs
without error, and writes NULL into `canonical_agent_id` on every row. Reverting
that one call fails eight assertions in `test-agents.ts`, which is the only
reason to trust the rest of them.

A review pass found two defects and one untested claim, all the same shape —
something asserted in prose that nothing held:

- **`OB1_AGENT_CACHE_TTL_MS=0` did not mean what it says.** Documented in three
  places as "resolve on every request", it capped *failed* lookups at a fixed
  ten seconds regardless — quietly false for exactly the answers an operator
  setting 0 is trying to observe. The failure TTL is now bounded by the
  configured one, so 0 means 0 and any nonzero value still caps a dead database
  at ten seconds.
- **`resolve_agent` reported `created: true` when it had not created anything.**
  Two callers racing on an unregistered key both took the `ON CONFLICT` path and
  both claimed to have made the agent. `RETURNING (xmax = 0)` is true only for a
  row the statement actually inserted.
- **Nothing tested the upgrade.** Every suite calls `resetSchema`, which builds
  all ten migrations against an empty database — the one situation a real
  deployment is never in. A migration that only worked on an empty table would
  have passed the entire gate. `db/test-upgrade.ts` now applies them one at a
  time onto a database with rows already in it, asserts the incremental schema
  matches a from-scratch one, and covers 010-onto-populated-009 specifically:
  prior rows read NULL, the append-only trigger still refuses UPDATE after the
  `ALTER`, and re-applying adds nothing. `test-agents [11b]` covers the other
  half — the new server against a database still at 009, where the point is not
  that the lookup fails but that the request behind it still succeeds.

Also dropped a partial index copied from upstream: on a table holding one row
per configured credential, indexing the active subset of a set Postgres would
sequentially scan anyway is maintenance with no reader.

`preflight` treats a missing registry as a **warning**, where a missing audit
trigger is fatal. The distinction is not squeamishness: without audit, history is
lost and cannot be reconstructed; without 010, every mutation is still attributed
by key name, exactly as before. Refusing to start over a feature whose absence
degrades cleanly would make applying a migration a hostage situation.

To revoke a key without touching the environment, take the digest from
`MCP_ACCESS_KEYS` and run:

```sql
SELECT revoke_agent_key('<the sha256 from your config>', 'found in a shell history file');
```

It is idempotent, and a repeat call keeps the first timestamp **and** the first
reason — the second reason is invariably the vaguer of the two, because whoever
writes it already believes the key is dead.
