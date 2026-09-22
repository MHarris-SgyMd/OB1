# 99. The stack publishes one port, on loopback — `deploy/compose.yaml` names the address of everything it publishes, the server is the only thing it publishes, and the database and Ollama reach the host through a second file an operator adds (SMD-1844)

`deploy/compose.yaml` published three ports with no host address:
`"${POSTGRES_PORT:-5432}:5432"`, `"${SERVER_PORT:-8000}:8000"` and, under the
`local-models` profile, `"${OLLAMA_PORT:-11434}:11434"`. Compose binds an
address-less mapping to `0.0.0.0`, every interface. On the first stack this
fork ran for real (podman machine on macOS, 2026-09-19) `lsof -nP -iTCP
-sTCP:LISTEN` showed `gvproxy *:5432` and `gvproxy *:8010`: the `postgres`
superuser on the whole brain — every thought, the audit log, the query log,
"personal data at rest" in SETUP.md's words — offered to every host on the LAN
on `POSTGRES_PASSWORD` alone, and the MCP server, whose key rides every request
in clear over plain HTTP (a header is as visible as `?key=` to a listener on the
segment), beside it. The file's own comment on the database port said "Exposed
for psql and pg_dump during a migration. Drop this in production." — the
default was the exposed one and no README said to drop it. SETUP.md and
`deploy/README.md` present this stack as the way to run the fork with no
Supabase, and SMD-1802 will point every deploy instruction at it, so the default
binding was the fork's default exposure. The host's own Ollama, for contrast,
binds `127.0.0.1:11434`.

**What changed.** The server's mapping is
`"${SERVER_BIND:-127.0.0.1}:${SERVER_PORT:-8000}:8000"` — loopback unless the
operator names an address — and it is the only `ports:` in the file. The
database and Ollama publish nothing: the server and the migrator reach
`postgres:5432` and the server and `ollama-pull` reach `ollama:11434` on the
compose network, by service name, as they always did; psql and pg_dump run as
`compose exec postgres …` inside the container. The ticket's sketch put the
database port under a profile; a profile gates a *service*, not a port, and the
postgres service cannot be optional — so "not published by default" is a second
file, `deploy/compose.host-ports.yaml`, that adds
`"${POSTGRES_BIND:-127.0.0.1}:${POSTGRES_PORT:-5432}:5432"` and the Ollama
equivalent when passed as a second `-f`. That file exists for the tools the
READMEs say to run from a checkout rather than inside the network —
`db/reembed.ts`, `db/extract-entities.ts`, `db/consolidate.ts`, the evals, a
canary or replay gate reading `query_log` — each of which takes a
`DATABASE_URL` the host can dial; without the overlay none of them reaches the
stack, and that is the intended default. Publishing the database on loopback by
default would have closed the LAN exposure the ticket named and nothing else;
not publishing it makes "who can reach the database" a question one file
answers. `deploy/.env.example` documents the three `*_BIND` knobs under "What the
host can reach", with the sentence that `SERVER_BIND=0.0.0.0` puts the key on
the wire in clear and belongs behind TLS or a tunnel, and `OLLAMA_PORT`, which
compose had read since change 16 and the example never named.

**Held two ways.** `scripts/check-fork-consistency.mjs` check 13 *parses*
every `compose*.yaml` under `deploy/` with `Bun.YAML` and refuses a mapping
that drops the address, a `_BIND` default other than the literal `127.0.0.1`,
the long form (an object — use the short one), a knob `.env.example` does not
document, and three things that reach past what the parser sees: a service's
`extends`, a top-level `include` (each imports a service body from a file the
rule does not open) and `network_mode` (`host` puts a service on the host's
interfaces with no `ports:` at all); and it holds an inventory, `PUBLISHES`, of
which service publishes from which file, so a mapping that is gone or refused
fails as missing and a new one as unlisted (the three review passes below say
how each rule got there — the parser replaced a text walk on the third; the
probes hold the rule to its own text on every run, and the mutants on the real
files are in the pass paragraphs). The "Full stack, no Supabase" job reads what
compose *makes* of the file, `config --format json`: one port in the base file
on `127.0.0.1` at the job's `SERVER_PORT`, three with the overlay and the
profile, all on loopback, no service with a `network_mode`, and under
`SERVER_BIND=0.0.0.0` the *server's* port on `0.0.0.0` with postgres's and
ollama's still on loopback — so the knob opens the server and only the server.
The job's `POSTGRES_PORT=55433` is gone with the mapping it parameterised.

