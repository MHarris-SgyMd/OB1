# 183. A `source:` egress term gates a row's stored label, not who may capture (SMD-1941)

**What changed.** `server-portable/index.ts`: the `capture_thought` handler's
`EgressSubject` no longer carries `metadata: { source }`. That is the whole fix:
a capture's `source` is the caller's claim, so keeping it OFF the subject means
no `source:` egress term can match the call — the dodge is closed at the call
site. The row still RECORDS the label in its payload (unchanged: SMD-1297's
per-source weight and the passes read it). `server-portable/egress.ts`:
`termMatches` gates the `source` unit on `metadata.source` for ANY subject that
carries it — it does NOT branch on kind. Every subject with a `source` has one
the server wrote: an edit and the re-embed/consolidation passes (the stored row),
and `db/sync-linear.ts`'s capture of a Linear issue (`source: "linear"`,
authoritative — the pass-1 finding below). The docblock records the rule.

`server-portable/preflight.ts` and `deploy/.env.example`: the `source:` warning
and the unit docs say a `source:` term does not gate a `capture_thought` capture
(its source is a claim, kept off the subject) and gates a row's stored label at
an edit and the passes; gate who may capture with `actor:<key name>`.

**Why.** SMD-1298 gave `capture_thought` an optional `source` so a session-end
hook's summary lands with `metadata.source` naming the harness. Before it, every
MCP capture's `source` was the server's own constant `mcp`, so an egress term
like `deny source:claude-code` was trustworthy for captures — only the server
wrote the value. Once the caller names it, a hook (or whoever holds its key) that
omits `source` is `mcp` to the policy, and a term meant to keep hook captures off
a remote model is dodged by not naming oneself. A capture's `source` cannot be a
security boundary; `actor:` (the key, proven) is. The value keeps its worth as a
row's stored label — for the per-source weight (SMD-1297) and for the passes'
gate over rows already tagged — where the server, not the caller, wrote it. This
is option 2 of the ticket: make `source` advisory at capture, rather than binding
a label to the key record (option 1).

**Held.** `bun server-portable/test-egress.ts` against real Postgres, 118
assertions: `termMatches` gates a `source:` term on a capture subject that CARRIES
the label (`db/sync-linear.ts`'s, authoritative) and matches nothing on a capture
subject with no source (`capture_thought`'s, the claim kept off), and the
`re-embed`/`edit`/`judge` paths gate on the stored row's label; and, at the
server, with `source:claude-code` in the frozen allow policy, a gated
`capture_thought` call that NAMES `source:claude-code` is still refused at zero
requests while the row RECORDS `source:claude-code` — the claim is stored, it
does not open the gate (re-adding `source` to the capture subject lets it leave
and fails this, verified pass 2).
`bun server-portable/test-preflight.ts`, 175 assertions: the `source:` warning
says the term does not gate a `capture_thought` capture and points at `actor:`.
`bun server-portable/test-server.ts`, 285 assertions, and the server typecheck:
unchanged, the capture path gates on `actor` and `marker`.

**Review passes.**

| Pass | Finding | Caught by | Fix |
| --- | --- | --- | --- |
| 3 | No correctness or safety defect — the confirming pass. The cold read traced `[7]` end to end (the refused-vs-allowed outcome hinges only on the source-drop, so it is not vacuous) and verified adding `source:claude-code` to the frozen policy broke no other `[6]` assertion. The run-it pass killed every mutant with no survivors — the re-add-`source` mutant is killed by `[7]` (a +2 request delta), the three `termMatches` mutants by `[3]`, the warn-string mutant by test-preflight; a non-vacuity re-check (OPEN_KEY swap) fails `[7]`, and the `source:claude-code` term is confirmed load-bearing. One stale comment (my pass-2 policy change left a two-term description of a three-term policy) | cold-read + run-it + mutant | the comment is corrected to enumerate all three allow terms and why each is there; no code change |
| 2 | The pass-1 server-level `[7]` regression was VACUOUS — it did not test what it claimed. `env()` snapshots `process.env` once at the first request (`initEnv`'s `if (ENV) return`), so `[7]`'s mid-test `OB1_EGRESS_ALLOW` write was a dead store: the frozen `actor:open,type:idea` policy simply never matched a gated capture, so `[7]` passed for the wrong reason and gave the pass-1 boundary ZERO end-to-end protection (a re-add-`source` mutant survived it). The cold read separately confirmed the fix complete — every `EgressSubject` builder in `server-portable/` and `db/` carries a server-written `source` or none — and flagged two operator-facing doc lines that called a working `deny source:linear` (sync-linear) config ineffective | run-it + mutant (vacuity probe) | `source:claude-code` is baked into the module-load allow policy (before the env freezes) and `[7]` now captures as the gated key NAMING that source — refused only because the handler drops the claim; the re-add-`source` mutant now fails `[7]`'s zero-requests assertion (verified). The `deny/.env.example` line and the preflight warn now say a `source:` term gates the row's label and sync-linear's captures, not a `capture_thought` capture |
| 1 | A real defect: the first cut gated `source` by keying `termMatches` on `kind === "capture"`, assuming capture ⟺ caller's claim. But `db/sync-linear.ts` is a second builder of `kind:"capture"` subjects whose `source` (`"linear"`, SMD-1806) is authoritative, server-written. The guard broke `source:` gating for that trusted worker — a silent egress leak under `allow` + `deny source:linear` (Linear issue text the operator meant to keep local would be sent to the remote model). The run-it mutation pass killed 3 of 3 logic mutants on the guarded line and flagged that nothing pinned the call-site omission | cold-read + run-it + mutant | the kind guard is removed — `termMatches` gates on `metadata.source` for any subject carrying one; the fix is index.ts keeping the caller's claim off the capture subject, so `sync-linear`'s authoritative source gates again while the MCP claim never reaches the gate. New teeth pin both halves at the gate and a server-level `[7]` pins that a named `source` does not admit an MCP capture |

**Not taken.** Binding a `source` label to the key record (option 1: a fourth
`MCP_ACCESS_KEYS` field `name:scope:sha256:source`, `authenticate` putting it on
the `Principal`, `keygen --source`, the six `_shared/auth.ts` copies synced,
preflight listing it) — it would make a `source:` term trustworthy for captures,
but it enlarges the security-critical `auth.ts` and its six copies and the key
format for a label whose only proven form is already `actor:` (the key name); the
maintainer chose the smaller, honest fix.

**Boyscout.** After the stop signal, two cut-for-space tidy-ups in the touched
files, no behaviour change (the suites hold at egress 118, server 285). The rule
"a capture's source does not gate; the row's own does" had grown into three
copies — the `EGRESS_UNITS` docblock, the `termMatches` `source` case, and the
`capture_thought` call site. The two secondary copies are trimmed to their
site-specific guard and a pointer to the docblock: `termMatches` keeps "the gate
does NOT branch on kind" (where the pass-1 bug lived), and the call site keeps
"re-adding `source` here reopens the dodge" (where a future edit would).

**Follow-ups.** None filed. SMD-1724 (a trust label from the source carried into
every read) is the general form.

**Upstream status.** Not upstream.