**Measured on the dogfood stack** (podman 5, libkrun machine, macOS; the stack
recreated in place with the canonical `deploy/.env` and the SMD-1843 override,
the data volume untouched): `podman ps` shows `127.0.0.1:8010->8000/tcp` for
the server and a bare `5432/tcp` for postgres; on the Mac `lsof` shows gvproxy
on `127.0.0.1:8010` where it held `*:8010`, and nothing on 5432 where it held
`*:5432` — podman machine's proxy honours the address. `nc` to
`127.0.0.1:8010` connects; to `127.0.0.1:5432` is refused; to the Mac's LAN
address on 8010 is not answered. The A/B that says it is the binding and not
the firewall: the server brought up once with `SERVER_BIND=0.0.0.0` shows
`0.0.0.0:8010->8000/tcp`, gvproxy back on `*:8010`, and the same `nc` to the
LAN address *connects*; restored to the default it is `127.0.0.1:8010` again
and the probe gets nothing. `preflight OK`, `/health` → `ok`, `smoke.sh` 9 of
9 — the server reaches Postgres over the service network, unaffected by what
the host publishes. One podman-specific note for the README: with the macOS
application firewall in stealth mode a probe of a closed port on the LAN
address *times out* rather than being refused, so the check on a Mac is
`lsof`, not the connection error's spelling.

**First review pass** (a cold read at high effort beside a run-it reviewer
with a mutation harness over the real files). The walk in check 13 matched an
item only at exactly six spaces: an address-less `"8000:8000"` indented eight
passed the check while `compose config` rendered it with no `host_ip` at all —
the tooth gone, and the header's "fails loudly" false (caught: mutant, by the
run-it reviewer; the cold read's extracted-parser probe found the same and
four more layouts — items at the key's indent, a flow sequence, four-space
services, an anchored key). Its altitude proposal is taken the first time it
appears: a positive **inventory**, `PUBLISHES`, names which service publishes
from which file, one mapping each, and a file's readable mappings must equal
its entry — so a mapping the walk cannot read fails as *missing*, a new file
or service that publishes fails as *unlisted* until named there with its
README row, and the overlay must exist (two of the run-it reviewer's notes,
now held). The walk reads by relative indentation, and tabs, a flow sequence,
an empty `ports:` and a service-level line that is not a key each fail in
their own words. The `no-address` message had been a catch-all — it told an
operator whose item *had* an address (unquoted, single-quoted, a literal
port) that compose would bind 0.0.0.0, and called an unquoted `8000:8000`
"long form" (caught: run-it, cold-read); the kinds are now decided by the
value's shape, quoting is accepted as compose accepts it, and the default the
rule wants is named as the literal `127.0.0.1` that smoke.sh and the CI step
dial rather than "loopback", since `[::1]` is loopback too (caught:
cold-read). Twenty-four probes hold the rule to its own text, and the twelve
mutants on the real files each fail with the intended message or, for the
two other quoting styles and the eight-space house-form item, pass as they
should. In the README the `lsof` line grepped a literal 8000 and 11434, which
on the very Mac it was measured on matches nothing for the server (it runs
on 8010) and shows the host's own Ollama as if it were the stack's (caught:
cold-read); it reads `${SERVER_PORT:-8000}` now and says what a line on 11434
is. And the `compose exec postgres …` recipes were spelled without the `-f`
files every other command in the README carries, so typed from the repo root
they find no configuration file (caught: cold-read); the README says once
what `compose` stands for in that section and the comments say "with the -f
files the stack runs with". One side observation from the run-it reviewer,
recorded: compose *appends* an overlay's `ports:` to the base file's rather
than replacing them, so had the base kept its postgres mapping the overlay
would have published the database twice — the inventory is what prevents
that return. Left alone: `smoke.sh`'s pre-existing handling of a present but
blank `SERVER_PORT=` (it builds `http://127.0.0.1:`), and the address-less
Ollama mapping in `recipes/local-brain-no-mcp/docker-compose.yml`, a community
recipe outside `deploy/` — the maintainer decides whether the rule widens.

**Second review pass** (same pairing, aimed at the seams the first added).
The walk had a way round it that no indentation fixes: a top-level `x-open:
&open` block holding `ports: ["5432:5432"]`, merged into `postgres` with `<<:
*open`, passed the check — the server's own mapping still matched the
inventory — while `compose config` rendered the database with `host_ip:
null`, back on every interface (caught: mutant, by the cold read). The walk
does not follow anchors, so it refuses what an anchor needs: a `<<:` merge key
anywhere in the file, and a `ports:` key outside `services:`, each in its own
words; the probe that had asserted a `ports:` under `volumes:` is *ignored* now
asserts it is refused. The CI step's third line compared a *sorted multiset*
of the three `host_ip`s to `["0.0.0.0", "127.0.0.1", "127.0.0.1"]` — true
just as well with `OLLAMA_BIND=0.0.0.0` and the server on loopback, run and
shown — so it proved one of three was open, not which (caught: run-it, on the
author's own suspicion handed to the reviewer); the line names the server's
port and the other two now. The `.env.example` "documented" regex was
satisfied by the prose line `# SERVER_BIND=0.0.0.0 is the one an operator
sets…`, so deleting the real `# SERVER_BIND=127.0.0.1` line passed (caught:
mutant, run-it); it matches a bare assignment now. Four things the documents
said that were not so or not enough (all caught: cold-read): the connector URL
said `localhost` while the mapping binds the IPv4 loopback alone, so a client
resolving `localhost` to `::1` first without a fallback is refused — the URLs
say `127.0.0.1`, as `smoke.sh` always has; adding or dropping the host-ports
overlay changes postgres's mapping, so `up -d` recreates that container and,
through `depends_on`, the server, a cost the overlay's header and the README
row now name (choose it when the stack comes up); the overlay's worked
`DATABASE_URL` expanded `$POSTGRES_PASSWORD` from a shell that does not have
it and hard-coded 5432 — it sources `deploy/.env` first and reads
`${POSTGRES_PORT:-5432}`; and the README's `lsof` grep was unanchored, so a
Supabase CLI stack on 54321/54322 read as the database leaking — a trailing
space anchors the port. The "Held two ways" paragraph above still described
the first pass's rule and counts; it describes the mechanism now and leaves the
counts to the pass paragraphs (caught: cold-read). The walk's `flow-ports`
message said "flow sequence" for an alias or a scalar too; the kind is
`inline-ports` and the message names all three (caught: run-it). `db/README.md`'s
bulk-pass section and the deploy README's "not covered" bullets said "run from
a checkout" with no word that the stack no longer publishes the database — one
pointer each to the overlay (caught: run-it). Not taken: the walk's wrong-story
messages for inputs YAML itself rejects (a `#` inside an env default, an IPv6
literal address) — each still fails; the inventory's multiset maps where a set
difference would do, and an unreachable `else` — tidy-ups for the boyscout
pass. Twenty-seven probes now; the three new mutants (the anchored block,
`OLLAMA_BIND=0.0.0.0` against the CI line, the prose-only knob) each fail.

**Third review pass** (same pairing, aimed at the definition: what can compose
publish that neither rule sees). The cold read found the third spelling in a
row that the text walk did not read — a quoted `"ports":` key and a `ports :`
with a space, each skipped as an unknown key while compose rendered the
mapping with no `host_ip` (caught: cold-read, with an extracted-parser probe)
— and both reviewers found compose-level imports the walk could never follow:
a service's `extends:` and a top-level `include:` reach a file outside
`deploy/`, and under a profile the imported service is invisible to the CI
render too (caught: cold-read; run-it ran it end to end). Three consecutive
passes each finding a seam in the same mechanism is the rule's verdict on the
mechanism ([[review-loop-discipline]]: SMD-1421, SMD-1252), not on the seams:
a walk over YAML text is not a YAML reader, and the fourth spelling was a pass
away. Check 13 now **parses** each file with `Bun.YAML.parse` — Bun 1.4.0 is
what CI and the Dockerfile pin, and a probe showed it resolving anchors,
aliases and merge keys, normalising `"ports"` and `ports :`, reading flow and
block sequences alike and throwing on a tab — so the tree the rule reads is
the tree compose reads, and the whole spelling class (indentation, quoting,
anchors, merge keys, flow form, key spelling: the subject of two passes' fixes)
is gone as a class; the long form is read as an object and still refused for
one shape's sake. What the parser cannot see is refused by name: `extends`,
`include`, and — the run-it reviewer's one hole in the definition —
`network_mode`, since `network_mode: host` puts a service on the host's
interfaces with no `ports:` item at all; the walk passed it, both CI lines
passed it (they count ports), compose rendered it (caught: run-it, the
definition angle). The CI's first two lines now also assert no service sets
`network_mode`. Under node, which has no `Bun.YAML`, the rule fails in words
rather than passing; the header's "node runs it too" carries that exception.
The check reads only files named as compose names them (`compose*.yaml`,
`docker-compose*.yml`): the first non-compose YAML under `deploy/` — SMD-1849's
collector configuration — would otherwise have failed the gate as "no
services" (caught: cold-read). The inventory's two multiset maps are a set
difference now and the unreachable `else` a `throw`, since the rewrite had the
code open. Four document findings, all cold-read: the `lsof` line expanded
`${SERVER_PORT:-8000}` in the operator's shell, which does not have it —
pass 1's own fix, one level up — so it says 8000 with the sentence that says
when to substitute; its reading "nothing for 5432" is now conditioned on the
host-ports file, under which `127.0.0.1:5432` is the correct sight; the
overlay's recipe sourced `deploy/.env` into the shell, exporting every secret
to every child process and reading dotenv as shell — it reads one key with
`grep | cut`, as `smoke.sh` reads `SERVER_PORT`; and SETUP.md's connect step
pasted the loopback URL into Claude Desktop's custom-connector UI, a client
that connects from Anthropic's side and so can never reach `127.0.0.1` — the
step names Claude Code at user scope as the local client (the dogfood stack's
own, `claude mcp add --transport http --scope user …`) and sends the connector
case to `SERVER_BIND=0.0.0.0` behind TLS, in both SETUP.md and the deploy
README. Confirmed by the run-it reviewer, not changed: `expose:` and `x-`
keys publish nothing; a whole-mapping env var is refused (one field); an
operator's `SERVER_PORT=0.0.0.0:8000` or `SERVER_BIND=*` is refused by compose
itself (`invalid IP address`); `compose.override.yaml` is not auto-loaded when
`-f` is given, so CI never sees one, and check 13 reads it locally; a
profile-hidden service is invisible to the CI render but not to the text rule,
and the reverse for a hidden `server`; compose 2.38.2 (the `ubuntu-latest`
runner's) has `config --format json` and compose-go emits `host_ip` only when
set, so `all(.host_ip == "127.0.0.1")` is false on an address-less mapping
there as here. Thirty-seven probes; on the real files the anchored block, the
quoted key, `extends`, `include`, `network_mode` and the earlier mutants each
fail with their own message. On a redesigned mechanism the count restarts: the
next pass reads the parser rule, not the walk.

**Fourth review pass** (same pairing; the first read of the parser rule as a
mechanism of its own). No hole in the rule: the run-it reviewer drove
`Bun.YAML.parse` through merge precedence (a service's own `ports` wins over the
anchor's in either order, first-wins in a merge list — compose agrees),
duplicate keys (Bun keeps the last, compose refuses the file — so nothing
publishable hides there), YAML 1.1 scalars (`8000:8000` is a string, not a
sexagesimal number; compose agrees), tags, numbers, nulls, aliased services
and whole aliased `services:` maps, a leading `---` (one object, no false
positive), an empty file, and the `no-parser` path under a nulled `Bun.YAML`
(one violation, in words, no probe spam). The two findings with weight were
in the documents, both cold-read. `deploy/.env.example`'s values were held by
nothing: a live `SERVER_BIND=0.0.0.0` in the file every operator copies to
`deploy/.env` passed check 13 (it counted as documented) and the CI step
(which writes its own `.env`), so the default of every stack brought up from
it would have been the exposure this change removed — check 13 now refuses a
live `_BIND` line whose value is not `127.0.0.1`, and guards the read of the
file (a rename crashed the script instead of failing in words). And the advice
"`SERVER_BIND=0.0.0.0` behind TLS or a tunnel" told a same-host proxy user to
open every interface for nothing: caddy, cloudflared and `tailscale serve` on
this host dial `127.0.0.1` themselves, so the loopback default serves the
remote-client case and `SERVER_BIND` changes only when the proxy is on another
machine — said now in the example, the compose comment, both READMEs and
SETUP.md. Also cold-read: SETUP.md's macOS path ran `OLLAMA_HOST=0.0.0.0:11434
ollama serve` "so containers can reach it", and this file's known-issues
bullet repeated it, while the README's new `lsof` reading called a host Ollama
"loopback on its own" — measured from inside the running server container,
`host.containers.internal:11434` answers a host Ollama bound to `127.0.0.1`
(gvproxy forwards to the host's loopback), so the `0.0.0.0` put an
unauthenticated model API on the LAN for nothing; SETUP.md and the bullet say
the default is enough, and the README says what `*:11434` means. The deploy
README's `claude mcp add` lacked `--scope user` while calling itself the
user-scope command (caught: cold-read, run-it — the installed CLI defaults to
local scope). Smaller, in pass 3's own additions: `unresolvedMergeKeys` was
dead code (Bun folds every merge spelling a probe could find, and the one it
leaves — a scalar merge value — compose refuses), removed with its kind; a root
sequence was reported as "N documents", so the kind is `not-a-mapping` and
the message names both readings; `lineOf` pointed at a comment when the word
appeared there first, so it skips comments (caught: run-it); the `extends` and
`network_mode` messages named one value each while refusing any (caught:
run-it); the overlay's recipe says a hex password needs no URL encoding and
what does. Confirmed unchanged: same-file `extends` is refused too, since the
child would inherit the parent's mapping uncounted; `network_mode: bridge` is
refused with the rest, a harmless false positive by design; a compose file in
a subdirectory is read by neither rule nor CI. Thirty-eight probes. The
findings in the mechanism this pass were tidy-ups in the previous pass's
additions and the rest were documents: the stop signal.

**Tidied while the file was open** (no behaviour change): the two readers of
`deploy/.env.example` — check 13's `_BIND` knobs and the older
compose-forwards check's `OB1_*` settings — each parsed the file with a regex
of its own, one of which the second pass had tightened while the other kept
accepting the prose form; both call one `documentedEnvKnobs(pattern)` now,
which decides once what a documented line is (a live or commented assignment,
an optional trailing `#` comment, no prose after the value; three probes hold
that, one of them the adjacent-lines case a `\s*` in the first draft got wrong
by eating the newline and the next knob as this one's comment) and fails in
words when the file is missing — where before the fourth pass's guard in check 13
was followed by the older check's unguarded read, so a renamed example still
aborted the whole script with an `ENOENT` trace after check 13 had reported
properly. Suite unchanged: 38 probes, every pass-4 mutant as before.

**Upstream status:** not sent — upstream has no `deploy/`; the stack is this
fork's (change 16 and the migration plan's Phase 4).
