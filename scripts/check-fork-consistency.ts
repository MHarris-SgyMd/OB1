#!/usr/bin/env bun
/**
 * check-fork-consistency.ts
 *
 * Repo-wide versions of checks the upstream PR gate only applies to the
 * directories a given PR touches. Because the gate never looks at untouched
 * folders, violations that predate a rule — or that landed while the rule was
 * being tightened — persist indefinitely. This runs the same rules across
 * everything so they cannot rot back in.
 *
 * Checks:
 *   1. metadata.json validates against .github/metadata.schema.json
 *   2. metadata `category` matches the directory it lives in
 *   3. relative links in contribution READMEs resolve
 *   4. requires_primitives / requires_skills point at directories that exist
 *   5. ALTER TABLE thoughts ADD COLUMN is guarded with IF NOT EXISTS, and a
 *      vendored .sql never DROPs or ALTERs a core thoughts column (SMD-1924)
 *   6. shipped content never hands untrusted input a shell — no sandbox-bypass
 *      or skip-permissions flag, alias or mode; no allow rule granting all of
 *      Bash or a prefix of a network client or interpreter; no spawn through a
 *      shell in any spelling — in every non-binary file under the contribution
 *      directories, with counted per-(file, hazard) exceptions
 *   7. vendored SQL never redefines, drops or re-comments a function the core
 *      migrations own, nor re-comments a thoughts column whose comment a
 *      migration writes — in every non-binary file under the seven category
 *      directories whole and docs/, the owned sets read from db/migrations/,
 *      with counted per-(file, function) exceptions for the files that create
 *      a brain rather than add to one
 *   8. a credential read from the environment is never compared with an
 *      equality operator — inline or through an identifier bound from the read
 *      — in the same files as 7, with counted per-file exceptions for the
 *      vendored files a ticket holds (none today)
 *   9. a committed eval fixture carries no thought content — ids, vectors and
 *      the searcher's own queries only (SMD-1295)
 *  10. a vendored file never writes a thought's content or vector around the
 *      functions that own them — no PostgREST `.update(`/`.upsert(`/`.insert(`
 *      on `thoughts` whose payload carries `content` or `embedding`, inline or
 *      through an object the file fills, and no SQL `UPDATE thoughts … SET` of
 *      either column or `INSERT INTO thoughts (…)` naming one — in the same
 *      files as 7, with counted per-file exceptions for a file whose README
 *      says it bypasses them (seven: three deployments with a database of
 *      their own, three function bodies shown, one test fixture)
 *  11. no code file under the seven category directories or docs/ reaches
 *      `Deno` — the vendored files are Bun-native since SMD-1799 (`process.env`,
 *      `export default { port, fetch }`, what `bun <file>` serves), and the
 *      Edge Function deployments that were excepted left with SMD-1800
 *      (DENO_EXCEPTIONS counts per file; none today); and a file that imports the SQL shim (Bun's client)
 *      imports no specifier Bun cannot resolve (`jsr:`, `npm:`, a URL), itself
 *      or through the files it imports (SMD-1480)
 *  12. a .sql file under db/ or any of the seven category directories runs
 *      nothing that needs Supabase — no `service_role`, `authenticated` or
 *      `anon`, no `auth.uid()`, `auth.role()` or `auth.users`, no
 *      `supabase_`-prefixed name, no RLS or policy — comments excepted by a
 *      literal-aware strip, string literals included (SMD-1796; widened from
 *      schemas/ and db/ to db/ and the seven category directories by
 *      SMD-1810); the rules are
 *      db/config.mjs's SUPABASE_SQL_RULES, which test-schema [10], [40] and
 *      [50] apply from inside the suite; no exceptions
 *  13. every port a compose file under deploy/ publishes names its host address
 *      as a knob that defaults to the literal 127.0.0.1 — the short form
 *      `"${X_BIND:-127.0.0.1}:${X_PORT:-n}:n"`, each `X_BIND` documented in
 *      deploy/.env.example, and no two mappings in compose.yaml and its
 *      overlays on one knob or default host port (SMD-2685) — no service
 *      reaches outside the file (`extends`,
 *      `include`) or onto the host without a port (`network_mode`), and
 *      PUBLISHES names which service publishes from which file, one mapping
 *      each, so a mapping that is gone or refused fails as missing:
 *      compose.yaml publishes the forwarder (SMD-2583), the break-glass
 *      listener under the auth profile on a literal 127.0.0.1 and no knob, the
 *      one named exception (LOOPBACK_MAPPINGS, SMD-3307), and n8n under its
 *      opt-in profile (SMD-2210); the database, Ollama and the typed-decision tier (jev)
 *      publish through compose.host-ports.yaml, a second -f, and the
 *      observability profile's Grafana through compose.grafana-port.yaml
 *      (SMD-1849); and
 *      deploy/.env.example's live lines are exactly the keys an operator fills
 *      in, empty (ENV_EXAMPLE_LIVE), and no tracked file is a .env (SMD-2685)
 *      or any env file (a name that starts `.env`, ends `.env` or holds
 *      `.env.`) but an .example, .sample or .template; and deploy/canary.sh and deploy/tier.sh
 *      read the stack's project through a stub carrying compose.yaml's own
 *      `name:` on one code line that reads an env file, and name it nowhere
 *      else in code but a short list (SMD-2873).
 *      The files are parsed with Bun.YAML (SMD-1844); no other exceptions
 *  14. every knob the server reads reaches the container: each `OB1_*` /
 *      `OPEN_BRAIN_*` name server-portable/root.ts declares in its `type Env`
 *      (the block's other names — DATABASE_URL, the key material, SUPABASE_*,
 *      the legacy MCP_ACCESS_KEY — are the stack's own wiring or another
 *      target's, outside this rule) — and a server source reading one
 *      straight from the environment declares it there — is forwarded by deploy/compose.yaml's
 *      `api.environment` (the REST core, the one server that reads them since
 *      SMD-2287 PR 6b retired `server`) as `${NAME}` or `${NAME:-…}` under its own name
 *      (a bare list item is refused; or excused by name in NOT_FORWARDED,
 *      with the reason) and documented in deploy/.env.example; a forwarded
 *      name the server does not declare is a typo; a documented knob no
 *      service forwards is a dead switch; `env_file` is refused (a file this
 *      rule does not open); every compose*.yaml under deploy/ is held to the
 *      shape and to the server's names, since an overlay lands in the same
 *      container; and OB1_LLM_BASE_URL's fallback, if any, is
 *      `http://<service>:11434/v1` for a service the file defines and
 *      db/config.mjs's LOCAL_PROVIDER_SERVICES names. The environment is read
 *      from the parsed document — a name in a comment or on a command line is
 *      not a forward, which is how three knobs passed the text rule this
 *      replaces — and the decision is one pure function its probes run on
 *      in-memory documents (SMD-1843)
 *  15. FORK.md is the front door and changes/ holds the record: every numbered
 *      change from 18 on is one file changes/NNN-<slug>.md whose first line is
 *      `# N. <title>` with the name's number, the numbers contiguous with no
 *      duplicate (two branches taking one number fail on the tree that holds
 *      both); a file is at most CHANGE_CAP_LINES lines, the files over it at
 *      the split listed in OVERSIZE_AT_SPLIT with a ceiling they may only
 *      shrink under (held stale two ways); FORK.md is under FORK_CEILING_BYTES,
 *      carries no `### N.` section, and its index block equals what
 *      scripts/fork-index.ts renders from the directory (a numbered section
 *      at any heading level is refused in FORK.md); and every "FORK.md change
 *      N" / "FORK change N" / "changes/NNN" / "NNN change M" citation in a file
 *      git tracks or would track (untracked, not ignored), and every bare
 *      "change N" in the record itself, names a number that has a file or a
 *      row of the 1–17 table — lists and wrapped lines included, a thousands
 *      group, a decimal, a date or a number before a unit word excluded, and a
 *      slugged path (or a relative link inside the record) naming the file as
 *      it is. A changes/smd-NNNN.md fragment (16) is held to the name and the
 *      cap here, and is not in the index: the block renders from the numbered
 *      files alone, so a PR that adds a fragment leaves FORK.md untouched and
 *      the block moves when a numbered file does — at a release cut or a
 *      retitle (SMD-1917, SMD-2084)
 *  16. every changes/smd-NNNN.md fragment is well-formed — one of Keep a
 *      Changelog's six types, a bump the migrations it lists allow (a `patch`
 *      that ships a migration fails), an SMD-#### ticket list; exactly one
 *      `## Changelog` (one to three plain lines naming every listed ticket and
 *      no other — 17b reads a version's tickets from CHANGELOG.md) followed
 *      by exactly one `## FORK`, nothing between them, the FORK body running
 *      to the end of the file with its first line the plain title (no heading
 *      mark, nothing on the second line, ending in every listed ticket — 17b
 *      reads a released ticket from that title) and no numbered heading of its
 *      own — the release step assigns the number and writes the heading
 *      (SMD-1804, SMD-1917); the rules are scripts/fragments.ts's
 *      fragmentProblems, which the release step runs too; the file's name and
 *      line cap are check 15's
 *  17. CHANGELOG.md follows Keep a Changelog 1.1.0 (Unreleased first, versions
 *      dated and descending, only the six headings, compare links resolve); each
 *      released version pairs both ways with releases.json and the numbered
 *      change files' titles (prose, which names pending tickets, is not a
 *      source); a migration inside a released range keeps the sha the release
 *      froze; and
 *      migration 044's schema_version equals db/version.mjs's FORK_VERSION
 *      (SMD-1804); and server-portable/version.ts is exactly what
 *      scripts/gen-version.ts renders from db/version.mjs, releases.json and
 *      db/migrations/ (17e, SMD-2041)
 *  18. the type-checked directories — server-portable/, compat/supabase-sql/,
 *      db/, evals/, scripts/, jev/, deploy/auth/ and rest-client/ (SMD-2287)
 *      — share one type surface and CI checks each: every one
 *      pins @types/bun, typescript and @types/node in devDependencies at the
 *      value server-portable pins (TypeScript dedupes a package by name and
 *      version, so one directory bumping alone loads two bun-types into the
 *      db and evals programs, whose ../server-portable imports pull the
 *      server's copy), its tsconfig compilerOptions equal the server's, and
 *      .github/workflows/fork-checks.yml runs `bunx tsc --noEmit` under it
 *      exactly once — a step of its own, or a directory a
 *      .github/ci/typecheck.sh step names, which runs them side by side
 *      (SMD-3202), and which check 18 then runs against a stub bunx: a tsc
 *      in each directory once, a failure failing the run, each failing
 *      directory named with its output; a tsc step under a directory the
 *      list does not name is refused. The workflow is parsed with Bun.YAML (SMD-1932); no exceptions
 *  19. docs/connector-registry.json — the connector taxonomy's one source — is
 *      sound and complete: the four closed/near-closed facet sets and the
 *      fetcher set equal the ones scripts/connector-registry.ts pins (a
 *      different set is a spec change and edits both); every family declares
 *      its schema and a reserved family is used by no capability; every
 *      artifact is a directory that exists, listed once, its capabilities
 *      naming exactly the five facets and a fetcher from the sets and a
 *      declared family; the connectors are exactly the vendors used, each
 *      with the direction its capabilities derive; the declaration — a
 *      registered artifact's metadata.json `connectors` equals the vendors its
 *      capabilities name, a contribution declaring one is registered, an
 *      excused one declares none; and coverage, the net under it — every
 *      contribution whose metadata.json names a service no not-a-connector
 *      pattern matches at the start of its first word, or of its second after
 *      a qualifier such as "Any" or "Optional:" (a provider first and
 *      qualified after is covered; a vendor first with a provider anywhere
 *      after it is not; a pattern covering a classified vendor's own service
 *      is too broad), carries a connector-shaped tag or
 *      a declared connector's name as a tag (lower-cased), or sits in a
 *      fold-in **SMD-1867** row of docs/vendored-disposition.md whose
 *      directory exists (a row whose directory is gone is a finding) is
 *      classified or excused by name with a reason, never both or neither,
 *      a stale excuse or pattern is refused; and
 *      docs/connector-taxonomy.md's generated tables equal what the registry
 *      renders. The rules are registryProblems, one pure function the
 *      renderer runs too (SMD-1933); no exceptions beyond the registry's own
 *      named excuses
 *  20. main's ruleset is a record in the tree — .github/rulesets/main.json, the
 *      body `gh api -X PUT repos/MHarris-SgyMd/OB1/rulesets/22189960 --input`
 *      applies — and it requires one check, "Fork Checks passed": the job
 *      fork-checks-passed in .github/workflows/fork-checks.yml, which needs
 *      every other job, runs if: always(), lets only the jobs with an if: of
 *      their own skip (AGGREGATE_MAY_SKIP, commit-lint), on which no job it
 *      needs sets continue-on-error or calls a reusable workflow, which runs
 *      on ubuntu-24.04 with no key beyond the few allowed on it or its step,
 *      and whose one step is held verbatim and run on its own cases
 *      (SMD-3168); every check is pinned to the Actions app
 *      (integration_id 15368), strict up-to-date is on and enforced on
 *      create, the four rules — deletion, non-fast-forward, pull-request with
 *      no required review and none of the four review flags, required-status-
 *      checks with its parameters — are present once each, the one optional
 *      rule — merge-queue, which GitHub refuses on a user-owned repository
 *      and the record adds the day this one is organisation-owned — at most
 *      once and, when present, with the fork's merge method, every entry
 *      judged on its own merge commit and no PR waiting for another
 *      (SMD-1857), no other type is, the target is the default branch and
 *      nothing else, the bypass list is empty and enforcement is active; and
 *      no other job reports a check under the aggregate's name. A matrix and a
 *      name with an expression are allowed now, since the record names no job
 *      but the one. The rules are rulesetProblems and aggregateProblems, pure
 *      functions their probes run on in-memory records (twenty-seven ruleset
 *      mutants, one accepted addition, nine non-probes; thirty-four aggregate
 *      mutants, four accepted shapes and an empty skip list two ways, four
 *      non-probes; one other-workflow name
 *      clash; sixteen names mayReportAs must allow or refuse; a
 *      5,000-expression name answered at once) and AGGREGATE_RUN under bash on ten cases; every workflow in
 *      .github/workflows is read for a job carrying the aggregate's name; the workflow is parsed with Bun.YAML (SMD-1856,
 *      SMD-3168); no exceptions
 *  21. a .sql file never destroys rows a brain already holds — CLAUDE.md's
 *      SQL-safety guard rail read as statements, not words: no DROP TABLE, no
 *      DROP DATABASE or DROP SCHEMA, no TRUNCATE with a table after it (a
 *      trigger event `BEFORE TRUNCATE ON t`, a privilege `GRANT TRUNCATE ON` and
 *      the bare value `TG_OP = 'TRUNCATE'` are not it), no DROP OWNED, no
 *      DELETE FROM whose statement — to its `;` or the `)` closing its CTE,
 *      a literal's parentheses not counted — has no WHERE of its own at the
 *      top level (one in a USING subquery qualifies nothing); comments
 *      excepted by the literal-aware strip, string literals and dollar-quoted
 *      bodies read (an EXECUTE string runs; a statement quoted in prose is a
 *      hit too, and belongs in a `--` comment) — in every .sql git tracks or
 *      would track, db/migrations/ included (the fork's migrations DROP
 *      FUNCTION and DROP TRIGGER, which destroy no row, and none drops a
 *      table); the rules are db/config.mjs's
 *      DESTRUCTIVE_SQL_RULES through destructiveSqlIn, with counted
 *      per-(file, rule) exceptions as 7's (none today) (SMD-1936)
 *  22. no vendored file imports @supabase/supabase-js at runtime — a
 *      specifier-shaped string naming the package (bare, `npm:`, `jsr:`, an
 *      esm.sh URL, a subpath), comments blanked, in any code file under the
 *      seven category directories and docs/: every vendored server reaches the
 *      brain through compat/supabase-sql, and supabase-js left the server
 *      with its PostgREST store (SMD-3152; server/index.ts, the Edge Function
 *      build that also held it, left with SMD-1800); counted per-file
 *      exceptions as 7's — none today (SMD-1798)
 * 22b. the retired Cloudflare Workers target stays retired (SMD-3152): no
 *      server-portable/wrangler.toml or store-postgrest.ts, no wrangler or
 *      supabase-js in server-portable/package.json, and no file outside the
 *      history (changes/, CHANGELOG.md, FORK.md) that names `wrangler`, or
 *      — outside code, where the refusal is spelled — sets OB1_STORE to
 *      postgrest; probes for both patterns
 * 22c. the brain deploys as the compose stack alone (SMD-2288): no doc outside
 *      the history starts one of its servers by path, quoted, relative or
 *      absolute (`bun server-portable/index.ts`, `cd mcp-server && bun
 *      index.ts`, `bun run dev` there, a systemd `ExecStart`, `pm2 start`),
 *      shell continuations joined; runs the server image alone (a `docker
 *      run` of ob1-server or open-brain-server with no `--entrypoint`, or with
 *      a runtime for it and the server's entry); or drives a cluster or a
 *      platform's deploy (`kubectl`, `helm install|upgrade`, `fly`/`flyctl
 *      deploy|launch`, `deployctl`, `gcloud run deploy`, `railway up`, `docker
 *      stack deploy`, `docker service create`, `podman kube play`, `oc
 *      apply|new-app`); a package manager's `dev` or `start` there (`cd`,
 *      `--cwd`, `--prefix`, `-C`); probes
 *  23. every workflow under .github/workflows/ names its runner image — no
 *      `-latest` label in any case or size, no expression — and pins every
 *      `uses:` (a step's, or a job's reusable workflow) to a full commit SHA
 *      with its tag in a trailing `# vX.Y.Z` comment, a local `./` path, or a
 *      `docker://` image by sha256 digest; .github/dependabot.yml is a
 *      `version: 2` file, every entry on a schedule Dependabot accepts, with a
 *      `github-actions` update over `/` that can open a PR, so the pins move.
 *      The structure is read with Bun.YAML, the tag comment from the value's
 *      own line, block scalars skipped; the rules are workflowPinProblems
 *      and dependabotProblems, pure functions their probes run on in-memory
 *      text (SMD-2093); no exceptions
 *  24. no vendored script speaks PostgREST — a `rest/v1` path in any string,
 *      a supabase-py import or `create_client(` (Python and shell), or a
 *      `@supabase/postgrest-js` specifier, comments blanked (the JS scanner;
 *      a `#` outside a string for .py, one at a word's start for .sh), in
 *      every code file under the
 *      seven category directories and docs/: the fork's stack runs no
 *      PostgREST, so such a script's live mode fails at its first request;
 *      the class decision is docs/vendored-disposition.md's "PostgREST-
 *      speaking scripts" (an import emits ingestion-contract items, a
 *      maintenance script moves onto compat/supabase-sql, three retire), and
 *      POSTGREST_EXCEPTIONS counts the eighteen files with a call site
 *      (two more reach the gateway through a lib; twenty-eight until
 *      obsidian-vault-import and local-ollama-embeddings retired (SMD-2137,
 *      SMD-2138), brain-backup, lint-sweep and thought-enrichment's three
 *      moved onto the shim (SMD-2144, SMD-2139), weekly-digest retired
 *      for the db/ verb db/weekly-digest.ts (SMD-2239), brain-smoke-test
 *      retired into deploy/smoke.sh (SMD-2103), and ob-graph's
 *      smoke-graph-rpcs.mjs went with its recipe (SMD-2920)) with the ticket that
 *      ports or retires each — a landed
 *      port fails until its entry goes, so the
 *      table's size, plus the two lib-reached scripts, is the class's
 *      remaining size (SMD-2126)
 *  25. a tripwire on the REST core (api.ts, rest/*.ts), the process root it
 *      builds on (root.ts) and the MCP endpoint's HTTP edge (mcp-edge.ts,
 *      SMD-2287; server-portable/index.ts until SMD-2287 PR 6b), for the logic a move to server-portable/core/
 *      leaves behind (SMD-2283, SMD-2284): each file's import and export statements
 *      name only its own TRANSPORT_FILES list's modules, whole or by the names
 *      listed and under those names (never egress.ts, embed.ts, metadata.ts
 *      or a store backend; root.ts's readers, the store's module,
 *      core/reads.ts, core/filter.ts and db/config.mjs by name), and nothing
 *      is imported for effect or dynamically; with comments and strings
 *      blanked, no `sql` template, `new SQL`, `.unsafe(` or `fetch(`, bare or
 *      on globalThis; the store's builder `db` named only in the root's
 *      import, at root.ts's declaration, as createCore's `store:`, in
 *      `agents().resolve(db(), …)`, as an object key and, in root.ts,
 *      serveHere()'s one start-up build (`void db().catch(() => {});`); and
 *      the store itself (`_store`, `createStore`) named only in root.ts's
 *      db() and closeStore() (the factory in db() alone), and the store
 *      module's import — a second db(), closeStore() or serveHere(), in
 *      root.ts or a transport file, is a hit. A value passed on (the agent
 *      registry's lookups) and a global's alias are not followed;
 *      transportLeaksIn is a pure function its probes run on in-memory text;
 *      and every server-portable module that calls serveHere(), an entry that
 *      serves the store, is one of TRANSPORT_FILES; no exceptions
 *  26. every vendored capture path names the trust of what it writes
 *      (SMD-1724): a code file under the seven category directories that
 *      captures through the function — an `upsert_thought` RPC by any client,
 *      JS, TS or Python, or its PostgREST path — or calls the MCP
 *      `capture_thought` tool (a client's call, not a server registering it)
 *      carries the declaration that write reads — upsert_thought's payload
 *      `event: { trust … }`, capture_thought's `trust:` argument — which the
 *      database clamps to the key's kind (073): an importer says `ingested`,
 *      a worker writing a model's output `agent`, a server relaying a
 *      client's text forwards the client's word. Whole-file, comments
 *      blanked. A raw row — a POST to `rest/v1/thoughts`, a helper's
 *      `.post("thoughts", …)` or text-rewriting `.patch("thoughts?…")`, or
 *      check 10's raw insert — cannot declare (073's trigger strips a
 *      payload's trust and nothing sets the event handoff over PostgREST),
 *      so TRUST_EXCEPTIONS counts each such line with the reason and the
 *      ticket that ports it; a port that lands fails until its entry goes,
 *      and its new call must declare
 *  27. retired with deploy/compose.tiers.yaml, the three-brain stack it held
 *      (SMD-2878); the number stays unused, so later checks keep theirs
 *  28. the proxy's route tables are held byte for byte, and only its
 *      backends answer it (SMD-2658, SMD-2685): compose.yaml's,
 *      compose.api-public.yaml's, compose.hooks-public.yaml's (SMD-2310) and
 *      compose.grafana-public.yaml's (SMD-1849) tables, as mounted config and
 *      as proxy label,
 *      each equal to the table built here, with no comment in it (Traefik
 *      renders a route file as a Go template); in every compose file directly
 *      in deploy/ (any case, and any name outside printable ASCII), no
 *      control, format or separator
 *      character but space and line feed, no `!!`, named-handle, verbatim or
 *      percent-escaped YAML tag, no !reset or !override and no directive;
 *      compose.yaml's proxy as held, its observability collector whole but its
 *      labels, which are check 37's (LGTM_SERVICE, and compose.grafana-port.yaml's one key of its
 *      environment, SMD-1849), its Postgres exporter and that one's role
 *      step whole (PG_EXPORTER_SERVICE, PG_MONITOR_ROLE_SERVICE), and its forwarder (SMD-2583), with the
 *      forwarder's script, as config and as label, byte for byte
 *      deploy/forwarder.ts; an overlay's only its own table's mount,
 *      no config but the file's own table's (compose.yaml's BASE_CONFIGS too: the forwarder's script, the dashboard and its provider, the alert rules), each service's configs as held (SERVICE_CONFIGS), no name compose takes with no -f
 *      and none outside printable ASCII; every overlay declared with the keys
 *      it sets, compose.yaml's services setting only keys that act inside
 *      their own container (no shared namespace, privilege or hook), each
 *      service's capabilities, confinement, mounts and build as held, the
 *      named volumes as held, a service name of lower-case letters, digits
 *      and hyphens, and compose.yaml's
 *      project name; and
 *      each file's networks, and who joins them under which names, exactly as
 *      held; each rule is the only catch of one of its probes (what the files
 *      make together, CI's "The proxy loads only the held route tables")
 *  28b. deploy/README.md's path table says what check 28's route tables
 *      route (SMD-2296): every path a router's rule names has a row, and a
 *      path in a row with no router is answered by the proxy's own 404; the
 *      row naming a router's first path names its backend (the first label
 *      of the service URL), says 404 for noop@internal, and names the
 *      overlay file for an overlay's router
 *  29. every service deploy/compose.yaml defines has its x-logging bound —
 *      the json-file driver with a max-size and a max-file — as its
 *      `logging:`, value for value (the file writes `logging: *logging`), so
 *      no container's log grows until the disk is full (SMD-1849)
 *  30. no Go template in the tree names a port binding's address field —
 *      `.HostIp` is docker's struct field and `.HostIP` podman's, so an
 *      `inspect -f` template naming either fails under the other CLI
 *      (SMD-2677); the address is read from the binding's JSON, whose key
 *      both spell HostIp (deploy/instance.ts's portsFromBindings). Any file git tracks
 *      or would track, a `{{ … }}` action at a time; no exceptions
 *  31. a plugin stays inside its schema and its role (SMD-2310) — an
 *      accident guard in front of the database's boundary, not a sandbox: its
 *      SQL — a migration file, a tagged template literal in its TypeScript
 *      (an untagged one is text) — names no core table (db/migrations/'
 *      CREATE TABLEs and the two ledgers) and no schema but its own, and runs
 *      no role, session or transaction change (RESET or SET ROLE, a
 *      search_path or set_config, COMMIT, ROLLBACK or BEGIN as a statement, a
 *      temp object, a session advisory lock, a cursor WITH HOLD, PREPARE,
 *      LISTEN, DISCARD); its TypeScript imports the SDK and its own files
 *      alone, no test file from code the server runs, and calls no fetch,
 *      Bun, process, Deno, eval or import(); its directory holds TypeScript,
 *      migrations/*.sql, a README and metadata.json alone;
 *      plugins/registry.ts imports and lists exactly the plugin directories,
 *      a manifest's name is its directory's, and its migration files are
 *      named by the core's rule; each GUI page a manifest declares has its
 *      route at dashboard/src/routes/plugins/<name><path>/ (a +page.svelte
 *      and a +page.server.ts whose load reaches the plugin through
 *      pluginAccess alone), and no route there is undeclared (SMD-2280 PR 3);
 *      each held by in-memory probes
 *  32. every service deploy/compose.yaml defines has the restart policy
 *      RESTART_POLICIES holds for it, value for value — what serves
 *      `unless-stopped`, so it comes back after a reboot with what it reads;
 *      what runs once "no" — and no service but those held (SMD-2760: Postgres
 *      had none, so on Docker a reboot would bring the servers back without
 *      their database); and no service runs a db/ follower but as a child
 *      of the coordinator, whose command is `db/coordinator.ts` (SMD-3214:
 *      as `on-failure:3` the followers stayed down after every reboot;
 *      SMD-3476)
 *  33. one Bun, pinned everywhere (SMD-2894): every workflow step that uses
 *      oven-sh/setup-bun names `bun-version`, and every `oven/bun:<tag>` in a
 *      file git tracks or would track names a tag of the version
 *      server-portable/Dockerfile's FROM names; a Dockerfile's FROM, a
 *      compose `image:` or a workflow's `container:` names a tag; one tag pinned by digest names one
 *      digest. changes/ and CHANGELOG.md, which record what was, are not
 *      read. That a digest is its tag's image is the registry's fact: CI's
 *      "The stack runs the pinned Bun" asks the running forwarder
 *  34. every suite is run (SMD-2895): each `test-*` script in a file git
 *      tracks or would track is one a fork-checks.yml step runs — `bun` or
 *      `node` naming it from the step's working-directory, the job's or a `cd`
 *      in the step, where its failure fails the job (no `continue-on-error`,
 *      `if: false`, `${{ false }}` or `|| true`), a comment line or a quoted
 *      string read as nothing, a matrix job read once a cell, a step under
 *      `matrix.<key> == '<value>'` (or `!=`) joined by `&&` read in the cells
 *      it runs in and one under any other `if:` that reads the matrix
 *      reported (SMD-3169) — or one SUITES_NOT_RUN names with why; an entry
 *      there that a workflow runs, that names no suite or that gives no
 *      reason is reported too. db/test-weekly-digest.ts and
 *      server-portable/test-jobs.ts had passed unrun for weeks; `eval-*`
 *      files are measurements, not suites, and are not read
 *  35. db/ci-parity.sh runs what CI runs (SMD-2903): every script a
 *      fork-checks.yml step runs (check 34's reader) is a `run` line of
 *      ci-parity.sh where the step sets DATABASE_URL, or a `nodb` line where it
 *      does not, from a directory the step may run it from, with the same
 *      flags and environment (the database URLs aside), a matrix job read
 *      once a cell, with `${{ matrix.* }}` filled in and a step under
 *      `if: matrix.<key> == '<value>'` (or `!=`) read in the cells it runs
 *      in, any other `if:` reading the matrix reported by check 34
 *      (SMD-3169); every typecheck step is a `typecheck` line; a line no
 *      step runs as written is stale; and PARITY_NOT_RUN excuses what it
 *      cannot run, by job or script, with why — an excuse for what CI no
 *      longer has is reported too
 *  36. the edge proxy (SMD-2876): deploy/edge/compose.yaml is EDGE_COMPOSE,
 *      value for value — compose.yaml's proxy's Traefik and access log, no
 *      trusted PROXY line, read-only and confined, the bridge shape on a
 *      network of its own published on 127.0.0.1 and the host shape on the
 *      host's network on both loopbacks, joining no brain's — with check 28's character and tag
 *      rules and no other compose file beside it; and deploy/edge/edge.ts
 *      renders brains.example.yaml, in each shape, as EDGE_ROUTE_TABLE, byte
 *      for byte: a router by host per brain, its header strip and its 404 for
 *      a brain that is down, its service at the shape's dial host; each rule
 *      the sole catch of a probe
 *  37. the provisioned dashboard reads what the stack writes (SMD-1849 PR
 *      3c): compose.yaml's `grafana-dashboard` config is
 *      deploy/observability/dashboard.json with each `$` doubled, as its
 *      content alone, and its provider DASHBOARD_PROVIDER byte for byte; lgtm
 *      carries each one's sha256 as a label, and the alert rules' (check
 *      38's file, SMD-3050), and no other, so a change recreates it; the
 *      dashboard parses, is uid ob1 and not editable, with no id twice; every
 *      data source is one the pinned image provisions; every Prometheus name a
 *      query or variable reads, a collapsed row's panels' included, is an
 *      instrument server-portable/'s code records (in its unit) or one of
 *      DASHBOARD_IMAGE_SERIES, measured on the pins, and every label it reads
 *      one that name carries; every variable a query names is defined, and
 *      none in the old `[[…]]` form; no top-level panel overlaps another, and
 *      none leaves the 24 columns; each rule is the only catch of one of its
 *      probes
 *  38. the provisioned alert rules read what the stack writes and send only
 *      names and numbers (SMD-3050): compose.yaml's `grafana-alert-rules`
 *      config is deploy/observability/alert-rules.yaml with each `$` doubled,
 *      as its content alone (lgtm's label for it is check 37's); the file
 *      provisions one group of ALERT_RULE_UIDS in the dashboard's folder and
 *      no contact point, policy or template, a deletion only of a rule it no
 *      longer holds; no `$` where Grafana expands one; each query Prometheus
 *      or an expression, each Prometheus query reading names and labels as
 *      check 37 holds a panel's, an aggregation at its outermost by
 *      ALERT_LABELS or by nothing, making no label, so an alert carries those
 *      labels alone; an annotation templates only those and the rule's values;
 *      no rule paused or recording. What Grafana itself refuses is left to it:
 *      it refuses the file and lgtm does not start, which CI's observability
 *      step sees. Each rule is the only catch of one of its probes
 *  39. a status-set change runs the refresh and rebuilds the gate it moves
 *      (SMD-3160): a migration that redefines node_lifecycle_types() or
 *      node_settled_types() to another set than the last earlier file that
 *      defined it has, as lines after its definition, SELECT
 *      ob1_refresh_set_readers(); (from the file that defines it on) and,
 *      for a lifecycle change, SELECT * FROM ob1_rebuild_source_gate(); or
 *      SELECT * FROM ob1_rebuild_source_gate_for_types('{…}'); lines naming
 *      exactly the types it adds and drops. Canonical forms only, on the
 *      comment-stripped text with every literal's inside blanked: each
 *      definition of a set anywhere in the file must be a line starting
 *      CREATE OR REPLACE FUNCTION <set>() whose body is the bare literal,
 *      else the file is reported. Each rule is the only catch of one of its
 *      probes
 *  40. every healthcheck in deploy/compose.yaml and deploy/edge/compose.yaml —
 *      each service's, and each `x-` anchor's — has a start period longer
 *      than zero and `start_interval: 1s`, so Docker
 *      probes it every second until its service is up, not after its 5 s
 *      default (SMD-3194); a disabled healthcheck is passed over. Its probe
 *      pins what it refuses and what it passes
 *  41. the brain's own code (server-portable/, mcp-server/, dashboard/,
 *      plugins/, db/, deploy/; tests and benches aside) never reads `*`,
 *      `t.*` or `(x).*`, anywhere in a select list, over a function, table or
 *      view the core's or a plugin's migrations define, nor `TABLE` it, nor
 *      RETURNING *: the statement is prepared, and a migration that adds a
 *      column to what it reads fails it with 0A000 until the process restarts
 *      (SMD-3302). Only the code's strings are read, as SQL (a `${…}` an
 *      opaque value), its comments, literals and dollar quotes masked; each
 *      SELECT alone, its FROM items with their aliases, a qualified star
 *      reading the item it names. Stricter than 0A000 needs (a star that never
 *      reaches the result is read too). Its probe pins what it refuses and
 *      passes, the migrations' names, the line it reports, and that its walk
 *      reads each kind of file the brain's code has
 *  42. in every suite and smoke script (each `test-*` or `smoke*` JavaScript
 *      or TypeScript file git tracks or would track) every server and child
 *      is held to 127.0.0.1 — Bun.serve and Bun.listen name hostname
 *      "127.0.0.1" at their object's top level, a node listen its host, an
 *      object giving a child PORT 0 or OB1_LISTEN_HOST that literal, set last
 *      with no spread after it — and none dials `localhost` with a port; read
 *      on the code alone (comments, string and template text and regex
 *      literals blanked; a file it cannot read through is reported): on macOS
 *      a port picked for every address can be one another app holds on
 *      127.0.0.1, which answers there in its place (SMD-3323);
 *      LISTEN_EVERY_ADDRESS names the exceptions, one site each, with why
 *  43. no workflow under .github/workflows/ gives a container a secret's
 *      value on the command line: an `-e` or `--env` naming a secret-shaped
 *      variable (a KEY, SECRET, PASSWORD, PASSWD, PW, TOKEN or CREDENTIAL
 *      word in its name, or a plural) with a `$` in its value fails, since
 *      the runner's process list shows it; pass it by name (`-e NAME`) from
 *      the shell's environment (SMD-3351). It reads that flag alone, not a
 *      curl header or a URL. Its probe pins what it refuses and passes
 *  44. each directory a fork-checks.yml step may run a script from (check
 *      34's reader) that holds a package.json has a bunfig.toml setting
 *      `[install] auto = "disable"`, so an import its job's installs do not
 *      resolve fails instead of Bun fetching it from npm; Bun reads the
 *      working directory's file alone (SMD-2978: db-live ran
 *      server-portable/preflight.ts on a zod fetched at run time). Its probes
 *      pin which files turn it off
 *
 * Run: bun scripts/check-fork-consistency.ts   (a Bun script — TypeScript, type-checked in CI
 * beside its run (SMD-1870); checks 13, 14, 18, 20, 23, 28, 29, 32, 33, 34, 35, 36, 37, 38, 40 and 44 parse YAML with Bun.YAML,
 * and check 44 TOML with Bun.TOML)
 * Exits non-zero on any violation.
 */

import { readFileSync, existsSync, readdirSync, statSync, lstatSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, dirname, relative, sep, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { coreColumnCommentStatement, coreFunctionStatement, DESTRUCTIVE_SQL_RULES, destructiveSqlIn, LOCAL_PROVIDER_SERVICES, ownedColumnCommentsIn, ownedFunctionsIn, stripSqlComments, supabaseIsmsIn } from "../db/config.mjs";
import { CHANGES_DIR, END as INDEX_END, START as INDEX_START, FIRST_FILED, classifyChanges, indexSpan, pad3, readChangeEntries, renderIndex, ticketsOf } from "./fork-index.ts";
import { FORK_VERSION, REPO_URL, migrationSha, readReleases, schemaVersionValue, semverCompare } from "../db/version.mjs";
import { fragmentProblems } from "./fragments.ts";
import { ASSETS, renderNotes } from "./release-artifacts.ts";
import { inlined as inlinedGrafana, INLINE_FILES } from "./inline-grafana.ts";
import type { ChangeEntry, ClassifiedChanges, NumberedChange } from "./fork-index.ts";
import { DISPOSITION_PATH, FACET_SETS, FETCHERS, REGISTRY_PATH, SPEC_PATH, VENDOR_PATTERN, dispositionPaths, readMetadata, readRegistry, registryProblems, renderClassification, tablesSpan } from "./connector-registry.ts";
import type { Family, Problem, Registry, Tree } from "./connector-registry.ts";
import { CATEGORIES, contributionDirs } from "./contributions.ts";
import type { ContribDir } from "./contributions.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** One finding: where in the tree, and what. */
type Violation = { where: string; msg: string };
const violations: Violation[] = [];
const fail: (where: string, msg: string) => void = (where, msg) => violations.push({ where, msg });
/** This script, as the `where` of a violation in its own probes and inventories. */
const SELF = "scripts/check-fork-consistency.ts";

/** The slice of .github/metadata.schema.json this check reads: the required names, four fields' enums and sub-properties, and the `connectors` block (SMD-1933) when the schema carries it. */
type MetadataSchema = {
  required: string[];
  properties: Record<string, unknown> & {
    difficulty: { enum: unknown[] };
    category: { enum: unknown[] };
    author: { properties: Record<string, unknown> };
    requires: { properties: Record<string, unknown> };
    connectors?: { items?: { pattern?: string; [k: string]: unknown }; uniqueItems?: boolean; [k: string]: unknown };
  };
};
const schema: MetadataSchema = JSON.parse(readFileSync(join(ROOT, ".github/metadata.schema.json"), "utf8"));
const props = schema.properties;

// The walk of the contribution directories is scripts/contributions.ts's
// contributionDirs — one definition, shared with connector-registry.ts (SMD-1933).

// ── 1 + 2: metadata validity and category/directory agreement ────────────────

/** metadata.json as this check reads it: the fields it inspects by name, everything else by key (the schema decides what is allowed). */
type Metadata = {
  version?: unknown;
  difficulty?: unknown;
  category?: unknown;
  tags?: unknown;
  author?: { name?: unknown; [k: string]: unknown };
  requires?: { open_brain?: unknown; [k: string]: unknown };
  requires_primitives?: string[]; // as the schema requires; check 1 never reads this field, so a scalar reaches checkDeps, which walks its characters as it always did — the schema is the contract
  requires_skills?: string[];
  [k: string]: unknown;
};
function checkMetadata({ cat, dir, rel }: ContribDir) {
  const file = join(dir, "metadata.json");
  if (!existsSync(file)) { fail(rel, "missing metadata.json"); return; }

  let d: Metadata;
  try {
    d = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(`${rel}/metadata.json`, `invalid JSON: ${(e as Error).message}`);
    return;
  }

  const at = `${rel}/metadata.json`;

  for (const k of schema.required) {
    if (!(k in d)) fail(at, `missing required field '${k}'`);
  }
  for (const k of Object.keys(d)) {
    if (!(k in props)) fail(at, `field '${k}' not allowed by schema`);
  }
  if ("version" in d && !/^\d+\.\d+\.\d+$/.test(String(d.version))) {
    fail(at, `version '${d.version}' is not semver`);
  }
  if ("difficulty" in d && !props.difficulty.enum.includes(d.difficulty)) {
    fail(at, `difficulty '${d.difficulty}' is not one of ${props.difficulty.enum.join("/")}`);
  }
  if ("category" in d) {
    if (!props.category.enum.includes(d.category)) fail(at, `category '${d.category}' not in enum`);
    else if (d.category !== cat) fail(at, `category '${d.category}' does not match directory '${cat}'`);
  }
  if (d.author && typeof d.author === "object") {
    for (const k of Object.keys(d.author)) {
      if (!Object.keys(props.author.properties).includes(k)) fail(at, `author.${k} not allowed`);
    }
    if (!d.author.name) fail(at, "author.name is required");
  }
  if (d.requires && typeof d.requires === "object") {
    if (d.requires.open_brain !== true) {
      fail(at, `requires.open_brain must be boolean true (found ${JSON.stringify(d.requires.open_brain)})`);
    }
    // Derive allowed keys from the schema rather than duplicating the list here.
    const allowedRequires = Object.keys(props.requires.properties);
    for (const k of Object.keys(d.requires)) {
      if (!allowedRequires.includes(k)) fail(at, `requires.${k} not allowed`);
    }
  }
  if ("tags" in d && (!Array.isArray(d.tags) || d.tags.length < 1)) {
    fail(at, "tags must be a non-empty array");
  }
  // The schema's shape for `connectors` (SMD-1933), applied here since no ajv gate runs: a list of
  // distinct kebab-case registry keys. A malformed declaration would read as "declares nothing".
  if ("connectors" in d) {
    if (!Array.isArray(d.connectors)) fail(at, `connectors must be an array of registry keys, got ${JSON.stringify(d.connectors)}`);
    else if (props.connectors?.items?.pattern) { // a schema without the block is check 19's finding, once, not a throw here
      const keyRe = new RegExp(props.connectors.items.pattern); // the schema's pattern, read, not restated
      for (const c of d.connectors) if (typeof c !== "string" || !keyRe.test(c)) fail(at, `connectors entry ${JSON.stringify(c)} is not a key (${props.connectors.items.pattern})`);
      if (props.connectors.uniqueItems && new Set(d.connectors).size !== d.connectors.length) fail(at, "connectors lists a key twice");
    }
  }
  for (const k of ["created", "updated"]) {
    if (k in d && !/^\d{4}-\d{2}-\d{2}$/.test(String(d[k]))) fail(at, `${k} '${d[k]}' is not YYYY-MM-DD`);
  }

  return d;
}

// ── 3: relative links resolve ────────────────────────────────────────────────

function checkLinks({ dir, rel }: ContribDir) {
  const readme = join(dir, "README.md");
  if (!existsSync(readme)) return fail(rel, "missing README.md");

  const text = readFileSync(readme, "utf8");
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    const link = m[1].trim();
    if (/^(https?:|mailto:|#)/.test(link)) continue;
    const path = link.split("#")[0];
    if (!path) continue;
    if (!existsSync(join(dir, path))) fail(`${rel}/README.md`, `broken link '${link}'`);
  }
}

// ── 4: declared dependencies exist ───────────────────────────────────────────

function checkDeps(meta: Metadata | undefined, { rel }: ContribDir) {
  if (!meta) return;
  for (const [field, folder] of [
    ["requires_primitives", "primitives"],
    ["requires_skills", "skills"],
  ] as const) {
    for (const slug of meta[field] ?? []) {
      if (!existsSync(join(ROOT, folder, slug))) {
        fail(`${rel}/metadata.json`, `${field} references '${slug}' but ${folder}/${slug}/ does not exist`);
      }
    }
  }
}

// ── Line scanning, shared by checks 5 and 6 ──────────────────────────────────

/** Repo-relative path with `/` separators on every OS, so it can be a key. */
const relOf = (file: string) => relative(ROOT, file).split(sep).join("/");

/**
 * Directories no check reads: the repo's own machinery, and the build output a
 * dashboard leaves behind (`.vercel/output`, `.svelte-kit/output`, `.next` —
 * gitignored, and a SvelteKit server bundle carries the shell spawn check 6
 * flags; the README's `bun run build` before its smoke made that a routine
 * false FAIL on a contributor's tree, SMD-1801's first review pass).
 */
const UNREAD_DIRS = new Set([".git", "node_modules", ".claude", ".vercel", ".svelte-kit", ".next", ".output", ".netlify"]);
function walk(dir: string, out: string[] = [], match = /\.(sql|md)$/) {
  for (const name of readdirSync(dir)) {
    // .claude holds this repo's agent worktrees — whole copies of the tree.
    if (UNREAD_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out, match);
    else if (match.test(name)) out.push(p);
  }
  return out;
}

/** One rule scanLines applies: `re` per line or `fileRe` whole-text (one of the two is set), `only` a path filter, `suppress` the counted-exception hook — see the docblock below. */
type ScanRule = { name?: string; msg: string; re?: RegExp; fileRe?: RegExp; only?: RegExp; suppress?: (rel: string) => boolean };
/**
 * Run every rule over every file. A rule is { name, msg } plus either `re`
 * (tested per line, without the g flag so test() is stateless) or `fileRe`
 * (tested against the whole text with the g flag, for shapes that span lines —
 * a pretty-printed JSON list; the line reported is the match's first). `only`
 * restricts a rule to files whose path matches. `suppress(rel)` keeps the rule
 * running and its hits COUNTED but not failed. Returns hit counts keyed
 * `${rel} ${name}`, so a caller can hold a suppressed file to an expected
 * count — one read, one definition of "matches", for the scan and the
 * exception audit alike.
 */
function scanLines(files: string[], rules: ScanRule[]) {
  const counts = new Map<string, number>();
  const hit = (rel: string, rule: ScanRule, line: number, quiet: boolean) => {
    const key = `${rel} ${rule.name ?? rule.msg}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!quiet) fail(`${rel}:${line}`, rule.msg);
  };
  for (const file of files) {
    const rel = relOf(file);
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (const rule of rules) {
      if (rule.only && !rule.only.test(rel)) continue;
      const quiet = rule.suppress?.(rel) ?? false;
      if (rule.fileRe) {
        for (const m of text.matchAll(rule.fileRe)) {
          hit(rel, rule, text.slice(0, m.index).split("\n").length, quiet);
        }
      } else {
        lines.forEach((line, i) => { if (rule.re!.test(line)) hit(rel, rule, i + 1, quiet); }); // a rule without fileRe carries re (ScanRule)
      }
    }
  }
  return counts;
}

// ── 5: column ops on core thoughts — ADD is re-runnable, DROP/ALTER is refused ─

function checkSqlGuards() {
  scanLines(walk(ROOT), [{
    name: "add-column-guard",
    re: /alter\s+table\s+(?:public\.)?thoughts\s+add\s+column\s+(?!if\s+not\s+exists)/i,
    msg: "ADD COLUMN on thoughts without IF NOT EXISTS",
  }, {
    // SMD-1924. Adding a column to thoughts is fine (guarded above); dropping
    // or retyping one mutates a structure db/migrations owns, and a vendored
    // file applied to a fork brain must not do it. The hazard was
    // recipes/email-history-import/rollback-chunking-columns.sql (DROP COLUMN
    // parent_id/chunk_index/full_text, the abandoned upstream chunking),
    // removed in SMD-1924. Scoped to vendored .sql: a core migration may own
    // the schema, and a README's rollback-of-its-own-added-columns or an
    // annotated do-not-run example is prose, not an applied file.
    name: "thoughts-column-mutation",
    only: /(?:^|\/)(?:schemas|recipes|integrations)\/.+\.sql$/i,
    fileRe: /alter\s+table\s+(?:public\.)?thoughts\s+(?:drop|alter)\s+column\b/gi,
    msg: "DROP COLUMN / ALTER COLUMN on core thoughts in a vendored file — additive ADD COLUMN … IF NOT EXISTS only; a column drop or retype belongs in a db/ migration",
  }]);
}

// ── 5b: every migration numbered, one per number ────────────────────────────
//
// The number is a migration's identity — its order, and how prose names it —
// and two branches each adding "the next number" is how two files come to
// share one (the fork has renumbered twice; SMD-1421). migrate.ts refuses such
// a set at run time, which is every operator's run and every compose start;
// this is the same rule — config.mjs's duplicateMigrationNumber, one spelling
// — where the collision is created, on every push.

async function checkMigrationNumbers() {
  const { migrationNameProblem } = await import("../db/config.mjs");
  const problem = migrationNameProblem(readdirSync(join(ROOT, "db", "migrations")));
  if (problem) fail("db/migrations", problem);
}

// ── 6: shipped content never hands untrusted input a shell ───────────────────
//
// SMD-1251. Two vendored recipes did. `gmail-smart-pull` kept a `codex exec`
// branch over Gmail message bodies that one environment variable turned into a
// sandbox-bypass run — upstream had already deleted the identical branch from
// `atomizer` and missed this copy — and its CLI spawns used `shell: true` with
// the binary path from an environment variable. `life-engine`'s recommended
// settings.json allowed `Bash(*)` beside a skip-permissions launch, defended by
// a prompt rule addressed to the model being injected. Both were fixed on that
// ticket; this is what keeps the next rebase from bringing them back.
//
// The rule this enforces, written down here because the tree is vendored from
// upstream wholesale (FORK.md, "Vendored content"): we audit once and hold the
// delta, and a standing check carries the audit. Content that ships under this
// repo's name does not run an agent with its sandbox or approvals off, does not
// recommend a wildcard, bare or interpreter-prefix shell allow, and does not
// spawn through a shell. The patterns are MECHANISMS, not the spellings the two
// fixed files happened to use: Codex's bypass flag and its aliases, Claude
// Code's skip-permissions flag and mode, every allow-rule shape that grants all
// of Bash or a prefix of a network client or interpreter, and every spawn shape
// that involves a shell — the `shell:` option with any non-false value,
// exec/execSync (always a shell), os.system/os.popen, and an explicit
// `sh -c` / `cmd /c` argv. A probe list is checked against them on every run so
// a pattern cannot rot silently.
//
// Exceptions are per (file, hazard) and COUNTED: a file that must name one flag
// in order to say it was removed is exempt from that hazard for exactly the
// number of lines it has today, and is scanned for every other hazard in full.
// One more line naming the flag — a rebase re-adding a usage block beside the
// warning — fails; one fewer — the prose rewritten — fails too, so the list is
// kept honest in both directions.
const CODE_FILES = /\.(m?js|cjs|tsx?)$/;
/** A check-6 hazard: its name, the shape it catches (`re` per line or `fileRe` whole-text), an `only` path filter, and the phrase its message opens with. */
type ShellHazard = { name: string; what: string; re?: RegExp; fileRe?: RegExp; only?: RegExp };
const SHELL_HAZARDS: ShellHazard[] = [
  { name: "codex-bypass",
    // The flag, its aliases, and the config key behind them (config.toml, or a
    // `-c approval_policy=never` override on the command line).
    re: /--dangerously-bypass-approvals-and-sandbox|--yolo\b|danger-full-access|--ask-for-approval[\s=]+never\b|(?<![\w-])-a\s+never\b|approval_policy\s*=\s*["']?never\b/,
    what: "Codex's sandbox-bypass flag, one of its aliases, or approval_policy=never" },
  { name: "skip-permissions",
    re: /--dangerously-skip-permissions|bypassPermissions/,
    what: "Claude Code's skip-permissions flag or mode" },
  { name: "wildcard-bash",
    // Bash(*), Bash(:*), Bash(*:*); a line that is only `Bash`, or a YAML list
    // item `- Bash`; an `allowed-tools:` (YAML) or `--allowedTools` /
    // `--allowed-tools` (CLI) carrying the bare token anywhere after it,
    // `Bash(git status:*)` and the like not counting.
    re: /Bash\(\s*:?\*+\s*(?::\*)?\s*\)|^\s*(?:-\s+)?Bash\s*\\?\s*$|allowed-tools:[^\n]*?(?<![\w(])Bash(?![\w(])|--allowed-?[Tt]ools\b[^\n]*?(?<![\w(-])Bash(?![\w(])/,
    what: "an allow rule that grants all of Bash" },
  { name: "wildcard-bash",
    // A quoted bare "Bash" INSIDE an allow list, however it is printed — the
    // list is read as a whole, so a `deny` list, a hook matcher, a
    // metadata.json `tools` entry or prose naming the tool in quotes is not it,
    // and a `deny` on the same line as an `allow` does not excuse the allow.
    fileRe: /["'](?:allow|allowedTools)["']\s*:\s*\[[^\]]*?["']Bash["']/g,
    what: "an allow rule that grants all of Bash" },
  { name: "bash-prefix-interpreter",
    // A prefix or glob rule on a network client, a shell, an interpreter or a
    // package runner, by bare name or full path — any `*` after the name, in
    // the `:*` form or the `Bash(curl *)` / `Bash(curl -s *host*)` glob form:
    // everything the star covers is approved, so `curl` is `-d @file` to any
    // host.
    re: /Bash\(\s*(?:[\w./-]*\/)?(?:curl|wget|sh|bash|zsh|fish|pwsh|powershell|cmd|node|python\d?|npx|npm\s+exec|pnpm\s+(?:dlx|exec)|yarn\s+dlx|bunx?|deno|eval|ssh|scp|nc|ncat|socat|perl|ruby|php)\b[^)]*\*[^)]*\)/,
    what: "a Bash prefix or glob rule on a network client or interpreter (everything the star covers is approved)" },
  { name: "shell-spawn",
    // In code files: the `shell` option with ANY value but false/0/null/undefined
    // — `true`, a path, an expression, a variable — wherever it sits.
    only: CODE_FILES,
    re: /(?:^|[{,])\s*["']?shell["']?\s*:\s*(?!false\b|0\b|null\b|undefined\b)\S/,
    what: "a spawn through a shell (spawn an argv array with no shell)" },
  { name: "shell-spawn",
    // Everywhere else (a README's code block, YAML, Python): the `shell` option
    // after `{` or `,`, or first on its line with a code value — so YAML's
    // `shell: bash` step key is not it; Python's shell=True/1; exec/execSync
    // called bare or on a child_process receiver, imported from child_process
    // or wrapped in promisify (always a shell); os.system/os.popen; an explicit
    // shell argv — `sh -c`/`-lc`/`-ec`, `cmd /c`/`/k`, `powershell -Command`,
    // by name, by path or via $SHELL — in a spawn, Bun.spawn or Deno.Command. A
    // code-shaped `exec(` in prose is flagged too; the remedy is an exception.
    re: /[{,]\s*["']?shell["']?\s*:\s*(?!false\b|0\b|null\b|undefined\b)\S|^\s*["']?shell["']?\s*:\s*(?:true\b|["'`]|process\.)|\bshell\s*=\s*(?:True|1)\b|(?<![\w.$`])(?:exec|execSync)\(|\b(?:child_process|childProcess|cp)\.exec(?:Sync)?\(|require\(["'](?:node:)?child_process["']\)\.exec(?:Sync)?\(|promisify\(\s*exec\s*\)|import\s*\{[^}]*\bexec(?:Sync)?\b[^}]*\}\s*from\s*["'](?:node:)?child_process["']|\bos\.(?:system|popen)\(|(?:["'](?:[\w./-]*\/)?(?:sh|bash|zsh|dash|fish|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh)["']|process\.env\.SHELL)\s*,\s*\[[^\]]*["'](?:-c|-lc|-ec|-ic|\/[cCkK]|-Command|-EncodedCommand)["']|(?:Bun\.spawn|Deno\.Command)\(\s*\[?\s*(?:["'](?:[\w./-]*\/)?(?:sh|bash|zsh|cmd|powershell|pwsh)["']|process\.env\.SHELL)/,
    what: "a spawn through a shell (spawn an argv array with no shell)" },
];
/** Strings each hazard must catch — the check's own negative tests. */
const SHELL_HAZARD_PROBES: [string, string][] = [
  ["codex-bypass", "codex exec --dangerously-bypass-approvals-and-sandbox -"],
  ["codex-bypass", "codex exec --yolo -"],
  ["codex-bypass", "--sandbox danger-full-access"],
  ["codex-bypass", "codex --ask-for-approval never"],
  ["codex-bypass", "codex --ask-for-approval=never"],
  ["codex-bypass", "codex exec -a never -"],
  ["codex-bypass", 'approval_policy = "never"'],
  ["codex-bypass", "codex -c approval_policy=never exec -"],
  ["skip-permissions", "claude --dangerously-skip-permissions"],
  ["skip-permissions", '"defaultMode": "bypassPermissions"'],
  ["skip-permissions", "--permission-mode bypassPermissions"],
  ["wildcard-bash", '      "Bash(*)",'],
  ["wildcard-bash", "'Bash(*:*)'"],
  ["wildcard-bash", "Bash(:*)"],
  ["wildcard-bash", '"allow": ["Bash"]'],
  ["wildcard-bash", '{"permissions": {"allow": ["Bash"], "deny": []}}'],
  ["wildcard-bash", '"allow": [\n      "Read",\n      "Bash",\n    ],'],
  ["wildcard-bash", "    Bash \\"],
  ["wildcard-bash", "  - Bash"],
  ["wildcard-bash", "allowed-tools: Read, Bash"],
  ["wildcard-bash", "allowed-tools: Bash(git status:*), Bash"],
  ["wildcard-bash", "--allowedTools Bash Edit"],
  ["wildcard-bash", "--allowed-tools Bash"],
  ["bash-prefix-interpreter", '"Bash(curl:*)"'],
  ["bash-prefix-interpreter", "Bash(curl -s https://api.open-meteo.com/v1/forecast:*)"],
  ["bash-prefix-interpreter", "Bash(/usr/bin/curl:*)"],
  ["bash-prefix-interpreter", "Bash(node:*)"],
  ["bash-prefix-interpreter", "Bash(npm exec:*)"],
  ["bash-prefix-interpreter", "Bash(curl *)"],
  ["bash-prefix-interpreter", "Bash(curl -s *api.open-meteo.com*)"],
  ["bash-prefix-interpreter", "Bash(python3 *)"],
  ["shell-spawn", "      shell: true,"],
  ["shell-spawn", '{ "shell": true }'],
  ["shell-spawn", ', shell: "/bin/sh",'],
  ["shell-spawn", '{ stdio: "pipe", shell: process.platform === "win32" }'],
  ["shell-spawn", "subprocess.run(cmd, shell=True)"],
  ["shell-spawn", "subprocess.run(cmd, shell=1)"],
  ["shell-spawn", "cp.execSync(cmd)"],
  ["shell-spawn", 'require("child_process").execSync(cmd)'],
  ["shell-spawn", 'spawn("/bin/sh", ["-c", cmd])'],
  ["shell-spawn", "spawn(process.env.SHELL, ['-c', cmd])"],
  ["shell-spawn", "spawn('sh', ['-ec', cmd])"],
  ["shell-spawn", 'spawn("cmd", ["/k", cmd])'],
  ["shell-spawn", "execSync(`claude -p ${text}`)"],
  ["shell-spawn", "exec(cmd, (err, out) => {"],
  ["shell-spawn", "child_process.exec(cmd)"],
  ["shell-spawn", "const run = promisify(exec);"],
  ["shell-spawn", 'import { exec } from "node:child_process";'],
  ["shell-spawn", "os.system(cmd)"],
  ["shell-spawn", 'spawn("cmd", ["/c", "start", "", url])'],
  ["shell-spawn", "spawn('sh', ['-c', cmd])"],
  ["shell-spawn", "spawn('sh', ['-lc', cmd])"],
  ["shell-spawn", "spawn('powershell', ['-NoProfile', '-Command', cmd])"],
  ["shell-spawn", "Bun.spawn(['sh', '-c', cmd])"],
  ["shell-spawn", "new Deno.Command('cmd', { args: ['/c', url] })"],
];
/** Strings no hazard may catch — ordinary prose and code this repo writes. */
// Code-file-only probes for the `shell` option with a non-literal value.
const SHELL_HAZARD_CODE_PROBES = [
  "        shell: isWin,",
  "  shell: opts.shell,",
];
const SHELL_HAZARD_NON_PROBES = [
  "a wildcard `Bash` allow",
  "two `Bash` rules",
  "no shell (SMD-1251): args is an argv array",
  "const m = /^x$/.exec(content);",
  "this spawn uses no shell, so the value",
  "shell: false,",
  'Bash(date "+%Y-%m-%d %H:%M:%S %Z")',
  "WebFetch(domain:api.open-meteo.com)",
  "Restart your shell: `source ~/.zshrc`",
  "Default shell: zsh",
  "      shell: bash",
  "codex exec (the OpenAI CLI) was removed",
  '"deny": ["Bash"]',
  '"disallowedTools": ["Bash"]',
  '"matcher": "Bash"',
  "allowed-tools: Bash(git status:*), Read",
  "Bash(git status:*)",
  "execFileSync(\"git\", [\"ls-files\"])",
  '"deny": [\n      "Bash",\n    ]',
  'if (input.tool_name === "Bash") {',
  '"tools": ["Bash", "Node.js 18+"]',
  '"ask": ["Bash"]',
  'The "Bash" tool is powerful',
  "      shell: isWin,",
];
/** A counted exception: why the file may match, and for exactly how many lines. */
type CountedException = { why: string; lines: number };
const SHELL_HAZARD_EXCEPTIONS = new Map<string, Record<string, CountedException>>([
  // Prose that names the deleted flag in order to say it was deleted: exactly
  // this many lines, for exactly this hazard.
  ["recipes/atomizer/README.md", { "codex-bypass": { why: "the warning that documents the codex provider's removal", lines: 1 } }],
  ["recipes/atomizer/lib/atomize-text.mjs", { "codex-bypass": { why: "the header note that documents the same removal", lines: 1 } }],
]);
// Text is scanned by construction (checks 6 and 7): only known binary shapes
// and lockfiles are skipped, so an extensionless Dockerfile, Procfile or CNAME
// is read like everything else.
const BINARY_FILES = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|pdf|zip|gz|tgz|lock|mp3|mp4|mov|m4a|wav|webm|xlsx|docx|pptx|db|sqlite|parquet|bin)$|(?:^|\/)(?:package-lock\.json|bun\.lockb?)$/i;

/**
 * Files git ignores under ROOT — recipe run output (email packs, OAuth state),
 * node_modules, .env — as repo-relative `/` paths. Untrusted text a recipe
 * pulled onto a maintainer's machine must not decide whether the tree passes,
 * and CI on a clean checkout has none of it. Empty when git is unavailable, in
 * which case everything is scanned.
 */
function gitIgnoredFiles(dirs: { rel: string }[]): Set<string> {
  try {
    // Scoped to the directories scanned and unbounded, so a node_modules or a
    // build output elsewhere in the tree cannot overflow the default 1 MiB
    // buffer and turn the skip off silently.
    const out = execFileSync("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...dirs.map((d) => d.rel)],
      { cwd: ROOT, encoding: "utf8", maxBuffer: Infinity });
    return new Set(out.split("\0").filter(Boolean));
  } catch (e) {
    console.warn(`  (git ls-files failed — ${(e as Error).message.split("\n")[0]} — scanning ignored files too)`);
    return new Set();
  }
}

/** Which hazards a text trips, by the same rules scanLines applies (line rules per line, file rules whole). */
function hazardsIn(text: string, rel = "probe.md") {
  const names = new Set<string>();
  for (const h of SHELL_HAZARDS) {
    if (h.only && !h.only.test(rel)) continue;
    const found = h.fileRe ? new RegExp(h.fileRe.source, h.fileRe.flags.replace("g", "")).test(text)
      : text.split("\n").some((line) => h.re!.test(line)); // a hazard without fileRe carries re (ShellHazard)
    if (found) names.add(h.name);
  }
  return names;
}

function checkShellHazards(dirs: ContribDir[]) {
  for (const [name, probe] of SHELL_HAZARD_PROBES) {
    if (!hazardsIn(probe).has(name)) fail(SELF, `shell-hazard pattern '${name}' no longer catches its probe: ${probe}`);
  }
  for (const probe of SHELL_HAZARD_CODE_PROBES) {
    if (!hazardsIn(probe, "probe.mjs").has("shell-spawn")) fail(SELF, `shell-hazard pattern 'shell-spawn' no longer catches its code probe: ${probe}`);
  }
  for (const text of SHELL_HAZARD_NON_PROBES) {
    const [name] = hazardsIn(text);
    if (name) fail(SELF, `shell-hazard pattern '${name}' catches ordinary text it must not: ${text}`);
  }
  // Only the contribution directories — not their `_template` placeholders,
  // which contributionDirs() already skips — so this never depends on the
  // display filter below to hide a placeholder's hits.
  const counts = scanLines(textFilesUnder(dirs), SHELL_HAZARDS.map(({ name, re, fileRe, only, what }) => ({
    name,
    re,
    fileRe,
    only,
    msg: `${what} — shipped content must not hand untrusted input a shell (SMD-1251)`,
    suppress: (rel: string) => Boolean(SHELL_HAZARD_EXCEPTIONS.get(rel)?.[name]),
  })));
  for (const [rel, byHazard] of SHELL_HAZARD_EXCEPTIONS) {
    for (const [name, { why, lines }] of Object.entries(byHazard)) {
      const seen = counts.get(`${rel} ${name}`) ?? 0;
      if (seen !== lines) {
        fail(rel, seen === 0
          ? `listed as a shell-hazard exception for '${name}' (${why}) but matches nothing — remove it from SHELL_HAZARD_EXCEPTIONS`
          : `shell-hazard exception for '${name}' (${why}) covers ${lines} line(s) but ${seen} match — a new usage beside the documented one, or the exception's count is stale`);
      }
    }
  }
}

/**
 * Every non-binary, non-ignored file under these directories — what checks 6
 * and 7 read. The ignored set is read once, over the seven category
 * directories and docs/, which cover every directory either check walks.
 */
const SCANNED_ROOTS = [...CATEGORIES, "docs"].map((c) => ({ dir: join(ROOT, c), rel: c }));
let ignoredFiles: Set<string> | undefined;
function textFilesUnder(dirs: { dir: string; rel: string }[]) {
  ignoredFiles ??= gitIgnoredFiles(SCANNED_ROOTS);
  return dirs.flatMap((d) => walk(d.dir, [], /./))
    .filter((f) => !BINARY_FILES.test(f) && !ignoredFiles!.has(relOf(f))); // assigned by the ??= above; the closure does not see that narrowing
}

// ── 7: vendored SQL never redefines or drops a function a migration owns ─────
//
// SMD-1250. Three vendored files carried `CREATE OR REPLACE FUNCTION
// public.upsert_thought(p_content TEXT, p_payload JSONB DEFAULT '{}')` and
// presented themselves as additive sidecars. Against a brain built by
// db/migrate.ts that statement REPLACES the body migration 005 installed — no
// error, the signature matches — and the scan for the rest found worse:
// thought-work-claims put its own `release_thought` over 015's (every worker
// release then fails 015's CHECK, and its release_claims_for_worker deletes
// the rows), a recipe's "additive" migration put a 2026-04 body over the
// 3-argument `upsert_thought` every capture on the SQL path runs — 008's
// actor, 021's label, 022's window rule and 025's provenance gone in one
// paste — and over 024's `thought_stats_summary`, and the vendored
// provenance-chains schema carried `trace_provenance`/`find_derivatives` under
// 025/026's signatures (which fail on the return type, as it turned out, but
// install after the DROP its own rollback shows) and a `COMMENT ON COLUMN
// thoughts.derived_from` that silently overwrote 025's contract. The
// vendored files were fixed on that ticket (FORK.md change 58: the statements
// cut where the file adds to a brain, the file excepted where it creates one);
// this is what keeps the next rebase from bringing them back.
//
// The owned set is READ from db/migrations/ — every `CREATE [OR REPLACE]
// FUNCTION` at the start of a line, comments stripped, with the file that last
// defines it — never typed, so it cannot lag the next migration. A hit is any
// CREATE FUNCTION, DROP FUNCTION, ALTER FUNCTION or COMMENT ON FUNCTION naming
// an owned function at the start of a line (a header comment quoting one
// begins with `--`; prose naming one is not a statement) — COMMENT because 028
// and 031 carry a data contract in a function's comment, which a vendored
// COMMENT ON overwrites as silently as CREATE OR REPLACE overwrites the body —
// in every non-binary, non-ignored file under the seven category directories
// WHOLE (a category's README and its `_template` included, which
// contributionDirs() skips) AND docs/, where two of the three original files
// lived. The rule itself is db/config.mjs's coreFunctionStatement, which
// test-schema [31] applies too. By NAME, not signature: a matching signature is the
// silent replacement, and a new overload beside an owned function is the
// ambiguity 004's header names and the arity split SMD-1245 describes.
//
// Exceptions are per (file, function) and COUNTED, as check 6's are: the
// files that CREATE a brain from the getting-started shape — the guide the
// migrations were extracted from, a recipe's own Neon database — define these functions because they are building the
// database the migrations would otherwise build, and are excepted for exactly
// the lines they have today with the reason beside them; one more line fails,
// one fewer fails as stale. A sidecar that adds to an existing brain gets no
// exception: its statement was cut and a header says which migration owns the
// function.
const MIGRATION_TEXTS = readdirSync(join(ROOT, "db", "migrations")).filter((f) => f.endsWith(".sql")).sort()
  .map((f): [string, string] => [f, readFileSync(join(ROOT, "db", "migrations", f), "utf8")]);
const OWNED_FUNCTIONS = ownedFunctionsIn(MIGRATION_TEXTS);
const OWNED_COLUMN_COMMENTS = ownedColumnCommentsIn(MIGRATION_TEXTS);
/** The whole-text rule as scanLines's `fileRe` (the g flag added; the line reported is the match's first). */
const asFileRe = (re: RegExp) => new RegExp(re.source, re.flags + "g");
/** Strings the rule must catch — the check's own negative tests, run through the scan's machinery every time. */
const CORE_FUNCTION_PROBES: [string, string][] = [
  ["upsert_thought", "CREATE OR REPLACE FUNCTION public.upsert_thought(p_content TEXT, p_payload JSONB DEFAULT '{}')"],
  ["upsert_thought", "create or replace function upsert_thought("],
  ["upsert_thought", "  CREATE FUNCTION upsert_thought (p_content text)"],
  ["match_thoughts", "create or replace function match_thoughts(\n  query_embedding vector(1536),"],
  ["trace_provenance", "DROP FUNCTION IF EXISTS public.trace_provenance(UUID, INT, INT);"],
  ["release_thought", "drop function release_thought;"],
  ["update_thought", "ALTER FUNCTION update_thought(uuid, text, jsonb) OWNER TO postgres;"],
  ["update_updated_at", "CREATE OR REPLACE FUNCTION update_updated_at()"],
  ["upsert_thought", "CREATE OR REPLACE FUNCTION\n  upsert_thought(p_content text)"],
  ["release_thought", "COMMENT ON FUNCTION public.release_thought IS"],
  ["claim_thoughts", "comment on function claim_thoughts(text, text, int, int) is 'x';"],
  // The quoting a Supabase dashboard export or `supabase db diff` emits.
  ["upsert_thought", 'CREATE OR REPLACE FUNCTION "public"."upsert_thought"("p_content" "text", "p_payload" "jsonb" DEFAULT \'{}\'::"jsonb")'],
  ["match_thoughts", '  DROP FUNCTION IF EXISTS public."match_thoughts"(vector, float, int, jsonb);'],
  ["update_thought", "> CREATE PROCEDURE update_thought(p_id uuid)"],
  ["renew_claims", "DROP ROUTINE renew_claims;"],
];
/** Ordinary lines the rule must not catch. */
const CORE_FUNCTION_NON_PROBES = [
  "CREATE OR REPLACE FUNCTION update_updated_at_column()",
  "CREATE OR REPLACE FUNCTION upsert_thoughts_batch(",
  "-- CREATE OR REPLACE FUNCTION upsert_thought(text, jsonb) is the statement 003 ran",
  "SELECT upsert_thought('x', '{}'::jsonb);",
  "GRANT EXECUTE ON FUNCTION public.upsert_thought(TEXT, JSONB) TO service_role;",
  "COMMENT ON FUNCTION public.release_thought_legacy IS 'x';",
  "COMMENT ON COLUMN public.thoughts.derived_from IS 'x';",
  "REVOKE EXECUTE ON FUNCTION public.trace_provenance(UUID, INT, INT) FROM PUBLIC;",
  "calls `upsert_thought` through PostgREST, then match_thoughts",
  "The `CREATE OR REPLACE FUNCTION upsert_thought` in upstream's file is cut here.",
  '-- > CREATE OR REPLACE FUNCTION "public"."upsert_thought"(',
  "CREATE OR REPLACE FUNCTION public.upsert_thought_v2(",
];
/** Column comments the rule must catch, and ordinary ones it must not. */
const COLUMN_COMMENT_PROBES: [string, string][] = [
  ["derived_from", "COMMENT ON COLUMN public.thoughts.derived_from IS"],
  ["supersedes", 'comment on column "thoughts"."supersedes" is \'x\';'],
];
const COLUMN_COMMENT_NON_PROBES = [
  "COMMENT ON COLUMN public.thoughts.derivation_layer IS 'x';",
  "COMMENT ON COLUMN thought_work_claims.ttl_expires_at IS 'x';",
  "-- COMMENT ON COLUMN thoughts.derived_from IS what 025 runs",
];
// Files that create a brain from upstream's getting-started shape, not sidecars
// that add to one. Exactly this many lines, for exactly these functions. (The
// guide itself carries no SQL since SMD-1802: it brings up the compose stack.)
const NEON = "creates the recipe's own Neon database from the guide's shape; never run against a migrated brain";
const one = (why: string): CountedException => ({ why, lines: 1 });
const CORE_FUNCTION_EXCEPTIONS = new Map<string, Record<string, CountedException>>([
  ["recipes/content-fingerprint-dedup/README.md", {
    upsert_thought: one("the recipe migration 003 was extracted from, kept as its record; the note above its Step 2 says a migrated brain must not paste it"),
  }],
  ["recipes/vercel-neon-telegram/sql/001-create-thoughts.sql", { update_updated_at: one(NEON) }],
  ["recipes/vercel-neon-telegram/sql/002-match-thoughts.sql", { match_thoughts: one(NEON) }],
]);

/** Which of `owned`'s names a text names in a statement, by the rule the scan applies to the whole text. */
const namedIn = (owned: Map<string, string>, ruleFor: (name: string) => RegExp, text: string) => new Set([...owned.keys()].filter((name) => ruleFor(name).test(text)));
const coreStatementsIn = (text: string) => namedIn(OWNED_FUNCTIONS, coreFunctionStatement, text);
const columnCommentsIn = (text: string) => namedIn(OWNED_COLUMN_COMMENTS, coreColumnCommentStatement, text);

function checkCoreFunctions() {
  if (OWNED_FUNCTIONS.size === 0) return fail(SELF, "no migration under db/migrations defines a function — the owned set is empty and check 7 would pass everything");
  for (const [fn, probe] of CORE_FUNCTION_PROBES) {
    if (!OWNED_FUNCTIONS.has(fn)) fail(SELF, `core-function probe names '${fn}', which no migration defines — the probe or the owned set is stale`);
    else if (!coreStatementsIn(probe).has(fn)) fail(SELF, `core-function rule no longer catches its probe for '${fn}': ${probe}`);
  }
  for (const text of CORE_FUNCTION_NON_PROBES) {
    const [fn] = coreStatementsIn(text);
    if (fn) fail(SELF, `core-function rule for '${fn}' catches ordinary text it must not: ${text}`);
  }
  if (OWNED_COLUMN_COMMENTS.size === 0) fail(SELF, "no migration under db/migrations comments a thoughts column — the owned column set is empty and its rule would pass everything");
  for (const [col, probe] of COLUMN_COMMENT_PROBES) {
    if (!OWNED_COLUMN_COMMENTS.has(col)) fail(SELF, `column-comment probe names 'thoughts.${col}', which no migration comments — the probe or the owned set is stale`);
    else if (!columnCommentsIn(probe).has(col)) fail(SELF, `column-comment rule no longer catches its probe for 'thoughts.${col}': ${probe}`);
  }
  for (const text of COLUMN_COMMENT_NON_PROBES) {
    const [col] = columnCommentsIn(text);
    if (col) fail(SELF, `column-comment rule for 'thoughts.${col}' catches ordinary text it must not: ${text}`);
  }
  // The seven category directories whole — not contributionDirs(), which
  // yields one entry per contribution and so skips each category's README and
  // its `_template` — and docs/, upstream's guide and drafts, where two of the
  // three files this check was written for lived.
  const before = violations.length;
  const counts = scanLines(textFilesUnder(SCANNED_ROOTS), [
    ...[...OWNED_FUNCTIONS].map(([fn, file]) => ({
      name: fn,
      fileRe: asFileRe(coreFunctionStatement(fn)),
      msg: `redefines, drops or re-comments ${fn}, which the core migrations own (last defined by db/migrations/${file}); vendored SQL must not touch a function a migration owns (SMD-1250)`,
      suppress: (rel: string) => Boolean(CORE_FUNCTION_EXCEPTIONS.get(rel)?.[fn]),
    })),
    ...[...OWNED_COLUMN_COMMENTS].map(([col, file]) => ({
      name: `thoughts.${col}`,
      fileRe: asFileRe(coreColumnCommentStatement(col)),
      msg: `re-comments thoughts.${col}, whose comment db/migrations/${file} writes as a data contract; vendored SQL must not overwrite it (SMD-1250)`,
    })),
  ]);
  // Why, and what to do — once per run, not once per matching line.
  if (violations.length > before) {
    fail("check 7", "a CREATE OR REPLACE on a matching signature replaces the migration's body silently, an overload beside it splits callers by arity, a DROP removes it, a COMMENT ON overwrites a contract 021, 025, 028 or 031 wrote there. Cut the statement and say in the file's header which migration owns the object (a sidecar that adds to a brain), or, if the file creates a brain rather than adds to one, list it in CORE_FUNCTION_EXCEPTIONS with its line count and the reason (FORK.md, change 58)");
  }
  for (const [rel, byFn] of CORE_FUNCTION_EXCEPTIONS) {
    for (const [fn, { why, lines }] of Object.entries(byFn)) {
      const seen = counts.get(`${rel} ${fn}`) ?? 0;
      if (seen !== lines) {
        fail(rel, seen === 0
          ? `listed as a core-function exception for '${fn}' (${why}) but matches nothing — remove it from CORE_FUNCTION_EXCEPTIONS`
          : `core-function exception for '${fn}' (${why}) covers ${lines} line(s) but ${seen} match — a new definition beside the documented one, or the exception's count is stale`);
      }
    }
  }
}


// ── 8: a credential from the environment is never compared with === ─────────
//
// SMD-1252. Seven vendored extension servers authenticated with two lines —
// `const expected = Deno.env.get("MCP_ACCESS_KEY"); if (!key || key !== expected)`
// — and then ran as the service role: one shared plaintext secret, compared
// byte by byte (the timing leak fix 14 closed in the core server), no scope,
// no revocation short of re-keying every client, and full write access on a
// key accepted from a URL query string. FORK.md change 64 made them consumers
// of server-portable/auth.ts — named, scoped, hashed keys; a read-scoped key
// is never given the tools that write — and this is what keeps the next rebase
// from bringing the two lines back. Its first run found the same compare in
// seventeen more vendored files; change 67 (SMD-1455) moved every one — the
// MCP and HTTP servers onto the module, the webhook receivers onto a
// timing-safe compare of digests — and the exception list below emptied.
//
// The rule is the MECHANISM, not the seven files' spelling: a strict or loose
// (in)equality with a value read from the environment under a credential's
// name (…KEY, …SECRET, …TOKEN, …PASSWORD) on either side — read inline, in
// any wrapping (`!== Deno.env.get("MCP_ACCESS_KEY")`, `!== (Deno.env.get(…) ??
// "")`, `Deno.env.get(…)!.trim() ===`), or through an identifier the file binds
// from a statement that contains such a read (`const expected = Deno.env.get(…)`,
// `const KEY = String(process.env.KEY ?? "").trim()`, `expected ??= …`, `const {
// API_TOKEN } = process.env`, `const { API_TOKEN: expected } = process.env`,
// Python's `os.environ`), the read spelled `Deno.env.get`, `process.env`,
// `Bun.env`, Hono's `c.env` and `env(c)` (the `hono/adapter` form, the one a
// server on Workers or Deno reaches for), a bare `env(…)`/`env.X`, or
// `os.environ` — in every
// non-binary, non-ignored file under the seven category directories and docs/,
// prose included, since a README's code block is what the next extension is
// copied from. Not a compare of the credential: `.length` (a timing-safe
// compare guards its lengths first), a call or an index on it, `typeof`, or a
// literal on the other side — nullish or empty (`if (KEY === undefined)` is a
// presence check) or a string (`if (KEY === "your-key-here")` is a placeholder
// check, a different smell). A name bound from a credential read is the
// credential for the WHOLE file: every compare of it counts, wherever it sits.
// Three review passes tried to except a re-declared name — a loop variable, a
// parameter, a destructure — and each pass found the previous pass's scoping
// both silencing real compares and failing ordinary code, because scope in
// regex over unparsed text is not a thing; the fourth took the altitude. A
// false positive here fails CI in the open and is answered with a rename or a
// counted exception; a miss is silent. Also outside the rule, by design: a
// compare of a secret the CALLER echoes — a webhook's `secret_token` — when it
// is not read from the environment on either side, and any compare routed
// through a function (`secretMatches(a, b)`, `timingSafeEqual`): the rule
// catches the operator, and a call is where the timing-safe compare lives.
// Outside the rule, and said so: `.includes`,
// `Object.is`, `switch`, `.localeCompare`, a compare through a class field or
// an object property — unless the object was bound from a statement that
// reads a credential from the environment (`const keys = { MCP_ACCESS_KEY:
// Deno.env.get(…) }`, one line or many, the shape change 67's workers use),
// whose credential-named properties, bracket reads and destructured names are
// followed; a free property clause fired on `opts.MAX_TOKENS` and
// `table.PRIMARY_KEY`, so it is anchored to those objects (not followed: a
// property assigned after the object was made, `cfg.API_KEY = process.env.API_KEY`;
// a nested one, `cfg.auth.KEY`; a literal that never closes) — a helper that
// returns the key, several declarators on
// one statement, a read through `Deno.env.toObject()` into a variable, a read
// by a non-literal name (`Deno.env.get(name)`), a parenthesised bound name
// (`(expected) === key`), a shell test (`[ "$KEY" != "$MCP_ACCESS_KEY" ]`),
// and braces or `=>` inside a string, comment or regex literal — each a
// spelling the review passes named and this rule does not chase. Exceptions are
// per file and COUNTED, as checks 6 and 7's are: a vendored file that must keep
// a compare is listed with the ticket that holds its fix, for exactly the lines
// it has today — one fixed drops out as stale, one added fails. The list has
// been empty since change 67.
const CREDENTIAL_ENV_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)(?:S|_?V?\d+)?\b/i;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
/** One read of the environment; the variable's name is the first defined group. */
const ENV_READ = String.raw`(?:Deno\.env\.get\(\s*["'\x60](${IDENT})["'\x60]\s*\)|process\.env\.(${IDENT})|process\.env\[\s*["'\x60](${IDENT})["'\x60]\s*\]|\b(?:Bun|c|ctx|context)\.env\.(${IDENT})|import\.meta\.env\.(${IDENT})|(?<![\w.$])env\(\s*${IDENT}\s*\)\.(${IDENT})|(?<![\w.$])env\(\s*["'](${IDENT})["']\s*\)|(?<![\w.$])env\(\)\.(${IDENT})|(?<![\w.$])env\.(${IDENT})|os\.environ(?:\.get)?[[(]\s*["'](${IDENT})["']|os\.[gG]etenv\(\s*["'](${IDENT})["'])`;
/** An equality operator, strict or loose, and not part of `=>`, `<=`, `>=` or `!` alone. */
const EQ = String.raw`(?<![=!<>])(?:!==|===|!=|==)(?!=)`;
/** What on the far side of a compare makes it a presence or placeholder check, not a compare of the credential. */
const NOT_A_VALUE = String.raw`(?:undefined\b|null\b|None\b|"[^"\n]*"|'[^'\n]*'|` + "`[^`\n]*`" + `)`;
/** What may wrap an inline read on the left of a compare: `!`, `)`, `?? ""`, `|| ""`, `.trim()`. */
const WRAP = String.raw`(?:[!)]|\s*(?:\?\?|\|\|)\s*(?:""|'')|\.trim\(\))*`;
/** A bound name as an operand, in the wrappings a compare puts around one: `String(x)`, `(x ?? "")`, `x.trim()`, `x?.trim()`, bare — not `x.y`, `x(`, `x[` or `x?.y`; a ternary's `?` after it is fine. */
const bound = (N: string) => String.raw`(?:String\(\s*${N}\s*\)|\(\s*${N}\s*(?:\?\?|\|\|)\s*(?:""|'')\s*\)|${N}(?:\?\.|\.)trim\(\)|${N}\b(?!\s*(?:[.(\[]|\?\.)))`;
const envNameOf = (groups: (string | undefined)[]) => groups.find((g) => g !== undefined) ?? "";

/**
 * The 1-based lines of `text` that compare an environment credential with an
 * equality operator, by the rule above. Bindings are collected over the whole
 * text first, so a compare may sit above or below the read it compares.
 */
function credentialComparesIn(text: string) {
  const names = new Set<string>();
  // `x = <anything on the statement containing a credential read>` — `=`, `??=`
  // and `||=`, a type annotation before it, a line break after it, a wrapper
  // (`String(…)`, `(… ?? "")`, `.trim()`) around the read.
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w$.])(${IDENT})\s*(?::[^=\n]*?)?\s*(?:\?\?|\|\|)?(?<![=!<>])=(?![=>])\s*[^;\n]*?${ENV_READ}`, "g"))) {
    if (CREDENTIAL_ENV_NAME.test(envNameOf(m.slice(2)))) names.add(m[1]);
  }
  // An object bound from a statement that reads a credential from the
  // environment — `const keys = { MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") }`,
  // on one line or many (the binding rule above stops at the line break; this
  // walks the braces). Its credential-named properties, bracket reads and a
  // destructure from it are the credential below. Anchored to these objects
  // only: a clause over any object's upper-case properties fired on
  // `opts.MAX_TOKENS` and `table.PRIMARY_KEY`.
  const objects = new Set<string>();
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w$.])(${IDENT})\s*(?::[^=\n]*?)?\s*=\s*\{`, "g"))) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < text.length; i++) { if (text[i] === "{") depth++; else if (text[i] === "}" && --depth === 0) break; }
    if (i === text.length) continue; // a literal that never closes (prose, a truncated block) binds nothing
    const block = text.slice(m.index, i + 1);
    if ([...block.matchAll(new RegExp(ENV_READ, "g"))].some((r) => CREDENTIAL_ENV_NAME.test(envNameOf(r.slice(1))))) objects.add(m[1]);
  }
  const OBJECTS = [...objects].map((o) => o.replace(/\$/g, "\\$"));
  // `const { MCP_ACCESS_KEY } = process.env` binds the env name; `{ MCP_ACCESS_KEY: expected }` binds the local one; so does a destructure from an object above.
  for (const m of text.matchAll(new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:process\.env|Deno\.env\.toObject\(\)|Bun\.env|c\.env|env\(\s*\w+\s*\)${OBJECTS.map((o) => "|" + o).join("")})(?![\w$])`, "g"))) {
    for (const part of m[1].split(",")) {
      const [envName, local] = part.split(":").map((p) => p.trim().split(/[\s=]/)[0]);
      if (envName && CREDENTIAL_ENV_NAME.test(envName)) names.add(local || envName);
    }
  }
  const lines = new Set<number>();
  const lineOf = (i: number) => text.slice(0, i).split("\n").length;
  const flag = (re: RegExp, keep: (m: RegExpMatchArray) => boolean = () => true) => {
    for (const m of text.matchAll(re)) if (keep(m)) lines.add(lineOf(m.index));
  };
  const credential = (m: RegExpMatchArray) => CREDENTIAL_ENV_NAME.test(envNameOf(m.slice(1)));
  flag(new RegExp(String.raw`${EQ}\s*\(*\s*${ENV_READ}`, "g"), credential);
  flag(new RegExp(String.raw`${ENV_READ}${WRAP}\s*${EQ}`, "g"), credential);
  for (const name of names) {
    const N = name.replace(/\$/g, "\\$");
    // The credential on the right: `key !== expected`, `!== expected.trim()`, `!== String(expected)`, `!== (expected ?? "")`
    // — not `expected.length`, `expected(`, `expected[`, `expected?.x`.
    flag(new RegExp(String.raw`(?<!${NOT_A_VALUE}\s*)${EQ}\s*${bound(N)}`, "g"));
    // The credential on the left: `MCP_ACCESS_KEY === key` — not `typeof MCP_ACCESS_KEY`, not against a nullish, empty or string literal.
    flag(new RegExp(String.raw`(?<![\w$.])(?<!typeof\s+)${bound(N)}\s*${EQ}(?!\s*${NOT_A_VALUE})`, "g"));
  }
  // A credential-named property of an object bound from the environment (above):
  // `keys.MCP_ACCESS_KEY`, `keys?.MCP_ACCESS_KEY`, `keys["MCP_ACCESS_KEY"]`, with
  // `.trim()` allowed. Same guards as a bound name: not `typeof`, not against a
  // nullish, empty or string literal, not `.x`, `(`, `[` after it.
  for (const O of OBJECTS) {
    const P = String.raw`(?<![\w$.])${O}(?:(?:\?\.|\.)(${IDENT})|(?:\?\.)?\[\s*["'](${IDENT})["']\s*\])(?:(?:\?\.|\.)trim\(\))?`;
    const cred = (m: RegExpMatchArray) => CREDENTIAL_ENV_NAME.test(m[1] ?? m[2] ?? "");
    flag(new RegExp(String.raw`(?<!${NOT_A_VALUE}\s*)${EQ}\s*${P}(?!\s*(?:[.(\[]|\?\.))`, "g"), cred);
    flag(new RegExp(String.raw`(?<!typeof\s+)${P}\s*${EQ}(?!\s*${NOT_A_VALUE})`, "g"), cred);
  }
  return [...lines].sort((a, b) => a - b);
}

/** Texts the rule must catch — the check's own negative tests, run on every run. */
const CREDENTIAL_COMPARE_PROBES = [
  'const key = c.req.query("key") || c.req.header("x-access-key");\nconst expected = Deno.env.get("MCP_ACCESS_KEY");\nif (!key || key !== expected) {',
  'const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;\n// …\nif (!provided || provided !== MCP_ACCESS_KEY) {',
  'const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") ?? "";\nreturn key === MCP_ACCESS_KEY;',
  'const READWISE_WEBHOOK_SECRET = Deno.env.get("READWISE_WEBHOOK_SECRET")!;\nif (body.secret !== READWISE_WEBHOOK_SECRET) {',
  'const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;\nif (secret !== expectedSecret) {',
  'if (key !== Deno.env.get("MCP_ACCESS_KEY")) {',
  'if (req.headers.get("x-key") != process.env.API_TOKEN) {',
  'if (process.env["BRAIN_ACCESS_KEY"] === provided) ok();',
  'if key != os.environ.get("API_KEY"):',
  'if presented == os.Getenv("API_KEY") {',
  'if presented == os.getenv(\'MCP_ACCESS_KEY\'):',
  'EXPECTED = os.environ["WEBHOOK_SECRET"]\nif token == EXPECTED:',
  'const { MCP_ACCESS_KEY } = process.env;\nif (k === MCP_ACCESS_KEY) {',
  'let token: string | undefined = process.env.BOT_TOKEN;\nreturn token === presented;',
  'const expected = env("MCP_ACCESS_KEY");\nif (provided !== expected) return 401;',
  'const AUDITOR_ACCESS_KEY = Deno.env.get("AUDITOR_ACCESS_KEY")!;\nif (key !== AUDITOR_ACCESS_KEY) {',
  'return Boolean(provided && provided === MCP_ACCESS_KEY);\nconst MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;',
  // What the first review pass found slipping past: a renamed destructure, Hono's
  // bindings and Bun's env, a wrapped read, a wrapped inline compare, `??=`.
  'const { MCP_ACCESS_KEY: expected } = process.env;\nif (key !== expected) {',
  'if (provided !== c.env.MCP_ACCESS_KEY) {',
  'const KEY = Bun.env.MCP_ACCESS_KEY;\nreturn key === KEY;',
  'const expected = (Deno.env.get("MCP_ACCESS_KEY") ?? "").trim();\nif (key !== expected) {',
  'const expected = String(process.env.MCP_ACCESS_KEY);\nif (key !== expected) {',
  'let expected: string | undefined;\nexpected ??= Deno.env.get("MCP_ACCESS_KEY");\nif (key !== expected) {',
  'if (key !== (Deno.env.get("MCP_ACCESS_KEY") ?? "")) {',
  'if (Deno.env.get("MCP_ACCESS_KEY")! !== key) {',
  'if (Deno.env.get("MCP_ACCESS_KEY")!.trim() === key) ok();',
  // What the second review pass found slipping past: wrappers on the bound
  // name, template quotes, import.meta.env, a suffixed name, a compare that
  // precedes a shadow rather than following one.
  'const expected = Deno.env.get("MCP_ACCESS_KEY");\nif (key.trim() !== expected.trim()) {',
  'const expected = Deno.env.get("MCP_ACCESS_KEY");\nif (key !== expected?.trim()) {',
  'const expected = Deno.env.get("MCP_ACCESS_KEY");\nif (key !== String(expected)) {',
  'const expected = Deno.env.get("MCP_ACCESS_KEY");\nif ((key ?? "") !== (expected ?? "")) {',
  'const expected = Deno.env.get(`MCP_ACCESS_KEY`);\nif (key !== expected) {',
  'if (import.meta.env.VITE_API_KEY === presented) {',
  'const expected = Deno.env.get("MCP_ACCESS_KEY_V2");\nif (key !== expected) {',
  'const token = process.env.API_TOKEN;\nif (presented === token) ok();\nfor (const token of list) use(token);',
  // What the third review pass found the shadow rule silencing: a declaration
  // whose block has closed, one in another function, one before the binding,
  // and a second binding of the same name.
  'const token = process.env.BOT_TOKEN;\nfunction lens() { return tokens.map((token) => token.length); }\nif (presented === token) ok();',
  'const secret = Deno.env.get("WEBHOOK_SECRET");\nfunction other() { for (const secret of list) use(secret); }\nif (body.secret !== secret) deny();',
  'const key = Deno.env.get("MCP_ACCESS_KEY");\nfunction lookup(key) { return map.get(key); }\nif (c.req.query("key") !== key) deny();',
  'const token = process.env.API_TOKEN;\nfor (const token of tokens) { use(token); }\nif (presented === token) ok();',
  'function a() { let expected = 0; return expected; }\nconst expected = Deno.env.get("MCP_ACCESS_KEY");\nif (key !== expected) deny();',
  'app.post("/mcp", (c) => { const expected = Deno.env.get("MCP_ACCESS_KEY"); if (k !== expected) deny(); });\napp.post("/sse", (c) => { const expected = Deno.env.get("MCP_ACCESS_KEY"); if (k !== expected) deny(); });',
  // What the fourth review pass found the (since removed) shadow rule silencing,
  // plus a ternary and a binding broken over two lines.
  'const token = process.env.API_TOKEN;\nfor (const token of tokens) if (token === close) break;\nif (presented === token) deny();',
  'const key = process.env.API_KEY;\nconst hit = list.some((key) => key === wanted);\nif (presented === key) deny();',
  'const expected = Deno.env.get("MCP_ACCESS_KEY");\nreturn key === expected ? ok() : deny();',
  'const expected = Deno.env.get("MCP_ACCESS_KEY");\nconst status = key !== expected ? 401 : 200;',
  'const expected =\n  Deno.env.get("MCP_ACCESS_KEY");\nif (k !== expected) deny();',
  // The fifth pass: Hono's adapter form.
  'import { env } from "hono/adapter";\nif (provided !== env(c).MCP_ACCESS_KEY) deny();',
  'const { MCP_ACCESS_KEY } = env(c);\nif (provided !== MCP_ACCESS_KEY) deny();',
  // Change 67's third and fourth passes: an object bound from the environment, its
  // credential-named property compared — dotted, bracketed, or destructured out of it.
  'const keys = { MCP_ACCESS_KEYS: Deno.env.get("MCP_ACCESS_KEYS"), MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") };\nif (provided === keys.MCP_ACCESS_KEY) deny();',
  'const keys = {\n  MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY"),\n};\nif (!provided || provided !== keys.MCP_ACCESS_KEY?.trim()) deny();',
  'const keys = { MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") };\nif (provided === keys["MCP_ACCESS_KEY"]) deny();',
  'const keys = { MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") };\nif (provided === keys?.["MCP_ACCESS_KEY"]) deny();',
  'const keys = {\n  MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY"),\n};\nconst { MCP_ACCESS_KEY } = keys;\nif (provided !== MCP_ACCESS_KEY) deny();',
];
/** Texts the rule must not catch — ordinary code and prose. */
const CREDENTIAL_COMPARE_NON_PROBES = [
  'const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY");\nif (!MCP_ACCESS_KEY) throw new Error("unset");',
  'const expected = process.env.BRAIN_ACCESS_KEY;\nif (key.length !== expected.length) return false;\nreturn timingSafeEqual(Buffer.from(key), Buffer.from(expected));',
  'if (process.env.OB1_STORE === "postgrest") {',
  'if (response.status !== expectedStatus) {',
  'const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY");\nif (MCP_ACCESS_KEY === undefined) fail();',
  'const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") ?? "";\nif (MCP_ACCESS_KEY === "") console.warn("unset");',
  'const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY");\nif (typeof MCP_ACCESS_KEY !== "string") fail();',
  'if (embedding.length !== EXPECTED_DIM) {',
  'const apiKey = process.env.OPENROUTER_API_KEY;\nif (args.grader === "openrouter" && !apiKey) {',
  'const key = c.req.query("key");\nif (!key) return c.json({ error: "Unauthorized" }, 401);',
  'supabase secrets set MCP_ACCESS_KEY=your-generated-key-here',
  'MCP_ACCESS_KEYS=laptop:write:<sha256 of the key>',
  'const principal = authenticateRequest(c.req.raw, { MCP_ACCESS_KEYS: Deno.env.get("MCP_ACCESS_KEYS"), MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") });',
  'const token = process.env.TELEGRAM_BOT_TOKEN;\nif (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");',
  'const expected = process.env.EXPECTED_DIM;\nif (_embedDimCache !== expected) {',
  'seven files compared the key with `!==` and are consumers of auth.ts now',
  'const secret = process.env.WEBHOOK_SECRET ?? "";\nconst ok = secret.length > 0 && timingSafeEqual(a, b);',
  'const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;\nif (key === "your-service-role-key") throw new Error("placeholder");',
  'const key = process.env.API_KEY;\nfor (const key of Object.keys(row)) if (key === "id") continue;',
  'const c = new Hono();\nif (c.env.OB1_STORE === "sql") {',
  'const expected = Deno.env.get("MCP_ACCESS_KEY");\nif (expected?.length !== 64) warn();',
  // Change 67's servers: a property of a bound principal is not the credential, and a
  // typeof test beside a bound secret is a type check, not a compare of it.
  'const principal = authenticateRequest(c.req.raw, { MCP_ACCESS_KEYS: Deno.env.get("MCP_ACCESS_KEYS") });\nif (session.scope !== principal.scope) session = undefined;',
  'const READWISE_WEBHOOK_SECRET = Deno.env.get("READWISE_WEBHOOK_SECRET")!;\nif (!secretMatches(typeof body.secret === "string" ? body.secret : null, READWISE_WEBHOOK_SECRET)) deny();',
  // A property's presence, type or absence is not a compare of it; the workers' fail-closed check.
  'const keys = { MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") };\nif (keys.MCP_ACCESS_KEY === undefined) warn();',
  'const keys = { MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") };\nif (typeof keys.MCP_ACCESS_KEY === "string") ok();',
  'const keys = { MCP_ACCESS_KEYS: Deno.env.get("MCP_ACCESS_KEYS"), MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") };\nif (!keys.MCP_ACCESS_KEYS && !keys.MCP_ACCESS_KEY) return json({ error: "misconfigured" }, 503);',
  // An upper-case property with a credential suffix on an object NOT bound from the
  // environment is not the credential — the fourth pass anchored the clause after these fired.
  'if (opts.MAX_TOKENS === 4096) trim();',
  'if (col === table.PRIMARY_KEY) skip();',
  // A helper that returns the key is outside the rule, and said so above.
  'const cfg = accessKeys();\nif (k !== cfg.MCP_ACCESS_KEY) deny();',
  // An object literal that never closes binds nothing, whatever is read below it.
  'const keys = {\nconst KEY = Deno.env.get("KEY");\nif (p === keys.KEY) deny();',
];
// Empty since SMD-1455 (FORK.md change 67) moved the seventeen files check 8's
// first run found onto the shared module. The shape stays for the next audit: a
// vendored file that must keep a compare is listed with its line count and the
// ticket that holds its fix, and the count is checked both ways — one fixed
// makes its entry stale (remove it), one added beside it fails.
const CREDENTIAL_COMPARE_EXCEPTIONS = new Map<string, CountedException>([]);

function checkCredentialCompares() {
  for (const probe of CREDENTIAL_COMPARE_PROBES) {
    // Every line of a probe that carries a compare must be caught — a probe with
    // two routes is two compares, and the second binding is not a shadow of the first.
    const expected = probe.split("\n").map((l, i) => (/(?:!==|===|!=|==)/.test(l) ? i + 1 : 0)).filter(Boolean);
    const got = credentialComparesIn(probe);
    if (expected.some((l) => !got.includes(l))) fail(SELF, `credential-compare rule no longer catches its probe (lines ${expected.join(",")}, caught ${got.join(",") || "none"}): ${JSON.stringify(probe)}`);
  }
  for (const text of CREDENTIAL_COMPARE_NON_PROBES) {
    if (credentialComparesIn(text).length > 0) fail(SELF, `credential-compare rule catches ordinary text it must not: ${JSON.stringify(text)}`);
  }
  const MSG = "compares a credential from the environment with an equality operator — one shared plaintext secret, a timing leak, no scope and no revocation; authenticate through the _shared/auth.ts beside the file (a copy of server-portable/auth.ts) as the extensions, recipes and integrations do (SMD-1252 and SMD-1455, FORK.md changes 64 and 67) — or, for a secret the caller echoes, compare digests with its secretMatches() — or list the file in CREDENTIAL_COMPARE_EXCEPTIONS with its line count and the ticket that holds its fix";
  const counts = new Map<string, number>();
  for (const file of textFilesUnder(SCANNED_ROOTS)) {
    const rel = relOf(file);
    const hits = credentialComparesIn(readFileSync(file, "utf8"));
    if (hits.length === 0) continue;
    counts.set(rel, hits.length);
    if (!CREDENTIAL_COMPARE_EXCEPTIONS.has(rel)) for (const line of hits) fail(`${rel}:${line}`, MSG);
  }
  for (const [rel, { why, lines }] of CREDENTIAL_COMPARE_EXCEPTIONS) {
    const seen = counts.get(rel) ?? 0;
    if (seen !== lines) {
      fail(rel, seen === 0
        ? `listed as a credential-compare exception (${why}) but matches nothing — remove it from CREDENTIAL_COMPARE_EXCEPTIONS`
        : `credential-compare exception (${why}) covers ${lines} line(s) but ${seen} match — a new compare beside the documented one, or the exception's count is stale`);
    }
  }
}

// ── 10: a thought's content or vector is written only through the functions ──
//
// SMD-1228. Three integrations named in FORK.md changes 38 and 40 updated a
// thought's `content` or `embedding` with a raw PostgREST `.update(…)` on
// `thoughts` rather than through `update_thought` — and the audit for this
// check found nine files with eleven such statements: the two MCP servers
// (`update-thought-mcp`, `enhanced-mcp`), three HTTP APIs
// (`agent-memory-api`, `open-brain-rest`, `rest-api`), a worker
// (`consolidation-workers/bio`), a recipe's server (`repo-learning-coach`, retired since: SMD-2923), a
// recipe's paste-in snippet (`provenance-chains`) and a README's sample
// (`telegram-capture`). Every rule the fork put into the
// writers is bypassed by such a statement: 003/018's fingerprint is left
// describing the old text (018's `fingerprint_held_by` report exists for the
// row it leaves), 021's label is left describing the old vector, 022's chunk
// rows of the old vector stay under the new one, and 008's actor is not set.
// FORK.md change 69 routed every one through `update_thought` (edits) or the
// 3-argument `upsert_thought` (captures, the vector and its label in one
// call); this is what keeps the next rebase from bringing one back.
//
// The rule is the MECHANISM: a PostgREST table verb that replaces columns —
// `.update(` or `.upsert(` — on `thoughts` (`.from("thoughts")`, either
// quote, or Python's `.table("thoughts")`, whitespace and line breaks
// allowed before the verb), whose payload carries a `content` or `embedding`
// key: an object literal (quoted, bare or computed key, the shorthand
// `{ embedding }`, an array of literals for an upsert, an `Object.assign(…)`
// of literals), or an identifier the file binds to one (`const update = {
// embedding, … }`, `Object.assign(patch, { … })`, `updates.content = …`,
// `patch["embedding"] = …`, anywhere in the file) — a key, not a value
// (`summary: content` is not one), at the literal's top level (`{ metadata: {
// content } }` is a metadata write); a row type on the client and a line
// comment before the verb do not hide it; and the SQL form, `UPDATE [ONLY]
// thoughts … SET` — `public.`, quoted identifiers and an alias allowed — with
// `content =` or `embedding =` in the SET list before its WHERE, or either
// name in the tuple form `SET (…) = (…)`. Word-bounded:
// `content_fingerprint =` and `embedding_model =` are other columns (023's
// backfill and the fingerprint recipe's are theirs to write). In every
// non-binary, non-ignored file under the seven category directories and
// docs/, prose included — a README's code block is what the next integration
// is copied from. SMD-1524 (change 71) added the fresh row: `.insert(` with
// either key (a literal, an array of literals, a bound name — one filled by
// `x.push({ … })` or Python's `x.append({ … })` too), and the SQL
// `INSERT INTO [public.]thoughts [AS alias] (<columns>)` naming either column
// — a row written around the 3-argument upsert_thought has no fingerprint
// (003: 016's trigger does not fill it; the row is invisible to dedup until
// 023's backfill and a later capture of the text makes a twin), no model
// label (021: a vector of unknown model, which the re-embed pool treats as
// not at the target), and no actor for 008. Not in the rule, and said so: an
// INSERT with no column list (`INSERT INTO thoughts VALUES …`, `INSERT INTO
// thoughts SELECT …`, a client's `${sql(rows)}` helper), a metadata-only update
// (nothing it leaves stale), a REST `PATCH …/rest/v1/thoughts` built by hand
// (none in the tree), a payload spread from another object (`{ ...updates }`),
// a payload that arrives as a function's return value or parameter, a builder
// split across statements (`const q = supabase.from("thoughts"); q.update(…)`),
// a table name held in a variable, a payload behind a type assertion or a
// conditional (`.update(<any>p)`, `.update(cond ? { content } : {})`), a
// two-hop `Object.assign({}, a, b)` of bound names, Python's
// `dict(content=…)`, a list built by comprehension from a function's return
// (`[build_row(h) for h in batch]` — readwise-import's, converted by hand and
// held by test-writes.ts's text guard), and an `.rpc("update_thought", …)` or
// `.rpc("upsert_thought", …)`, which is the remedy — the dataflow cases need
// what this rule does not have, and a miss there is what the second half of
// the audit, extensions/test-writes.ts, is for. Exceptions are per file and
// COUNTED, as checks 6–8's are: a file that deliberately writes around the
// functions is listed with the reason and the line count, and its README must
// say what its rows lack; one fixed drops out as stale, one added fails. Seven
// today, none a bypass a fix could remove: three deployments whose database is
// their own (the fork's functions are not in it — two of them the files check 7
// excepts for creating a brain), the two guides and the one container init that
// show an upsert_thought body (the INSERT is the function's own), and the test
// that plants a row as an older write left it, to be moved by the writer under test.
/** The table, as PostgREST's client (with a row type), the SQL shim or Python's client name it. */
const THOUGHTS_TABLE = String.raw`\.(?:from|from_|table)(?:<[^>\n]*>)?\s*\(\s*["'\x60]thoughts["'\x60]\s*\)`;
/** What may sit between the table and its verb: whitespace, line and block comments. */
const GAP = String.raw`(?:\s|//[^\n]*|/\*[\s\S]*?\*/)*`;
/**
 * A `content` or `embedding` KEY of an object literal: `content:`, `"embedding":`,
 * `["content"]:`, the shorthand `{ embedding }` / `content,`. A key follows `{`
 * or `,`; a name after `:` is a value (`summary: content`), not a key. Tested
 * on a literal's top level only — see topLevel() — so `{ metadata: { content } }`
 * is a metadata write.
 */
const PAYLOAD_KEY = /(?:^|[{,])\s*(?:["'\x60]?(?:content|embedding)["'\x60]?|\[\s*["'\x60](?:content|embedding)["'\x60]\s*\])\s*(?::|,|\})/;
/**
 * Walk the characters of `text` from `open`, calling `visit(ch, i, inString)` for every character;
 * a `"`, `'` or backtick run is a string (escapes honoured), so a brace inside
 * one is not structure — `{ note: "}", content }` closes where the code says.
 */
function walkChars(text: string, open: number, visit: (ch: string, i: number, inString: boolean) => boolean | void) {
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") { visit(ch, i, true); visit(text[++i] ?? "", i, true); continue; }
      if (ch === quote) quote = null;
      visit(ch, i, true);
    } else {
      if (ch === '"' || ch === "'" || ch === "\x60") quote = ch;
      if (visit(ch, i, false) === false) return;
    }
  }
}
/** The brace- or bracket-balanced block that opens at `text[open]`, or null when it never closes. */
function blockAt(text: string, open: number) {
  let depth = 0, end = -1;
  walkChars(text, open, (ch, i, inString) => {
    if (inString) return;
    if (ch === "{" || ch === "[") depth++;
    else if ((ch === "}" || ch === "]") && --depth === 0) { end = i; return false; }
  });
  return end < 0 ? null : text.slice(open, end + 1);
}
/**
 * `block` with everything nested deeper than `depth` blanked — an object's own
 * keys at 1, an array's elements' keys at 2. A `[` that follows `{` or `,` is a
 * computed key (`{ ["content"]: x }`), not a nested value, and stays at its depth.
 */
function topLevel(block: string, depth = 1) {
  let d = 0, out = "", last = "";
  const nests: boolean[] = [];
  walkChars(block, 0, (ch, _i, inString) => {
    if (!inString && (ch === "{" || ch === "[")) {
      const nest = ch === "{" || !(last === "{" || last === ",");
      nests.push(nest);
      if (nest) d++;
      out += d <= depth ? ch : " ";
    } else if (!inString && (ch === "}" || ch === "]")) {
      out += d <= depth ? ch : " ";
      if (nests.pop() !== false) d--;
    } else out += d <= depth ? ch : " ";
    if (!/\s/.test(ch)) last = ch;
  });
  return out;
}
/**
 * SQL from a statement's head onward with its dash-dash line comments and
 * slash-star block comments blanked (newlines kept), and a single-quoted
 * string's text blanked between its quotes — a dash pair, a comma or a column
 * name inside one is text: a column named in a comment or a string is not a
 * column, one beside a comment is, and a comment's own `;`, `WHERE` or `(` no
 * longer ends the list early — the three review passes.
 * Started at the head, where the text is SQL, so a quote in the prose before
 * it does not open a string.
 */
function sqlUncommented(sqlText: string) {
  let out = "", i = 0, quote = false, escapes = false, ident = false;
  while (i < sqlText.length) {
    const ch = sqlText[i];
    if (quote) {
      // An E'…' string reads a backslash-escaped quote as text (the fourth review pass).
      if (escapes && ch === "\\") { out += "  "; i += 2; continue; }
      out += ch === "'" || ch === "\n" ? ch : " "; if (ch === "'") quote = false; i++; continue;
    }
    // A "quoted identifier" is a name, read whole: a dash pair inside it is not a comment (the fourth review pass).
    if (ident) { out += ch; if (ch === '"') ident = false; i++; continue; }
    if (ch === '"') { ident = true; out += ch; i++; continue; }
    if (ch === "'") { quote = true; escapes = /[eE]$/.test(out.slice(-1)) && !/\w/.test(out.slice(-2, -1)); out += ch; i++; continue; }
    if (ch === "-" && sqlText[i + 1] === "-") { while (i < sqlText.length && sqlText[i] !== "\n") { out += " "; i++; } continue; }
    if (ch === "/" && sqlText[i + 1] === "*") {
      const end = sqlText.indexOf("*/", i + 2);
      const stop = end < 0 ? sqlText.length : end + 2;
      for (; i < stop; i++) out += sqlText[i] === "\n" ? "\n" : " ";
      continue;
    }
    out += ch; i++;
  }
  return out;
}
/** The text from `from` on, comments blanked, as far as a statement can reasonably run: 4000 characters (the longest in the tree is under 400). */
const sqlFrom = (text: string, from: number) => sqlUncommented(text.slice(from, from + 4000));
/** Whether a literal opening at `text[open]` — `{…}` or `[{…}, …]` — carries either key at the level a table verb reads. */
const literalCarries = (text: string, open: number) => {
  const block = blockAt(text, open);
  return block !== null && PAYLOAD_KEY.test(topLevel(block, text[open] === "[" ? 2 : 1));
};

/**
 * The 1-based lines of `text` that write a thought's content or vector around
 * the functions, by the rule above. Bindings are collected over the whole text
 * first, so a payload may be filled above or below the verb that sends it — and
 * a name bound to such a payload is one for the WHOLE file, as check 8's bound
 * credential is: scope in regex over unparsed text is not a thing, and a hit on
 * a second, cleaner send of the same name is answered with a rename.
 */
function thoughtWritesAroundIn(text: string) {
  const lineOf = (i: number) => text.slice(0, i).split("\n").length;
  const lines = new Set<number>();
  // Identifiers bound to a payload with either key: `x = { … content … }` or
  // `x = [{ … }]` (the block walked), `Object.assign(x, { … })`, `x.push({ … })`,
  // `x.content = …`, `x.embedding ??= …`, `x.content += …`, `x["embedding"] = …`.
  const payloads = new Set<string>();
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w$.])(${IDENT})\s*(?::[^=\n]*?)?\s*=\s*([{[])`, "g"))) {
    if (literalCarries(text, m.index + m[0].length - 1)) payloads.add(m[1]);
  }
  for (const m of text.matchAll(new RegExp(String.raw`Object\.assign\(\s*(${IDENT})\s*,\s*\{`, "g"))) {
    if (literalCarries(text, m.index + m[0].length - 1)) payloads.add(m[1]);
  }
  // A list filled one literal at a time — `rows.push({ … })`, Python's `rows.append({ … })` — is an array of them (SMD-1524).
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w$.])(${IDENT})\.(?:push|append)\(\s*\{`, "g"))) {
    if (literalCarries(text, m.index + m[0].length - 1)) payloads.add(m[1]);
  }
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w$.])(${IDENT})!?(?:\.(?:content|embedding)|\[\s*["'\x60](?:content|embedding)["'\x60]\s*\])\s*(?:\?\?|\|\||\+)?=(?![=>])`, "g"))) {
    payloads.add(m[1]);
  }
  // The verb — `.update(`, `.upsert(`, or, since SMD-1524, `.insert(` (a type
  // argument allowed): its first argument a literal, a bound name, or an
  // `Object.assign(…)` whose own literals — not the ones nested in them — are read.
  for (const m of text.matchAll(new RegExp(String.raw`${THOUGHTS_TABLE}${GAP}\.(update|upsert|insert)(?:<[^>\n]*>)?\(\s*(?:([{[])|Object\.assign\(|(${IDENT}))`, "g"))) {
    const verbAt = m.index + m[0].lastIndexOf("." + m[1]);
    let hit = false;
    if (m[2]) hit = literalCarries(text, m.index + m[0].length - 1);
    else if (m[3]) hit = payloads.has(m[3]);
    else {
      // The assign's argument list, parens read as brackets so blockAt() spans it; each `{` at its top level is a literal it merges.
      const parens = text.replace(/[()]/g, (c) => (c === "(" ? "[" : "]"));
      const args = blockAt(parens, m.index + m[0].length - 1) ?? "";
      let d = 0;
      walkChars(args, 0, (ch, i, inString) => {
        if (inString) return;
        if (ch === "{" && d === 1 && literalCarries(args, i)) hit = true;
        if (ch === "{" || ch === "[") d++;
        else if (ch === "}" || ch === "]") d--;
      });
    }
    if (hit) lines.add(lineOf(verbAt));
  }
  // SQL: `UPDATE [ONLY] [public.]thoughts [[AS] alias] SET <list>` up to WHERE/RETURNING/;, identifiers
  // quoted or not — the list naming either column as an assignment target, or the tuple form `SET (a, b) = …`.
  // The head is found in the text; the list is read from the text with its comments blanked, so a
  // comment's `;` or `WHERE` does not end it (the third review pass).
  for (const m of text.matchAll(/\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?thoughts"?(?![\w"])(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET\b/gi)) {
    const list = /^([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|;|$)/.exec(sqlFrom(text, m.index + m[0].length))![1]; // the lookahead's `$` alternative makes this match every string
    const tuple = /^\s*\(([^)]*)\)\s*=/.exec(list);
    // An assignment TARGET: first in the list or after a comma — `SET summary = CASE WHEN content = 'x'` compares, it does not assign.
    if (tuple ? /(?:^|[\s,(])"?(?:content|embedding)"?\s*(?:,|$)/i.test(tuple[1]) : /(?:^|,)\s*"?(?:content|embedding)"?\s*=(?!=)/i.test(list)) lines.add(lineOf(m.index));
  }
  // SQL: `INSERT INTO [public.]thoughts [[AS] alias] (<columns>)` — the column list naming either
  // column (SMD-1524). No list, no rule: `INSERT INTO thoughts VALUES …` and `… SELECT …` say nothing.
  for (const m of text.matchAll(/\bINSERT\s+INTO\s+(?:"?public"?\.)?"?thoughts"?(?![\w"])(?:\s+(?:AS\s+)?(?!VALUES\b|SELECT\b)\w+)?\s*\(/gi)) {
    const list = /^([^()]*)\)/.exec(sqlFrom(text, m.index + m[0].length));
    if (list && /(?:^|[\s,])"?(?:content|embedding)"?\s*(?:,|$)/i.test(list[1])) lines.add(lineOf(m.index));
  }
  return [...lines].sort((a, b) => a - b);
}

/** Texts the rule must catch — the nine files' eleven updates and the eight files' inserts, one probe each, the forms a rebase could bring, and the review passes' escapes. */
const THOUGHT_WRITE_PROBES = [
  // update-thought-mcp: a payload filled by property assignment, sent by name, verb on its own line.
  'const updates: Record<string, unknown> = {};\nif (content !== undefined) {\n  updates.content = content;\n  updates.embedding = `[${embedding.join(",")}]`;\n}\nconst { data, error } = await supabase\n  .from("thoughts")\n  .update(updates)\n  .eq("id", id)\n  .select("id")\n  .single();',
  // enhanced-mcp: a literal over several lines, with the file\'s own fingerprint beside the content.
  'const { error: updateError } = await supabase\n  .from("thoughts")\n  .update({\n    content,\n    content_fingerprint: fingerprint,\n    embedding,\n    type: extracted.type,\n    updated_at: new Date().toISOString(),\n  })\n  .eq("id", id);',
  // agent-memory-api and repo-learning-coach (retired since, SMD-2923): the vector alone, after a 2-argument upsert.
  'if (thoughtId) await supabase.from("thoughts").update({ embedding }).eq("id", thoughtId);',
  "const { error: embeddingError } = await supabase\n  .from('thoughts')\n  .update({ embedding })\n  .eq('id', thoughtId)",
  // open-brain-rest: a literal bound to a name, then sent.
  'const update = {\n  embedding,\n  metadata,\n  type,\n  status,\n};\nconst { error } = await supabase.from("thoughts").update(update).eq("id", thoughtId);',
  'const update: Record<string, unknown> = { metadata };\nif (parsed.data.content !== undefined) {\n  update.content = parsed.data.content;\n  update.embedding = await getEmbedding(parsed.data.content);\n}\nconst { error } = await supabase.from("thoughts").update(update).eq("id", id);',
  // rest-api: a typed record bound with the content, the vector added when it came.
  'const updates: Record<string, unknown> = { content, updated_at: new Date().toISOString() };\nif (embedding) updates.embedding = embedding;\nconst { error: updateErr } = await supabase.from("thoughts").update(updates).eq("id", id);',
  'const columnUpdates: Record<string, unknown> = { metadata: existingMetadata };\nif (enriched.embedding) columnUpdates.embedding = enriched.embedding;\nawait supabase.from("thoughts").update(columnUpdates).eq("id", thoughtId);',
  // consolidation-bio: the profile rewrite, a literal over several lines with the text first.
  'const { error: updateError } = await supabase\n  .from("thoughts")\n  .update({\n    content: profileContent,\n    type: "person_note",\n    importance: 5,\n    metadata: profileMetadata,\n    updated_at: now,\n  })\n  .eq("id", existingId);',
  // provenance-chains: a patch that starts as the vector and grows.
  'const patch: Record<string, unknown> = { embedding };\nif (supersedes) patch.supersedes = supersedes;\nconst { error: patchError } = await supabase\n  .from("thoughts")\n  .update(patch)\n  .eq("id", thoughtId);',
  // telegram-capture\'s sample: content and vector in one literal.
  'const { error } = await supabase\n  .from("thoughts")\n  .update({\n    content: messageText,\n    embedding,\n    metadata: { ...metadata, edited: true },\n  })\n  .eq("id", existing[0].id);',
  // The forms a rebase could bring: quoted keys, a bracket assignment, upsert, Python, SQL with an alias, SQL over lines.
  'await supabase.from("thoughts").update({ "embedding": vec }).eq("id", id);',
  'patch["content"] = text;\nawait supabase.from("thoughts").update(patch).eq("id", id);',
  "await supabase.from('thoughts').upsert({ id, content, embedding });",
  'supabase.table("thoughts").update({"content": content, "embedding": embedding}).eq("id", thought_id).execute()',
  'UPDATE thoughts SET content = $2, embedding = $3, updated_at = now() WHERE id = $1;',
  'UPDATE public.thoughts t\nSET embedding = e.vec,\n    updated_at = now()\nFROM embeddings e\nWHERE t.id = e.thought_id;',
  'UPDATE thoughts AS t SET content = trim(t.content) WHERE t.content <> trim(t.content);',
  // The first review pass's escapes: a row type on the client, a comment before the verb,
  // Object.assign into a bound name and inline, an array payload bound or inline, a computed
  // key, Python's from_, UPDATE ONLY, quoted identifiers, the tuple form.
  'await supabase.from<Thought>("thoughts").update({ content, embedding }).eq("id", id);',
  'await supabase\n  .from("thoughts") // the row\n  .update({ content })\n  .eq("id", id);',
  'const patch: Record<string, unknown> = {};\nObject.assign(patch, { embedding });\nawait supabase.from("thoughts").update(patch).eq("id", id);',
  'await supabase.from("thoughts").update(Object.assign({}, base, { content })).eq("id", id);',
  'const rows = [{ id, content, embedding }];\nawait supabase.from("thoughts").upsert(rows, { onConflict: "id" });',
  'await supabase.from("thoughts").upsert([{ id, content }]);',
  'await supabase.from("thoughts").update({ ["content"]: text }).eq("id", id);',
  "supabase.from_('thoughts').update({'content': content}).eq('id', thought_id).execute()",
  'UPDATE ONLY thoughts SET embedding = $2 WHERE id = $1;',
  'UPDATE "public"."thoughts" SET "content" = $2 WHERE "id" = $1;',
  'UPDATE thoughts SET (content, embedding) = ($2, $3) WHERE id = $1;',
  // The second review pass's escapes: a type argument on the verb, a block comment before it, a
  // space before the table's paren, a string value with an unbalanced brace before the key, a
  // backtick key, a backtick bracket assignment, an upsert chain (its line is the verb's).
  'await supabase.from("thoughts").update<Thought>({ content }).eq("id", id);',
  'await supabase\n  .from("thoughts")\n  /* the row */\n  .update({ content })\n  .eq("id", id);',
  'await supabase.from ("thoughts").update({ embedding }).eq("id", id);',
  'await supabase.from("thoughts").update({ note: "}", content }).eq("id", id);',
  'await supabase.from("thoughts").update({ [`embedding`]: vec }).eq("id", id);',
  'const p: Record<string, unknown> = {};\np[`content`] = text;\nawait supabase.from("thoughts").update(p).eq("id", id);',
  // SMD-1524: the fresh row. The Slack/Telegram samples' literal (the non-probe change 69 carried,
  // moved here); readwise-capture's, with the enhanced columns beside the vector; consolidation-bio's,
  // with the file's own fingerprint and no vector; the classification recipe's, content alone; the
  // Python client's dict; a list filled by append, sent by name; a list pushed, sent by name; an
  // array literal; a bound array; a server's SQL with casts; the Neon recipe's template
  // over lines; quoted identifiers with a schema; an alias; INSERT … SELECT with a column list.
  'await supabase.from("thoughts").insert({ content, embedding, metadata });',
  'const { error } = await supabase.from("thoughts").insert({\n  content,\n  embedding,\n  source_type: "readwise",\n  type: "reference",\n  metadata: {\n    source: "readwise",\n    readwise_highlight_id: event.id,\n  },\n});',
  'const { data, error: insertError } = await supabase\n  .from("thoughts")\n  .insert({\n    content: profileContent,\n    type: "person_note",\n    importance: 5,\n    metadata: profileMetadata,\n    content_fingerprint: contentFingerprint,\n  })\n  .select("id")\n  .single();',
  'await db.from("thoughts").insert({\n  content: classified.title,\n  type: classified.type,\n  created_at: new Date().toISOString(),\n});',
  'supabase.table("thoughts").insert({"content": content, "embedding": embedding, "metadata": meta}).execute()',
  'rows = []\nfor h in highlights:\n    rows.append({"content": h["text"], "embedding": h["vec"]})\nsupabase.table("thoughts").insert(rows).execute()',
  'const rows: Record<string, unknown>[] = [];\nrows.push({ content, embedding });\nawait supabase.from("thoughts").insert(rows);',
  'await supabase.from("thoughts").insert([{ content: a, embedding: va }, { content: b, embedding: vb }]);',
  'const batch = [{ content, embedding, metadata }];\nconst { error } = await supabase.from("thoughts").insert(batch);',
  'await client.queryObject(\n  `INSERT INTO thoughts (content, embedding, metadata)\n   VALUES ($1, $2::vector, $3::jsonb)`,\n  [content, embStr, JSON.stringify(meta)]\n);',
  'const rows = await sql`\n  INSERT INTO thoughts (content, embedding, metadata, source)\n  VALUES (${content}, ${embeddingStr}::vector, ${metadataStr}::jsonb, ${source})\n  RETURNING id\n`;',
  'INSERT INTO "public"."thoughts" ("content", "metadata") VALUES ($1, $2);',
  'INSERT INTO thoughts AS t (content, embedding) VALUES ($1, $2::vector) ON CONFLICT DO NOTHING;',
  'INSERT INTO thoughts (content, metadata) SELECT body, \'{}\'::jsonb FROM staging;',
  // The first review pass: a column list over lines with a comment beside a column.
  'INSERT INTO thoughts (\n  content, -- the text\n  metadata\n) VALUES ($1, $2);',
  // The second review pass: a comment after the comma in a SET list, a block comment beside a column.
  'UPDATE thoughts SET metadata = $1, -- note\n  content = $3 WHERE id = $2;',
  'INSERT INTO thoughts (content /* the text */, metadata) VALUES ($1, $2);',
  // The third review pass: a comment whose text would end the list — a `;`, a WHERE, a paren — and a
  // dash pair inside a string beside a real target.
  'UPDATE thoughts SET metadata = $1, -- v2; was v1\n  content = $2 WHERE id = $3;',
  'UPDATE thoughts SET metadata = $1 -- where content lives\n, content = $2 WHERE id = $3;',
  'INSERT INTO thoughts (content, -- (the text)\n  metadata) VALUES ($1, $2);',
  "UPDATE thoughts SET summary = 'a -- b', content = $2 WHERE id = $1;",
  'UPDATE thoughts SET metadata = $1 /* where */ , embedding = $2 WHERE id = $3;',
  'INSERT INTO thoughts (metadata /* (note) */, content) VALUES ($1, $2);',
  // The fourth review pass: a doubled quote, an E-string's escaped quote and a dash pair inside a
  // quoted identifier, each beside a real target.
  "UPDATE thoughts SET summary = 'it''s', content = $2 WHERE id = $1;",
  "UPDATE thoughts SET summary = E'a\\'b', content = $2 WHERE id = $1;",
  'UPDATE thoughts SET "note--x" = $1, content = $2 WHERE id = $3;',
];
/** Texts the rule must not catch — the remedy, the other columns, the other tables, reads, prose. */
const THOUGHT_WRITE_NON_PROBES = [
  'const { data, error } = await supabase.rpc("update_thought", { p_id: id, p_content: content, p_embedding: embedding, p_embedding_model: EMBEDDING_MODEL });',
  'await supabase.rpc("upsert_thought", { p_content: content, p_payload: { metadata, embedding_model: model }, p_embedding: embedding });',
  'await supabase.from("thoughts").update({ metadata: updatedMeta }).eq("id", survivorId);',
  'await supabase.from("thoughts").update({ status: "new", status_updated_at: new Date().toISOString() }).eq("id", id);',
  'const sidecar = { type: extracted.type, sensitivity_tier: resolvedTier, importance: 3 };\nawait supabase.from("thoughts").update(sidecar).eq("id", id);',
  'const { data } = await supabase.from("thoughts").select("id, content, embedding, metadata").eq("id", id).single();',
  'await supabase.from("thought_chunks").update({ content: window }).eq("id", chunkId);',
  'await supabase.from("agent_memories").update({ content: row.content, summary }).eq("id", id);',
  'const updates: Record<string, unknown> = {};\nupdates.type = sanitizeType(String(body.type));\nawait supabase.from("thoughts").update(updates).eq("id", id);',
  'UPDATE thoughts\nSET content_fingerprint = encode(sha256(convert_to(lower(trim(content)), \'UTF8\')), \'hex\')\nWHERE content_fingerprint IS NULL;',
  'UPDATE thoughts SET embedding_model = NULL WHERE embedding IS NULL;',
  "UPDATE thoughts SET metadata = metadata || '{\"source\": \"mcp\"}'::jsonb WHERE metadata->>'source' IS NULL;",
  "UPDATE public.thoughts\nSET type = metadata->>'type'\nWHERE type IS NULL AND metadata->>'type' IS NOT NULL;",
  'UPDATE public.thoughts t\nSET supersedes = NULL\nFROM public.thought_edges te\nWHERE te.to_thought_id = t.id;',
  'UPDATE thoughts SET updated_at = now() WHERE id = $1 RETURNING content, embedding;',
  'a raw UPDATE of the vector around them is the operator\'s, as 021 says',
  'the hasher: createHash("sha256").update(content).digest("hex")',
  'const { error } = await supabase.from("thoughts").update({ ...updates }).eq("id", id);',
  // The first review pass's false positives: a bare name as a VALUE, a nested object, an
  // assignment whose right side is the column.
  'await supabase.from("thoughts").update({ summary: content }).eq("id", id);',
  'const sidecar = { type: t, note: embedding };\nawait supabase.from("thoughts").update(sidecar).eq("id", id);',
  'await supabase.from("thoughts").update({ metadata: { content: "x", embedding: null } }).eq("id", id);',
  'UPDATE thoughts SET summary = content, reviewed = true WHERE id = $1;',
  "UPDATE thoughts SET metadata = jsonb_set(metadata, '{content}', to_jsonb(summary)) WHERE id = $1;",
  'UPDATE thoughts SET metadata = metadata || jsonb_build_object(\'embedding\', 1) WHERE id = $1;',
  // The second review pass's false positives: a column compared inside a CASE in the SET list, a
  // nested object inside an inline Object.assign.
  "UPDATE thoughts SET summary = CASE WHEN content = 'x' THEN 'y' ELSE summary END WHERE id = $1;",
  'await supabase.from("thoughts").update(Object.assign({}, base, { metadata: { content: "x" } })).eq("id", id);',
  // SMD-1524: inserts that are not the rule's — another table, the other columns, no column list,
  // a metadata-only row, the function's own remedy, prose naming the statement, a chunk row.
  'INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding) VALUES ($1, 0, $2, $3::vector);',
  'INSERT INTO thoughts (id, content_fingerprint, embedding_model, created_at) VALUES ($1, $2, $3, now());',
  'INSERT INTO thoughts VALUES ($1, $2, $3);',
  "INSERT INTO thoughts SELECT * FROM thoughts_staging;",
  'await supabase.from("thoughts").insert({ metadata: { source: "import" } });',
  'await supabase.from("readwise_books").insert({ content: note, title });',
  'await supabase.from("consolidation_log").insert({ operation: "profile", details: { content: "x" } });',
  'Any code path that writes a raw `INSERT INTO thoughts` — a webhook handler — will insert a row with a NULL fingerprint.',
  'await supabase.rpc("upsert_thought", { p_content: content, p_payload: { metadata: meta, embedding_model: EMBEDDING_MODEL }, p_embedding: embedding });',
  'thoughts = [build_thought(h, book) for h in batch]\nsupabase.table("thoughts").insert(thoughts).execute()',
  // The first review pass: a comment naming the column is not the column.
  'INSERT INTO thoughts (\n  metadata -- not content\n) VALUES ($1);',
  // The second review pass: the same in a block comment, and in a SET list.
  'INSERT INTO thoughts (metadata /* content */) VALUES ($1);',
  'UPDATE thoughts SET metadata = $1 /* content = $3, */ WHERE id = $2;',
  // The third review pass: the column named inside a string is text, not a target.
  "UPDATE thoughts SET summary = 'x -- content = 1' WHERE id = $1;",
  "UPDATE thoughts SET summary = 'see, content = old' WHERE id = $1;",
];
const OWN_DATABASE = (what: string): CountedException => ({ why: `${what} — the fork's functions are not in it, so the capture is a raw row with no fingerprint, no label and no audit actor; the README says so`, lines: 1 });
const THOUGHT_WRITE_EXCEPTIONS = new Map([
  // The guide that shows upstream's upsert_thought body: the INSERT is the function's own (check 7 excepts the same lines).
  ["recipes/content-fingerprint-dedup/README.md", { why: "the INSERT inside the upsert_thought definition migration 003 was extracted from, kept as its record", lines: 1 }],
  // Two that own their database, built from the guide's shape.
  ["recipes/vercel-neon-telegram/src/lib/db.ts", OWN_DATABASE("its own Neon database, built by sql/001-create-thoughts.sql")],
  ["recipes/schema-aware-routing/index.ts", OWN_DATABASE("its own five-table project, built by its README's SQL (a `thoughts` with domain/status/source columns)")],
  // The fixture: a row as an older write left it — fingerprint and label by hand — for the writer under test to move.
  ["extensions/test-writes.ts", { why: "plants a thought as an older write left it, fingerprint and label supplied by hand, for the writer under test to move whole", lines: 1 }],
]);

function checkThoughtWritesAround() {
  for (const probe of THOUGHT_WRITE_PROBES) {
    // Caught on exactly one line, and that line is the verb's (or the UPDATE's): the second review
    // pass found an upsert chain reported on the line before its verb, which a count alone passed.
    const got = thoughtWritesAroundIn(probe);
    const verbLine = probe.split("\n").findIndex((l) => /\.(?:update|upsert|insert)\b/.test(l) || /\b(?:UPDATE\s+(?:ONLY\s+)?|INSERT\s+INTO\s+)"?(?:public|thoughts)\b/i.test(l)) + 1;
    if (got.length !== 1 || got[0] !== verbLine) fail(SELF, `thought-write rule no longer catches its probe on its verb's line ${verbLine} (caught ${got.join(",") || "none"}): ${JSON.stringify(probe)}`);
  }
  for (const text of THOUGHT_WRITE_NON_PROBES) {
    if (thoughtWritesAroundIn(text).length > 0) fail(SELF, `thought-write rule catches ordinary text it must not: ${JSON.stringify(text)}`);
  }
  const MSG = "writes a thought's content or vector around the functions that own them — the fingerprint (003/018), the model label (021) and the chunk rows (022) are left describing the text and vector before the write, and no actor reaches the audit (008); route an edit through update_thought(p_id, p_content, p_metadata_patch, p_embedding, …, p_embedding_model) and a capture — an insert too — through the 3-argument upsert_thought with embedding_model in the payload, the columns it does not know by an update carrying neither content nor vector (FORK.md changes 69 and 70, SMD-1228 and SMD-1524) — or list the file in THOUGHT_WRITE_EXCEPTIONS with its line count and the reason, and say in its README what its rows lack";
  const counts = new Map<string, number>();
  for (const file of textFilesUnder(SCANNED_ROOTS)) {
    const rel = relOf(file);
    const hits = thoughtWritesAroundIn(readFileSync(file, "utf8"));
    if (hits.length === 0) continue;
    counts.set(rel, hits.length);
    if (!THOUGHT_WRITE_EXCEPTIONS.has(rel)) for (const line of hits) fail(`${rel}:${line}`, MSG);
  }
  for (const [rel, { why, lines }] of THOUGHT_WRITE_EXCEPTIONS) {
    const seen = counts.get(rel) ?? 0;
    if (seen !== lines) {
      fail(rel, seen === 0
        ? `listed as a thought-write exception (${why}) but matches nothing — remove it from THOUGHT_WRITE_EXCEPTIONS`
        : `thought-write exception (${why}) covers ${lines} line(s) but ${seen} match — a new write beside the documented one, or the exception's count is stale`);
    }
  }
}

// ── 11: the vendored files are Bun-native ────────────────────────────────────
//
// SMD-1799 (SMD-1480 before it, FORK.md change 74). The files under the
// category directories were Supabase Edge Functions — `Deno.env.get` for their
// environment, `Deno.serve` at the end — and ran on Bun, where the SQL shim
// lives, only through compat/deno-on-bun.ts, a polyfill for those two members
// that this check held as each file's first import. SMD-1799 gave the files
// Bun's own shape instead: `process.env` for the environment and
// `export default { port, fetch }` at the tail — the shape server-portable/index.ts
// had (api.ts's too), and what `bun <file>` serves — and the polyfill is gone. This holds
// the tree there:
//   - no code file under the seven category directories or docs/ reaches
//     `Deno` — any member, or the bare name (an alias, a bracket, a
//     destructure, `typeof Deno`: a Bun-native file does not detect its
//     runtime) — save what DENO_EXCEPTIONS names with the reason and the
//     exact count of lines, so a new line fails and a stale entry fails
//     (none today: the seven Edge Function files it counted, the
//     local-brain-no-mcp recipe's five and the cost recipe's two, left the
//     tree with SMD-1800);
//   - a file that imports compat/supabase-sql (Bun's client) imports no
//     specifier Bun cannot resolve — `jsr:`, `npm:`, a URL — in the file or
//     the files it imports, relatively and transitively, a dynamic
//     `import("…")` included (`node:` is fine).
// Comments, string contents and regex literals are not code, and a template
// literal's `${…}` expressions are: members and specifiers are read with the
// former blanked (line numbers kept). Scanned: every .ts/.tsx/.mts/.cts/.js/
// .jsx/.mjs/.cjs under the seven category directories and docs/.
/** `Deno` wherever it appears in code: a member chain of up to two names, or bare. */
const DENO_MEMBER = /\bDeno\b(?:\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?)?/g;
/** A dynamic import's literal specifier — quoted or in a plain backtick literal; one with `${…}` is not a literal and is not read. */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'\x60])([^"'\x60\n$]+)\1/g;
const SHIM_SPECIFIER = /compat\/supabase-sql\/index\.ts$/;
/** A specifier Bun does not resolve: Deno's registries and a URL. */
const NOT_ON_BUN = /^(?:jsr:|npm:|https?:\/\/)/;
/**
 * file → the reason it still reaches `Deno`, and the exact count of lines that do. A line past the count
 * fails; a count no line reaches fails as stale; a file that is gone fails until its entry goes. None today:
 * the seven Edge Function files this held (local-brain-no-mcp's five, the cost recipe's after sample and its
 * 410 stub) left the tree with SMD-1800. An entry here is a deployment on another runtime, with the ticket
 * that retires it.
 */
const DENO_EXCEPTIONS = new Map<string, CountedException>([]);

/**
 * `text` with comments and regex literals blanked, and — when `stringsToo` —
 * string contents blanked as well; every blanked character becomes a space,
 * newlines stay (a `\`-newline continuation keeps its newline), so offsets and
 * line numbers hold. One scanner, `scan`, linear in the text: a template
 * literal's `${…}` expressions are code and stay — read by the same rules, so
 * a quote, a `}` or a comment inside a regex or string within one is read as
 * such, and the expression ends at the first `}` at depth 0 — while the
 * literal's own text is blanked (`\`${Deno.env.get("X")}/y\`` is the Edge
 * Function idiom; SMD-1799's first review pass found the whole literal
 * blanked, its second found the expression's end read by a scanner that knew
 * no regex). A `/` opens a regex literal where a value cannot end — after `(`,
 * `,`, `=`, `:`, `[`, `!`, `&`, `|`, `?`, `{`, `}`, `;`, an arithmetic
 * operator, the start of the text, or a keyword such as `return` (not a member
 * named like one: `a.return / b`) — and is blanked to its closing `/` on the
 * same line (a `]`-closed class may hold one); a `/` with no close on its line
 * is a division, and so is one after `)` or `<` (`</td>` is JSX's closer, and
 * two on a line read as a regex spanning the cell between, .tsx being in
 * scope), after a postfix `++` or `--`, and after a non-null `x!` — a `!`
 * right after a name or a closing bracket, unless that name is a keyword not
 * led by a `.` (`return!/re/` still negates; SMD-3323). What this cannot read:
 * a regex after `)` with a quote inside hides the rest of that line, never a
 * later one (a string stops at the newline), as does one after `)!` with no
 * space (`if (a)!/'/`, read as a non-null) — but a backtick in such a regex
 * opens a template that runs on, which check 42 reports at a later line; a
 * `/` after a non-null with a space or a block comment before its `!`
 * (`x ! / 2`) or after a tagged template's `!` reads as a regex to the
 * next `/` on its line; an apostrophe in JSX text
 * (`<td>it's</td><td>{Deno.pid}</td>`) does the same — the .tsx analogue of
 * the prose hazard check 22 met — and matters only when `Deno` shares the
 * line, as does a keyword before a `/` in JSX text (`<p>default / custom</p>`).
 * `blankedWithOpen` also says where a template or `${` the text ends inside
 * began, which check 42 reports rather than trusts.
 */
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof", "default"]);
function blanked(text: string, stringsToo: boolean): string {
  return scan(text, 0, stringsToo, false).out;
}
/**
 * `blanked`, and where the text ends inside a template literal or `${` (-1 for none): the innermost `${` left open,
 * else the template; a reading that ran on to the end, which check 42 reports at its line rather than trusts
 * (SMD-3323). `scan`'s own `end` matters only to its recursion, so callers take this pair.
 */
function blankedWithOpen(text: string, stringsToo: boolean): { out: string; openAt: number } {
  const { out, openAt } = scan(text, 0, stringsToo, false);
  return { out, openAt };
}
/**
 * The scanner behind `blanked`: from `from`; when `inExpression`, stops at the first `}` at depth 0 and says where;
 * `openAt` is where the text ends inside a template or `${`: the innermost `${` left open, else the template; -1 for
 * none.
 */
function scan(text: string, from: number, stringsToo: boolean, inExpression: boolean): { out: string; end: number; openAt: number } {
  let out = "";
  let openAt = -1;
  // The last code character that is not a space, the last identifier (kept across the spaces after it) and whether it
  // followed a `.` — for the regex-or-division question at a `/`.
  let last = "", word = "", wordOpen = false, afterDot = false, depth = 0;
  // The code character just before `last` with nothing between them, "" where a space or a blanked span came between,
  // the identifier that ended there and whether a `.` led it — for the postfix and non-null cases at a `/` (SMD-3323).
  // `lastEnd` is where the last emitted code character sits in `out`, so adjacency is a position, not a read back into
  // the growing string (PR 2a review pass 1: indexing `out` flattened it at every character, and the checker took
  // 178 s, where it takes about 5). A string, template or regex leaves it behind, so what follows one is never adjacent.
  let beforeLast = "", wordBeforeLast = "", dotBeforeLast = false, lastEnd = -1;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const emit = (ch: string) => {
    out += ch;
    if (/\s/.test(ch)) { wordOpen = false; return; }
    const adjacent = last !== "" && lastEnd === out.length - 2;
    beforeLast = adjacent ? last : "";
    wordBeforeLast = adjacent ? word : "";
    dotBeforeLast = adjacent && afterDot;
    lastEnd = out.length - 1;
    if (/[\w$]/.test(ch)) { if (!wordOpen) afterDot = last === "."; word = wordOpen ? word + ch : ch; wordOpen = true; } else { word = ""; wordOpen = false; }
    last = ch;
  };
  let i = from;
  for (; i < text.length;) {
    const c = text[i], d = text[i + 1];
    if (c === "/" && d === "/") { while (i < text.length && text[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2), stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" ? "\n" : " ";
      continue;
    }
    if (c === '"' || c === "'") {
      out += c; i++;
      while (i < text.length && text[i] !== c && text[i] !== "\n") {
        if (text[i] === "\\") { const esc = text.slice(i, i + 2); out += stringsToo ? blank(esc) : esc; i += esc.length; continue; }
        out += stringsToo ? " " : text[i]; i++;
      }
      if (i < text.length && text[i] === c) { out += c; i++; }
      last = c; word = "";
      continue;
    }
    if (c === "`") {
      const opened = i;
      out += c; i++;
      while (i < text.length && text[i] !== "`") {
        if (text[i] === "\\") { const esc = text.slice(i, i + 2); out += stringsToo ? blank(esc) : esc; i += esc.length; continue; }
        if (text[i] === "$" && text[i + 1] === "{") {
          const inner = scan(text, i + 2, stringsToo, true);
          if (openAt < 0) openAt = inner.openAt >= 0 ? inner.openAt : inner.end >= text.length ? i : -1;
          out += "${" + inner.out + (inner.end < text.length ? "}" : "");
          i = inner.end + 1;
          continue;
        }
        out += stringsToo && text[i] !== "\n" ? " " : text[i]; i++;
      }
      if (i < text.length) { out += "`"; i++; }
      else if (openAt < 0) openAt = opened;
      last = "`"; word = "";
      continue;
    }
    // `a++ / 2` and `a-- / 2` divide: a postfix operator ends a value. So does TypeScript's non-null `x!`, where the `!`
    // follows a value with nothing between (`return!/re/` still negates a regex).
    const postfix = (last === "+" || last === "-") && beforeLast === last;
    const nonNull = last === "!" && /[\w$)\]]/.test(beforeLast) && !(REGEX_AFTER_WORD.has(wordBeforeLast) && !dotBeforeLast);
    if (c === "/" && !postfix && !nonNull && (last === "" || "(,=:[!&|?{};+-*%>~^".includes(last) || (REGEX_AFTER_WORD.has(word) && !afterDot))) {
      // A regex literal, if one closes on this line; else the `/` is a division.
      let j = i + 1, inClass = false, closed = false;
      for (; j < text.length && text[j] !== "\n"; j++) {
        if (text[j] === "\\" && text[j + 1] !== "\n") { j++; continue; } // an escape, never past the line's end
        if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        else if (text[j] === "/" && !inClass) { closed = true; break; }
      }
      if (closed) {
        out += "/" + " ".repeat(j - i - 1) + "/"; i = j + 1;
        while (i < text.length && /[a-z]/.test(text[i])) { out += " "; i++; } // the flags
        last = "/"; word = "";
        continue;
      }
    }
    if (inExpression) {
      if (c === "{") depth++;
      else if (c === "}") { if (depth === 0) return { out, end: i, openAt }; depth--; }
    }
    emit(c); i++;
  }
  return { out, end: text.length, openAt };
}

/**
 * Every import (and export-from) statement's specifier, with the line it starts
 * on, in order. A statement ends at its `;`, or — for one written on a single
 * line with no `;` (SMD-1799's second review pass found a semicolon-less
 * recipe's twelve files' imports unread; that recipe, repo-learning-coach,
 * retired with SMD-2923, and no file on the shim is semicolon-less now, but
 * the reading stays until this rule retires with the shim, SMD-3216) — at
 * its line's end. A semicolon-less import that spans lines is still missed (a
 * silent miss, never a false catch), so the rule says so here.
 */
function importSpecifiers(text: string) {
  const code = blanked(text, false);
  const out: { spec: string; line: number }[] = [];
  const lineOf = lineIndexer(code);
  // A statement runs to its `;` but never across a newline into a line that opens another statement or leads
  // with `;` (standard style's `;[…]` and `;(…)` idioms): the third review pass found a semicolon-less import
  // counted twice through the next line's leading `;`, and a mixed file's `;`-terminated import credited to the
  // semicolon-less line above it. The `;` must sit on the specifier's own line.
  for (const m of code.matchAll(/^[ \t]*(?:import|export)\b(?:[^;\n]|\n(?![ \t]*(?:import\b|export\b|;)))*;/gm)) {
    const spec = /\bfrom\s*(["'])([^"'\n]+)\1[ \t]*;$/.exec(m[0]) ?? /^[ \t]*import\s*(["'])([^"'\n]+)\1[ \t]*;$/.exec(m[0]);
    if (spec) out.push({ spec: spec[2], line: lineOf(m.index) });
  }
  for (const m of code.matchAll(/^[ \t]*(?:import|export)\b[^;\n]*$/gm)) {
    const spec = /\bfrom\s*(["'])([^"'\n]+)\1\s*$/.exec(m[0]) ?? /^[ \t]*import\s*(["'])([^"'\n]+)\1\s*$/.exec(m[0]);
    if (spec) out.push({ spec: spec[2], line: lineOf(m.index) });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Whether `text` imports the SQL shim by a relative specifier. */
const importsShim = (text: string) => importSpecifiers(text).some((s) => SHIM_SPECIFIER.test(s.spec));

/** Every `Deno` reached in `text`'s code, as `{ member, line }` — `<bare>` when not through a member; `globalThis.Deno.x` reads as `Deno.x`. */
function denoLinesIn(text: string): { member: string; line: number }[] {
  const code = blanked(text, true);
  const lineOf = lineIndexer(text);
  const out: { member: string; line: number }[] = [];
  for (const m of code.matchAll(DENO_MEMBER)) {
    const member = m[1] === undefined ? "<bare>" : m[2] ? `${m[1]}.${m[2]}` : m[1];
    out.push({ member, line: lineOf(m.index!) });
  }
  return out;
}
/**
 * The specifiers Bun does not resolve, as `specifier:<s>@<line>`: in `entry`'s
 * imports, export-froms and literal dynamic imports, and in `deps` — the texts
 * of the files the entry imports, relatively and transitively — prefixed with
 * their index (`dep0:`). Pure over texts so the probes below need no files.
 */
function specifierGapsIn(entry: string, deps: string[] = []): string[] {
  const gaps: string[] = [];
  [entry, ...deps].forEach((text, i) => {
    const at = i === 0 ? "" : `dep${i - 1}:`;
    for (const s of importSpecifiers(text)) if (NOT_ON_BUN.test(s.spec)) gaps.push(`${at}specifier:${s.spec}@${s.line}`);
    const code = blanked(text, true);
    const lineOf = lineIndexer(text);
    for (const m of code.matchAll(DYNAMIC_IMPORT)) {
      // The specifier's text is blanked in `code`; read it from the original at the same offset.
      const spec = text.slice(m.index + m[0].length - m[2].length - 1, m.index + m[0].length - 1);
      if (NOT_ON_BUN.test(spec)) gaps.push(`${at}specifier:${spec}@${lineOf(m.index!)}`);
    }
  });
  return gaps;
}

/** [text, the `member@line` list it must report]: every spelling of reaching `Deno`, and the texts that do not. */
const DENO_PROBES: [string, string[]][] = [
  // The Edge Function shape: an env read and the serve tail.
  ['import { createClient } from "../../compat/supabase-sql/index.ts";\nconst u = Deno.env.get("SUPABASE_URL");\nDeno.serve(() => new Response("ok"));\n', ["env.get@2", "serve@3"]],
  // The members the polyfill never provided.
  ['const t = await Deno.readTextFile("x");\n', ["readTextFile@1"]],
  ['if (!ok) Deno.exit(1);\n', ["exit@1"]],
  ['const all = Deno.env.toObject();\n', ["env.toObject@1"]],
  // `Deno` reached around the member syntax — an alias, a bracket, a destructure, a runtime test — each `<bare>`.
  ['const D = Deno;\nD.exit(1);\n', ["<bare>@1"]],
  ['const k = Deno["env"].get("X");\n', ["<bare>@1"]],
  ['const { readTextFile } = Deno;\n', ["<bare>@1"]],
  ['if (typeof Deno !== "undefined") run();\n', ["<bare>@1"]],
  // Through globalThis, and after a multi-line import.
  ['import {\n  createClient,\n} from "../../compat/supabase-sql/index.ts";\nconst u = globalThis.Deno.env.get("X");\n', ["env.get@4"]],
  // A Node-shaped file on the shim: nothing.
  ['#!/usr/bin/env node\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nconst url = process.env.SUPABASE_URL;\n', []],
  // Members in comments and strings are prose.
  ['// All env reads use Deno.env.get(); never Deno.readTextFile.\nconst note = "Deno.serve(app.fetch)"; /* Deno.exit */\n', []],
  // Bun's entry shape, the tail the sweep left.
  ['export default {\n  port: Number(process.env.PORT || 8000),\n  fetch: app.fetch,\n};\n', []],
  // A template literal's expressions are code (the first review pass found the whole literal blanked), nested or not.
  ['const u = `${Deno.env.get("SUPABASE_URL")}/rest/v1`;\n', ["env.get@1"]],
  ['const s = `a ${cond ? `${Deno.env.get("A")}` : "b"} c`;\n', ["env.get@1"]],
  ['const t = `plain ${x} text`;\nDeno.exit(1);\n', ["exit@2"]],
  // A regex literal is not code: a quote inside one used to open a "string" that hid the next line (the same pass);
  // `\bDeno\.env\b` inside one is prose; a division is not a regex; a regex after `return` is one.
  ['const re = /["\']?Deno\\.env/;\nDeno.exit(1);\n', ["exit@2"]],
  ['const m = text.match(/\\bDeno\\.env\\b/g);\n', []],
  ['const half = total / 2;\nDeno.exit(1);\n', ["exit@2"]],
  ['function f(s) { return /Deno/.test(s); }\nDeno.exit(1);\n', ["exit@2"]],
  // The second review pass, against a parser oracle: a `/` after `<` is JSX's closer, not a regex (two on a .tsx
  // line read as one spanning the cell between); a quote or a `}` inside a regex within `${…}` is the regex's; a
  // member named like a keyword is not the keyword; a `\`-newline continuation keeps its line count.
  ['return <tr><td>{a}</td><td>{Deno.env.get("B")}</td></tr>;\n', ["env.get@1"]],
  ['const s = `${/"/.test(a)}`; Deno.exit(1);\n', ["exit@1"]],
  ['const t = `${/}/.test(Deno.pid)}`;\n', ["pid@1"]],
  ['const r = a.return / Deno.pid / 2;\n', ["pid@1"]],
  ['const s = "a\\\nb";\nDeno.exit(1);\n', ["exit@3"]],
  // Not read, by design: `globalThis["Deno"]`, `Reflect.get(globalThis, "Deno")`, `eval("Deno")` — strings are prose,
  // and a rule on the string "Deno" would refuse every README's code block; a file that hides its runtime that way
  // is a review finding, not a checker's.
];
/** The files check 11 reads: every code extension check 22's CODE_FILE reads, less the markup ones (a `Deno` in a Svelte or HTML script is check 22's kind of rare). */
const BUN_CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** [entry, deps, the gaps it must report]: specifiers Bun does not resolve, in the entry and through a dependency. */
const SPECIFIER_PROBES: [string, string[], string[]][] = [
  // Deno's registries and a URL, in an import and an export-from; a dynamic import; through a dependency.
  ['import "jsr:@supabase/functions-js/edge-runtime.d.ts";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\n', [], ["specifier:jsr:@supabase/functions-js/edge-runtime.d.ts@1"]],
  ['import { Hono } from "npm:hono@4.9.2";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\n', [], ["specifier:npm:hono@4.9.2@1"]],
  ['import { createClient } from "../../compat/supabase-sql/index.ts";\nexport {\n  Pool,\n} from "https://deno.land/x/postgres@v0.17.0/mod.ts";\n', [], ["specifier:https://deno.land/x/postgres@v0.17.0/mod.ts@2"]],
  ['import { createClient } from "../../compat/supabase-sql/index.ts";\nconst p = await import("jsr:@std/path");\n', [], ["specifier:jsr:@std/path@2"]],
  ['import { createClient } from "../../compat/supabase-sql/index.ts";\nimport { db } from "./_shared/db.ts";\n', ['import { Pool } from "npm:pg@8";\nexport const db = new Pool();\n'], ["dep0:specifier:npm:pg@8@1"]],
  // `node:` is fine, a relative dynamic import is fine, a specifier in a comment or a string is prose.
  ['import { createHash } from "node:crypto";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nconst m = await import("./tools.ts");\n// see "jsr:@supabase/functions-js"\nconst s = "npm:hono";\n', [], []],
  // Semicolon-less, single-line (the second review pass: a semicolon-less recipe's shape, unread until then).
  ["import { Hono } from 'npm:hono@4'\nimport { createClient } from '../../compat/supabase-sql/index.ts'\n", [], ["specifier:npm:hono@4@1"]],
  // The third pass: a `;`-led next line counts the import once; a mixed file credits each import to its own line.
  ["import { a } from 'npm:a'\n;[1].forEach(f)\n", [], ["specifier:npm:a@1"]],
  ["import { a } from 'npm:a'\nimport { b } from 'npm:b';\nimport { c } from 'npm:c'\n", [], ["specifier:npm:a@1", "specifier:npm:b@2", "specifier:npm:c@3"]],
  // A multi-line, `;`-terminated import is still read whole.
  ['import {\n  createClient,\n} from "npm:@supabase/supabase-js@2";\nimport { x } from "../../compat/supabase-sql/index.ts";\n', [], ["specifier:npm:@supabase/supabase-js@2@1"]],
];

function checkBunNative() {
  for (const [probe, want] of DENO_PROBES) {
    const got = denoLinesIn(probe).map((d) => `${d.member}@${d.line}`);
    if (got.join() !== want.join()) fail(SELF, `bun-native rule reports ${JSON.stringify(got)} for a probe that must report ${JSON.stringify(want)}: ${JSON.stringify(probe)}`);
  }
  for (const [entry, deps, want] of SPECIFIER_PROBES) {
    const got = specifierGapsIn(entry, deps);
    if (got.join() !== want.join()) fail(SELF, `bun-native rule reports ${JSON.stringify(got)} for a specifier probe that must report ${JSON.stringify(want)}: ${JSON.stringify(entry)}`);
  }
  for (const name of ["x.ts", "x.tsx", "x.mts", "x.cts", "x.js", "x.jsx", "x.mjs", "x.cjs"]) if (!BUN_CODE_FILE.test(name)) fail(SELF, `check 11's BUN_CODE_FILE no longer reads ${name} (its own probe)`);
  for (const name of ["x.md", "x.json", "x.sql", "x.svelte", "x.html"]) if (BUN_CODE_FILE.test(name)) fail(SELF, `check 11's BUN_CODE_FILE reads ${name}, which it should not (its own probe)`);
  if (!importsShim("import { createClient } from '../../compat/supabase-sql/index.ts'\nexport const c = createClient(u, k)\n")) fail(SELF, "importsShim no longer sees a semicolon-less shim import (its own probe)");
  if (importsShim("// import { createClient } from '../../compat/supabase-sql/index.ts';\nconst s = 'compat/supabase-sql/index.ts';\n")) fail(SELF, "importsShim reads a shim import out of a comment or a string (its own probe)");
  const gone = new Set([...DENO_EXCEPTIONS.keys()].filter((rel) => !existsSync(join(ROOT, rel))));
  for (const rel of gone) fail(SELF, `DENO_EXCEPTIONS names ${rel}, which is not in the tree — remove the entry with the file`);

  const HOW = "reaches `Deno` — the vendored files are Bun-native (SMD-1799): `process.env` for the environment, `export default { port, fetch }` at the tail, Bun's own APIs for files and arguments (the Edge Function deployments that were excepted left with SMD-1800; DENO_EXCEPTIONS counts a deployment on another runtime, with the ticket that retires it — none today)";
  const code = textFilesUnder(SCANNED_ROOTS).filter((f) => BUN_CODE_FILE.test(f) && !f.includes(`${sep}node_modules${sep}`));
  const reached = new Map<string, number>();
  for (const file of code) {
    const text = readFileSync(file, "utf8");
    const rel = relOf(file);
    const lines = [...new Set(denoLinesIn(text).map((d) => d.line))].sort((a, b) => a - b);
    if (lines.length) {
      if (DENO_EXCEPTIONS.has(rel)) reached.set(rel, lines.length);
      else for (const line of lines) fail(`${rel}:${line}`, HOW);
    }
    if (!importsShim(text)) continue;
    // The files it evaluates: relative imports, transitively, that exist in the tree — not the shim itself.
    const deps: string[] = [];
    const seen = new Set([file]);
    const queue = [file];
    while (queue.length) {
      const from = queue.shift()!; // the loop runs while queue.length
      const src = from === file ? text : readFileSync(from, "utf8");
      for (const { spec } of importSpecifiers(src)) {
        if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
        // As Bun resolves it: the path as written; a `.js`/`.mjs` specifier for a `.ts`/`.tsx`/`.mts` file; an
        // extensionless one; a directory's index — in Bun's order, the first that is a file.
        const target = join(dirname(from), spec);
        const p = [target, target.replace(/\.js$/, ".ts"), target.replace(/\.js$/, ".tsx"), target.replace(/\.mjs$/, ".mts"),
          ...(/\.\w+$/.test(spec) ? [] : [`${target}.ts`, `${target}.tsx`, `${target}.js`]),
          join(target, "index.ts"), join(target, "index.tsx"), join(target, "index.js")]
          .find((c) => existsSync(c) && statSync(c).isFile());
        if (!p || seen.has(p) || relOf(p).startsWith("compat/")) continue;
        seen.add(p); queue.push(p); deps.push(p);
      }
    }
    for (const gap of specifierGapsIn(text, deps.map((d) => readFileSync(d, "utf8")))) {
      const dep = /^dep(\d+):/.exec(gap);
      const where = dep ? relOf(deps[Number(dep[1])]) : rel;
      const g = dep ? gap.slice(dep[0].length) : gap;
      const spec = g.slice("specifier:".length).replace(/@\d+$/, "");
      const line = /@(\d+)$/.exec(g)?.[1];
      fail(`${where}:${line}`, `imports \`${spec}\` in a file that runs under Bun, which does not resolve it — the shim's servers run as \`bun <file>\` (a \`jsr:\` type import goes; \`npm:pkg@v\` is \`pkg\` in the directory's package.json; a URL import is a package)`);
    }
  }
  for (const [rel, { why, lines }] of DENO_EXCEPTIONS) {
    if (gone.has(rel)) continue; // failed once above
    const n = reached.get(rel) ?? 0;
    if (n !== lines) fail(rel, n === 0
      ? `listed as a Deno exception (${why}) but reaches \`Deno\` on no line — remove it from DENO_EXCEPTIONS`
      : `listed as a Deno exception for ${lines} line(s) (${why}) but reaches \`Deno\` on ${n} — a new line is a new use, a gone line a stale count`);
  }
}

// ── 12: schema SQL runs nothing that needs Supabase ──────────────────────────
//
// SMD-1796. Twelve of the seventeen SQL files under schemas/ ended with GRANTs
// TO service_role, RLS enabled with a policy FOR service_role, GRANTs and
// REVOKEs naming authenticated and anon, and (two) policies on auth.uid().
// Those are Supabase's roles and GoTrue's schema: on any Postgres that is not
// Supabase the first such statement stops the file (`role "service_role" does
// not exist`), and where an operator creates the role to get past it, RLS with
// no policy for the role they actually connect as denies that role every row.
// The statements were cut on that ticket (FORK.md change 93), each file left
// with a note pointing at `migrate.ts --grant`'s `community` group; this keeps
// the next rebase from bringing them back — and holds db/ to the same rule
// test-schema [10] has held the migrations to since the start, now one
// spelling: db/config.mjs's SUPABASE_SQL_RULES over stripSqlComments, which
// is literal-aware (a `--` inside a string no longer hides the rest of its
// line — SMD-1316's ask) and scans string literals, since `EXECUTE 'GRANT … TO
// service_role'` runs the grant as surely as the bare statement. Every .sql
// under db/ and the seven category directories, whole; no exceptions. Until
// SMD-1810 the walk covered schemas/ and db/ alone, and the extension and
// recipe directories carried fourteen more such files — per-user `auth.uid()
// = user_id` policies on most, GRANTs TO service_role or authenticated, one
// `REFERENCES auth.users`, and `EXECUTE 'GRANT … TO service_role'` strings
// inside ops-views.sql's DO blocks (the case the literal-aware scan exists
// for). Those were cut on that ticket under SMD-1716's single-operator model
// (the server scopes rows by DEFAULT_USER_ID; the policies were the same fact
// in GoTrue's schema), their tables became `--grant`'s `extensions` and
// `recipes` groups, and the walk widened to db/ and the seven category
// directories, plugins/ among them (SQL_RULE_DIRS — evals/ keeps its own SQL out of it) so the
// next new recipe is held to the rule the day it lands.

const SQL_RULE_DIRS = ["db", "extensions", "primitives", "recipes", "schemas", "integrations", "skills", "plugins"];

function checkSupabaseIsms() {
  for (const dir of SQL_RULE_DIRS) {
    const base = join(ROOT, dir);
    if (!existsSync(base)) continue;
    for (const file of walk(base, [], /\.sql$/)) {
      const rel = relOf(file);
      for (const h of supabaseIsmsIn(readFileSync(file, "utf8"))) fail(`${rel}:${h.line}`, `${h.msg} (SMD-1796, SMD-1810)`);
    }
  }
}

// ── 13: a compose file publishes a port on loopback, by a knob, or not at all ──
//
// SMD-1844. deploy/compose.yaml carried `"${POSTGRES_PORT:-5432}:5432"`,
// `"${SERVER_PORT:-8000}:8000"` and `"${OLLAMA_PORT:-11434}:11434"`: an
// address-less mapping, which compose binds to 0.0.0.0. On the first stack the
// fork ran (podman machine, macOS) `lsof` showed gvproxy on `*:5432` and
// `*:8010` — the postgres superuser on the whole brain behind its password, and
// the MCP server with its key in clear on every request, offered to every host
// on the LAN. The file's own comment said to drop the database port in
// production; the default was the exposed one and no README said to. Since the
// fix every published mapping is the short form `"${X_BIND:-127.0.0.1}:
// ${X_PORT:-n}:n"` — the literal 127.0.0.1 unless the operator names an
// address, in a knob deploy/.env.example documents — and the base file
// publishes the server (since SMD-1846 the proxy in front of it, on the same
// knobs), the break-glass listener under the `auth` profile on a literal
// 127.0.0.1 (SMD-3307), plus n8n under the opt-in `orchestration` profile
// since SMD-2210; the database and Ollama reach the host only
// through compose.host-ports.yaml, a second -f an operator adds for a tool run
// from a checkout.
//
// The file is PARSED, not scanned. Three review passes each found a spelling
// the text walk before this did not read — an item at another indentation, a
// `ports:` block carried in through an anchor and `<<:` merge key, a quoted
// `"ports":` key — and each time compose rendered the mapping with no host_ip
// while the check passed; a walk over YAML text is not a YAML reader, and the
// fourth spelling would have been found by the next pass. Bun.YAML.parse
// (Bun 1.2+; CI and the images pin the one version check 33 holds) resolves anchors, aliases and
// merge keys (quoted or bare — a probe found no spelling it leaves unfolded),
// normalises key spellings, reads flow and block sequences alike and refuses
// tabs, so what this rule sees is what compose sees — with two exceptions it
// refuses by name, because they reach outside the file: a service's
// `extends:` and a top-level `include:`, each of which imports a service body
// from a file the rule does not open; and `network_mode:`, which with the
// value `host` puts a service on the host's interfaces with no `ports:` at
// all (the third pass's one hole in the definition). Under node, which has no
// Bun.YAML, the rule fails in words rather than passing. The fourth pass added
// the file operators copy, since that file, not compose.yaml's fallback, is the
// default of every stack brought up from it: a live `X_BIND=` line there could
// say only 127.0.0.1. SMD-2685 replaced that with a hold of every live line,
// each exactly `KEY=` for one of ENV_EXAMPLE_LIVE's keys, and refuses a tracked
// .env and two mappings in one stack on a knob or a default host port.
//
// Two rules on the ports. The first, per service: `ports` is a list whose every item is the
// short form — no host address (fewer than three fields), an address but not
// the form (a literal address or port, a `/tcp` suffix, a knob not named
// `_BIND`), a default other than the literal `127.0.0.1` (smoke.sh and the CI
// step dial it), a knob `.env.example` does not document, and the long form
// (an object) are each refused in their own words. The second is an
// inventory: PUBLISHES names which service publishes from which compose file,
// one mapping each, and a file's readable mappings must equal its entry — so
// a mapping that is gone, or refused above, fails as MISSING too, a new file
// or service that publishes fails as UNLISTED until named here deliberately
// (with its row in deploy/README.md), and the overlay must exist. Only files
// named as compose names them (`compose*.yaml`, `docker-compose*.yml`) are
// read: SMD-1849's collector configuration under deploy/ is not a stack.

/** One knob line of deploy/.env.example: the name and its line. */
type EnvKnob = { name: string; line: number };
/**
 * The knobs deploy/.env.example documents whose names match `pattern`: one
 * entry per knob line, live or commented out (most ship commented out
 * precisely because they have a default), with an optional trailing `#`
 * comment — so `# OB1_EMBEDDING_DIM=1536   # hosted` counts and the prose line
 * `# SERVER_BIND=0.0.0.0 is the one an operator sets…` does not. Null, after a
 * failure in words, when the file is missing; both readers stop there rather
 * than throw. Check 13 and the compose-forwards check read the file through
 * this, so what counts as a documented line is decided once.
 */
function envKnobsIn(text: string, pattern: RegExp) {
  const knobs: EnvKnob[] = [];
  // Same-line whitespace only: a `\s*` here once ate the newline and the next
  // knob line as this one's trailing comment, and POSTGRES_BIND went undocumented.
  for (const m of text.matchAll(/^#?[ \t]*([A-Z0-9_]+)=\S*[ \t]*(?:#.*)?$/gm)) {
    if (pattern.test(m[1])) knobs.push({ name: m[1], line: text.slice(0, m.index).split("\n").length });
  }
  return knobs;
}
const ENV_KNOB_PROBES: [string, RegExp, string[]][] = [
  // [text, pattern, expected names]
  ["# A_BIND=127.0.0.1\n# B_BIND=127.0.0.1\n# C_BIND=127.0.0.1\n", /_BIND$/, ["A_BIND", "B_BIND", "C_BIND"]],
  ["# OB1_X=1536   # hosted; unmeasured\nOB1_Y=\n", /^OB1_/, ["OB1_X", "OB1_Y"]],
  ["# SERVER_BIND=0.0.0.0 is the one an operator sets\n# SERVER_BIND=127.0.0.1\n", /_BIND$/, ["SERVER_BIND"]],
];
let envExampleMissingReported = false; // documentedEnvKnobs reports the missing file once, for its two callers
function documentedEnvKnobs(pattern: RegExp) {
  for (const [text, pat, names] of ENV_KNOB_PROBES) {
    const got = envKnobsIn(text, pat).map((k) => k.name);
    if (JSON.stringify(got) !== JSON.stringify(names)) fail(SELF, `env-knob reader no longer reports exactly ${JSON.stringify(names)} for its probe (reported ${JSON.stringify(got)}): ${JSON.stringify(text)}`);
  }
  const path = join(ROOT, "deploy", ".env.example");
  if (!existsSync(path)) {
    if (!envExampleMissingReported) fail("deploy/.env.example", `missing — the documented knobs are read from it (check 13's _BIND knobs, check 14's OB1_* settings), and SETUP.md tells every operator to copy it`);
    envExampleMissingReported = true;
    return null;
  }
  return envKnobsIn(readFileSync(path, "utf8"), pattern);
}

/** compose file under deploy/ → the services that publish one mapping each from it. */
const PUBLISHES: Record<string, string[]> = {
  // The forwarder, in front of the stack's one origin (SMD-1846, SMD-2583):
  // the proxy behind it is on internal networks alone and the server is
  // `/mcp` on it, neither publishing; the break-glass listener under the auth
  // profile (SMD-3307), on a literal 127.0.0.1 (LOOPBACK_MAPPINGS); and n8n
  // under `--profile orchestration` (SMD-2210): its editor, API, webhooks and
  // MCP endpoint on loopback, for the provisioning step and an AI client on
  // this host.
  "compose.yaml": ["forwarder", "breakglass", "n8n"],
  "compose.host-ports.yaml": ["postgres", "ollama", "jev"],
  "compose.grafana-port.yaml": ["lgtm"],
};
const COMPOSE_FILE = /^(docker-)?compose.*\.ya?ml$/;

/**
 * The named exceptions to the house form: a service whose one mapping is on a literal 127.0.0.1, with no `_BIND`
 * knob a deploy/.env could widen — [the mapping, its documented `_PORT` knob, its default port]. The break-glass
 * listener (SMD-3307; ADR decision 15) is the operator's way in while the authorization server is down, key
 * sign-in to the GUI, so loopback alone is its whole point: a `BREAKGLASS_BIND=0.0.0.0` would offer key sign-in
 * on the network, the weaker door the configured origin closes.
 */
const LOOPBACK_MAPPINGS: Record<string, [string, string, string]> = {
  breakglass: ["127.0.0.1:${BREAKGLASS_PORT:-8001}:8001", "BREAKGLASS_PORT", "8001"],
};
/** The house form: the host port is the bind knob's own `_PORT` knob, so no mapping publishes on another's (SMD-2685: jev on `${SERVER_PORT}` would bind the proxy's port first and take its clients' keys). */
const PORT_ITEM = /^\$\{([A-Z0-9_]+)_BIND:-([^}]*)\}:\$\{\1_PORT:-([1-9]\d*)\}:\d+$/;
/** Colon-separated fields of a short-form mapping, `${…}` contents not counted. */
function portFields(v: string) {
  let depth = 0, n = 1;
  for (const ch of v) { if (ch === "{") depth++; else if (ch === "}") depth--; else if (ch === ":" && depth === 0) n++; }
  return n;
}
/** 1-based line of the first non-comment line containing `needle`, for the report; 0 if none. */
function lineOf(text: string, needle: string) {
  const i = text.split("\n").findIndex((l) => !/^\s*#/.test(l) && l.replace(/\s+#.*$/, "").includes(needle));
  return i < 0 ? 0 : i + 1;
}

/** What Bun.YAML.parse yields, spelled out: a mapping is a record of unknowns, a sequence an array, anything else a scalar or null — the readers narrow it by typeof / Array.isArray, as they always did. */
type YamlValue = Record<string, unknown> | unknown[] | string | number | boolean | null;
/** One check-13 gap: `[kind, service, line, detail]` — service null when the file as a whole is at fault, line 0 when none applies. */
type PortGap = [kind: string, service: string | null, line: number, detail: string];
/**
 * One compose file's published ports: `{ gaps: [[kind, service, line, detail]],
 * published: [service, …] }` — `published` lists a service once per house-form
 * mapping, for the inventory.
 */
function publishedPortGapsIn(text: string, { documented }: { documented: Set<string> | null }): { gaps: PortGap[]; published: string[]; knobs: [service: string, prefix: string, port: string][] } {
  const gaps: PortGap[] = [], published: string[] = [], knobs: [string, string, string][] = [];
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") return { gaps: [["no-parser", null, 0, ""]], published, knobs };
  let doc: YamlValue;
  try { doc = Bun.YAML.parse(text) as YamlValue; } catch (e) { return { gaps: [["unparseable", null, 0, String((e as Error).message ?? e)]], published, knobs }; }
  if (Array.isArray(doc)) return { gaps: [["not-a-mapping", null, 0, `a list of ${doc.length}`]], published, knobs };
  if (!doc || typeof doc !== "object" || !doc.services || typeof doc.services !== "object" || Array.isArray(doc.services)) {
    return { gaps: [["no-services", null, 0, ""]], published, knobs };
  }
  if ("include" in doc) gaps.push(["include", null, lineOf(text, "include"), ""]);
  for (const [service, def] of Object.entries(doc.services)) {
    const at = lineOf(text, `${service}:`) || lineOf(text, service);
    if (!def || typeof def !== "object" || Array.isArray(def)) { gaps.push(["unreadable", service, at, JSON.stringify(def)]); continue; }
    if ("extends" in def) gaps.push(["extends", service, lineOf(text, "extends"), JSON.stringify(def.extends)]);
    if ("network_mode" in def) gaps.push(["network-mode", service, lineOf(text, "network_mode"), String(def.network_mode)]);
    if (!("ports" in def)) continue;
    const ports = def.ports;
    if (!Array.isArray(ports)) { gaps.push(["ports-not-list", service, lineOf(text, "ports"), JSON.stringify(ports)]); continue; }
    if (ports.length === 0) gaps.push(["empty-ports", service, lineOf(text, "ports"), ""]);
    for (const item of ports) {
      if (item === null || typeof item === "object") { gaps.push(["long-form", service, lineOf(text, "target"), JSON.stringify(item)]); continue; }
      const v = String(item);
      const line = lineOf(text, v) || lineOf(text, "ports");
      if (portFields(v) < 3) { gaps.push(["no-address", service, line, v]); continue; }
      const literal = LOOPBACK_MAPPINGS[service];
      if (literal && v === literal[0]) {
        if (documented && !documented.has(literal[1])) gaps.push(["undocumented-knob", service, line, literal[1]]);
        else { published.push(service); knobs.push([service, literal[1].replace(/_PORT$/, ""), literal[2]]); }
        continue;
      }
      const m = PORT_ITEM.exec(v);
      if (!m) { gaps.push(["not-house-form", service, line, v]); continue; }
      if (m[2] !== "127.0.0.1") gaps.push(["default-not-loopback", service, line, `${m[1]}_BIND defaults to "${m[2]}"`]);
      else if (documented && !documented.has(`${m[1]}_BIND`)) gaps.push(["undocumented-knob", service, line, `${m[1]}_BIND`]);
      else { published.push(service); knobs.push([service, m[1], m[3]]); }
    }
  }
  return { gaps, published, knobs };
}

const GOOD = `"\${SERVER_BIND:-127.0.0.1}:\${SERVER_PORT:-8000}:8000"`;
const PORT_PROBES: [string, string[], string[]][] = [
  // [text, expected gap kinds, expected published services]
  [`services:\n  server:\n    ports:\n      - ${GOOD}\n`, [], ["server"]],
  // Spellings a parser makes one: quoting, indentation, a flow sequence, a quoted or spaced key, an alias, an anchored block merged in.
  [`services:\n  server:\n    ports:\n      - ${GOOD.replace(/"/g, "'")}\n`, [], ["server"]],
  [`services:\n  server:\n    ports:\n      - ${GOOD.replace(/"/g, "")}\n`, [], ["server"]],
  [`services:\n  server:\n    ports:\n        - ${GOOD}\n`, [], ["server"]],
  [`services:\n  server:\n    ports:\n    - ${GOOD}\n`, [], ["server"]],
  [`services:\n    server:\n        ports:\n            - ${GOOD}\n`, [], ["server"]],
  [`services:\n  server:\n    ports: [${GOOD}]\n`, [], ["server"]],
  [`services:\n  server:\n    "ports":\n      - ${GOOD}\n`, [], ["server"]],
  [`services:\n  server:\n    ports :\n      - ${GOOD}\n`, [], ["server"]],
  [`x-p: &p\n  - ${GOOD}\nservices:\n  server:\n    ports: *p\n`, [], ["server"]],
  [`x-open: &open\n  ports:\n    - ${GOOD}\nservices:\n  server:\n    <<: *open\n    image: x\n`, [], ["server"]],
  // …and the same spellings carrying a bare mapping are read, and refused.
  [`services:\n  server:\n    ports:\n        - "8000:8000"\n`, ["no-address"], []],
  [`services:\n  server:\n    "ports":\n      - "5432:5432"\n`, ["no-address"], []],
  [`x-open: &open\n  ports:\n    - "5432:5432"\nservices:\n  postgres:\n    <<: *open\n    image: x\n`, ["no-address"], []],
  [`services:\n  server:\n    ports: ["8000:8000"]\n`, ["no-address"], []],
  [`services:\n  server:\n    ports:\n      - "\${SERVER_PORT:-8000}:8000"\n`, ["no-address"], []],
  [`services:\n  server:\n    ports:\n      - 8000:8000\n`, ["no-address"], []],
  [`services:\n  server:\n    ports:\n      - "\${SERVER_BIND:-127.0.0.1}:8000:8000"\n`, ["not-house-form"], []],
  [`services:\n  server:\n    ports:\n      - "127.0.0.1:\${SERVER_PORT:-8000}:8000"\n`, ["not-house-form"], []],
  [`services:\n  server:\n    ports:\n      - ${GOOD.replace(/"$/, '/tcp"')}\n`, ["not-house-form"], []],
  [`services:\n  server:\n    ports:\n      - "\${SERVER_BIND:-0.0.0.0}:\${SERVER_PORT:-8000}:8000"\n`, ["default-not-loopback"], []],
  [`services:\n  server:\n    ports:\n      - "\${SERVER_BIND:-[::1]}:\${SERVER_PORT:-8000}:8000"\n`, ["default-not-loopback"], []],
  [`services:\n  server:\n    ports:\n      - target: 8000\n        published: 8000\n        host_ip: 127.0.0.1\n`, ["long-form"], []],
  [`services:\n  server:\n    ports: 8000\n`, ["ports-not-list"], []],
  [`services:\n  server:\n    ports: []\n`, ["empty-ports"], []],
  [`services:\n  server:\n    ports:\n      - "\${OTHER_BIND:-127.0.0.1}:\${OTHER_PORT:-8000}:8000"\n`, ["undocumented-knob"], []],
  [`services:\n  jev:\n    ports:\n      - "\${JEV_BIND:-127.0.0.1}:\${SERVER_PORT:-8000}:8020"\n`, ["not-house-form"], []],
  [`services:\n  jev:\n    ports:\n      - "\${JEV_BIND:-127.0.0.1}:\${JEV_PORT:-08000}:8020"\n`, ["not-house-form"], []],
  // The named loopback exception (LOOPBACK_MAPPINGS): the break-glass listener's literal, and no other spelling or service.
  [`services:\n  breakglass:\n    ports:\n      - "127.0.0.1:\${BREAKGLASS_PORT:-8001}:8001"\n`, [], ["breakglass"]],
  [`services:\n  breakglass:\n    ports:\n      - "0.0.0.0:\${BREAKGLASS_PORT:-8001}:8001"\n`, ["not-house-form"], []],
  [`services:\n  breakglass:\n    ports:\n      - "\${BREAKGLASS_BIND:-127.0.0.1}:\${BREAKGLASS_PORT:-8001}:8001"\n`, ["undocumented-knob"], []],
  [`services:\n  forwarder:\n    ports:\n      - "127.0.0.1:\${BREAKGLASS_PORT:-8001}:8001"\n`, ["not-house-form"], []],
  // What reaches outside the file, or the host, without a ports: item.
  [`services:\n  postgres:\n    extends:\n      file: base/pg.yaml\n      service: pg\n`, ["extends"], []],
  [`include:\n  - other.yaml\nservices:\n  server:\n    ports:\n      - ${GOOD}\n`, ["include"], ["server"]],
  [`services:\n  postgres:\n    network_mode: host\n`, ["network-mode"], []],
  [`services:\n  server:\n    network_mode: host\n    ports:\n      - ${GOOD}\n`, ["network-mode"], ["server"]],
  // What is not a stack this rule can read.
  [`services:\n  server:\n\tports:\n`, ["unparseable"], []],
  [`services:\n  - server\n`, ["no-services"], []],
  [`services:\n  server: x\n`, ["unreadable"], []],
  [`version: "3"\n`, ["no-services"], []],
  [`a: 1\n---\nb: 2\n`, ["not-a-mapping"], []],
  [`- a\n- b\n`, ["not-a-mapping"], []],
  // Two items are two mappings; a second service is read after the first; comments are not mappings.
  [`services:\n  server:\n    ports:\n      - ${GOOD}\n      - "9000:9000"\n  postgres:\n    ports:\n      # - "5432:5432"\n      - "\${POSTGRES_BIND:-127.0.0.1}:\${POSTGRES_PORT:-5432}:5432"  # loopback\n`, ["no-address"], ["server", "postgres"]],
  // A ports: key under a top-level block nothing merges into publishes nothing.
  [`services:\n  server:\n    image: x\nvolumes:\n  ports:\n      - "8000:8000"\n`, [], []],
];

/** The keys deploy/.env.example sets on a live line, each written `KEY=` with nothing after it: the ones an operator fills in. Any other setting there is commented. */
const ENV_EXAMPLE_LIVE = ["POSTGRES_PASSWORD", "MCP_ACCESS_KEYS", "OB1_FORWARDER_KEY", "OPENROUTER_API_KEY"];
/** Each line of an env file that is neither blank, a comment (`#` after spaces or tabs alone), nor exactly `KEY=` for one of ENV_EXAMPLE_LIVE's keys, as [line, text]. Exactly, because compose's dotenv reader goes on after a closing quote (`MCP_ACCESS_KEYS="" COMPOSE_FILE=…` sets both, and a quoted value runs on over a line that reads as a comment: SMD-2685 review pass 4), and reads `export KEY=` and `KEY: value` too; with no value on a live line, no quote opens. */
function envExampleLive(text: string): [number, string][] {
  return text.split("\n").flatMap((l, i): [number, string][] => /^([ \t]*#.*|)$/.test(l) || ENV_EXAMPLE_LIVE.some((k) => l === `${k}=`) ? [] : [[i + 1, l]]);
}
const ENV_EXAMPLE_PROBES: [string, string, number][] = [
  ["the keys an operator fills in, and comments", "POSTGRES_PASSWORD=\n# SERVER_PORT=8000\n\t# indented\n\nMCP_ACCESS_KEYS=\n", 0],
  ["the project renamed", "POSTGRES_PASSWORD=\nCOMPOSE_PROJECT_NAME=open-brain-two\n", 1],
  ["a compose file added by export", "export COMPOSE_FILE=compose.yaml:ob1-local.yaml\n", 1],
  ["jev on the proxy's port, spaced", "JEV_PORT = 8000\n", 1],
  ["a second key after a quoted held one (SMD-2685 review pass 4, measured)", "MCP_ACCESS_KEYS=\"\" COMPOSE_PROJECT_NAME=open-brain-two\n", 1],
  ["a second key after a single-quoted held one, unspaced", "POSTGRES_PASSWORD='x'JEV_PORT=8000\n", 1],
  ["a quoted held value running on over a line that reads as a comment (SMD-2685 review pass 4, measured)", "POSTGRES_PASSWORD=\"\n# put the password between the quotes\" JEV_PORT=8000\n", 1],
  ["a held key exported", "export POSTGRES_PASSWORD=\n", 1],
  ["a held key with a value", "OPENROUTER_API_KEY=sk-placeholder\n", 1],
  ["a held key ending in a carriage return", "POSTGRES_PASSWORD=\r\n", 1],
  ["a comment led by a no-break space", "\u00a0# COMPOSE_PROJECT_NAME=x\n", 1],
];

function checkPublishedPorts() {
  // The _BIND knobs, and the _PORT knob of each named loopback exception, which has no _BIND.
  const knobs = documentedEnvKnobs(new RegExp(`_BIND$|^(${Object.values(LOOPBACK_MAPPINGS).map(([, k]) => k).join("|")})$`));
  if (knobs === null) return;
  const documented = new Set(knobs.map((k) => k.name));
  // The file every operator copies to deploy/.env: a live line there is a setting every stack brought up from it runs with, whatever compose.yaml's fallback says, and no check renders it (CI writes its own .env). A live _BIND line put the stack on the network (SMD-1844); a COMPOSE_PROJECT_NAME there renames the project, a COMPOSE_FILE adds a file no check reads, a _PORT moves a mapping onto another's port (SMD-2685 review pass 3). So the live lines are exactly the keys an operator must fill in.
  for (const [what, text, n] of ENV_EXAMPLE_PROBES) if (envExampleLive(text).length !== n) fail(SELF, `check 13's .env.example rule no longer finds ${n} stray line${n === 1 ? "" : "s"} in its probe: ${what}`);
  for (const [line, text] of envExampleLive(readFileSync(join(ROOT, "deploy", ".env.example"), "utf8"))) fail(`deploy/.env.example:${line}`, `a live line reads ${JSON.stringify(text.slice(0, 80))}, where the live lines are exactly ${ENV_EXAMPLE_LIVE.map((k) => `\`${k}=\``).join(", ")} — every stack brought up from a copy of this file runs with what it sets and no check renders it: a COMPOSE_* setting renames the project or adds a compose file, a _PORT moves a mapping onto another's port, and compose reads a second setting after a quoted value; leave it commented, or, for a key every operator must fill in, add it to check 13's ENV_EXAMPLE_LIVE (SMD-2685)`);
  // …and the file compose reads itself is never tracked: a committed deploy/.env reaches every stack run with no --env-file (a COMPOSE_FILE in it names a file no check reads), and `git pull` writes it over an operator's own, which git ignores (SMD-2685 review pass 5, measured). Any case, since macOS opens .ENV as .env.
  let tracked: string[] | null = null;
  try { tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: Infinity }).split("\0"); } catch (e) { console.warn(`  (git ls-files failed — ${(e as Error).message.split("\n")[0]} — so check 13 cannot tell a committed .env from an operator's own, and skips that rule)`); }
  for (const f of tracked ?? []) if (/^\.env$/i.test(f.split("/").at(-1) ?? "")) fail(f, "is a tracked .env — compose reads it with no --env-file, so what it sets (a COMPOSE_FILE naming a file no check reads, a port) reaches every stack run from here unrendered, and `git pull` writes it over an operator's own; untrack it (`git rm --cached`) and keep settings in .env.example (SMD-2685)");
    else if (/^\.env.|\.env$|\.env\./i.test(f.split("/").at(-1) ?? "") && !/\.(example|sample|template)$/i.test(f)) fail(f, "is a tracked env file — one env file is one brain (SMD-2873): a brain's own (.env.<name>.local), a canary's (.env.canary.local, .env.<stable>-canary.local), the temporary file deploy/canary.sh makes one in, and any other env file hold a database password or keys, and `git pull` writes it over the operator's own; untrack it (`git rm --cached`) and name a brain's .env.<name>.local, which the root .gitignore ignores, or an example .example, .sample or .template (SMD-2583, SMD-2873)");
  // One env file is one brain (SMD-2873): canary.sh and tier.sh read the project from it, through a stub
  // carrying compose.yaml's own `name:`, on one code line that reads an env file; no other code line names
  // open-brain but the few each script is allowed (a fixed default, in any of bash's forms, is one).
  {
    let name: string | undefined;
    try { name = (Bun.YAML.parse(readFileSync(join(ROOT, "deploy", "compose.yaml"), "utf8")) as { name?: unknown }).name as string | undefined; } catch { name = undefined; }
    if (typeof name !== "string" || !name) fail("deploy/compose.yaml", "has no top-level `name:` Bun.YAML reads, which deploy/canary.sh and deploy/tier.sh fall back to (SMD-2873)");
    else {
      const allowed: Record<string, RegExp[]> = {
        "canary.sh": [/\[ "\$CANARY" = open-brain-canary \]/g, /compose\.yaml's default \(open-brain\)/g, /compose\.yaml's open-brain"/g],
        "tier.sh": [/\bopen-brain-tier(-env)?\b/g, /compose\.yaml's open-brain"/g],
      };
      const composeName: string = name;
      for (const [script, ok] of Object.entries(allowed)) {
        // The code part of each line: a trailing ` # …` comment is no code, and must not carry an allowed word past the check.
        const lines = readFileSync(join(ROOT, "deploy", script), "utf8").split("\n").map((l, i) => [i + 1, l.replace(/\s#.*$/, "")] as const).filter(([, l]) => !/^\s*(#|$)/.test(l));
        const stub: string = `printf 'name: ${composeName}\\nservices: {}\\n'`;
        const stubs = lines.filter(([, l]) => l.includes(stub));
        if (stubs.length !== 1 || !/--env-file/.test(stubs[0][1])) fail(`deploy/${script}`, `reads the stack's project through compose with a stub carrying compose.yaml's \`name: ${name}\` (${stub}) on exactly one code line, which reads an env file (--env-file), so its fallback is the project compose.yaml names (found on ${stubs.length}) (SMD-2873)`);
        // Each allowed text, and the stub, is taken out of the code; the name must then be gone.
        for (const [n, l] of lines) if (ok.reduce((s, r) => s.replace(r, ""), l.split(stub).join("")).includes(name)) fail(`deploy/${script}:${n}`, `names ${name} outside the project read (${JSON.stringify(l.trim().slice(0, 80))}): the project follows the env file, and compose.yaml's name is the read's fallback alone (SMD-2873)`);
      }
    }
  }
  const probeDocs = new Set(["SERVER_BIND", "POSTGRES_BIND", "BREAKGLASS_PORT"]);
  for (const [text, kinds, services] of PORT_PROBES) {
    const got = publishedPortGapsIn(text, { documented: probeDocs });
    const gotKinds = got.gaps.map((g) => g[0]);
    if (gotKinds.length === 1 && gotKinds[0] === "no-parser") break; // reported once, below
    if (JSON.stringify(gotKinds) !== JSON.stringify(kinds) || JSON.stringify(got.published) !== JSON.stringify(services)) {
      fail(SELF, `published-port rule no longer reports exactly ${JSON.stringify(kinds)} / ${JSON.stringify(services)} for its probe (reported ${JSON.stringify(gotKinds)} / ${JSON.stringify(got.published)}): ${JSON.stringify(text)}`);
    }
  }

  const dir = join(ROOT, "deploy");
  const files = readdirSync(dir).filter((f) => COMPOSE_FILE.test(f) && statSync(join(dir, f)).isFile()).sort();
  for (const name of Object.keys(PUBLISHES)) {
    if (!files.includes(name)) fail(`deploy/${name}`, `missing — PUBLISHES in ${SELF} says ${PUBLISHES[name].map((s) => `\`${s}\``).join(" and ")} publish from it (SMD-1844)`);
  }
  const HOUSE = "`\"${X_BIND:-127.0.0.1}:${X_PORT:-n}:n\"`";
  for (const [what, entries, n] of PORT_CLASH_PROBES) if (portClashes(entries).length !== n) fail(SELF, `check 13's port-clash rule no longer finds ${n} clash${n === 1 ? "" : "es"} in its probe: ${what}`);
  const stack: [string, string, string, string][] = [];
  for (const name of files) {
    const rel = `deploy/${name}`;
    const { gaps, published, knobs: fileKnobs } = publishedPortGapsIn(readFileSync(join(dir, name), "utf8"), { documented });
    for (const [service, prefix, port] of fileKnobs) stack.push([name, service, prefix, port]);
    for (const [kind, service, line, detail] of gaps) {
      const at = line ? `${rel}:${line}` : rel;
      const svc = service ? `service \`${service}\`` : "the file";
      const knob = `${(service || "X").toUpperCase().replace(/-/g, "_")}_BIND`;
      switch (kind) {
        case "no-parser": fail(SELF, `check 13 parses compose files with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-1844)`); return;
        case "unparseable": fail(rel, `does not parse as YAML: ${detail} (SMD-1844)`); break;
        case "not-a-mapping": fail(rel, `parses to ${detail}, not a mapping — several documents, or a root sequence; a compose file is one mapping (SMD-1844)`); break;
        case "no-services": fail(rel, `has no top-level \`services:\` mapping — every compose*.yaml under deploy/ is a stack this rule reads (SMD-1844)`); break;
        case "include": fail(at, `a top-level \`include:\` imports services from a file this rule does not open — put the services in this file (SMD-1844)`); break;
        case "extends": fail(at, `${svc} \`extends\` ${detail} — a service body this rule does not follow (another file, or a sibling whose \`ports:\` the child would inherit uncounted); write the service out (SMD-1844)`); break;
        case "network-mode": fail(at, `${svc} sets \`network_mode: ${detail}\` — refused whatever the value: \`host\` puts the service on the host's interfaces with no \`ports:\` at all, and the stack needs no mode but the default network; remove it (SMD-1844)`); break;
        case "unreadable": fail(at, `${svc} is ${detail}, not a mapping (SMD-1844)`); break;
        case "ports-not-list": fail(at, `${svc} has \`ports: ${detail}\`, not a list (SMD-1844)`); break;
        case "empty-ports": fail(at, `${svc} has an empty \`ports:\` list (SMD-1844)`); break;
        case "long-form": fail(at, `${svc} publishes ${detail} in the long form — use the short form ${HOUSE}, the one shape this rule and the README teach (SMD-1844)`); break;
        case "no-address": fail(at, `${svc} publishes \`${detail}\` with no host address — compose binds that to 0.0.0.0, every interface; write ${HOUSE} with \`${knob}\` and document the knob in deploy/.env.example (SMD-1844)`); break;
        case "not-house-form": fail(at, `${svc} publishes \`${detail}\`, which names an address but is not the house form ${HOUSE} — the knob must end in _BIND, the host port must be the same knob's \`_PORT\` (smoke.sh and the CI step read SERVER_PORT; a mapping on another's knob publishes on its port, SMD-2685) with a default written plainly (compose reads 08000 as 8000), and no suffix (SMD-1844)`); break;
        case "default-not-loopback": fail(at, `${svc}: ${detail} — the default is the literal 127.0.0.1, which smoke.sh and the CI step dial; an operator who wants another address sets the knob (SMD-1844)`); break;
        case "undocumented-knob": fail(at, `${svc} reads \`${detail}\`, which deploy/.env.example does not document — an operator cannot find the knob that opens the port (SMD-1844)`); break;
        default: throw new Error(`check 13: no message for kind ${kind}`);
      }
    }
    const expected = PUBLISHES[name] ?? [];
    for (const service of expected) {
      if (!published.includes(service)) fail(rel, `publishes no house-form mapping for service \`${service}\`, and PUBLISHES in ${SELF} says it does — the port is gone, or refused above (SMD-1844)`);
    }
    for (const service of new Set(published)) {
      const n = published.filter((s) => s === service).length;
      if (!expected.includes(service) || n > 1) fail(rel, `service \`${service}\` publishes ${n} mapping${n === 1 ? "" : "s"} from this file and PUBLISHES in ${SELF} lists ${expected.includes(service) ? "one" : "none"} — ${name === "compose.yaml" ? "the base file publishes the proxy (a service behind it is a router in x-proxy-routes, not a port, SMD-1846), and n8n under the orchestration profile; the database and Ollama publish through compose.host-ports.yaml, a second -f, and " : ""}a new published port is named in PUBLISHES deliberately, with its row in deploy/README.md's "What is reachable from where" (SMD-1844)`);
    }
  }
  for (const clash of portClashes(stack)) fail("deploy/", `${clash} (SMD-2685)`);
}

/** Where two mappings in compose.yaml and its overlays, which run as one stack, share a knob or a default host port: [file, service, knob prefix, default port] each. Whichever binds first takes the other's clients — the proxy's port taken by jev, which starts before it, would take every MCP client's key (SMD-2685). */
function portClashes(entries: [string, string, string, string][]): string[] {
  const out: string[] = [];
  for (const [i, by] of [[2, "knob"], [3, "default host port"]] as const) {
    const seen = new Map<string, string>();
    for (const e of entries) {
      const at = `${e[0]}'s ${e[1]}`;
      const other = seen.get(e[i]);
      if (other) out.push(`${at} publishes on the ${by} ${i === 2 ? `${e[i]}_BIND/${e[i]}_PORT` : e[i]} that ${other} does — each mapping has a knob and a default port of its own, or the first to bind takes the other's clients`);
      else seen.set(e[i], at);
    }
  }
  return out;
}
const PORT_CLASH_PROBES: [string, [string, string, string, string][], number][] = [
  ["two services, two knobs, two ports", [["compose.yaml", "proxy", "SERVER", "8000"], ["compose.host-ports.yaml", "jev", "JEV", "8020"]], 0],
  ["jev on the proxy's knob", [["compose.yaml", "proxy", "SERVER", "8000"], ["compose.host-ports.yaml", "jev", "SERVER", "8020"]], 1],
  ["jev on its own knob, defaulting to the proxy's port", [["compose.yaml", "proxy", "SERVER", "8000"], ["compose.host-ports.yaml", "jev", "JEV", "8000"]], 1],
];

// ── Run ──────────────────────────────────────────────────────────────────────

const dirs = contributionDirs(ROOT);
for (const d of dirs) {
  const meta = checkMetadata(d);
  checkLinks(d);
  checkDeps(meta, d);
}
checkSqlGuards();
await checkMigrationNumbers();
checkShellHazards(dirs);
checkCoreFunctions();
checkCredentialCompares();
checkThoughtWritesAround();
checkBunNative();
checkSupabaseIsms();
checkPublishedPorts();

/**
 * The embedding default is stated in three places that must agree, and two of them
 * silently win over the third. Compose substitutes `${VAR:-fallback}` before the
 * process starts, so a stale fallback in compose.yaml overrides db/config.mjs
 * rather than deferring to it — the configuration would look right in the source
 * and be wrong in the container, which is the failure mode this whole fork keeps
 * trying to make loud.
 */
async function checkEmbeddingDefaults() {
  const cfg = await import("../db/config.mjs");
  const compose = readFileSync(join(ROOT, "deploy", "compose.yaml"), "utf8");

  const dims = [...compose.matchAll(/OB1_EMBEDDING_DIM:\s*\$\{OB1_EMBEDDING_DIM:-(\d+)\}/g)].map((m) => Number(m[1]));
  const models = [...compose.matchAll(/OB1_EMBEDDING_MODEL:\s*\$\{OB1_EMBEDDING_MODEL:-([^}]+)\}/g)].map((m) => m[1].trim());

  for (const d of dims) {
    if (d !== cfg.DEFAULT_EMBEDDING_DIM) {
      violations.push({
        where: "deploy/compose.yaml",
        msg: `OB1_EMBEDDING_DIM fallback ${d} does not match db/config.mjs DEFAULT_EMBEDDING_DIM ${cfg.DEFAULT_EMBEDDING_DIM}`,
      });
    }
  }
  for (const m of models) {
    if (m !== cfg.DEFAULT_EMBEDDING_MODEL) {
      violations.push({
        where: "deploy/compose.yaml",
        msg: `OB1_EMBEDDING_MODEL fallback "${m}" does not match db/config.mjs DEFAULT_EMBEDDING_MODEL "${cfg.DEFAULT_EMBEDDING_MODEL}"`,
      });
    }
  }

  const metas = [...compose.matchAll(/OB1_METADATA_MODEL:-([^}]+)\}/g)].map((m) => m[1].trim());
  for (const m of metas) {
    if (m !== cfg.DEFAULT_METADATA_MODEL) {
      violations.push({
        where: "deploy/compose.yaml",
        msg: `OB1_METADATA_MODEL fallback "${m}" does not match db/config.mjs DEFAULT_METADATA_MODEL "${cfg.DEFAULT_METADATA_MODEL}"`,
      });
    }
  }

  // The three provider-facing defaults move together or not at all. A local model
  // name sent to a hosted endpoint is a 404 per capture — fatal for the embedding
  // call, silent for the metadata one. Both halves of that have already shipped
  // here once.
  const hostedModel = (n: string) => n.includes("/");
  const localBase = /(^|\/\/)(127\.0\.0\.1|localhost|ollama|host\.(docker|containers)\.internal)/.test(
    cfg.DEFAULT_LLM_BASE_URL
  );
  if (hostedModel(cfg.DEFAULT_EMBEDDING_MODEL) !== hostedModel(cfg.DEFAULT_METADATA_MODEL)) {
    violations.push({
      where: "db/config.mjs",
      msg: `default embedding model "${cfg.DEFAULT_EMBEDDING_MODEL}" and metadata model ` +
           `"${cfg.DEFAULT_METADATA_MODEL}" target different providers; one is hosted and one is local`,
    });
  }
  if (hostedModel(cfg.DEFAULT_EMBEDDING_MODEL) === localBase) {
    violations.push({
      where: "db/config.mjs",
      msg: `DEFAULT_LLM_BASE_URL "${cfg.DEFAULT_LLM_BASE_URL}" does not match the model defaults ` +
           `("${cfg.DEFAULT_EMBEDDING_MODEL}"); a local model name sent to a hosted endpoint 404s on every capture`,
    });
  }

  // A default the schema cannot index would be caught at migrate time, but only
  // by whoever ran it. Catching it here means it never lands.
  const problems = cfg.validateEmbeddingConfig(cfg.DEFAULT_EMBEDDING_DIM, cfg.DEFAULT_EMBEDDING_MODEL, cfg.EMBEDDING_DIMENSIONS);
  for (const p of problems) violations.push({ where: "db/config.mjs", msg: `default configuration is not usable: ${p}` });
}
await checkEmbeddingDefaults();

/**
 * SMD-1471: the "Grants for a capturing role" table must spell each object's
 * PRIVILEGES to match ROLE_GRANTS, per group — an object can carry a different
 * set in two groups (`ob1_config`, `thought_audit`), so a name-only check would
 * miss a drifted privilege. Read the rows in order, tracking the group from the
 * bold cell that leads each group's first row, and compare both ways: every
 * ROLE_GRANTS row must be documented with its privileges, and every documented
 * object (the backticked names at the head of a cell, before the parenthesis or
 * em dash that opens the prose) must be granted in that group (SMD-1298's third
 * review pass: a config row could be deleted with the docs still claiming it).
 * Pure: the section's text and the grant rows in, the violation messages out,
 * so GRANTS_PROBES can run it on tables written for the purpose.
 */
export type GrantRow = { group: string; kind: string; name: string; privileges: readonly string[] };
export function grantsDrift(section: string, rows: readonly GrantRow[]): string[] {
  const out: string[] = [];
  const rowLines = section.split("\n").filter((l) => l.trimStart().startsWith("|"));
  const documentedPrivs = new Map<string, Set<string>>(); // `${group}\t${name}` -> Set(privileges)
  const documentedHead = new Set<string>(); // `${group}\t${name}` for the names at the head of an object cell
  let group: string | null = null;
  for (const line of rowLines) {
    // A pipe-led, pipe-tailed row splits to ['', groupCell, objectCell, privCell, '']
    // — the leading `**word**` names a group and carries to the rows below it.
    const cells = line.split("|").map((c) => c.trim());
    const gm = /\*\*(\w+)\*\*/.exec(cells[1] ?? "");
    if (gm) group = gm[1];
    if (!group || cells.length < 4) continue; // the header and its `---` separator
    // The privileges are one backticked, comma-separated span at the head of
    // the cell; prose may follow after an em-dash, so read only that span.
    const pm = /`([^`]+)`/.exec(cells[3] ?? "");
    const privs = new Set(pm ? pm[1].split(",").map((p) => p.trim()).filter(Boolean) : []);
    // Every backticked object name in the object cell shares this row's
    // privileges (a community row lists several tables at once). Stray
    // backticked prose (`BIGSERIAL`) becomes a key nothing looks up.
    for (const m of (cells[2] ?? "").matchAll(/`([^`]+)`/g)) documentedPrivs.set(`${group}\t${m[1]}`, privs);
    // Every backticked name before the first em dash, with every balanced
    // parenthetical removed first — a cut at the first parenthesis saw only
    // the first of several tables (seventh review pass), and an optional
    // parenthetical after each name still lost a table behind an em dash inside
    // one, and read a `thoughts` inside one as a table (eighth review pass).
    // The backticked spans are masked first, so a function's own signature
    // (`f(uuid, jsonb)`) is not a parenthetical.
    const spans: string[] = [];
    let head = (cells[2] ?? "").replace(/`[^`]+`/g, (m) => `\u0000${spans.push(m) - 1}\u0000`);
    for (let stripped; (stripped = head.replace(/\([^()]*\)/g, "")) !== head;) head = stripped;
    head = head.replace(/\u0000(\d+)\u0000/g, (_, i: string) => spans[Number(i)] ?? "");
    for (const m of head.split(" — ")[0].matchAll(/`([^`]+)`/g)) documentedHead.add(`${group}\t${m[1]}`);
  }
  for (const { group: g, kind, name, privileges } of rows) {
    const documented = documentedPrivs.get(`${g}\t${name}`);
    if (!documented) {
      // The name check fires when the object is absent everywhere; this fires
      // when it is present but not in this group's row.
      out.push(`"Grants for a capturing role" has no **${g}** row for the ${kind} \`${name}\` that db/config.mjs's ROLE_GRANTS grants in that group — the table and ROLE_GRANTS have drifted (SMD-1471)`);
      continue;
    }
    const missing = privileges.filter((p) => !documented.has(p));
    const extra = [...documented].filter((p) => !privileges.includes(p));
    if (missing.length || extra.length) {
      out.push(`the **${g}** row for \`${name}\` lists [${[...documented].join(", ")}] but ROLE_GRANTS grants [${privileges.join(", ")}]${missing.length ? `; the README is missing ${missing.join(", ")}` : ""}${extra.length ? `; the README has extra ${extra.join(", ")}` : ""} — a role would be short or over a privilege the docs claim (SMD-1471)`);
    }
  }
  const granted = new Set(rows.map(({ group: g, name }) => `${g}\t${name}`));
  for (const key of documentedHead) {
    const [g, name = ""] = key.split("\t");
    if (!/^[a-z_][a-z0-9_]*(?:\([^)]*\))?$/.test(name) || granted.has(key)) continue; // a table, or a function with its signature
    out.push(`"Grants for a capturing role" has a **${g}** row for \`${name}\` that db/config.mjs's ROLE_GRANTS does not grant in that group — a privilege the docs claim and no role gets (SMD-1471, SMD-1298)`);
  }
  return out;
}
/** grantsDrift's own negative and positive tests: [table, rows, the number of violations, why]. */
const GRANTS_TABLE = [
  "| Group | Object | Privileges |", "| --- | --- | --- |",
  "| **capture** — the server | `thoughts` (001) | `SELECT, INSERT` |",
  "| | `thought_audit` (008) | `INSERT` |",
  "| **server** — extras | `thought_audit` (008) | `SELECT` — a capture key's supersedes is checked here |",
  "| | function `resolve_agent(text, text, text)` (010) | `EXECUTE` |",
  "| **community** — schemas | `ingestion_jobs` (schemas/x — a `thoughts` column) | `SELECT, INSERT` |",
  "| | `ingestion_runs` (schemas/y), `ingestion_steps` (schemas/y) | `SELECT` |",
  "| | `t_view` (a view over `thoughts` — needs its own SELECT) | `SELECT` |",
  "| | `t_one` (schemas/z — jobs), `t_two` (schemas/z) | `SELECT` |",
  "| | functions `f_sig(uuid, jsonb)` (schemas/z; SECURITY DEFINER, `REVOKE`d `FROM PUBLIC`) | `EXECUTE` |",
].join("\n");
const GRANTS_ROWS: GrantRow[] = [
  { group: "capture", kind: "table", name: "thoughts", privileges: ["SELECT", "INSERT"] },
  { group: "capture", kind: "table", name: "thought_audit", privileges: ["INSERT"] },
  { group: "server", kind: "table", name: "thought_audit", privileges: ["SELECT"] },
  { group: "server", kind: "function", name: "resolve_agent(text, text, text)", privileges: ["EXECUTE"] },
  { group: "community", kind: "table", name: "ingestion_jobs", privileges: ["SELECT", "INSERT"] },
  { group: "community", kind: "table", name: "ingestion_runs", privileges: ["SELECT"] },
  { group: "community", kind: "table", name: "ingestion_steps", privileges: ["SELECT"] },
  { group: "community", kind: "table", name: "t_view", privileges: ["SELECT"] },
  { group: "community", kind: "table", name: "t_one", privileges: ["SELECT"] },
  { group: "community", kind: "table", name: "t_two", privileges: ["SELECT"] },
  { group: "community", kind: "function", name: "f_sig(uuid, jsonb)", privileges: ["EXECUTE"] },
];
const GRANTS_PROBES: [string, GrantRow[], number, string][] = [
  [GRANTS_TABLE, GRANTS_ROWS, 0, "a table that matches its rows is clean, a table named in a row's prose is not an object"],
  [GRANTS_TABLE, GRANTS_ROWS.filter((r) => !(r.group === "server" && r.name === "thought_audit")), 1, "a README row no group grants (the server thought_audit SELECT) is a violation — the reverse pass"],
  [GRANTS_TABLE, GRANTS_ROWS.filter((r) => r.kind !== "function"), 2, "a README function row no group grants is a violation too — both of them, the signature inside the backticks read whole"],
  [GRANTS_TABLE, [...GRANTS_ROWS, { group: "worker", kind: "table", name: "ob1_config", privileges: ["INSERT"] }], 1, "a config row with no README row is a violation"],
  [GRANTS_TABLE.replace("| | `thought_audit` (008) | `INSERT` |", "| | `thought_audit` (008) | `SELECT, INSERT` |"), GRANTS_ROWS, 1, "a privilege the README claims and the config does not grant is a violation"],
  [GRANTS_TABLE, GRANTS_ROWS.filter((r) => r.name !== "ingestion_steps"), 1, "the SECOND table of a multi-table cell, each with its own parenthetical, is read by the reverse pass too"],
];
for (const [table, rows, n, why] of GRANTS_PROBES) {
  const got = grantsDrift(table, rows);
  if (got.length !== n) fail(SELF, `grantsDrift probe "${why}": expected ${n} violation(s), got ${got.length}${got.length ? ` — ${got[0]}` : ""}`);
}

/**
 * db/README.md's "Grants for a capturing role" names every table db/config.mjs's
 * ROLE_GRANTS requires — and, since SMD-1796, every view, sequence and function the
 * community group adds — the two are one spelling (SMD-1226). Preflight's `write
 * privileges` check and `migrate.ts --grant` both read ROLE_GRANTS; the README is
 * the human list. An object added to a group in config without a line in the
 * README would leave a self-hoster's role short a privilege the docs never
 * mention. Matched in backticks, the doc's convention for a name, so `thoughts`
 * is not satisfied by `thought_chunks` merely containing it; a function is
 * matched with its argument types, as the row spells them.
 */
async function checkCapturingGrants() {
  const cfg = await import("../db/config.mjs");
  const readme = readFileSync(join(ROOT, "db", "README.md"), "utf8");
  const heading = /^#+\s+Grants for a capturing role\s*$/m.exec(readme);
  if (!heading) {
    violations.push({ where: "db/README.md", msg: 'no "Grants for a capturing role" section — db/config.mjs ROLE_GRANTS has no documented home (SMD-1226)' });
    return;
  }
  // Bound at the next level-2 heading, not any `#`-led line: the section holds a
  // ```bash fence, and a future `# comment` inside it would otherwise read as the
  // next heading and truncate the section (SMD-1226 review, L3).
  const rest = readme.slice(heading.index + heading[0].length);
  const next = /^##\s/m.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  // Match within the markdown table rows (pipe-led lines), not the section's
  // prose: a table named only in a paragraph would otherwise satisfy the check
  // even if its privilege row were deleted. The rows are where the grant lives.
  const tableRows = section.split("\n").filter((l) => l.trimStart().startsWith("|")).join("\n");
  for (const { kind, name } of cfg.grantedObjects()) {
    if (!tableRows.includes("`" + name + "`")) {
      violations.push({
        where: "db/README.md",
        msg: `"Grants for a capturing role" does not name the ${kind} \`${name}\`, which db/config.mjs's ROLE_GRANTS requires — the list and the docs have drifted (SMD-1226${kind === "table" ? "" : ", SMD-1796"})`,
      });
    }
  }
  for (const msg of grantsDrift(section, cfg.grantRows())) violations.push({ where: "db/README.md", msg });
}
await checkCapturingGrants();

/**
 * db/README.md documents every migration: 001–023 as rows in "## The
 * migrations", 024 onward as a "NNN change M" map pointing at FORK.md. Both were
 * kept by hand and drifted (SMD-1696 found the intro count off by one; a map
 * lags a new migration). This holds the two together: every file under
 * db/migrations/ is named exactly once across the table and the map, no
 * documented number lacks a file, and the "N migrations applied" count is the
 * file count. Distinct from check 5b (checkMigrationNumbers), which only forbids
 * two files sharing a number (SMD-1805).
 */
function checkMigrationDoc() {
  const files = readdirSync(join(ROOT, "db", "migrations")).filter((f) => /^\d{3}_.*\.sql$/.test(f));
  const fileNums = files.map((f) => Number(f.slice(0, 3)));
  const readme = readFileSync(join(ROOT, "db", "README.md"), "utf8");
  const tableStart = readme.indexOf("## The migrations");
  const mapStart = readme.indexOf("Migrations 024 onward");
  if (tableStart < 0 || mapStart < 0 || mapStart < tableStart) {
    return fail("db/README.md", 'the migration documentation ("## The migrations" table and the "Migrations 024 onward" map) is not where the coverage check expects it (SMD-1805)');
  }
  const tableText = readme.slice(tableStart, mapStart);
  const mapEnd = readme.indexOf("\n\n", mapStart);
  const mapText = readme.slice(mapStart, mapEnd < 0 ? readme.length : mapEnd);
  const documented = new Set<number>();
  const dup = new Set<number>();
  const note = (n: number) => (documented.has(n) ? dup.add(n) : documented.add(n));
  for (const m of tableText.matchAll(/`(\d{3})_[a-z0-9_]+\.sql`/g)) note(Number(m[1]));
  // "NNN change M" for a hand-numbered change, or "NNN SMD-####" for a migration
  // a fragment introduced — its change number is assigned at release, so it is
  // documented by its stable ticket until then (SMD-1804).
  for (const m of mapText.matchAll(/\b(\d{3}) (?:change \d+|SMD-\d+)/g)) note(Number(m[1]));
  const pad = (n: number) => String(n).padStart(3, "0");
  const missing = fileNums.filter((n) => !documented.has(n)).sort((a, b) => a - b);
  const extra = [...documented].filter((n) => !fileNums.includes(n)).sort((a, b) => a - b);
  if (missing.length) fail("db/README.md", `migration(s) ${missing.map(pad).join(", ")} have a file under db/migrations/ but appear in neither "## The migrations" nor the "024 onward" map — document each (a table row for 001–023, a "NNN change M" map entry otherwise) (SMD-1805)`);
  if (extra.length) fail("db/README.md", `the migration table or map names ${extra.map(pad).join(", ")}, which has no file under db/migrations/ — a renamed or removed migration left a stale entry (SMD-1805)`);
  if (dup.size) fail("db/README.md", `migration(s) ${[...dup].sort((a, b) => a - b).map(pad).join(", ")} are documented more than once across the table and the map (SMD-1805)`);
  const cm = /(\d+)\)?\s+migrations applied/.exec(readme);
  if (!cm) fail("db/README.md", `no "(N) migrations applied" count to check against the ${fileNums.length} files — state it as a digit so it cannot drift (SMD-1805)`);
  else if (Number(cm[1]) !== fileNums.length) fail("db/README.md", `states ${cm[1]} migrations applied but db/migrations/ holds ${fileNums.length} (SMD-1805)`);
}
checkMigrationDoc();

/**
 * server-portable/tools.json is generated from the typed source tools.ts
 * (SMD-1805) — the one place the MCP tool surface is written, so it can carry a
 * `ToolName` union JSON cannot. deploy/smoke.sh (bash) reads the JSON; this
 * holds it to exactly what tools.ts produces, the round-trip the codemod check
 * does for the shim. Bun-only — it imports the TS source through the generator —
 * so a node run skips it in words, as check 13 does.
 */
async function checkToolsManifest() {
  let renderToolsJson: () => string;
  try {
    ({ renderToolsJson } = await import("./gen-tools.ts"));
  } catch (e) {
    // Skipped only where the generator cannot load at all; under bun a failed
    // import is the generator broken, and passing on it would hide a stale file
    // (SMD-2041 review pass 1).
    if (typeof Bun !== "undefined") return fail("scripts/gen-tools.ts", `does not import (${(e as Error).message.split("\n")[0]}) — the tools.json round-trip cannot run (SMD-1805)`);
    console.warn(`  (tools.json round-trip skipped — ${(e as Error).message.split("\n")[0]} — run under bun)`);
    return;
  }
  const have = readFileSync(join(ROOT, "server-portable", "tools.json"), "utf8");
  if (have !== renderToolsJson()) {
    fail("server-portable/tools.json", "does not match its source — the MCP tool surface's typed source is server-portable/tools.ts; run `bun scripts/gen-tools.ts` to regenerate (SMD-1805)");
  }
}
await checkToolsManifest();

/**
 * 14: every knob the server reads reaches the container (SMD-1843).
 *
 * The first dogfood stack set OB1_LLM_BASE_URL, OB1_METADATA_MODEL and
 * OB1_QUERY_LOG in deploy/.env and the container saw none of them: compose
 * forwards exactly what `environment:` names, and the server's block named
 * none of the three. The rule this replaces compared the knobs .env.example
 * documents against every `OB1_*` token in the compose file's TEXT — and the
 * file's comments named the first, ollama-pull's command line the second, so
 * both counted as forwarded; the third was not documented, so it was never
 * asked about. (That rule had itself found six unforwarded knobs when it was
 * written — OB1_CHUNK_TOKENS, OB1_CHUNK_OVERLAP, OB1_CHUNK_CONTEXT,
 * OB1_EMBEDDING_DIMENSIONS, OB1_LLM_API_KEY, OB1_AGENT_CACHE_TTL_MS — and was
 * one-directional on purpose: compose may set what the example does not
 * mention. This one is not: a forwarded knob the server does not declare is a
 * typo.) Measured: preflight took the code's default, 127.0.0.1:11434,
 * for a local endpoint (it is — the container's own loopback), wanted no
 * credential, dialled nothing without --deep and said OK; the first capture
 * failed in 7 ms with "Unable to connect" and the server logged nothing.
 *
 * So the universe is what the SERVER declares — the `OB1_*` and `OPEN_BRAIN_*`
 * names in server-portable/root.ts's `type Env` (the process root both
 * serving entries build on, SMD-2284); the block's other names
 * (DATABASE_URL, the key material, SUPABASE_*, the legacy MCP_ACCESS_KEY) are
 * the stack's own wiring or another target's, and outside this rule — held
 * honest by a scan of
 * every non-test server source for a direct read (`process.env.OB1_X`,
 * `env.OB1_X`, `env["OB1_X"]`) of a name the block does not declare; and
 * "forwarded" is read from the parsed documents' `services.*.environment`,
 * mapping or list form. Each declared knob is forwarded by the base file's
 * server under its own name as `${NAME}` or `${NAME:-…}` (a literal pins the
 * operator out; another name is a miswire; a bare list item `- NAME` is
 * refused — compose fills it from its own environment, absent rather than ""
 * when nothing is set, and the runners differ in what "its environment" is)
 * or excused by name in NOT_FORWARDED with the reason, and documented in
 * .env.example so an operator can find it. A forwarded name the server does
 * not declare is a typo or a knob that died. A documented knob no service in
 * any compose file forwards is a dead switch. `env_file` is refused on any
 * service: it forwards a file this rule does not open. Every compose*.yaml
 * under deploy/ is held to the shape and to the server's names, since an
 * overlay's `server:` lands in the same container; the base file alone holds
 * the universe. And OB1_LLM_BASE_URL's compose fallback, if it has one, is
 * `http://<service>:11434/v1` for a service the file or the base defines and
 * db/config.mjs's LOCAL_PROVIDER_SERVICES names — what preflight calls local;
 * held in every file's server, since an overlay's lands in the same container.
 *
 * The decision is one pure function over parsed inputs, serverEnvGapsIn, so
 * DECISION_PROBES run it on in-memory documents every run — the third review
 * pass found the readers and the messages probed and the decision itself not,
 * so a dropped branch stayed invisible while the real file complied.
 */
const SERVER_ENV_SOURCE = "server-portable/root.ts";
const KNOB = /^(OB1_|OPEN_BRAIN_)[A-Z0-9_]+$/;
/** The one shape a knob is forwarded in — `${NAME}` or `${NAME:-default}` — with the default captured; the fallback rule reads the capture. */
const HOUSE_FORM = (k: string) => new RegExp(`^\\$\\{${k}(?::-([^$}]*))?\\}$`);
/**
 * Knobs with no default anywhere, which compose must refuse to run without: forwarded as `${NAME:?the fix}`
 * and in no other form, so a stack missing one stops at `up`, naming the fix, rather than starting a
 * service that exits at once behind the proxy's 502. Each with why it has no default.
 */
const REQUIRED_KNOBS: Record<string, string> = {
  OB1_FORWARDER_KEY: "the MCP server's forward-scope key (SMD-2287): mcp-server/index.ts exits 2 without it, and no default can be one, since its hash must be in the stack's own MCP_ACCESS_KEYS",
};
/**
 * Each required knob .env.example documents but not as its live, empty `NAME=` line — commented out, a copied .env
 * meets compose's refusal at its first `up` instead (SMD-2287 PR 5b review pass 2). Check 13's ENV_EXAMPLE_LIVE admits
 * the line, and refuses one with a value.
 */
function requiredNotLive(text: string, documented: Set<string>, required: Record<string, string> = REQUIRED_KNOBS): string[] {
  return Object.keys(required).filter((k) => documented.has(k) && !new RegExp(`^${k}=$`, "m").test(text));
}
/** [.env.example's text, the knobs requiredNotLive reports] for a required OB1_R, documented: each must hold (review pass 3). */
const REQUIRED_LIVE_PROBES: [string, string[]][] = [["OB1_R=\n", []], ["# OB1_R=\n", ["OB1_R"]], ["  OB1_R=\n", ["OB1_R"]], ["OB1_R=x\n", ["OB1_R"]]];
/** The one shape a required knob is forwarded in: `${NAME:?message}`, the message naming the fix. */
const REQUIRED_FORM = (k: string) => new RegExp(`^\\$\\{${k}:\\?[^$}]+\\}$`);
/** Knobs the server declares that compose.yaml must NOT forward, with the reason its own comment gives. */
/**
 * Knobs only the REST core is handed (KNOB_SERVICE): any other service forwarding one is refused. Until SMD-2287 PR 6b
 * NOT_FORWARDED held these from `server`, the MCP server; with the REST core the service check 14 reads, the hold is
 * on everything else — a worker merging the `x-env` block they were added to would take a plugin's webhook secrets
 * (review pass 6b·1, measured).
 */
const KNOB_SERVICE_ONLY: Record<string, string> = {
  OB1_HOOKS: "the plugins whose webhooks the REST core serves (SMD-2310): compose.yaml's x-hook-env, merged by the REST core alone",
  OB1_HOOK_SECRETS: "the plugins' webhook secrets (SMD-2310): compose.yaml's x-hook-env, merged by the REST core alone — no other service serves a webhook, so none is handed the secrets",
};
const NOT_FORWARDED: Record<string, string> = {
  OB1_LISTEN_HOST: "the one address a server run outside the stack listens on — a suite's child on 127.0.0.1 (SMD-3323); a container is reached on the mesh, so it listens on every address, and a value forwarded from deploy/.env would cut it off from the proxy",
  OB1_OTEL_TRUST_TRACEPARENT: "trusting a caller's traceparent (SMD-1849 PR 2b) is a proxy deployment's to say, by an operator's own -f file outside deploy/, not any stack here: forwarded by the server, it would be one setting in deploy/.env from continuing every caller's trace",
  OB1_STORE: "the SQL store is the server's only store (FORK.md change 97; the PostgREST store retired in SMD-3152) — forwarding it would only carry a value the server refuses",
  OB1_GIT_SHA: "the commit the image was built from, baked by server-portable/Dockerfile from the build arg of the same name (compose's `build.args`) — a runtime forward would override the baked value with whatever deploy/.env names, a commit the image need not have been built from (SMD-2041)",
};

/**
 * Names .env.example documents that no compose service forwards, by design: a
 * provisioning step run from a checkout reads them from deploy/.env. Each is
 * held here to staying unforwarded by compose, and to staying documented.
 * deploy/tier.sh hands OB1_* lines to a container outside compose; it skips
 * OB1_AUTH_*, which deploy/auth/provision.ts --self-check holds.
 */
const FILE_ONLY: Record<string, string> = {
  OB1_AUTH_OPERATOR_PASSWORD: "the operator's sign-in password, which deploy/auth/provision.ts --init hashes into OB1_AUTH_OPERATOR_PASSWORD_HASH; the auth container is given the hash alone (SMD-2285)",
};

/** The names `type Env = { … }` declares in a server source, in order; null when the block is not there. */
function declaredEnvIn(source: string): string[] | null {
  const m = /type Env = \{([\s\S]*?)\n\};/.exec(source);
  if (!m) return null;
  return [...m[1].matchAll(/^[ \t]*([A-Z][A-Z0-9_]*)\??:/gm)].map((x) => x[1]);
}

/**
 * The knob names a source reads straight from an environment object —
 * `process.env.OB1_X`, `env.OB1_X`, `env?.OB1_X`, `env["OB1_X"]`, `ENV.OB1_X`,
 * `bindings.OB1_X`, root.ts's accessor `env().OB1_X` — as `[name, index]`
 * pairs, deduplicated, in order of first read, the index that of the read
 * itself (a docblock naming the knob above it is not the read). A name a
 * module reads this way without declaring it in `type Env` is the class the
 * rule's first run found twice (OB1_PG_POOL in store-sql.ts, and
 * OB1_TRGM_INDEX, which db/config.mjs reads for preflight); a read through a
 * variable (`env[QUERY_LOG.flag]`) or a destructuring is invisible here, and
 * declared by hand.
 */
function envReadsIn(source: string) {
  const reads: [string, number][] = [];
  for (const m of source.matchAll(/\b(?:process\.env|env\(\)|env|ENV|bindings)(?:\?\.|\.|\??\[["'])((?:OB1_|OPEN_BRAIN_)[A-Z0-9_]+)\b/g)) {
    if (!reads.some(([n]) => n === m[1])) reads.push([m[1], m.index]);
  }
  return reads;
}

/** A check-14 reader gap: `[kind, service, detail]` — `no-services` alone names no service. */
type EnvGap =
  | [kind: "no-services", service: null, detail: string]
  | [kind: "unreadable" | "env-file" | "environment-item-not-string" | "environment-not-mapping", service: string, detail: string];
/** One service's forwarded environment: name → value, null for a list item with no `=`. */
type ServiceEnv = Map<string, string | null>;
/**
 * One parsed compose document's environment: `forwarded` maps each service to
 * a Map of name → value (null for a list item with no `=`); `gaps` lists
 * `[kind, service, detail]` for what the rule refuses or cannot read.
 */
function forwardedEnvIn(doc: YamlValue) {
  const gaps: EnvGap[] = [], forwarded = new Map<string, ServiceEnv>();
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !doc.services || typeof doc.services !== "object" || Array.isArray(doc.services)) {
    gaps.push(["no-services", null, ""]);
    return { gaps, forwarded };
  }
  for (const [service, def] of Object.entries(doc.services)) {
    // An unreadable service registers no environment — registering an empty
    // one first made `server: x` cascade into one "never forwards" report per
    // declared knob beside check 13's (the eighth review pass).
    if (!def || typeof def !== "object" || Array.isArray(def)) { gaps.push(["unreadable", service, JSON.stringify(def)]); continue; }
    const env: ServiceEnv = new Map();
    forwarded.set(service, env);
    if ("env_file" in def) gaps.push(["env-file", service, JSON.stringify(def.env_file)]);
    if (!("environment" in def)) continue;
    const e = def.environment;
    if (Array.isArray(e)) {
      for (const item of e) {
        // A list item is a string: `NAME=value` or a bare `NAME`. A mapping or
        // a list in its place (`- OB1_A: 1`, a common slip compose rejects)
        // would stringify to "[object Object]" and vanish from the count.
        if (typeof item !== "string") { gaps.push(["environment-item-not-string", service, JSON.stringify(item)]); continue; }
        const i = item.indexOf("=");
        env.set(i < 0 ? item : item.slice(0, i), i < 0 ? null : item.slice(i + 1));
      }
    } else if (e && typeof e === "object") {
      for (const [k, v] of Object.entries(e)) env.set(k, v === null ? null : String(v));
    } else {
      gaps.push(["environment-not-mapping", service, JSON.stringify(e)]);
    }
  }
  return { gaps, forwarded };
}

/**
 * 1-based line of the KEY `needle` inside one service's block — the first
 * non-comment line after the service's own key (at the indentation the first
 * key under `services:` has) and before the next key at that indentation or
 * the next top-level key, spelled `needle`, `"needle"` or `'needle'`, as a
 * mapping key or a list item. 0 when not found (a flow mapping on one line).
 * lineOf() searches the whole file, and the first review pass found a
 * server-side fault reported at migrate's line for every knob both forward;
 * the second found a substring match handing the pointer to
 * `OB1_QUERY_LOG_RETENTION_DAYS` for `OB1_QUERY_LOG`, and to a `command:`
 * line that named the knob — so keys only, regex-escaped.
 */
function lineIn(text: string, service: string, needle: string) {
  const lines = text.split("\n");
  const comment = (l: string) => /^\s*#/.test(l) || !l.trim();
  const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isKey = (l: string, name: string) => new RegExp(`^\\s*(?:-\\s*)?["']?${esc(name)}["']?\\s*(?:[:=]|$)`).test(l);
  const top = lines.findIndex((l) => /^["']?services["']?\s*:/.test(l));
  if (top < 0) return 0;
  const firstKey = lines.findIndex((l, i) => i > top && !comment(l));
  if (firstKey < 0) return 0;
  const indent = /^\s*/.exec(lines[firstKey])![0].length; // `^\s*` matches every string
  const atIndent = (l: string) => !comment(l) && /^\s*/.exec(l)![0].length === indent; // as above
  const start = lines.findIndex((l, i) => i > top && atIndent(l) && isKey(l, service));
  if (start < 0) return 0;
  // The block ends at the next service, or the next top-level key — not at a
  // column-0 comment inside it (the third pass: one dropped the pointer).
  let stop = lines.findIndex((l, i) => i > start && (atIndent(l) || (!comment(l) && /^\S/.test(l))));
  if (stop < 0) stop = lines.length;
  const i = lines.findIndex((l, i) => i > start && i < stop && !comment(l) && isKey(l, needle));
  return i < 0 ? 0 : i + 1;
}
const LINE_PROBES: [string, string, string, number][] = [
  // [yaml, service, needle, expected line]
  ["services:\n  migrate:\n    environment:\n      OB1_A: ${OB1_A:-}\n  server:\n    environment:\n      OB1_A: ${OB1_A:-}\n", "server", "OB1_A", 7],
  ["services:\n  migrate:\n    environment:\n      OB1_A: ${OB1_A:-}\n  server:\n    environment:\n      OB1_A: ${OB1_A:-}\n", "migrate", "OB1_A", 4],
  ["services:\n  server:\n    # OB1_A: in a comment\n    environment:\n      \"OB1_A\": ${OB1_A:-}\n", "server", "OB1_A", 5],
  ["services:\n  server:\n    environment:\n      OB1_A : ${OB1_A:-}\n", "server", "OB1_A", 4],
  ["services:\n  server:\n    environment:\n      OB1_B: 1\n  ollama:\n    environment:\n      OB1_A: 1\n", "server", "OB1_A", 0],
  ["services:\n    server:\n        environment:\n            OB1_A: 1\n", "server", "OB1_A", 4],
  // A longer name sharing the prefix, and a value that names the knob, come first — neither is the key.
  ["services:\n  server:\n    environment:\n      OB1_A_B: 1\n      OB1_AB: 1\n      OB1_A: 1\n", "server", "OB1_A", 6],
  ["services:\n  server:\n    command: [\"x\", \"$OB1_A\"]\n    environment:\n      OB1_B: ${OB1_A:-}\n      OB1_A: 1\n", "server", "OB1_A", 6],
  ["services:\n  'server':\n    environment:\n      OB1_A: 1\n", "server", "OB1_A", 4],
  ["services:\n  server:\n    environment:\n      - OB1_B=1\n      - OB1_A\n", "server", "OB1_A", 5],
  ["services:\n  a-b:\n    environment:\n      OB1_A: 1\n  a.b:\n    environment:\n      OB1_A: 1\n", "a.b", "OB1_A", 7],
  // A column-0 comment inside the block does not end it; the next top-level key does.
  ["services:\n  server:\n    image: x\n# a column-zero comment\n    environment:\n      OB1_A: 1\nvolumes:\n  OB1_A: 1\n", "server", "OB1_A", 6],
];

/** What a value that is not `${NAME}` / `${NAME:-…}` is, for the message. */
function forwardForm(v: string, name: string) {
  if (new RegExp(`^\\$\\{${name}-`).test(v)) return "`${X-…}`, a single dash, keeps an EMPTY value from deploy/.env instead of the default";
  if (new RegExp(`^\\$\\{${name}:\\?`).test(v)) return "`${X:?…}` aborts compose on an unset knob that has a default in the code";
  if (new RegExp(`^\\$${name}$`).test(v)) return "a bare `$X` is the form this rule does not read";
  if (/\$\{[^}]*\$\{/.test(v)) return "a nested `${…${…}}` is the form this rule does not read";
  if (new RegExp(`\\$\\{${name}(:|-|\\})`).test(v)) return "the knob's own name with something the rule does not read around or inside it — text before or after the expansion, a second expansion, `:+`, or a `$` in the default";
  if (/^\$\{/.test(v)) return "another variable's name is a miswire";
  return "a literal pins the operator out";
}
const FORM_PROBES: [string, string, string][] = [
  // [value, name, a phrase the message must carry]
  ["${X-a}", "X", "single dash"], ["${X:?a}", "X", "aborts compose"], ["$X", "X", "bare"], ["${X:-${Y}}", "X", "nested"],
  ["on", "X", "literal"], ["${Y:-}", "X", "miswire"],
  ["${X:-}x", "X", "own name"], ["x${X:-}", "X", "own name"], ["${X:+on}", "X", "own name"], ["${X:-$$id}", "X", "own name"], ["${X:-a}${X:-b}", "X", "own name"],
];

const ENV_SOURCE_PROBES: [string, string[] | null][] = [
  // [source, expected names]
  ["type Env = {\n  A?: string;\n  /** doc with a colon: here */\n  OB1_B: string;\n  lower?: string;\n};\n", ["A", "OB1_B"]],
  ["type Env = {\n  A?: string;\n  B?: string;\n};\nconst x: { C?: string } = {};\n", ["A", "B"]],
  ["const Env = { A: 1 };\n", null],
];
const ENV_READ_PROBES: [string, string[]][] = [
  // [source, expected names]
  ["const a = process.env.OB1_A; const b = env.OB1_B || 1; const c = env?.OB1_C; const d = env[\"OB1_D\"]; const e = ENV.OPEN_BRAIN_E; f(bindings.OB1_F); const g = env().OB1_G;", ["OB1_A", "OB1_B", "OB1_C", "OB1_D", "OPEN_BRAIN_E", "OB1_F", "OB1_G"]],
  // Prose, a string naming the knob, a read through a variable, and a lowercase object are not reads.
  ["// set OB1_A in deploy/.env\nconst m = `OB1_B=${x}`; const v = env[QUERY_LOG.flag]; const w = cfg.OB1_C; const z = process.env.OB1_A;", ["OB1_A"]],
];
// The index is the read's, not the first mention's: the comment comes first here.
const ENV_READ_INDEX_PROBE: [string, string, number] = ["// OB1_A is read below\nconst a = process.env.OB1_A;", "OB1_A", 23 + 10]; // the read expression starts after the comment line (23) and `const a = ` (10)
/**
 * Knobs db/config.mjs reads that are the migrator's alone — the server's process
 * loads the file but never reaches the read — with the reason.
 */
const READ_FOR_MIGRATOR: Record<string, string> = {
  OB1_BACKFILL_LIMIT: "migration 023's batch size, read inside the substitutions db/migrate.ts asks for; the server never calls that",
};
const FORWARD_PROBES: [string, string[], Record<string, string | null>][] = [
  // [yaml, expected gap kinds, expected server names → values]
  ["services:\n  server:\n    environment:\n      OB1_A: ${OB1_A:-}\n      OB1_B: ${OB1_B:-x}\n", [], { OB1_A: "${OB1_A:-}", OB1_B: "${OB1_B:-x}" }],
  ["services:\n  server:\n    environment:\n      - OB1_A=${OB1_A:-}\n      - OB1_B\n", [], { OB1_A: "${OB1_A:-}", OB1_B: null }],
  ["x-e: &e\n  environment:\n    OB1_A: ${OB1_A:-}\nservices:\n  server:\n    <<: *e\n    image: x\n", [], { OB1_A: "${OB1_A:-}" }],
  ["services:\n  server:\n    env_file: .env\n    environment:\n      OB1_A: ${OB1_A:-}\n", ["env-file"], { OB1_A: "${OB1_A:-}" }],
  ["services:\n  server:\n    environment: OB1_A=1\n", ["environment-not-mapping"], {}],
  ["services:\n  server:\n    environment:\n      - OB1_A: 1\n      - OB1_B=2\n", ["environment-item-not-string"], { OB1_B: "2" }],
  // A comment and a command line are not forwards.
  ["services:\n  server:\n    # OB1_A: ${OB1_A:-}\n    command: [\"sh\", \"-c\", \"echo ${OB1_B:-}\"]\n    environment:\n      OB1_C: \"1\"\n", [], { OB1_C: "1" }],
  ["- a\n", ["no-services"], {}],
  ["services:\n  server: x\n", ["unreadable"], {}],
];

/** One compose file, parsed: its name under deploy/ and its document. */
type ComposeFile = { name: string; doc: YamlValue };
/**
 * One check-14 gap: `[kind, file, service, name, detail]` — the slots a kind fills are the ones
 * its message reads, so the `switch` in checkServerEnvForwarded narrows them by kind.
 */
type ServerEnvGap =
  | [kind: "env-file" | "environment-not-mapping" | "environment-item-not-string", file: string, service: string, name: null, detail: string]
  | [kind: "bare-item" | "not-house-form" | "excused-forwarded" | "knob-service-only" | "unforwarded" | "bad-fallback", file: string, service: string, name: string, detail: string]
  | [kind: "undeclared", file: string, service: string, name: string, detail: string | null]
  | [kind: "no-server" | "no-base", file: string, service: null, name: null, detail: string]
  | [kind: "undocumented" | "dead-switch", file: string, service: null, name: string, detail: string]
  | [kind: "excuse-stale" | "file-only-stale", file: null, service: null, name: string, detail: string]
  | [kind: "file-only-forwarded", file: string, service: null, name: string, detail: string];
/**
 * The decision, pure: `declared` (type Env's names), `documented` (a Set of the
 * example's knob names), `files` = [{ name, doc }] with "compose.yaml" among
 * them; `excused` is NOT_FORWARDED and `fileOnly` FILE_ONLY, or a probe's own maps. Returns gaps
 * `[kind, file, service, name, detail]`, in the order the
 * rules run: per file — the reader's gaps, then each knob's shape and, under
 * the server, its declaration and excuse; then the base file's universe;
 * stale excuses; dead switches; the fallback.
 */
/** The service whose environment check 14 holds: the REST core, the one server that reads the knobs (until SMD-2287 PR 6b, `server`, the MCP server index.ts was). */
const KNOB_SERVICE = "api";
function serverEnvGapsIn(declared: string[], documented: Set<string>, files: ComposeFile[], excused: Record<string, string> = NOT_FORWARDED, fileOnly: Record<string, string> = FILE_ONLY, required: Record<string, string> = REQUIRED_KNOBS) {
  const gaps: ServerEnvGap[] = [];
  const anywhere = new Set<string>();
  const forwardedBy = new Map<string, Map<string, ServiceEnv>>(); // file name → its services' environments, read once
  let server: ServiceEnv | null = null, baseDoc: YamlValue | null = null, baseSeen = false;
  for (const { name, doc } of files) {
    const { gaps: read, forwarded } = forwardedEnvIn(doc);
    forwardedBy.set(name, forwarded);
    for (const [kind, service, detail] of read) {
      if (kind !== "no-services" && kind !== "unreadable") gaps.push([kind, name, service, null, detail]); // check 13 reports those two
    }
    for (const [service, env] of forwarded) {
      for (const [k, v] of env) {
        if (!KNOB.test(k)) continue;
        anywhere.add(k);
        if (v === null) gaps.push(["bare-item", name, service, k, ""]);
        else if (k in required ? !REQUIRED_FORM(k).test(v) : !HOUSE_FORM(k).test(v)) gaps.push(["not-house-form", name, service, k, v]);
        if (service !== KNOB_SERVICE && k in KNOB_SERVICE_ONLY) gaps.push(["knob-service-only", name, service, k, KNOB_SERVICE_ONLY[k]]);
        if (service === KNOB_SERVICE) {
          if (!declared.includes(k)) gaps.push(["undeclared", name, KNOB_SERVICE, k, v]);
          else if (k in excused) gaps.push(["excused-forwarded", name, KNOB_SERVICE, k, excused[k]]);
        }
      }
    }
    if (name === "compose.yaml") {
      baseSeen = true;
      baseDoc = doc;
      server = forwarded.get(KNOB_SERVICE) ?? null;
      if (!server && !read.some(([kind, service]) => kind === "no-services" || (kind === "unreadable" && service === KNOB_SERVICE))) gaps.push(["no-server", name, null, null, ""]);
    }
  }
  if (!baseSeen) gaps.push(["no-base", "compose.yaml", null, null, ""]);
  if (!server) return gaps;
  for (const k of declared.filter((n) => KNOB.test(n))) {
    if (k in excused) continue; // forwarding it is refused above
    if (!server.has(k)) gaps.push(["unforwarded", "compose.yaml", KNOB_SERVICE, k, ""]);
    if (!documented.has(k)) gaps.push(["undocumented", ".env.example", null, k, ""]);
  }
  for (const k of Object.keys(excused)) {
    if (!declared.includes(k)) gaps.push(["excuse-stale", null, null, k, ""]);
  }
  // A knob compose refuses to run without is documented, or the operator meets it first as compose's refusal (SMD-2287).
  for (const k of Object.keys(required)) if (!documented.has(k)) gaps.push(["undocumented", ".env.example", null, k, ""]);
  for (const k of documented) {
    if (k in fileOnly) {
      if (anywhere.has(k)) gaps.push(["file-only-forwarded", ".env.example", null, k, fileOnly[k]]);
    } else if (!anywhere.has(k)) gaps.push(["dead-switch", ".env.example", null, k, ""]);
  }
  for (const k of Object.keys(fileOnly)) {
    if (!documented.has(k)) gaps.push(["file-only-stale", null, null, k, ""]);
  }
  // The fallback is held wherever a file's server sets it — an overlay's
  // `OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-https://…}` lands in the same
  // container (the fifth pass found only the base file's read) — and the
  // service may be defined in that file or the base.
  for (const { name, doc } of files) {
    const env = forwardedBy.get(name)!.get(KNOB_SERVICE); // set for every file by the first loop
    // The captured default of a house-form value; a value the shape rule refused was reported above and draws no second report here.
    const fb = HOUSE_FORM("OB1_LLM_BASE_URL").exec(env?.get("OB1_LLM_BASE_URL") ?? "");
    if (!fb?.[1]) continue;
    // Names compare as DNS and preflight's isLocalHostname do: case-insensitively.
    const m = /^http:\/\/([A-Za-z0-9][A-Za-z0-9_.-]*):11434\/v1$/.exec(fb[1]);
    const host = m ? m[1].toLowerCase() : null;
    const defined = (d: YamlValue | null) => Object.keys((d as Record<string, unknown> | null)?.services ?? {}).some((s) => s.toLowerCase() === host); // `?.services` on a non-mapping is undefined, which the `?? {}` answers; the cast says only that
    const ok = host && LOCAL_PROVIDER_SERVICES.includes(host) && (defined(baseDoc) || defined(doc));
    if (!ok) gaps.push(["bad-fallback", name, KNOB_SERVICE, "OB1_LLM_BASE_URL", fb[1]]);
  }
  return gaps;
}
// Text, not documents: the probes are parsed inside the check, after its
// Bun.YAML guard — parsing here at module scope made the whole script throw
// under node before any check reported (the seventh review pass).
const BASE = (yaml: string) => ({ name: "compose.yaml", yaml });
const OVERLAY = (yaml: string) => ({ name: "compose.x.yaml", yaml });
const SRV = (env: string) => `services:\n  api:\n    environment:\n${env}`;
const DECISION_PROBES: [string[], string[], { name: string; yaml: string }[], string[], Record<string, string>?, Record<string, string>?, Record<string, string>?][] = [
  // [declared, documented, files, expected "kind:name" list, excused (none unless given), file-only (none unless given), required (none unless given)]
  // A required knob is forwarded as `${X:?…}` and in no other form; another service may forward it (SMD-2287).
  [["OB1_A"], ["OB1_A", "OB1_R"], [BASE(`${SRV("      OB1_A: ${OB1_A:-}\n")}  mcp:\n    environment:\n      OB1_R: \${OB1_R:?set OB1_R}\n`)], [], undefined, undefined, { OB1_R: "why" }],
  [["OB1_A"], ["OB1_A", "OB1_R"], [BASE(`${SRV("      OB1_A: ${OB1_A:-}\n")}  mcp:\n    environment:\n      OB1_R: \${OB1_R:-}\n`)], ["not-house-form:OB1_R"], undefined, undefined, { OB1_R: "why" }],
  [["OB1_A"], ["OB1_A"], [BASE(`${SRV("      OB1_A: ${OB1_A:-}\n")}  mcp:\n    environment:\n      OB1_R: \${OB1_R:?set OB1_R}\n`)], ["undocumented:OB1_R"], undefined, undefined, { OB1_R: "why" }],
  [["OB1_A"], ["OB1_A", "OB1_P"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n"))], [], undefined, { OB1_P: "why" }],
  [["OB1_A"], ["OB1_A", "OB1_P"], [BASE(`${SRV("      OB1_A: ${OB1_A:-}\n")}  other:\n    environment:\n      OB1_P: \${OB1_P:-}\n`)], ["file-only-forwarded:OB1_P"], undefined, { OB1_P: "why" }],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n"))], ["file-only-stale:OB1_P"], undefined, { OB1_P: "why" }],
  [["OB1_A", "OB1_B", "OB1_STORE"], ["OB1_A", "OB1_B"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n      OB1_B: ${OB1_B:-x}\n"))], [], { OB1_STORE: "why" }],
  [["OB1_A", "OB1_B"], ["OB1_A", "OB1_B"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n"))], ["unforwarded:OB1_B", "dead-switch:OB1_B"]],
  [["OB1_A"], ["OB1_A", "OB1_C"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n"))], ["dead-switch:OB1_C"]],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n      OB1_Z: ${OB1_Z:-}\n"))], ["undeclared:OB1_Z"]],
  [["OB1_A", "OB1_B"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n      OB1_B: ${OB1_B:-}\n"))], ["undocumented:OB1_B"]],
  [["OB1_A", "OB1_STORE"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n      OB1_STORE: ${OB1_STORE:-}\n"))], ["excused-forwarded:OB1_STORE"], { OB1_STORE: "why" }],
  // The webhook keys are the REST core's alone (KNOB_SERVICE_ONLY): a worker forwarding one, as merging the x-env block they were added to would (review pass 6b·1).
  [["OB1_HOOK_SECRETS"], ["OB1_HOOK_SECRETS"], [BASE(`${SRV("      OB1_HOOK_SECRETS: ${OB1_HOOK_SECRETS:-}\n")}  extract:\n    environment:\n      OB1_HOOK_SECRETS: \${OB1_HOOK_SECRETS:-}\n`)], ["knob-service-only:OB1_HOOK_SECRETS"]],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_B:-}\n"))], ["not-house-form:OB1_A"]],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: on\n"))], ["not-house-form:OB1_A"]],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      - OB1_A\n"))], ["bare-item:OB1_A"]],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A:\n"))], ["bare-item:OB1_A"]],
  // The shape's tail: the knob's own name with a refused tail is not the house form.
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:-}x\n"))], ["not-house-form:OB1_A"]],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A-}\n"))], ["not-house-form:OB1_A"]],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:?x}\n"))], ["not-house-form:OB1_A"]],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A}\n"))], []],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      - OB1_A=${OB1_A:-}\n"))], []],
  [["OB1_A"], ["OB1_A"], [BASE("services:\n  api:\n    env_file: .env\n    environment:\n      OB1_A: ${OB1_A:-}\n")], ["env-file:"]],
  [["OB1_A"], ["OB1_A"], [BASE("services:\n  migrate:\n    environment:\n      OB1_A: ${OB1_A:-}\n")], ["no-server:"]],
  // An unreadable server is check 13's one report, not a cascade of "never forwards" here.
  [["OB1_A"], ["OB1_A"], [BASE("services:\n  api: x\n")], []],
  [["OB1_A"], ["OB1_A"], [OVERLAY(SRV("      OB1_A: ${OB1_A:-}\n"))], ["no-base:"]],
  // A knob not declared by the server is excused in NOT_FORWARDED: the entry is stale.
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n"))], ["excuse-stale:OB1_STORE"], { OB1_STORE: "why" }],
  // The fallback: the stack's own model service passes; another service, or a name the list lacks, does not.
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE("services:\n  api:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://ollama:11434/v1}\n  ollama:\n    image: x\n")], []],
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE("services:\n  api:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://postgres:11434/v1}\n  postgres:\n    image: x\n")], ["bad-fallback:OB1_LLM_BASE_URL"]],
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE("services:\n  api:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://ollama:11434/v1}\n")], ["bad-fallback:OB1_LLM_BASE_URL"]],
  // An overlay's fallback is held too: a hosted one is refused; the stack's own service, defined in the overlay, passes.
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE("services:\n  api:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://ollama:11434/v1}\n  ollama:\n    image: x\n"), OVERLAY(SRV("      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-https://openrouter.ai/api/v1}\n"))], ["bad-fallback:OB1_LLM_BASE_URL"]],
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE(SRV("      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-}\n")), OVERLAY("services:\n  api:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://ollama:11434/v1}\n  ollama:\n    image: x\n")], []],
  // Names compare as DNS does: a service spelled Ollama, a fallback spelled OLLAMA.
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE("services:\n  api:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://OLLAMA:11434/v1}\n  Ollama:\n    image: x\n")], []],
  // Overlays: the server's names are held there too; a knob forwarded only in an overlay is not a dead switch.
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n")), OVERLAY(SRV("      OB1_Z: ${OB1_Z:-}\n"))], ["undeclared:OB1_Z"]],
  [["OB1_A"], ["OB1_A", "OB1_C"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n")), OVERLAY("services:\n  migrate:\n    environment:\n      OB1_C: ${OB1_C:-}\n")], []],
];

function checkServerEnvForwarded() {
  const rel = "deploy/compose.yaml";
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    fail(SELF, `check 14 parses deploy/compose*.yaml with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-1843)`);
    return;
  }
  for (const [source, names] of ENV_SOURCE_PROBES) {
    const got = declaredEnvIn(source);
    if (JSON.stringify(got) !== JSON.stringify(names)) fail(SELF, `env-declaration reader no longer reports ${JSON.stringify(names)} for its probe (reported ${JSON.stringify(got)}): ${JSON.stringify(source)}`);
  }
  for (const [source, names] of ENV_READ_PROBES) {
    const got = envReadsIn(source).map(([n]) => n);
    if (JSON.stringify(got) !== JSON.stringify(names)) fail(SELF, `env-read reader no longer reports ${JSON.stringify(names)} for its probe (reported ${JSON.stringify(got)}): ${JSON.stringify(source)}`);
  }
  {
    const [source, name, index] = ENV_READ_INDEX_PROBE;
    const got = envReadsIn(source).find(([n]) => n === name)?.[1];
    if (got !== index) fail(SELF, `env-read reader no longer reports the read's own index ${index} for \`${name}\` (reported ${got}) — a mention in a comment above the read must not take the pointer: ${JSON.stringify(source)}`);
  }
  for (const [yaml, service, needle, line] of LINE_PROBES) {
    const got = lineIn(yaml, service, needle);
    if (got !== line) fail(SELF, `service-line reader no longer reports line ${line} for \`${needle}\` under \`${service}\` (reported ${got}): ${JSON.stringify(yaml)}`);
  }
  for (const [value, name, phrase] of FORM_PROBES) {
    if (!forwardForm(value, name).includes(phrase)) fail(SELF, `forward-form message for ${JSON.stringify(value)} no longer says "${phrase}": ${JSON.stringify(forwardForm(value, name))}`);
  }
  for (const [yaml, kinds, server] of FORWARD_PROBES) {
    const got = forwardedEnvIn(Bun.YAML.parse(yaml) as YamlValue);
    const gotKinds = got.gaps.map((g) => g[0]);
    const gotServer = Object.fromEntries(got.forwarded.get("server") ?? []);
    if (JSON.stringify(gotKinds) !== JSON.stringify(kinds) || JSON.stringify(gotServer) !== JSON.stringify(server)) {
      fail(SELF, `forwarded-env reader no longer reports ${JSON.stringify(kinds)} / ${JSON.stringify(server)} for its probe (reported ${JSON.stringify(gotKinds)} / ${JSON.stringify(gotServer)}): ${JSON.stringify(yaml)}`);
    }
  }
  for (const [declared, documented, probeFiles, expected, excused, fileOnly, required] of DECISION_PROBES) {
    const files = probeFiles.map(({ name, yaml }) => ({ name, doc: Bun.YAML.parse(yaml) as YamlValue }));
    const got = serverEnvGapsIn(declared, new Set(documented), files, excused ?? {}, fileOnly ?? {}, required ?? {}).map(([kind, , , name]) => `${kind}:${name ?? ""}`);
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(SELF, `check 14's decision no longer reports ${JSON.stringify(expected)} for its probe (reported ${JSON.stringify(got)}): declared ${JSON.stringify(declared)}, documented ${JSON.stringify(documented)}, ${probeFiles.map((f) => f.name).join(" + ")}`);
  }

  const knobs = documentedEnvKnobs(KNOB);
  if (knobs === null) return;
  const documented = new Set(knobs.map((k) => k.name));
  for (const [text, want] of REQUIRED_LIVE_PROBES) {
    const got = requiredNotLive(text, new Set(["OB1_R"]), { OB1_R: "why" });
    if (JSON.stringify(got) !== JSON.stringify(want)) fail(SELF, `check 14's required-knob live line no longer reports ${JSON.stringify(want)} for ${JSON.stringify(text)} (reported ${JSON.stringify(got)})`);
  }
  for (const k of requiredNotLive(readFileSync(join(ROOT, "deploy/.env.example"), "utf8"), documented)) {
    fail("deploy/.env.example", `documents \`${k}\` only commented out, which compose refuses to run without (REQUIRED_KNOBS) — give it its live, empty \`${k}=\` line, which check 13's ENV_EXAMPLE_LIVE admits (SMD-2287)`);
  }
  const exampleLine = (name: string) => knobs.find((k) => k.name === name)?.line;

  const sourcePath = join(ROOT, SERVER_ENV_SOURCE);
  if (!existsSync(sourcePath)) { fail(SERVER_ENV_SOURCE, `missing — check 14 reads the knobs the server declares from its \`type Env\` block (SMD-1843)`); return; }
  const indexSource = readFileSync(sourcePath, "utf8"); // read once: the declaration here, the read scan below
  const declared = declaredEnvIn(indexSource);
  if (declared === null) { fail(SERVER_ENV_SOURCE, `has no \`type Env = { … };\` block — check 14 reads the knobs the server declares from it; if the declaration moved, move the reader (SMD-1843)`); return; }
  if (!declared.some((n) => KNOB.test(n))) { fail(SERVER_ENV_SOURCE, `\`type Env\` declares no OB1_* or OPEN_BRAIN_* name — check 14 has nothing to hold the compose file to, which cannot be right (SMD-1843)`); return; }

  // The declaration is held honest: a source the container's process loads —
  // every non-test server-portable/*.ts, root.ts and index.ts included (their `env().X`
  // reads are matched and declared by construction, since env() returns Env;
  // a `process.env.OB1_X` there would not be), and db/config.mjs,
  // which the server imports and which reads eight knobs through its ENV
  // proxy — that reads a knob straight from the environment declares it, or
  // the universe is short of what runs. The migrator's own knob is excused.
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(join(ROOT, dir)).sort()) {
      const srcRel = `${dir}/${f}`;
      if (statSync(join(ROOT, srcRel)).isDirectory()) { if (f !== "node_modules") walk(srcRel); }
      else if (/\.ts$/.test(f) && !/^test-/.test(f)) sources.push(srcRel);
    }
  };
  walk("server-portable"); // subdirectories too (core/, rest/) — the fifth pass found the walk flat
  if (!sources.includes("server-portable/core/context.ts")) fail(SELF, `check 14's read scan no longer reaches server-portable/core/ (context.ts is not in its list) — a knob read in a subdirectory would go undeclared unseen (SMD-1843)`);
  sources.push("db/config.mjs");
  const readSomewhere = new Set();
  for (const srcRel of sources) {
    const source = srcRel === SERVER_ENV_SOURCE ? indexSource : readFileSync(join(ROOT, srcRel), "utf8");
    for (const [name, index] of envReadsIn(source)) {
      readSomewhere.add(name);
      if (declared.includes(name) || (srcRel === "db/config.mjs" && name in READ_FOR_MIGRATOR)) continue;
      fail(`${srcRel}:${source.slice(0, index).split("\n").length}`, `reads \`${name}\` from the environment, and ${SERVER_ENV_SOURCE}'s \`type Env\` — the one list of what the container's process reads, which check 14 holds deploy/compose.yaml to — does not declare it, so nothing forwards it: declare it there with what it does${srcRel === "db/config.mjs" ? `, or, when only db/migrate.ts reaches the read, excuse it in READ_FOR_MIGRATOR in ${SELF}` : ""} (SMD-1843)`);
    }
  }
  for (const name of Object.keys(READ_FOR_MIGRATOR)) {
    if (!readSomewhere.has(name)) fail(SELF, `READ_FOR_MIGRATOR excuses \`${name}\`, which db/config.mjs no longer reads — drop the entry (SMD-1843)`);
    if (declared.includes(name)) fail(SELF, `READ_FOR_MIGRATOR excuses \`${name}\` as the migrator's alone, and ${SERVER_ENV_SOURCE}'s \`type Env\` declares it — one of the two is wrong (SMD-1843)`);
  }

  const dir = join(ROOT, "deploy");
  const files: ComposeFile[] = [], texts = new Map<string, string>();
  for (const name of readdirSync(dir).filter((f) => COMPOSE_FILE.test(f) && statSync(join(dir, f)).isFile()).sort()) {
    const text = readFileSync(join(dir, name), "utf8");
    let doc: YamlValue;
    try { doc = Bun.YAML.parse(text) as YamlValue; } catch { if (name === "compose.yaml") return; continue; } // check 13 reports the parse failure; nothing to hold without the base
    files.push({ name, doc });
    texts.set(name, text);
  }
  const at = (file: string, service: string | null, needle: string | null) => {
    const frel = `deploy/${file}`;
    const l = texts.has(file) && service && needle ? lineIn(texts.get(file)!, service, needle) : 0; // has() just tested
    return l ? `${frel}:${l}` : frel;
  };
  const HOUSE = (k: string) => `\`\${${k}}\` or \`\${${k}:-…}\``;
  for (const [kind, file, service, name, detail] of serverEnvGapsIn(declared, documented, files)) {
    switch (kind) {
      case "env-file": fail(at(file, service, "env_file"), `service \`${service}\` has \`env_file: ${detail}\` — a file this rule does not open, forwarding whatever it holds; name each knob in \`environment:\` instead (SMD-1843)`); break;
      case "environment-not-mapping": fail(at(file, service, "environment"), `service \`${service}\` has \`environment: ${detail}\`, neither a mapping nor a list (SMD-1843)`); break;
      case "environment-item-not-string": fail(at(file, service, "environment"), `service \`${service}\` has ${detail} as an \`environment:\` list item — an item is \`NAME=value\`; a mapping there is the slip compose rejects, and this rule would otherwise count its knob as missing (SMD-1843)`); break;
      case "bare-item": fail(at(file, service, name), `\`${name}\` under \`${service}\` has no value — a bare \`- ${name}\` item, or \`${name}:\` with nothing after it — which compose fills from its own environment: absent in the container when nothing is set, where every other knob here is "", and the runners differ in what that environment is (docker-compose reads deploy/.env for it; measured) — write \`${name}: \${${name}:-}\` (in a list, \`- ${name}=\${${name}:-}\`) (SMD-1843)`); break;
      case "not-house-form": fail(at(file, service, name), name in REQUIRED_KNOBS
        ? `\`${name}: ${detail}\` under \`${service}\` — REQUIRED_KNOBS holds it required: ${REQUIRED_KNOBS[name]}; it is forwarded as \`\${${name}:?<the fix>}\`, so compose refuses a stack without it and names the fix (SMD-2287)`
        : `\`${name}: ${detail}\` under \`${service}\` — ${forwardForm(detail, name)}; a knob is forwarded as ${HOUSE(name)}, the operator's value under its own name (SMD-1843)`); break;
      case "undeclared": fail(at(file, KNOB_SERVICE, name), `\`${KNOB_SERVICE}.environment\` forwards \`${name}\`, which ${SERVER_ENV_SOURCE} does not declare — \`type Env\` there is the one list of what the container's process reads, so this is a typo, a knob that died, or a knob a module reads without declaring (two were, when this rule first ran): declare it there with what it does, or drop it here (SMD-1843)`); break;
      case "knob-service-only": fail(at(file, service, name), `\`${service}\` forwards \`${name}\`, which KNOB_SERVICE_ONLY in ${SELF} holds to the REST core (\`${KNOB_SERVICE}\`) alone: ${detail} (SMD-2310, SMD-2287 PR 6b)`); break;
      case "excused-forwarded": fail(at(file, KNOB_SERVICE, name), `forwards \`${name}\`, which NOT_FORWARDED in ${SELF} says the stack must not: ${detail} (SMD-1843)`); break;
      case "no-server": fail(`deploy/${file}`, `has no \`${KNOB_SERVICE}\` service — check 14 reads what it forwards to the REST core, the server that reads the knobs (SMD-1843, SMD-2287 PR 6b)`); break;
      case "no-base": fail(rel, `missing — check 14 reads the server's environment from it, and SETUP.md brings the stack up with it (SMD-1843)`); break;
      case "unforwarded": fail(at(file, KNOB_SERVICE, "environment"), `the server reads \`${name}\` (${SERVER_ENV_SOURCE}, type Env) and \`${KNOB_SERVICE}.environment\` never forwards it, so a value in deploy/.env does nothing and says nothing — add \`${name}: \${${name}:-}\` (or, when the stack must not forward it, the name and the reason to NOT_FORWARDED in ${SELF}) (SMD-1843)`); break;
      case "undocumented": fail("deploy/.env.example", name in REQUIRED_KNOBS
        ? `does not document \`${name}\`, which compose refuses to run without (REQUIRED_KNOBS) — add its live \`${name}=\` line with what it is and how to mint it, and keep it in check 13's ENV_EXAMPLE_LIVE (SMD-2287)`
        : `does not document \`${name}\`, which the server reads and compose forwards — an operator cannot find the knob; add a \`# ${name}=\` line with what it does (SMD-1843)`); break;
      case "excuse-stale": fail(SELF, `NOT_FORWARDED excuses \`${name}\`, which ${SERVER_ENV_SOURCE} no longer declares — drop the entry (SMD-1843)`); break;
      case "file-only-forwarded": fail(`deploy/.env.example${exampleLine(name) ? `:${exampleLine(name)}` : ""}`, `\`${name}\` is forwarded to a container, which FILE_ONLY in ${SELF} says no compose service forwards: ${detail}`); break;
      case "file-only-stale": fail(SELF, `FILE_ONLY names \`${name}\`, which deploy/.env.example no longer documents — drop the entry`); break;
      case "dead-switch": fail(`deploy/.env.example${exampleLine(name) ? `:${exampleLine(name)}` : ""}`, `documents \`${name}\`, and no service's \`environment:\` in any deploy/compose*.yaml forwards it, so setting it in deploy/.env does nothing and says nothing — a mention in a comment or on a command line is not a forward (SMD-1843)`); break;
      case "bad-fallback": fail(at(file, KNOB_SERVICE, name), `OB1_LLM_BASE_URL falls back to \`${detail}\` — the fallback is \`http://<service>:11434/v1\` for a service this file or compose.yaml defines and db/config.mjs's LOCAL_PROVIDER_SERVICES names (${LOCAL_PROVIDER_SERVICES.map((n) => `\`${n}\``).join(", ")}: what preflight calls local), the one address that means something inside the compose network; any other default belongs in db/config.mjs or the operator's deploy/.env (SMD-1843)`); break;
      default: throw new Error(`check 14: no message for kind ${kind}`);
    }
  }
}
checkServerEnvForwarded();

/**
 * 9: committed fixtures carry NO thought content (SMD-1295).
 *
 * export-queries.ts redacts a real brain's log to query text and ids, and the
 * replay fixture is ids and vectors, so a fixture can be committed without the
 * corpus. This guards that promise. A committed fixture has a tiny, known shape,
 * so the rule is an ALLOWLIST, not a denylist of field names: every STRING value
 * anywhere in the tree — including array elements and nested objects — must be
 * one of a thought id (a uuid), or text under a key the fixture format defines
 * as free text (`query` — what the caller typed; `note`/`origin`/`generated` —
 * tool-authored labels, deliberately NOT content-adjacent names like `source`).
 * Object KEYS are checked too — a legitimate key is a plain field name or an id,
 * so a thought body smuggled as a key (prose, spaces) fails closed like any value.
 * Any other string is a possible leak — a thought body under `content`, an array
 * of `chunks`, a `title` derived from content, or any newly-added key that is not
 * one of the four free-text ones — and fails closed. The only way to hide content
 * is to put it under those four keys; the fixture format never does, so a future
 * export must not either. A self-test on every run keeps it honest both ways.
 *
 * Note this guards THOUGHT content, not query text: the export fixture's `query`
 * strings are the searcher's own words — personal data — and are allowed here
 * because a replay needs them. Committing an export fixture from a real brain
 * therefore commits real queries; that is a privacy call for the maintainer, and
 * SETUP.md/FORK.md say so. Only the synthetic replay-fixture is truly content-free.
 */
function checkFixtureRedaction() {
  const FREE_TEXT_KEYS = new Set(["query", "note", "origin", "generated"]);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // A structural field name — the only shape an object key legitimately takes in
  // a fixture. A thought body smuggled AS a key (prose, spaces) is not one, so
  // keys are checked too, not just values.
  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  // Recurse carrying the nearest object key that governs a value; an array's
  // elements are governed by the array's own key, so `relevant: [uuid]` passes
  // and `chunks: ["body"]` does not.
  const scan = (node: unknown, key: string, path: string, hits: string[]): void => {
    if (typeof node === "string") {
      if (node.trim() !== "" && !FREE_TEXT_KEYS.has(key) && !UUID.test(node.trim())) hits.push(`${path} (value under "${key}")`);
      return;
    }
    if (Array.isArray(node)) { node.forEach((v, i) => scan(v, key, `${path}[${i}]`, hits)); return; }
    if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) {
      // A key that is neither a plain field name nor an id is content-shaped.
      if (!IDENT.test(k) && !UUID.test(k)) hits.push(`${path}.${JSON.stringify(k.slice(0, 40))} (object key)`);
      scan(v, k, `${path}.${k}`, hits);
    }
  };
  // Self-test: thought content must be caught however it hides — a plain field,
  // an array of strings, or an off-list key; a query/ids/vectors fixture must not.
  for (const [probe, why] of [
    [{ queries: [{ query: "q", content: "a leaked thought body" }] }, "a `content` field"],
    [{ thoughts: [{ id: "x", chunks: ["a leaked chunk body"] }] }, "content in an array of strings"],
    [{ title: "a leaked title derived from content" }, "content under an off-list key (`title`)"],
    [{ thoughts: { "a leaked thought body used as a key": 1 } }, "content used as an object key"],
  ]) {
    const bad: string[] = []; scan(probe, "$", "$", bad);
    if (bad.length === 0) fail(SELF, `fixture redaction check no longer catches ${why} (its own probe)`);
  }
  const good: string[] = []; scan(
    { generated: "2026-01-01T00:00:00Z", origin: "query_log", note: "a description",
      queries: [{ query: "how many projects have I led", relevant: ["10000000-0000-4000-8000-000000000001"], baseline: ["10000000-0000-4000-8000-000000000002"] }],
      thoughts: [{ id: "10000000-0000-4000-8000-000000000003", embedding: [0.1, -0.2] }] }, "$", "$", good);
  if (good.length) fail(SELF, `fixture redaction check false-positives on a query/ids/vectors fixture (${good.join(", ")})`);

  const dir = join(ROOT, "evals", "fixtures");
  if (!existsSync(dir)) return;
  for (const file of walk(dir, [], /\.json$/)) {
    let data: unknown;
    try { data = JSON.parse(readFileSync(file, "utf8")); }
    catch { fail(relOf(file), "committed fixture is not valid JSON"); continue; }
    const hits: string[] = [];
    scan(data, "$", "$", hits);
    for (const h of hits) fail(relOf(file), `committed fixture carries a non-id, non-query string at ${h} — thought content must not be committed (SMD-1295)`);
  }
}
checkFixtureRedaction();

// ── 15: FORK.md is the front door; changes/ holds the record (SMD-1917) ──────
//
// FORK.md reached 1.23 MB and 17,700 lines — larger than any context window, so
// every reader took a slice by grep — and its `### N.` sections were numbered by
// hand in one file, so every merge of main renumbered a section and left the
// code comments citing the old number silently wrong. Every change from 18 on is
// one file under changes/ now, and this holds the layout: the names and the
// numbers, the line cap, FORK.md's own size, the generated index, and every
// citation of a change number in the tree.

/** FORK.md's byte ceiling, measured outside the generated index — the front door's prose, not the record (~16k tokens; 50 KB at the split). */
const FORK_CEILING_BYTES = 64 * 1024;
/** A change file's line cap. The shape is in changes/README.md. */
const CHANGE_CAP_LINES = 150;
/**
 * The files over the cap when the split landed, with the ceiling each may only
 * shrink under (its line count then, rounded up to ten). Held stale two ways: an
 * entry for a file that now fits under the cap, or for a number with no file,
 * fails until it is dropped. The sizes are the files' at the merge that landed the
 * split (main's PR #95 had added two lines to 69). 102 was cut to the shape and is absent;
 * 103 (SMD-1541) landed on main as a hand-numbered section while the split was in
 * review — the last one the transition allowed — and joins the list.
 */
const OVERSIZE_AT_SPLIT: Record<number, number> = {
  24: 160, 28: 710, 30: 200, 32: 230, 33: 160, 34: 190, 35: 160, 36: 180, 37: 210, 38: 340, 39: 280,
  40: 250, 41: 270, 51: 240, 52: 220, 56: 380, 57: 160, 58: 210, 60: 170, 61: 350, 63: 250, 64: 420, 66: 210,
  67: 430, 69: 310, 70: 380, 71: 340, 72: 410, 73: 220, 74: 330, 75: 240, 76: 310, 77: 450, 78: 200, 79: 230, 80: 430,
  81: 300, 84: 210, 90: 290, 91: 470, 93: 250, 94: 340, 95: 360, 97: 240, 98: 270, 99: 290,
  103: 320, // landed hand-numbered on main (PR #95) during SMD-1804's transition, after the split
};

/**
 * Change numbers a text cites by the explicit shapes every file may use:
 * "FORK.md change N" — also "FORK change N", "FORK.md's change N", "changes N
 * and M", "changes N, M, and O", "FORK.md, change N", "FORK.md §N", "FORK.md
 * section N" — a `changes/NNN` path, and db/README.md's migration map row
 * "NNN change M". `record` adds the bare "change N" / "Change N" (and the same
 * lists) the record itself uses (FORK.md and the change files, where "change"
 * means nothing else). A number followed by `-NN-` is a date, not a change;
 * "18-20" with a plain hyphen is still a range.
 * Returns [{ n, index }].
 */
// A number is not a thousands group ("changes 1,536 rows" is a count) nor a date
// ("change 2026-09-21"). A list continues after "and", a dash or a slash, or
// after a comma when another item or "and" follows — so "(FORK.md change 90,
// 250 ms)" and "change 90, 2 of them" cite 90 alone while "changes 31, 53, and
// 89" cites all three. A continuation number is three digits at most: change
// 1000, should the fork get there, is read in the leading position only.
// A number is a change number unless it is a thousands group ("1,536 rows"), a
// date ("2026-09-21"), a decimal ("0.51 R@10") or is followed by a unit or count
// word ("no behaviour change 250 ms", "a schema change 200 lines long") — the
// record measures in the same sentences it cites in. The unit list is the
// record's vocabulary, a heuristic held by its probes: a false report is fixed
// by rewording, a miss by adding the word here.
const UNIT_WORDS = String.raw`ms|[µμ]s|s|sec(?:ond)?s?|min(?:ute)?s?|h|hours?|rows?|lines?|files?|bytes?|[KMGT]i?B|%|dims?|dimensions?|tokens?|passes?|times|commits?|queries|thoughts?|vectors?|sections?|entries|items?|chars?|characters|words?|columns?|tables?|calls?|runs?`;
const LINE_WRAP = String.raw`[ \t]*(?:\r?\n[ \t]*)?`; // the same line or a wrap onto the next, never across a blank line
const UNIT = String.raw`(?!${LINE_WRAP}(?:${UNIT_WORDS})(?!\w))`;
const NUM = String.raw`\b(?!-\d\d-)(?!,\d{3}\b)(?!\.\d)${UNIT}`;
// "18–20, 22" and "3, 4, 5." read whole, across a wrapped line: a bare comma item
// continues before another item, before "and", or at the end of the clause;
// ", change N" always continues. The one cost is a unit-less number in
// parentheses — "(change 90, 250)" cites 250 — a shape no site writes.
const SEP = String.raw`,${LINE_WRAP}`; // a comma item may wrap onto an indented continuation line; a blank line still stops
const CITED_LIST = String.raw`(\d+)${NUM}((?:(?:,?\s+and|–|—|-|\/)\s?(?:change )?\d{1,3}${NUM}|${SEP}change \d{1,3}${NUM}|${SEP}\d{1,3}${NUM}(?=${SEP}(?:change )?\d|,?\s+and\s|\s+(?:of|per)\b|\s*(?:[.;:)\]]|$)))*)`;
// A slugged path names a file as it is — a mis-cased or underscored slug is read
// so that check 15 can report the dead link, not skipped as "not a path".
const CHANGE_PATH = String.raw`(?<![\w/.-])(?:\.\.?\/)*changes\/(\d{3})([-_][\w-]+\.md)?(?![\w-])(?!\.[\w-])`; // ./ and ../ allowed; not docs/changes/…, not …md.bak; a sentence may end after it
// Inside the record a link may be relative: `(079-the-store.md)` beside the file.
const RECORD_PATH = String.raw`\((?:\.\/)?(\d{3})([-_][\w-]+\.md)(?:#[\w-]*)?(?: "[^"\n]*")?\)`;
// The file name may sit in a code span (\`FORK.md\` change N) or behind ../ .
// Code comments cite as "SMD-1541 (change 103)" or "(SMD-1541; change 103)": a
// bare "change N" within a few words of a ticket is a citation anywhere; and
// "(FORK 79)" — the file's name and a number — is one too (the NUM guard keeps
// "FORK.md 61,543 bytes" and "FORK.md 828 lines" out).
const TICKETED = String.raw`\bSMD-\d+[^\n]{0,40}?\(?[Cc]hanges?\s${CITED_LIST}`;
const EXPLICIT_CITATION = new RegExp(String.raw`\b(?:\.\.\/)?FORK(?:\.md)?\x60?(?:'s)?,?\s(?:(?:[Cc]hange|section|§) ?s?\s?)?${CITED_LIST}|${CHANGE_PATH}|\b\d{3} change (\d+)\b|${TICKETED}`, "gm");
const BARE_CITATION = new RegExp(String.raw`\b[Cc]hanges?\s${CITED_LIST}|${RECORD_PATH}`, "gm");
/** A change number a text cites, at the offset of its citation; `name` when it was cited as a `changes/NNN-<slug>.md` path. */
type Citation = { n: number; index: number; name?: string };
/** [{ n, index, name? }] — `name` when the citation is a `changes/NNN-<slug>.md` path, which must exist as such. */
function citedChangesIn(text: string, { record = false }: { record?: boolean } = {}) {
  const out: Citation[] = [];
  const list = (m: RegExpMatchArray, index: number = m.index!) => { // the default is taken for a real match alone, whose index is set
    out.push({ n: Number(m[1]), index });
    for (const t of m[2].matchAll(/\d+/g)) out.push({ n: Number(t[0]), index });
  };
  let rest = text; // the record's bare reader runs over the text with the explicit spans blanked: one report per site
  for (const m of text.matchAll(EXPLICIT_CITATION)) {
    if (m[3] !== undefined) out.push({ n: Number(m[3]), index: m.index, ...(m[4] ? { name: `${m[3]}${m[4]}` } : {}) });
    else if (m[5] !== undefined) out.push({ n: Number(m[5]), index: m.index });
    else if (m[6] !== undefined) list([m[0], m[6], m[7]], m.index);
    else list(m);
    rest = rest.slice(0, m.index) + " ".repeat(m[0].length) + rest.slice(m.index + m[0].length);
  }
  if (record) for (const m of rest.matchAll(BARE_CITATION)) {
    if (m[3] !== undefined) out.push({ n: Number(m[3]), index: m.index, name: `${m[3]}${m[4]}` });
    else list(m);
  }
  return out;
}
const CITATION_PROBES: [string, boolean, number[]][] = [
  ["see FORK.md change 58: the statements", false, [58]],
  ["named in FORK.md changes 38 and 40 updated a", false, [38, 40]],
  ["(FORK.md, change 64) and FORK.md §50 and FORK.md section 12", false, [64, 50, 12]],
  ["[the file](changes/102-every-knob-the-server-reads-reaches.md) and changes/018-long-captures-stay-searchable.md and changes/044", false, [102, 18, 44]],
  ["changes/README.md and change 42 in prose", false, []],
  ["change 42 in prose, Changes 3 and 4, changed 5 times", true, [42, 3, 4]],
  ["FORK.md changes 18-20 and 22", false, [18, 20, 22]],
  ["(FORK.md change 90, 1536 dims) and FORK.md change 90 and 1,536 vectors", false, [90, 90]],
  ["FORK.md Change 42 and FORK.md change\n43", false, [42, 43]],
  ["FORK.md change 42 once, once only", true, [42]],
  ["which changes 1,536 rows and change 42; FORK.md change 1,000", true, [42]],
  ["(FORK.md change 90, 250 ms) and FORK.md change 90, 2 of them", false, [90, 90, 2]], // "2 of them" reads as a list item: a miss on "changes 31, 53 of the record" would be silent, a false report here is bounded to a number above the highest change
  ["Ten (changes 31, 53, 55, 59, and 89) ship; changes 31, 53", true, [31, 53, 55, 59, 89, 31, 53]],
  ["FORK.md changes 3, 4, 5. Then FORK.md changes 18–20, 22; FORK.md change 90, change 91, change 92", false, [3, 4, 5, 18, 20, 22, 90, 91, 92]],
  ["`FORK.md` change 43 and `FORK.md` §50 and `../FORK.md` §48", false, [43, 50, 48]],
  ["(FORK.md change 31, 0.51 R@10) and FORK.md change 31, 12.3 ms.", false, [31, 31]],
  ["no behaviour change 250 ms after; a schema change 200 lines long; changes 3, 4 and 500 rows; change 5 of 6", true, [3, 4, 5]],
  ["Like FORK.md changes 31, 53\nand 999; FORK.md changes 5, 6,\n7 and 8; changes 31,\n53. And changes 31,\n53 then", true, [31, 53, 999, 5, 6, 7, 8, 31, 53, 31]],
  ["- FORK.md changes 5, 6,\n  7 and 8; changes 31,\n\n53", true, [5, 6, 7, 8, 31]],
  ["change 42% of them, change 5 seconds later, change 6 minutes, change 7 hours, change 8 μs", true, []],
  ["FORK.md changes 31 and 53 of the record; changes 3, 4 and 500 rows; see FORK.md change 999\n\nlines later", true, [31, 53, 999, 3, 4]], // explicit citations first, then the record's bare ones
  ["changes 31, 53 of the record; FORK.md change 42 of this fork; change 5 of 6", true, [42, 31, 53, 5]],
  ["SMD-1541 (change 103): the key; (SMD-1541; change 103 has the why); SMD-1228 changes 38 and 40; SMD-1 is not change-free", false, [103, 103, 38, 40]],
  ["SMD-1037 (FORK 79), (FORK 82) and FORK.md 61,543 bytes, FORK.md 828 lines", false, [79, 82]],
  ["see changes/104-x.md. And ../changes/020-x.md and ./changes/021-y.md and changes/022-z.md.bak", false, [104, 20, 21]],
  ["docs/changes/104-x.md and changes/105-y.md.bak and changes/106-z.md", false, [106]],
  ["since FORK.md change 90, one per id a capture names", false, [90]],
  ["024 change 45\n025 change 46\n044 SMD-1804", false, [45, 46]],
  ["033's header and FORK change 62 state it; FORK §79; FORK.md's change 12", false, [62, 79, 12]],
  ["Ten (changes 31, 53, 55, and 89) ship nothing", true, [31, 53, 55, 89]],
  ["measured on change 2026-09-21 and change 42", true, [42]],
  ["FORK.md change 2026-09-21 is a date", false, []],
];

/** A citation as the layout decision sees it: where in the tree, the number, and the file name when it was cited as a path. */
type LayoutCitation = { where: string; n: number; name?: string };
/** forkLayoutProblems' inputs; the constants default to the shipped values, a probe passes its own. */
type LayoutArgs = { entries: ChangeEntry[]; forkText: string; citations?: LayoutCitation[]; ceilings?: Record<number, number>; cap?: number; forkCeiling?: number };
/**
 * The layout decision, pure: what changes/ holds (as `{ name, text }` entries),
 * FORK.md's text, the citations found in the tree, and the constants. Returns
 * [{ where, kind, msg }]; the caller turns them into failures.
 */
function forkLayoutProblems({ entries, forkText, citations = [], ceilings = OVERSIZE_AT_SPLIT, cap = CHANGE_CAP_LINES, forkCeiling = FORK_CEILING_BYTES }: LayoutArgs) {
  const problems: { where: string; kind: string; msg: string }[] = [];
  const at = (where: string, kind: string, msg: string) => problems.push({ where, kind, msg });
  const changes = classifyChanges(entries);
  const { numbered, other } = changes;
  for (const o of other) at(`${CHANGES_DIR}/${o.name}`, "bad-name", o.text === null
    ? "is not a regular file (a directory, a symlink, a pipe) — changes/ holds change files and fragments alone"
    : "is neither a numbered change (NNN-<slug>.md: three digits, a dash, lower-case ASCII words) nor a release fragment (smd-NNNN.md) — the index cannot list it");
  const byTicket = new Map<string, string>();
  for (const f of changes.fragments) {
    if (byTicket.has(f.ticket)) at(`${CHANGES_DIR}/${f.name}`, "duplicate-fragment", `is a second fragment for ${f.ticket} beside ${CHANGES_DIR}/${byTicket.get(f.ticket)} — one PR, one fragment; the release step would number both`);
    else byTicket.set(f.ticket, f.name);
  }
  if (numbered.length === 0) { at(CHANGES_DIR, "no-files", `holds no numbered change file — every change from ${FIRST_FILED} on is one`); }
  const byN = new Map<number, NumberedChange>();
  for (const c of numbered) {
    if (c.n < FIRST_FILED) at(`${CHANGES_DIR}/${c.name}`, "below-first", `carries change number ${c.n}; changes 1–${FIRST_FILED - 1} are FORK.md's table and have no file`);
    if (byN.has(c.n)) at(`${CHANGES_DIR}/${c.name}`, "duplicate", `carries change number ${c.n}, which ${CHANGES_DIR}/${byN.get(c.n)!.name} already carries — two branches took one number; the later one takes the next free number and its citations move with it`);
    else byN.set(c.n, c);
  }
  const hi = numbered.length ? numbered[numbered.length - 1].n : FIRST_FILED - 1;
  for (let n = FIRST_FILED; n <= hi; n++) if (!byN.has(n)) at(CHANGES_DIR, "gap", `has no file for change ${n} — the numbers run contiguously from ${FIRST_FILED} to the highest (${hi})`);
  for (const c of numbered) {
    if (!c.heading) at(`${CHANGES_DIR}/${c.name}`, "heading", "does not open with `# N. <title>` on its first line — the index reads the title from it");
    else if (c.heading.n !== c.n) at(`${CHANGES_DIR}/${c.name}`, "heading", `opens with \`# ${c.heading.n}.\` but its name says ${c.n} — the citations follow the name`);
    const ceiling = ceilings[c.n];
    if (c.lines > cap) {
      if (ceiling === undefined) at(`${CHANGES_DIR}/${c.name}`, "oversize", `is ${c.lines} lines; a change file is at most ${cap} — a review pass is a table row, a finding worth more is a follow-up ticket (changes/README.md)`);
      else if (c.lines > ceiling) at(`${CHANGES_DIR}/${c.name}`, "oversize", `is ${c.lines} lines; it was over the cap at the split and may only shrink — its ceiling in OVERSIZE_AT_SPLIT is ${ceiling}`);
    } else if (ceiling !== undefined) at(SELF, "excuse-stale", `OVERSIZE_AT_SPLIT lists change ${c.n} (ceiling ${ceiling}) but ${CHANGES_DIR}/${c.name} is ${c.lines} lines, under the cap — drop the entry`);
  }
  for (const n of Object.keys(ceilings).map(Number)) if (!byN.has(n)) at(SELF, "excuse-stale", `OVERSIZE_AT_SPLIT lists change ${n}, which has no file — drop the entry`);
  for (const f of changes.fragments) if (f.lines > cap) at(`${CHANGES_DIR}/${f.name}`, "oversize", `is ${f.lines} lines; a fragment becomes a change file and is held to the same ${cap} — a review pass is a table row (changes/README.md)`);
  const sec = /^(#{1,6}) (\d+)\. /m.exec(forkText.replace(/^```[\s\S]*?^```/gm, "")); // a `# 1. fetch` comment in a fenced snippet is not a section
  if (sec) at("FORK.md", "section-in-fork", `carries a \`${sec[1]} ${sec[2]}.\` section — a numbered change is a file, ${CHANGES_DIR}/${String(sec[2]).padStart(3, "0")}-<slug>.md, and this file lists it`);
  let span: { s: number; e: number } | null = null;
  try { span = indexSpan(forkText); } catch (e) { at("FORK.md", "index-missing", `${(e as Error).message} — the generated index lives between them`); }
  // The ceiling is the front door's prose: the generated index between the
  // markers grows a row per release and is not what the ceiling is for.
  const prose = span ? forkText.slice(0, span.s) + forkText.slice(span.e) : forkText;
  const bytes = Buffer.byteLength(prose, "utf8");
  if (bytes > forkCeiling) at("FORK.md", "fork-oversize", `is ${bytes} bytes outside the generated index; the front door stays under ${forkCeiling} — a change's record belongs in its file under ${CHANGES_DIR}/, not here`);
  if (span && forkText.slice(span.s, span.e) !== "\n" + renderIndex(numbered)) at("FORK.md", "index-stale", `the index between the markers is not what ${CHANGES_DIR}/ renders to — run \`bun scripts/fork-index.ts\``);
  for (const c of citations) {
    if (c.n < 1 || (c.n >= FIRST_FILED && !byN.has(c.n)) || (c.name && c.n < FIRST_FILED)) at(c.where, "dangling", `cites change ${c.n}${c.name ? ` as ${CHANGES_DIR}/${c.name}` : ""}, which has no file under ${CHANGES_DIR}/ (1–${FIRST_FILED - 1} are FORK.md's table; the highest with a file is ${hi}) — a renumber left this behind, or the file is missing`);
    else if (c.name && byN.get(c.n)!.name !== c.name) at(c.where, "dangling", `cites ${CHANGES_DIR}/${c.name}, and change ${c.n}'s file is ${CHANGES_DIR}/${byN.get(c.n)!.name} — the file was renamed under the link`); // has(c.n) held by the branch above
  }
  return problems;
}

const LAYOUT_ENTRIES = (...files: [string, string | null][]): ChangeEntry[] => files.map(([name, text]) => ({ name, text }));
const CH = (n: number, title = "A thing — a consequence (SMD-1)", body = "Body.\n"): [string, string] => [`${String(n).padStart(3, "0")}-a-thing.md`, `# ${n}. ${title}\n\n${body}`];
const FORK_FOR = (entries: ChangeEntry[], extra = "") => `# FORK\n\nintro\n\n${INDEX_START}\n${renderIndex(classifyChanges(entries).numbered)}${INDEX_END}\n\ntail\n${extra}`;
const LONG = "line\n".repeat(200);
const LAYOUT_PROBES: [string, () => LayoutArgs, string[]][] = [
  // [label, args, expected kinds]
  ["a consistent layout", () => { const en = LAYOUT_ENTRIES(CH(18), CH(19), ["README.md", "x"], ["smd-1804.md", "---\n"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {}, citations: [{ where: "a.ts:1", n: 19 }, { where: "b.md:2", n: 3 }] }; }, []],
  ["a stray name", () => { const en = LAYOUT_ENTRIES(CH(18), ["notes.md", "x"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["bad-name"]],
  ["a fragment over the cap", () => { const en = LAYOUT_ENTRIES(CH(18), ["smd-9.md", "---\n" + LONG]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["oversize"]],
  ["two files with one number", () => { const en = LAYOUT_ENTRIES(CH(18), ["018-other.md", "# 18. Other\n"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["duplicate"]],
  ["a gap", () => { const en = LAYOUT_ENTRIES(CH(18), CH(20)); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["gap"]],
  ["a missing 18", () => { const en = LAYOUT_ENTRIES(CH(19)); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["gap"]],
  ["no files at all", () => { const en = LAYOUT_ENTRIES(); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["no-files"]],
  ["a heading with the wrong number", () => { const en = LAYOUT_ENTRIES(["018-a-thing.md", "# 19. A thing\n"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["heading"]],
  ["no heading", () => { const en = LAYOUT_ENTRIES(["018-a-thing.md", "A thing\n"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["heading"]],
  ["an unlisted file over the cap", () => { const en = LAYOUT_ENTRIES(CH(18, undefined, LONG)); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["oversize"]],
  ["a listed file over its ceiling", () => { const en = LAYOUT_ENTRIES(CH(18, undefined, LONG)); return { entries: en, forkText: FORK_FOR(en), ceilings: { 18: 190 } }; }, ["oversize"]],
  ["a listed file under its ceiling", () => { const en = LAYOUT_ENTRIES(CH(18, undefined, LONG)); return { entries: en, forkText: FORK_FOR(en), ceilings: { 18: 210 } }; }, []],
  ["a listed file that now fits", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en), ceilings: { 18: 210 } }; }, ["excuse-stale"]],
  ["a listing with no file", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en), ceilings: { 44: 210 } }; }, ["excuse-stale"]],
  ["FORK.md over its ceiling", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en, "x".repeat(100)), ceilings: {}, forkCeiling: 150 }; }, ["fork-oversize"]],
  ["a numbered section left in FORK.md", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en, "\n### 19. Left behind\n"), ceilings: {} }; }, ["section-in-fork"]],
  ["no index markers", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: "# FORK\nno markers\n", ceilings: {} }; }, ["index-missing"]],
  ["a duplicated end marker", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en, INDEX_END + "\n"), ceilings: {} }; }, ["index-missing"]],
  ["a `## N.` section left in FORK.md", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en, "\n## 19. Left behind\n"), ceilings: {} }; }, ["section-in-fork"]],
  ["a change file's own `# N.` heading pasted into FORK.md", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en, "\n# 19. Pasted\n"), ceilings: {} }; }, ["section-in-fork"]],
  ["a leading zero in the heading", () => { const en = LAYOUT_ENTRIES(["018-a-thing.md", "# 018. A thing\n"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["heading"]],
  ["a stray file of another extension", () => { const en = LAYOUT_ENTRIES(CH(18), ["notes.txt", "x"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["bad-name"]],
  ["a directory (or symlink, or pipe) under changes/", () => { const en = LAYOUT_ENTRIES(CH(18), ["drafts", null]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["bad-name"]],
  ["a numbered file below 18", () => { const en = LAYOUT_ENTRIES(CH(18), ["005-below.md", "# 5. Below (SMD-1)\n"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["below-first"]],
  ["a dotfile the OS left", () => { const en = LAYOUT_ENTRIES(CH(18), [".DS_Store", "x"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, []],
  ["two fragments for one ticket", () => { const en = LAYOUT_ENTRIES(CH(18), ["smd-9.md", "---\n"], ["smd-09.md", "---\n"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["duplicate-fragment"]],
  ["a stale index (a numbered file added, FORK.md untouched)", () => { const en = LAYOUT_ENTRIES(CH(18), CH(19)); return { entries: en, forkText: FORK_FOR(en.slice(0, 1)), ceilings: {} }; }, ["index-stale"]],
  // A PR adds a fragment and nothing else; FORK.md is as main left it (SMD-2084).
  ["a fragment added, FORK.md untouched", () => { const en = LAYOUT_ENTRIES(CH(18), ["smd-9.md", "---\n"]); return { entries: en, forkText: FORK_FOR(en.slice(0, 1)), ceilings: {} }; }, []],
  ["a citation above the highest", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en), ceilings: {}, citations: [{ where: "a.ts:1", n: 19 }] }; }, ["dangling"]],
  ["a citation of change 0", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en), ceilings: {}, citations: [{ where: "a.ts:1", n: 0 }] }; }, ["dangling"]],
  ["a citation of a gapped number", () => { const en = LAYOUT_ENTRIES(CH(18), CH(20)); return { entries: en, forkText: FORK_FOR(en), ceilings: {}, citations: [{ where: "a.ts:1", n: 19 }] }; }, ["gap", "dangling"]],
  ["a path citation under an old slug", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en), ceilings: {}, citations: [{ where: "a.md:1", n: 18, name: "018-old-name.md" }, { where: "b.md:1", n: 18, name: "018-a-thing.md" }] }; }, ["dangling"]],
  ["a path citation of a table change (no file can exist)", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en), ceilings: {}, citations: [{ where: "a.md:1", n: 5, name: "005-below.md" }] }; }, ["dangling"]],
];

const SKIP_DIRS = new Set([...UNREAD_DIRS, ".planning", ".cf-out", "dist", "build", ".wrangler"]);
/**
 * Every text file a citation can live in: what git tracks plus what it would
 * track (untracked, not ignored) — so a change file not yet added is read, and a
 * pulled email under an ignored data/ directory, an .env or a local corpus is
 * not, as .gitignore promises of this check. Without git (a copied tree), a walk
 * that skips the usual build and tool directories, symlinks left alone. Binary
 * names and files over 4 MB are skipped either way. Repo-relative paths.
 */
function citationFiles() {
  let names: string[];
  try {
    // A nested repository (an agent worktree under .claude/) is listed as `dir/`,
    // a deleted-but-indexed file has no stat, a symlink is followed by nothing
    // here: regular files alone, as the walk below keeps. An untracked file a
    // harness left behind IS read — that is the rule, not a slip.
    names = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8", maxBuffer: Infinity })
      .split("\0").filter(Boolean);
  } catch (e) {
    console.warn(`  (git ls-files failed — ${(e as Error).message.split("\n")[0]} — walking the tree for citations, ignored files too)`);
    names = [];
    const walkFor = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walkFor(full); continue; }
        names.push(relative(ROOT, full).split(sep).join("/"));
      }
    };
    walkFor(ROOT);
  }
  const regular = (rel: string) => { try { const st = lstatSync(join(ROOT, rel)); return st.isFile() && st.size <= 4 * 1024 * 1024; } catch { return false; } };
  // Not this script: its probe strings are citation shapes, not citations.
  return names.filter((rel) => rel !== SELF && !BINARY_FILES.test(rel) && !rel.split("/").includes("node_modules") && regular(rel));
}

/** An offset → 1-based line number function for one text: the line starts are indexed once, then each lookup is a binary search. */
function lineIndexer(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (index: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; } return lo + 1; };
}

/** changes/ read once per run: the classified entries with their text, for checks 15, 16 and 17b. */
let changesCache: (ClassifiedChanges & { entries: ChangeEntry[] }) | null = null;
function changesOnDisk() {
  if (!changesCache) {
    const entries = readChangeEntries(ROOT);
    changesCache = { entries, ...classifyChanges(entries) };
  }
  return changesCache;
}

function checkForkLayout() {
  for (const [text, record, want] of CITATION_PROBES) {
    const got = citedChangesIn(text, { record }).map((c) => c.n);
    if (JSON.stringify(got) !== JSON.stringify(want)) fail(SELF, `check 15's citation reader returns [${got}] for ${JSON.stringify(text)}, expected [${want}] (its own probe)`);
  }
  // (this file is not among the files the reader scans, so its probes may cite dead links freely)
  const named = citedChangesIn('see changes/079-the-store-measured-against-pgvector.md and changes/080 and changes/081-The_Store.md and changes/082_x.md and [79](079-the-store.md) and [a](./079-a.md#top "t")', { record: true }).map((c) => c.name ?? null);
  if (JSON.stringify(named) !== JSON.stringify(["079-the-store-measured-against-pgvector.md", null, "081-The_Store.md", "082_x.md", "079-the-store.md", "079-a.md"])) fail(SELF, `check 15's citation reader keeps a slugged path's name (mis-cased, underscored, or a relative link inside the record too — a dead link on Linux), got ${JSON.stringify(named)} (its own probe)`);
  for (const [label, args, want] of LAYOUT_PROBES) {
    const got = forkLayoutProblems(args()).map((p) => p.kind);
    if (JSON.stringify(got) !== JSON.stringify(want)) fail(SELF, `check 15's layout decision reports [${got}] for ${label}, expected [${want}] (its own probe)`);
  }

  const forkText = readFileSync(join(ROOT, "FORK.md"), "utf8");
  const entries = changesOnDisk().entries; // every entry, any extension — a stray is a finding
  const citations: LayoutCitation[] = [];
  // A citation inside a fenced block or a code span counts: a quoted "change N" is
  // still a claim about the record (check 16 strips fences for its heading rule
  // alone, where a `# 1.` comment is not a heading).
  for (const rel of citationFiles()) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    const record = rel === "FORK.md" || rel.startsWith(`${CHANGES_DIR}/`);
    const found = citedChangesIn(text, { record });
    if (found.length === 0) continue;
    const lineAt = lineIndexer(text);
    for (const c of found) citations.push({ where: `${rel}:${lineAt(c.index)}`, n: c.n, ...(c.name ? { name: c.name } : {}) });
  }
  for (const p of forkLayoutProblems({ entries, forkText, citations })) fail(p.where, `${p.msg} (SMD-1917)`);
}
checkForkLayout();
// ── 16–17: fragments, the changelog and the freeze (SMD-1804) ────────────────
const KAC_HEADINGS = new Set(["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]);


/**
 * 16: a changes/<ticket>.md fragment is well-formed — fragmentProblems lives in
 * scripts/fragments.ts, one definition for this check and the release step. A fragment replaces the
 * hand-numbered FORK section for new work: front matter naming a Keep a Changelog
 * type, a bump the migrations it lists allow, and the tickets and migrations it
 * touches; a Changelog body (1–3 lines) and a FORK body. A `bump: patch` that
 * ships a migration is the rule from the version scheme; a numbered heading in
 * the FORK body (`### N.` / `# N.`) is the mistake the fragment format exists to
 * prevent — the number is assigned at release, so a fragment cannot know its own.
 * A citation of an existing change number is fine; check 15 holds every citation
 * to a file (SMD-1917). A path to another fragment is not: the cut numbers every
 * fragment and rewrites no mention, so a fragment names a change by its ticket, or
 * pins the path to a commit (SMD-2047).
 */

function checkFragments() {
  const goodFrag = "---\ntype: added\nbump: minor\ntickets: [SMD-1804, SMD-1805]\nmigrations: [044]\n---\n\n## Changelog\nThe fork gets a version (SMD-1804, SMD-1805).\n\n## FORK\nA title (SMD-1804 / 1805)\n\nBody citing SMD-1804, migration 044 and change 79.\n";
  if (fragmentProblems(goodFrag).length) fail(SELF, `check 16 false-positives on a valid fragment (${fragmentProblems(goodFrag).join("; ")})`);
  // Each probe isolates one rule: its other lines carry the ticket, so dropping
  // the rule it names is the only way it passes. A third element names the file.
  for (const [probe, why, name] of [
    ["---\ntype: added\nbump: patch\ntickets: [SMD-1]\nmigrations: [044]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\ny (SMD-1)\n", "a patch that ships a migration"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\nmigrations: []\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\n# 103. A title\n\nbody\n", "a numbered heading in the FORK body"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\nmigrations: []\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title (SMD-1)\n\n### 103. sub\n", "a numbered `### N.` heading in the FORK body"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\nmigrations: []\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\n### A title\n\nbody\n", "an unnumbered heading as the FORK body's title"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\nmigrations: []\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title that\nwraps (SMD-1)\n\nbody\n", "a title wrapped onto a second line"],
    ["---\ntype: added\nbump: patch2\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\ny (SMD-1)\n", "a bump off the three"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-x]\n---\n\n## Changelog\nx\n\n## FORK\ny\n", "a ticket that is not SMD-#### (no ticket on the lines, so only that rule fires)"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\nmigrations: [44]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\ny (SMD-1)\n", "a migration number of two digits"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\na (SMD-1)\nb\nc\nd\n\n## FORK\ny (SMD-1)\n", "a four-line Changelog body"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n", "a missing FORK body"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1, SMD-2]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title (SMD-1)\n\nbody\n", "a title that names one of the two tickets"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title\n\nbody\n", "a title that names no ticket"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\n\n## FORK\nA title (SMD-1)\n\nbody\n", "an empty Changelog body (which used to read the FORK section as its text)"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1, SMD-2]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title (SMD-1 / 2)\n\nbody\n", "a Changelog line that names one of the two tickets"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1), closing SMD-7's follow-up\n\n## FORK\nA title (SMD-1)\n\nbody\n", "a Changelog line naming a ticket the front matter does not"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\n- x (SMD-1)\n\n## FORK\nA title (SMD-1)\n\nbody\n", "a Changelog line that is already a bullet"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## FORK\nA title (SMD-1)\n\nbody\n\n## Changelog\nx (SMD-1)\n", "a Changelog section after the FORK body (which runs to the end of the file)"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## Notes\nkept nowhere\n\n## FORK\nA title (SMD-1)\n\nbody\n", "a section between Changelog and FORK, which the cut writes nowhere"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## Changelog\ny (SMD-1)\n\n## FORK\nA title (SMD-1)\n\nbody\n", "two Changelog sections"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n### Added\n\n## FORK\nA title (SMD-1)\n\nbody\n", "a heading inside the Changelog body"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title (SMD-1)\n\n##### 5. deep\n", "a numbered heading five levels deep in the FORK body"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1804]\n---\n\n## Changelog\nx (SMD-1804)\n\n## FORK\nA title (SMD-1804)\n\nbody\n", "a fragment named for a ticket its front matter does not list", "smd-1805.md"],
    ["---\ntype: whatever\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\ny (SMD-1)\n", "a type off the six"],
    ["---\ntype: added\nbump: minor\ntickets: []\n---\n\n## Changelog\nx\n\n## FORK\ny\n", "an empty ticket list (no ticket on the lines, so only that rule fires)"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\n", "an empty FORK section"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## FORK\ny (SMD-1)\n", "a missing Changelog body"],
    ["no front matter here\n", "no front matter"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\nmigrations: 045\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\ny (SMD-1)\n", "a scalar `migrations:` (read as none, it passed while the cut refused \"migration 000\" — SMD-1870)"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title (SMD-1)\n\nIts sibling `changes/smd-2.md` says why.\n", "a path to another fragment, which points at nothing once the cut numbers it (SMD-2047)"],
  ]) if (fragmentProblems(probe, name).length === 0) fail(SELF, `check 16 no longer catches ${why} (its own probe)`);
  for (const [probe, why] of [
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title (SMD-1)\n\n```bash\n# 1. install\n```\n\n#1. not a heading\n\n1. a list item\n\n## Measured after\n\nA second-level heading inside the record is kept, as changes 19 and 79 keep theirs.\n", "a numbered comment in a fenced block, a `#1.`, a list item and a `## ` sub-heading inside the record"],
    ["---\ntype: added        # one of the six\nbump: minor        # the rules\ntickets: [SMD-1804]        # one or more\nmigrations: [044]          # or [] for none\n---\n\n## Changelog\n\nx (SMD-1804, migration 044).\n\n## FORK\n\nA title (SMD-1804)\n\nbody\n", "the README's template copied with its inline comments"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title (SMD-1)\n\nThe mutant lists are at `fbedb39c:changes/smd-1.md`, and SMD-2's record says why; `changes/smd-NNNN.md` is the pattern.\n", "a fragment path pinned to a commit, a ticket named instead of a path, and the pattern written with letters"],
  ]) if (fragmentProblems(probe).length) fail(SELF, `check 16 refuses ${why}: ${fragmentProblems(probe).join("; ")} (its own non-probe)`);

  // Numbered files and stray names are check 15's; one definition of a fragment's name (fork-index.ts).
  for (const f of changesOnDisk().fragments) for (const p of fragmentProblems(f.text, f.name)) fail(`changes/${f.name}`, `${p} (SMD-1804)`);
}
checkFragments();

/**
 * 17a: CHANGELOG.md is Keep a Changelog 1.1.0 — Unreleased first, released
 * versions dated and newest-first, only the six headings under a version, and a
 * resolving compare link for every section. No back-fill: sections 1–100 of the
 * fork predate the first cut and live in FORK.md, so a fresh CHANGELOG has only
 * Unreleased until the first release is assembled.
 */
function changelogProblems(text: string) {
  const problems: string[] = [];
  const parts = text.split(/^## /m).slice(1);
  const titles = parts.map((p) => p.split("\n", 1)[0].trim());
  const sections = titles.filter((t) => t.startsWith("["));
  if (sections.length === 0 || sections[0] !== "[Unreleased]") problems.push("the first `## [..]` section must be `## [Unreleased]`");
  const versions: string[] = [];
  for (const part of parts) {
    const title = part.split("\n", 1)[0].trim();
    if (!title.startsWith("[") || title === "[Unreleased]") continue;
    const vm = /^\[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\] - (\d{4}-\d{2}-\d{2})$/.exec(title);
    if (!vm) { problems.push(`\`## ${title}\` is not \`[X.Y.Z] - YYYY-MM-DD\``); continue; }
    versions.push(vm[1]);
    for (const h3 of part.matchAll(/^### (.+)$/gm)) if (!KAC_HEADINGS.has(h3[1].trim())) problems.push(`\`[${vm[1]}]\` has heading \`### ${h3[1].trim()}\` — only ${[...KAC_HEADINGS].join("/")} are allowed`);
  }
  for (let i = 1; i < versions.length; i++) if (semverCompare(versions[i - 1], versions[i]) <= 0) problems.push(`versions are not newest-first: [${versions[i - 1]}] then [${versions[i]}]`);
  const linkTargets = new Set([...text.matchAll(/^\[([^\]]+)\]:\s*\S+/gm)].map((m) => m[1]));
  for (const v of ["Unreleased", ...versions]) if (!linkTargets.has(v)) problems.push(`no compare link \`[${v}]: …\` at the foot`);
  for (const t of linkTargets) if (t !== "Unreleased" && !versions.includes(t)) problems.push(`a compare link \`[${t}]\` names a version with no section`);
  return problems;
}
function checkChangelogShape() {
  const good = "# Changelog\n\n## [Unreleased]\n\n## [1.1.0] - 2026-10-01\n### Added\n- a thing (SMD-2)\n\n## [1.0.0] - 2026-09-30\n### Fixed\n- a thing (SMD-1)\n\n[Unreleased]: u\n[1.1.0]: u\n[1.0.0]: u\n";
  if (changelogProblems(good).length) fail(SELF, `check 17a false-positives on a valid changelog (${changelogProblems(good).join("; ")})`);
  for (const [probe, why] of [
    ["# Changelog\n\n## [1.0.0] - 2026-09-30\n### Added\n- x (SMD-1)\n\n[Unreleased]: u\n[1.0.0]: u\n", "no Unreleased first (its links present, so only that rule fires)"],
    ["# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n### Added\n- x\n\n[Unreleased]: u\n", "an undated version (no footer link for it, so only that rule fires)"],
    ["# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-09-30\n### Added\n- x\n\n[Unreleased]: u\n[1.0.0]: u\n[0.9.0]: u\n", "a compare link for a version with no section"],
    ["# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-09-30\n### Reworked\n- x\n\n[Unreleased]: u\n[1.0.0]: u\n", "a seventh heading"],
    ["# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-09-30\n### Added\n- x\n\n## [1.1.0] - 2026-10-01\n### Added\n- y\n\n[Unreleased]: u\n[1.0.0]: u\n[1.1.0]: u\n", "versions not newest-first"],
    ["# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-09-30\n### Added\n- x\n\n[1.0.0]: u\n", "a missing Unreleased compare link"],
  ]) if (changelogProblems(probe).length === 0) fail(SELF, `check 17a no longer catches ${why} (its own probe)`);

  const path = join(ROOT, "CHANGELOG.md");
  if (!existsSync(path)) return fail("CHANGELOG.md", "the fork's changelog is missing — Keep a Changelog 1.1.0, Unreleased first (SMD-1804)");
  for (const p of changelogProblems(readFileSync(path, "utf8"))) fail("CHANGELOG.md", `${p} (SMD-1804)`);
}
checkChangelogShape();

/** Tickets appearing in each released `## [X.Y.Z]` section of a changelog. */
function releasedChangelogTickets(text: string) {
  const out = new Map<string, Set<string>>();
  for (const part of text.split(/^## /m).slice(1)) {
    const title = part.split("\n", 1)[0].trim();
    if (!title.startsWith("[") || title === "[Unreleased]") continue;
    const vm = /^\[([^\]]+)\]/.exec(title);
    if (!vm) continue; // a `## [` heading with no `]`: checkChangelogShape has reported it; reading vm[1] threw and hid every violation (SMD-1870)
    out.set(vm[1], new Set([...part.matchAll(/\bSMD-(\d+)\b/g)].map((m) => `SMD-${m[1]}`)));
  }
  return out;
}
/**
 * 17b: each release pairs both ways. releases.json is the machine record the
 * assembler writes; CHANGELOG.md is the page; FORK.md holds the sections. A
 * released version must appear in all three with the same tickets: a CHANGELOG
 * entry whose ticket has no numbered change file, or a release whose version or tickets
 * the changelog does not match, is drift the assembler would have to have caused.
 * A no-op until the first release (releases.json is []).
 */
function pairingProblems(releases: readonly { version: string; tickets?: readonly string[] }[], changelogText: string, forkTickets: Set<string>) {
  const problems: string[] = [];
  const cl = releasedChangelogTickets(changelogText);
  // releases.json carries the full version (`1.0.0+upstream.<sha>`); a CHANGELOG
  // section title carries the core (`[1.0.0]`) — the assembler writes both, so
  // the pairing compares cores (found by assembling a release on a copy of the
  // tree: the first cut failed its own check both ways, SMD-1917).
  const core = (v: string) => String(v).split("+")[0];
  for (const r of releases) {
    if (!cl.has(core(r.version))) { problems.push(`release ${r.version} (releases.json) has no [${core(r.version)}] section in CHANGELOG.md`); continue; }
    const clTickets = cl.get(core(r.version))!; // has() just tested
    const rTickets = new Set(r.tickets ?? []);
    for (const t of rTickets) if (!clTickets.has(t)) problems.push(`release ${r.version} lists ${t} but its CHANGELOG section does not`);
    for (const t of clTickets) if (!rTickets.has(t)) problems.push(`CHANGELOG [${r.version}] names ${t} but releases.json does not`);
    for (const t of rTickets) if (!forkTickets.has(t)) problems.push(`release ${r.version} lists ${t} but no numbered change file's title names it — the release step did not number its fragment`);
  }
  const known = new Set(releases.map((r) => core(r.version)));
  for (const v of cl.keys()) if (!known.has(v)) problems.push(`CHANGELOG has a released [${v}] with no releases.json entry`);
  return problems;
}
function checkChangelogForkPairing() {
  const fork = new Set(["SMD-1"]);
  const clGood = "## [1.0.0] - 2026-09-30\n### Added\n- x (SMD-1)\n";
  if (pairingProblems([{ version: "1.0.0", tickets: ["SMD-1"] }], clGood, fork).length) fail(SELF, "check 17b false-positives on a matched release");
  if (pairingProblems([{ version: "1.0.0+upstream.9543c29", tickets: ["SMD-1"] }], clGood, fork).length) fail(SELF, "check 17b false-positives on a matched release whose releases.json version carries the +upstream build metadata (its own probe)");
  for (const [rel, cl, forks, why] of [
    [[{ version: "1.0.0", tickets: ["SMD-1"] }], "## [1.0.0] - 2026-09-30\n- x (SMD-2)\n", fork, "a ticket in releases.json missing from the changelog"],
    [[{ version: "1.0.0", tickets: ["SMD-1"] }], "## [Unreleased]\n", fork, "a release with no CHANGELOG section of its version (and no other section to blame)"],
    [[{ version: "1.0.0", tickets: ["SMD-1", "SMD-2"] }], "## [1.0.0] - 2026-09-30\n- x (SMD-1)\n", new Set(["SMD-1", "SMD-2"]), "a release ticket the CHANGELOG section omits (its other ticket present, so only that branch fires)"],
    [[{ version: "1.0.0", tickets: ["SMD-1"] }], "## [1.0.0] - 2026-09-30\n- x (SMD-1)\n- y (SMD-2)\n", new Set(["SMD-1", "SMD-2"]), "a changelog ticket missing from releases.json"],
    [[{ version: "1.0.0", tickets: ["SMD-9"] }], "## [1.0.0] - 2026-09-30\n- x (SMD-9)\n", fork, "a released ticket with no FORK section"],
    [[], "## [1.0.0] - 2026-09-30\n- x (SMD-1)\n", fork, "a changelog release with no releases.json entry"],
  ] as const) if (pairingProblems(rel, cl, forks).length === 0) fail(SELF, `check 17b no longer catches ${why} (its own probe)`);
  // A malformed heading is check 17a's finding; the ticket reader skips it rather than throwing on it (a TypeError here hid every violation, SMD-1870).
  let skipped = false;
  try { skipped = releasedChangelogTickets("## [Unreleased]\n\n## [1.0.0 - 2026-09-30\n- x (SMD-1)\n").size === 0; } catch { /* the TypeError the guard removes */ }
  if (!skipped) fail(SELF, "check 17b's ticket reader no longer skips a `## [` heading with no closing bracket — it throws on it, or reads it as a version (its own probe)");

  const clPath = join(ROOT, "CHANGELOG.md");
  if (!existsSync(clPath)) return;
  // A released ticket has a record: a numbered change file whose TITLE ends in it
  // (ticketOf expands "(SMD-1301 / 1302)" to both; check 16 makes the release
  // step's title name every front-matter ticket). Neither FORK.md's text nor a
  // change file's body is a source: both name pending tickets in prose, which
  // would let a release that left a fragment unnumbered pass — the drift this
  // catches (SMD-1917).
  const recordTickets = new Set<string>();
  for (const c of changesOnDisk().numbered) for (const t of ticketsOf(c.heading?.title ?? "")) recordTickets.add(t);
  for (const p of pairingProblems(readReleases(), readFileSync(clPath, "utf8"), recordTickets)) fail("CHANGELOG.md", `${p} (SMD-1804)`);
}
checkChangelogForkPairing();

/**
 * 17c: a migration inside a released range keeps the sha the release froze. The
 * ledger's own sha check refuses drift at apply time; this refuses an EDIT to a
 * released migration at review time — the rule the version scheme adds. Each
 * releases.json entry records the sha of every migration in its range; a file
 * whose template now hashes to something else, or is gone, has been edited after
 * it was frozen. A no-op until the first release.
 */
function checkFrozenMigrations() {
  const migDir = join(ROOT, "db", "migrations");
  const shaOf = (num: number) => {
    const f = readdirSync(migDir).find((n) => n.startsWith(pad3(num) + "_"));
    return f ? migrationSha(readFileSync(join(migDir, f), "utf8")) : null;
  };
  // Self-test: a frozen sha that no longer matches, and a missing file, are caught.
  const real = readdirSync(migDir).filter((n) => /^\d{3}_/.test(n)).sort()[0];
  const realNum = Number(real.slice(0, 3));
  const realSha = migrationSha(readFileSync(join(migDir, real), "utf8"));
  const okRel = [{ version: "9.9.9", range: [realNum, realNum], frozenShas: { [pad3(realNum)]: realSha } }];
  if (frozenProblems(okRel, shaOf).length) fail(SELF, "check 17c false-positives on an unchanged frozen migration");
  const badRel = [{ version: "9.9.9", range: [realNum, realNum], frozenShas: { [pad3(realNum)]: "000000000000" } }];
  if (frozenProblems(badRel, shaOf).length === 0) fail(SELF, "check 17c no longer catches an edited frozen migration (its own probe)");
  const goneRel = [{ version: "9.9.9", range: [999, 999], frozenShas: { "999": "abc" } }];
  if (frozenProblems(goneRel, shaOf).length === 0) fail(SELF, "check 17c no longer catches a missing frozen migration (its own probe)");

  for (const p of frozenProblems(readReleases(), shaOf)) fail("db/migrations", `${p} (SMD-1804)`);
}
function frozenProblems(releases: readonly { version: string; range: readonly number[] | null; frozenShas?: Record<string, string> }[], shaOf: (num: number) => string | null) {
  const problems: string[] = [];
  for (const r of releases) {
    if (!r.range) continue; // a docs/server-only release froze no migration range
    const [lo, hi] = r.range;
    for (let n = lo; n <= hi; n++) {
      const frozen = (r.frozenShas ?? {})[pad3(n)];
      if (!frozen) { problems.push(`release ${r.version} froze range ${pad3(lo)}..${pad3(hi)} but records no sha for migration ${pad3(n)}`); continue; }
      const now = shaOf(n);
      if (now === null) problems.push(`migration ${pad3(n)} is inside released range ${r.version} but has no file — a released migration cannot be removed`);
      else if (now !== frozen) problems.push(`migration ${pad3(n)} was frozen at ${frozen} by release ${r.version} but now hashes to ${now} — a released migration is append-only, add a new file instead of editing it`);
    }
  }
  return problems;
}
checkFrozenMigrations();

/**
 * 17d: the version a brain reports equals the version the tooling computes. The
 * highest-numbered migration that writes ob1_config.schema_version writes the
 * current version; it must be exactly db/version.mjs's FORK_VERSION, so the
 * string a brain reports (044 at the baseline, a later set-version migration
 * after a cut) and the string preflight and the assembler use cannot drift.
 */
function checkSchemaVersion() {
  // Self-test: the two INSERT shapes are read, a migration that writes no
  // schema_version is not mistaken for one that does. The reader is
  // db/version.mjs's schemaVersionValue, shared with assemble-release.ts, which
  // refuses a cut whose highest migration does not write the version (SMD-1860).
  if (schemaVersionValue("INSERT INTO ob1_config (key, value) VALUES\n  ('schema_version', '1.2.3+upstream.abc')\nON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;") !== "1.2.3+upstream.abc")
    fail(SELF, "check 17d no longer reads the schema_version an INSERT writes (its own probe)");
  if (schemaVersionValue("INSERT INTO ob1_config (key, value) VALUES ('embedding_dim', '1024');") !== null)
    fail(SELF, "check 17d reads a schema_version from a migration that writes none (its own probe)");

  const migDir = join(ROOT, "db", "migrations");
  const writers: { num: number; name: string; value: string }[] = [];
  for (const name of readdirSync(migDir).filter((n) => /^\d{3}_.*\.sql$/.test(n))) {
    const value = schemaVersionValue(readFileSync(join(migDir, name), "utf8"));
    if (value !== null) writers.push({ num: Number(name.slice(0, 3)), name, value });
  }
  if (writers.length === 0) return fail("db/migrations", "no migration writes ob1_config.schema_version — migration 044 should (SMD-1804)");
  writers.sort((a, b) => a.num - b.num);
  const current = writers[writers.length - 1];
  if (current.value !== FORK_VERSION) fail(`db/migrations/${current.name}`, `writes schema_version '${current.value}' but db/version.mjs's FORK_VERSION is '${FORK_VERSION}' — the brain would report a version the tooling does not (SMD-1804)`);
}
checkSchemaVersion();

/**
 * 17e: server-portable/version.ts is generated (SMD-2041) — the version, the
 * release range and the tree's last migration the server reports, in a module
 * with no imports (the image carries no db/migrations/ to read). It must be
 * exactly what scripts/gen-version.ts renders, so a migration added or a cut
 * made without regenerating it fails here rather than a brain reporting the
 * previous tree. Bun-only, like the tools.json round-trip.
 */
async function checkVersionModule() {
  let renderVersionTs: () => string;
  try {
    ({ renderVersionTs } = await import("./gen-version.ts"));
  } catch (e) {
    // As the tools.json round-trip: a skip only off bun.
    if (typeof Bun !== "undefined") return fail("scripts/gen-version.ts", `does not import (${(e as Error).message.split("\n")[0]}) — check 17e cannot run (SMD-2041)`);
    console.warn(`  (version.ts round-trip skipped — ${(e as Error).message.split("\n")[0]} — run under bun)`);
    return;
  }
  const rel = "server-portable/version.ts";
  const path = join(ROOT, rel);
  if (!existsSync(path)) return fail(rel, "missing — run `bun scripts/gen-version.ts` (SMD-2041)");
  if (readFileSync(path, "utf8") !== renderVersionTs())
    fail(rel, "does not match what scripts/gen-version.ts renders from db/version.mjs, releases.json and db/migrations/ — the server would report a version, release range or last migration other than this tree's; run `bun scripts/gen-version.ts` to regenerate (SMD-2041)");
}
await checkVersionModule();

/**
 * 18: one type surface across the type-checked directories, and a CI step
 * for each — see the header. The rule is one pure function over in-memory
 * records, probed below, so a package.json that stops pinning, a tsconfig that
 * drifts, or a workflow that loses (or grows) a tsc step fails here by name.
 * `server-portable` is the reference: the others import its files, so its
 * pins are the ones a second copy would collide with.
 */
const TYPECHECKED_DIRS = ["server-portable", "compat/supabase-sql", "db", "evals", "scripts", "jev", "deploy/auth", "rest-client", "mcp-server"];
const TYPE_PINS = ["@types/bun", "typescript", "@types/node"];
const WORKFLOW = ".github/workflows/fork-checks.yml";
const TSC_STEP = /^\s*bunx tsc --noEmit\s*$/;
/** The script that type-checks the directories it names side by side (SMD-3202), each relative to the repository root; a step that runs it is a tsc step for each. Its whole `run:`, as TSC_STEP's is. */
const TSC_SCRIPT = ".github/ci/typecheck.sh";
const TSC_SCRIPT_STEP = /^\s*\.github\/ci\/typecheck\.sh((?:[ \t]+[A-Za-z0-9_.\/-]+)+)\s*$/;
/** Any `run:` that invokes the script, at a command's start (`bash` or `./` in front allowed): one TSC_SCRIPT_STEP does not read is named as that. A mention of it (shellcheck, echo) is not an invocation. */
const TSC_SCRIPT_RUN = /(?:^|[;&|(])[ \t]*(?:(?:bash|sh)[ \t]+)?(?:\.\/)?\.github\/ci\/typecheck\.sh(?:\s|$)/m;
/** What check 18 compares: each directory's package.json and tsconfig.json as read (absent when the file is), and the workflow's tsc steps by directory. */
type PackageJson = { devDependencies?: Record<string, string> };
type TsConfig = { compilerOptions?: Record<string, unknown> };
type TypecheckSurface = { packages: Record<string, PackageJson | undefined>; tsconfigs: Record<string, TsConfig | undefined>; tscSteps: string[] };
/** The probe's surface: every directory present with every field, so a mutation can reach in. */
type TypecheckProbe = { packages: Record<string, { devDependencies: Record<string, string> }>; tsconfigs: Record<string, { compilerOptions: Record<string, unknown> }>; tscSteps: string[] };
/** .github/workflows/fork-checks.yml as tscStepsIn reads it: jobs, their steps, a step's `run` and `working-directory` — every level optional, as the `?.`s say. */
type WorkflowDoc = { jobs?: Record<string, { steps?: { run?: unknown; "working-directory"?: string }[] } | undefined> } | null | undefined;
function typecheckSurfaceProblems({ packages, tsconfigs, tscSteps }: TypecheckSurface) {
  const problems: [string, string][] = [];
  const ref = TYPECHECKED_DIRS[0];
  const refDev = packages[ref]?.devDependencies ?? {};
  // Keys sorted at every depth (a nested object such as `paths` compares by
  // content, not insertion order); arrays keep their order, since `types`
  // and `lib` are ordered.
  const sortKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)])) : v);
  const canon = (o: unknown) => JSON.stringify(sortKeys(o ?? {}));
  const refOpts = canon(tsconfigs[ref]?.compilerOptions);
  for (const dir of TYPECHECKED_DIRS) {
    const dev = packages[dir]?.devDependencies;
    if (!dev) problems.push([`${dir}/package.json`, `${packages[dir] ? "has no devDependencies" : "is missing"} — every type-checked directory pins ${TYPE_PINS.join(", ")} in its devDependencies (SMD-1932)`]);
    else for (const name of TYPE_PINS) {
      if (!(name in dev)) problems.push([`${dir}/package.json`, dir === ref ? `does not pin ${name} — it is the reference the other type-checked directories are held to (SMD-1932)` : `does not pin ${name}; ${ref}/package.json pins it at ${refDev[name] ?? "(nothing)"} (SMD-1932)`]);
      else if (dir !== ref && dev[name] !== refDev[name]) problems.push([`${dir}/package.json`, `pins ${name} at ${dev[name]} but ${ref}/package.json pins ${refDev[name]} — bump every type-checked directory in one commit, or two copies of the types load into the programs that import ../server-portable (SMD-1932)`]);
    }
    const opts = tsconfigs[dir]?.compilerOptions;
    if (!opts) problems.push([`${dir}/tsconfig.json`, `missing, or has no compilerOptions (SMD-1932)`]);
    else if (dir !== ref && canon(opts) !== refOpts) problems.push([`${dir}/tsconfig.json`, `compilerOptions differ from ${ref}/tsconfig.json's: ${canon(opts)} vs ${refOpts} (SMD-1932)`]);
    const n = tscSteps.filter((d) => d === dir).length;
    if (n !== 1) problems.push([WORKFLOW, `runs \`bunx tsc --noEmit\` under ${dir} ${n} time(s); exactly one typecheck per type-checked directory, its own step or a .github/ci/typecheck.sh step naming it (SMD-1932)`]);
  }
  for (const d of tscSteps) if (!TYPECHECKED_DIRS.includes(d)) problems.push([WORKFLOW, `runs \`bunx tsc --noEmit\` under ${d}, which TYPECHECKED_DIRS in ${SELF} does not name — add it there, with its pins and tsconfig, or take it out of the step that type-checks it (SMD-1932)`]);
  return problems;
}
/**
 * A SvelteKit directory's typecheck as CI writes it: `bun run check` (svelte-kit
 * sync, then svelte-check) in a step's working-directory, the whole command
 * (SMD-2280 PR 2b). Not a tsc step for check 18 — the directory's tsconfig
 * extends the one `svelte-kit sync` generates, and its pins are SvelteKit's —
 * but check 35's typecheck all the same, which ci-parity.sh's `typecheck DIR`
 * runs the same way for a directory holding svelte.config.js.
 */
const SVELTE_CHECK_STEP = /^\s*bun run check\s*$/;
function svelteCheckStepsIn(doc: WorkflowDoc): string[] {
  const out: string[] = [];
  for (const job of Object.values(doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (typeof step?.run === "string" && SVELTE_CHECK_STEP.test(step.run)) out.push(posix.normalize(step["working-directory"] ?? "."));
    }
  }
  return out;
}
/** Each directory a parsed workflow type-checks, in order: a `bunx tsc --noEmit` step's working-directory, and each directory a TSC_SCRIPT step names. */
function tscStepsIn(doc: WorkflowDoc) {
  const out: string[] = [];
  for (const job of Object.values(doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (typeof step?.run !== "string") continue;
      if (TSC_STEP.test(step.run)) out.push(step["working-directory"] ?? ".");
      const named = TSC_SCRIPT_STEP.exec(step.run);
      if (named) out.push(...named[1].trim().split(/\s+/).map((d) => posix.normalize(d).replace(/\/+$/, "")));
    }
  }
  return out;
}
function checkTypecheckSurface() {
  // Self-test: a consistent set passes; one drifted pin, one missing pin, one
  // differing option, one missing step and one unlisted step each report
  // exactly one problem.
  const good = (): TypecheckProbe => ({
    packages: Object.fromEntries(TYPECHECKED_DIRS.map((d) => [d, { devDependencies: { "@types/bun": "1.4.0", typescript: "5.9.3", "@types/node": "26.6.2" } }])),
    tsconfigs: Object.fromEntries(TYPECHECKED_DIRS.map((d) => [d, { compilerOptions: { strict: true, types: ["bun"] } }])),
    tscSteps: [...TYPECHECKED_DIRS],
  });
  if (typecheckSurfaceProblems(good()).length) fail(SELF, `check 18 false-positives on a consistent surface (${typecheckSurfaceProblems(good()).map((p) => p[1]).join("; ")})`);
  for (const [why, mutate] of [
    ["a drifted pin", (g: TypecheckProbe) => { g.packages.db.devDependencies.typescript = "5.9.4"; }],
    ["a missing pin", (g: TypecheckProbe) => { delete g.packages.evals.devDependencies["@types/node"]; }],
    ["a differing compilerOption", (g: TypecheckProbe) => { g.tsconfigs.evals.compilerOptions.strict = false; }],
    ["a missing tsc step", (g: TypecheckProbe) => { g.tscSteps = g.tscSteps.filter((d) => d !== "db"); }],
    ["a tsc step under an unlisted directory", (g: TypecheckProbe) => { g.tscSteps.push("recipes/x"); }],
  ] as const) {
    const g = good(); mutate(g);
    const got = typecheckSurfaceProblems(g);
    if (got.length !== 1) fail(SELF, `check 18 reports ${got.length} problem(s) for ${why}, not one (its own probe): ${JSON.stringify(got)}`);
  }
  // The reader: a step of its own, and each directory a TSC_SCRIPT step names; not the script with none, nor a step that only mentions it.
  const read = tscStepsIn({ jobs: { a: { steps: [
    { run: "bunx tsc --noEmit", "working-directory": "x" }, { run: `${TSC_SCRIPT} a b/c ./d` }, { run: TSC_SCRIPT }, { run: `echo ${TSC_SCRIPT} z` }, { run: `${TSC_SCRIPT} e && bun f.ts` }, { run: `${TSC_SCRIPT} g/\n` },
  ] } } });
  const invoked = [`${TSC_SCRIPT} a`, `bash ${TSC_SCRIPT} a`, `./${TSC_SCRIPT} a`, `|\n  ${TSC_SCRIPT} a \\\n    b`, `cd x && ${TSC_SCRIPT} a`].every((r) => TSC_SCRIPT_RUN.test(r)) && ![`shellcheck ${TSC_SCRIPT}`, `echo ${TSC_SCRIPT} z`, `bash db/typecheck.sh`].some((r) => TSC_SCRIPT_RUN.test(r));
  if (!invoked) fail(SELF, `check 18 no longer tells an invocation of ${TSC_SCRIPT} from a mention of it (SMD-3202)`);
  if (JSON.stringify(read) !== JSON.stringify(["x", "a", "b/c", "d", "g"])) fail(SELF, `check 18 no longer reads its probe's tsc steps as ["x","a","b/c","d","g"] (read ${JSON.stringify(read)}) (SMD-3202)`);

  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    fail(SELF, `check 18 parses ${WORKFLOW} with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-1932)`);
    return;
  }
  const readJson = (rel: string) => (existsSync(join(ROOT, rel)) ? JSON.parse(readFileSync(join(ROOT, rel), "utf8")) : undefined);
  const packages = Object.fromEntries(TYPECHECKED_DIRS.map((d) => [d, readJson(`${d}/package.json`)]));
  const tsconfigs = Object.fromEntries(TYPECHECKED_DIRS.map((d) => [d, readJson(`${d}/tsconfig.json`)]));
  const doc = Bun.YAML.parse(readFileSync(join(ROOT, WORKFLOW), "utf8")) as WorkflowDoc;
  // One walk over the steps for the script: a step it reads makes check 18 run the script below; one running it in
  // a form the reader does not take counts for nothing, every directory it names reading as untype-checked, so it
  // is said once, first, as that (review pass 3).
  let usesScript = false;
  for (const job of Object.values(doc?.jobs ?? {})) for (const step of job?.steps ?? []) {
    if (typeof step?.run !== "string") continue;
    if (TSC_SCRIPT_STEP.test(step.run)) usesScript = true;
    else if (TSC_SCRIPT_RUN.test(step.run))
      fail(WORKFLOW, `runs ${TSC_SCRIPT} in a form check 18 cannot read (${JSON.stringify(step.run.trim().slice(0, 80))}), so the directories it names count as untype-checked below — write the whole \`run:\` as \`${TSC_SCRIPT} DIR…\`: one line or a \`>-\` folded scalar, no \`./\`, \`bash\`, \`\\\` or comment (SMD-3202)`);
  }
  const tscSteps = tscStepsIn(doc);
  for (const [where, msg] of typecheckSurfaceProblems({ packages, tsconfigs, tscSteps })) fail(where, msg);
  // A step naming directories counts only while the script type-checks each of them and fails on any: run, it is held to that.
  if (usesScript) for (const problem of typecheckScriptProblems(join(ROOT, TSC_SCRIPT))) fail(TSC_SCRIPT, `${problem} (SMD-3202)`);
}
/**
 * TSC_SCRIPT run against a stub `bunx` over directories of a scratch tree, named
 * relative to the repository root as the step names them, from another working
 * directory. The stub logs each call's directory and arguments; where a `fail`
 * file holds an exit code it prints a line on stdout (where tsc prints its
 * diagnostics) and one on stderr, and exits with that code. One failing
 * directory's stub waits until another's call is logged, so the two run side by
 * side and finish in a known order. Three runs — fail, pass, fail, pass; pass,
 * pass; pass, fail — each held to check 18's promise (a tsc in each directory,
 * once, exactly `tsc --noEmit`; the run failing if any fails, passing if none
 * does) and to what the step's log is for (each failing directory's line, with
 * its own exit code, in the order named; its own output under it, both streams,
 * and no other's; not folded). Review passes 1–5 found a text guard and then
 * four smaller probes each passing edits that broke one of these; pass 5
 * enumerated the contract and this covers every plausible edit it found.
 */
function typecheckScriptProblems(script: string): string[] {
  if (!existsSync(script)) return ["is missing, so nothing type-checks the directories a step names to it — check 18 counts a step naming directories to it as their typecheck"];
  const tmp = mkdtempSync(join(tmpdir(), "ob1-check18-"));
  try {
    const stub = join(tmp, "bin");
    mkdirSync(stub);
    writeFileSync(join(stub, "bunx"), [
      "#!/bin/sh",
      `printf '%s %s\\n' "$PWD" "$*" >> "$TSC_STUB_LOG"`,
      // Side by side: wait (2 s at most) for the named directory's call, then a moment for it to finish first.
      `if [ -f wait-for ]; then w=$(cat wait-for); n=0; until grep -qF "$w tsc" "$TSC_STUB_LOG" || [ "$n" -ge 200 ]; do sleep 0.01; n=$((n + 1)); done; [ "$n" -ge 200 ] && echo "barrier timed out" >> "$TSC_STUB_LOG"; sleep 0.05; fi`,
      `echo "stub tsc in $PWD"`,
      `if [ -f fail ]; then echo "stub type error in $PWD"; echo "stub stderr in $PWD" >&2; exit "$(cat fail)"; fi`,
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(join(stub, "bunx"), 0o755);
    const dir = (name: string, failCode?: number, waitFor?: string) => {
      const d = join(tmp, name);
      mkdirSync(d);
      writeFileSync(join(d, "tsconfig.json"), "{}");
      if (failCode !== undefined) writeFileSync(join(d, "fail"), String(failCode));
      if (waitFor) writeFileSync(join(d, "wait-for"), waitFor);
      return d;
    };
    const c = dir("c", 137);
    const [a, b, d, e] = [dir("a", 2, c), dir("b"), dir("d"), dir("e", 1)];
    const failCode = new Map([[a, 2], [c, 137], [e, 1]]);
    // BASH_ENV and ENV would run a file of the caller's before the script, and could put another bunx ahead of the stub.
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${stub}:${process.env.PATH}`, BASH_ENV: undefined, ENV: undefined };
    const rel = (x: string) => relative(ROOT, x);
    // Run from a directory nested deeper than the repository root is deep, so the step's relative directories
    // resolve only from the root: from here their `..`s stay inside the scratch tree (review pass 5: from a
    // shallow directory they climbed to / and resolved anyway, and a script that dropped its `cd` passed).
    const cwd = join(tmp, ...Array(ROOT.split(sep).filter(Boolean).length + 1).fill("w"));
    mkdirSync(cwd, { recursive: true });
    const short = (x: string) => x.replace(tmp, "…").replace(rel(tmp), "…");
    const run = (dirs: string[], label: string) => {
      const log = join(tmp, `${label}.log`);
      writeFileSync(log, "");
      const r = Bun.spawnSync(["bash", script, ...dirs.map(rel)], { cwd, env: { ...env, TSC_STUB_LOG: log }, stdout: "pipe", stderr: "pipe" });
      const logged = readFileSync(log, "utf8").split("\n").filter(Boolean);
      return { dirs, label, code: r.exitCode, lines: `${r.stdout.toString()}${r.stderr.toString()}`.split("\n"), calls: logged.filter((x) => x !== "barrier timed out"), serial: logged.includes("barrier timed out") };
    };
    let runs: ReturnType<typeof run>[];
    try { runs = [run([a, b, c, d], "fail, pass, fail, pass"), run([b, d], "pass, pass"), run([b, e], "pass, fail")]; }
    catch (err) { return [`cannot be run to hold it (${(err as Error).message.split("\n")[0]}): check 18 runs it with bash, which must be on PATH`]; }
    const promise = "check 18 counts a step naming directories to it as their typecheck";
    const forLog = "the step's log is how a failure names its directory";
    const exactly = "the command is held to `bunx tsc --noEmit` exactly, as a step of its own is, so no flag (--noCheck) can weaken it; an option belongs in the directory's tsconfig.json";
    const head = "::error title=Typecheck::tsc --noEmit in ";
    const problems: string[] = [];
    for (const r of runs) {
      const failing = r.dirs.filter((x) => failCode.has(x));
      const on = `on ${r.label}`;
      if (failing.length ? r.code === 0 : r.code !== 0) problems.push(`exits ${r.code} ${on}, where ${failing.length ? "a failure must fail the run" : "every tsc passed"} — ${promise}`);
      if (r.serial) problems.push(`runs the directories one after another ${on}, not side by side — the step exists to run them side by side`);
      if (!(r.calls.length === r.dirs.length && r.dirs.every((x) => r.calls.filter((y) => y === `${x} tsc --noEmit`).length === 1))) {
        problems.push(`runs ${JSON.stringify(r.calls.map(short))} ${on}, not one \`bunx tsc --noEmit\` in each directory — ${promise}; ${exactly}`);
        continue;
      }
      // Each failing directory's line, in the order named, with its own exit code; its section (to the next ::error or ::group::) holding its own output, both streams, and no other directory's; no group open around it.
      const named = r.lines.flatMap((l, i) => (l.startsWith(head) ? [i] : []));
      const want = failing.map((x) => `${head}${rel(x)} failed (exit ${failCode.get(x)})`);
      const got = named.map((i) => r.lines[i]);
      if (got.length !== want.length || !want.every((w, k) => got[k] === w || got[k].startsWith(`${w} `))) {
        problems.push(`names ${JSON.stringify(got.map(short))} ${on}, not ${JSON.stringify(want.map(short))}: each failing directory's line starts \`${head}DIR failed (exit N)\`, N its tsc's own exit code, in the order named — ${forLog}`);
        continue;
      }
      let open = false;
      r.lines.forEach((l, i) => {
        if (l.startsWith("::group::")) open = true;
        else if (l.startsWith("::endgroup::")) open = false;
        else if (named.includes(i) && open) problems.push(`folds ${short(l.slice(head.length))}'s failure inside a group ${on}: a failing directory's output is left open — ${forLog}`);
      });
      for (const [k, i] of named.entries()) {
        const x = failing[k];
        const stop = r.lines.findIndex((l, j) => j > i && (l.startsWith("::error") || l.startsWith("::group::")));
        const section = r.lines.slice(i + 1, stop === -1 ? r.lines.length : stop);
        if (!section.includes(`stub type error in ${x}`) || !section.includes(`stub stderr in ${x}`)) problems.push(`does not print ${short(rel(x))}'s tsc output, stdout and stderr, under its failure ${on} (tsc writes its diagnostics to stdout) — ${forLog}`);
        const others = r.dirs.filter((y) => y !== x && section.some((l) => l.endsWith(` in ${y}`)));
        if (others.length) problems.push(`prints ${JSON.stringify(others.map((y) => short(rel(y))))}'s output under ${short(rel(x))}'s failure ${on}, as if theirs were its — ${forLog}`);
      }
    }
    return [...new Set(problems)];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
checkTypecheckSurface();
// ── 19: the connector registry (SMD-1933) ────────────────────────────────────
/**
 * A registry every rule accepts, in memory, against a tree of two contributions
 * and a disposition table naming one of them: the baseline the mutants below
 * are measured from. Each mutant changes one thing and must produce exactly
 * the kinds listed — so a rule that stops firing is caught, and a rule that
 * fires on the baseline is caught first.
 */
/** The probe tree: registryProblems' Tree with the disposition table present, so a tree mutant can append to it. */
type ProbeTree = Tree & { dispositionText: string };
/** A pinned facet as the probe declares it; `family`'s `values` is the string "families", the other four are lists. */
type ProbeFacet = { stability: string; values: unknown[] | string };
/** A probe capability: the seven keys as strings, `fetcher` optional (one mutant deletes it), any other key settable (one adds a sixth). */
type ProbeCapability = { vendor: string; family: string; transport: string; direction: string; cardinality: string; round_trip: string; fetcher?: string; note?: string; [k: string]: unknown };
type ProbeArtifact = { path: string; capabilities: ProbeCapability[] };
/**
 * The baseline registry, every block present and every key a string, so a
 * mutant can reach in — the strict counterpart of connector-registry.ts's
 * loose Registry (the probe is assignable to it). The families reuse the loose
 * Family: a probe family is a reserved one or a full one, the rules read both.
 */
type ProbeRegistry = {
  facets: Record<string, ProbeFacet>;
  fetchers: Record<string, string>;
  families: Record<string, Family>;
  connectors: Record<string, { direction: string; note?: string }>;
  artifacts: ProbeArtifact[];
  not_connectors: { services: { pattern: string; reason?: string }[]; artifacts: Record<string, string> };
};
/**
 * A probe registry with one block reshaped: the parameter type of a mutant
 * that breaks a block's shape (an object for the artifacts list, a string for
 * a capability, null for a family) — wider than ProbeRegistry, so the closure
 * still fits the table's `(r: ProbeRegistry) => void`.
 */
type ProbeWith<K extends keyof ProbeRegistry, T> = Omit<ProbeRegistry, K> & Record<K, T>;
/** [why, mutate, want, tree?]: a mutant of the baseline registry, the kinds it must produce, and (a fourth element) null for a null registry or a function that reshapes the tree. */
type RegistryProbe = [why: string, mutate: (r: ProbeRegistry) => void, want: string[], tree?: ((t: ProbeTree) => void) | null];
const PROBE_TREE = (): ProbeTree => ({
  existingDirs: ["integrations/acme-capture", "recipes/acme-digest", "recipes/plain-tool"],
  metadataByPath: new Map([
    ["integrations/acme-capture", { requires: { services: ["Acme Chat API", "OpenRouter"] }, tags: ["messaging"], connectors: ["acme"] }],
    ["recipes/acme-digest", { requires: { services: ["Acme Chat API (optional)"] }, tags: ["digest"], connectors: ["acme"] }],
    ["recipes/plain-tool", { requires: { services: ["Supabase"] }, tags: ["ops"] }],
  ]),
  dispositionText: "### `integrations/` (1)\n\n| Artifact | Disposition | Justification |\n|---|---|---|\n| `acme-capture` | keep + audited → fold-in **SMD-1867** | a capture source |\n",
});
const PROBE_REGISTRY = (): ProbeRegistry => ({
  facets: {
    ...Object.fromEntries(Object.entries(FACET_SETS).map(([k, v]) => [k, { stability: v.stability, values: [...v.values] }])),
    family: { stability: "open", values: "families" },
  },
  fetchers: Object.fromEntries(FETCHERS.map((f) => [f, "x"])),
  families: {
    "message-stream/chat": { item: "a message", grouping_key: "thread", default_cardinality: "1:1", canonical: "c", text: "t", edges: ["e"], metadata: ["m"], identity: "i", typical_transport: ["push"], dividing_line: "d" },
    "notification-target": { reserved: true, direction: "sink", note: "held" },
  },
  connectors: { acme: { direction: "bidirectional" } },
  artifacts: [
    { path: "integrations/acme-capture", capabilities: [{ vendor: "acme", family: "message-stream/chat", transport: "push", direction: "source", cardinality: "1:1", round_trip: "read-only", fetcher: "native-driver" }] },
    { path: "recipes/acme-digest", capabilities: [{ vendor: "acme", family: "message-stream/chat", transport: "push", direction: "sink", cardinality: "many:1", round_trip: "read-only", fetcher: "native-driver", note: "n" }] },
  ],
  not_connectors: {
    services: [{ pattern: "openrouter", reason: "a model provider" }, { pattern: "supabase", reason: "hosting" }],
    artifacts: {},
  },
});
const REGISTRY_PROBES: RegistryProbe[] = [
  ["a transport off the near-closed set (webhook-push)", (r) => { r.artifacts[0].capabilities[0].transport = "webhook-push"; }, ["capability-value"]],
  ["a fourth transport added to the registry's own set", (r) => { (r.facets.transport.values as unknown[]).push("stream"); }, ["facet-set"]], // the four pinned facets' values are lists; only `family`'s is the string (ProbeFacet)
  ["a sixth facet", (r) => { r.facets.protocol = { stability: "open", values: ["http"] }; }, ["facet-set"]],
  ["a fifth fetcher kind", (r) => { r.fetchers.cron = "x"; }, ["fetcher-set"]],
  ["a capability naming an undeclared family", (r) => { r.artifacts[0].capabilities[0].family = "mailbox/email"; }, ["capability-family"]],
  ["a capability using the reserved family", (r) => { r.artifacts[1].capabilities[0].family = "notification-target"; }, ["reserved-used"]],
  ["a family missing a schema field", (r) => { delete r.families["message-stream/chat"].identity; }, ["family-schema"]],
  ["a reserved family that is not sink-only", (r) => { r.families["notification-target"].direction = "source"; }, ["family-schema"]],
  ["a capability with a sixth key and no fetcher", (r) => { const c = r.artifacts[0].capabilities[0]; delete c.fetcher; c.protocol = "https"; }, ["capability-keys"]],
  ["an artifact whose directory does not exist", (r) => { r.artifacts[0].path = "integrations/acme-gone"; }, ["artifact-missing", "coverage-unregistered"]],
  ["an artifact listed twice", (r) => { r.artifacts.push(structuredClone(r.artifacts[1])); }, ["artifact-duplicate"]],
  ["a connector declaring source while its capabilities span both", (r) => { r.connectors.acme.direction = "source"; }, ["connector-direction"]],
  ["a connector with no capability naming it", (r) => { r.connectors.ghost = { direction: "source" }; }, ["connector-set"]],
  ["a vendor used with no connector entry", (r) => { delete r.connectors.acme; }, ["connector-set"]],
  ["an external-touching artifact left unclassified", (r) => { r.artifacts.pop(); r.connectors.acme.direction = "source"; }, ["coverage-unregistered"]],
  ["an artifact both classified and excused (its metadata still declares the connector)", (r) => { r.not_connectors.artifacts["recipes/acme-digest"] = "because"; }, ["coverage-both", "excuse-declares"]],
  ["a classified artifact whose metadata declares no connector", (r) => { r.artifacts.push({ path: "recipes/plain-tool", capabilities: [{ vendor: "acme", family: "message-stream/chat", transport: "pull", direction: "source", cardinality: "1:1", round_trip: "read-only", fetcher: "native-driver" }] }); }, ["connectors-field"]],
  ["a provider matched twice, once at the head after a qualifier, is covered (every match is read)", (r) => {}, [], (t) => { t.metadataByPath.set("recipes/two-hits", { requires: { services: ["Any OpenRouter-compatible OpenRouter gateway"] }, tags: ["notes"] }); t.existingDirs.push("recipes/two-hits"); }],
  ["a registered artifact whose metadata declares other connectors than its capabilities", (r) => {}, ["connectors-field"], (t) => { t.metadataByPath.get("recipes/acme-digest")!.connectors = ["acme", "beta"]; }], // PROBE_TREE sets the key
  ["a contribution declaring a connector and classified nowhere", (r) => {}, ["coverage-unregistered"], (t) => { t.metadataByPath.set("recipes/plain-tool", { requires: { services: ["Supabase"] }, tags: ["ops"], connectors: ["acme"] }); }],
  ["an excused artifact whose metadata declares a connector", (r) => { r.not_connectors.artifacts["recipes/plain-tool"] = "a tool"; }, ["excuse-declares"], (t) => { t.metadataByPath.set("recipes/plain-tool", { requires: { services: ["Supabase"] }, tags: ["ops"], connectors: ["acme"] }); }],
  ["a vendor named after an Object.prototype member", (r) => { r.artifacts[1].capabilities[0].vendor = "constructor"; r.connectors.acme.direction = "source"; }, ["connector-set", "connectors-field"]],
  ["an excuse for an artifact nothing marks", (r) => { r.not_connectors.artifacts["recipes/plain-tool"] = "because"; }, ["excuse-stale"]],
  ["an excuse for a contribution that does not exist", (r) => { r.not_connectors.artifacts["recipes/gone"] = "because"; }, ["excuse-stale"]],
  ["a service pattern matching nothing in the tree", (r) => { r.not_connectors.services.push({ pattern: "zapier", reason: "x" }); }, ["pattern-stale"]],
  ["a service pattern that does not compile", (r) => { r.not_connectors.services.push({ pattern: "(", reason: "x" }); }, ["pattern-invalid"]],
  ["a service pattern that is empty (which would match every service)", (r) => { r.not_connectors.services.push({ pattern: "", reason: "x" }); }, ["pattern-invalid"]],
  ["a service pattern with no reason", (r) => { r.not_connectors.services.push({ pattern: "openrouter" }); }, ["pattern-reason"]],
  ["an excuse with no reason", (r) => { r.artifacts.pop(); r.connectors.acme.direction = "source"; r.not_connectors.artifacts["recipes/acme-digest"] = ""; }, ["excuse-reason"], (t) => { delete t.metadataByPath.get("recipes/acme-digest")!.connectors; }], // PROBE_TREE sets the key
  ["an artifact path that is not <category>/<slug>", (r) => { r.artifacts[1].path = "Recipes/Acme Digest"; }, ["artifact-path", "coverage-unregistered"]],
  ["a capability repeated within an artifact", (r) => { r.artifacts[0].capabilities.push({ ...r.artifacts[0].capabilities[0] }); }, ["capability-duplicate"]],
  ["a registry that is not an object", () => {}, ["shape"], null],
  ["an artifacts block that is an object, not a list", (r: ProbeWith<"artifacts", { [i: number]: ProbeArtifact; a?: ProbeArtifact }>) => { r.artifacts = { a: r.artifacts[0] }; }, ["shape", "coverage-unregistered", "connector-set"]],
  ["an artifact marked only by a tag naming its connector", (r) => {}, ["coverage-unregistered"], (t) => { t.metadataByPath.set("recipes/acme-notes", { requires: { services: ["OpenRouter"] }, tags: ["acme", "notes"] }); t.existingDirs.push("recipes/acme-notes"); }],
  ["a vendor named first in a service string a provider pattern also matches", (r) => {}, ["coverage-unregistered"], (t) => { t.metadataByPath.set("recipes/notion-sync", { requires: { services: ["Notion API (summaries via OpenRouter)"] }, tags: ["notes"] }); t.existingDirs.push("recipes/notion-sync"); }],
  ["a vendor first with the provider as the second token, bracketed or slashed", (r) => {}, ["coverage-unregistered"], (t) => { t.metadataByPath.set("recipes/notion-sync", { requires: { services: ["Notion (OpenRouter)"] }, tags: ["notes"] }); t.metadataByPath.set("recipes/mail-sync", { requires: { services: ["Gmail/OpenRouter"] }, tags: ["notes"] }); t.existingDirs.push("recipes/notion-sync", "recipes/mail-sync"); }],
  ["a connector's name as a tag in another case", (r) => {}, ["coverage-unregistered"], (t) => { t.metadataByPath.set("recipes/acme-notes", { requires: { services: ["OpenRouter"] }, tags: ["Acme", "Notes"] }); t.existingDirs.push("recipes/acme-notes"); }],
  ["an artifact marked only by a tag the brain's own vocabulary shares (capture) is not marked", (r) => {}, [], (t) => { t.metadataByPath.set("recipes/own-capture", { requires: { services: ["OpenRouter"] }, tags: ["capture", "export", "sync"] }); t.existingDirs.push("recipes/own-capture"); }],
  ["a family declared as null and used", (r: ProbeWith<"families", Record<string, Family | null>>) => { r.families["web-clip"] = null; r.artifacts[0].capabilities[0].family = "web-clip"; }, ["family-schema"]],
  ["a fold-in row naming a contribution that is gone", (r) => {}, ["disposition-stale"], (t) => { t.dispositionText += "| `gone-capture` | keep + audited → fold-in **SMD-1867** | removed since |\n"; }],
  // The three below keep a provider service on the probe tree so the openrouter pattern stays live: the table is the only trigger under test.
  ["an artifact the disposition table alone marks (a batch importer naming a provider only, declaring nothing)", (r) => { r.artifacts.shift(); r.connectors.acme.direction = "sink"; }, ["coverage-unregistered"], (t) => { t.metadataByPath.set("integrations/acme-capture", { requires: { services: ["OpenRouter"] }, tags: [] }); }],
  ["a fold-in row for a directory whose metadata did not parse marks nothing", (r) => { r.artifacts.shift(); r.connectors.acme.direction = "sink"; }, [], (t) => { t.metadataByPath.set("integrations/acme-capture", null); t.metadataByPath.set("recipes/plain-tool", { requires: { services: ["Supabase", "OpenRouter"] }, tags: ["ops"] }); }],
  ["a fold-in row after a fenced `# comment` under the same heading", (r) => { r.artifacts.shift(); r.connectors.acme.direction = "sink"; }, ["coverage-unregistered"], (t) => { t.metadataByPath.set("integrations/acme-capture", { requires: { services: ["OpenRouter"] }, tags: [] }); t.dispositionText = t.dispositionText.replace("| Artifact |", "```sh\n# a comment in an example\n```\n| Artifact |"); }],
  ["a service pattern that matches the empty string (a trailing `|`)", (r) => { r.not_connectors.services[0].pattern = "openrouter|"; }, ["pattern-invalid"]],
  ["a registry entry for a placeholder directory", (r) => { r.artifacts[1].path = "recipes/_template"; }, ["artifact-path", "coverage-unregistered"]],
  ["a disposition table that is missing", (r) => {}, ["disposition-missing"], (t: Tree) => { t.dispositionText = null; }],
  ["a disposition table with one category's heading moved (partly dark)", (r) => {}, ["disposition-dark"], (t) => { t.dispositionText = "### `recipes/` (1)\n\n| `acme-digest` | keep + audited → SMD-1867 candidate | x |\n\n## Integrations\n\n| `acme-capture` | keep + audited → fold-in **SMD-1867** | x |\n"; }],
  ["a not-a-connector pattern broad enough to cover a classified vendor's own service", (r) => { r.not_connectors.services.push({ pattern: "acme", reason: "too broad" }); }, ["pattern-broad"]],
  ["a provider as the bare second word after a vendor's name", (r) => {}, ["coverage-unregistered"], (t) => { t.metadataByPath.set("recipes/notion-sync", { requires: { services: ["Notion OpenRouter summaries"] }, tags: ["notes"] }); t.existingDirs.push("recipes/notion-sync"); }],
  ["a capability with a direction typo beside source capabilities (no spurious connector-direction)", (r) => { r.artifacts[1].capabilities[0].direction = "both"; r.connectors.acme.direction = "source"; }, ["capability-value"]],
  ["a fold-in row for a directory with no metadata.json marks nothing", (r) => { r.artifacts.shift(); r.connectors.acme.direction = "sink"; }, [], (t) => { t.metadataByPath.delete("integrations/acme-capture"); t.metadataByPath.set("recipes/plain-tool", { requires: { services: ["Supabase", "OpenRouter"] }, tags: ["ops"] }); }],
  ["a registry path with a space, which the walk admits", (r) => { r.artifacts[1].path = "recipes/acme digest"; }, ["artifact-missing", "coverage-unregistered"]],
  ["a disposition table whose headings moved to `##`, yielding no fold-in", (r) => {}, ["disposition-dark"], (t) => { t.dispositionText = t.dispositionText.replace("### ", "## "); }],
  ["a capability that is a bare string", (r: ProbeWith<"artifacts", { path: string; capabilities: (ProbeCapability | string)[] }[]>) => { r.artifacts[1].capabilities[0] = "acme"; r.connectors.acme.direction = "source"; }, ["capability-keys", "connectors-field"]],
  ["an artifact listed twice, the duplicate under another vendor (the first entry is judged)", (r) => { r.artifacts.push({ path: "recipes/acme-digest", capabilities: [{ vendor: "beta", family: "message-stream/chat", transport: "push", direction: "sink", cardinality: "many:1", round_trip: "read-only", fetcher: "native-driver" }] }); r.connectors.beta = { direction: "sink" }; }, ["artifact-duplicate"]],
];
/** Non-probes: what the rules must accept (a `want` of []) and must not throw on. */
const REGISTRY_NON_PROBES: RegistryProbe[] = [
  ["a contribution naming only a model provider is not marked", (r) => {}, [], (t) => { t.metadataByPath.set("recipes/uses-a-model", { requires: { services: ["OpenRouter"] }, tags: ["synthesis"] }); t.existingDirs.push("recipes/uses-a-model"); }],
  ["two patterns matching one service are both live (the narrower inside the word, covering nothing)", (r) => { r.not_connectors.services.push({ pattern: "router", reason: "overlaps openrouter on purpose" }); }, []],
  ["a provider first and qualified after is covered", (r) => {}, [], (t) => { t.metadataByPath.set("recipes/uses-a-gateway", { requires: { services: ["Any OpenRouter-compatible LLM gateway (Ollama, etc.)", "Optional: OpenRouter (Sonar) for live search"] }, tags: ["synthesis"] }); t.existingDirs.push("recipes/uses-a-gateway"); }],
  ["a pattern whose only match lies past the head is live, though it covers nothing", (r) => { r.not_connectors.services.push({ pattern: "sonar", reason: "a model" }); }, [], (t) => { t.metadataByPath.set("recipes/uses-a-gateway", { requires: { services: ["Optional: OpenRouter (Sonar) for live search"] }, tags: ["synthesis"] }); t.existingDirs.push("recipes/uses-a-gateway"); }],
  ["an excuse for a directory that exists without a metadata.json waits on check 1", (r) => { r.not_connectors.artifacts["recipes/no-meta"] = "waiting on its metadata"; }, [], (t) => { t.existingDirs.push("recipes/no-meta"); }],
  ["a registered artifact whose metadata did not parse gets no coverage verdict", (r) => {}, [], (t) => { t.metadataByPath.set("recipes/acme-digest", null); }],
  ["a metadata whose tags and services are strings marks nothing and throws nothing", (r) => {}, [], (t) => { t.metadataByPath.set("recipes/odd-tool", { requires: { services: "Acme Chat API" }, tags: "digest" }); t.existingDirs.push("recipes/odd-tool"); }],
];
/** [text, want]: what dispositionPaths reads from a table — the fold-in marker in the Disposition cell under a contribution-category heading, and nothing from the Justification cell, past another heading, under `docs/drafts/`, or from a bare mention or a negation. */
const DISPOSITION_PROBES: [text: string, want: string[]][] = [
  ["### `integrations/` (2)\n\n| Artifact | Disposition | Justification |\n|---|---|---|\n| `a-capture` | keep + audited → fold-in **SMD-1867** | x |\n| `b-tool` | keep + audited | mentioned beside SMD-1867 and SMD-1924; a tool, not a fold-in |\n| `e-graph` | keep + audited | a graph view; not an SMD-1867 adapter |\n\n### `recipes/` (1)\n\n| `c-import` | keep + audited → SMD-1867 candidate | x |\n| `f-import` | keep + audited *(drop one sub-file)* → SMD-1867 candidate | x |\n| `h-import` | remove | superseded by the seam; was the SMD-1867 candidate |\n| `i-import` | remove — was the SMD-1867 candidate | superseded by the seam |\n| `g-ext` | keep + audited | A capture adapter under the SMD-1867 contract, not an ad-hoc integration. |\n\n### `docs/drafts/` (1)\n\n| `sketch.md` | keep + audited → SMD-1867 candidate | not a contribution directory |\n\n## Notes\n\n| `d-tool` | remove → fold-in **SMD-1867** | was considered |\n", ["integrations/a-capture", "recipes/c-import", "recipes/f-import"]],
  ["## Summary\n\n| `x-tool` | fold-in **SMD-1867** |\n", []],
];
function checkConnectorRegistry() {
  // One pattern for a vendor key: the schema's for metadata `connectors`, the registry's for its vendors.
  if (props.connectors?.items?.pattern !== VENDOR_PATTERN) fail(".github/metadata.schema.json", `connectors.items.pattern is ${JSON.stringify(props.connectors?.items?.pattern)} but scripts/connector-registry.ts's VENDOR_PATTERN is ${JSON.stringify(VENDOR_PATTERN)} — one definition of a vendor key (SMD-1933)`);
  const kindsOf = (registry: Registry | null, tree: Tree = PROBE_TREE()) => [...new Set(registryProblems({ registry, ...tree }).map((p) => p.kind))].sort();
  const base = registryProblems({ registry: PROBE_REGISTRY(), ...PROBE_TREE() });
  if (base.length) return fail(SELF, `check 19's baseline registry fails its own rules (${base.map((p) => `${p.kind}: ${p.msg}`).join("; ")}) — the mutants below measure nothing`);
  for (const [text, want] of DISPOSITION_PROBES) {
    const got = dispositionPaths(text);
    if (JSON.stringify(got) !== JSON.stringify(want)) fail(SELF, `check 19's disposition reader returns [${got}], expected [${want}] (its own probe)`);
  }
  // A fourth element: null runs the mutant on a null registry; a function reshapes the tree. A `want` of []
  // is a non-probe — a case the rules must accept and not throw on.
  for (const [why, mutate, want, tree] of [...REGISTRY_PROBES, ...REGISTRY_NON_PROBES]) {
    let r: ProbeRegistry | null = PROBE_REGISTRY();
    if (tree === null) r = null; else mutate(r);
    const t = PROBE_TREE();
    if (typeof tree === "function") tree(t);
    let got: string[];
    try { got = kindsOf(r, t); } catch (e) { fail(SELF, `check 19 throws for ${why}: ${(e as Error).message} (its own probe)`); continue; }
    if (JSON.stringify(got) !== JSON.stringify([...want].sort())) fail(SELF, `check 19 reports [${got}] for ${why}, expected [${want}] (its own probe)`);
  }

  if (!existsSync(join(ROOT, REGISTRY_PATH))) return fail(REGISTRY_PATH, "missing — the connector taxonomy's one source (SMD-1933)");
  let registry: Registry;
  try { registry = readRegistry(ROOT); } catch (e) { return fail(REGISTRY_PATH, `does not parse: ${(e as Error).message} (SMD-1933)`); }
  const dispositionText = existsSync(join(ROOT, DISPOSITION_PATH)) ? readFileSync(join(ROOT, DISPOSITION_PATH), "utf8") : null;
  let problems: Problem[];
  // readMetadata is the one statement of "absent is not in the map, unparseable is null (no verdict)" — the CLI reads the same; check 1 names the unparseable file.
  try { problems = registryProblems({ registry, existingDirs: dirs.map((d) => d.rel), metadataByPath: readMetadata(dirs), dispositionText }); } catch (e) { return fail(REGISTRY_PATH, `check 19 threw instead of reporting: ${(e as Error).message} (SMD-1933)`); }
  for (const p of problems) fail(p.where, `${p.msg} (SMD-1933)`);
  if (!existsSync(join(ROOT, SPEC_PATH))) return fail(SPEC_PATH, "missing — the spec that carries the registry's rendered tables (SMD-1933)");
  const span = tablesSpan(readFileSync(join(ROOT, SPEC_PATH), "utf8"));
  if (!span) return fail(SPEC_PATH, "the generated-tables markers are missing or doubled (SMD-1933)");
  // The renderer assumes a sound registry (the CLI refuses to render otherwise); an unsound one has its findings above.
  if (problems.length === 0 && span.block !== renderClassification(registry)) fail(SPEC_PATH, `the generated tables differ from what ${REGISTRY_PATH} renders — run \`bun scripts/connector-registry.ts\` (SMD-1933)`);
}
checkConnectorRegistry();
// ── 20: main's ruleset is a record in the tree, and it requires the one job that needs every other (SMD-1856, SMD-3168) ──
/**
 * The ruleset GitHub enforces on `main` (id 22189960) lived outside the tree,
 * where a job added to the workflow was not added to it — which is how the
 * replay gate ran unrequired from SMD-1295 until this ticket. And with strict
 * off, a run green against the `main` of its trigger time stayed green after
 * `main` moved, so two branches could each pass and together break the tree.
 * `.github/rulesets/main.json` is the body that
 * `gh api -X PUT repos/MHarris-SgyMd/OB1/rulesets/22189960 --input` applies, so
 * the setting is reviewed here first; this check holds the record to the
 * ticket's decisions: the default branch as the target, strict up-to-date on,
 * every check pinned to the Actions app so only a workflow run satisfies it, a
 * pull-request rule with no required review (one maintainer) and none of the
 * review flags that would ask one another way, deletion and force-push
 * refused, no bypass actor, enforcement active. The record can still drift
 * from the live ruleset — CI's token cannot read it, and a GET adds defaults
 * the record omits — so FORK.md names the one command that re-applies it.
 *
 * Until SMD-3168 the record named every job, so each job added, renamed or
 * split was a ruleset PUT made by hand just before its merge (SMD-3048,
 * SMD-3051, SMD-3152), and a matrix was refused because its checks are named
 * after their cells. Now the record requires one context, AGGREGATE_NAME: the
 * job AGGREGATE_JOB, which `needs:` every other job, runs `if: always()` and
 * fails unless each one succeeded or was skipped where MAY_SKIP names it. So
 * this check holds that job instead: it exists under that name, it needs every
 * job in the workflow and nothing else, it runs always (a skipped required
 * check is a passing one), MAY_SKIP spells AGGREGATE_MAY_SKIP and those are
 * exactly the jobs with an `if:` of their own (none of which another job
 * needs), no job it needs sets `continue-on-error` or calls a reusable
 * workflow, it runs on AGGREGATE_RUNNER, it and its step carry no key beyond
 * the few allowed (no continue-on-error, no step if:, no shell, no env but
 * NEEDS and MAY_SKIP), no
 * job in any workflow takes its name, and its one step is AGGREGATE_RUN
 * verbatim — which the check runs through bash on AGGREGATE_CASES, so the
 * step's verdict is tested, not only its text.
 *
 * SMD-1857 wanted the merge queue as a fifth rule: a PR is queued, GitHub
 * builds the merge result and runs the required checks on it (the workflow's
 * `merge_group` trigger), and merges only what passes — so the checks judge
 * the tree that lands without the author merging `main` first, which is what
 * strict up-to-date makes them do. GitHub offers the queue on
 * organisation-owned repositories only; this one is owned by a user account,
 * and the API refuses the rule (422, "Invalid rule 'merge_queue'") — a record
 * the PUT refuses is no record. So the rule is OPTIONAL here: absent while
 * the repository is user-owned, held to MERGE_QUEUE the day it is added,
 * which is the day the repository moves to an organisation.
 */
const RULESET = ".github/rulesets/main.json";
/** GitHub's own app id for Actions: a required check pinned to it is satisfied by a workflow run and by nothing else — not a status another app or a token posts under the same name. */
const GITHUB_ACTIONS_APP_ID = 15368;
/** The rule types the record carries, each exactly once; another type (a linear-history rule, say) is a decision the ticket declined, and edits this list with it. */
const RULE_TYPES = ["deletion", "non_fast_forward", "pull_request", "required_status_checks"];
/** The rule types the record MAY carry, at most once each: the merge queue, which GitHub refuses on a user-owned repository and which the record adds the day this one is organisation-owned (SMD-1857). */
const OPTIONAL_RULE_TYPES = ["merge_queue"];
/**
 * The merge queue's parameters when the rule is present, each held equal
 * (SMD-1857). MERGE keeps the merge commit the fork lands with (the record of
 * how a branch diverged); ALLGREEN judges each queued PR on its own merge
 * commit, so a red run names the PR that broke the tree rather than the group;
 * min 1 means a lone PR is merged as soon as its run is green — the wait
 * applies only to reaching a minimum above one; 5 and 5 are GitHub's defaults
 * for how many entries build and merge together, more than this fork queues
 * at once; 60 minutes is four times the longest run seen (a push run of main,
 * 16 minutes) before a check that never reports is read as failed and the PR
 * is dropped from the queue.
 */
const MERGE_QUEUE = { check_response_timeout_minutes: 60, grouping_strategy: "ALLGREEN", max_entries_to_build: 5, max_entries_to_merge: 5, merge_method: "MERGE", min_entries_to_merge: 1, min_entries_to_merge_wait_minutes: 5 } as const;
/** The one ref the ruleset targets: GitHub's alias for the default branch, so a rename of `main` carries it. */
const RULESET_REFS = ["~DEFAULT_BRANCH"];
/** The pull-request rule's flags, each held false: any of them true asks a review, or blocks on a thread, that the zero count says nothing asks. */
const PR_RULE_FLAGS = ["dismiss_stale_reviews_on_push", "require_code_owner_review", "require_last_push_approval", "required_review_thread_resolution"];
/** The record as rulesetProblems reads it: every level optional, as the `?.`s say. */
type RulesetDoc = {
  target?: unknown;
  enforcement?: unknown;
  bypass_actors?: unknown;
  conditions?: { ref_name?: { include?: unknown; exclude?: unknown } } | null;
  rules?: ({ type?: unknown; parameters?: ({ strict_required_status_checks_policy?: unknown; do_not_enforce_on_create?: unknown; required_status_checks?: unknown; required_approving_review_count?: unknown } & Record<string, unknown>) | null } | null)[];
} | null | undefined;
/** The workflow as aggregateProblems reads it: a job's display name is its `name`, else its key — what GitHub reports the check as. */
type JobsDoc = { jobs?: Record<string, { name?: unknown; if?: unknown; needs?: unknown; steps?: unknown } | null | undefined> | null } | null | undefined;
/** The one job the record requires (SMD-3168), by key and by the display name GitHub reports its check under. */
const AGGREGATE_JOB = "fork-checks-passed";
const AGGREGATE_NAME = "Fork Checks passed";
/** The `if:` the aggregate runs under, as written either way: always, so a failed need does not skip it into a pass. */
const AGGREGATE_IF = ["always()", "${{ always() }}"];
/** The step's NEEDS, every need's result as JSON. */
const AGGREGATE_NEEDS_ENV = "${{ toJSON(needs) }}";
/**
 * The verdict step's run: body, verbatim. A need that did not succeed fails
 * it — failure, cancelled, or skipped unless MAY_SKIP names the job exactly —
 * and the names and results are printed. A NEEDS that does not parse fails it
 * too: jq exits non-zero and the shell's -e stops there.
 */
const AGGREGATE_RUN = `# shellcheck disable=SC2016 # jq's variables, not the shell's
not_passed=$(jq -r --arg may_skip "$MAY_SKIP" '
  ($may_skip | split(" ") | map(select(. != ""))) as $skip
  | to_entries[]
  | select(.value.result != "success" and (.value.result != "skipped" or (.key as $k | any($skip[]; . == $k) | not)))
  | "\\(.key): \\(.value.result)"' <<<"$NEEDS")
if [ -n "$not_passed" ]; then
  printf 'Not every job passed:\\n%s\\n' "$not_passed" >&2
  exit 1
fi
echo "Every job passed: $(jq '[.[] | select(.result == "success")] | length' <<<"$NEEDS") succeeded, $(jq '[.[] | select(.result == "skipped")] | length' <<<"$NEEDS") skipped where MAY_SKIP allows."`;
/** [why, NEEDS, MAY_SKIP, whether the step passes]: AGGREGATE_RUN under bash, case by case. */
const AGGREGATE_CASES: [why: string, needs: string, maySkip: string, passes: boolean][] = (() => {
  const r = (result: string) => ({ result, outputs: {} });
  const n = (o: Record<string, { result: string }>) => JSON.stringify(o);
  return [
    ["every job succeeded", n({ a: r("success"), b: r("success") }), "commit-lint", true],
    ["a job failed", n({ a: r("success"), b: r("failure") }), "commit-lint", false],
    ["a job was cancelled", n({ a: r("success"), b: r("cancelled") }), "commit-lint", false],
    ["a job MAY_SKIP does not name was skipped", n({ a: r("success"), b: r("skipped") }), "commit-lint", false],
    ["commit-lint was skipped (a push)", n({ a: r("success"), "commit-lint": r("skipped") }), "commit-lint", true],
    ["commit-lint failed", n({ a: r("success"), "commit-lint": r("failure") }), "commit-lint", false],
    ["a job whose name MAY_SKIP's contains was skipped", n({ a: r("success"), commit: r("skipped") }), "commit-lint", false],
    ["a job whose name contains MAY_SKIP's was skipped", n({ a: r("success"), "commit-lint-x": r("skipped") }), "commit-lint", false],
    ["a result that is empty", n({ a: r("") }), "", false],
    ["a NEEDS that does not parse", "not json", "", false],
  ];
})();
/**
 * The keys the aggregate job, its step and the step's env may carry, and no
 * others (review pass 1): `continue-on-error` on either, a step `if:`, a
 * `shell:` or a job's `defaults:`, or an env that moves PATH, would each turn a
 * failed verdict into a passing job — "Fork Checks passed" green with a job red.
 */
const AGGREGATE_JOB_KEYS = ["name", "runs-on", "if", "needs", "steps", "timeout-minutes"];
const AGGREGATE_STEP_KEYS = ["name", "id", "env", "run", "timeout-minutes"];
/** The aggregate's runner (review pass 2): another label runs its step under another shell (a Windows runner's pwsh) or on a machine with its own jq. */
const AGGREGATE_RUNNER = "ubuntu-24.04";
/**
 * The jobs the aggregate lets skip, as MAY_SKIP must spell them — one space
 * between names, as the step's jq splits them (review pass 2). Held here so
 * that a job made skippable is a reviewed change to this check, not an `if:`
 * and a MAY_SKIP entry added together: commit-lint, because a plain push has
 * no range of its own to lint. A job here must be one no other job needs (a
 * skipped need skips its dependents, review pass 5). The comments above
 * commit-lint and the aggregate in the workflow, and FORK.md's ruleset text,
 * name this list in prose; change them with it. The probes keep their own list
 * (PROBE_MAY_SKIP), so a change here moves only the real rules.
 */
const AGGREGATE_MAY_SKIP = ["commit-lint"];
const AGGREGATE_ENV_KEYS = ["NEEDS", "MAY_SKIP"];
/** A name as a message shows it: quoted, with anything outside printable ASCII escaped, so a look-alike does not read as the name it imitates (review pass 3). */
const shownName = (s: string): string => JSON.stringify(s).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** One `${{ … }}` in a name: a quoted string read whole, so a `}}` inside it does not end the expression (review pass 4); unclosed, it runs to the end. */
const EXPRESSION_IN_NAME = /\$\{\{(?:'(?:[^']|'')*'|[^'}]|\}(?!\}))*(?:\}\}|$)/;
/**
 * How a job's display name could report the check AGGREGATE_NAME, or null:
 * its literal text carries it ("carries"), or — each `${{ … }}` read as any
 * text, since a matrix value, `format()` or the event renders it at run time —
 * it can render as it ("could render as"; review pass 3: a name wholly an
 * expression passed). Both ignore case, which costs nothing. The match is a
 * glob read with indexOf — the first part a prefix, the last a suffix, the
 * rest in order between — never a RegExp built from the name, which a run of
 * empty parts backtracked for minutes (review pass 4). `Tests (${{
 * matrix.shard }})` can do neither, and is allowed.
 */
function mayReportAs(name: string, target: string): "carries" | "could render as" | null {
  const text = name.toLowerCase();
  const want = target.toLowerCase();
  if (text.includes(want)) return "carries";
  const parts = text.split(EXPRESSION_IN_NAME);
  if (parts.length === 1) return null;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (first.length + last.length > want.length || !want.startsWith(first) || !want.endsWith(last)) return null;
  const end = want.length - last.length;
  let at = first.length;
  for (const part of parts.slice(1, -1)) {
    const i = want.indexOf(part, at);
    if (i < 0 || i + part.length > end) return null;
    at = i + part.length;
  }
  return "could render as";
}
/**
 * [name, what mayReportAs answers for it against AGGREGATE_NAME] (review pass
 * 5): names it must allow — the shapes a matrix or an input gives a job, and
 * ones that come close — beside the ways it must refuse, so a matcher grown
 * too broad fails here as surely as one grown too narrow.
 */
const MAY_REPORT_CASES: [name: string, answer: "carries" | "could render as" | null][] = [
  ["Schema against real Postgres (${{ matrix.shard }})", null],
  ["${{ inputs.label }} tests", null],
  ["Fork Checks (${{ matrix.os }})", null],
  ["Release (images, stack from them, notes)", null],
  ["Fork Checks passe${{ x }}d!", null],
  ["Fork ${{ x }} Checks ${{ y }} passed ${{ z }}", null],
  ["Fork Checks pa${{ x }}ks passed", null],
  ["", null],
  ["Fork Checks passed", "carries"],
  ["fork checks PASSED (old)", "carries"],
  ["${{ x }}Fork Checks passed extra", "carries"],
  ["${{ matrix.label }}", "could render as"],
  ["Fork Checks ${{ matrix.word }}", "could render as"],
  ["${{ 'Fork' }} Checks ${{ 'pass' }}ed", "could render as"],
  ["${{ fromJSON('{\"a\":{\"b\":\"Fork Checks\"}}').a.b }} passed", "could render as"],
  ["Fork Checks pass${{ x", "could render as"],
];
/**
 * Jobs, other than the aggregate, whose display name could report a check
 * under AGGREGATE_NAME (mayReportAs): a second check under the one context
 * the record requires, pinned to the same app, which can pass while the
 * aggregate fails. Read in every workflow, not this one alone (review pass 1).
 */
function nameClashes(file: string, doc: JobsDoc, aggregateKey: string | null): [string, string][] {
  const jobs = doc?.jobs && typeof doc.jobs === "object" ? doc.jobs : {};
  return Object.entries(jobs)
    .filter(([key]) => key !== aggregateKey)
    .flatMap(([key, job]): [string, string][] => {
      const name = typeof job?.name === "string" ? job.name : key;
      const how = mayReportAs(name, AGGREGATE_NAME);
      const hint = how === "could render as" ? "; give it literal text no expression can complete it to, as `Live (\${{ matrix.shard }})` does" : "";
      return how ? [[file, `job ${key} is named ${shownName(name)}, which ${how} "${AGGREGATE_NAME}"${hint} — a second check under the one context ${RULESET} requires, which can pass while the aggregate fails (SMD-3168)`]] : [];
    });
}
/** A job's `needs:` as GitHub reads it: one key, or a list of them; anything else is null. */
const needsOf = (needs: unknown): string[] | null =>
  typeof needs === "string" ? [needs] : Array.isArray(needs) && needs.every((x) => typeof x === "string") ? needs : null;
/**
 * The aggregate job held to what makes the one context mean "every job
 * passed": present under AGGREGATE_NAME, run always, no matrix, needing every
 * other job and only those, one step that is AGGREGATE_RUN with NEEDS from
 * `needs`, MAY_SKIP spelling AGGREGATE_MAY_SKIP and those being exactly the
 * jobs with an `if:` of their own (any other skipped is a failure; one of
 * those not named fails every run its `if:` skips), no job it needs set
 * `continue-on-error` (a failure that reports as a success, review pass 2)
 * or calls a reusable workflow (whose jobs this check does not read, review
 * pass 3), the job on AGGREGATE_RUNNER with no key beyond AGGREGATE_JOB_KEYS,
 * its step none beyond AGGREGATE_STEP_KEYS and its env none beyond
 * AGGREGATE_ENV_KEYS, and no other job reporting a check under its name.
 */
function aggregateProblems(doc: JobsDoc, maySkipList: readonly string[] = AGGREGATE_MAY_SKIP): [string, string][] {
  const problems: [string, string][] = [];
  const jobs = doc?.jobs && typeof doc.jobs === "object" ? doc.jobs : {};
  const others = Object.keys(jobs).filter((k) => k !== AGGREGATE_JOB);
  problems.push(...nameClashes(WORKFLOW, doc, AGGREGATE_JOB));
  for (const key of others) {
    const ignored = (jobs[key] as Record<string, unknown> | null | undefined)?.["continue-on-error"];
    if (ignored !== undefined && ignored !== false) problems.push([WORKFLOW, `job ${key} sets continue-on-error: ${JSON.stringify(ignored)} — its failure then reaches ${AGGREGATE_JOB}'s needs as a success, and "${AGGREGATE_NAME}" passes with it red; take it off (SMD-3168)`]);
    const called = (jobs[key] as Record<string, unknown> | null | undefined)?.uses;
    if (called !== undefined) problems.push([WORKFLOW, `job ${key} calls the reusable workflow ${JSON.stringify(called)} — its result is the called run's, whose own jobs check 20 does not read, so a continue-on-error there passes "${AGGREGATE_NAME}" with a job red (review pass 3); run its steps here${typeof called === "string" && called.startsWith("./") ? ", or teach check 20 to read the called file" : " — a remote one cannot be read from this tree"} (SMD-3168)`]);
  }
  const agg = jobs[AGGREGATE_JOB];
  if (!agg || typeof agg !== "object") return [...problems, [WORKFLOW, `has no job ${AGGREGATE_JOB} ("${AGGREGATE_NAME}") — the one check ${RULESET} requires; without it every PR waits on a check that never reports (SMD-3168)`]];
  for (const key of Object.keys(agg)) if (!AGGREGATE_JOB_KEYS.includes(key)) problems.push([WORKFLOW, `job ${AGGREGATE_JOB} sets ${key}, which check 20 does not allow on it — the job carries ${AGGREGATE_JOB_KEYS.join(", ")} alone, since a key like continue-on-error or defaults can turn a failed verdict into a pass (SMD-3168)`]);
  if ((agg as Record<string, unknown>)["runs-on"] !== AGGREGATE_RUNNER) problems.push([WORKFLOW, `job ${AGGREGATE_JOB} runs on ${JSON.stringify((agg as Record<string, unknown>)["runs-on"] ?? null)}, not ${AGGREGATE_RUNNER} — another runner runs its step under another shell or another jq (SMD-3168)`]);
  if (agg.name !== AGGREGATE_NAME) problems.push([WORKFLOW, `job ${AGGREGATE_JOB} is ${agg.name === undefined ? "unnamed" : `named ${JSON.stringify(agg.name)}`}, not "${AGGREGATE_NAME}" — the context ${RULESET} requires (SMD-3168)`]);
  if (!AGGREGATE_IF.includes(String(agg.if ?? "").trim())) problems.push([WORKFLOW, `job ${AGGREGATE_JOB} runs if: ${JSON.stringify(agg.if ?? null)}, not if: always() — a job whose needs failed is skipped, and GitHub reads a skipped required check as passing (SMD-3168)`]);
  const needs = needsOf(agg.needs);
  if (!needs) problems.push([WORKFLOW, `job ${AGGREGATE_JOB}'s needs is ${JSON.stringify(agg.needs ?? null)}, not a list of the workflow's jobs (SMD-3168)`]);
  else {
    for (const key of others) if (!needs.includes(key)) problems.push([WORKFLOW, `job ${AGGREGATE_JOB} does not need ${key} — a job outside its needs can fail and the PR merges all the same; add it (SMD-3168)`]);
    for (const n of new Set(needs)) if (!others.includes(n)) problems.push([WORKFLOW, `job ${AGGREGATE_JOB} needs ${n}, which is no other job in ${WORKFLOW} (SMD-3168)`]);
  }
  const steps = Array.isArray(agg.steps) ? (agg.steps as unknown[]) : null;
  if (!steps || steps.length !== 1) return [...problems, [WORKFLOW, `job ${AGGREGATE_JOB} has ${steps ? steps.length : "no list of"} step(s), not the one verdict step check 20 holds (SMD-3168)`]];
  const step = (steps[0] && typeof steps[0] === "object" ? steps[0] : {}) as { env?: unknown; run?: unknown } & Record<string, unknown>;
  const env = (step.env && typeof step.env === "object" ? step.env : {}) as Record<string, unknown>;
  for (const key of Object.keys(step)) if (!AGGREGATE_STEP_KEYS.includes(key)) problems.push([WORKFLOW, `job ${AGGREGATE_JOB}'s step sets ${key}, which check 20 does not allow on it — the step carries ${AGGREGATE_STEP_KEYS.join(", ")} alone, since continue-on-error, an if: or a shell can turn a failed verdict into a pass (SMD-3168)`]);
  for (const key of Object.keys(env)) if (!AGGREGATE_ENV_KEYS.includes(key)) problems.push([WORKFLOW, `job ${AGGREGATE_JOB}'s step sets ${key} in its env, which check 20 does not allow — NEEDS and MAY_SKIP alone, since a PATH or a BASH_ENV changes what the verdict runs (SMD-3168)`]);
  if (typeof step.run !== "string" || step.run.trimEnd() !== AGGREGATE_RUN) problems.push([WORKFLOW, `job ${AGGREGATE_JOB}'s step is not AGGREGATE_RUN in ${SELF} verbatim — the verdict check 20 runs on its cases; change both together (SMD-3168)`]);
  if (env.NEEDS !== AGGREGATE_NEEDS_ENV) problems.push([WORKFLOW, `job ${AGGREGATE_JOB}'s step reads NEEDS from ${JSON.stringify(env.NEEDS ?? null)}, not ${AGGREGATE_NEEDS_ENV} — the results it judges (SMD-3168)`]);
  const maySkip = maySkipList.join(" ");
  // With nothing skippable the key may go too: the step reads an unset MAY_SKIP as empty.
  const given = env.MAY_SKIP === undefined && maySkip === "" ? "" : env.MAY_SKIP;
  if (given !== maySkip) problems.push([WORKFLOW, `job ${AGGREGATE_JOB}'s step sets MAY_SKIP to ${JSON.stringify(env.MAY_SKIP ?? null)}, not ${JSON.stringify(maySkip)} — AGGREGATE_MAY_SKIP in ${SELF}, one space between names as the step's jq splits them; a job made skippable is a change there, with its reason (SMD-3168)`]);
  for (const key of maySkipList) {
    const dependents = others.filter((k) => needsOf(jobs[k]?.needs)?.includes(key));
    if (!others.includes(key)) problems.push([SELF, `AGGREGATE_MAY_SKIP names ${key}, which is no job in ${WORKFLOW} — take it off (SMD-3168)`]);
    else if (jobs[key]?.if === undefined) problems.push([SELF, `AGGREGATE_MAY_SKIP names ${key}, which has no if: of its own — a job that always runs is never skipped, so a skip of it is a failure; take it off (SMD-3168)`]);
    else if (dependents.length) problems.push([SELF, `AGGREGATE_MAY_SKIP names ${key}, which ${dependents.join(", ")} need${dependents.length === 1 ? "s" : ""} — a skipped need skips the jobs that need it, and with those skippable too a run passes having run nothing (review pass 5); a skippable job must be one nothing needs (SMD-3168)`]);
  }
  for (const key of others) if (jobs[key]?.if !== undefined && !maySkipList.includes(key)) problems.push([WORKFLOW, `job ${key} has an if: of its own and AGGREGATE_MAY_SKIP in ${SELF} does not name it — a skip of it would pass, or fail every run its if: skips; drop the if:, or add the job there with the reason it may skip (SMD-3168)`]);
  return problems;
}
function rulesetProblems(ruleset: RulesetDoc) {
  const problems: [string, string][] = [];
  if (!ruleset || typeof ruleset !== "object") return [[RULESET, "is missing or does not parse — the body main's ruleset is applied from (SMD-1856)"]] as [string, string][];
  if (ruleset.target !== "branch") problems.push([RULESET, `target is ${JSON.stringify(ruleset.target)}, not "branch" (SMD-1856)`]);
  if (ruleset.enforcement !== "active") problems.push([RULESET, `enforcement is ${JSON.stringify(ruleset.enforcement)}, not "active" (SMD-1856)`]);
  if (!Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length) problems.push([RULESET, "bypass_actors is not the empty list — the ruleset applies to admins too (SMD-1856)"]);
  const refs = ruleset.conditions?.ref_name;
  if (JSON.stringify(refs?.include) !== JSON.stringify(RULESET_REFS) || !Array.isArray(refs?.exclude) || refs.exclude.length) problems.push([RULESET, `conditions.ref_name is not {include: ${JSON.stringify(RULESET_REFS)}, exclude: []} — the ruleset would apply to something other than the default branch, or to nothing (SMD-1856)`]);
  const rules = Array.isArray(ruleset.rules) ? ruleset.rules : [];
  const types = rules.map((r) => (typeof r?.type === "string" ? r.type : "(untyped)"));
  for (const t of RULE_TYPES) if (types.filter((x) => x === t).length !== 1) problems.push([RULESET, `carries the ${t} rule ${types.filter((x) => x === t).length} time(s), not once (SMD-1856)`]);
  for (const t of OPTIONAL_RULE_TYPES) if (types.filter((x) => x === t).length > 1) problems.push([RULESET, `carries the ${t} rule ${types.filter((x) => x === t).length} time(s) — at most once (SMD-1857)`]);
  for (const t of new Set(types)) if (!RULE_TYPES.includes(t) && !OPTIONAL_RULE_TYPES.includes(t)) problems.push([RULESET, `carries a ${t} rule that RULE_TYPES in ${SELF} does not name — a new rule is a decision; record it there with the reason (SMD-1856)`]);
  const pr = rules.find((r) => r?.type === "pull_request");
  if (pr) {
    if (pr.parameters?.required_approving_review_count !== 0) problems.push([RULESET, `the pull_request rule's required_approving_review_count is ${JSON.stringify(pr.parameters?.required_approving_review_count)}, not 0 — one maintainer; a required review blocks every PR (SMD-1856)`]);
    for (const flag of PR_RULE_FLAGS) if (pr.parameters?.[flag] !== false) problems.push([RULESET, `the pull_request rule's ${flag} is ${JSON.stringify(pr.parameters?.[flag])}, not false — a review, or a resolved thread, asked another way than the count (SMD-1856)`]);
  }
  const queue = rules.find((r) => r?.type === "merge_queue");
  if (queue) {
    if (!queue.parameters || typeof queue.parameters !== "object") problems.push([RULESET, "the merge_queue rule has no parameters — the merge method, the grouping and the group size live there, and GitHub refuses the rule without them (SMD-1857)"]);
    else for (const [key, want] of Object.entries(MERGE_QUEUE)) if (queue.parameters[key] !== want) problems.push([RULESET, `the merge_queue rule's ${key} is ${JSON.stringify(queue.parameters[key])}, not ${JSON.stringify(want)} — a decision MERGE_QUEUE in ${SELF} records; change both, with the reason (SMD-1857)`]);
  }
  const checksRule = rules.find((r) => r?.type === "required_status_checks");
  if (!checksRule) return problems;
  const checks = checksRule.parameters;
  if (!checks || typeof checks !== "object") { problems.push([RULESET, "the required_status_checks rule has no parameters — strict, the contexts and the pins live there (SMD-1856)"]); return problems; }
  if (checks.strict_required_status_checks_policy !== true) problems.push([RULESET, "strict_required_status_checks_policy is not true — a run green against an older main would stay green after main moves (SMD-1856)"]);
  if (checks.do_not_enforce_on_create !== false) problems.push([RULESET, `do_not_enforce_on_create is ${JSON.stringify(checks.do_not_enforce_on_create)}, not false — a branch created at main's ref would skip the checks (SMD-1856)`]);
  if (!Array.isArray(checks.required_status_checks)) { problems.push([RULESET, `required_status_checks is ${JSON.stringify(checks.required_status_checks)}, not a list (SMD-1856)`]); return problems; }
  const required = checks.required_status_checks as ({ context?: unknown; integration_id?: unknown } | null)[];
  const contexts = required.map((c) => (typeof c?.context === "string" ? c.context : ""));
  for (const c of required) {
    if (typeof c?.context !== "string" || !c.context) problems.push([RULESET, `a required check has no context: ${JSON.stringify(c)} (SMD-1856)`]);
    else if (c.integration_id !== GITHUB_ACTIONS_APP_ID) problems.push([RULESET, `"${c.context}" is not pinned to the Actions app (integration_id ${GITHUB_ACTIONS_APP_ID}) — unpinned, a status any app posts under the name satisfies it (SMD-1856)`]);
  }
  for (const c of new Set(contexts)) if (c && contexts.filter((x) => x === c).length > 1) problems.push([RULESET, `requires "${c}" twice (SMD-1856)`]);
  if (!contexts.includes(AGGREGATE_NAME)) problems.push([RULESET, `does not require "${AGGREGATE_NAME}", the job that needs every other (${AGGREGATE_JOB}) — without it a PR merges with any job red; add it and re-apply the ruleset (SMD-3168)`]);
  for (const c of new Set(contexts)) if (c && c !== AGGREGATE_NAME) problems.push([RULESET, `requires ${shownName(c)}, which is not "${AGGREGATE_NAME}" — every job is required through ${AGGREGATE_JOB}'s needs, and a job's own name here is a context its next rename leaves waiting, blocking every PR (SMD-3168)`]);
  return problems;
}
/** A record every rule accepts, with every field a mutant can reach; RULESET_PROBE_CONTEXTS is the one context it requires. */
type RulesetProbeRule = { type: string; parameters?: { strict_required_status_checks_policy?: boolean; do_not_enforce_on_create?: boolean; required_status_checks?: ({ context?: string; integration_id?: number } | null)[] | string; required_approving_review_count?: number; [flag: string]: unknown } | null };
type RulesetProbe = { target: string; enforcement: string; bypass_actors: unknown[]; conditions: { ref_name: { include: string[]; exclude: string[] } } | null; rules: RulesetProbeRule[] };
const RULESET_PROBE_CONTEXTS = [AGGREGATE_NAME];
const RULESET_PROBE = (): RulesetProbe => ({
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: { ref_name: { include: [...RULESET_REFS], exclude: [] } },
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    { type: "pull_request", parameters: { required_approving_review_count: 0, ...Object.fromEntries(PR_RULE_FLAGS.map((f) => [f, false])) } },
    { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: false, required_status_checks: RULESET_PROBE_CONTEXTS.map((context) => ({ context, integration_id: GITHUB_ACTIONS_APP_ID })) } },
  ],
});
/** The optional merge-queue rule as the record would carry it, with a parameter overridden for a mutant. */
const QUEUE_RULE = (over: Record<string, unknown> = {}): RulesetProbeRule => ({ type: "merge_queue", parameters: { ...MERGE_QUEUE, ...over } });
/** [why, mutate]: records the rules must ACCEPT beyond the plain probe — the optional rule, present as recorded. */
const RULESET_ACCEPTED: [why: string, mutate: (g: RulesetProbe) => RulesetProbe][] = [
  ["a merge-queue rule as MERGE_QUEUE records it", (g) => { g.rules.push(QUEUE_RULE()); return g; }],
];
/** [why, mutate (returns the record to judge — the mutated probe, or null for no record), a phrase the ONE problem must carry]. */
const RULESET_MUTANTS: [why: string, mutate: (g: RulesetProbe) => RulesetProbe | null, says: string][] = [
  ["a record that does not require the aggregate", (g) => { g.rules[3].parameters!.required_status_checks = []; return g; }, `does not require "${AGGREGATE_NAME}"`],
  ["a job's own name required beside the aggregate", (g) => { (g.rules[3].parameters!.required_status_checks as object[]).push({ context: "Repo consistency", integration_id: GITHUB_ACTIONS_APP_ID }); return g; }, 'requires "Repo consistency", which is not'],
  ["a look-alike of the aggregate's name required beside it", (g) => { (g.rules[3].parameters!.required_status_checks as object[]).push({ context: "Fork Checks\u00a0passed", integration_id: GITHUB_ACTIONS_APP_ID }); return g; }, 'requires "Fork Checks\\u00a0passed", which is not'],
  ["a required check no job is named", (g) => { (g.rules[3].parameters!.required_status_checks as object[]).push({ context: "Old job", integration_id: GITHUB_ACTIONS_APP_ID }); return g; }, 'requires "Old job", which is not'],
  ["a required check with no context", (g) => { (g.rules[3].parameters!.required_status_checks as object[]).push({ integration_id: GITHUB_ACTIONS_APP_ID }); return g; }, "has no context"],
  ["strict off", (g) => { g.rules[3].parameters!.strict_required_status_checks_policy = false; return g; }, "strict_required_status_checks_policy is not true"],
  ["enforce-on-create off", (g) => { g.rules[3].parameters!.do_not_enforce_on_create = true; return g; }, "do_not_enforce_on_create is true"],
  ["a check not pinned to the Actions app", (g) => { delete (g.rules[3].parameters!.required_status_checks as { integration_id?: number }[])[0].integration_id; return g; }, "is not pinned to the Actions app"],
  ["a check required twice", (g) => { (g.rules[3].parameters!.required_status_checks as object[]).push({ context: RULESET_PROBE_CONTEXTS[0], integration_id: GITHUB_ACTIONS_APP_ID }); return g; }, `requires "${RULESET_PROBE_CONTEXTS[0]}" twice`],
  ["a required_status_checks rule with no parameters", (g) => { g.rules[3].parameters = null; return g; }, "required_status_checks rule has no parameters"],
  ["a required_status_checks list that is a string", (g) => { g.rules[3].parameters!.required_status_checks = "Server tests"; return g; }, "not a list"],
  ["no pull-request rule", (g) => { g.rules.splice(2, 1); return g; }, "pull_request rule 0 time(s)"],
  ["a doubled deletion rule", (g) => { g.rules.push({ type: "deletion" }); return g; }, "deletion rule 2 time(s)"],
  ["a pull-request rule requiring a review", (g) => { g.rules[2].parameters!.required_approving_review_count = 1; return g; }, "required_approving_review_count is 1"],
  ["a pull-request rule requiring thread resolution", (g) => { g.rules[2].parameters!.required_review_thread_resolution = true; return g; }, "required_review_thread_resolution is true"],
  ["a linear-history rule", (g) => { g.rules.push({ type: "required_linear_history" }); return g; }, "carries a required_linear_history rule"],
  ["a bypass actor", (g) => { g.bypass_actors.push({ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }); return g; }, "bypass_actors is not the empty list"],
  ["enforcement set to evaluate", (g) => { g.enforcement = "evaluate"; return g; }, 'enforcement is "evaluate"'],
  ["a push target", (g) => { g.target = "push"; return g; }, 'target is "push"'],
  ["a ruleset aimed at another branch", (g) => { g.conditions!.ref_name.include = ["refs/heads/dev"]; return g; }, "conditions.ref_name is not"],
  ["a ruleset with no conditions", (g) => { g.conditions = null; return g; }, "conditions.ref_name is not"],
  ["no record at all", () => null, "is missing or does not parse"],
  ["a doubled merge-queue rule", (g) => { g.rules.push(QUEUE_RULE(), QUEUE_RULE()); return g; }, "merge_queue rule 2 time(s) — at most once"],
  ["a merge-queue rule with no parameters", (g) => { g.rules.push({ type: "merge_queue", parameters: null }); return g; }, "merge_queue rule has no parameters"],
  ["a queue that squashes", (g) => { g.rules.push(QUEUE_RULE({ merge_method: "SQUASH" })); return g; }, 'merge_method is "SQUASH", not "MERGE"'],
  ["a queue judged on the group's head only", (g) => { g.rules.push(QUEUE_RULE({ grouping_strategy: "HEADGREEN" })); return g; }, 'grouping_strategy is "HEADGREEN"'],
  ["a queue that waits for a second PR", (g) => { g.rules.push(QUEUE_RULE({ min_entries_to_merge: 2 })); return g; }, "min_entries_to_merge is 2, not 1"],
];
/** Non-probes: shapes the rules must not throw on and must report at least one problem for — a record that parsed but is not a ruleset. */
const RULESET_NON_PROBES: [why: string, record: unknown][] = [
  ["a list", []],
  ["a string", "main"],
  ["an object with no fields", {}],
  ["rules that are not a list", { ...RULESET_PROBE(), rules: "deletion" }],
  ["a null rule", { ...RULESET_PROBE(), rules: [null] }],
  ["a null required check", (() => { const g = RULESET_PROBE(); (g.rules[3].parameters!.required_status_checks as (object | null)[]).push(null); return g; })()],
  ["a pull-request rule with no parameters", (() => { const g = RULESET_PROBE(); delete g.rules[2].parameters; return g; })()],
  ["conditions that are a string", { ...RULESET_PROBE(), conditions: "main" }],
  ["a merge-queue rule whose parameters are a string", (() => { const g = RULESET_PROBE(); g.rules.push({ type: "merge_queue", parameters: "MERGE" } as unknown as RulesetProbeRule); return g; })()],
];
/** The skip list the probes judge against, apart from AGGREGATE_MAY_SKIP so that a change there does not move them (review pass 5). */
const PROBE_MAY_SKIP = ["commit-lint"];
/** A workflow aggregateProblems accepts: a plain job, the job AGGREGATE_MAY_SKIP names with its if:, a matrix job named by an expression (allowed since SMD-3168), and the aggregate needing all three. */
type ProbeJobs = Record<string, Record<string, unknown> | null>;
const AGGREGATE_PROBE = (): ProbeJobs => ({
  a: { name: "Server tests" },
  "commit-lint": { name: "Commit messages", if: "github.event_name == 'pull_request'" },
  shard: { name: "Live (${{ matrix.shard }})", strategy: { matrix: { shard: ["rest", "sleep"] } } },
  [AGGREGATE_JOB]: { name: AGGREGATE_NAME, "runs-on": "ubuntu-24.04", if: "always()", needs: ["a", "commit-lint", "shard"], steps: [{ name: "Every job succeeded", env: { NEEDS: AGGREGATE_NEEDS_ENV, MAY_SKIP: PROBE_MAY_SKIP.join(" ") }, run: `${AGGREGATE_RUN}\n` }] },
});
/** The aggregate of AGGREGATE_PROBE, to mutate in place. */
const aggOf = (j: ProbeJobs) => j[AGGREGATE_JOB] as Record<string, unknown> & { steps: { env: Record<string, unknown>; run: string }[] };
/** [why, mutate]: workflows aggregateProblems must ACCEPT beyond the probe. */
const AGGREGATE_ACCEPTED: [why: string, mutate: (j: ProbeJobs) => ProbeJobs][] = [
  ["if: written as an expression", (j) => { aggOf(j).if = "${{ always() }}"; return j; }],
  ["needs as one key, when one job is all there is", () => ({ "commit-lint": { if: "github.event_name == 'pull_request'" }, [AGGREGATE_JOB]: { ...aggOf(AGGREGATE_PROBE()), needs: "commit-lint", steps: [{ env: { NEEDS: AGGREGATE_NEEDS_ENV, MAY_SKIP: PROBE_MAY_SKIP.join(" ") }, run: AGGREGATE_RUN }] } })],
  ["timeouts on the job and the step, and a step id (a timeout is a failure)", (j) => { aggOf(j)["timeout-minutes"] = 5; Object.assign(aggOf(j).steps[0], { id: "verdict", "timeout-minutes": 2 }); return j; }],
  ["continue-on-error: false on a needed job", (j) => { (j.a as Record<string, unknown>)["continue-on-error"] = false; return j; }],
];
/** [why, mutate, a phrase the ONE problem must carry]. */
const AGGREGATE_MUTANTS: [why: string, mutate: (j: ProbeJobs) => ProbeJobs, says: string][] = [
  ["no aggregate job", (j) => { delete j[AGGREGATE_JOB]; return j; }, `has no job ${AGGREGATE_JOB}`],
  ["the aggregate renamed", (j) => { aggOf(j).name = "All green"; return j; }, `is named "All green", not "${AGGREGATE_NAME}"`],
  ["the aggregate run on success() alone", (j) => { aggOf(j).if = "success()"; return j; }, "not if: always()"],
  ["the aggregate with no if:", (j) => { delete aggOf(j).if; return j; }, "not if: always()"],
  ["the aggregate as a matrix", (j) => { aggOf(j).strategy = { matrix: { x: [1] } }; return j; }, "sets strategy, which check 20 does not allow on it"],
  ["a job left out of its needs", (j) => { aggOf(j).needs = ["commit-lint", "shard"]; return j; }, `does not need a`],
  ["a need that is no job", (j) => { aggOf(j).needs = ["a", "commit-lint", "shard", "ghost"]; return j; }, "needs ghost, which is no other job"],
  ["needs that are a number", (j) => { aggOf(j).needs = 3; return j; }, "not a list of the workflow's jobs"],
  ["a step that passes whatever it reads", (j) => { aggOf(j).steps[0].run = "echo ok"; return j; }, "is not AGGREGATE_RUN"],
  ["the verdict's exit 1 dropped", (j) => { aggOf(j).steps[0].run = AGGREGATE_RUN.replace("  exit 1\n", ""); return j; }, "is not AGGREGATE_RUN"],
  ["NEEDS read from somewhere else", (j) => { aggOf(j).steps[0].env.NEEDS = "{}"; return j; }, "reads NEEDS from"],
  ["a second step", (j) => { aggOf(j).steps.push({ env: {}, run: "true" }); return j; }, "2 step(s), not the one verdict step"],
  ["MAY_SKIP naming a job AGGREGATE_MAY_SKIP does not", (j) => { aggOf(j).steps[0].env.MAY_SKIP = "commit-lint a"; return j; }, 'sets MAY_SKIP to "commit-lint a", not "commit-lint"'],
  ["MAY_SKIP emptied", (j) => { aggOf(j).steps[0].env.MAY_SKIP = ""; return j; }, 'sets MAY_SKIP to "", not "commit-lint"'],
  ["MAY_SKIP split by a newline, which the step's jq does not split on", (j) => { aggOf(j).steps[0].env.MAY_SKIP = "commit-lint\n"; return j; }, "sets MAY_SKIP to"],
  ["a job given an if: AGGREGATE_MAY_SKIP does not name", (j) => { (j.a as Record<string, unknown>).if = "github.event_name == 'push'"; return j; }, "job a has an if: of its own and AGGREGATE_MAY_SKIP"],
  ["the job AGGREGATE_MAY_SKIP names with its if: taken off", (j) => { delete (j["commit-lint"] as Record<string, unknown>).if; return j; }, "AGGREGATE_MAY_SKIP names commit-lint, which has no if:"],
  ["the job AGGREGATE_MAY_SKIP names gone", (j) => { delete j["commit-lint"]; aggOf(j).needs = ["a", "shard"]; return j; }, "AGGREGATE_MAY_SKIP names commit-lint, which is no job"],
  ["a skippable job another job needs", (j) => { (j.a as Record<string, unknown>).needs = ["commit-lint"]; return j; }, "AGGREGATE_MAY_SKIP names commit-lint, which a needs"],
  ["a needed job that ignores its own failure", (j) => { (j.a as Record<string, unknown>)["continue-on-error"] = true; return j; }, "job a sets continue-on-error: true"],
  ["the aggregate on another runner", (j) => { aggOf(j)["runs-on"] = "windows-2025"; return j; }, 'runs on "windows-2025", not ubuntu-24.04'],
  ["another job named as the aggregate", (j) => { (j.a as Record<string, unknown>).name = AGGREGATE_NAME; return j; }, `job a is named "${AGGREGATE_NAME}", which carries`],
  ["another job named by an expression whose text carries the aggregate's name", (j) => { (j.a as Record<string, unknown>).name = `\${{ '${AGGREGATE_NAME}' }}`; return j; }, "which carries"],
  ["another job named wholly by an expression (a matrix value)", (j) => { (j.a as Record<string, unknown>).name = "${{ matrix.label }}"; return j; }, "which could render as"],
  ["another job named in part by an expression that could complete the name", (j) => { (j.a as Record<string, unknown>).name = "Fork Checks ${{ matrix.word }}"; return j; }, "which could render as"],
  ["another job named by an expression with a `}}` inside a quoted string", (j) => { (j.a as Record<string, unknown>).name = `\${{ fromJSON('{"a":{"b":"Fork Checks"}}').a.b }} passed`; return j; }, "which could render as"],
  ["another job named as the aggregate in another case", (j) => { (j.a as Record<string, unknown>).name = AGGREGATE_NAME.toLowerCase(); return j; }, "which carries"],
  ["a needed job that calls a reusable workflow", (j) => { (j.a as Record<string, unknown>).uses = "./.github/workflows/called.yml"; return j; }, "job a calls the reusable workflow"],
  ["the aggregate's job continue-on-error", (j) => { aggOf(j)["continue-on-error"] = true; return j; }, "sets continue-on-error, which check 20 does not allow on it"],
  ["the aggregate's job defaults", (j) => { aggOf(j).defaults = { run: { shell: "sh" } }; return j; }, "sets defaults, which check 20 does not allow on it"],
  ["the step continue-on-error", (j) => { (aggOf(j).steps[0] as Record<string, unknown>)["continue-on-error"] = true; return j; }, "step sets continue-on-error"],
  ["the step skipped by its own if:", (j) => { (aggOf(j).steps[0] as Record<string, unknown>).if = "false"; return j; }, "step sets if"],
  ["the step under another shell", (j) => { (aggOf(j).steps[0] as Record<string, unknown>).shell = "bash -c true {0}"; return j; }, "step sets shell"],
  ["a PATH in the step's env", (j) => { aggOf(j).steps[0].env.PATH = "/nowhere"; return j; }, "sets PATH in its env"],
];
/** Non-probes: shapes aggregateProblems must not throw on and must report at least one problem for. */
const AGGREGATE_NON_PROBES: [why: string, doc: unknown][] = [
  ["no jobs", { jobs: null }],
  ["an aggregate that is null", { jobs: { a: {}, [AGGREGATE_JOB]: null } }],
  ["steps that are a string", { jobs: { [AGGREGATE_JOB]: { name: AGGREGATE_NAME, if: "always()", needs: [], steps: "run" } } }],
  ["a step that is null", { jobs: { [AGGREGATE_JOB]: { name: AGGREGATE_NAME, if: "always()", needs: [], steps: [null] } } }],
];
/** AGGREGATE_RUN under bash with NEEDS and MAY_SKIP set: whether it exits 0, or why it could not be run. */
function aggregateRunPasses(needs: string, maySkip: string): boolean | string {
  try {
    execFileSync("bash", ["-eo", "pipefail", "-s"], { input: AGGREGATE_RUN, env: { ...process.env, NEEDS: needs, MAY_SKIP: maySkip }, stdio: ["pipe", "ignore", "ignore"] });
    return true;
  } catch (e) {
    const err = e as { status?: number | null; code?: string };
    return typeof err.status === "number" ? false : `bash did not run (${err.code ?? "no exit status"})`;
  }
}
function checkRulesetRecord() {
  // Self-test: a record every rule accepts passes; each mutant reports exactly
  // one problem, and that problem names what the mutant broke; a non-probe
  // reports something and throws nothing.
  const base = rulesetProblems(RULESET_PROBE());
  if (base.length) fail(SELF, `check 20 false-positives on a consistent record (${base.map((p) => p[1]).join("; ")})`);
  for (const [why, mutate] of RULESET_ACCEPTED) {
    const got = rulesetProblems(mutate(RULESET_PROBE()));
    if (got.length) fail(SELF, `check 20 refuses ${why} (its own probe): ${got.map((p) => p[1]).join("; ")}`);
  }
  for (const [why, mutate, says] of RULESET_MUTANTS) {
    const got = rulesetProblems(mutate(RULESET_PROBE()));
    if (got.length !== 1) fail(SELF, `check 20 reports ${got.length} problem(s) for ${why}, not one (its own probe): ${JSON.stringify(got)}`);
    else if (!got[0][1].includes(says)) fail(SELF, `check 20's one problem for ${why} does not say "${says}" (its own probe): ${got[0][1]}`);
  }
  for (const [why, record] of RULESET_NON_PROBES) {
    let got: [string, string][];
    try { got = rulesetProblems(record as RulesetDoc); } catch (e) { fail(SELF, `check 20 throws for ${why}: ${(e as Error).message} (its own probe)`); continue; }
    if (!got.length) fail(SELF, `check 20 accepts ${why} (its own probe)`);
  }
  // The aggregate's rules, the same way: the probe passes, each accepted
  // shape passes, each mutant reports one problem naming what it broke.
  const aggBase = aggregateProblems({ jobs: AGGREGATE_PROBE() } as JobsDoc, PROBE_MAY_SKIP);
  if (aggBase.length) fail(SELF, `check 20 false-positives on a consistent workflow (${aggBase.map((p) => p[1]).join("; ")})`);
  for (const [why, mutate] of AGGREGATE_ACCEPTED) {
    const got = aggregateProblems({ jobs: mutate(AGGREGATE_PROBE()) } as JobsDoc, PROBE_MAY_SKIP);
    if (got.length) fail(SELF, `check 20 refuses ${why} (its own probe): ${got.map((p) => p[1]).join("; ")}`);
  }
  for (const [why, mutate, says] of AGGREGATE_MUTANTS) {
    const got = aggregateProblems({ jobs: mutate(AGGREGATE_PROBE()) } as JobsDoc, PROBE_MAY_SKIP);
    if (got.length !== 1 || !got[0][1].includes(says)) fail(SELF, `check 20 reports ${JSON.stringify(got)} for ${why}, not one problem saying "${says}" (its own probe)`);
  }
  for (const [why, doc] of AGGREGATE_NON_PROBES) {
    let got: [string, string][];
    try { got = aggregateProblems(doc as JobsDoc, PROBE_MAY_SKIP); } catch (e) { fail(SELF, `check 20 throws for ${why}: ${(e as Error).message} (its own probe)`); continue; }
    if (!got.length) fail(SELF, `check 20 accepts ${why} (its own probe)`);
  }
  // Nothing skippable: MAY_SKIP may be "" or absent, and a job's if: is then refused.
  const noSkip = (env: Record<string, string>) => ({ jobs: { x: {}, [AGGREGATE_JOB]: { name: AGGREGATE_NAME, "runs-on": AGGREGATE_RUNNER, if: "always()", needs: ["x"], steps: [{ env: { NEEDS: AGGREGATE_NEEDS_ENV, ...env }, run: AGGREGATE_RUN }] } } }) as JobsDoc;
  for (const env of [{}, { MAY_SKIP: "" }] as Record<string, string>[]) {
    const got = aggregateProblems(noSkip(env), []);
    if (got.length) fail(SELF, `check 20 refuses an empty skip list with MAY_SKIP ${"MAY_SKIP" in env ? "empty" : "absent"} (its own probe): ${got.map((p) => p[1]).join("; ")}`);
  }
  for (const [name, answer] of MAY_REPORT_CASES) {
    const got = mayReportAs(name, AGGREGATE_NAME);
    if (got !== answer) fail(SELF, `check 20's mayReportAs answers ${JSON.stringify(got)} for the name ${shownName(name)}, not ${JSON.stringify(answer)} (its own case, review pass 5)`);
  }
  const longStart = performance.now();
  const longName = mayReportAs("${{a}}".repeat(5000) + "z", AGGREGATE_NAME);
  const longMs = performance.now() - longStart;
  if (longName !== null || longMs > 1000) fail(SELF, `check 20's mayReportAs reads a name of 5,000 expressions as ${JSON.stringify(longName)} in ${Math.round(longMs)} ms — it must be null, and at once: a RegExp built from a name backtracks (review pass 4, its own probe)`);
  const otherClash = nameClashes("probe.yml", { jobs: { build: { name: "Build" }, spoof: { name: AGGREGATE_NAME } } } as JobsDoc, null);
  if (otherClash.length !== 1 || !otherClash[0][1].includes("job spoof")) fail(SELF, `check 20 reports ${JSON.stringify(otherClash)} for another workflow's job named "${AGGREGATE_NAME}", not one problem naming it (its own probe)`);
  // The step itself, run: AGGREGATE_RUN is the text the job holds, so its
  // verdict on each case is the job's. jq absent would read as every case
  // failing, so it is looked for first (review pass 1).
  let haveJq = true;
  try { execFileSync("jq", ["--version"], { stdio: "ignore" }); } catch { haveJq = false; fail(SELF, "check 20 runs AGGREGATE_RUN with jq, as the job does, and jq is not on PATH here — install jq (SMD-3168)"); }
  for (const [why, needs, maySkip, passes] of haveJq ? AGGREGATE_CASES : []) {
    const got = aggregateRunPasses(needs, maySkip);
    if (typeof got === "string") { fail(SELF, `check 20 runs AGGREGATE_RUN under bash with jq, as the job does, and here ${got} — install bash and jq (SMD-3168)`); break; }
    if (got !== passes) fail(SELF, `check 20's AGGREGATE_RUN ${got ? "passes" : "fails"} when ${why}, where the job must ${passes ? "pass" : "fail"} (its own case, SMD-3168)`);
  }
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    fail(SELF, `check 20 parses ${WORKFLOW} with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-1856)`);
    return;
  }
  let ruleset: RulesetDoc = null;
  if (existsSync(join(ROOT, RULESET))) {
    try { ruleset = JSON.parse(readFileSync(join(ROOT, RULESET), "utf8")); } catch { ruleset = null; }
  }
  let doc: JobsDoc = null;
  try { doc = Bun.YAML.parse(readFileSync(join(ROOT, WORKFLOW), "utf8")) as JobsDoc; } catch (e) { return fail(WORKFLOW, `does not parse: ${(e as Error).message} — check 20 has no job list to hold the record to (SMD-1856)`); }
  if (!doc?.jobs || !Object.keys(doc.jobs).length) return fail(WORKFLOW, "has no jobs check 20 can read — nothing for the one required check to need (SMD-1856)");
  for (const [where, msg] of [...aggregateProblems(doc), ...rulesetProblems(ruleset)]) fail(where, msg);
  // Every other workflow, for a job that would report a check under the one
  // context (review pass 1); one that does not parse is check 23's to report.
  const workflowsDir = join(ROOT, ".github", "workflows");
  for (const f of existsSync(workflowsDir) ? readdirSync(workflowsDir).sort() : []) {
    const rel = `.github/workflows/${f}`;
    if (!/\.ya?ml$/.test(f) || rel === WORKFLOW) continue;
    let other: JobsDoc = null;
    try { other = Bun.YAML.parse(readFileSync(join(workflowsDir, f), "utf8")) as JobsDoc; } catch { continue; }
    for (const [where, msg] of nameClashes(rel, other, null)) fail(where, msg);
  }
}
checkRulesetRecord();

// ── 21: a .sql file never destroys rows a brain already holds ────────────────
//
// SMD-1936. CLAUDE.md's guard rail and CONTRIBUTING.md's review checklist said
// "no DROP TABLE, DROP DATABASE, TRUNCATE or unqualified DELETE FROM in SQL
// files" and nothing on this fork checked it. Upstream's PR gate
// (ob1-gate-v2.yml, rule 5) greps a PR's changed .sql files for the words on
// any line, comments included, and calls a DELETE unqualified when its own
// line has no WHERE; the fork does not run that gate (FORK.md's detach note:
// it enforces contribution rules this fork does not follow), and
// read that literally the rail fails the one file that applies it — 046's
// `BEFORE TRUNCATE ON thought_audit` trigger, which REFUSES truncation, was
// flagged twice in SMD-1730's review against the sentence — and 034's
// `DELETE FROM query_log` with its WHERE on the next line. So the rule is
// stated as what it means, a SQL file must never destroy rows a brain already
// holds, and read as STATEMENTS: db/config.mjs's DESTRUCTIVE_SQL_RULES through
// destructiveSqlIn — the comment-stripped text (stripSqlComments, literal-
// aware, so a header quoting a statement to say why the file has none is not
// a hit), a TRUNCATE counted only when a table follows it (a trigger event, a
// privilege and the bare value `TG_OP = 'TRUNCATE'` are not it), a DELETE FROM
// counted only when its statement — to the `;`, or the `)` that closes its
// CTE, a literal's parentheses and semicolons not counted — has no WHERE of
// its own at the top level (a WHERE inside a USING subquery or a format()
// argument qualifies nothing; the first review pass found both holes), DROP
// TABLE, DROP DATABASE/SCHEMA and DROP OWNED wherever they stand outside a
// quoted identifier (`"a DROP TABLE b"` names a column), string literals read
// because an EXECUTE string runs — which makes a statement quoted in prose
// (`RAISE EXCEPTION 'TRUNCATE refused'`) a hit as well; the remedy is check
// 12's, a `--` comment or a rewording, and the messages say so. test-schema
// does not repeat the scan: the migrations are in this check's scope as
// files, and a substituted value (`${EMBEDDING_DIM}`) is never one of these
// statements.
//
// Scope: every .sql git tracks or would track (citationFiles, check 15's
// listing) — the seven category directories, docs/, deploy/ AND
// db/migrations/; an ignored file, the Supabase CLI's supabase/migrations or
// a recipe's data/, is not the tree's. The fork's migrations DROP FUNCTION and DROP TRIGGER deliberately
// (032/033/046's ACL replays, 046's own trigger), which the rail does not name
// and which destroy no row; no migration has ever dropped a table — a scratch
// table is a TEMP table ON COMMIT DROP (016's `_rte_in`), and the dead `DROP
// TABLE IF EXISTS` change 61 records was db/migrate.ts's, TypeScript — so the
// migrations are held to the same rule with no carve-out. Outside the rule, by
// the rail's own words ("in SQL files"): SQL inside .ts (compat's suite drops
// the tables it makes, test-schema empties the one it owns) and the heredocs
// of a recipe's init .sh. Exceptions are per (file, rule) and COUNTED as check
// 7's are; the list is empty, and a file that needs one says why beside it.

/** Statements each rule must catch — the check's own negative tests, run through the rules every time. */
const DESTRUCTIVE_SQL_PROBES: [string, string][] = [
  ["truncate", "TRUNCATE thoughts;"],
  ["truncate", "truncate table only public.thoughts restart identity cascade;"],
  ["truncate", 'TRUNCATE "thoughts";'],
  ["truncate", "BEGIN\n  TRUNCATE\n    thought_chunks;\nEND"],
  ["truncate", "EXECUTE 'TRUNCATE ' || quote_ident(p_table);"],
  ["truncate", "EXECUTE format('TRUNCATE %I', p_table);"],
  ["drop-table", "DROP TABLE IF EXISTS thoughts CASCADE;"],
  ["drop-table", "drop table pg_temp.scratch;"],
  ["drop-database", "DROP DATABASE open_brain;"],
  ["drop-database", "DROP SCHEMA public CASCADE;"],
  ["unqualified-delete", "DELETE FROM thoughts;"],
  ["unqualified-delete", "DELETE FROM thoughts RETURNING id;"],
  ["unqualified-delete", "delete from only thoughts"],
  ["unqualified-delete", "DELETE FROM thoughts -- WHERE id = $1\n;"],
  ["unqualified-delete", "WITH gone AS (DELETE FROM thoughts RETURNING id) SELECT count(*) FROM gone WHERE id IS NOT NULL;"],
  ["unqualified-delete", "EXECUTE format('DELETE FROM %I', p_table);"],
  // First review pass: a WHERE that is not the statement's own, a literal that would move its boundary, the forms the regexes missed.
  ["unqualified-delete", "DELETE FROM thoughts USING (SELECT id FROM x WHERE y) s;"],
  ["unqualified-delete", "DELETE FROM thoughts RETURNING 'WHERE';"],
  ["unqualified-delete", "WITH d AS (DELETE FROM thoughts RETURNING id, '(') SELECT 1 WHERE true;"],
  ["unqualified-delete", "EXECUTE format('DELETE FROM %I', (SELECT n FROM x WHERE k = 1));"],
  // The `)` that closes the CTE must END the statement, not just lower the depth: a later CTE's
  // WHERE sits at depth 0 again once its `(` reopens (the depth-0 rule alone let this pass).
  ["unqualified-delete", "WITH d AS (DELETE FROM thoughts RETURNING id), e AS (SELECT 1 WHERE true) SELECT * FROM e;"],
  ["truncate", "EXECUTE format('TRUNCATE %1$I', p_table);"],
  ["truncate", "EXECUTE $q$TRUNCATE $q$ || quote_ident(p_table);"],
  ["drop-database", "DROP OWNED BY community CASCADE;"],
  // Second review pass: an apostrophe inside a dollar-quoted value must not open a literal that swallows the rest of the file; a tag may carry digits.
  ["unqualified-delete", "COMMENT ON TABLE t IS $q1$don't$q1$;\nDELETE FROM t RETURNING 'WHERE';"], // the blanker's own tag grammar, digits included
  ["truncate", "EXECUTE $q1$TRUNCATE $q1$ || quote_ident(p_table);"],
  // Third review pass: a dollar-quoted dynamic string's delete, and an unquoted non-ASCII name.
  ["unqualified-delete", "EXECUTE $q$DELETE FROM $q$ || quote_ident(p_table);"],
  ["truncate", "TRUNCATE Übersicht;"],
];
/** SQL this repository writes that no rule may catch. */
const DESTRUCTIVE_SQL_NON_PROBES = [
  "-- TRUNCATE thoughts; is what this file must never run",
  "/* DROP TABLE thoughts; DELETE FROM thoughts; */",
  "CREATE TRIGGER thought_audit_immutable_truncate\n  BEFORE TRUNCATE ON thought_audit\n  FOR EACH STATEMENT EXECUTE FUNCTION thought_audit_refuse_mutation();",
  "CREATE TRIGGER t AFTER INSERT OR DELETE OR TRUNCATE ON thoughts FOR EACH STATEMENT EXECUTE FUNCTION f();",
  "GRANT SELECT, INSERT, TRUNCATE ON thoughts TO community;",
  "REVOKE TRUNCATE, DELETE ON thoughts FROM PUBLIC;",
  "CASE WHEN TG_OP = 'TRUNCATE' THEN 'thought_audit_immutable_truncate' ELSE 'thought_audit_immutable' END",
  "DELETE FROM thoughts WHERE id = $1;",
  "DELETE FROM query_log\n   WHERE logged_at < now() - make_interval(days => p_keep_days);",
  "DELETE FROM _rte_in WHERE true;",
  "DELETE FROM _rte_in a USING _rte_in b\n   WHERE a.ntype = b.ntype AND a.nname = b.nname;",
  "WITH d AS (DELETE FROM ob1_entity_edges WHERE thought_id = p_thought_id RETURNING from_entity_id) SELECT 1;",
  "DELETE FROM thoughts WHERE id IN (SELECT id FROM thoughts ORDER BY created_at LIMIT 1);",
  "EXECUTE 'DELETE FROM ' || quote_ident(p_table) || ' WHERE id = $1' USING p_id;",
  "EXECUTE format('DELETE FROM %I WHERE id = $1', p_table) USING p_id;",
  "CREATE TEMP TABLE IF NOT EXISTS _rte_in (name text) ON COMMIT DROP;",
  "DROP TRIGGER IF EXISTS thought_audit_immutable_truncate ON thought_audit;",
  "DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb);",
  "DROP POLICY IF EXISTS p ON t;",
  "ALTER TABLE thoughts DROP CONSTRAINT IF EXISTS thoughts_derivation_layer_check;",
  "REFERENCES thoughts(id) ON DELETE CASCADE",
  "CREATE POLICY p ON t FOR DELETE USING (true);",
  "COMMENT ON COLUMN thoughts.truncated_at IS 'when the text was cut';",
  'SELECT "TRUNCATE", "DELETE FROM" FROM information_schema.role_table_grants;',
  "SELECT has_table_privilege('community', 'thoughts', 'TRUNCATE');",
  "ALTER TABLE thoughts ENABLE ALWAYS TRIGGER thought_audit_immutable_truncate;",
  "DELETE FROM thoughts WHERE false;",
  "COMMENT ON FUNCTION prune_query_log(int) IS 'Delete query_log rows older than p_keep_days. The DELETE is always bounded by logged_at.';",
  "DELETE FROM thoughts USING f(')') g WHERE thoughts.id = g.id;",
  "DELETE FROM thoughts USING (SELECT ';' AS s) x WHERE thoughts.id = $1;", // the literal's `;` before the WHERE
  // Second review pass: a keyword anywhere inside a quoted identifier; an apostrophe in a dollar-quoted value before a qualified delete.
  'SELECT "my TRUNCATE", "a DROP TABLE b", "x DELETE FROM y" FROM information_schema.role_table_grants;',
  "COMMENT ON TABLE t IS $$don't$$;\nDELETE FROM t USING f(')') g WHERE t.id = g.id;",
  "EXECUTE $q$DELETE FROM $q$ || quote_ident(p_table) || ' WHERE id = $1';", // third pass: the WHERE arrives in a `'…'` piece the blanked walk cannot see
];
/** file → rule → the reason and the exact hit count; a hit past the count fails, a count no hit reaches fails as stale. Empty: no file in the tree needs one. */
const DESTRUCTIVE_SQL_EXCEPTIONS = new Map<string, Record<string, CountedException>>([]);

function checkDestructiveSql() {
  const rules = new Set(DESTRUCTIVE_SQL_RULES.map((r) => r.name));
  for (const [rule, probe] of DESTRUCTIVE_SQL_PROBES) {
    if (!rules.has(rule)) { fail(SELF, `check 21's probe names rule '${rule}', which DESTRUCTIVE_SQL_RULES does not define (its own probe)`); continue; }
    if (!destructiveSqlIn(probe).some((h) => h.rule === rule)) fail(SELF, `check 21's rule '${rule}' no longer catches its probe: ${JSON.stringify(probe)} (its own probe)`);
  }
  for (const text of DESTRUCTIVE_SQL_NON_PROBES) {
    const [hit] = destructiveSqlIn(text);
    if (hit) fail(SELF, `check 21's rule '${hit.rule}' catches SQL this repository writes: ${JSON.stringify(text)} (its own probe)`);
  }
  // The line is the statement's own, through comments and a plpgsql body alike.
  const lined = destructiveSqlIn("-- a header\nCREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  -- TRUNCATE in prose\n  TRUNCATE thoughts;\nEND;\n$$;\n");
  if (lined.map((h) => `${h.rule}@${h.line}`).join(",") !== "truncate@5") fail(SELF, `check 21 reports ${JSON.stringify(lined.map((h) => `${h.rule}@${h.line}`))} for a TRUNCATE on line 5 of a function body, expected ["truncate@5"] (its own probe)`);

  const counts = new Map<string, number>();
  // The files git tracks or would track, as check 15 reads them — so an ignored
  // .sql (the Supabase CLI's supabase/migrations, a recipe's data/) is not the
  // tree's, as .gitignore promises of this script (first review pass; the walk
  // read the disk). citationFiles skips a file over 4 MB; no .sql is near it.
  const files = citationFiles().filter((rel) => rel.endsWith(".sql"));
  if (files.length === 0) fail(SELF, "check 21 found no .sql file in the tree — the listing or its filter is broken, and the rule would pass everything");
  for (const rel of files) {
    for (const h of destructiveSqlIn(readFileSync(join(ROOT, rel), "utf8"))) {
      const key = `${rel} ${h.rule}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (DESTRUCTIVE_SQL_EXCEPTIONS.get(rel)?.[h.rule]) continue;
      fail(`${rel}:${h.line}`, `${h.msg} (SMD-1936)`);
    }
  }
  for (const [rel, byRule] of DESTRUCTIVE_SQL_EXCEPTIONS) {
    for (const [rule, { why, lines }] of Object.entries(byRule)) {
      const seen = counts.get(`${rel} ${rule}`) ?? 0;
      if (seen !== lines) {
        fail(rel, seen === 0
          ? `listed as a destructive-SQL exception for '${rule}' (${why}) but matches nothing — remove it from DESTRUCTIVE_SQL_EXCEPTIONS`
          : `destructive-SQL exception for '${rule}' (${why}) covers ${lines} line(s) but ${seen} match — a new statement beside the documented one, or the exception's count is stale`);
      }
    }
  }
}
checkDestructiveSql();

// ── 22: no vendored file imports @supabase/supabase-js at runtime ────────────
//
// SMD-1798 (the third of SMD-1795's seven). Every vendored MCP server, API,
// worker and script reaches the brain through compat/supabase-sql — Bun's
// Postgres client in supabase-js's shape — so running any of them needs no
// Supabase project, PostgREST or service key; supabase-js left the server with
// its PostgREST store and the Cloudflare Workers target (SMD-3152, check 22b),
// which were outside this scan (the shim's own suite writes its PostgREST
// expectations by hand and loads no oracle; server/index.ts, the Edge Function
// build that also held it, left with SMD-1800). This is what keeps the next rebase, or
// the next vendored file, from bringing a PostgREST client back: a
// specifier-shaped string naming the package — "@supabase/supabase-js",
// "npm:@supabase/supabase-js@2", "jsr:@supabase/supabase-js@2", a CDN URL
// ("https://esm.sh/@supabase/supabase-js@2", unpkg's), with or without a
// subpath — in any code file (.ts, .tsx, .mts, .cts, .js, .jsx, .mjs, .cjs,
// .svelte, .vue, and .html for an inline module script) under the seven
// category directories and docs/, comments blanked (the codemod's
// `// ob1-original-import:` record is a comment; a README's sample is prose,
// SMD-1802's), is a hit, whatever statement holds it: an import, a type-only
// import, a require, a dynamic import. Counted per-file exceptions, as check 7
// counts them — none today: the dashboard's type-only import went when its
// Supabase sign-in did (SMD-1801); the one client the codemod's KEEP list held
// on supabase-js — local-brain-no-mcp's, inside that recipe's own Supabase
// stack — left with the recipe (SMD-1800). Every other vendored client moved:
// the rest in change 74, the last six here.
const SUPABASE_JS_SPECIFIER = /(["'])(?:npm:|jsr:|https?:\/\/[^"'\s]*\/)?@supabase\/supabase-js(?:@[^"'/]*)?(?:\/[^"']*)?\1/g;
/** Code, and HTML for the inline `<script type="module">` a dashboard's page may carry. */
const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|svelte|vue|html)$/;
/** [text, whether it is a hit, markup?] — the forms the tree has had, and the neighbours the rule must not reach. */
const SUPABASE_JS_PROBES: [string, boolean, boolean?][] = [
  ['import { createClient } from "@supabase/supabase-js";', true],
  ["import { createClient } from 'npm:@supabase/supabase-js@2';", true],
  ['import { createClient } from "jsr:@supabase/supabase-js@2";', true],
  ['import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";', true],
  ['import { createClient } from "https://esm.sh/v135/@supabase/supabase-js@2";', true],
  ['<p>Don\'t panic</p>\n<script type="module">import { createClient } from \'https://unpkg.com/@supabase/supabase-js@2/dist/module/index.js\';</script>', true, true],
  ['import type { Session, User } from "@supabase/supabase-js";', true],
  ['const { createClient } = require("@supabase/supabase-js");', true],
  ['const m = await import("@supabase/supabase-js/dist/module/index.js");', true],
  ['import { createClient } from "../../compat/supabase-sql/index.ts";', false],
  ['// ob1-original-import: @supabase/supabase-js\nimport { createClient } from "../../compat/supabase-sql/index.ts";', false],
  ['import "jsr:@supabase/functions-js/edge-runtime.d.ts";', false],
  ['/* import { createClient } from "@supabase/supabase-js"; */\nconst x = 1;', false],
  ['const note = "the file imports @supabase/supabase-js at runtime";', false],
  ['import { createClient } from "@supabase/supabase-js-shaped/thing";', false],
  // Markup: a commented-out script and a link in prose are not imports.
  ['<!-- <script>import x from "@supabase/supabase-js";</script> -->\n<a href="https://npmjs.com/package/@supabase/supabase-js">docs</a>\n<script>const y = 1;</script>', false, true],
];
/** file → rule → the reason and the exact hit count; a hit past the count fails, a count no hit reaches fails as stale. */
const SUPABASE_JS_EXCEPTIONS = new Map<string, Record<string, CountedException>>([]);
/** A markup file's code is its `<script>` bodies: everything else, an HTML comment included, is blanked (newlines kept). */
const MARKUP_FILE = /\.(html|svelte|vue)$/;
function scriptBodiesOf(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, blank);
  let out = "";
  let last = 0;
  for (const m of withoutComments.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    // The body starts after the opening tag's `>` (its attributes hold none): anchored there, not by searching the
    // match for the body's text, which a body repeated in an attribute would find first.
    const start = m.index! + m[0].indexOf(">") + 1;
    out += blank(withoutComments.slice(last, start)) + m[1];
    last = start + m[1].length;
  }
  return out + blank(withoutComments.slice(last));
}
/** The 1-based lines of `text` holding a supabase-js specifier, ascending — comments blanked; in markup, the script bodies alone (an odd apostrophe in prose had shifted the blanker's quote parity and hidden an import). */
function supabaseJsImportsIn(text: string, markup = false): number[] {
  const code = blanked(markup ? scriptBodiesOf(text) : text, false);
  const lineOf = lineIndexer(code);
  const lines = new Set<number>();
  for (const m of code.matchAll(SUPABASE_JS_SPECIFIER)) lines.add(lineOf(m.index!));
  return [...lines].sort((a, b) => a - b);
}
function checkSupabaseJsImports() {
  // The file sets have no witness in the tree today (no .html under the roots names the package): held by name.
  for (const name of ["x.ts", "x.tsx", "x.mts", "x.cts", "x.js", "x.jsx", "x.mjs", "x.cjs", "x.svelte", "x.vue", "x.html"]) if (!CODE_FILE.test(name)) fail(SELF, `check 22's CODE_FILE no longer reads ${name} (its own probe)`);
  for (const name of ["x.md", "x.sql", "x.json", "x.htm"]) if (CODE_FILE.test(name)) fail(SELF, `check 22's CODE_FILE reads ${name}, which it should not (its own probe)`);
  for (const name of ["x.html", "x.svelte", "x.vue"]) if (!MARKUP_FILE.test(name)) fail(SELF, `check 22's MARKUP_FILE no longer treats ${name} as markup (its own probe)`);
  if (MARKUP_FILE.test("x.ts")) fail(SELF, "check 22's MARKUP_FILE treats x.ts as markup (its own probe)");
  for (const [probe, hit, markup] of SUPABASE_JS_PROBES) {
    const n = supabaseJsImportsIn(probe, markup === true).length;
    if (hit && n === 0) fail(SELF, `check 22 no longer catches its probe: ${JSON.stringify(probe)} (its own probe)`);
    if (!hit && n > 0) fail(SELF, `check 22 catches a non-probe: ${JSON.stringify(probe)} (its own probe)`);
  }
  const files = textFilesUnder(SCANNED_ROOTS).filter((f) => CODE_FILE.test(f));
  if (files.length === 0) fail(SELF, "check 22 found no code file under the seven category directories and docs/ — the listing is broken, not the tree clean");
  const seen = new Set<string>();
  for (const file of files) {
    const rel = relOf(file);
    const lines = supabaseJsImportsIn(readFileSync(file, "utf8"), MARKUP_FILE.test(file));
    const excepted = SUPABASE_JS_EXCEPTIONS.get(rel)?.["supabase-js"];
    if (excepted) {
      seen.add(rel);
      if (lines.length !== excepted.lines) fail(rel, `check 22's exception covers ${excepted.lines} line(s) of a supabase-js import and the file has ${lines.length} — ${lines.length > excepted.lines ? "a new import, or a moved one" : "the exception is stale"} (${excepted.why})`);
      continue;
    }
    for (const line of lines) {
      fail(`${rel}:${line}`, `imports @supabase/supabase-js at runtime — every vendored server reaches the brain through compat/supabase-sql since SMD-1798 (\`bun scripts/migrate-to-sql-shim.ts --apply ${rel}\`; the shim's README says what it still refuses); the server dropped it with its PostgREST store (SMD-3152)`);
    }
  }
  for (const rel of SUPABASE_JS_EXCEPTIONS.keys()) if (!seen.has(rel)) fail(rel, "check 22's exception names a file the scan does not reach — stale, or the file is gone");
}
checkSupabaseJsImports();

// ── 22b: the retired Workers target stays retired (SMD-3152) ─────────────────
//
// The PostgREST store was kept for one target, Cloudflare Workers
// (server-portable/wrangler.toml pinned OB1_STORE=postgrest), and no brain ran
// it: stable and canary run the compose stack on the SQL store. SMD-3152
// removed the store, the target, their CI steps and their docs. This keeps a
// rebase, a revert or a copied guide from bringing either back unseen: the two
// files stay gone, server-portable's package.json names neither wrangler nor
// supabase-js, and no live file names `wrangler` or sets OB1_STORE to
// postgrest. A code file is exempt from the second pattern alone: the refusal
// and its tests spell the selection they refuse. The history (changes/,
// CHANGELOG.md, FORK.md) records what was. dashboards/ was exempt from both
// while the Next dashboard deployed to Cloudflare with wrangler of its own;
// it retired with SMD-3309, and the exemption with it.
/** `wrangler` as a word, any case. */
const WRANGLER_WORD = /\bwrangler\b/i;
/**
 * OB1_STORE set to postgrest on one line — an env line, a YAML, TOML or JSON
 * key, a shell assignment, a Dockerfile `ENV` with its space, a compose
 * default (`${OB1_STORE:-postgrest}`) — any case, quoted or not. A value on a
 * line of its own (Kubernetes' `name:`/`value:` pair) is not read: structure
 * across lines is a parser's job, and the runtime refuses the selection anyway.
 */
const POSTGREST_SELECTED = /\bOB1_STORE["']?(?:\s*[=:]\s*|\s+)(?:\$\{OB1_STORE:?-)?["']?postgrest\b/i;
/** [text, wrangler?, postgrest selected?] — what 22b must catch, and the neighbours it must not reach. */
const RETIRED_TARGET_PROBES: [string, boolean, boolean][] = [
  ["bunx wrangler deploy --dry-run --outdir=.cf-out", true, false],
  ['"wrangler": "4.127.1"', true, false],
  ["Wrangler dev serves it", true, false],
  ["OB1_STORE=postgrest", false, true],
  ['OB1_STORE = "postgrest"', false, true],
  ["      OB1_STORE: postgrest", false, true],
  ["export OB1_STORE='PostgREST'", false, true],
  ['"OB1_STORE": "postgrest"', false, true],
  ["ENV OB1_STORE postgrest", false, true],
  ["      OB1_STORE: ${OB1_STORE:-postgrest}", false, true],
  ["OB1_STORE=sql", false, false],
  ["      OB1_STORE: ${OB1_STORE:-sql}", false, false],
  ["OB1_STORE is unset; postgrest is refused", false, false],
  ["the PostgREST store, retired", false, false],
  ["wranglers' wrangling", false, false],
];
const RETIRED_FILES = ["server-portable/wrangler.toml", "server-portable/wrangler.json", "server-portable/wrangler.jsonc", "server-portable/store-postgrest.ts", "server-portable/test-store-postgrest.ts"];
const isHistory = (rel: string) => rel.startsWith("changes/") || rel === "CHANGELOG.md" || rel === "FORK.md";
function checkRetiredTarget() {
  for (const [probe, wrangler, selected] of RETIRED_TARGET_PROBES) {
    if (WRANGLER_WORD.test(probe) !== wrangler) fail(SELF, `check 22b's wrangler pattern ${wrangler ? "misses" : "catches"} its probe ${JSON.stringify(probe)} (its own probe)`);
    if (POSTGREST_SELECTED.test(probe) !== selected) fail(SELF, `check 22b's OB1_STORE pattern ${selected ? "misses" : "catches"} its probe ${JSON.stringify(probe)} (its own probe)`);
  }
  for (const rel of RETIRED_FILES) if (existsSync(join(ROOT, rel))) fail(rel, "the retired Workers target's file is back (SMD-3152): the PostgREST store and wrangler.toml served no brain — delete it");
  const pkg = JSON.parse(readFileSync(join(ROOT, "server-portable/package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  for (const dep of ["wrangler", "@supabase/supabase-js"]) {
    if (pkg.dependencies?.[dep] || pkg.devDependencies?.[dep]) fail("server-portable/package.json", `names ${dep}, which only the retired Workers target and PostgREST store needed (SMD-3152)`);
  }
  const files = citationFiles().filter((rel) => !isHistory(rel));
  if (!files.includes("SETUP.md")) fail(SELF, "check 22b's listing does not reach SETUP.md — the listing is broken, not the tree clean");
  for (const rel of files) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    const code = CODE_FILE.test(rel);
    text.split("\n").forEach((line, i) => {
      if (WRANGLER_WORD.test(line)) fail(`${rel}:${i + 1}`, "names wrangler — the Cloudflare Workers target was retired (SMD-3152); the brain deploys as the compose stack");
      if (!code && POSTGREST_SELECTED.test(line)) fail(`${rel}:${i + 1}`, "sets OB1_STORE to postgrest — the PostgREST store was retired (SMD-3152) and the server refuses the selection; leave OB1_STORE unset");
    });
  }
}
checkRetiredTarget();

// ── 22c: the brain deploys as the compose stack alone (SMD-2288) ─────────────
//
// SMD-2282's decision 6: the brain is the compose stack (the proxy, the REST
// core, the MCP server at /mcp, Postgres and the profiles beside them), with no
// single-process mode. The MCP server is a client of the REST core on the
// stack's internal network, so no other shape can run it. SMD-3152 retired the
// Workers target (22b) and SMD-2288 the Kubernetes one; this keeps a doc from
// teaching another. A doc fails on a line that starts one of the brain's
// servers by path from outside its directory or runs a `dev` or `start` script
// there (after a `cd`, or by `--cwd`, `--prefix`, `--dir` or `-C`), runs the
// server image alone as a server, or drives a cluster or a platform's deploy. A
// command continued with `\` is read as one line, and the steps after a `cd`
// cross `;` but never another `cd`. Between the runtime and the path only flags,
// `run`, `watch` and a bare `--` are read, so prose ("a graph node is written by
// server-portable/api.ts") passes. The image run with `--entrypoint` and a tool
// (keygen.ts, in deploy/README.md) passes; with a runtime for it and the
// server's entry later on the line, a path or the bare file the image's
// directory holds, it fails (a tool given a file of that name as an argument
// would too). `bun index.ts` on a line of its own, inside server-portable/ or
// mcp-server/, is how their tests run the entry and is not read; a `cd` on the
// line before it is not joined to it either. Compose's own command spelled with
// the runtime (`bun ../mcp-server/index.ts`) fails like any other: name the file
// and the entrypoint apart. A path segment holds no `/`, and a flag splits one
// way (FLAGS), so a long path or a long run of flags is read once: either read
// two ways, a line of thirty ran past Bun's backtracking limit and the match
// returned false, a violation missed. The probes hold both with a line of
// thirty. The history (changes/, CHANGELOG.md, FORK.md) records what was.
/** Path characters: no space, quote, backtick or shell separator. */
const PATH_CHAR = String.raw`[^\s"'\x60|;&,]`;
/** One path segment and its slash: no `/` inside, so a path splits one way. */
const SEGMENT = String.raw`[^\s"'\x60|;&,/]+\/`;
/** One of the brain's server directories, from the root, `./`, `../` or absolute. */
const BRAIN_DIR = String.raw`\/?(?:${SEGMENT})*?(?:server-portable|mcp-server)`;
/** One of their entry files by that path, quoted or not. */
const BRAIN_ENTRY = String.raw`["'\x60]?${BRAIN_DIR}\/(?:index|api)\.[jt]s\b`;
/** The entry file alone, `./` or not, as a word of its own: not the tail of another directory's path. */
const BARE_ENTRY = String.raw`(?<![\w/.-])(?:\.\/)?(?:index|api)\.[jt]s\b`;
/** A runtime that would start it, as a word: not `bun build`, `bun test` or `bun install`, which start nothing. */
const RUNTIME = String.raw`\b(?:bun|node|deno|tsx|pm2\s+start)\b(?!\s+(?:build|test|install)\b)`;
/** A quoted value, either quote. */
const QUOTED = String.raw`(?:"[^"\n]*"|'[^'\n]*')`;
/**
 * Flags, `run` and `watch` (`tsx watch`). Each splits one way: a flag's name
 * starts with a word character after its dashes (`--?[\w-]+` read `--a` as
 * `--` `a` or `-` `-a`); a value after `=` is quoted or runs to the next space
 * (commas in it: `--allow-env=PORT,DATABASE_URL`); a value after a space is
 * quoted, or starts with neither `-` nor the words `run` and `watch`; and a
 * bare `--` ends the flags (`pm2 start bun -- …`). Two ways a word, thirty
 * words ran past Bun's backtracking limit and the match returned false.
 */
const FLAGS = String.raw`(?:\s+(?:--?\w[\w-]*(?:=(?:${QUOTED}|[^\s"'\x60|;&]*)|\s(?:${QUOTED}|(?!(?:run|watch)\b)[^\s"'\x60|;&,-]${PATH_CHAR}*))?|--|run|watch))*?`;
/** A package script that runs the entry (server-portable's `dev` is `bun --watch index.ts`): `dev` or `start`, not `dev:docs` or `start-db`. */
const SCRIPT = String.raw`(?:dev|start)(?![\w:-])`;
const DEV_RUN = String.raw`(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?${SCRIPT}`;
/** The flags, up to the path. */
const ARGS = String.raw`${FLAGS}\s+`;
/** One character of the commands after a `cd`, or an `&&`: `;` too, but never into another `cd` or `pushd`. One unit a character, so the steps split one way. */
const STEP = String.raw`(?:(?!\b(?:cd|pushd)\b)[^\n|&]|&&)`;
const OUTSIDE_COMPOSE = [
  // bun server-portable/index.ts, PORT=8000 bun run ./mcp-server/index.ts, ExecStart=/usr/bin/bun /opt/ob1/server-portable/index.ts
  new RegExp(RUNTIME + ARGS + BRAIN_ENTRY),
  // cd server-portable && bun install; bun index.ts, cd mcp-server; PORT=8001 bun --watch index.ts, cd "server-portable" && npm run dev
  new RegExp(String.raw`\b(?:cd|pushd)\s+["']?${BRAIN_DIR}\/?["']?\s*(?:&&|;)${STEP}*?(?:` + RUNTIME + String.raw`${STEP}*?${BARE_ENTRY}|\b${DEV_RUN})`),
  // bun --cwd mcp-server index.ts, bun --cwd server-portable run dev, bun run --cwd server-portable dev
  new RegExp(RUNTIME + FLAGS + String.raw`\s+--cwd[= ]${BRAIN_DIR}\/?` + ARGS + String.raw`(?:${BARE_ENTRY}|(?:run\s+)?${SCRIPT})`),
  // a package manager's script there: npm --prefix server-portable run dev, npm run dev --prefix …, yarn --cwd … dev, pnpm -C … start
  new RegExp(String.raw`\b(?:npm|pnpm|yarn)\b(?=[^\n|;&]*\s(?:--prefix|--cwd|--dir|-C)[= ]["']?${BRAIN_DIR}(?![\w-]))(?=[^\n|;&]*\s(?:run\s+)?${SCRIPT})`),
  // the server image alone: docker run … ob1-server, docker container run, docker create, with no --entrypoint on the line
  /\b(?:docker|podman)\s+(?:container\s+)?(?:run|create)\b(?![^\n]*--entrypoint)[^\n]*\b(?:ob1|open-brain)-server(?![\w-])/,
  // the image with a runtime for its entrypoint and the server's entry: docker run --entrypoint bun <image> index.ts
  new RegExp(String.raw`\b(?:docker|podman)\s+(?:container\s+)?(?:run|create)\b[^\n]*?--entrypoint[= ]["']?(?:\S*\/)?(?:bun|node)\b[^\n]*?(?:${BRAIN_ENTRY}|\s["']?${BARE_ENTRY})`),
  // a cluster or a platform's deploy
  /\bkubectl\b|\bhelm\s+(?:install|upgrade)\b|\b(?:fly|flyctl)\s+(?:deploy|launch)\b|\bdeployctl\b|\bgcloud\s+run\s+deploy\b|\brailway\s+up\b|\bdocker\s+(?:stack\s+deploy|service\s+create)\b|\bpodman\s+(?:kube\s+play|play\s+kube)\b|\boc\s+(?:apply|new-app)\b/,
];
/** A doc's lines with shell continuations (a trailing `\`) joined, each at its first line's number. */
function joinedLines(text: string): [number, string][] {
  const out: [number, string][] = [];
  let at = 0;
  let held: string | null = null;
  text.split("\n").forEach((line, i) => {
    if (held === null) { at = i + 1; held = ""; }
    if (/\\\s*$/.test(line)) held += line.replace(/\\\s*$/, " ");
    else { out.push([at, held + line]); held = null; }
  });
  if (held !== null) out.push([at, held]);
  return out;
}
const outsideCompose = (line: string) => OUTSIDE_COMPOSE.some((re) => re.test(line));
/** [text, caught?] — what 22c must catch (the ticket's Verify plant first), and the neighbours it must not reach. */
const OUTSIDE_COMPOSE_PROBES: [string, boolean][] = [
  ["run `bun server-portable/index.ts`", true],
  ["PORT=8000 bun run ./server-portable/index.ts", true],
  ["bun --no-env-file server-portable/api.ts", true],
  ["bun --env-file .env.local --watch server-portable/index.ts", true],
  ["node server-portable/index.js", true],
  ["OB1_REST_URL=http://api:8000 bun mcp-server/index.ts", true],
  ['bun "server-portable/index.ts"', true],
  ["bun `mcp-server/index.ts`", true],
  ["ExecStart=/usr/local/bin/bun /opt/ob1/server-portable/index.ts", true],
  [`bun --env-file=/home/me/${"d/".repeat(30)}.env server-portable/index.ts`, true],
  [`bun${" --a b".repeat(30)} ; bun server-portable/index.ts`, true],
  [`bun${" --a run".repeat(30)} ; bun server-portable/index.ts`, true],
  ["pm2 start bun -- server-portable/index.ts", true],
  ["tsx watch server-portable/index.ts", true],
  ['bun --env-file ".env.local" server-portable/index.ts', true],
  ["node --require './otel.js' server-portable/index.js", true],
  ["deno run --allow-env=PORT,DATABASE_URL server-portable/index.ts", true],
  ["pm2 start server-portable/index.ts --interpreter bun", true],
  ["cd server-portable && bun index.ts", true],
  ["cd server-portable && bun ./index.ts", true],
  ["cd mcp-server; bun install; bun index.ts", true],
  ["cd server-portable && bun install; bun index.ts", true],
  ['cd "server-portable" && bun index.ts', true],
  ["pushd mcp-server && bun index.ts", true],
  ["cd mcp-server; bun --watch index.ts", true],
  ["cd mcp-server && OB1_REST_URL=http://api:8000 bun index.ts", true],
  ["cd server-portable && bun install && bun index.ts", true],
  ["cd ../server-portable && bun index.ts", true],
  ["cd server-portable && bun run dev", true],
  ["cd server-portable && npm run dev", true],
  ["cd server-portable && yarn start", true],
  ["bun --cwd mcp-server index.ts", true],
  ["bun --cwd server-portable run dev", true],
  ["bun run --cwd server-portable dev", true],
  ["npm --prefix server-portable run dev", true],
  ["npm run dev --prefix server-portable", true],
  ["yarn --cwd server-portable dev", true],
  ["pnpm -C mcp-server start", true],
  ["docker run -p 8000:8000 ghcr.io/mharris-sgymd/ob1-server:2.0.0", true],
  ["podman run --rm -e MCP_ACCESS_KEYS ob1-server", true],
  ["docker run -p 8000:8000 open-brain-server", true],
  ["docker container run -p 8000:8000 ob1-server", true],
  ["docker create --name brain ghcr.io/mharris-sgymd/ob1-server:2.0.0", true],
  ["docker run --entrypoint bun -p 127.0.0.1:8001:8000 \\\n  -e OB1_REST_URL=http://api:8000 \\\n  <server image> ../mcp-server/index.ts", true],
  ["docker run --entrypoint bun ghcr.io/mharris-sgymd/ob1-server:2.0.0 index.ts", true],
  ["podman run --entrypoint=bun open-brain-server api.ts", true],
  ["docker run --entrypoint=/usr/local/bin/bun ghcr.io/mharris-sgymd/ob1-server:2.0.0 index.ts", true],
  ["docker run --entrypoint bun ob1-server 'index.ts'", true],
  ["kubectl apply -f k8s/", true],
  ["helm install brain ./chart", true],
  ["helm upgrade brain ./chart", true],
  ["fly deploy", true],
  ["flyctl launch", true],
  ["deployctl deploy --project=brain main.ts", true],
  ["gcloud run deploy brain --image ghcr.io/mharris-sgymd/ob1-server:2.0.0", true],
  ["railway up", true],
  ["docker stack deploy -c deploy/compose.yaml brain", true],
  ["docker service create --name brain ghcr.io/mharris-sgymd/ob1-server:2.0.0", true],
  ["podman kube play brain.yaml", true],
  ["oc apply -f brain.yaml", true],
  ["oc new-app ghcr.io/mharris-sgymd/ob1-server:2.0.0", true],
  ["podman play kube brain.yaml", true],
  ["docker run --rm --entrypoint bun ghcr.io/mharris-sgymd/ob1-server:<X.Y.Z> keygen.ts --name laptop --scope write", false],
  ["cd server-portable && bun keygen.ts --name n8n --scope capture", false],
  ["cd mcp-server && bun install", false],
  ["cd mcp-server && npm install", false],
  ["cd server-portable && npm run dev:docs", false],
  ["cd server-portable && bun test && npm run lint", false],
  ["cd server-portable && bun test && cd ../recipes/life-engine && npm run dev", false],
  ["cd server-portable && bun keygen.ts && cd ../integrations/slack-capture && bun index.ts", false],
  ["npm --prefix server-portable install", false],
  ["docker run --name ob1-server-test postgres:17", false],
  ["cd server-portable && bun install && cat index.ts", false],
  ["cd server-portable && bun build ./index.ts --outdir dist", false],
  ["cd mcp-server && bun test index.ts", false],
  ["cd server-portable && bun keygen.ts; cd .. && bun extensions/household-knowledge/index.ts", false],
  ["cd server-portable && bun keygen.ts && bun ../extensions/household-knowledge/index.ts", false],
  ["bun test server-portable/test-server.ts", false],
  ["bun build server-portable/index.ts --outdir dist", false],
  ["after bun install, open server-portable/index.ts", false],
  ["Each graph node is written by server-portable/api.ts", false],
  ["deno lint mcp-server/index.ts", false],
  ["`server-portable/index.ts` is the server n8n reaches", false],
  ["podman compose -f deploy/compose.yaml run --rm migrate", false],
  ["bun extensions/household-knowledge/index.ts", false],
  ["the image's entrypoint runs `exec bun index.ts`", false],
  ["Kubernetes' and ECS's 30, Fly's `kill_timeout`", false],
];
const DOC_FILE = /\.mdx?$/;
function checkComposeOnly() {
  for (const [probe, caught] of OUTSIDE_COMPOSE_PROBES) {
    if (joinedLines(probe).some(([, line]) => outsideCompose(line)) !== caught) fail(SELF, `check 22c ${caught ? "misses" : "catches"} its probe ${JSON.stringify(probe)} (its own probe)`);
  }
  const files = citationFiles().filter((rel) => DOC_FILE.test(rel) && !isHistory(rel));
  for (const want of ["SETUP.md", "docs/01-getting-started.md", "primitives/deploy-remote-mcp/README.md"]) {
    if (!files.includes(want)) fail(SELF, `check 22c's listing does not reach ${want} — the listing is broken, not the tree clean`);
  }
  for (const rel of files) {
    for (const [n, line] of joinedLines(readFileSync(join(ROOT, rel), "utf8"))) {
      if (outsideCompose(line)) fail(`${rel}:${n}`, "runs the brain outside the compose stack — it deploys as the compose stack alone (SMD-2282's decision 6, SMD-2288), which SETUP.md brings up; a vendored server's own `bun <file>` is primitives/deploy-remote-mcp/'s");
    }
  }
}
checkComposeOnly();

// ── 23: a workflow names its runner image and pins every action to a commit (SMD-2093) ──
/**
 * Both workflows ran on `ubuntu-latest`, which GitHub moves to a new Ubuntu on
 * a date of its own (26 from 2026-10-19), so the switch would have landed on
 * whichever PR ran first after it, as an unrelated red. And every `uses:` named
 * a tag its owner can move, which the release job runs with `packages: write`.
 * So every job's `runs-on` names an image: no `-latest` label in any case or
 * size (`macos-latest-large` moves as `ubuntu-latest` does), and no
 * expression this check cannot read; a runner group names no image and is
 * held by its labels alone. Every `uses:` — a step's, or a job's reusable
 * workflow — is one of three things: a full 40-hex commit SHA with the tag it
 * was in a trailing comment that opens with a version number (`# v7.0.1`, or
 * `# 7.0.1` for an action whose tags carry no `v`; Dependabot rewrites the two
 * together, and a reader needs the tag), a local `./` path, or a `docker://`
 * image by sha256 digest. And .github/dependabot.yml is a `version: 2` file,
 * every entry on a schedule Dependabot accepts, with a `github-actions` entry
 * over `/` that can open a PR, so the pins move by PR rather than rot — a
 * heuristic for the ways a file stops the pins moving, not a validator of
 * Dependabot's schema (an ignore of `actions/*` passes). The structure is
 * read from the parsed document. The comment, which a YAML parser drops, is
 * read from the value's line: the first unclaimed line carrying the value,
 * block scalars (`run: |`, `run: |- # note`, `- |`, an anchored or tagged
 * `&a |`) skipped, since a `uses:` line there is text, not a step. A
 * SHA-pinned `uses:` with no line of its own (flow style, a folded value, or
 * steps reused by YAML alias, which actionlint 1.7.7 refuses too) is refused,
 * since its tag cannot be read; and every SHA-pinned line the reader does find
 * carries its tag whether a step claimed it or not, so text the reader cannot
 * tell from a step (a quoted scalar across lines, an input named `uses`)
 * cannot lend its tag to a bare step below it. Check 23
 * holds a pin's shape, not its truth: a comment that names another tag, or a
 * commit only a fork of the action holds, is zizmor's to find (run once for
 * SMD-2093, not in CI); actionlint cannot check a SHA-pinned action's inputs,
 * so a Dependabot major is read against the new action.yml by hand; and an
 * image an action starts by an input (release.yml's binfmt and BuildKit
 * images) or a job's `container:`/`services:` image is not a `uses:` and is
 * not read. Nor are a local action's own steps (.github/actions/, none
 * today). The rules are workflowPinProblems and dependabotProblems, pure
 * functions their probes run on in-memory text; no exceptions.
 */
const WORKFLOWS_DIR = ".github/workflows";
const DEPENDABOT = ".github/dependabot.yml";
/** The `schedule.interval` values Dependabot's options reference accepts; `cron` wants a `cronjob` beside it. */
const DEPENDABOT_INTERVALS = ["daily", "weekly", "monthly", "quarterly", "semiannually", "yearly", "cron"];
const FULL_SHA = /^[0-9a-f]{40}$/;
/** The trailing comment a SHA pin carries: a version number, `# v7`, `# v7.0.1` or `# 7.0.1`, then a space or the line's end (a date or a prerelease suffix is refused). */
const TAG_COMMENT = /^#\s*v?\d+(?:\.\d+)*(?:\s|$)/;
/** A runner label GitHub moves to a new image on its own date: `-latest`, alone or before a size, in any case. */
const MOVING_LABEL = /-latest(?:-|$)/i;
/**
 * A line that opens a block scalar: `run: |`, `script: >-`, a list item `- |`
 * (nested, `- - |`, too), an anchor or tag before the indicator (`run: &a |`,
 * `run: !!str |`). Group 1 is the indent, group 2 the items' dashes, group 3
 * the key; the body is every line indented past the key's column, or past the
 * first dash's for a keyless item.
 */
const BLOCK_SCALAR_KEY = /^(\s*)((?:-\s+)*)(?:([^\s#][^#]*?):\s+)?(?:[&!]\S*\s+)*[|>][-+0-9]*\s*(?:#.*)?$/;
type UsesLine = { value: string; comment: string; line: number };
/** Every line outside a block scalar that reads as `uses: <value> [# comment]`: a `- ` list item or not, the key anchored or not, the value quoted or not. */
function usesLinesOf(text: string): UsesLine[] {
  const out: UsesLine[] = [];
  let blockColumn = -1; // inside a block scalar, the column its body must be indented past; -1 outside one
  text.split(/\r?\n/).forEach((raw, i) => {
    if (blockColumn >= 0) {
      if (raw.trim() === "" || raw.length - raw.trimStart().length > blockColumn) return;
      blockColumn = -1;
    }
    const block = raw.match(BLOCK_SCALAR_KEY);
    if (block) { blockColumn = block[3] !== undefined ? block[1].length + block[2].length : block[1].length; return; }
    const m = raw.match(/^\s*(?:-\s+)?(?:&\S+\s+)?uses:\s*(["']?)([^"'\s#]+)\1\s*(#.*)?$/);
    if (m) out.push({ value: m[2], comment: (m[3] ?? "").trim(), line: i + 1 });
  });
  return out;
}
function workflowPinProblems(file: string, text: string): [string, string][] {
  const problems: [string, string][] = [];
  let doc: unknown;
  try { doc = Bun.YAML.parse(text); } catch (e) { return [[file, `does not parse: ${(e as Error).message} — check 23 cannot read its runners or its actions (SMD-2093)`]]; }
  const jobs = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as { jobs?: unknown }).jobs : null;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return [[file, "has no `jobs:` map check 23 can read (SMD-2093)"]];
  const lines = usesLinesOf(text);
  const taken = new Set<number>();
  const holdUses = (key: string, value: unknown) => {
    if (typeof value !== "string") { problems.push([file, `job ${key} has a \`uses:\` that is not a string (${JSON.stringify(value)}) (SMD-2093)`]); return; }
    // The first unclaimed line carrying this value is its line: two steps using one pin claim one line each.
    const i = lines.findIndex((l, n) => !taken.has(n) && l.value === value);
    if (i >= 0) taken.add(i);
    const where = i >= 0 ? `${file}:${lines[i].line}` : file;
    if (value.startsWith("./")) return; // a local action: pinned by the commit this workflow runs at
    if (value.startsWith("docker://")) {
      if (!/@sha256:[0-9a-f]{64}$/.test(value)) problems.push([where, `uses ${value}, an image by tag — name it by its sha256 digest (\`docker://<image>@sha256:<digest>\`) so the step runs the image that was read (SMD-2093)`]);
      return;
    }
    const at = value.lastIndexOf("@");
    const ref = at < 0 ? "" : value.slice(at + 1);
    if (!FULL_SHA.test(ref)) {
      problems.push([where, `uses ${value}, ${ref ? `a tag or branch (${ref})` : "no ref at all"} its owner can move — pin the full 40-character commit SHA with the tag in a trailing comment, \`${at < 0 ? value : value.slice(0, at)}@<sha> # ${/^v?\d/.test(ref) ? ref : "vX.Y.Z"}\`, and let Dependabot move it (SMD-2093)`]);
      return;
    }
    if (i < 0) { problems.push([file, `job ${key} uses ${value} on no line of its own check 23 can read (flow style, a folded or literal value, or an alias of another step) — the tag comment beside a SHA cannot be read; write the step as \`uses: ${value} # vX.Y.Z\` (SMD-2093)`]); return; }
    if (!TAG_COMMENT.test(lines[i].comment)) problems.push([where, `pins ${value} with no \`# vX.Y.Z\` comment naming the tag — Dependabot rewrites the SHA and the comment together, and a reader cannot tell what a bare SHA is (SMD-2093)`]);
  };
  for (const [key, job] of Object.entries(jobs as Record<string, unknown>)) {
    if (!job || typeof job !== "object") continue;
    const j = job as { "runs-on"?: unknown; uses?: unknown; steps?: unknown };
    if (j["runs-on"] !== undefined) {
      const runsOn = j["runs-on"];
      // A string, a list of labels, or `{ group, labels }` — a group alone names no image, only its labels do.
      const group = runsOn && typeof runsOn === "object" && !Array.isArray(runsOn) ? (runsOn as { group?: unknown; labels?: unknown }) : null;
      const labels: unknown[] = typeof runsOn === "string" ? [runsOn] : Array.isArray(runsOn) ? runsOn : group && "labels" in group ? [group.labels].flat() : group && "group" in group ? [] : [runsOn];
      for (const label of labels) {
        if (typeof label !== "string") problems.push([file, `job ${key}'s runs-on ${JSON.stringify(runsOn)} carries a label check 23 cannot read (SMD-2093)`]);
        else if (label.includes("${{")) problems.push([file, `job ${key} picks its runner by an expression (${label}) — check 23 cannot tell whether it resolves to a -latest image; name the image (SMD-2093)`]);
        else if (MOVING_LABEL.test(label)) problems.push([file, `job ${key} runs on ${label}, which GitHub moves to a new image on its own date — name the image (ubuntu-24.04, macos-15, windows-2025), and move to the next one in a PR of its own (SMD-2093)`]);
      }
    }
    if (j.uses !== undefined) holdUses(key, j.uses);
    if (Array.isArray(j.steps)) for (const step of j.steps) if (step && typeof step === "object" && "uses" in step) holdUses(key, (step as { uses: unknown }).uses);
  }
  // A line no step claimed is text the reader cannot tell from a step (a quoted scalar across lines, an input named
  // `uses`) — or a bare step whose value an earlier such line was read for. Either way a SHA pin on it carries its tag,
  // so whichever line a step's tag is read from, no pinned line in the file is bare.
  lines.forEach((l, n) => {
    if (taken.has(n)) return;
    const at = l.value.lastIndexOf("@");
    if (at >= 0 && FULL_SHA.test(l.value.slice(at + 1)) && !TAG_COMMENT.test(l.comment)) problems.push([`${file}:${l.line}`, `pins ${l.value} with no \`# vX.Y.Z\` comment on a \`uses:\` line no step's tag was read from — if it is a step, an earlier line carrying the same pin was read in its place; every pinned line carries its tag (SMD-2093)`]);
  });
  return problems;
}
/** .github/dependabot.yml, as text or null when absent: a `version: 2` file, every entry on a schedule Dependabot accepts, with a `github-actions` update over `/` that can open a PR. */
function dependabotProblems(text: string | null): [string, string][] {
  if (text === null) return [[DEPENDABOT, "missing — nothing moves the workflows' SHA pins, so they stay on the commit they were pinned at; add a `github-actions` update over `/` (SMD-2093)"]];
  let doc: unknown;
  try { doc = Bun.YAML.parse(text); } catch (e) { return [[DEPENDABOT, `does not parse: ${(e as Error).message} (SMD-2093)`]]; }
  // Dependabot refuses the whole file for a wrong version or an entry with no schedule, and then moves nothing.
  if (!doc || typeof doc !== "object" || (doc as { version?: unknown }).version !== 2) return [[DEPENDABOT, "is not a `version: 2` file — Dependabot refuses the whole file, and nothing moves the workflows' SHA pins (SMD-2093)"]];
  const updates = (doc as { updates?: unknown }).updates;
  type Update = { "package-ecosystem"?: unknown; directory?: unknown; directories?: unknown; "open-pull-requests-limit"?: unknown; ignore?: unknown };
  const covers = (u: unknown): u is Update => {
    if (!u || typeof u !== "object") return false;
    const e = u as Update;
    return e["package-ecosystem"] === "github-actions" && (e.directory === "/" || (Array.isArray(e.directories) && e.directories.includes("/")));
  };
  const entries = Array.isArray(updates) ? updates.filter(covers) : [];
  if (!entries.length) return [[DEPENDABOT, "has no `github-actions` update over `/` — nothing moves the workflows' SHA pins, so they stay on the commit they were pinned at (SMD-2093)"]];
  // Every entry, not only the covering one: one unschedulable entry and Dependabot refuses the file whole. An entry in
  // a multi-ecosystem group takes the group's schedule instead of its own.
  const validSchedule = (s: unknown) => {
    if (!s || typeof s !== "object") return false;
    const { interval, cronjob } = s as { interval?: unknown; cronjob?: unknown };
    return typeof interval === "string" && DEPENDABOT_INTERVALS.includes(interval) && (interval !== "cron" || typeof cronjob === "string");
  };
  const groups = (doc as { "multi-ecosystem-groups"?: unknown })["multi-ecosystem-groups"];
  const scheduled = (e: unknown) => {
    if (!e || typeof e !== "object") return false;
    const { schedule, "multi-ecosystem-group": group } = e as { schedule?: unknown; "multi-ecosystem-group"?: unknown };
    if (typeof group === "string" && groups && typeof groups === "object" && !Array.isArray(groups)) return validSchedule((groups as Record<string, { schedule?: unknown } | null>)[group]?.schedule) || validSchedule(schedule);
    return validSchedule(schedule);
  };
  if (!(updates as unknown[]).every(scheduled)) return [[DEPENDABOT, `has an update with no schedule Dependabot accepts (\`schedule.interval\` one of ${DEPENDABOT_INTERVALS.join(", ")}, and a \`cronjob\` for cron — its own, or its \`multi-ecosystem-group\`'s) — Dependabot refuses the whole file, and nothing moves the pins (SMD-2093)`]];
  // An entry that can open no PR is no entry: a limit of 0, or an ignore of every dependency at every version — a `*`
  // rule with `update-types` or `versions` holds back only those (no majors, say), and the rest still open PRs.
  const ignoresAll = (r: unknown) => !!r && typeof r === "object" && (r as { "dependency-name"?: unknown })["dependency-name"] === "*" && !("update-types" in r) && !("versions" in r);
  const opens = (e: Update) => e["open-pull-requests-limit"] !== 0 && !(Array.isArray(e.ignore) && e.ignore.some(ignoresAll));
  if (!entries.some(opens)) return [[DEPENDABOT, "has a `github-actions` update over `/` that can open no PR (`open-pull-requests-limit: 0`, or an ignore of `*` at every version) — the pins stay where they are (SMD-2093)"]];
  return [];
}
const PIN_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
/** A one-job workflow whose runner and first step a probe replaces; the step text sits at a list item's indent (6), a continuation line at 8. */
const PIN_PROBE = (runsOn: string, step: string) => `name: probe\non: push\njobs:\n  a:\n    runs-on: ${runsOn}\n    steps:\n      ${step}\n      - uses: ./.github/actions/local\n      - run: echo hi\n`;
const PIN_STEP = `- uses: actions/checkout@${PIN_SHA} # v7.0.1`;
/** Workflows check 23 accepts: [why, text]. */
const PIN_ACCEPTED: [string, string][] = [
  // A pin as it is written: quoted, after a name, after a folded name, under an anchored key, twice, by digest, CRLF.
  ["a named image and a SHA pin with its tag", PIN_PROBE("ubuntu-24.04", PIN_STEP)],
  ["a quoted SHA pin", PIN_PROBE("ubuntu-24.04", `- uses: "actions/checkout@${PIN_SHA}" # v7`)],
  ["a SHA pin on the line after the step's name", PIN_PROBE("ubuntu-24.04", `- name: Check out\n        uses: actions/checkout@${PIN_SHA} # v7.0.1`)],
  ["a step whose folded `name: >-` precedes its `uses:`", PIN_PROBE("ubuntu-24.04", `- name: >-\n          Check out\n        uses: actions/checkout@${PIN_SHA} # v7.0.1`)],
  ["a `uses:` key with an anchor", PIN_PROBE("ubuntu-24.04", `- &checkout uses: actions/checkout@${PIN_SHA} # v7.0.1`)],
  ["two steps on one pin", PIN_PROBE("ubuntu-24.04", `${PIN_STEP}\n      ${PIN_STEP}`)],
  ["a tag comment with no v, as an action whose tags carry none", PIN_PROBE("ubuntu-24.04", `- uses: actions/checkout@${PIN_SHA} # 7.0.1`)],
  ["a docker image by digest", PIN_PROBE("ubuntu-24.04", `- uses: docker://alpine@sha256:${"a".repeat(64)}`)],
  ["a workflow with CRLF line ends", PIN_PROBE("ubuntu-24.04", PIN_STEP).replace(/\n/g, "\r\n")],
  // Runners that name their image.
  ["a runner label list with no -latest", PIN_PROBE("[self-hosted, linux]", PIN_STEP)],
  ["a runner group alone, which names no image", PIN_PROBE("{ group: big-runners }", PIN_STEP)],
  ["a runner group with a named image", PIN_PROBE("{ group: big-runners, labels: [ubuntu-24.04] }", PIN_STEP)],
  // Block scalars are text: a bare copy of the pin in one takes no step's line.
  ["a `uses:` line inside a run body, which is text", PIN_PROBE("ubuntu-24.04", `${PIN_STEP}\n      - run: |\n          uses: actions/checkout@v4`)],
  ["a bare copy of the pin in an earlier run body, which does not take the commented step's line", PIN_PROBE("ubuntu-24.04", `- run: |\n          uses: actions/checkout@${PIN_SHA}\n      ${PIN_STEP}`)],
  ["a bare copy of the pin after a blank line in an earlier run body", PIN_PROBE("ubuntu-24.04", `- run: |\n          echo one\n\n          uses: actions/checkout@${PIN_SHA}\n      ${PIN_STEP}`)],
  ["a bare copy of the pin in an earlier `run: |-` body, a chomping indicator after the `|`", PIN_PROBE("ubuntu-24.04", `- run: |-\n          uses: actions/checkout@${PIN_SHA}\n      ${PIN_STEP}`)],
  ["a bare copy of the pin in an earlier `run: | # note` body, a comment after the `|`", PIN_PROBE("ubuntu-24.04", `- run: | # note\n          uses: actions/checkout@${PIN_SHA}\n      ${PIN_STEP}`)],
  ["a bare copy of the pin in an earlier tagged run body", PIN_PROBE("ubuntu-24.04", `- run: !!str |\n          uses: actions/checkout@${PIN_SHA}\n      ${PIN_STEP}`)],
  ["a bare copy of the pin in an earlier `- |` item, skipped as a block too", PIN_PROBE("ubuntu-24.04", `- uses: ./.github/actions/local\n        with:\n          args:\n            - |\n              uses: actions/checkout@${PIN_SHA}\n      ${PIN_STEP}`)],
  ["a bare copy of the pin in an earlier nested `- - |` item", PIN_PROBE("ubuntu-24.04", `- uses: ./.github/actions/local\n        with:\n          args:\n            - - |\n                uses: actions/checkout@${PIN_SHA}\n      ${PIN_STEP}`)],
];
/** Workflows check 23 refuses with exactly one problem: [why, text, a phrase the problem carries]. */
const PIN_MUTANTS: [string, string, string][] = [
  // Runners GitHub moves, or that this check cannot read.
  ["runs-on ubuntu-latest", PIN_PROBE("ubuntu-latest", PIN_STEP), "moves to a new image"],
  ["a -latest label in a list", PIN_PROBE("[self-hosted, macos-latest]", PIN_STEP), "moves to a new image"],
  ["a -latest label with a size", PIN_PROBE("macos-latest-large", PIN_STEP), "moves to a new image"],
  ["a -latest label in another case", PIN_PROBE("Ubuntu-Latest", PIN_STEP), "moves to a new image"],
  ["a runner group whose label is -latest", PIN_PROBE("{ group: big-runners, labels: [ubuntu-latest] }", PIN_STEP), "moves to a new image"],
  ["a runner picked by an expression", PIN_PROBE("${{ matrix.os }}", PIN_STEP), "by an expression"],
  ["a runner label that is not a string", PIN_PROBE("[ubuntu-24.04, 3]", PIN_STEP), "cannot read"],
  // Refs an owner can move, and images by tag.
  ["an action by major tag", PIN_PROBE("ubuntu-24.04", "- uses: actions/checkout@v4"), "can move"],
  ["an action by branch", PIN_PROBE("ubuntu-24.04", "- uses: actions/checkout@main"), "can move"],
  ["an action by short SHA", PIN_PROBE("ubuntu-24.04", `- uses: actions/checkout@${PIN_SHA.slice(0, 7)} # v7.0.1`), "can move"],
  ["a 41-character ref", PIN_PROBE("ubuntu-24.04", `- uses: actions/checkout@${PIN_SHA}0 # v7.0.1`), "can move"],
  ["an action with no ref", PIN_PROBE("ubuntu-24.04", "- uses: actions/checkout"), "no ref at all"],
  ["a reusable workflow by tag", "name: probe\non: push\njobs:\n  b:\n    uses: org/repo/.github/workflows/x.yml@v1\n", "can move"],
  ["a docker image by tag", PIN_PROBE("ubuntu-24.04", "- uses: docker://alpine:3"), "by its sha256 digest"],
  ["a docker digest with text after it", PIN_PROBE("ubuntu-24.04", `- uses: docker://alpine@sha256:${"a".repeat(64)}x`), "by its sha256 digest"],
  // A SHA with no tag. Each step claims its own line: without the claim, both steps of "the first bare" read line
  // one, and it is reported twice.
  ["a SHA pin with no comment", PIN_PROBE("ubuntu-24.04", `- uses: actions/checkout@${PIN_SHA}`), "no `# vX.Y.Z` comment"],
  ["a SHA pin whose comment names no tag", PIN_PROBE("ubuntu-24.04", `- uses: actions/checkout@${PIN_SHA} # pinned`), "no `# vX.Y.Z` comment"],
  ["a SHA pin whose comment is a date", PIN_PROBE("ubuntu-24.04", `- uses: actions/checkout@${PIN_SHA} # 2026-09-24`), "comment naming the tag"],
  ["two steps on one pin, the second bare", PIN_PROBE("ubuntu-24.04", `${PIN_STEP}\n      - uses: actions/checkout@${PIN_SHA}`), "no `# vX.Y.Z` comment"],
  ["two steps on one pin, the first bare", PIN_PROBE("ubuntu-24.04", `- uses: actions/checkout@${PIN_SHA}\n      ${PIN_STEP}`), "comment naming the tag"],
  // A pin with no line of its own, whose tag cannot be read.
  ["a SHA pin in flow style", PIN_PROBE("ubuntu-24.04", `- { uses: "actions/checkout@${PIN_SHA}" }`), "on no line"],
  ["steps reused by alias, which have no line of their own", `name: probe\non: push\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps: &s\n      ${PIN_STEP}\n  b:\n    runs-on: ubuntu-24.04\n    steps: *s\n`, "an alias of another step"],
  // A commented copy of the pin above a bare step lends it nothing: in a block scalar the bare step claims its own
  // line; in text the reader cannot tell from a step, the bare line goes unclaimed, and every pinned line carries its tag.
  ["a bare step under a run body carrying the commented pin", PIN_PROBE("ubuntu-24.04", `- run: |\n          uses: actions/checkout@${PIN_SHA} # v7.0.1\n      - uses: actions/checkout@${PIN_SHA}`), "no `# vX.Y.Z` comment"],
  ["a bare step under a `- |` item carrying the commented pin", PIN_PROBE("ubuntu-24.04", `- uses: ./.github/actions/local\n        with:\n          args:\n            - |\n              uses: actions/checkout@${PIN_SHA} # v7.0.1\n      - uses: actions/checkout@${PIN_SHA}`), "comment naming the tag"],
  ["a bare step under an anchored run body carrying the commented pin", PIN_PROBE("ubuntu-24.04", `- run: &body |\n          uses: actions/checkout@${PIN_SHA} # v7.0.1\n      - uses: actions/checkout@${PIN_SHA}`), "comment naming the tag"],
  ["a bare step under a quoted run across lines carrying the commented pin", PIN_PROBE("ubuntu-24.04", `- run: "echo one\n          uses: actions/checkout@${PIN_SHA} # v7.0.1 \n          echo two"\n      - uses: actions/checkout@${PIN_SHA}`), "no step's tag was read from"],
  ["a bare step under an input named uses carrying the commented pin", PIN_PROBE("ubuntu-24.04", `- uses: ./.github/actions/local\n        with:\n          uses: actions/checkout@${PIN_SHA} # v7.0.1\n      - uses: actions/checkout@${PIN_SHA}`), "no step's tag was read from"],
  // Shapes the check cannot read at all.
  ["no jobs at all", "name: probe\non: push\n", "no `jobs:` map"],
  ["a `uses:` that is not a string", PIN_PROBE("ubuntu-24.04", "- uses: 3"), "not a string"],
];
function checkWorkflowPins() {
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    fail(SELF, `check 23 parses ${WORKFLOWS_DIR}/ with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-2093)`);
    return;
  }
  for (const [why, text] of PIN_ACCEPTED) {
    const got = workflowPinProblems("probe.yml", text);
    if (got.length) fail(SELF, `check 23 refuses ${why} (its own probe): ${got.map((p) => p[1]).join("; ")}`);
  }
  for (const [why, text, says] of PIN_MUTANTS) {
    const got = workflowPinProblems("probe.yml", text);
    if (got.length !== 1 || !got[0][1].includes(says)) fail(SELF, `check 23 reports ${JSON.stringify(got)} for ${why}, not one problem saying "${says}" (its own probe)`);
  }
  const DEPENDABOT_OK = "version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: weekly\n";
  for (const [why, text] of [
    ["a github-actions update over /", DEPENDABOT_OK],
    ["a github-actions update over a directories list naming /", DEPENDABOT_OK.replace("directory: /", "directories: [/]")],
    ["an ignore of every action's majors alone, which still opens PRs", `${DEPENDABOT_OK}    ignore:\n      - dependency-name: "*"\n        update-types: ["version-update:semver-major"]\n`],
    ["a cron schedule with its cronjob", DEPENDABOT_OK.replace("interval: weekly", "interval: cron\n      cronjob: \"0 6 * * 1\"")],
    ["an ignore of every action at some versions alone, which still opens PRs", `${DEPENDABOT_OK}    ignore:\n      - dependency-name: "*"\n        versions: [">= 8"]\n`],
    ["an entry in a multi-ecosystem group whose own schedule stands where the group names none", `${DEPENDABOT_OK}  - package-ecosystem: npm\n    directory: /scripts\n    multi-ecosystem-group: infra\n    schedule:\n      interval: weekly\nmulti-ecosystem-groups:\n  infra: {}\n`],
    ["an entry scheduled by its multi-ecosystem group", `${DEPENDABOT_OK}  - package-ecosystem: npm\n    directory: /scripts\n    multi-ecosystem-group: infra\nmulti-ecosystem-groups:\n  infra:\n    schedule:\n      interval: weekly\n`],
  ] as const) if (dependabotProblems(text).length) fail(SELF, `check 23 refuses ${why} (its own probe)`);
  for (const [why, text, says] of [
    ["no file", null, "missing"],
    ["an npm update alone", DEPENDABOT_OK.replace("github-actions", "npm"), "has no `github-actions` update"],
    ["a github-actions update over another directory", DEPENDABOT_OK.replace("directory: /", "directory: /deploy"), "has no `github-actions` update"],
    ["a github-actions update limited to no PRs", `${DEPENDABOT_OK}    open-pull-requests-limit: 0\n`, "can open no PR"],
    ["a github-actions update that ignores every action", `${DEPENDABOT_OK}    ignore:\n      - dependency-name: "*"\n`, "can open no PR"],
    ["version 1, which Dependabot refuses whole", DEPENDABOT_OK.replace("version: 2", "version: 1"), "`version: 2`"],
    ["a github-actions update with no schedule, which Dependabot refuses whole", DEPENDABOT_OK.replace("    schedule:\n      interval: weekly\n", ""), "no schedule Dependabot accepts"],
    ["an interval Dependabot does not know", DEPENDABOT_OK.replace("interval: weekly", "interval: fortnightly"), "no schedule Dependabot accepts"],
    ["a cron interval with no cronjob", DEPENDABOT_OK.replace("interval: weekly", "interval: cron"), "no schedule Dependabot accepts"],
    ["a second, unscheduled entry beside a good one", `${DEPENDABOT_OK}  - package-ecosystem: npm\n    directory: /scripts\n`, "no schedule Dependabot accepts"],
    ["multi-ecosystem groups written as a list, not a map", `${DEPENDABOT_OK}  - package-ecosystem: npm\n    directory: /scripts\n    multi-ecosystem-group: "0"\nmulti-ecosystem-groups:\n  - schedule:\n      interval: weekly\n`, "no schedule Dependabot accepts"],
  ] as const) {
    const got = dependabotProblems(text);
    if (got.length !== 1 || !got[0][1].includes(says)) fail(SELF, `check 23 reports ${JSON.stringify(got)} for a dependabot.yml with ${why}, not one problem saying "${says}" (its own probe)`);
  }
  const files = readdirSync(join(ROOT, WORKFLOWS_DIR)).filter((n) => /\.ya?ml$/.test(n)).sort();
  if (files.length === 0) fail(WORKFLOWS_DIR, "holds no workflow — the listing is broken, not the tree clean (check 23)");
  for (const name of files) {
    const rel = `${WORKFLOWS_DIR}/${name}`;
    for (const [where, msg] of workflowPinProblems(rel, readFileSync(join(ROOT, rel), "utf8"))) fail(where, msg);
  }
  const depPath = join(ROOT, DEPENDABOT);
  for (const [where, msg] of dependabotProblems(existsSync(depPath) ? readFileSync(depPath, "utf8") : null)) fail(where, msg);
}
checkWorkflowPins();

// ── 24: no vendored script speaks PostgREST (SMD-2126) ──────────────────────
//
// Thirty scripts in twenty-one recipes reached the brain as PostgREST clients:
// `${SUPABASE_URL}/rest/v1/<table>` and `/rest/v1/rpc/<fn>` with a service-role
// key from a `.mjs`/`.js`/`.ts` fetch, or supabase-py's `create_client` from a
// `.py`. The fork's stack runs no PostgREST (SETUP.md), so each one's live mode
// failed at its first request, and neither check 10 (a URL string is not
// `.insert(`) nor check 22 (no supabase-js import) saw them. The class decision
// is docs/vendored-disposition.md's "PostgREST-speaking scripts" section: an
// import emits ingestion-contract items for db/ingest-records.ts (SMD-1867,
// SMD-2136), a maintenance script reaches Postgres through compat/supabase-sql
// under bun, three whose capability the core already owns retire — one ticket
// each, filed under SMD-2126. This holds the class where it stands and stops it
// growing back: in every code file (.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs, .py,
// .sh) under the seven category directories and docs/, comments blanked (the
// JS scanner for JS; a `#` outside a string for Python, and for shell one at
// a word's start (after one of bash's metacharacters, whitespace, `;`, `(`,
// `)`, `|`, `&`, `<`, `>`, or the text's start) — `$#`, `${#a[@]}` and `a#b`
// are not comments, so a hit after
// one on the same line is read; a docstring is a string and is read: a file
// that says it posts to `/rest/v1/rpc/…` is making a claim about itself), a
// `rest/v1` path in any string, a supabase-py import or `create_client(`
// (Python and shell alone), or a `@supabase/postgrest-js` specifier is a hit.
// POSTGREST_EXCEPTIONS counts the eighteen files with a call site (two
// more reach the gateway through a lib; twenty-eight until the two retirements,
// obsidian-vault-import and local-ollama-embeddings — SMD-2137 and SMD-2138 —
// the first five ports: brain-backup and lint-sweep — SMD-2144 — and
// thought-enrichment's three — SMD-2139 — weekly-digest's retirement for
// the db/ verb db/weekly-digest.ts — SMD-2239 — brain-smoke-test's into
// deploy/smoke.sh — SMD-2103 — and ob-graph's smoke-graph-rpcs.mjs with its
// recipe — SMD-2920)
// with the ticket that ports or retires each: a line past the count fails (a
// new call beside the documented ones),
// a count no line reaches fails as stale (the port landed on those lines —
// lower the count, or remove the entry when none remains), a file that is
// gone fails until its entry goes. So every child PR shrinks the table,
// and the table's size, plus the two lib-reached scripts, is the class's
// remaining size.
const POSTGREST_CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|sh)$/;
/** The files whose comments start at `#`: Python and shell. */
const HASH_COMMENT_FILE = /\.(py|sh)$/;
/** The shell files among them: a `#` opens their comments at a word's start alone (hashCommentsBlanked's `shell`). */
const SHELL_FILE = /\.sh$/;
/** A PostgREST path in any string: `…/rest/v1/thoughts`, `/rest/v1/rpc/f`, a bare "rest/v1" joined later; `v10` and `arrest/v1` are not it. */
const POSTGREST_PATH = /\brest\/v1\b/g;
/** supabase-py: the import in either spelling, and the client constructor (Python and shell files alone — `create_client` is a plain name elsewhere). */
const SUPABASE_PY_FORMS = [/^\s*from\s+supabase(?:\.[\w.]+)?\s+import\b/gm, /^\s*import\s+supabase\b/gm, /\bcreate_client\s*\(/g];
/** postgrest-js, in every specifier shape check 22 reads for supabase-js. */
const POSTGREST_JS_SPECIFIER = /(["'])(?:npm:|jsr:|https?:\/\/[^"'\s]*\/)?@supabase\/postgrest-js(?:@[^"'/]*)?(?:\/[^"']*)?\1/g;
/**
 * `text` with `#` comments blanked: a `#` outside a string, to the line's end,
 * every blanked character a space so offsets and line numbers hold — in
 * Python anywhere, in shell (`shell`) only at a word's start (the text's
 * start, or after one of bash's metacharacters: whitespace, `;`, `(`, `)`,
 * `|`, `&`, `<`, `>` — the second review pass measured `)#c`, `>#c` and `<#c`
 * as comment starts in bash, dash and zsh), since `$#`, `${#a[@]}` and
 * `a#b` are not comments and a hit after one on the same line must be read
 * (the first review pass). Strings — `'…'`, `"…"`, `'''…'''`, `"""…"""` — are
 * kept whole, an escape inside one honoured, so a `#` in a string is text and
 * a quote in a comment is blanked. Not a parser: an unterminated quote in a
 * shell word (`don't`) leaves the rest of the file read as a string, which
 * can only add hits — visible, and answered by quoting the word.
 */
function hashCommentsBlanked(text: string, shell = false): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") { out += c + (text[i + 1] ?? ""); i++; continue; }
      if (text.startsWith(quote, i)) { out += quote; i += quote.length - 1; quote = null; continue; }
      out += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = text.startsWith(c + c + c, i) ? c + c + c : c; out += quote; i += quote.length - 1; continue; }
    if (c === "#" && (!shell || i === 0 || /[\s;(|&)<>]/.test(text[i - 1]))) { let j = i; while (j < text.length && text[j] !== "\n") j++; out += " ".repeat(j - i); i = j - 1; continue; }
    out += c;
  }
  return out;
}
/** The 1-based lines of `text` holding a PostgREST form, ascending — comments blanked by the file's kind, strings read. */
function postgrestIn(text: string, rel: string): number[] {
  const hash = HASH_COMMENT_FILE.test(rel);
  const code = hash ? hashCommentsBlanked(text, SHELL_FILE.test(rel)) : blanked(text, false);
  const lineOf = lineIndexer(code);
  const lines = new Set<number>();
  for (const re of hash ? [POSTGREST_PATH, ...SUPABASE_PY_FORMS] : [POSTGREST_PATH, POSTGREST_JS_SPECIFIER]) for (const m of code.matchAll(re)) lines.add(lineOf(m.index!));
  return [...lines].sort((a, b) => a - b);
}
/** [text, file name (its kind), whether it is a hit] — the thirty files' shapes, and the neighbours the rule must not reach. */
const POSTGREST_PROBES: [string, string, boolean][] = [
  ["const res = await fetch(`${SUPABASE_URL}/rest/v1/thoughts?select=id`, { headers });", "x.mjs", true],
  ['fetch(SUPABASE_URL + "/rest/v1/rpc/match_thoughts", { method: "POST", headers, body });', "x.ts", true],
  ["const BASE = `${url}/rest/v1`;\nconst r = await fetch(`${BASE}/${pathQuery}&limit=1`);", "x.js", true],
  ['resp = requests.post(f"{SUPABASE_URL}/rest/v1/thoughts", headers=h, json=body, timeout=120)', "x.py", true],
  ["from supabase import create_client, Client", "x.py", true],
  ["supabase: Client = create_client(url, key)", "x.py", true],
  ['import { PostgrestClient } from "@supabase/postgrest-js";', "x.ts", true],
  ['"""Posts each row to /rest/v1/rpc/upsert_thought, the 3-argument form."""\nimport sys', "x.py", true],
  ['curl -s "$SUPABASE_URL/rest/v1/thoughts?select=id" -H "apikey: $KEY"', "x.sh", true],
  ["const url = `${SUPABASE_URL}/rest/v1/thoughts`; // the same in a comment: /rest/v1/thoughts", "x.mjs", true],
  ["echo '# not a comment: /rest/v1 inside quotes is a hit though'", "x.sh", true],
  // Not hits: a comment in either grammar, the shim's import, the key alone, a regex literal, other paths, a longer name.
  ["// the old path: ${SUPABASE_URL}/rest/v1/thoughts\nconst x = 1;", "x.mjs", false],
  ["/* POST /rest/v1/thoughts */\nconst x = 1;", "x.ts", false],
  ["# posts to /rest/v1/rpc/upsert_thought\nresp = requests.post(url, json=body)", "x.py", false],
  ["url = base  # was /rest/v1/thoughts", "x.py", false],
  ["x = \"it's\"  # /rest/v1/thoughts after an apostrophe in a string", "x.py", false],
  ['import { createClient } from "../../compat/supabase-sql/index.ts";', "x.ts", false],
  ["const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;", "x.mjs", false],
  ["const re = /rest\\/v1/;", "x.ts", false],
  ['const v = "/api/v1/thoughts";', "x.ts", false],
  ["const u = `${base}/functions/v1/smart-ingest`;", "x.ts", false],
  ['const p = "/api/rest/v10/x"; const q = "/arrest/v1/y";', "x.ts", false],
  ["name = create_client_name(x)", "x.py", false],
  ["const c = create_client(url);", "x.ts", false],
  // Shell: `#` inside a word is not a comment, so the hit after it is read; Python: it is, anywhere.
  ['n=${#arr[@]}; curl -s "$U/rest/v1/thoughts"', "x.sh", true],
  ["x = 1#c /rest/v1/thoughts", "x.py", false],
  ["import supabase\nsb = supabase.Client(url, key)", "x.py", true],
  ["from supabase.client import Client", "x.py", true],
  ["A=1;#c /rest/v1/thoughts", "x.sh", false],
  ["(true)#c /rest/v1/thoughts", "x.sh", false],
  ["# /rest/v1/thoughts\nx=1", "x.sh", false],
];
/** A helper for the table: the file's kind and its ticket. */
const POSTGREST = (what: string, ticket: string, lines: number): CountedException => ({ why: `${what} — ${ticket}`, lines });
const IMPORT = "an import that embeds the text itself and POSTs the row raw; it emits ingestion-contract items for `bun db/ingest-records.ts --source items --items` (SMD-2136)";
const SHIM = "a maintenance script; it moves onto compat/supabase-sql under bun";
/** SMD-3216 (2026-10-22): the shim retires, so the scripts still to port become clients of the REST core instead. */
const REST_CLIENT = "a script still to port; it becomes a REST-core client through rest-client/ (SMD-3216), naming any core operation it lacks";
/**
 * file → the ticket that ports or retires it, and the exact count of lines that speak PostgREST. Thirty files in
 * twenty-one recipes (SMD-2126's survey of f7693c4c, re-measured on d8e3de60); two more of the thirty —
 * atomizer's backfill-gmail-correspondents.mjs and authorship-edges' backfill-authorship.mjs — reach the
 * gateway through their `lib/` file alone and have no line of their own. Five of the thirty are gone:
 * obsidian-vault-import's import-obsidian.py (SMD-2137) and local-ollama-embeddings' embed-local.py (SMD-2138)
 * retired with their recipes, the first entries to leave; weekly-digest's weekly-digest.mjs (SMD-2239),
 * its live mode rebuilt as the db/ verb db/weekly-digest.ts (a sink, not a maintenance script — the
 * recipe's README stays a pointer); and brain-smoke-test's smoke-all.js (SMD-2103), retired with its
 * recipe once deploy/smoke.sh took the wrong-key refusal, the one check of its that applied here and
 * that smoke.sh lacked; and ob-graph's smoke-graph-rpcs.mjs, with its recipe (SMD-2920; SMD-2146
 * canceled). Five more are on the shim: brain-backup's
 * backup-brain.mjs and lint-sweep's lint-sweep.js (SMD-2144), the first ports to land, and
 * thought-enrichment's enrich-thoughts.mjs, backfill-type.mjs and backfill-sensitivity.mjs (SMD-2139),
 * the first writers.
 */
const POSTGREST_EXCEPTIONS = new Map<string, CountedException>([
  // Imports → the ingestion contract (after SMD-2136).
  ["recipes/chatgpt-conversation-import/import-chatgpt.py", POSTGREST(`${IMPORT}; SMD-2147 decides its match_thoughts dedup and chatgpt_conversations sidecar`, "SMD-2147", 3)],
  ["recipes/perplexity-conversation-import/import-perplexity.py", POSTGREST(IMPORT, "SMD-2148", 1)],
  ["recipes/readwise-import/import-readwise.py", POSTGREST("an import on supabase-py that already captures through upsert_thought (SMD-1524) over a transport the fork lacks; it emits contract items", "SMD-2149", 2)],
  ["recipes/google-activity-import/import-google-activity.mjs", POSTGREST(IMPORT, "SMD-2150", 1)],
  ["recipes/email-history-import/pull-gmail.ts", POSTGREST(REST_CLIENT, "SMD-2021", 2)],
  // Retire: the fork's core owns the capability.
  ["recipes/fingerprint-dedup-backfill/backfill-fingerprints.mjs", POSTGREST("superseded by migration 023; the file is removed", "SMD-2145", 1)],
  // Maintenance scripts → the shim under bun.
  ["recipes/fingerprint-dedup-backfill/delete-duplicates.mjs", POSTGREST(`${SHIM}, its deletes through delete_thought`, "SMD-2145", 1)],
  ["recipes/atomizer/audit-gmail-pipeline.mjs", POSTGREST(REST_CLIENT, "SMD-2140", 2)],
  ["recipes/atomizer/lib/entity-resolver.mjs", POSTGREST(`${REST_CLIENT} (backfill-gmail-correspondents.mjs reaches the gateway through it)`, "SMD-2140", 2)],
  ["recipes/atomizer/re-atomize-gmail-thought.mjs", POSTGREST(`${REST_CLIENT}, its thought writes through upsert_thought and delete_thought`, "SMD-2140", 2)],
  ["recipes/authorship-edges/lib/author-edges.mjs", POSTGREST(`${REST_CLIENT} (backfill-authorship.mjs reaches the gateway through it)`, "SMD-2141", 2)],
  ["recipes/typed-edge-classifier/classify-edges.mjs", POSTGREST(REST_CLIENT, "SMD-2141", 1)],
  ["recipes/provenance-chains/backfill.mjs", POSTGREST(REST_CLIENT, "SMD-2142", 1)],
  ["recipes/provenance-chains/eval.mjs", POSTGREST(REST_CLIENT, "SMD-2142", 1)],
  ["recipes/wiki-synthesis/scripts/synthesize-wiki.mjs", POSTGREST(REST_CLIENT, "SMD-2143", 1)],
  ["recipes/wiki-synthesis/scripts/backfill-gmail-wikis.mjs", POSTGREST(`${REST_CLIENT}, its page deletes through delete_thought`, "SMD-2143", 1)],
  ["recipes/entity-wiki/generate-wiki.mjs", POSTGREST(REST_CLIENT, "SMD-2143", 1)],
  // Not a maintenance script but a sink: it pages thought text and posts it to Telegram, which a shim
  // port would do from below the server's egress gate — the orchestration ADR's decision 9, written for
  // templates, is read to cover it. Its
  // two read-only siblings, brain-backup and lint-sweep, are on the shim (SMD-2144, rescoped 2026-09-26).
  ["recipes/source-filtering/backfill-metadata.ts", POSTGREST(REST_CLIENT, "SMD-2021", 2)],
]);
function checkPostgrestClients() {
  for (const name of ["x.ts", "x.tsx", "x.mts", "x.cts", "x.js", "x.jsx", "x.mjs", "x.cjs", "x.py", "x.sh"]) if (!POSTGREST_CODE_FILE.test(name)) fail(SELF, `check 24's POSTGREST_CODE_FILE no longer reads ${name} (its own probe)`);
  for (const name of ["x.md", "x.sql", "x.json", "x.html", "x.yaml", "x.pyc"]) if (POSTGREST_CODE_FILE.test(name)) fail(SELF, `check 24's POSTGREST_CODE_FILE reads ${name}, which it should not (its own probe)`);
  for (const name of ["x.py", "x.sh"]) if (!HASH_COMMENT_FILE.test(name)) fail(SELF, `check 24's HASH_COMMENT_FILE no longer treats ${name} as #-commented (its own probe)`);
  if (HASH_COMMENT_FILE.test("x.mjs")) fail(SELF, "check 24's HASH_COMMENT_FILE treats x.mjs as #-commented (its own probe)");
  if (!SHELL_FILE.test("x.sh") || SHELL_FILE.test("x.py")) fail(SELF, "check 24's SHELL_FILE no longer names x.sh alone (its own probe)");
  // The blanker on its own: a `#` in each string kind kept, one after each closed string blanked, offsets and newlines held.
  const blankerProbe = "a = 'x#y' # c1\nb = \"p#q\" # c2\nc = '''m#n\n#o''' # c3\nd = \"\"\"s\\\"#t\"\"\" # c4\ne = 1 # c5\n";
  const blankerWant = "a = 'x#y'     \nb = \"p#q\"     \nc = '''m#n\n#o'''     \nd = \"\"\"s\\\"#t\"\"\"     \ne = 1     \n";
  if (hashCommentsBlanked(blankerProbe) !== blankerWant) fail(SELF, `check 24's hashCommentsBlanked no longer blanks exactly the comments of its probe: ${JSON.stringify(hashCommentsBlanked(blankerProbe))}`);
  // Every way a shell comment opens — the text's start, whitespace, `;`, `|`, `&`, `(`, `)`, `>`, `<` — and the three
  // ways a `#` is not one (`$#`, `${#a[@]}`, `a#b`); the second review pass found the class asserted and unprobed.
  const shellProbe = "#c0\nn=$# ; m=${#a[@]} ;a#b # c1\n#c2\n x=1 #c3\na;#c4\nb|#c5\nc&#c6\n(#c7\n)#c8\nd>#c9\ne<#c10\n";
  const shellWant = "   \nn=$# ; m=${#a[@]} ;a#b     \n   \n x=1    \na;   \nb|   \nc&   \n(   \n)   \nd>   \ne<    \n";
  if (hashCommentsBlanked(shellProbe, true) !== shellWant) fail(SELF, `check 24's hashCommentsBlanked (shell) no longer blanks exactly the comments of its probe: ${JSON.stringify(hashCommentsBlanked(shellProbe, true))}`);
  for (const [probe, name, hit] of POSTGREST_PROBES) {
    const n = postgrestIn(probe, name).length;
    if (hit && n === 0) fail(SELF, `check 24 no longer catches its probe: ${JSON.stringify(probe)} (its own probe)`);
    if (!hit && n > 0) fail(SELF, `check 24 catches a non-probe: ${JSON.stringify(probe)} (its own probe)`);
  }
  // The line is the string's, once, for the probe whose hit and comment share a line: line 1 alone.
  const beside = POSTGREST_PROBES.find(([text]) => text.includes("// the same in a comment"));
  if (!beside) fail(SELF, "check 24's hit-beside-a-comment probe is gone (its own probe)");
  const twice = beside ? postgrestIn(beside[0], beside[1]) : [1];
  if (twice.length !== 1 || twice[0] !== 1) fail(SELF, `check 24 reports lines ${twice.join(",")} for a hit beside a comment, not line 1 once (its own probe)`);
  const files = textFilesUnder(SCANNED_ROOTS).filter((f) => POSTGREST_CODE_FILE.test(f));
  if (files.length === 0) fail(SELF, "check 24 found no code file under the seven category directories and docs/ — the listing is broken, not the tree clean");
  const MSG = "speaks PostgREST — a `rest/v1` path, a supabase-py client or postgrest-js reaches a brain only through Supabase's PostgREST, which this fork's stack does not run (SETUP.md), so the script's live mode fails at its first request; the class decision is docs/vendored-disposition.md's \"PostgREST-speaking scripts\" (SMD-2126): an import emits ingestion-contract items for `bun db/ingest-records.ts --source items --items` (SMD-2136), a maintenance script reaches Postgres through compat/supabase-sql under bun (`SUPABASE_URL` a postgres:// string), or the file is listed in POSTGREST_EXCEPTIONS with its line count and the ticket that ports or retires it";
  const seen = new Set<string>();
  for (const file of files) {
    const rel = relOf(file);
    const lines = postgrestIn(readFileSync(file, "utf8"), rel);
    const excepted = POSTGREST_EXCEPTIONS.get(rel);
    if (excepted) {
      seen.add(rel);
      if (lines.length !== excepted.lines) fail(rel, `check 24's exception covers ${excepted.lines} line(s) that speak PostgREST and the file has ${lines.length} (${lines.join(", ") || "none"}) — ${lines.length > excepted.lines ? "a new call beside the documented ones" : "the port landed on those lines, so the exception is stale: lower the count, or remove the entry when no line remains"} (${excepted.why})`);
      continue;
    }
    for (const line of lines) fail(`${rel}:${line}`, MSG);
  }
  for (const rel of POSTGREST_EXCEPTIONS.keys()) if (!seen.has(rel)) fail(rel, "check 24's exception names a file the scan does not reach — stale, or the file is gone: remove the entry");
}
checkPostgrestClients();

// ── 25: the REST core and the HTTP edge are transport; the logic is core/'s (SMD-2283) ──
//
// SMD-2283 moved every tool's logic — the store reads and writes, the egress
// gate, the embedding and extraction calls, the action log — into
// server-portable/core/, so index.ts validates (the SDK runs core/schemas.ts's
// zod), calls a core operation and renders its answer (render.ts), and the REST
// core (SMD-2284) calls the same operations: one gateway, not two (SMD-1931).
// The process root both entries build on — the environment, the store and the
// agent registry — is root.ts, and the REST core (api.ts, rest/) is held as
// index.ts was (SMD-2284), as is the endpoint's HTTP edge, mcp-edge.ts
// (SMD-2287). SMD-2287 PR 6b deleted index.ts: the REST core is the one entry
// that reads the store, and its allowlist stays as the probes' (PROBE_ROLE).
// This is a tripwire for the forms a move leaves
// behind, not a proof: a text scan cannot follow a value. In each of
// TRANSPORT_FILES:
//   - every import and re-export statement (comments and strings blanked, so
//     a sentence naming a file is not one) names a module the file's own list
//     allows, whole or by the names it lists, under their own names — for
//     the probes' role the root's readers, core/reads.ts's deadlines, core/filter.ts's
//     parsers; for root.ts the store's factory, a notice, its kind and its
//     type, and db/config.mjs's two env helpers — never egress.ts, embed.ts,
//     metadata.ts or a store backend; no side-effect import, no dynamic import
//     or require;
//   - strings blanked too: no `sql` template, `new SQL`, `.unsafe(`, or
//     `fetch(` bare or on globalThis (a provider call is the core's);
//   - the store's builder `db` named only in the root's import, where root.ts
//     declares it, handed to the core (`createCore({ …, store: db })`), called
//     for the agent registry (`agents().resolve(db(), …)`), as an object key,
//     or in root.ts by serveHere() as `void db().catch(() => {});` alone, its
//     start-up build (SMD-2284) — an alias, `(db)()`, another caller (the
//     root's other wiring too) or another `store:` is a hit;
//   - the store itself (`_store`, `createStore`, called or not) named only in
//     root.ts, inside db() and closeStore() — db() builds it and wires the job
//     sink to it, closeStore() closes it at a stop; the factory in db() alone —
//     at its declaration and in the store module's import. A second db(),
//     closeStore() or serveHere(), in any of TRANSPORT_FILES, is a hit.
// What it does not see: a store method reached through a value it cannot name
// (a parameter, the agent registry's own lookups, a context the core hands
// back), an alias of a global (`Bun.sql`), and a module the allowlist admits
// doing more than its name says. Probes run on in-memory text.
/** What a file may import: a module whole ("*"), or only the names listed. */
type TransportImports = ReadonlyMap<string, "*" | ReadonlySet<string>>;
/** A file check 25 reads: what it may import, whether it holds the store's wiring, and an import its reader must find (so a broken reader is not a clean file). */
type TransportRole = { imports: TransportImports; wiring: boolean; mustImport: string };
/** The probes' role: index.ts's allowlist, the MCP server's entry until SMD-2287 PR 6b deleted it — a transport file's widest set of imports, for the probes to hold the reader's rules over. */
const PROBE_ROLE: TransportRole = {
  imports: new Map<string, "*" | ReadonlySet<string>>([
    ["@modelcontextprotocol/server", "*"], ["hono", "*"],
    // The process root's readers: the environment, the store's builder and closer, the agent registry, the enabled plugins.
    ["./root.ts", new Set(["agents", "closeStore", "db", "env", "initEnv", "plugins", "serveHere", "Env"])],
    ["./auth.ts", "*"], ["./version.ts", "*"], ["./shutdown.ts", "*"], ["./jobs.ts", "*"], ["./tools.ts", "*"], ["./sse.ts", "*"],
    ["./core/index.ts", "*"], ["./render.ts", "*"],
    // The public origin's answers (SMD-2382): HTTP at the edge, no store, no provider.
    ["./oauth-edge.ts", "*"],
    // The request's JSON line and its spans (SMD-1849): an allow-list, a sink and the OpenTelemetry API; the SDK only through startTelemetry; no store, no provider.
    ["./telemetry.ts", "*"],
    // The core's deadlines and filter parser — its operations are reached through createCore.
    ["./core/reads.ts", new Set(["HEALTH_DEADLINE_MS", "BRAIN_INFO_TOOL_DEADLINE_MS"])],
    ["./core/filter.ts", new Set(["parseFilter", "withActorFilter"])],
    // The endpoint's HTTP edge (SMD-2287 PR 2): refusal envelopes, CORS, a request's parts — held below as a transport file of its own.
    ["./mcp-edge.ts", "*"],
  ]),
  wiring: false,
  mustImport: "./core/index.ts",
};
// The MCP endpoint's HTTP edge, moved out of index.ts (SMD-2287 PR 2) for the
// MCP server as a REST client to answer as this one does: HTTP alone — the
// origin's challenge, the request record's types, the tool names — and no
// store, no provider, no environment.
const EDGE_ROLE: TransportRole = {
  imports: new Map<string, "*" | ReadonlySet<string>>([
    ["hono", new Set(["Context"])],
    ["./oauth-edge.ts", new Set(["challengeHeader", "UNREACHABLE_RETRY_AFTER_SECONDS"])],
    ["./telemetry.ts", new Set(["traceOf", "RequestOutcome", "RequestTrace"])],
    ["./tools.ts", new Set(["ToolName"])],
    // The worker mirrors' inputs and the codes their words cover (SMD-2287): types alone.
    ["./core/schemas.ts", new Set(["Input"])],
    ["./core/workers.ts", new Set(["ReleaseLeasesCode", "RetryFailedCode", "RunWorkerCode"])],
  ]),
  wiring: false,
  mustImport: "./telemetry.ts",
};
const ROOT_ROLE: TransportRole = {
  imports: new Map<string, "*" | ReadonlySet<string>>([
    // The factory, for db() alone (STORE_WIRING), and the store's type.
    ["./store.ts", new Set(["createStore", "ThoughtStore"])],
    ["../db/config.mjs", new Set(["tierProblem", "trimmedEnv"])],
    ["./agents.ts", "*"],
    ["./jobs.ts", new Set(["setJobSink"])],
    // The enabled plugins, read once from the environment (SMD-2310): manifests checked, nothing run.
    ["./core/plugins.ts", new Set(["enabledHooks", "hookSecrets", "loadPlugins", "LoadedHook", "LoadedPlugin"])],
    // Their tool names, for the request line (SMD-1849): a name list, no logic.
    ["./telemetry.ts", new Set(["knowTools"])],
  ]),
  wiring: true,
  mustImport: "./store.ts",
};
// The REST core (SMD-2284): its entry builds the core over the root's readers; rest/ routes, authorizes and answers, and reaches the
// store, the gate and the models through the core alone.
const API_ROLE: TransportRole = {
  imports: new Map<string, "*" | ReadonlySet<string>>([
    ["./root.ts", new Set(["agents", "closeStore", "db", "env", "hooks", "initEnv", "plugins", "serveHere"])],
    // The request rebuilt where its URL will not parse (SMD-2535), and the address listened on (SMD-3323), in auth.ts so
    // the vendored copies have them (SMD-2595).
    ["./auth.ts", new Set(["listenHostFrom", "routable"])],
    // This host's addresses, so an OB1_LISTEN_HOST it does not have stops the server in words (SMD-3323): no store.
    ["node:os", new Set(["networkInterfaces"])],
    ["./core/index.ts", "*"], ["./shutdown.ts", "*"], ["./jobs.ts", "*"], ["./rest/app.ts", "*"],
    // The authorization server's token check, built from the environment (SMD-2286): authorization, as auth.ts is, no store.
    ["./oauth-token.ts", new Set(["remoteChecker", "tokenSettings", "TokenCheck"])],
    // The stop's lines for what it cuts, and the spans' start and flush (SMD-1849), what a cut flush held (SMD-2902)
    // and the mark its word counts from (SMD-3297): request records and telemetry, no store.
    ["./telemetry.ts", new Set(["cutOpenRequests", "cutTelemetry", "flushTelemetry", "markTelemetry", "startTelemetry"])],
  ]),
  wiring: false,
  mustImport: "./core/index.ts",
};
const REST_IMPORTS = new Map<string, "*" | ReadonlySet<string>>([
  ["hono", "*"], ["zod", "*"],
  ["../auth.ts", "*"], ["../tools.ts", "*"], ["../jobs.ts", "*"], ["../sse.ts", "*"], ["../version.ts", "*"],
  ["../agents.ts", new Set(["AgentOutcome"])],
  ["../core/index.ts", "*"],
  ["../core/refusal.ts", new Set(["failure", "ok", "refusalValue", "Refusal", "RefusalCode"])],
  // A bearer token's shape and the 503's wait (SMD-2382), and the token check's type (SMD-2286): authorization, as auth.ts is.
  ["../oauth-edge.ts", new Set(["JWT_SHAPE", "UNREACHABLE_RETRY_AFTER_SECONDS"])],
  ["../oauth-token.ts", new Set(["TokenCheck"])],
  ["./routes.ts", "*"], ["./openapi.ts", "*"],
  ["../telemetry.ts", "*"],
]);
const REST_ROLE: TransportRole = { imports: REST_IMPORTS, wiring: false, mustImport: "../core/index.ts" };
const TRANSPORT_FILES = new Map<string, TransportRole>([
  ["server-portable/mcp-edge.ts", EDGE_ROLE],
  ["server-portable/root.ts", ROOT_ROLE],
  ["server-portable/api.ts", API_ROLE],
  ["server-portable/rest/app.ts", REST_ROLE],
  ["server-portable/rest/routes.ts", REST_ROLE],
  ["server-portable/rest/openapi.ts", REST_ROLE],
]);
/** The functions whose bodies are the store's wiring: build it once (and wire the job sink), close it at a stop, and build it at a serving entry's start (SMD-2284). */
const STORE_WIRING = ["db", "closeStore", "serveHere"];
/** [start, end) of each STORE_WIRING function's body in `bare` (strings and comments blanked); a name not found is absent. */
function wiringSpans(bare: string): Map<string, [number, number]> {
  const spans = new Map<string, [number, number]>();
  for (const name of STORE_WIRING) {
    // The body opens with the `{` that ends the signature's line, so a brace in
    // a return type or a parameter (`Promise<{ closed: boolean }>`) is not it.
    const m = new RegExp(`\\bfunction\\s+${name}\\s*\\([^\\n]*\\{[ \\t]*$`, "m").exec(bare);
    if (!m) continue;
    const open = m.index + m[0].lastIndexOf("{");
    let depth = 0, i = open;
    for (; i < bare.length; i++) {
      if (bare[i] === "{") depth++;
      else if (bare[i] === "}" && --depth === 0) break;
    }
    spans.set(name, [m.index, i + 1]);
  }
  return spans;
}
/** The lines of `text` (one of TRANSPORT_FILES, read as `role`) that reach past the core, each with what it reached. Pure over a text. */
function transportLeaksIn(text: string, role: TransportRole = PROBE_ROLE): { line: number; what: string }[] {
  const hits: { line: number; what: string }[] = [];
  const lineAt = (i: number) => text.slice(0, i).split("\n").length;
  const code = blanked(text, false); // comments blanked: a specifier is read here
  const bare = blanked(text, true); // strings too: a statement is found here, so a sentence naming a file is not one
  const specAt = (q: number) => code.slice(q + 1, code.indexOf(code[q], q + 1));
  /**
   * Each import statement's span by its module: `db` may be named in the
   * root's, the store in the store module's — and nowhere else for being in a
   * statement (review pass 1).
   */
  const imports: [spec: string, start: number, end: number][] = [];
  // A statement's keyword stands alone — not a member (`cfg.import`) or part of
  // a name — and its clause holds no `=`, `(` or `)`, which no import or
  // export clause has: without them a line with no semicolon (`export const
  // PORT = 8080`, `import X = NS.y`) read on to the next `from "` and made the
  // lines between one statement (review pass 2).
  for (const m of bare.matchAll(/(?<![.\w$])(import|export)\s+(?:type\s+)?([^;"'`=()]*?)\s*\bfrom\s*["']/g)) {
    const spec = specAt(m.index + m[0].length - 1);
    const reexport = m[1] === "export";
    if (!reexport) imports.push([spec, m.index, m.index + m[0].length]);
    const allowed = role.imports.get(spec);
    if (!allowed) { hits.push({ line: lineAt(m.index), what: `imports ${spec}` }); continue; }
    if (allowed === "*") continue;
    const list = /\{([^}]*)\}/.exec(m[2]);
    if (!list || /\*/.test(m[2]) || /^[\w$]+\s*(?:,|$)/.test(m[2].trim())) { hits.push({ line: lineAt(m.index), what: `imports ${spec} whole, where only ${[...allowed].join(", ")} may be named` }); continue; }
    for (const entry of list[1].split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean)) {
      // Under its own name: a rename would hide the name the rules below look for.
      const [name, alias] = entry.split(/\s+as\s+/);
      if (!allowed.has(name)) hits.push({ line: lineAt(m.index), what: `imports ${name} from ${spec}` });
      else if (alias !== undefined && alias !== name) hits.push({ line: lineAt(m.index), what: `imports ${name} from ${spec} as ${alias}` });
      // Handed on, the store's builder or closer is out of every rule below (review pass 1).
      else if (reexport && STORE_WIRING.includes(name)) hits.push({ line: lineAt(m.index), what: `re-exports ${name} from ${spec}` });
    }
  }
  const inImportOf = (spec: string, i: number) => imports.some(([from, s, e]) => from === spec && i >= s && i < e);
  for (const m of bare.matchAll(/\bimport\s*["']/g)) hits.push({ line: lineAt(m.index), what: `a side-effect import of ${specAt(m.index + m[0].length - 1)}` });
  for (const m of bare.matchAll(/\b(?:import|require)\s*\(/g)) hits.push({ line: lineAt(m.index), what: "a dynamic import" });
  for (const m of bare.matchAll(/\bsql\s*`|\bnew\s+(?:Bun\s*\.\s*)?SQL\b|\.unsafe\s*\(/g)) hits.push({ line: lineAt(m.index), what: "a SQL call" });
  for (const m of bare.matchAll(/(?<![.\w$])fetch\s*\(|\bglobalThis\s*\.\s*fetch\b/g)) hits.push({ line: lineAt(m.index), what: "a fetch (a provider call is the core's)" });
  const wiring = role.wiring ? wiringSpans(bare) : new Map<string, [number, number]>();
  const inBody = (name: string, i: number) => { const span = wiring.get(name); return span !== undefined && i >= span[0] && i < span[1]; };
  // In a transport file every declaration of db() or closeStore() is a second
  // one; in the root, every one after the first (review pass 2).
  for (const name of STORE_WIRING) {
    const declared = [...bare.matchAll(new RegExp(`\\bfunction\\s+${name}\\b`, "g"))];
    for (const m of declared.slice(role.wiring ? 1 : 0)) hits.push({ line: lineAt(m.index), what: `a second ${name}() — the store's wiring is root.ts's ${STORE_WIRING.map((n) => `${n}()`).join(", ")}` });
  }
  for (const m of bare.matchAll(/(?<![.\w$])db\b/g)) {
    const before = bare.slice(0, m.index), after = bare.slice(m.index + 2);
    if (inImportOf("./root.ts", m.index)) continue; // named in the root's import — the list above holds which
    // serveHere's start-up build, the one form: its rejection is the first request's to report (review pass 2: any call in any wiring body passed).
    if (inBody("serveHere", m.index) && /\bvoid\s+$/.test(before) && /^\(\)\.catch\(\(\)\s*=>\s*\{\s*\}\);/.test(after)) continue;
    if (/\bcreateCore\(\s*\{[^{}]*\bstore\s*:\s*$/.test(before) && /^\s*[,}]/.test(after)) continue; // handed to the core, uncalled
    if (/\bagents\(\)\s*\.\s*resolve\(\s*$/.test(before) && /^\s*\(\s*\)/.test(after)) continue; // the agent registry's lookup
    if (/[{,]\s*$/.test(before) && /^\s*:/.test(after)) continue; // an object key, not the builder
    if (/\bfunction\s+$/.test(before)) continue; // a second db(): said once, above
    hits.push({ line: lineAt(m.index), what: "the store's builder db named past the core" });
  }
  // The factory builds the store in db() alone; closeStore() closes what db() built; serveHere() only calls db().
  for (const m of bare.matchAll(/(?<![.\w$])(?:_store|createStore)\b/g)) {
    const where = m[0] === "createStore" ? ["db"] : ["db", "closeStore"];
    if (inImportOf("./store.ts", m.index) || where.some((n) => inBody(n, m.index)) || (role.wiring && /\blet\s+$/.test(bare.slice(0, m.index)))) continue;
    hits.push({ line: lineAt(m.index), what: role.wiring ? `the store (${m[0]}) named outside ${where.map((n) => `${n}()`).join(" and ")}` : `the store (${m[0]}) named outside root.ts` });
  }
  return hits;
}
/** [text, hit, role] — what check 25 must catch, and what it must not; the role is index.ts's unless named. */
const TRANSPORT_PROBES: [string, boolean, TransportRole?][] = [
  ['import { decideCalls } from "./egress.ts";\n', true],
  ["import type { EmbedConfig } from './embed.ts'\n", true],
  ['export { extractMetadata } from "./metadata.ts";\n', true],
  ['import "./store-sql.ts";\n', true],
  ['const egress = await import("./egress.ts");\n', true],
  ['const t = require("./thoughts.ts");\n', true],
  ['import { workerStatus } from "./core/reads.ts";\n', true],
  ['import * as reads from "./core/reads.ts";\n', true],
  ['import { createStore, isoTimestamp } from "./store.ts";\n', true, ROOT_ROLE],
  ["const r = await (await db()).retryFailed(workType);\n", true],
  ["const s = await db();\nawait s.retryFailed(workType);\n", true],
  ["void db().then((s) => s.logActions(rows));\n", true],
  ["const s = db;\nawait (await s()).retryFailed(workType);\n", true],
  ["await (db)().then((s) => s.close());\n", true],
  ["await db?.();\n", true],
  ["await Promise.resolve(db()).then((s) => s.retryFailed(workType));\n", true],
  ["const r = await (await _store!).retryFailed(workType);\n", true],
  ["const s = await createStore(env());\n", true],
  ["const rows = await sql`select 1`;\n", true],
  ["const pg = new SQL(url);\n", true],
  ['await s.unsafe("select 1");\n', true],
  ['const r = await fetch("https://openrouter.ai/api/v1/embeddings", { method: "POST" });\n', true],
  ["const r = await globalThis.fetch(url);\n", true],
  // Review pass 2: the factory renamed, aliased or applied, and a store: that is not the core's.
  ['import { createStore as mk } from "./store.ts";\nconst s = await mk(env());\n', true, ROOT_ROLE],
  ["const mk = createStore;\n", true, ROOT_ROLE],
  ["const s = await createStore.call(null, env());\n", true, ROOT_ROLE],
  ["const o = { store: db() };\n", true],
  ["const c = createContext({ env, store: db, door });\n", true],
  ["const core = createCore({ env, store: db(), door });\n", true],
  // SMD-2284: the root's readers by name, and nowhere else the wiring.
  ['import { db as store } from "./root.ts";\n', true],
  ['import { createStore } from "./store.ts";\n', true],
  ["let _store: Promise<ThoughtStore> | null = null;\n", true],
  ["function db(): Promise<ThoughtStore> {\n  return _store!;\n}\n", true],
  ["export function closeStore(): Promise<boolean> {\n  return Promise.resolve(false);\n}\n", true],
  ['import { decideCalls } from "./egress.ts";\n', true, ROOT_ROLE],
  // SMD-2284 review pass 1: the builder handed on, a statement read on past its line, a second db() naming no store.
  ['export { db } from "./root.ts";\n', true],
  ['export { closeStore } from "./root.ts";\n', true],
  ['export const s = db\nimport { canRead } from "./auth.ts";\n', true],
  ['export const s = createStore(env())\nimport { setJobSink } from "./jobs.ts";\n', true, ROOT_ROLE],
  ["function db() {\n  return Promise.reject(new Error(\"elsewhere\"));\n}\n", true],
  // …and a builder or a factory of the same name from another module the file may import whole.
  ['import { db } from "./jobs.ts";\n', true],
  ['import { createStore } from "./agents.ts";\n', true, ROOT_ROLE],
  // Review pass 2: a keyword that is a member, a line with no semicolon, a second declaration in the root, the factory in closeStore().
  ['const ldr = cfg.import\nconst leaked = db\nimport { initEnv } from "./root.ts";\n', true],
  ['void cfg.import\nvoid db\nimport { env } from "./root.ts";\n', true],
  ['const ldr = cfg.import\nconst s = createStore(env())\nimport { setJobSink } from "./jobs.ts";\nimport { storeKind } from "./store.ts";\n', true, ROOT_ROLE],
  ['import X = NS.y\nconst q = db\nimport { env } from "./root.ts";\n', true],
  ['export function db(): Promise<ThoughtStore> {\n  return _store!;\n}\nexport function closeStore(): Promise<boolean> {\n  function closeStore() { return Promise.resolve(true); }\n  return closeStore();\n}\n', true, ROOT_ROLE],
  ['export function db(): Promise<ThoughtStore> {\n  return _store!;\n}\nexport function closeStore(): Promise<boolean> {\n  return createStore(env()).then(() => true);\n}\n', true, ROOT_ROLE],
  ['export const PORT = 8080\nimport { db } from "./root.ts";\nconst core = createCore({ env, store: db, door });\n', false],
  ['export const X = 1\nimport { createStore, type ThoughtStore } from "./store.ts";\n', false, ROOT_ROLE],
  // SMD-2284 PR 2: the REST core reaches the store through the core alone.
  ['import { decideCalls } from "../egress.ts";\n', true, REST_ROLE],
  ['import { createStore } from "../store.ts";\n', true, REST_ROLE],
  ["const r = await fetch(url);\n", true, REST_ROLE],
  ['import { createCore } from "./core/index.ts";\nimport { db } from "./root.ts";\nconst core = createCore({ env, store: db, door: API_DOOR });\nconst id = await agents().resolve(db(), p);\n', false, API_ROLE],
  ['import { db } from "./root.ts";\nconst s = await db();\n', true, API_ROLE],
  ['import { failure, refusalValue, type Refusal, type RefusalCode } from "../core/refusal.ts";\n', false, REST_ROLE],
  ['import { refuse } from "../core/refusal.ts";\n', true, REST_ROLE],
  // SMD-2287 PR 2: the endpoint's HTTP edge takes the origin's challenge and the record's types, by name, and no more of either module.
  ['import { challengeHeader, UNREACHABLE_RETRY_AFTER_SECONDS } from "./oauth-edge.ts";\nimport { traceOf, type RequestOutcome, type RequestTrace } from "./telemetry.ts";\n', false, EDGE_ROLE],
  ['import { refusalAt } from "./oauth-edge.ts";\n', true, EDGE_ROLE],
  ['import { env } from "./root.ts";\n', true, EDGE_ROLE],
  ['import { beginRequest } from "./telemetry.ts";\n', true, EDGE_ROLE],
  // SMD-2284 PR 3: the root's serveHere builds the store at a serving entry's start — the wiring calling itself.
  ["export function serveHere(door: string): void {\n  serving = door;\n  initEnv();\n  void db().catch(() => {});\n}\n", false, ROOT_ROLE],
  ["export function startUp(): void {\n  void db().catch(() => {});\n}\n", true, ROOT_ROLE],
  // Review pass 2: only that form, only there — a store call in serveHere, db() in closeStore(), the store in serveHere.
  ["export function serveHere(door: string): void {\n  serving = door;\n  void db().then((s) => s.retryFailed(\"x\"));\n}\n", true, ROOT_ROLE],
  ["export function serveHere(door: string): void {\n  void db().catch(() => {}).then((s) => s?.retryFailed(\"x\"));\n}\n", true, ROOT_ROLE],
  ["export function closeStore(): Promise<boolean> {\n  return db().then(async (s) => { await s.close(); return true; });\n}\n", true, ROOT_ROLE],
  ["export function serveHere(door: string): void {\n  serving = door;\n  _store = null;\n}\n", true, ROOT_ROLE],
  // Review pass 1's root probe: a store call past the wiring, in the root itself.
  ["const r = await (await db()).retryFailed(workType);\n", true, ROOT_ROLE],
  ['import { agents, closeStore, db, env, initEnv, serveHere, type Env } from "./root.ts";\n', false],
  ["drainOnSignal({ server: () => bunServer, close: closeStore });\n", false],
  ['import { createCore, SPECS } from "./core/index.ts";\n', false],
  ['import type { ToolName } from "./tools.ts";\nexport { parseFilter } from "./core/filter.ts";\n', false],
  ['import { HEALTH_DEADLINE_MS } from "./core/reads.ts";\nexport { HEALTH_DEADLINE_MS, BRAIN_INFO_TOOL_DEADLINE_MS } from "./core/reads.ts";\n', false],
  ['import { createStore, type ThoughtStore } from "./store.ts";\n', false, ROOT_ROLE],
  // The PostgREST store's notice and the kind left with it (SMD-3152): the root names neither.
  ['import { createStore, postgrestOnBunNotice, type ThoughtStore } from "./store.ts";\n', true, ROOT_ROLE],
  ['// import { decideCalls } from "./egress.ts";\n', false],
  ["const msg = \"copied from './egress.ts' once\";\nconst t = `moved from \"./x.ts\"`;\n", false],
  ["let _store: Promise<ThoughtStore> | null = null;\nexport function db(): Promise<ThoughtStore> {\n  if (!_store) _store = createStore(env());\n  void _store.then((s) => s.jobSink(serving));\n  return _store;\n}\n", false, ROOT_ROLE],
  ["export function closeStore(): Promise<boolean> {\n  return _store ? _store.then(async (s) => { await s.close(); return true; }) : Promise.resolve(false);\n}\n", false, ROOT_ROLE],
  ["const identity = await agents().resolve(db(), principal);\n", false],
  ["const core = createCore({ env, store: db, door: SERVER_NAME });\n", false],
  ["const core = createCore({\n  env,\n  store: db,\n  door: SERVER_NAME,\n});\n", false],
  ['import {\n  createStore,\n  type ThoughtStore,\n} from "./store.ts";\n', false, ROOT_ROLE],
  ['return c.json({ db: "up", store: "sql" });\n', false],
  ["function closeStore(): Promise<{ closed: boolean }> {\n  return _store ? _store.then(() => ({ closed: true })) : Promise.resolve({ closed: false });\n}\n", false, ROOT_ROLE],
  ["export default { port, fetch: app.fetch };\nconst r = await app.fetch(req);\n", false],
  ['// (await db()).retryFailed(workType) — said in a comment\nconst s = "await db() and sql`x` in a string";\n', false],
];
function checkTransportOnly() {
  for (const [probe, hit, role] of TRANSPORT_PROBES) {
    const n = transportLeaksIn(probe, role).length;
    const as = role === ROOT_ROLE ? " as root.ts" : "";
    if (hit && n === 0) fail(SELF, `check 25 no longer catches its probe${as}: ${JSON.stringify(probe)} (its own probe)`);
    if (!hit && n > 0) fail(SELF, `check 25 catches a non-probe${as}: ${JSON.stringify(probe)} — ${transportLeaksIn(probe, role).map((h) => h.what).join("; ")} (its own probe)`);
  }
  // Every entry that serves the store — a server-portable module calling serveHere(), root.ts's own definition aside —
  // is one of TRANSPORT_FILES: the REST core is the one since SMD-2287 PR 6b retired index.ts, and an entry the list
  // lost would be held by nothing (review pass 6b·6: dropping api.ts passed).
  const spDir = join(ROOT, "server-portable");
  for (const f of readdirSync(spDir).filter((n) => n.endsWith(".ts") && !n.startsWith("test-") && n !== "root.ts").sort()) {
    if (/\bserveHere\(/.test(blanked(readFileSync(join(spDir, f), "utf8"), true)) && !TRANSPORT_FILES.has(`server-portable/${f}`))
      fail(`server-portable/${f}`, "calls serveHere() — it serves the store — and is not one of check 25's TRANSPORT_FILES: add it with its role, so its imports are held as the REST core's are (SMD-2283, SMD-2287)");
  }
  for (const [file, role] of TRANSPORT_FILES) {
    const path = join(ROOT, file);
    if (!existsSync(path)) { fail(file, "check 25's file is gone — move the check with it"); continue; }
    const text = readFileSync(path, "utf8");
    if (!new RegExp(`\\bfrom\\s*["']${role.mustImport.replace(/[.]/g, "\\.")}["']`).test(blanked(text, false))) fail(file, `check 25 reads no import of ${role.mustImport} — the reader is broken, not the file clean`);
    if (role.wiring) {
      const spans = wiringSpans(blanked(text, true));
      for (const name of STORE_WIRING) if (!spans.has(name)) fail(file, `check 25 finds no function ${name}() — STORE_WIRING names the functions that build and close the store; rename it there with the function`);
    }
    for (const { line, what } of transportLeaksIn(text, role)) {
      fail(`${file}:${line}`, `${what} — a transport file validates, calls a core operation and answers (SMD-2283), over the process root in root.ts (SMD-2284); the store, the egress gate and the model calls are server-portable/core/'s, so the REST core (SMD-2284) makes the same calls: move the logic into core/, or, for a module or name that holds no logic, add it to the file's TRANSPORT_FILES list`);
    }
  }
}
checkTransportOnly();

// ── 26: every vendored capture path names its trust ──────────────────────────
//
// SMD-1724. Migration 073 stamps every thought with the trust of the write
// that put its text there — the key's registry kind, or what the write
// declared below it — and the read tools label it, with a notice on outside
// text. A key's kind is a ceiling, not a description: an importer whose key
// is an operator's would label a scraped page `operator` unless the write
// says what it carries. So every vendored path that captures says so:
//   - a capture through the function — `.rpc("upsert_thought", …)`,
//     `callRpc(…)`, supabase-py's `.rpc("upsert_thought", {…})` — or a
//     client's call of the MCP `capture_thought` tool (`{ name:
//     "capture_thought", arguments }`, `callTool("capture_thought", {…})`;
//     a server registering the tool — `server.registerTool(…)`,
//     `server.tool(…)` — is not a call) makes the file a capture path;
//   - a capture path carries a `trust` key — `trust: "ingested"`,
//     `event: { trust }`, Python's `"trust": "ingested"` — comments blanked;
//     whole-file, as checks 8 and 10 bind a name: one declaration answers
//     the file's every call. The value is the file's to choose: a word, or a
//     client's forwarded (the database clamps it either way);
//   - a raw row cannot declare: 073's trigger strips a payload's trust, and
//     the event handoff is a transaction setting nothing sets over PostgREST.
//     So a raw capture — a POST to `rest/v1/thoughts`, a `.post("thoughts",
//     …)`, or check 10's raw insert — is listed in TRUST_EXCEPTIONS with the
//     reason and the exact count of its lines: a port that lands fails until
//     its entry goes, and the port's call must declare.
// Scanned: every .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs/.py/.sh under the
// seven category directories (docs/ holds no capture path; a README's sample
// is prose).
/** A capture through the function: an `upsert_thought` RPC by any client, the name a string literal — or its PostgREST path, `rpc/upsert_thought`, which a port of the Python importers would POST to (first review pass). */
const UPSERT_RPC = [/\b\w*rpc\s*\(\s*(["'`])upsert_thought\1\s*,/gi, /\brpc\/upsert_thought\b/g];
/** A JSON-RPC tools/call of capture_thought: its params object, keys quoted or not, in either order (first review pass). */
const MCP_CAPTURE_PARAMS = [/(["']?)name\1\s*:\s*(["'`])capture_thought\2\s*,\s*(["']?)arguments\3\s*:/g, /(["']?)arguments\1\s*:[^{}\n]*,\s*(["']?)name\2\s*:\s*(["'`])capture_thought\3/g];
/** A call whose first argument is the tool's name and second its arguments object — a client's, unless the callee registers a tool. */
const MCP_CAPTURE_CALL = /(?<![\w$])([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(\s*(["'`])capture_thought\2\s*,\s*\{/g;
/** The callees that register a tool rather than call one: the SDK's two, reached as a method. */
const REGISTERS_TOOL = /\.\s*(?:registerTool|tool)$/;
/**
 * A declaration in the shape a write reads it. upsert_thought's is the payload's write event — `event: { trust … }`,
 * a key or a shorthand, Python's `"event": {"trust": …}` — and capture_thought's is the arguments' `trust:` key. Not
 * any `trust` in the file: a schema's key, a parameter or a positional argument passed for the call site's deleted
 * declaration in five files (first review pass), so the RPC's form is the event object alone.
 */
const EVENT_TRUST_DECLARED = /(["']?)event\1\s*:\s*\{\s*(["']?)trust\2\s*[:,}]/;
const TOOL_TRUST_DECLARED = /(?<![\w$.])(["'`]?)trust\1\s*:\s*(?!z\.|string\b|Trust\b)/;
/** A raw capture over PostgREST: the table's own path, closed (a `?` query is a read or an edit), a helper's `.post("thoughts", …)`, or a helper's `.patch("thoughts?…", { content … })` — a raw rewrite of the text, stamped from the key's kind (first review pass). */
const RAW_CAPTURE_FORMS = [/\brest\/v1\/thoughts["'`]/g, /\.post\(\s*(["'`])thoughts\1\s*,/g, /\.patch\(\s*["'`]thoughts\?[^,\n]*,\s*\{[^}\n]*\bcontent\b/g];

/** A file's capture call sites and raw captures, by line, comments blanked by its kind (check 24's blankers). */
function capturePathsIn(text: string, rel: string): { calls: number[]; raw: number[]; declares: boolean } {
  const hash = HASH_COMMENT_FILE.test(rel);
  const code = hash ? hashCommentsBlanked(text, SHELL_FILE.test(rel)) : blanked(text, false);
  const lineOf = lineIndexer(code);
  const calls = new Set<number>();
  let rpc = false, tool = false;
  for (const re of UPSERT_RPC) for (const m of code.matchAll(re)) { calls.add(lineOf(m.index!)); rpc = true; }
  // Python's MCP clients too (`session.call_tool("capture_thought", {…})`, a dict's `"name"`); shell's curl is not read.
  if (!SHELL_FILE.test(rel)) {
    for (const re of MCP_CAPTURE_PARAMS) for (const m of code.matchAll(re)) { calls.add(lineOf(m.index!)); tool = true; }
    for (const m of code.matchAll(MCP_CAPTURE_CALL)) if (!REGISTERS_TOOL.test(m[1])) { calls.add(lineOf(m.index!)); tool = true; }
  }
  const raw = new Set<number>();
  for (const re of RAW_CAPTURE_FORMS) for (const m of code.matchAll(re)) raw.add(lineOf(m.index!));
  // Check 10's raw insert, read on the file's own text (it blanks SQL comments itself).
  if (!hash) for (const line of thoughtWritesAroundIn(text)) raw.add(line);
  // A file that does both answers both: each kind of call its own declaration.
  const declares = (rpc || tool) && (!rpc || EVENT_TRUST_DECLARED.test(code)) && (!tool || TOOL_TRUST_DECLARED.test(code));
  return { calls: [...calls].sort((a, b) => a - b), raw: [...raw].sort((a, b) => a - b), declares };
}

/** [text, file name, calls, raw, declares] — the shapes in the tree, and the neighbours the rule must not reach. */
const TRUST_PROBES: [string, string, number, number, boolean][] = [
  // The function, by every client in the tree: supabase-js and the shim, a helper, supabase-py, a call over lines.
  ['await supabase.rpc("upsert_thought", { p_content: c, p_payload: { metadata, event: { trust: "ingested" } } });', "x.mjs", 1, 0, true],
  ['await supabase.rpc("upsert_thought", { p_content: c, p_payload: { metadata } });', "x.ts", 1, 0, false],
  ["const r = await callRpc('upsert_thought', { p_content: c, p_payload: {} });", "x.mjs", 1, 0, false],
  ['const r = await sb.rpc(\n  "upsert_thought",\n  { p_content: c },\n);', "x.mjs", 1, 0, false],
  ['supabase.rpc(\n    "upsert_thought",\n    {"p_content": c, "p_payload": {"event": {"trust": "ingested"}}},\n).execute()', "x.py", 1, 0, true],
  // MCP: the params object, a helper call, a bare one; a declaration by shorthand.
  ['rpc(cfg, "tools/call", { name: "capture_thought", arguments: args });', "x.mjs", 1, 0, false],
  ["const result = await callMcpTool('capture_thought', { content, trust: 'operator' });", "x.ts", 1, 0, true],
  ['const cap = await tool("capture_thought", { content: "x" });', "x.ts", 1, 0, false],
  ['await client.callTool("capture_thought", { content });', "x.ts", 1, 0, false],
  ['const declared = trust ? { event: { trust } } : {};\nawait supabase.rpc("upsert_thought", { p_payload: { ...declared } });', "x.ts", 1, 0, true],
  // Raw rows: PostgREST's table path, a helper's post, check 10's insert.
  ['resp = requests.post(f"{SUPABASE_URL}/rest/v1/thoughts", headers=h, json=body)', "x.py", 0, 1, false],
  ["const res = await fetch(`${SUPABASE_URL}/rest/v1/thoughts`, { method: 'POST', body });", "x.ts", 0, 1, false],
  ['const inserted = await sb.post(\n  "thoughts",\n  { content, metadata },\n);', "x.mjs", 0, 1, false],
  ['await supabase.from("thoughts").insert({ content, embedding, metadata });', "x.ts", 0, 1, false],
  // Not the rule's: a server registering the tool, a tool list, a gate on the name, a read, an edit,
  // the function in a comment, a docstring, a log line, a regex literal, prose naming trust.
  ['server.registerTool(\n  "capture_thought",\n  { title: "Capture" },\n  handler,\n);', "x.ts", 0, 0, false],
  ['server.tool("capture_thought", "Save a thought", { content: z.string() }, async () => {});', "x.ts", 0, 0, false],
  ['const BRAIN_TOOLS = ["search_thoughts", "capture_thought"];', "x.mjs", 0, 0, false],
  ["if (name === 'capture_thought' && !session.canCapture) return deny();", "x.ts", 0, 0, false],
  ["let url = `${SUPABASE_URL}/rest/v1/thoughts?select=id,content&limit=${limit}`;", "x.ts", 0, 0, false],
  ["const res = await fetch(`${SUPABASE_URL}/rest/v1/thoughts?id=eq.${id}`, { method: 'PATCH', body });", "x.ts", 0, 0, false],
  ['// await supabase.rpc("upsert_thought", { p_content: c });\nconst n = 1;', "x.ts", 0, 0, false],
  // A Python string is read, as check 24 reads one: a docstring quoting the call is a call, answered by naming the trust.
  ['"""Store each highlight through supabase.rpc("upsert_thought", ...)."""', "x.py", 1, 0, false],
  ['throw new Error(`upsert_thought failed: ${error.message}`);', "x.ts", 0, 0, false],
  ['if (/\\brpc\\/upsert_thought\\b/.test(msg)) retry();', "x.mjs", 0, 0, false],
  ['// the trust: the key decides\nawait supabase.rpc("upsert_thought", { p_content: c });', "x.ts", 1, 0, false],
  // The first review pass: a `trust` that is not the write's — a schema key, a parameter, a positional argument, a
  // string — declares nothing; the PostgREST path, JSON-quoted params, reversed keys and Python's MCP call are calls.
  ['const schema = z.object({ trust: z.enum(["agent"]).optional() });\nawait supabase.rpc("upsert_thought", { p_payload: { metadata } });', "x.ts", 1, 0, false],
  ['function f(trust: string) { return run(a, trust, b); }\nawait supabase.rpc("upsert_thought", { p_payload: { metadata } });', "x.ts", 1, 0, false],
  ['const note = "trust: none";\nawait supabase.rpc("upsert_thought", { p_payload: {} });', "x.ts", 1, 0, false],
  ['resp = httpx.post(f"{URL}/rest/v1/rpc/upsert_thought", json={"p_content": c, "p_payload": {"event": {"trust": "ingested"}}})', "x.py", 1, 0, true],
  ["const r = await fetch(`${BASE}/rest/v1/rpc/upsert_thought`, { method: 'POST', body });", "x.ts", 1, 0, false],
  ['const body = { "jsonrpc": "2.0", "method": "tools/call", "params": { "name": "capture_thought", "arguments": a } };', "x.ts", 1, 0, false],
  ['send({ method: "tools/call", params: { arguments: args, name: "capture_thought" } });', "x.mjs", 1, 0, false],
  ['result = await session.call_tool("capture_thought", {"content": text, "trust": "ingested"})', "x.py", 1, 0, true],
  ['const args = { content, trust: "agent" };\nawait supabase.rpc("upsert_thought", { p_payload: {} });\nrpc(cfg, "tools/call", { name: "capture_thought", arguments: args });', "x.mjs", 2, 0, false],
  // A raw rewrite of the text through a helper's PATCH; a vector-only or metadata-only patch is not one.
  ["await sb.patch(`thoughts?id=eq.${id}`, { content, metadata, embedding });", "x.mjs", 0, 1, false],
  ["await sb.patch(`thoughts?id=eq.${id}`, { embedding });", "x.mjs", 0, 0, false],
];

const RAW_IMPORT = (ticket: string): CountedException["why"] =>
  `an import that POSTs its rows raw, so they carry no declared trust (073's trigger strips a payload's, and PostgREST sets no event handoff); its port onto the ingestion contract (${ticket}) writes through db/ingest-records.ts, whose rows take the ingester key's kind — classify that key \`ingested\``;
const RAW_FALLBACK = "the plain insert its upsert_thought call falls back to on a brain without the function; that call declares, the raw row cannot (SMD-2143 makes the script a REST-core client, SMD-3216)";
const RAW_OWN_DATABASE = "a deployment with a database of its own and none of the fork's migrations: no 073, so no trust to declare (check 10 counts the same insert)";
/**
 * file → why its raw captures cannot declare, and the exact count of their lines. A line past the count fails (a
 * new raw capture), a count no line reaches fails as stale (a port landed: lower it, or remove the entry), a file
 * that is gone fails until its entry goes.
 */
const TRUST_EXCEPTIONS = new Map<string, CountedException>([
  ["recipes/chatgpt-conversation-import/import-chatgpt.py", { why: RAW_IMPORT("SMD-2147"), lines: 1 }],
  ["recipes/perplexity-conversation-import/import-perplexity.py", { why: RAW_IMPORT("SMD-2148"), lines: 1 }],
  ["recipes/google-activity-import/import-google-activity.mjs", { why: RAW_IMPORT("SMD-2150"), lines: 1 }],
  ["recipes/email-history-import/pull-gmail.ts", { why: `${RAW_IMPORT("SMD-2021")}; the second line is the retry`, lines: 2 }],
  ["recipes/entity-wiki/generate-wiki.mjs", { why: "a rerun rewrites an existing dossier's text with a raw PATCH, and a failed upsert_thought call (any error, not only a missing function) falls back to a raw insert: both stamped from the key's kind, so a regenerated dossier reads as the key's and not `agent`; only the first capture's call declares (SMD-2143 moves the script onto the shim, through update_thought and upsert_thought)", lines: 2 }],
  ["recipes/wiki-synthesis/scripts/backfill-gmail-wikis.mjs", { why: RAW_FALLBACK, lines: 1 }],
  ["recipes/vercel-neon-telegram/src/lib/db.ts", { why: RAW_OWN_DATABASE, lines: 1 }],
  ["recipes/schema-aware-routing/index.ts", { why: RAW_OWN_DATABASE, lines: 1 }],
  ["extensions/test-writes.ts", { why: "the fixture check 10 counts: rows planted as an older write left them — test rows, not captures", lines: 1 }],
]);

function checkCaptureTrust() {
  for (const [probe, name, calls, raw, declares] of TRUST_PROBES) {
    const got = capturePathsIn(probe, name);
    if (got.calls.length !== calls || got.raw.length !== raw || got.declares !== declares) {
      fail(SELF, `check 26 reads its probe as ${got.calls.length} call(s), ${got.raw.length} raw, declares ${got.declares} — expected ${calls}, ${raw}, ${declares}: ${JSON.stringify(probe)} (${name}; its own probe)`);
    }
  }
  const files = textFilesUnder(CATEGORIES.map((c) => ({ dir: join(ROOT, c), rel: c }))).filter((f) => POSTGREST_CODE_FILE.test(f));
  if (files.length === 0) fail(SELF, "check 26 found no code file under the seven category directories — the listing is broken, not the tree clean");
  const MSG = "captures a thought without naming its trust — the database stamps the key's kind, a ceiling and not a description, so an importer behind an operator's key labels outside text `operator`; declare what the content is: `event: { trust: \"ingested\" }` in upsert_thought's payload (`agent` for a model's output; a server relaying a client forwards the client's word), or `trust` among capture_thought's arguments (SMD-1724)";
  const seen = new Set<string>();
  let capturePaths = 0;
  for (const file of files) {
    const rel = relOf(file);
    const { calls, raw, declares } = capturePathsIn(readFileSync(file, "utf8"), rel);
    if (calls.length) capturePaths++;
    if (calls.length && !declares) for (const line of calls) fail(`${rel}:${line}`, MSG);
    const excepted = TRUST_EXCEPTIONS.get(rel);
    if (excepted) {
      seen.add(rel);
      if (raw.length !== excepted.lines) fail(rel, `check 26's exception covers ${excepted.lines} raw capture line(s) and the file has ${raw.length} (${raw.join(", ") || "none"}) — ${raw.length > excepted.lines ? "a new raw capture beside the documented ones" : "a port landed on those lines, so the exception is stale: lower the count, or remove the entry when none remains"} (${excepted.why})`);
    } else {
      for (const line of raw) fail(`${rel}:${line}`, "writes a thought as a raw row, which cannot declare its trust — 073's trigger strips a payload's, and nothing sets the event handoff over PostgREST; capture through upsert_thought with `event: { trust }` in the payload, or list the file in TRUST_EXCEPTIONS with its line count and the reason (SMD-1724)");
    }
  }
  if (capturePaths === 0) fail(SELF, "check 26 found no capture path under the seven category directories — the detector is broken, not the tree clean");
  for (const rel of TRUST_EXCEPTIONS.keys()) if (!seen.has(rel)) fail(rel, "check 26's exception names a file the scan does not reach — stale, or the file is gone: remove the entry");
}
checkCaptureTrust();

// ── 27: retired with compose.tiers.yaml (SMD-2878) ──
//
// Check 27 held deploy/compose.tiers.yaml, three brains in one compose
// project (SMD-2294), to the stack it generated from compose.yaml. That file
// is retired: each brain is a stack of its own (SMD-2872), a canary one on its
// own port (deploy/canary.sh, SMD-2874), with the edge in front where one
// origin is wanted (SMD-2876). The number stays unused, so later checks keep
// theirs. What follows is shared by check 28 and those after it.
/** A brain's name on its mesh for its MCP server or its REST core. */
const meshName = (kind: "mcp" | "api") => `${kind}.ob1.internal`;
// A route table's parts, as Bun.YAML reads the block; check 28 builds
// compose.yaml's, compose.api-public.yaml's and compose.hooks-public.yaml's
// tables from them.
/** A router, its `middlewares:` line left out when `mw` is "" (a router with none, as /mcp and /health have had since SMD-2532 took not-legacy away). */
const routeRouter = (name: string, rule: string, priority: number, mw: string, service: string, entry = "web") =>
  `    ${name}:\n      rule: "${rule}"\n      priority: ${priority}\n      entryPoints: [${entry}]\n${mw ? `      middlewares: [${mw}]\n` : ""}      service: ${service}\n`;
/** A headers middleware setting one request header (an empty value deletes it). */
const routeHeader = (name: string, header: string, value: string) => `    ${name}:\n      headers:\n        customRequestHeaders:\n          ${header}: "${value}"\n`;
const routeErrors = (name: string, status: string) =>
  `    ${name}:\n      errors:\n        status: ["${status}"]\n        service: noop@internal\n        statusRewrites:\n          "${status}": 404\n`;
const routeService = (name: string, url: string) => `    ${name}:\n      loadBalancer:\n        servers:\n          - url: "${url}"\n`;
const routeHealth = (service: string) => routeRouter("health", "(Path(`/health`) || Path(`/health/`)) && (Method(`GET`) || Method(`HEAD`) || Method(`OPTIONS`))", 20, "", service);
/** The control, format and separator characters in a text other than the space and the line feed, each as `line (U+XXXX)` — compose and Bun.YAML part lines, comments and indentation differently around them. */
const oddCharacters = (text: string) => [...new Set([...text.matchAll(/(?![ \n])[\p{Cc}\p{Cf}\p{Z}]/gu)].map((m) => `${text.slice(0, m.index).split("\n").length} (U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`))];
/** The OpenTelemetry knobs compose.yaml's x-otel-env forwards, each the SDK's own name (SMD-1849). */
const OTEL_KEYS = ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_RESOURCE_ATTRIBUTES", "OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER", "OTEL_LOGS_EXPORTER", "OTEL_SDK_DISABLED", "OTEL_TRACES_SAMPLER", "OTEL_TRACES_SAMPLER_ARG", "OTEL_METRIC_EXPORT_INTERVAL"];
type Mapping = Record<string, unknown>;
/** A value as JSON with every object's keys sorted, so two parses compare by content, not key order. */
const canonJson = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Mapping)[k]])) : x);
const isMapping = (v: unknown): v is Mapping => !!v && typeof v === "object" && !Array.isArray(v);
const omitKeys = (o: unknown, ks: string[]) => Object.fromEntries(Object.entries(isMapping(o) ? o : {}).filter(([k]) => !ks.includes(k)));
/** Where two parsed values differ, by path: a mapping down to its keys, a multi-line string to its first differing line. */
function pathDiffs(got: unknown, want: unknown, path: string, out: string[]) {
  if (canonJson(got) === canonJson(want)) return;
  const at = path || "(the file)";
  if (isMapping(got) && isMapping(want)) {
    for (const k of [...new Set([...Object.keys(got), ...Object.keys(want)])].sort()) pathDiffs(got[k], want[k], path ? `${path}.${k}` : k, out);
  } else if (typeof got === "string" && typeof want === "string" && (got.includes("\n") || want.includes("\n"))) {
    const g = got.split("\n"), w = want.split("\n");
    const i = Math.max(0, w.findIndex((l, n) => l !== g[n]));
    out.push(`${at} line ${i + 1} reads ${JSON.stringify(g[i] ?? "(end)")} where it should read ${JSON.stringify(w[i] ?? "(end)")}`);
  } else {
    const show = (v: unknown) => v === undefined ? "nothing" : JSON.stringify(v).slice(0, 120);
    out.push(`${at} is ${show(got)} where it should be ${show(want)}`);
  }
}
// ── 40: every healthcheck probes every second until its service is up (SMD-3194) ──
/**
 * 40: every healthcheck in the stack's compose files — each service's, and each `x-` anchor's a service merges
 * in — has a start period longer than zero and probes every second within it, until it first passes. Docker's
 * start interval defaults to 5 s, and one with no start period waits its interval, so a healthcheck written
 * without them holds every `up --wait` and service_healthy wait about 5 s however soon its service is up (75
 * waits of 5.0–5.6 s a Fork Checks run before this). A disabled healthcheck (`disable: true`, or a test of
 * `NONE`) has nothing to probe and is passed over.
 */
const HEALTHCHECK_START_FILES = ["deploy/compose.yaml", "deploy/edge/compose.yaml"];
/** A compose duration (`1m30s`, `10s`, `500ms`) in milliseconds; NaN where it is not one. */
function composeDurationMs(v: unknown): number {
  const parts = typeof v === "string" ? [...v.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|us|ns)/g)] : [];
  if (!parts.length || parts.map((m) => m[0]).join("") !== v) return NaN;
  const unit: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 0.001, ns: 0.000001 };
  return parts.reduce((t, m) => t + Number(m[1]) * unit[m[2]], 0);
}
function healthcheckStartProblems(doc: unknown): string[] {
  const out: string[] = [];
  const d = isMapping(doc) ? doc : {};
  const holders: [string, unknown][] = [
    ...Object.entries(isMapping(d.services) ? d.services : {}).map(([n, v]): [string, unknown] => [`services.${n}`, v]),
    ...Object.entries(d).filter(([k]) => k.startsWith("x-")).map(([k, v]): [string, unknown] => [k, v]),
  ];
  for (const [where, m] of holders) {
    const h = isMapping(m) ? m.healthcheck : undefined;
    if (!isMapping(h) || h.disable === true || (Array.isArray(h.test) && h.test[0] === "NONE")) continue;
    const missing: string[] = [];
    if (!(composeDurationMs(h.start_period) > 0)) missing.push(h.start_period === undefined ? "a start_period (start_interval applies only within it)" : `a start_period longer than zero, not ${JSON.stringify(h.start_period)}`);
    if (h.start_interval !== "1s") missing.push(h.start_interval === undefined ? "start_interval: 1s" : `start_interval: 1s, not ${JSON.stringify(h.start_interval)}`);
    if (missing.length) out.push(`${where}.healthcheck needs ${missing.join(" and ")}`);
  }
  return out;
}
function checkHealthcheckStarts() {
  const probe = (hc: Record<string, unknown>) => healthcheckStartProblems({ services: { s: { healthcheck: { test: ["CMD", "true"], ...hc } } }, "x-a": { healthcheck: { test: ["CMD", "true"], start_period: "5s", start_interval: "1s" } } }).length;
  const cases: [Record<string, unknown>, number][] = [
    [{ start_period: "10s", start_interval: "1s" }, 0], [{ start_period: "1m30s", start_interval: "1s" }, 0],
    [{ start_period: "10s" }, 1], [{ start_interval: "1s" }, 1], [{}, 1], [{ start_period: "10s", start_interval: "5s" }, 1],
    [{ start_period: "0s", start_interval: "1s" }, 1], [{ start_period: "ten", start_interval: "1s" }, 1],
    [{ disable: true }, 0], [{ test: ["NONE"] }, 0],
  ];
  const wrong = cases.filter(([hc, n]) => probe(hc) !== n);
  if (wrong.length || healthcheckStartProblems({ "x-b": { healthcheck: { test: ["CMD", "true"] } } }).length !== 1)
    fail(SELF, `check 40 no longer reads its probe as written (${JSON.stringify(wrong.map(([hc]) => hc))}): a start period above zero and a 1 s start interval pass, a missing, zero or other one fails, in a service or an x- anchor, and a disabled healthcheck is passed over (SMD-3194)`);
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") return;
  for (const f of HEALTHCHECK_START_FILES) {
    if (!existsSync(join(ROOT, f))) continue;
    for (const p of healthcheckStartProblems(Bun.YAML.parse(readFileSync(join(ROOT, f), "utf8")))) fail(f, `${p} — Docker's first probe waits its 5 s default otherwise, and every wait on the service with it (check 40, SMD-3194)`);
  }
}
checkHealthcheckStarts();

// ── 41: the brain's code names the columns it reads from its schema, never `*` (SMD-3302) ──
/**
 * 41: a `*` — bare, `t.*` or `(x).*`, anywhere in a select list — over a function, table or view the core's or a
 * plugin's migrations define, `TABLE <it>`, or a `RETURNING *` on any table, in the brain's own code: a server, a
 * db/ verb, a plugin, the dashboard, the stack's own services under deploy/. Bun prepares the statement, and a
 * migration that adds a column to what it reads (110 added two to list_supersession_proposals; CLAUDE.md lets one
 * add a column to thoughts) changes `*`'s result type: Postgres then refuses the connection's cached plan with
 * 0A000, "cached plan must not change result type", on every call until the process restarts. Named columns
 * re-plan to the same type.
 *
 * Only the code's strings are read, as SQL: each JS string and template, a `${…}` in it an opaque value and a
 * template nested in one a string of its own. SQL comments, literals and dollar quotes are masked by one
 * left-to-right pass. Each SELECT is then read alone: its list to the FROM at its own depth (a stop word after AS
 * is a column label), PL/pgSQL's INTO targets aside; its FROM clause split into items — a join's, a LATERAL's, ROWS
 * FROM's, a parenthesised join's — each read for its leading name and alias alone (no keyword is an alias, so an
 * ON or USING condition is passed over); a subquery read in turn as its own SELECT. A qualified star reads the item
 * it names, a bare one every item; a CTE's name and a function no migration defines (unnest) pass. The rule is
 * stricter than 0A000 needs — a star whose columns never reach the result (`EXISTS (SELECT * …)`, a subquery's
 * under a named list) is read too, and so is a call Bun does not prepare (`.unsafe(text)` with no parameters):
 * name the columns anyway. Not seen: SQL built by concatenation or at run time (compat/supabase-sql's rpc, Bun's
 * `${sql(name)}`), and a row value expanded through a subquery or a column (`(SELECT t FROM thoughts t).*`,
 * `(s.r).*`); a CTE's name passes anywhere in its string, not only in its own statement. Tests and benches are
 * not read: test-store-sql's control prepares `*` to show the failure, and a bench times `SELECT *` so every
 * column is computed.
 */
const STAR_READ_DIRS = ["server-portable", "mcp-server", "dashboard", "plugins", "db", "deploy"];
type SchemaNames = { functions: ReadonlySet<string>; relations: ReadonlySet<string> };
/** A character that can open a SQL comment (`--`, `/*`), literal (`'`, `$tag$`) or quoted name: sqlMasked copies the text between them whole. */
const SQL_SPECIAL = /[-\/'"$]/g;
/** `s` with each SQL comment, string literal (plain, E'…') and dollar-quoted body blanked — a literal left as `''` — in one left-to-right pass; quoted identifiers kept. Length and newlines kept. */
function sqlMasked(s: string): string {
  const blank = (x: string) => x.replace(/[^\n]/g, " ");
  let out = "", i = 0;
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    let stop = -1, literal = false;
    if (c === "-" && d === "-") { const e = s.indexOf("\n", i); stop = e < 0 ? s.length : e; }
    else if (c === "/" && d === "*") {
      let depth = 0, j = i;
      for (; j < s.length; j++) {
        if (s[j] === "/" && s[j + 1] === "*") { depth++; j++; }
        else if (s[j] === "*" && s[j + 1] === "/") { j++; if (--depth === 0) { j++; break; } }
      }
      stop = Math.min(j, s.length);
    } else if (c === "'") {
      const escapes = /[Ee]/.test(s[i - 1] ?? "") && !/[\w$]/.test(s[i - 2] ?? "");
      let j = i + 1;
      for (; j < s.length; j++) {
        if (escapes && s[j] === "\\") { j++; continue; }
        if (s[j] === "'") { if (s[j + 1] === "'") { j++; continue; } break; }
      }
      stop = Math.min(j + 1, s.length); literal = true;
    } else if (c === '"') { const e = s.indexOf('"', i + 1); out += s.slice(i, e < 0 ? s.length : e + 1); i = e < 0 ? s.length : e + 1; continue; }
    else if (c === "$" && !/[\w$]/.test(s[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(s.slice(i, i + 64))?.[0];
      if (tag) { const e = s.indexOf(tag, i + tag.length); stop = e < 0 ? s.length : e + tag.length; literal = true; }
    }
    if (stop < 0) {
      // Up to the next character that can open a comment, literal or quote, in one copy.
      SQL_SPECIAL.lastIndex = i + 1;
      const next = SQL_SPECIAL.exec(s)?.index ?? s.length;
      out += s.slice(i, next); i = next; continue;
    }
    const body = blank(s.slice(i, stop));
    out += literal && body.length >= 2 ? "''" + body.slice(2) : body;
    i = stop;
  }
  return out;
}
/** Every function, table and view the core's and the plugins' migrations create, by bare name, lowercased — read off the masked text, so a body's CREATE (a DO block's) or a `$tag$` in a comment changes nothing. */
function schemaNamesIn(files: [string, string][]): SchemaNames {
  const functions = new Set<string>(), relations = new Set<string>();
  for (const [, text] of files) {
    const sql = sqlMasked(text);
    for (const m of sql.matchAll(/^[ \t]*CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s*\(/gim)) functions.add(m[1].toLowerCase());
    for (const m of sql.matchAll(/^[ \t]*CREATE(?:\s+OR\s+REPLACE)?(?:\s+UNLOGGED|\s+FOREIGN|\s+RECURSIVE)?\s+(?:MATERIALIZED\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gim)) relations.add(m[1].toLowerCase());
  }
  return { functions, relations };
}
/** Each JS string's and template's text in `src`, with the offset it starts at: comments and regex literals out first (blanked), a `${…}` an opaque ` $_ ` (its newlines kept), and a string or template inside one found too. */
function jsStrings(src: string): { text: string; at: number }[] {
  const t = blanked(src, false), found: { text: string; at: number }[] = [];
  const code = (from: number, inExpr: boolean): number => {
    let depth = 0, i = from;
    while (i < t.length) {
      const c = t[i];
      if (c === "'" || c === '"') {
        let j = i + 1, s = "";
        while (j < t.length && t[j] !== c && t[j] !== "\n") { if (t[j] === "\\") { s += t[j + 1] ?? ""; j += 2; continue; } s += t[j++]; }
        found.push({ text: s, at: i + 1 }); i = j + 1; continue;
      }
      if (c === "`") { i = template(i + 1); continue; }
      if (inExpr) { if (c === "{") depth++; else if (c === "}") { if (depth === 0) return i + 1; depth--; } }
      i++;
    }
    return i;
  };
  const template = (from: number): number => {
    let s = "", i = from;
    while (i < t.length && t[i] !== "`") {
      if (t[i] === "\\") { s += t[i + 1] ?? ""; i += 2; continue; }
      if (t[i] === "$" && t[i + 1] === "{") { const end = code(i + 2, true); s += " $_ " + "\n".repeat((t.slice(i, end).match(/\n/g) ?? []).length); i = end; continue; }
      s += t[i++];
    }
    found.push({ text: s, at: from });
    return i + 1;
  };
  code(0, false);
  return found;
}
const SQL_NAME = String.raw`(?:"[^"]*"|[A-Za-z_]\w*|\$_)`;
const SQL_PATH = new RegExp(String.raw`^\s*((?:${SQL_NAME}\s*\.\s*)*${SQL_NAME})`);
/** A name as Postgres compares it: unquoted folded to lower case, quoted kept. */
const sqlName = (n: string) => (n.startsWith('"') ? n.slice(1, -1) : n.toLowerCase());
/** A dotted path's last name, as sqlName compares it, and whether a schema (or more) qualifies it. */
function pathName(path: string): { name: string; qualified: boolean } {
  const parts = path.split(/\s*\.\s*/);
  return { name: sqlName(parts[parts.length - 1]), qualified: parts.length > 1 };
}
/** A call: its name, then its paren. */
const SQL_CALL = new RegExp(String.raw`(${SQL_NAME})\s*\(`, "g");
/** The index just past the paren that closes the one at `open`. */
function closeParen(m: string, open: number): number {
  let d = 0;
  for (let j = open; j < m.length; j++) { if (m[j] === "(") d++; else if (m[j] === ")" && --d === 0) return j + 1; }
  return m.length;
}
/** Where a FROM clause ends: the next clause, a set operator, or a bare SELECT (a subquery's is in parens). */
const FROM_STOPS = /^(?:WHERE|GROUP|HAVING|ORDER|LIMIT|OFFSET|UNION|INTERSECT|EXCEPT|WINDOW|FOR|RETURNING|FETCH|SELECT)$/i;
/** Where a select list with no FROM ends: the next clause or statement. */
const LIST_STOPS = /^(?:SELECT|UNION|INTERSECT|EXCEPT|WHERE|GROUP|HAVING|ORDER|LIMIT|OFFSET|WINDOW|FETCH|RETURNING)$/i;
/** Where a RETURNING list ends: the next statement or set operator. */
const RETURNING_STOPS = /^(?:SELECT|INSERT|UPDATE|DELETE|MERGE|WITH|VALUES|TABLE|UNION|INTERSECT|EXCEPT|RETURNING)$/i;
/** A list's stop word is a column label after AS (`1 AS offset`), and GROUP after WITHIN (`mode() WITHIN GROUP (…)`): neither ends it. */
const listStop = (stops: RegExp) => (w: string, before: string) => stops.test(w) && !/\bAS\s*$/i.test(before) && !(/^GROUP$/i.test(w) && /\bWITHIN\s*$/i.test(before));
const LIST_ENDS = listStop(LIST_STOPS), RETURNING_ENDS = listStop(RETURNING_STOPS);
/** Words never a FROM item's alias — what may follow one — so only an item's own name and alias are read, never its condition. */
const SQL_KEYWORDS = /^(?:WHERE|GROUP|HAVING|ORDER|LIMIT|OFFSET|UNION|INTERSECT|EXCEPT|WINDOW|FOR|RETURNING|FETCH|SELECT|ON|USING|JOIN|NATURAL|LEFT|RIGHT|FULL|INNER|OUTER|CROSS|TABLESAMPLE|LATERAL|WITH|ORDINALITY)$/i;
/** A paren that opens a subquery, tried at the paren itself (sticky), whatever whitespace or comment follows it. */
const SUBQUERY = /\(\s*(?:SELECT|WITH|VALUES)\b/iy;
/**
 * From `from` in masked SQL, the text up to `;`, a `)` closing a paren opened before `from`, or a word `stop`
 * accepts at depth 0, given the text before it (one after `.`, `"` or a word character is no word); a subquery —
 * `(` then SELECT, WITH or VALUES — becomes ` $q `, read as its own SELECT elsewhere.
 */
function sqlSpan(m: string, from: number, stop: (word: string, before: string) => boolean): { text: string; end: number; word: string } {
  let depth = 0, out = "", i = from;
  while (i < m.length) {
    const c = m[i];
    if (c === ";") break;
    if (c === "(") {
      SUBQUERY.lastIndex = i;
      if (SUBQUERY.test(m)) { out += " $q "; i = closeParen(m, i); continue; }
      depth++;
    } else if (c === ")") { if (depth === 0) break; depth--; }
    else if (depth === 0 && /[A-Za-z_]/.test(c) && !/[\w$."]/.test(m[i - 1] ?? "")) {
      const w = /^[A-Za-z_]\w*/.exec(m.slice(i, i + 64))![0];
      if (stop(w, out)) return { text: out, end: i, word: w };
      out += w; i += w.length; continue;
    }
    out += c; i++;
  }
  return { text: out, end: i, word: "" };
}
/** `list` split where `at` matches at depth 0 of parens and brackets (a word only at a word's start). */
function splitTop(list: string, at: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (let i = 0; i < list.length;) {
    const c = list[i];
    if (c === "(" || c === "[") depth++; else if (c === ")" || c === "]") depth--;
    const hit = depth === 0 && (!/[A-Za-z_]/.test(c) || !/[\w$."]/.test(list[i - 1] ?? "")) ? at.exec(list.slice(i)) : null;
    if (hit) { parts.push(cur); cur = ""; i += hit[0].length; continue; }
    cur += c; i++;
  }
  parts.push(cur);
  return parts;
}
/** A select-list item's star: `{ qual }` for `*` (null) or `q.*`, `{ expr }` for `(x).*` (redundant parens off, around the item or `x`); null for any other item. */
function starOf(item: string): { qual?: string | null; expr?: string } | null {
  let it = item.trim();
  // `(t.*)` is `t.*`: Postgres expands a star in parens too.
  if (it.startsWith("(") && closeParen(it, 0) === it.length) return starOf(it.slice(1, -1));
  if (!it.endsWith("*")) return null;
  it = it.slice(0, -1).trimEnd();
  if (it === "") return { qual: null };
  if (!it.endsWith(".")) return null;
  it = it.slice(0, -1).trimEnd();
  if (it.startsWith("(") && closeParen(it, 0) === it.length) {
    // `((t)).*` is `(t).*`, and `(t.*).*` is `t.*`.
    let e = it;
    while (e.startsWith("(") && closeParen(e, 0) === e.length) e = e.slice(1, -1).trim();
    return starOf(e) ?? { expr: e };
  }
  const path = SQL_PATH.exec(it);
  if (!path || path[0].length !== it.length) return null;
  return { qual: pathName(path[1]).name };
}
type FromItem = { name: string; fn: boolean; alias: string | null; qualified?: boolean };
/** A FROM clause's items: name, whether it is a call, alias, whether schema-qualified. Only each item's leading name and alias are read (no keyword is an alias), so its ON or USING condition is passed over; a parenthesised join is read through (its alias, if it has one, each item's); ROWS FROM's calls are each an item. */
function fromItems(clause: string): FromItem[] {
  const items: FromItem[] = [];
  for (let piece of splitTop(clause, /^(?:,|JOIN\b)/i)) {
    piece = piece.trim();
    while (/^(?:LATERAL|ONLY)\b/i.test(piece)) piece = piece.replace(/^\w+\s*/, "");
    const aliasAfter = (rest: string) => {
      const a = /^\s*(?:WITH\s+ORDINALITY\b\s*)?(?:AS\s+)?("[^"]*"|[A-Za-z_]\w*)/i.exec(rest);
      return a && !SQL_KEYWORDS.test(a[1]) ? sqlName(a[1]) : null;
    };
    const rows = /^ROWS\s+FROM\s*\(/i.exec(piece);
    if (rows) {
      const end = closeParen(piece, rows[0].length - 1), alias = aliasAfter(piece.slice(end));
      for (const f of piece.slice(rows[0].length, end - 1).matchAll(SQL_CALL)) items.push({ name: sqlName(f[1]), fn: true, alias });
      continue;
    }
    if (piece.startsWith("(")) {
      const end = closeParen(piece, 0), inner = fromItems(piece.slice(1, end - 1)), alias = aliasAfter(piece.slice(end));
      items.push(...(alias ? inner.map((it) => ({ ...it, alias })) : inner));
      continue;
    }
    const path = SQL_PATH.exec(piece);
    if (!path) continue;
    const rest = piece.slice(path[0].length), fn = /^\s*\(/.test(rest);
    items.push({ ...pathName(path[1]), fn, alias: aliasAfter(fn ? rest.slice(closeParen(rest, rest.indexOf("("))) : rest) });
  }
  return items;
}
/** What each `*` in one string of SQL reads that a migration defines, with its offset: `fn(…)`, a relation's name, or `RETURNING *`. */
function starReadsInSql(sql: string, names: SchemaNames): { what: string; at: number }[] {
  const m = sqlMasked(sql), hits: { what: string; at: number }[] = [];
  const ctes = new Set([...m.matchAll(new RegExp(String.raw`(?:\bWITH(?:\s+RECURSIVE)?|,)\s*(${SQL_NAME})\s*(?:\([^()]*\)\s*)?AS\s+(?:NOT\s+)?(?:MATERIALIZED\s+)?\(`, "gi"))].map((c) => sqlName(c[1])));
  const read = (it: FromItem, at: number) => {
    if (it.fn ? names.functions.has(it.name) : names.relations.has(it.name) && (it.qualified || !ctes.has(it.name))) hits.push({ what: it.fn ? `${it.name}(…)` : it.name, at });
  };
  for (const s of m.matchAll(/\bSELECT\b/gi)) {
    const list = sqlSpan(m, s.index! + 6, (w, before) => (/^FROM$/i.test(w) && !/\bIS\s+(?:NOT\s+)?DISTINCT\s*$/i.test(before)) || LIST_ENDS(w, before));
    // PL/pgSQL's `SELECT * INTO v FROM …`: the targets are not the list.
    const items = splitTop(splitTop(list.text, /^INTO\b/i)[0], /^,/);
    items[0] = items[0].replace(/^\s*ALL\b/i, "").replace(/^\s*DISTINCT\b\s*/i, "");
    const on = /^ON\s*\(/i.exec(items[0]);
    if (on) items[0] = items[0].slice(closeParen(items[0], on[0].length - 1));
    const stars = items.map(starOf).filter((x) => x !== null);
    if (!stars.length) continue;
    const from = /^FROM$/i.test(list.word) ? fromItems(sqlSpan(m, list.end + 4, (w) => FROM_STOPS.test(w)).text) : [];
    for (const star of stars) {
      let qual = star.qual;
      if (star.expr !== undefined) {
        for (const f of star.expr.matchAll(SQL_CALL)) read({ name: sqlName(f[1]), fn: true, alias: null }, s.index!);
        const p = SQL_PATH.exec(star.expr);
        if (!p || p[0].length !== star.expr.length) continue;
        qual = pathName(p[1]).name;
      }
      for (const it of from) if (qual === null || (it.alias ?? it.name) === qual) read(it, s.index!);
    }
  }
  for (const r of m.matchAll(/\bRETURNING\b/gi))
    if (splitTop(sqlSpan(m, r.index! + 9, RETURNING_ENDS).text, /^,/).some((it) => starOf(it) !== null)) hits.push({ what: "RETURNING *", at: r.index! });
  // TABLE x: at a statement's start, after a WITH list or a set operator, and ending as a statement or a set's arm
  // does — so prose that starts "Table jobs are…" is not one.
  for (const t of m.matchAll(new RegExp(String.raw`(?:^|[;()]|\b(?:UNION|INTERSECT|EXCEPT)(?:\s+(?:ALL|DISTINCT))?\b)\s*TABLE\s+(?:ONLY\s+)?((?:${SQL_NAME}\s*\.\s*)*${SQL_NAME})(?=\s*(?:$|[;)]|\$_|(?:ORDER|LIMIT|OFFSET|FETCH|FOR|UNION|INTERSECT|EXCEPT)\b))`, "gi"))) {
    read({ ...pathName(t[1]), fn: false, alias: null }, t.index!);
  }
  return hits;
}
/** Each `*` read in a JS/TS file's strings, with its line. */
function starReads(src: string, names: SchemaNames): { what: string; line: number }[] {
  const starts = [0];
  for (let i = src.indexOf("\n"); i >= 0; i = src.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineAt = (i: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= i) lo = mid; else hi = mid - 1; } return lo + 1; };
  return jsStrings(src).flatMap((s) => starReadsInSql(s.text, names).map((h) => ({ what: h.what, line: lineAt(s.at) + (s.text.slice(0, h.at).match(/\n/g) ?? []).length })));
}
/** The files check 41 reads: STAR_READ_DIRS' code, tests and benches aside; null when git cannot list them. */
function starReadFiles(): string[] | null {
  let names: string[];
  try {
    names = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...STAR_READ_DIRS], { cwd: ROOT, encoding: "utf8", maxBuffer: Infinity }).split("\0").filter(Boolean);
  } catch (e) {
    console.warn(`  (git ls-files failed — ${(e as Error).message.split("\n")[0]} — so check 41 is skipped)`);
    return null;
  }
  return names.filter((n) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(n) && !/(?:^|\/)(?:test|bench)-[^/]*$/.test(n) && !n.includes("/node_modules/"))
    .filter((n) => existsSync(join(ROOT, n)) && statSync(join(ROOT, n)).isFile()).sort();
}
function checkStarReads() {
  const pluginMigrations = existsSync(join(ROOT, "plugins")) ? readdirSync(join(ROOT, "plugins")).flatMap((p) => {
    const dir = join(ROOT, "plugins", p, "migrations");
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f): [string, string] => [`${p}/${f}`, readFileSync(join(dir, f), "utf8")]) : [];
  }) : [];
  const names = schemaNamesIn([...MIGRATION_TEXTS, ...pluginMigrations]);
  const q = (s: string) => "sql`" + s + "`";
  const TC = "thought_changes(…)";
  const cases: [string, string][] = [
    [q("SELECT * FROM list_supersession_proposals(${a}::text)"), "list_supersession_proposals(…)"], [q("SELECT p.* FROM thought_changes(NULL) p"), TC],
    [q("select *, 1 from list_proposal_writers(x)"), "list_proposal_writers(…)"], [q("SELECT DISTINCT * FROM public.stale_entities(i, 50)"), "stale_entities(…)"],
    [q('SELECT *\n FROM "thought_changes" /* c */ (x)'), TC], [q("SELECT 1 AS z, w.* FROM t2 p CROSS JOIN LATERAL list_proposal_writers(p.ids) w"), "list_proposal_writers(…)"],
    [q("SELECT (x).* FROM thought_changes(1) x"), TC], [q("SELECT (coalesce(thought_changes(1, 2))).*"), TC],
    [q("SELECT * FROM ROWS FROM (thought_changes(1, 2)) r"), TC], [q("SELECT ALL * FROM thought_changes(1)"), TC],
    [q("SELECT DISTINCT ON (coalesce(a, lower(b)), c) * FROM thought_changes(1)"), TC], [q("SELECT * FROM (SELECT id, t.* FROM thought_changes(1) t) s"), TC],
    [q("SELECT *-- every column\n FROM thought_changes(1)"), TC], [q("SELECT * FROM thoughts WHERE id = $1"), "thoughts"],
    [q('SELECT * FROM public."thoughts"'), "thoughts"], [q("SELECT * FROM THOUGHTS"), "thoughts"], [q("SELECT * FROM w,thoughts"), "thoughts"],
    [q("SELECT * FROM (w JOIN thoughts t ON true)"), "thoughts"], [q("SELECT t.*, p.status FROM supersession_proposals p JOIN thoughts t ON t.id = p.older_id"), "thoughts"],
    [q("SELECT public.thoughts.* FROM public.thoughts"), "thoughts"], [q('SELECT "my t".* FROM thoughts "my t"'), "thoughts"],
    [q("SELECT '(' AS x, ';' AS y, 'a FROM b', E'it\\\\'s', * FROM thoughts"), "thoughts"], [q("SELECT a IS DISTINCT FROM b AS c, * FROM thoughts"), "thoughts"],
    [q('SELECT "from", * FROM thoughts'), "thoughts"], [q("SELECT *, ${x ? sql`1` : sql`0`} AS flag FROM thoughts"), "thoughts"],
    [q("SELECT * FROM w JOIN x ON x.a = ${order} JOIN thoughts t ON true"), "thoughts"], [q("SELECT * FROM w JOIN x ON x.limit = 1 JOIN thoughts t ON true"), "thoughts"],
    ["sql.unsafe('SELECT * FROM thoughts' + where)", "thoughts"], [q("SELECT * FROM thoughts${where}"), "thoughts"], [q("SELECT * FROM ${schema}.thoughts"), "thoughts"],
    [q("SELECT * FROM notes"), "notes"], [q("SELECT * FROM ob1_rebuild_source_gate_for_types(${t}::text[])"), "ob1_rebuild_source_gate_for_types(…)"],
    [q("SELECT * FROM w UNION SELECT * FROM thoughts"), "thoughts"], [q("TABLE thoughts"), "thoughts"],
    [q("UPDATE thoughts SET content = $1 RETURNING *"), "RETURNING *"], [q("insert into x (a) values (1) returning id, x.*"), "RETURNING *"],
    ['const g = "db/migrations/*.sql"; sql`SELECT * FROM thoughts`; const h = `every extensions/*/`;', "thoughts"], ["i--; sql`SELECT * FROM thoughts`", "thoughts"],
    [q("SELECT id FROM list_supersession_proposals(x)"), ""], [q("SELECT * FROM unnest(x)"), ""], [q("WITH notes AS (SELECT 1 AS a) SELECT * FROM notes"), ""],
    [q("WITH w AS (SELECT id FROM thoughts) SELECT w.*, t.content FROM w JOIN thoughts t ON t.id = w.id"), ""],
    [q("SELECT u.*, t.content FROM unnest(${ids}::uuid[]) AS u(id) JOIN thoughts t ON t.id = u.id"), ""], [q("SELECT * FROM w JOIN x ON x.n = w.thoughts"), ""],
    [q("SELECT * FROM w JOIN x ON x.a = any(thought_changes(1))"), ""], [q("SELECT * FROM (SELECT id FROM thought_changes(x)) s"), ""],
    ["// sql`SELECT * FROM thought_changes(x)`\nconst y = 1;", ""], [q("SELECT count(*) FROM thought_changes(x)"), ""],
    [q("SELECT *, a FROM t WHERE x IN (SELECT 1 FROM thought_changes(x))"), ""], [q("SELECT extract(epoch FROM now()), * FROM w"), ""],
    [q("SELECT * FROM w WHERE thought_changes(1) IS NOT NULL"), ""], [q("SELECT * FROM w ORDER BY thoughts"), ""],
    [q("UPDATE thoughts SET a = 1 RETURNING id, a * 2"), ""], [q("SELECT * FROM w -- thoughts\n"), ""], [q("SELECT * FROM w WHERE a = 'TABLE thoughts'"), ""],
    [q('SELECT "a--b", * FROM thoughts'), "thoughts"], [q("SELECT $$ FROM ( $$ AS x, * FROM thoughts"), "thoughts"],
    ["f(`x ${y ? 'SELECT * FROM thoughts' : ''}`)", "thoughts"], [q("SELECT id FROM w ${x ? sql`SELECT * FROM thoughts` : sql``}"), "thoughts"],
    [q("SELECT * FROM w, (SELECT 1 FROM a JOIN thoughts t ON true) s"), ""], [q("SELECT * FROM w; INSERT INTO a SELECT 1 FROM b JOIN thoughts t ON true"), ""],
    [q("SELECT bacon.* FROM thoughts bacon"), "thoughts"], [q("SELECT thoughts.* FROM w JOIN thoughts ON true"), "thoughts"],
    [q("SELECT thoughts.* FROM w JOIN thoughts USING (id)"), "thoughts"], [q("SELECT thoughts.* FROM thoughts LEFT JOIN x ON true"), "thoughts"],
    [q("SELECT * FROM w ORDER BY a, thoughts"), ""], [q("SELECT * FROM w\nSELECT 1 FROM a JOIN thoughts t ON true"), ""], [q("SELECT * FROM w UNION SELECT a FROM b, thoughts"), ""],
    [q("SELECT thoughts.* FROM thoughts WHERE id = $1"), "thoughts"], [q("SELECT x.* FROM thought_changes(1) WITH ORDINALITY x"), TC],
    [q("SELECT thoughts.* FROM thoughts TABLESAMPLE SYSTEM (1)"), "thoughts"], [q("SELECT * FROM ONLY thoughts"), "thoughts"],
    [q("SELECT * FROM w EXCEPT ALL TABLE thoughts"), "thoughts"], [q("TABLE ONLY thoughts"), "thoughts"], [q("WITH c AS (SELECT 1) TABLE thoughts"), "thoughts"],
    ["log('Table thoughts are read here')", ""], [q("WITH RECURSIVE thoughts AS (SELECT 1) SELECT * FROM thoughts"), ""],
    [q("WITH thoughts AS (SELECT 1 AS id) SELECT * FROM public.thoughts"), "thoughts"], [q("SELECT /* a /* b */ c */ * FROM thoughts"), "thoughts"],
    [q("SELECT * FROM w JOIN ( -- the newest proposal per thought, read once\n SELECT 1 AS z FROM a JOIN thoughts t ON true) s ON true"), ""],
    [q("SELECT j.* FROM (w JOIN thoughts t ON true) AS j"), "thoughts"], [q("SELECT ((t)).* FROM thoughts t"), "thoughts"], [q("SELECT (t.*).* FROM thoughts t"), "thoughts"],
    ["x = 'unterminated\nsql`SELECT * FROM thoughts`", "thoughts"], ["a = 'x\nb = sql`SELECT * FROM ${'w'}, thoughts`", "thoughts"],
    [q("SELECT * FROM w; ANALYZE a, thoughts"), ""],
    [q("SELECT 1 AS offset, * FROM thoughts"), "thoughts"], [q("SELECT *, 1 AS limit FROM thoughts"), "thoughts"],
    [q("SELECT mode() WITHIN GROUP (ORDER BY content), t.* FROM thoughts t GROUP BY t.id"), "thoughts"], [q("UPDATE thoughts SET a = 1 RETURNING 1 AS values, *"), "RETURNING *"],
    [q("TABLE thoughts FOR UPDATE"), "thoughts"], [q("TABLE thoughts ${x}"), "thoughts"], [q("SELECT * FROM thought_changes(1) WHERE id IN (SELECT 1)"), TC],
    [q("SELECT 1 WHERE EXISTS (TABLE thoughts)"), "thoughts"], [q("SELECT * FROM w UNION DISTINCT TABLE thoughts"), "thoughts"], [q("TABLE thoughts UNION SELECT * FROM w"), "thoughts"],
    [q("WITH thoughts AS (SELECT 1) TABLE public.thoughts"), "thoughts"], [q("SELECT * FROM w JOIN x ON x.a = ARRAY[s.b, s.thoughts]"), ""],
    [q("SELECT (t.*) FROM thoughts t"), "thoughts"], [q("SELECT thought_changes.* FROM thought_changes(1) WITH ORDINALITY"), TC], [q("SELECT * INTO v FROM thoughts"), "thoughts"], [q("SELECT injoin.* FROM thoughts injoin"), "thoughts"],
  ];
  // The names are read off the masked text: a CREATE in a body or a comment, and a `$tag$` in a comment, change nothing.
  const synthetic = schemaNamesIn([["x.sql", "-- a $t$ in a comment\nCREATE FUNCTION a1() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nDO $d$ BEGIN CREATE TABLE b1 (x int); END $d$;\n-- CREATE TABLE c1 (x int);\nCREATE TABLE IF NOT EXISTS d1 (x int);\nCREATE OR REPLACE VIEW e1 AS SELECT 1;\nCREATE UNLOGGED TABLE g1 (x int);\nCREATE MATERIALIZED VIEW IF NOT EXISTS h1 AS SELECT 1;\n/* $u$ */ CREATE FUNCTION f1() RETURNS int LANGUAGE sql AS 'SELECT 1';\n"]]);
  const namesRead = [...synthetic.functions].sort().join() === "a1,f1" && [...synthetic.relations].sort().join() === "d1,e1,g1,h1";
  const wrong = cases.filter(([t, want]) => starReads(t, names).map((h) => h.what).join() !== want);
  const lines = [...starReads("const a = 1;\nconst b = sql`\n  SELECT id\n  FROM x;\n  SELECT * FROM thoughts`;", names), ...starReads("a\nb\nsql`SELECT * FROM thoughts`", names)].map((h) => h.line).join();
  // The walk too: it reads each kind of file the brain's code has, and leaves the tests and benches; and the store's
  // own text, its listing put back to `*`, is found.
  const files = starReadFiles();
  const want = ["server-portable/store-sql.ts", "db/consolidate.ts", "db/config.mjs", "plugins/example/index.ts", "mcp-server/index.ts", "dashboard/src/routes/proposals/+page.server.ts", "deploy/orchestration/runner.ts"];
  const walkWrong = files === null ? [] : [...want.filter((f) => !files.includes(f)), ...["server-portable/test-store-sql.ts", "db/bench-hybrid.ts"].filter((f) => files.includes(f))];
  const store = readFileSync(join(ROOT, "server-portable/store-sql.ts"), "utf8");
  const starred = store.replace(/SELECT id, status, verdict[\s\S]*?remaining\s+FROM list_supersession_proposals/, "SELECT * FROM list_supersession_proposals");
  if (wrong.length || !namesRead || lines !== "5,3" || walkWrong.length || starred === store || !starReads(starred, names).some((h) => h.what === "list_supersession_proposals(…)")
      || !names.functions.has("thought_changes") || !names.relations.has("thoughts"))
    fail(SELF, `check 41 no longer reads its probe as written (${JSON.stringify(wrong.map(([t]) => t))}${namesRead ? "" : "; the migrations' names misread"}; lines ${lines}, not 5,3; walk ${JSON.stringify(walkWrong)}${starred === store ? "; the store's listing read is no longer where the probe puts it back to `*`" : ""}): a \`*\`, \`t.*\` or \`(x).*\` anywhere in a select list over a function, table or view a migration defines — through any FROM item, qualified to it or bare — TABLE and RETURNING * fail; named columns, a CTE, an uncounted function, an ON condition, a subquery's FROM, a comment, a literal and count(*) pass; the walk reads the store, db/, plugins, mcp-server, the dashboard and deploy/ and leaves tests and benches (SMD-3302)`);
  for (const f of files ?? []) {
    for (const h of starReads(readFileSync(join(ROOT, f), "utf8"), names))
      fail(`${f}:${h.line}`, `a \`*\` over ${h.what === "RETURNING *" ? "a RETURNING" : h.what} — name the columns: a migration that adds one fails this prepared statement with 0A000 ("cached plan must not change result type") until the process restarts (check 41, SMD-3302)`);
  }
}
checkStarReads();
// ── 42: a suite's servers listen on 127.0.0.1, where they are reached (SMD-3323) ──
/**
 * 42: in every suite and smoke script (each `test-*` or `smoke*` JavaScript or TypeScript file git tracks or would
 * track — a developer's untracked one too, as checks 15 and 41 read them — the suites' support modules among them),
 * every server and child is held to 127.0.0.1, and none is dialled at `localhost` (listenSites says how each is
 * read: a Bun.serve or Bun.listen call's own `hostname`, a node-style `.listen(`'s host, an object giving a child
 * `PORT` 0 or naming `OB1_LISTEN_HOST`, each that literal, set last and with no spread after it; a `localhost:` with a
 * port interpolated or added after it, in a string or template, an `origin`/`referer` or scheme-less `host` header value
 * aside; a dial by options, `{ hostname: "localhost", port }`, is not seen, and none is in the walk).
 *
 * Listening on every address, a server can be handed, on macOS, a port another app (Tailscale, a VM's port
 * forwarder) holds on 127.0.0.1, which then answers 127.0.0.1 at that port in its place: macOS hands out port 0 from
 * one cursor every process shares, and a bind on every address skips no port held on 127.0.0.1 alone. test-rest failed
 * 7–8 runs in 300 under load from it. The mirror: a server held to 127.0.0.1 is still dialled at [::1] first by
 * `localhost`, where another process's listener on its port answers, so a suite dials 127.0.0.1. No suite sees a
 * server put back on every address (the collision is rare, and Linux has none), so this does.
 *
 * Code alone is read (blankedWithOpen, over `scan`, the scanner the checker's readers share; PR 2a): a quote in a
 * comment, a regex literal or a `//` in a string earlier on the line does not carry the reading past a call or skip
 * one, and a `hostname` nested, commented or quoted inside the call is not its own (PR 1's review pass 2 found its first
 * reading of a test-server provider ran 16,842 characters past it on an apostrophe). A file the reader cannot read
 * through is reported, never passed. LISTEN_EVERY_ADDRESS names each server or child that must listen on every
 * address, by its file and a fragment that names it and no other, with why; a fragment that names none, several, or
 * one already held is reported, as is an entry whose file the walk no longer reads (walkProblems, with the walk's
 * own floor). Its probe pins each of these. PR 1 held test-rest.ts, test-server.ts and db/test-support.ts; PR 2a
 * every suite and smoke script; PR 2b the vendored servers extensions/test-auth.ts starts, so its exception went.
 * Without git the walk cannot list them, and the check is skipped with a word, as check 41 is.
 */
/**
 * The files check 42 reads: every `test-*` or `smoke*` JavaScript or TypeScript file git tracks or would track,
 * declaration files and node_modules aside; null when git cannot list them.
 */
function listenLoopbackFiles(): string[] | null {
  let names: string[];
  try {
    names = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8", maxBuffer: Infinity }).split("\0").filter(Boolean);
  } catch (e) {
    console.warn(`  (git ls-files failed — ${(e as Error).message.split("\n")[0]} — so check 42 is skipped)`);
    return null;
  }
  return names.filter((n) => /(?:^|\/)(?:test-[^/]*|smoke[^/]*)\.(?:[cm]?[jt]s|[jt]sx)$/.test(n) && !n.endsWith(".d.ts") && !n.includes("/node_modules/"))
    .filter((n) => existsSync(join(ROOT, n)) && statSync(join(ROOT, n)).isFile()).sort();
}
const LISTEN_EVERY_ADDRESS: [file: string, fragment: string, why: string][] = [
  ["db/test-support.ts", "new Response(token)", "secondLoopback's probe: it stands for a server on every address, so a row can find an address that reaches one"],
  ["db/test-support.ts", 'OB1_LISTEN_HOST: "127.0.0.1", ...env', "serveChild's own default, which a case's env may override; each override is an object naming OB1_LISTEN_HOST, read here as a site of its own"],
  ["server-portable/test-rest.ts", "OB1_LISTEN_HOST: value", "[11b]'s refusing children: told a value that is no address, or none the host has, they exit before they serve"],
  ["server-portable/test-rest.ts", 'OB1_LISTEN_HOST: "  "', "[11b]'s blank child: on every address on purpose, asked only at the second loopback address"],
  ["server-portable/test-server.ts", "OB1_LISTEN_HOST: LISTEN_PLANTED", "the MCP server's refusing child: told a planted value, it exits before it serves"],
  ["server-portable/test-server.ts", 'OB1_LISTEN_HOST: "" }', "the MCP server's blank child: on every address on purpose, asked only at the second loopback address"],
  ["server-portable/test-support.ts", "Bun.serve({ port, hostname, fetch: () => new Response(null) })", "quietPort: a port is quiet only where both 127.0.0.1 and every address bind, so it binds each in turn and frees it (SMD-3296)"],
  ["db/test-connect.ts", "Bun.listen({ hostname: lan,", "the counted refusals' listener: on this machine's own non-loopback address, remote to the database rule and reachable, so a connection opened before the guard is seen"],
];

/**
 * Each bracket's partner in `code`, in one pass: `match[i]` for an opening or closing bracket at `i`, -1 where it
 * has none. `unpairedAt` is the first closing bracket that meets another kind's opening or none, else the first
 * opening left open, else -1.
 */
function bracketsOf(code: string): { match: Int32Array; unpairedAt: number } {
  const match = new Int32Array(code.length).fill(-1);
  const stack: number[] = [];
  const pair: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let unpairedAt = -1;
  for (let k = 0; k < code.length; k++) {
    const c = code[k];
    if (c === "(" || c === "[" || c === "{") stack.push(k);
    else if (c === ")" || c === "]" || c === "}") {
      const o = stack.pop();
      if (o === undefined || code[o] !== pair[c]) {
        if (unpairedAt < 0) unpairedAt = k;
        continue;
      }
      match[o] = k;
      match[k] = o;
    }
  }
  return { match, unpairedAt: unpairedAt >= 0 ? unpairedAt : stack.length ? stack[0] : -1 };
}

/** The parts of a bracketed list (an argument list, an object's entries) split at its own commas: [start, end) each. */
function partsOf(code: string, match: Int32Array, open: number): [number, number][] {
  const close = match[open];
  const parts: [number, number][] = [];
  let start = open + 1;
  for (let k = open + 1; k < close; k++) {
    const c = code[k];
    if ((c === "(" || c === "[" || c === "{") && match[k] > k) k = match[k];
    else if (c === ",") {
      parts.push([start, k]);
      start = k + 1;
    }
  }
  if (code.slice(start, close).trim()) parts.push([start, close]);
  return parts;
}

/** `text` between the first and last character of code in [a, b): a value's source, comments around it left out. */
function sourceOf(text: string, code: string, a: number, b: number): string {
  let s = a;
  let e = b;
  while (s < e && /\s/.test(code[s])) s++;
  while (e > s && /\s/.test(code[e - 1])) e--;
  return text.slice(s, e);
}

/** An object literal's own entries in order: each key and its value's source, or a spread. */
type Entry = { key: string; value: string } | { spread: true };
function entriesOf(text: string, code: string, match: Int32Array, open: number): Entry[] {
  if (match[open] < 0) return [];
  const entries: Entry[] = [];
  for (const [a, b] of partsOf(code, match, open)) {
    const part = code.slice(a, b);
    if (/^\s*\.\.\./.test(part)) {
      entries.push({ spread: true });
      continue;
    }
    const m = /^\s*(?:([A-Za-z_$][\w$]*)|(["'])\s*\2)\s*:/.exec(part);
    if (!m) {
      // A computed key could be any key, as a spread could; a method, getter, setter or shorthand of a name sets
      // that key to no literal.
      if (/^\s*(?:(?:get|set|async)\s+)?\*?\s*\[/.test(part)) entries.push({ spread: true });
      else {
        const named = /^\s*(?:(?:get|set|async)\s+(?=[A-Za-z_$*]))?\*?\s*([A-Za-z_$][\w$]*)/.exec(part);
        if (named) entries.push({ key: named[1], value: "" });
      }
      continue;
    }
    const quote = m[2] ? a + part.indexOf(m[2]) : -1;
    const key = m[1] ?? text.slice(quote + 1, text.indexOf(m[2], quote + 1));
    entries.push({ key, value: sourceOf(text, code, a + m[0].length, b) });
  }
  return entries;
}

/** Whether `key` is set, last, to a value `ok` takes, with no spread after it that could set it again. */
function heldBy(entries: Entry[], key: string, ok: (value: string) => boolean): boolean {
  let at = -1;
  entries.forEach((e, k) => {
    if ("key" in e && e.key === key) at = k;
  });
  if (at < 0) return false;
  const e = entries[at];
  return "key" in e && ok(e.value) && !entries.slice(at + 1).some((x) => "spread" in x);
}

const LOOPBACK_LITERAL = /^(["'`])127\.0\.0\.1\1$/;
const isLoopback = (v: string) => LOOPBACK_LITERAL.test(v);

/** One place a server or child is started, and whether it is held to 127.0.0.1. */
type ListenSite = { line: number; what: string; loopback: boolean; text: string; dial?: boolean };

/**
 * Every place in `text` a server or child is started, each with whether it is held to 127.0.0.1:
 * - a Bun.serve or Bun.listen call (`Bun.serve (`, `Bun?.serve(`, `Bun["serve"](`, `Bun.serve<T>(`): its object
 *   sets `hostname` to that literal, last and with no spread after it, or names a `unix` socket; a Bun.serve or
 *   Bun.listen named but not called (an alias this cannot follow) is a site never held, `typeof Bun.serve` aside;
 * - a node-style `.listen(`: its second argument is that literal, or its object's `host` is, or it listens on a
 *   path (a string that is not all digits);
 * - an object that gives a child `PORT` 0 or names `OB1_LISTEN_HOST`: `OB1_LISTEN_HOST` is that literal, last
 *   and with no spread after it.
 * Code alone is read (blankedWithOpen). A file it cannot read through — a template or `${` left open, or brackets that do
 * not pair by kind — is one problem of its own, never a pass.
 */
function listenSites(text: string): ListenSite[] | { line: number; why: string } {
  const starts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === "\n") starts.push(k + 1);
  const lineOf = (at: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const { out: code, openAt } = blankedWithOpen(text, true);
  const { match, unpairedAt } = bracketsOf(code);
  if (openAt >= 0) return { line: lineOf(openAt), why: "a template or ${ opened here is left open where the file ends" };
  if (unpairedAt >= 0) return { line: lineOf(unpairedAt), why: "a bracket here does not pair" };
  const sites: ListenSite[] = [];
  const objectAt = (paren: number): number => {
    for (let k = paren + 1; k < code.length; k++) if (!/\s/.test(code[k])) return code[k] === "{" ? k : -1;
    return -1;
  };
  // The dot form read on the code (`Bun/* c */.serve` is one), the bracket form on the text, its name a string.
  const named = [
    ...code.matchAll(/\bBun\s*(?:\?\.|\.)\s*(serve|listen)\b/g),
    ...[...text.matchAll(/\bBun\s*(?:\?\.\s*)?\[\s*(["'])(serve|listen)\1\s*\]/g)].filter((m) => code.slice(m.index, m.index + 3) === "Bun").map((m) => Object.assign([m[0], m[2]], { index: m.index })),
  ];
  for (const m of named) {
    const fn = m[1];
    const after = /^\s*(?:\?\.\s*)?(?:<[^()]*>\s*)?\(/.exec(code.slice(m.index + m[0].length));
    if (!after) {
      if (!/\btypeof\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) sites.push({ line: lineOf(m.index), what: `Bun.${fn} named, not called (an alias this check cannot follow)`, loopback: false, text: text.slice(m.index, m.index + m[0].length) });
      continue;
    }
    const paren = m.index + m[0].length + after[0].length - 1;
    const obj = objectAt(paren);
    const entries = obj >= 0 ? entriesOf(text, code, match, obj) : null;
    const loopback = entries !== null && (heldBy(entries, "hostname", isLoopback) || entries.some((e) => "key" in e && e.key === "unix"));
    sites.push({ line: lineOf(m.index), what: `Bun.${fn}(${entries === null ? " with no object literal" : ""}`, loopback, text: text.slice(m.index, match[paren] + 1) });
  }
  for (const m of code.matchAll(/\.\s*listen\s*\(/g)) {
    if (/\bBun\s*(\?\.)?\s*$/.test(code.slice(Math.max(0, m.index - 6), m.index))) continue;
    const paren = m.index + m[0].length - 1;
    if (match[paren] < 0) continue;
    const args = partsOf(code, match, paren);
    const first = args[0] ? sourceOf(text, code, ...args[0]) : "";
    let loopback: boolean;
    if (/^["']/.test(first)) loopback = !/^(["'])\d*\1$/.test(first); // a path; a string of digits is a port
    else if (first.startsWith("{")) {
      const entries = entriesOf(text, code, match, args[0][0] + code.slice(...args[0]).indexOf("{"));
      loopback = heldBy(entries, "host", isLoopback) || entries.some((e) => "key" in e && e.key === "path");
    } else loopback = args[1] !== undefined && isLoopback(sourceOf(text, code, ...args[1]));
    sites.push({ line: lineOf(m.index), what: ".listen(", loopback, text: text.slice(m.index, match[paren] + 1) });
  }
  for (const m of code.matchAll(/\{/g)) {
    const entries = entriesOf(text, code, match, m.index);
    const port = entries.find((e): e is { key: string; value: string } => "key" in e && e.key === "PORT");
    const givesPort0 = port !== undefined && /^(?:(["'`])0\1|0|String\(0\))$/.test(port.value);
    const namesHost = entries.some((e) => "key" in e && e.key === "OB1_LISTEN_HOST");
    if (!givesPort0 && !namesHost) continue;
    sites.push({ line: lineOf(m.index), what: givesPort0 ? 'a child given PORT "0"' : "a child given OB1_LISTEN_HOST", loopback: heldBy(entries, "OB1_LISTEN_HOST", isLoopback), text: text.slice(m.index, match[m.index] + 1) });
  }
  // A `localhost` dial of a port, in a string or template (comments blanked, strings kept): Bun dials `localhost` at
  // [::1] first, where another process's listener on the same port answers in place of a server held to 127.0.0.1
  // (PR 2a review pass 1); a suite dials its own servers at 127.0.0.1.
  // A string that is a request header's value — an `origin` or `referer` entry, or a `host` entry with no scheme, in an
  // object that is a `headers:` value or `new Headers(`'s argument — is a header a row sends, not a dial
  // (dashboard/smoke-breakglass.ts refuses a localhost Origin; PR 2a review passes 3–5). The key's span is found on
  // `code`, where comments are blanked, and must open an object entry, right after `{` or `,`, so a ternary's `:`, a
  // label or a call's argument is not one; an env's `ORIGIN` or a `cors({ origin })` is not a header.
  const withStrings = blanked(text, false);
  /** The last code character at or before `i` that is not a space. */
  const back = (i: number) => {
    while (i >= 0 && /\s/.test(code[i])) i--;
    return i;
  };
  /** The word ending at `end` in `code`, and the code character before it, with where that sits. */
  const wordBefore = (end: number) => {
    let w = end;
    while (w >= 0 && /[\w$]/.test(code[w])) w--;
    const p = back(w);
    return { word: code.slice(w + 1, end + 1), prev: code[p] ?? "", prevAt: p };
  };
  const headerKey = (m: RegExpMatchArray & { index: number }): boolean => {
    let q = m.index;
    while (q > 0 && code[q] === " ") q--; // back to the string's opening quote or backtick
    const k = back(q - 1);
    if (code[k] !== ":") return false;
    const e = back(k - 1);
    let start = e;
    let key = "";
    if (code[e] === '"' || code[e] === "'") {
      start = code.lastIndexOf(code[e], e - 1);
      if (start < 0) return false;
      key = withStrings.slice(start + 1, e);
    } else {
      while (start >= 0 && /[\w$]/.test(code[start])) start--;
      key = withStrings.slice(++start, e + 1);
    }
    const b = back(start - 1);
    if (code[b] !== "{" && code[b] !== ",") return false;
    const named = /^(?:origin|referer)$/i.test(key) || (/^host$/i.test(key) && !withStrings.slice(q, m.index).includes("://"));
    if (!named) return false;
    // The object holding the entry: its `{`, found back over the brackets the entry's siblings close; an unmatched `(`
    // or `[` on the way means the entry is in a call or an array, not that object (PR 2a review pass 6).
    let o = b;
    while (o >= 0 && code[o] !== "{") {
      if (code[o] === "(" || code[o] === "[") return false;
      o = (code[o] === ")" || code[o] === "]" || code[o] === "}") && match[o] >= 0 ? match[o] - 1 : o - 1;
    }
    if (o < 0) return false;
    const before = back(o - 1);
    if (code[before] === "(") {
      const callee = wordBefore(back(before - 1));
      return callee.word === "Headers" && wordBefore(callee.prevAt).word === "new" && callee.prev !== ".";
    }
    if (code[before] !== ":") return false;
    const key2 = wordBefore(back(before - 1));
    return key2.word === "headers" && (key2.prev === "{" || key2.prev === ",");
  };
  for (const m of withStrings.matchAll(/\blocalhost:(?:\$\{|["'`]\s*\+)/gi)) {
    if (headerKey(m as RegExpMatchArray & { index: number })) continue;
    sites.push({ line: lineOf(m.index), what: "a localhost dial of a port", loopback: false, dial: true, text: text.slice(m.index, text.indexOf("\n", m.index) < 0 ? text.length : text.indexOf("\n", m.index)) });
  }
  return sites.sort((a, b) => a.line - b.line);
}

/**
 * The problems in `text`: one where the file cannot be read through, else each site not held to 127.0.0.1 that no
 * `allowed` fragment names, and each fragment that names no site, more than one, or one already held (stale).
 */
type ListenProblem = { line: number; kind: "unread" | "site" | "dial" | "exception"; msg: string };
function listenProblems(text: string, allowed: string[] = []): ListenProblem[] {
  const sites = listenSites(text);
  if (!Array.isArray(sites)) return [{ line: sites.line, kind: "unread", msg: `check 42 cannot read the file through: ${sites.why}` }];
  const out: ListenProblem[] = [];
  const excused = new Set<ListenSite>();
  for (const fragment of allowed) {
    const named = sites.filter((s) => !s.dial && s.text.includes(fragment));
    if (named.length !== 1) out.push({ line: 0, kind: "exception", msg: `the exception \`${fragment}\` names ${named.length} sites, not one` });
    else if (named[0].loopback) out.push({ line: named[0].line, kind: "exception", msg: `the exception \`${fragment}\` names a site already held to 127.0.0.1` });
    else excused.add(named[0]);
  }
  for (const s of sites) if (!s.loopback && !excused.has(s)) out.push(s.dial ? { line: s.line, kind: "dial", msg: s.what } : { line: s.line, kind: "site", msg: `${s.what} not held to 127.0.0.1` });
  return out;
}

// PR 1's three, a suite of another directory, two smoke scripts (`smoke.ts`, `smoke-oauth.ts`) and an .mjs suite: a narrowed
// pattern drops one (PR 2a review passes 3–4).
const LISTEN_WALK_HELD = ["server-portable/test-rest.ts", "server-portable/test-server.ts", "db/test-support.ts", "mcp-server/test-mcp.ts", "dashboard/smoke.ts", "dashboard/smoke-oauth.ts", "recipes/session-capture-hook/test-session-capture.mjs"];
/**
 * What is wrong with check 42's walk itself: it must reach the suites PR 1 held and dozens beside them (51 today), or a
 * narrowed walk passes silently; and each LISTEN_EVERY_ADDRESS entry must name a file it reads (PR 2a review pass 2).
 */
function walkProblems(files: string[], exceptions: readonly (readonly [string, string, string])[] = LISTEN_EVERY_ADDRESS): string[] {
  const out: string[] = [];
  const missing = LISTEN_WALK_HELD.filter((f) => !files.includes(f));
  if (files.length < 30 || missing.length) out.push(`check 42's walk read ${files.length} suite files${files.length < 30 ? ", under 30" : ""}${missing.length ? `, missing ${JSON.stringify(missing)}` : ""}: it lists every test-* and smoke* file`);
  for (const [file, fragment] of exceptions) if (!files.includes(file)) out.push(`LISTEN_EVERY_ADDRESS names \`${fragment}\` in ${file}, which check 42's walk does not read — drop the entry`);
  return out;
}
function checkLoopbackListeners() {
  // Each case's problems, by count, or where how it reads matters (a site, not an unreadable file; the line a
  // template was left open at) by kind and line (PR 2a review pass 1).
  const cases: [string, number | string[], string[]?][] = [
    ['const s = Bun.serve({ port: 0, fetch: () => new Response("x") });', 1],
    ['const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });', 0],
    ["const s = Bun.serve({ port: 0, hostname: '127.0.0.1' });", 0],
    ['const s = Bun.serve({\n  port: 0,\n  hostname: "127.0.0.1",\n  fetch(req) { return new Response(")"); },\n});', 0],
    ['const s = Bun.serve({\n  port: 0,\n  fetch(req) { return new Response("hostname: \\"127.0.0.1\\""); },\n});', 1],
    ['const s = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch });', 1],
    ['const s = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: {}, hostname: "0.0.0.0" });', 1],
    ['const s = Bun.serve({ port: 0, tls: { hostname: "127.0.0.1" } });', 1],
    ['const s = Bun.serve({ hostname: "127.0.0.1", ...opts });', 1],
    ['const s = Bun.serve({ ...opts, hostname: "127.0.0.1" });', 0],
    ['const s = Bun.serve({ port: 0, hostname: /* why */ "127.0.0.1" // last\n});', 0],
    ['const s = Bun.serve({ unix: "/tmp/s.sock", fetch });', 0],
    ['const s = Bun?.serve({ port: 0 });', 1],
    ['const { serve } = Bun; const f = Bun.serve; f({ port: 0 });', 1],
    ['type S = ReturnType<typeof Bun.serve>;', 0],
    ['x = a++ / 2 + `/${q}`;\nconst s = Bun.serve({ port: 0 });\nconst u = `v`;', ["site@2"]],
    ['const t = `${n++ / 2}`; const s = Bun.serve({ port: 0 }); const w = b / 3;', ["site@1"]],
    ['const r = x! / 2 + `${y}`; const s = Bun.serve({ port: 0 }); const w = b / 3;', ["site@1"]],
    ['const r = a.of / 2 + `${y}`; const s = Bun.serve({ port: 0 }); const w = b / 3;', ["site@1"]],
    ['const v = a-- / 2; const s = Bun.serve({ port: 0 }); const w = b / 3;', ["site@1"]],
    ["const a = `x ${f(`\ny ${z`;", ["unread@2"]],
    ['const u = `http://localhost:${p}/v1`;', ["dial@1"]],
    ['const u = "http://localhost:" + p;', ["dial@1"]],
    ['// dial `http://localhost:${p}` here, not that', 0],
    ['const u = "http://localhost:9/v1";', 0],
    ['const u = `HTTP://LOCALHOST:${p}/v1`;', ["dial@1"]],
    ['const o = { localhost: "" + y };', 0],
    ['fetch(u, { headers: { origin: `http://localhost:${p}`, "Referer": `http://localhost:${p}/x` } });', 0],
    ['fetch(u, { headers: { accept: `http://localhost:${p}` } });', ["dial@1"]],
    ['fetch(u, { headers: { host: `localhost:${p}` } });', 0],
    ['const raw = { host: `localhost:${p}` };', ["dial@1"]],
    ['f(a, origin, `http://localhost:${p}`);', ["dial@1"]],
    ['const o = { hostUrl: `localhost:${p}` };', ["dial@1"]],
    ['fetch(u, { headers: { origin : `http://localhost:${p}` } });', 0],
    ['const a = "http://x"; fetch(u, { headers: { host: `localhost:${p}` } });', 0],
    ['spawn(cmd, { env: { ...process.env, ORIGIN: `http://localhost:${port}` } });', ["dial@1"]],
    ['const h = new Headers({ "Origin": `http://localhost:${p}` });', 0],
    ['app.use(cors({ origin: `http://localhost:${p}` }));', ["dial@1"]],
    ['fetch(`http://localhost:${p}`, { headers: { origin: `http://localhost:${p}` } });', ["dial@1"]],
    ['const h = makeHeaders({ origin: `http://localhost:${p}` });', ["dial@1"]],
    ['const o = { myheaders: { origin: `http://localhost:${p}` } };', ["dial@1"]],
    ['const o = { $headers: { origin: `http://localhost:${p}` } };', ["dial@1"]],
    ['const o = { Headers: { origin: `http://localhost:${p}` } };', ["dial@1"]],
    ['fetch(u, { headers: { a: { origin: `http://localhost:${p}` } } });', ["dial@1"]],
    ['fetch(u, { headers: { accept: x ? origin : `http://localhost:${p}` } });', ["dial@1"]],
    ['fetch(u, { headers: { x: [a, origin, `http://localhost:${p}`] } });', ["dial@1"]],
    ['fetch(u, { headers: { host: `http://localhost:${p}` } });', ["dial@1"]],
    ['fetch(u, { headers: { "x-origin-url": `http://localhost:${p}` } });', ["dial@1"]],
    ['const o = x ? headers : { origin: `http://localhost:${p}` };', ["dial@1"]],
    ['fetch(u, { headers: { a: f({ b: [1] }), origin: `http://localhost:${p}` } });', 0],
    ['const cfg = { host: `http://localhost:${p}` };', ["dial@1"]],
    ['const cfg = { apiHost: `http://localhost:${p}`, originUrl: `http://localhost:${p}` };', ["dial@1", "dial@1"]],
    ['f(origin, `http://localhost:${p}`);', ["dial@1"]],
    ['const base = process.env.ORIGIN ? process.env.ORIGIN : `http://localhost:${port}`;', ["dial@1"]],
    ['const o = { u // "origin"\n : `http://localhost:${p}` };', ["dial@2"]],
    ['const ok = !/a`b/.test(x); const s = Bun.serve({ port: 0, hostname: "127.0.0.1" });', 0],
    ['const t = `open ${x', ["unread@1"]],
    ['const a = 1;\nconst t = `open\n${x', ["unread@3"]],
    ['const t = `open\nconst s = Bun.serve({ port: 0 });', ["unread@1"]],
    ['const r = x! / 2; const s = Bun.serve({ port: 0 }); const w = b / 3;', ["site@1"]],
    ['const r = f()! / 2; const s = Bun.serve({ port: 0 }); const w = b / 3;', ["site@1"]],
    ['const r = a[0]! / 2; const s = Bun.serve({ port: 0 }); const w = b / 3;', ["site@1"]],
    ['const n = a.default! / 2; const s = Bun.serve({ port: 0 }); const w = b / 3;', ["site@1"]],
    ["export default /'/.source; const s = Bun.serve({ port: 0 });", ["site@1"]],
    ["if (a) !/'/.test(s) && f(); const s = Bun.serve({ port: 0 });", ["site@1"]],
    ["const n = a + +/'/.source.length; const s = Bun.serve({ port: 0 });", ["site@1"]],
    ['const v = a++ / 2; const s = Bun.serve({ port: 0 }); const w = b / 3;', 1],
    ['const s = Bun.serve({ port: 0, hostname: "127.0.0.1" ];', 1],
    ['server.listen("0", () => done());', 1],
    ['const ok = () => { return!/\'/.test(s); }; const s = Bun.serve({ port: 0, hostname: "127.0.0.1" });', 0],
    ['const s = Bun.serve({ hostname: "127.0.0.1", ["hostname"]: x });', 1],
    ['const s = Bun.serve({ hostname: "127.0.0.1", hostname });', 1],
    ['const s = Bun.serve({ hostname: "127.0.0.1", get hostname() { return "0.0.0.0"; } });', 1],
    ['const s = Bun.serve({ hostname: "127.0.0.1", async fetch(req) { return new Response(""); } });', 0],
    ['const s = Bun/* c */.serve({ port: 0 });', 1],
    ['const s = Bun.serve({\n  port: 0,\n  // hostname: "127.0.0.1",\n});', 1],
    ['const s = Bun.serve({ port: 0, /* hostname: "127.0.0.1", */ });', 1],
    // An apostrophe in a comment inside a bad call, a good call after it: the bad one is still read.
    ['const a = Bun.serve({\n  port: 0,\n  // the stub\'s answer (as the provider\n  fetch: () => new Response("x"),\n});\nconst b = Bun.serve({ port: 0, hostname: "127.0.0.1" });', 1],
    ['const a = Bun.serve({ port: 0, fetch: (r) => new Response(r.url.replace(/"/g, "")) });\nconst b = Bun.serve({ port: 0, hostname: "127.0.0.1" });', 1],
    ['const a = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => new Response(r.url.replace(/\\)/g, "")) });', 0],
    ['const a = Bun.serve({\n  port: 0, hostname: "127.0.0.1",\n  // see a) above\n  fetch,\n});', 0],
    ['const t = `a ${`b ${"c"}`} Bun.serve(`; const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(`${x}"`) });', 0],
    ['const u = "http://x"; const s = Bun.serve({ port: 0 });', 1],
    ["const u = `http://127.0.0.1:${p}`; const s = Bun.serve({ port: 0, fetch });", 1],
    ['const n = x / 2; const s = Bun.serve({ port: 0, hostname: "127.0.0.1" }); const m = y / 3;', 0],
    ['// the bare server prints Bun\'s own `warn: Bun.serve()` line', 0],
    ['const w = "warn: Bun.serve() closed";', 0],
    ['const s = Bun["serve"]({ port: 0 });', 1],
    ['const s = Bun.serve ({ port: 0 });', 1],
    ['const s = Bun.serve<{ id: number }>({ port: 0 });', 1],
    ['const s = Bun.serve(opts);', 1],
    ['const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {} });', 0],
    ['const l = Bun.listen({ port: 0, socket: {} });', 1],
    ['const l = Bun.listen({ unix: "/tmp/s.sock", socket: {} });', 0],
    ['server.listen(0, "127.0.0.1", () => done());', 0],
    ['server.listen(0, () => done());', 1],
    ['server.listen({ port: 0, host: "127.0.0.1" });', 0],
    ['server.listen("/tmp/s.sock");', 0],
    ['  env: { PATH: "", PORT: "0", MCP_ACCESS_KEY: KEY },', 1],
    ["  env: { PATH: '', PORT: '0' },", 1],
    ['  env: { PATH: "", "PORT": "0" },', 1],
    ['  env: { PATH: "", PORT: "0", OB1_LISTEN_HOST: "127.0.0.1" },', 0],
    ['  env: { PATH: "", PORT: "0", OB1_LISTEN_HOST: "0.0.0.0" },', 1],
    ['  env: { PATH: "", PORT: "0", OB1_LISTEN_HOST: "127.0.0.1", ...env },', 1],
    ['  env: { ...process.env, PORT: "0", OB1_LISTEN_HOST: "127.0.0.1" },', 0],
    ['  serveChild(dir, "api.ts", { KEY: "k", OB1_LISTEN_HOST: "  " });', 1],
    ['  env: { /* c */ "PORT": "0" },', 1],
    ['  env: {\n    PATH: "",\n    PORT: "0",\n    OB1_LISTEN_HOST: "127.0.0.1",\n  },', 0],
    ['  // env: { PORT: "0" }', 0],
    ['  const env = { PORT: "8000" };', 0],
    ['const s = Bun.serve({ port: 0, fetch: () => new Response(token) });', 0, ["new Response(token)"]],
    ['const s = Bun.serve({ port: 0, fetch: () => new Response(token) });\nconst t = Bun.serve({ port: 0, fetch: () => new Response(token) });', 3, ["new Response(token)"]],
    ['const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(token) });', 1, ["new Response(token)"]],
    ['const s = Bun.serve({ port: 0 });', 2, ["new Response(token)"]],
  ];
  const wrong = cases.map(([t, want, allowed]) => {
    const problems = listenProblems(t, allowed ?? []);
    const got = typeof want === "number" ? problems.length : problems.map((p) => `${p.kind}@${p.line}`);
    return { t, want, got };
  }).filter((c) => JSON.stringify(c.got) !== JSON.stringify(c.want));
  // The walk's own guards, on lists made up here.
  const many = [...LISTEN_WALK_HELD, ...Array.from({ length: 40 }, (_, i) => `x/test-${i}.ts`)];
  const walkWrong = [
    walkProblems(many, [["x/test-1.ts", "f", "why"]]).length === 0,
    /under 30/.test(walkProblems(many.slice(0, 29), []).join()),
    walkProblems(many.slice(0, 30), []).length === 0,
    /missing \["mcp-server\/test-mcp.ts"\]/.test(walkProblems(many.filter((f) => f !== "mcp-server/test-mcp.ts"), []).join()),
    /x\/gone\.ts, which check 42's walk does not read/.test(walkProblems(many, [["x/gone.ts", "f", "why"]]).join()),
  ].map((ok, i) => (ok ? -1 : i)).filter((i) => i >= 0);
  if (walkWrong.length) fail(SELF, `check 42's walk guard no longer reads its probe as written (cases ${walkWrong.join(", ")}): a full walk passes, so does one of 30, one of 29 or missing a held suite fails, an exception naming a file outside it fails (SMD-3323)`);
  if (wrong.length) fail(SELF, `check 42 no longer reads its probe as written (${JSON.stringify(wrong)}): code alone is read and an unreadable file reported, a call's own top-level hostname with no spread after it, a node listen's host, a child's OB1_LISTEN_HOST, and each exception naming one site still on every address (SMD-3323)`);
  const files = listenLoopbackFiles();
  if (files === null) return;
  for (const problem of walkProblems(files)) fail(SELF, `${problem} (SMD-3323)`);
  for (const f of files) {
    const allowed = LISTEN_EVERY_ADDRESS.filter(([file]) => file === f).map(([, fragment]) => fragment);
    for (const p of listenProblems(readFileSync(join(ROOT, f), "utf8"), allowed)) {
      const fix = {
        site: `on macOS a port picked for every address can be one another app holds on 127.0.0.1, which then answers there in its place; set hostname to the literal "127.0.0.1" (a node listen: its host; a child: OB1_LISTEN_HOST), last and with no spread after it, or list the site in LISTEN_EVERY_ADDRESS with why`,
        dial: "Bun dials `localhost` at [::1] first, where another process's listener on the port answers in place of a server held to 127.0.0.1; dial 127.0.0.1",
        exception: "make its fragment name exactly one site that is still on every address, or drop the entry",
        unread: "a site after it could not be seen; mend the code there, or teach scan the construct, with a probe case",
      }[p.kind];
      fail(p.line > 0 ? `${f}:${p.line}` : p.kind === "exception" ? SELF : f, `${p.msg} — ${fix} (check 42, SMD-3323)`);
    }
  }
}
checkLoopbackListeners();

// ── 43: a workflow gives a container a secret by name, never its value on the command line (SMD-3351) ──
/**
 * 43: in each workflow, an `-e` or `--env` flag that gives a secret-shaped variable a value with a `$` in it puts
 * what that expands to in the process's argv (docker run's, compose exec's or run's), which the runner's process
 * list shows for as long as it runs. Set the variable in the shell's environment and pass it by name, `-e NAME`.
 * A secret-shaped name has KEY, SECRET, PASSWORD, PASSWD, PW, TOKEN or CREDENTIAL (or a plural) as one of its
 * `_`-separated words, in any case. It reads any `-e` on a line, so another tool's `-e` with such a word is
 * refused too; none does today, and passing by name clears one. A literal value passes (a stand-in a step
 * declares), as do a single-quoted one, which expands nothing, and a comment line. It reads the name alone:
 * `-e ROLE_URL="$url"` passes, whatever the URL carries. It reads that flag alone: the smoke keys a curl header
 * or a `?key=` URL carries are on argv still, per-run stand-ins on a throwaway runner.
 */
const SECRET_NAME_WORD = /^(?:KEYS?|SECRETS?|PASSWORDS?|PASSWD|PW|TOKENS?|CREDENTIALS?)$/;
function secretsOnArgv(text: string): { line: number; name: string }[] {
  const out: { line: number; name: string }[] = [];
  text.split("\n").forEach((l, i) => {
    if (/^\s*#/.test(l)) return;
    for (const m of l.matchAll(/(?:^|[\s(])(?:-e|--env)(?:\s+|=)(["']?)([A-Za-z_][A-Za-z0-9_]*)=(\S*)/g)) {
      const [, quote, name, value] = m;
      if (quote === "'" || value.startsWith("'") || !value.includes("$")) continue;
      if (name.toUpperCase().split("_").some((w) => SECRET_NAME_WORD.test(w))) out.push({ line: i + 1, name });
    }
  });
  return out;
}
function checkSecretsOnArgv() {
  const cases: [string, number][] = [
    ['auth exec -T -e OB1_AUTH_OPERATOR_PASSWORD="$pw" auth bun restart-check.ts --session-cookie', 1],
    ["auth exec -T -e OB1_AUTH_OPERATOR_PASSWORD auth bun restart-check.ts --session-cookie", 0],
    ['docker run -d --entrypoint bun -e "OB1_FORWARDER_KEY=$(openssl rand -hex 32)" -e OB1_REST_URL=http://127.0.0.1:9 img', 1],
    ["OB1_FORWARDER_KEY=$(openssl rand -hex 32) docker run -d -e OB1_FORWARDER_KEY -e OB1_REST_URL=http://127.0.0.1:9 img", 0],
    ["docker run --env OB1_SMOKE_READ_KEY=${KEY} img", 1],
    ["docker run --env=API_TOKEN=$t img", 1],
    ['args=(-e "PLUGIN_PW=$p")', 1],
    ["docker run -e OB1_GUI_SECRET=${{ secrets.GUI }} img", 1],
    ['docker run -e A_KEY="$a" -e B_TOKEN="$b" img', 2],
    ['docker run -e OB1_HOOK_SECRETS="example=$s" img', 1],
    ['docker run -e api_key="$x" img', 1],
    ["docker run -e OB1_X_SECRET='$literal' img", 0],
    ['oneshot -e ROLE_URL="$good" orchestration-runner-role', 0],
    ['auth exec -T -e PUB="$pub" auth bun x', 0],
    ["docker run -e KEYBOARD=$k img", 0],
    ["docker run -e OB1_X_SECRET=ci-stand-in-0123 img", 0],
    ["docker run -e 'OB1_X_SECRET=$literal' img", 0],
    ['          # auth exec -T -e OB1_AUTH_OPERATOR_PASSWORD="$pw" auth', 0],
    ["auth exec -T auth bun -e 'const k = process.env.OB1_KEY; console.log(k)'", 0],
  ];
  const wrong = cases.map(([t, n]) => ({ t, want: n, got: secretsOnArgv(t).length })).filter((c) => c.got !== c.want);
  if (wrong.length) fail(SELF, `check 43 no longer reads its probe as written (${JSON.stringify(wrong)}): an -e or --env giving a secret-shaped name a value with a $ fails, one by name, a literal, a single-quoted value, another name and a comment pass (SMD-3351)`);
  const dir = join(ROOT, ".github", "workflows");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  if (!files.length) { fail(".github/workflows", "no workflow found — check 43 reads each one for a secret on the command line (SMD-3351)"); return; }
  for (const f of files) {
    for (const s of secretsOnArgv(readFileSync(join(dir, f), "utf8"))) {
      fail(`.github/workflows/${f}:${s.line}`, `-e ${s.name}=<a value with $> puts the secret on the docker command line, which the runner's process list shows while it runs — set ${s.name} in the step's environment (export it) and pass it by name, -e ${s.name} (check 43, SMD-3351)`);
    }
  }
}
checkSecretsOnArgv();

// ── 28: the proxy's route tables are held byte for byte, and only its backends answer it (SMD-2658, SMD-2685) ──
//
// Traefik's file provider renders a route file as a Go template (sprig
// included) before it reads the YAML, so a `{{ … }}` on a comment line in a
// table can emit any router; and a line YAML reads as a key that a reviewer
// reads as a comment, one led by a no-break space, is a router nobody
// reviewed (SMD-2294's pass 7 ran it live). This holds each table,
// compose.yaml's x-proxy-routes,
// compose.api-public.yaml's x-api-route and compose.hooks-public.yaml's
// x-hooks-route (SMD-2310): as Bun.YAML parses each file, the
// config compose mounts and the proxy label that copies it are each the table
// built here, byte for byte (the anchor itself compose ignores), and it
// carries no comment (each file's notes on its routes are YAML comments above
// the block). So a route changed on purpose is changed here too, as check
// 13's PUBLISHES is. It reads every compose file directly in deploy/, in any
// case (compose finds compose.override.yaml as Compose.Override.yaml on
// macOS), and any file there whose name is not printable ASCII (macOS folds
// U+212A onto k) (a bare pass number below is SMD-2658's review pass; SMD-2685's are named so):
//   characters  none carries a control, format or separator character but
//       the space and the line feed — compose breaks a line at U+0085, U+2028
//       and U+2029 and Bun.YAML does not, so what this check reads as a
//       comment could redefine the anchor for compose, or give an overlay a
//       `configs:` key that replaces the table (pass 1, measured);
//   tags  none carries a `!!` or named `!x!` tag handle, a verbatim `!<…>`
//       or percent-escaped tag, a `!reset` or `!override`, or a `%`
//       directive — compose decodes a `!!binary` key that Bun.YAML keeps as
//       base64 text, so an overlay hid `proxy`, `name` and `mesh` from this
//       check (pass 6, measured), and it honours !reset and !override where
//       Bun.YAML reads past them (SMD-2685); any other local tag Bun.YAML
//       reads past as compose does, and CI renders each file against
//       Bun.YAML's reading of it;
//   proxy  compose.yaml's proxy is PROXY_SERVICE, and its forwarder FORWARDER_SERVICE
//       (SMD-2583), each its label (the table's, the script's)
//       and its logging (check 29's) aside: image, user, capabilities, environment, mounts, networks,
//       search domains, waits — so a hook, a hosts entry, a volume, another
//       provider or a variable a deploy/.env could move is a change here too,
//       made on purpose (SMD-2685); an overlay that carries a table mounts
//       only that table; each file defines only its own table's config; and
//       no file is one compose reads with no -f (compose.override.yaml),
//       which CI never renders;
//   keys  each file sets only what is held for it. An overlay is an OVERLAYS
//       entry and sets only the services and keys it declares there (pass 2
//       got route files and other backends past a list of forbidden keys);
//       compose.yaml's services set only SERVICE_KEYS, which act inside the
//       service's own container — not `pid`, `ipc`, `privileged` or a hook,
//       so no sidecar reaches into the proxy's namespaces and writes a route
//       file through /proc/<pid>/root (SMD-2685, measured live) — with each
//       service's capabilities, `security_opt` and `read_only` exactly as
//       CONFINEMENT holds them, its mounts as SERVICE_MOUNTS and its build as
//       SERVICE_BUILDS (SMD-2685's review passes 1–3 each found a mount past
//       the rule as it stood: an engine's socket, a writable .git), and the
//       named volumes as
//       COMPOSE_VOLUMES; no service name but lower-case
//       letters, digits and hyphens (compose adds it on each network, so a
//       dotted one answers as a backend); no top-level key but the file's
//       (`name` in an overlay renames the networks the proxy joins, pass 4;
//       `secrets` mounts a file wherever it says; `include` reads a file this
//       check does not);
//   networks  each file defines exactly FILE_NETWORKS, and each service joins
//       exactly SERVICE_NETWORKS under the names held there (the proxy's are
//       PROXY_SERVICE's): only a backend answers to its own mesh name, and no
//       second key joins a network the first already names. Two containers
//       aliased mcp.ob1.internal, measured on the pinned Traefik: the one
//       registered first took 30 of 30 requests (SMD-2685).
// What compose makes of the files together — each -f combination equal to
// compose.yaml's alone but for what its overlays declare, its proxy loading
// exactly these tables — CI holds ("The proxy loads only the held route
// tables"), with every file there rendered against Bun.YAML's reading of it,
// so that what this check reads is what compose runs.
/** compose.yaml's route table, byte for byte, as Bun.YAML reads the block. */
const PROXY_ROUTE_TABLE = "http:\n  routers:\n"
  + routeRouter("auth", "Path(`/auth`) || PathPrefix(`/auth/`) || Path(`/.well-known/oauth-authorization-server/auth`) || Path(`/.well-known/openid-configuration/auth`) || Path(`/.well-known/oauth-authorization-server`)", 40, "auth-absent", "auth")
  + routeRouter("resource", "Path(`/.well-known/oauth-protected-resource/mcp`)", 40, "auth-absent", "mcp")
  + routeRouter("oauth-fallback-off", "Path(`/register`) || Path(`/authorize`) || Path(`/token`)", 35, "not-served", "noop@internal")
  + routeRouter("api-off", "Path(`/api`) || PathPrefix(`/api/`)", 35, "api-off", "noop@internal")
  + routeRouter("hooks-off", "Path(`/hooks`) || PathPrefix(`/hooks/`)", 35, "not-served", "noop@internal")
  + routeRouter("grafana-off", "Path(`/grafana`) || PathPrefix(`/grafana/`)", 35, "not-served", "noop@internal")
  + routeRouter("mcp", "Path(`/mcp`) || PathPrefix(`/mcp/`)", 30, "", "mcp")
  + routeRouter("dashboard", "Path(`/dashboard`) || PathPrefix(`/dashboard/`)", 30, "", "app")
  // The break-glass entrypoint's one router (SMD-3307): the GUI, marked; web strips the marker (PROXY_SERVICE's entrypoint middleware).
  + routeRouter("dashboard-breakglass", "Path(`/dashboard`) || PathPrefix(`/dashboard/`)", 30, "breakglass-listener", "app", "breakglass")
  + routeHealth("mcp")
  + "  middlewares:\n"
  + routeErrors("auth-absent", "502") + routeErrors("api-off", "418") + routeErrors("not-served", "418")
  + routeHeader("breakglass-listener", "X-OB1-Listener", "breakglass") + routeHeader("strip-listener", "X-OB1-Listener", "")
  + "  services:\n" + routeService("mcp", `http://${meshName("mcp")}.:8000`)
  + routeService("auth", "http://auth.ob1.internal.:3000")
  + routeService("app", "http://app.ob1.internal.:8000");
/** compose.api-public.yaml's route table, byte for byte, as Bun.YAML reads the block. */
const API_ROUTE_TABLE = "http:\n  routers:\n"
  + routeRouter("api-public", "Path(`/api`) || PathPrefix(`/api/`)", 36, "api-no-forwarder, api-strip", "api")
  + "  middlewares:\n    api-no-forwarder:\n      headers:\n        customRequestHeaders:\n          X-Brain-Forwarder: \"\"\n    api-strip:\n      stripPrefix:\n        prefixes: [\"/api\"]\n"
  + "  services:\n" + routeService("api", `http://${meshName("api")}.:8000`);
/** compose.hooks-public.yaml's route table (SMD-2310), byte for byte, as Bun.YAML reads the block: /hooks/ to the REST core, path kept. */
const HOOKS_ROUTE_TABLE = "http:\n  routers:\n"
  + routeRouter("hooks-public", "PathPrefix(`/hooks/`)", 36, "hooks-no-forwarder", "hooks")
  + "  middlewares:\n    hooks-no-forwarder:\n      headers:\n        customRequestHeaders:\n          X-Brain-Forwarder: \"\"\n"
  + "  services:\n" + routeService("hooks", `http://${meshName("api")}.:8000`);
/** compose.grafana-public.yaml's route table (SMD-1849 PR 3a), byte for byte, as Bun.YAML reads the block: /grafana to the observability profile's Grafana, path kept; its 502 — the profile off, the container stopped or starting — a bare 404. */
const GRAFANA_ROUTE_TABLE = "http:\n  routers:\n"
  + routeRouter("grafana-public", "Path(`/grafana`) || PathPrefix(`/grafana/`)", 36, "grafana-absent", "grafana")
  + "  middlewares:\n" + routeErrors("grafana-absent", "502")
  + "  services:\n" + routeService("grafana", "http://lgtm.ob1.internal.:3000");
/** [the file under deploy/, the config compose mounts, where the proxy mounts it, the proxy label that copies it, the table's name here, the table]. */
const ROUTE_FILES = [
  ["compose.yaml", "proxy-routes", "/etc/traefik/dynamic/routes.yaml", "ob1.proxy-routes", "PROXY_ROUTE_TABLE", PROXY_ROUTE_TABLE],
  ["compose.api-public.yaml", "proxy-api-route", "/etc/traefik/dynamic/api.yaml", "ob1.proxy-api-route", "API_ROUTE_TABLE", API_ROUTE_TABLE],
  ["compose.hooks-public.yaml", "proxy-hooks-route", "/etc/traefik/dynamic/hooks.yaml", "ob1.proxy-hooks-route", "HOOKS_ROUTE_TABLE", HOOKS_ROUTE_TABLE],
  ["compose.grafana-public.yaml", "proxy-grafana-route", "/etc/traefik/dynamic/grafana.yaml", "ob1.proxy-grafana-route", "GRAFANA_ROUTE_TABLE", GRAFANA_ROUTE_TABLE],
] as const;
/** compose.yaml's proxy as Bun.YAML reads it, its label (the table rule's) and its `logging` (check 29's, x-logging for every service) aside. */
const PROXY_SERVICE = {
  image: "docker.io/library/traefik:v3.7.13@sha256:24841fe2de7304c149343d877d2923b4c8800a38ba015dea9174c23b20e344a0",
  user: "65534:65534",
  cap_drop: ["ALL"],
  security_opt: ["no-new-privileges:true"],
  environment: {
    TRAEFIK_ENTRYPOINTS_WEB_ADDRESS: ":8000",
    TRAEFIK_ENTRYPOINTS_WEB_PROXYPROTOCOL_TRUSTEDIPS: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7",
    TRAEFIK_ENTRYPOINTS_WEB_HTTP_ALIASHEADERSSTRATEGY: "delete",
    TRAEFIK_ENTRYPOINTS_WEB_HTTP_MIDDLEWARES: "strip-listener@file",
    TRAEFIK_ENTRYPOINTS_BREAKGLASS_ADDRESS: ":8001",
    TRAEFIK_ENTRYPOINTS_BREAKGLASS_PROXYPROTOCOL_TRUSTEDIPS: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7",
    TRAEFIK_ENTRYPOINTS_BREAKGLASS_HTTP_ALIASHEADERSSTRATEGY: "delete",
    TRAEFIK_PROVIDERS_FILE_DIRECTORY: "/etc/traefik/dynamic",
    TRAEFIK_ACCESSLOG: "true",
    TRAEFIK_ACCESSLOG_FORMAT: "json",
    TRAEFIK_ACCESSLOG_FIELDS_QUERYPARAMETERS_DEFAULTMODE: "drop",
    TRAEFIK_ACCESSLOG_FIELDS_HEADERS_DEFAULTMODE: "drop",
    TRAEFIK_ACCESSLOG_FIELDS_NAMES_CLIENTUSERNAME: "drop",
    TRAEFIK_PING: "true",
    TRAEFIK_PING_ENTRYPOINT: "ping",
    TRAEFIK_ENTRYPOINTS_PING_ADDRESS: "127.0.0.1:8082",
    TRAEFIK_GLOBAL_CHECKNEWVERSION: "false",
    TRAEFIK_GLOBAL_SENDANONYMOUSUSAGE: "false",
  },
  configs: [{ source: "proxy-routes", target: "/etc/traefik/dynamic/routes.yaml" }],
  networks: { front: { aliases: ["proxy.ob1.internal"] }, mesh: {} },
  dns_search: ["."],
  healthcheck: { test: ["CMD", "traefik", "healthcheck"], interval: "5s", timeout: "3s", retries: 5, start_period: "10s", start_interval: "1s" },
  depends_on: { api: { condition: "service_started" }, mcp: { condition: "service_started" }, app: { condition: "service_started" } },
  restart: "unless-stopped",
};
/** The forwarder's script (SMD-2583), deploy/forwarder.ts: compose.yaml carries it inline as x-forwarder, in its `forwarder` config and its label, each held to this byte for byte — the file CI runs --self-check on. It holds no `$`, which compose would read as a variable from deploy/.env or the shell, so the copy compose runs is this file (review pass 1: `${X:-…}` steered the script and passed). */
const FORWARDER_SCRIPT = readFileSync(join(ROOT, "deploy", "forwarder.ts"), "utf8");
/** compose.yaml's forwarder (SMD-2583), whole but for its label (the script's, held below) and its logging (check 29's): the stack's published port, on `edge` and `front` alone, in front of the proxy, under an init so a stop ends it at once (SMD-3193). */
const FORWARDER_SERVICE = {
  image: "docker.io/oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373",
  user: "65534:65534",
  cap_drop: ["ALL"],
  security_opt: ["no-new-privileges:true"],
  command: ["bun", "/forwarder.ts"],
  init: true,
  configs: [{ source: "forwarder", target: "/forwarder.ts" }],
  ports: ["${SERVER_BIND:-127.0.0.1}:${SERVER_PORT:-8000}:8000"],
  networks: ["edge", "front"],
  dns_search: ["."],
  healthcheck: { test: ["CMD-SHELL", "grep -qE ':1F40 0+:0000 0A' /proc/net/tcp /proc/net/tcp6"], interval: "5s", timeout: "3s", retries: 5, start_period: "10s", start_interval: "1s" },
  depends_on: { proxy: { condition: "service_started" } },
  restart: "unless-stopped",
};
/**
 * compose.yaml's break-glass listener (SMD-3307; ADR decision 15), whole but for its label (the script's, held as the
 * forwarder's) and its logging: the forwarder's script and confinement on `--port 8001`, the proxy's `breakglass`
 * entrypoint, which routes the GUI alone and marks it; under the auth profile alone, published on a literal
 * 127.0.0.1 (check 13's LOOPBACK_MAPPINGS), on `edge` and `front` alone. A key sign-in reaches the GUI through it
 * while the stack is configured, so a change to it is made here too, on purpose.
 */
const BREAKGLASS_SERVICE = {
  ...FORWARDER_SERVICE,
  profiles: ["auth"],
  command: ["bun", "/forwarder.ts", "--port", "8001"],
  ports: ["127.0.0.1:${BREAKGLASS_PORT:-8001}:8001"],
  healthcheck: { ...FORWARDER_SERVICE.healthcheck, test: ["CMD-SHELL", "grep -qE ':1F41 0+:0000 0A' /proc/net/tcp /proc/net/tcp6"] },
};
/** Where lgtm's Grafana finds the provisioned dashboard (SMD-1849 PR 3c): the file its provider reads, mounted from the grafana-dashboard config and its home page; and where the provider is mounted, Grafana's provisioning directory's dashboards/, every file of which it reads as a provider. Check 37's DASHBOARD_PROVIDER names the first. */
const DASHBOARD_PATH = "/otel-lgtm/open-brain-dashboard.json";
const DASHBOARD_PROVIDER_PATH = "/otel-lgtm/grafana/conf/provisioning/dashboards/open-brain.yaml";
/** Where lgtm's Grafana finds the provisioned alert rules (SMD-3050), mounted from the grafana-alert-rules config: its provisioning directory's alerting/, every file of which it reads for rules (and contact points, policies and templates, which check 38 refuses there). */
const ALERT_RULES_PATH = "/otel-lgtm/grafana/conf/provisioning/alerting/open-brain.yaml";
/**
 * compose.yaml's `mcp`, the MCP server built on the REST core (SMD-2287), whole, its logging aside: the knobs it holds
 * are its environment, listed — none of the server's secrets (no database URL, key list, provider key, plugin or
 * webhook secret), and only what mcp-server/index.ts reads — its entrypoint keeps auto-install off, its healthcheck is
 * the only one podman keeps (an OCI image drops HEALTHCHECK), and it waits on the REST core. A change to it is made here
 * too, on purpose (review pass 1 of PR 5b: a denylist in CI let a superuser password or a new name's secret through).
 */
const MCP_SERVICE = {
  image: "${COMPOSE_PROJECT_NAME:-open-brain}-server",
  pull_policy: "never",
  entrypoint: ["bun", "--no-install"],
  command: ["../mcp-server/index.ts"],
  environment: {
    ...Object.fromEntries(OTEL_KEYS.map((k) => [k, `\${${k}:-}`])),
    OB1_FORWARDER_KEY: "${OB1_FORWARDER_KEY:?set OB1_FORWARDER_KEY in the stack's env file — the MCP server's forward-scope key, minted with bun server-portable/keygen.ts --name mcp-forwarder --scope forward (a release install runs keygen.ts in the release's server image), its line in MCP_ACCESS_KEYS}",
    OB1_PLUGINS: "${OB1_PLUGINS:-}",
    OB1_PUBLIC_ORIGIN: "${OB1_PUBLIC_ORIGIN:-}",
    COMPOSE_PROFILES: "${COMPOSE_PROFILES:-}",
    OB1_AUTH_SECRET_MCP: "${OB1_AUTH_SECRET_MCP:-}",
    OB1_STOP_GRACE: "${OB1_STOP_GRACE:-}",
  },
  stop_grace_period: "${OB1_STOP_GRACE:-10}s",
  depends_on: { api: { condition: "service_started" } },
  restart: "unless-stopped",
  networks: { mesh: { aliases: ["mcp.ob1.internal"] } },
  healthcheck: { test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:$${PORT:-8000}/health >/dev/null || exit 1"], interval: "30s", timeout: "3s", start_period: "10s", start_interval: "1s", retries: 3 },
};
/**
 * compose.yaml's `app`, the operator GUI (SMD-2280), whole, its logging aside: the server's image run as
 * `bun ../dashboard/serve.ts` with auto-install off, holding no brain key — only the origin, the break-glass port
 * and the configured switch its sign-in reads (COMPOSE_PROFILES naming auth turns key sign-in off but on the
 * break-glass port, ADR decision 16, so dropping or pinning it would reopen that door), and the authorization
 * server's secret for its `gui` client, the one secret it holds, which signs the operator in through the AS while
 * the stack is configured (SMD-3307) — on the mesh alone, its files read-only and no capability, its health on its
 * own path, and its wait on the REST core. A change to it is made here too, on purpose (review pass 1:
 * a key list, a forwarder key, `user: root`, another image and COMPOSE_PROFILES dropped each passed the per-key rules).
 */
const APP_SERVICE = {
  image: "${COMPOSE_PROJECT_NAME:-open-brain}-server",
  pull_policy: "never",
  entrypoint: ["bun", "--no-install"],
  command: ["../dashboard/serve.ts"],
  environment: {
    OB1_PUBLIC_ORIGIN: "${OB1_PUBLIC_ORIGIN:-}",
    COMPOSE_PROFILES: "${COMPOSE_PROFILES:-}",
    OB1_STOP_GRACE: "${OB1_STOP_GRACE:-}",
    OB1_AUTH_SECRET_GUI: "${OB1_AUTH_SECRET_GUI:-}",
    BREAKGLASS_PORT: "${BREAKGLASS_PORT:-8001}",
  },
  stop_grace_period: "${OB1_STOP_GRACE:-10}s",
  depends_on: { api: { condition: "service_started" } },
  restart: "unless-stopped",
  networks: { mesh: { aliases: ["app.ob1.internal"] } },
  read_only: true,
  tmpfs: ["/tmp"],
  cap_drop: ["ALL"],
  security_opt: ["no-new-privileges:true"],
  healthcheck: { test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:8000/dashboard/health >/dev/null || exit 1"], interval: "30s", timeout: "3s", start_period: "10s", start_interval: "1s", retries: 3 },
};
/**
 * compose.yaml's observability collector (SMD-1849 PR 3a) as Bun.YAML reads it, its `logging` (check 29's) and its labels (check 37's,
 * PR 3c) aside: the image by its digest,
 * Grafana's anonymous access off, the refusal of an empty or default admin password (30 s before it exits), the backends on the
 * container's loopback, every call out off, Loki's retention, the mesh and (PR 3b) telemetry. Its environment holds telemetry's sign-in and
 * exposure; a change to it is made here too, on purpose (review pass 1).
 */
const LGTM_SERVICE = {
  image: "docker.io/grafana/otel-lgtm:0.36.0@sha256:57c04cbd8e7022f32bb84c4ac005d79baf8b08e2c5be44facf11f5f1f9944ba2",
  profiles: ["observability"],
  init: true,
  cap_drop: ["ALL"],
  security_opt: ["no-new-privileges:true"],
  command: ["bash", "-c", [
    "LC_ALL=C.UTF-8\n",
    "pw=$$(printf '%s' \"$$GF_SECURITY_ADMIN_PASSWORD\" | tr -d '[:space:]')\n",
    "if [ \"$$(printf '%s' \"$$pw\" | tr '[:upper:]' '[:lower:]')\" = admin ] || [ \"$${#pw}\" -lt 12 ]; then\n",
    "  echo \"lgtm: set GRAFANA_ADMIN_PASSWORD in deploy/.env, 12 characters or more and not admin: Grafana signs its operator in with it\" >&2; sleep 30; exit 1\n",
    "fi\n",
    "origin=$${LGTM_ORIGIN%/}\n",
    "export GF_SERVER_ROOT_URL=\"$$origin/grafana/\"\n",
    "case \"$$(printf '%s' \"$$origin\" | tr '[:upper:]' '[:lower:]')\" in https://*) export GF_SECURITY_COOKIE_SECURE=true ;; esac\n",
    "sed 's/^server:$$/server:\\n  http_listen_address: 127.0.0.1\\n  grpc_listen_address: 127.0.0.1/' /otel-lgtm/tempo-config.yaml > /tmp/tempo-config.yaml\n",
    "if [ \"$$(grep -c 'listen_address:' /tmp/tempo-config.yaml)\" != 2 ] || ! grep -qx '  grpc_listen_address: 127.0.0.1' /tmp/tempo-config.yaml; then\n",
    "  echo \"lgtm: the image's tempo-config.yaml is not the one this was written for (a server: block setting no address): Tempo would not be on loopback alone\" >&2; sleep 30; exit 1\n",
    "fi\n",
    "exec /otel-lgtm/run-all.sh\n",
  ].join("")],
  environment: {
    GF_SECURITY_ADMIN_PASSWORD: "${GRAFANA_ADMIN_PASSWORD:-}",
    GF_AUTH_ANONYMOUS_ENABLED: "false",
    LGTM_ORIGIN: "${OB1_PUBLIC_ORIGIN:-http://127.0.0.1:${SERVER_PORT:-8000}}",
    GF_SERVER_SERVE_FROM_SUB_PATH: "true",
    GF_SECURITY_CONTENT_SECURITY_POLICY: "true",
    GF_SECURITY_DATA_SOURCE_PROXY_WHITELIST: "127.0.0.1:9090 127.0.0.1:3100 127.0.0.1:3200 127.0.0.1:4040",
    GF_SECURITY_DISABLE_GRAVATAR: "true",
    GF_SNAPSHOTS_ENABLED: "false",
    GF_SNAPSHOTS_EXTERNAL_ENABLED: "false",
    GF_PUBLIC_DASHBOARDS_ENABLED: "false",
    GF_METRICS_ENABLED: "false",
    GF_NEWS_NEWS_FEED_ENABLED: "false",
    GF_PLUGINS_PREINSTALL_DISABLED: "true",
    GF_PLUGINS_PUBLIC_KEY_RETRIEVAL_DISABLED: "true",
    GF_PLUGINS_PLUGIN_ADMIN_ENABLED: "false",
    GF_ANALYTICS_REPORTING_ENABLED: "false",
    GF_ANALYTICS_CHECK_FOR_UPDATES: "false",
    GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: "false",
    GF_CLOUD_MIGRATION_ENABLED: "false",
    GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH: DASHBOARD_PATH,
    PROMETHEUS_EXTRA_ARGS: "--web.listen-address=127.0.0.1:9090 --enable-feature=created-timestamp-zero-ingestion",
    LOKI_EXTRA_ARGS: "-server.http-listen-address=127.0.0.1 -server.grpc-listen-address=127.0.0.1 -reporting.enabled=false -compactor.retention-enabled=true -compactor.delete-request-store=filesystem -store.retention=336h",
    TEMPO_EXTRA_ARGS: "-config.file=/tmp/tempo-config.yaml -reporting.enabled=false",
    PYROSCOPE_EXTRA_ARGS: "-server.http-listen-address=127.0.0.1 -server.grpc-listen-address=127.0.0.1 -memberlist.bind-addr=127.0.0.1 -usage-stats.enabled=false",
    // The collector's scrape of pg-exporter on `telemetry` (SMD-1849 PR 3b), one argument with no space in it.
    OTELCOL_EXTRA_ARGS: "--config=yaml:{\"receivers\":{\"prometheus/postgres\":{\"config\":{\"scrape_configs\":[{\"job_name\":\"postgres\",\"scrape_interval\":\"30s\",\"metrics_path\":\"/cgi-bin/metrics\",\"static_configs\":[{\"targets\":[\"pg-exporter.ob1.internal.:9187\"]}]}]}}},\"service\":{\"pipelines\":{\"metrics\":{\"receivers\":[\"otlp\",\"prometheus/collector\",\"prometheus/postgres\"]}}}}",
  },
  volumes: ["lgtm-data:/data"],
  // The provisioned dashboard and its provider (PR 3c), check 37's, and the alert rules (SMD-3050), check 38's.
  configs: [{ source: "grafana-dashboard", target: DASHBOARD_PATH }, { source: "grafana-dashboard-provider", target: DASHBOARD_PROVIDER_PATH }, { source: "grafana-alert-rules", target: ALERT_RULES_PATH }],
  networks: { mesh: { aliases: ["lgtm.ob1.internal"] }, telemetry: {} },
  healthcheck: { test: ["CMD", "bash", "-c", "test -f /tmp/ready && for u in 3000/api/health 3100/ready 9090/api/v1/status/runtimeinfo 3200/ready 4040/ready 13133/ready; do curl -fsS -o /dev/null -m 1 http://127.0.0.1:$${u} || exit 1; done"], interval: "10s", timeout: "8s", retries: 3, start_period: "300s", start_interval: "1s" },
  restart: "unless-stopped",
};
/**
 * compose.yaml's Postgres exporter and the step that makes its role (SMD-1849 PR 3b), whole as Bun.YAML reads them, their `logging`
 * (check 29's) aside: the image by its digest, the role it reads as (ob1_monitor, a member of pg_monitor alone, never a superuser),
 * which statements it names and how much of their text, and its own queries left out. The exporter on loopback behind busybox httpd on its `telemetry`
 * address alone, serving the one CGI that fetches its /metrics (SMD-3023): its /probe dials any target and credentials its caller names. Held whole because what CI's one run of the profile
 * reads is the series (PR 3c), not how they are made: a superuser's DSN, an image by tag or a dropped --member-of passed every other
 * check (review pass 1).
 */
const PG_EXPORTER_SERVICE = {
  image: "quay.io/prometheuscommunity/postgres-exporter:v0.20.1@sha256:ac5ec343104fae0e2d84a27bb8d69b38430a11910c5382cad85d478d2bab713e",
  profiles: ["observability"],
  read_only: true,
  tmpfs: ["/tmp", "/var/www:exec,mode=1777"],
  cap_drop: ["ALL"],
  security_opt: ["no-new-privileges:true"],
  init: true,
  entrypoint: ["/bin/sh", "-c", [
    "addr=\n",
    "for _ in 1 2 3 4 5 6 7 8 9 10; do\n",
    "  addr=$$(nslookup pg-exporter.ob1.internal. 2> /dev/null | awk '/^Name:/ { n = 1 } n && /^Address:? *[0-9.]+$$/ { print $$NF; exit }')\n",
    "  [ -n \"$$addr\" ] && break\n",
    "  sleep 1\n",
    "done\n",
    "if [ -z \"$$addr\" ]; then\n",
    "  echo \"pg-exporter: pg-exporter.ob1.internal resolves to no address, and the exporter's front listens on that one alone: compose.yaml gives this container that name on telemetry\" >&2; sleep 30; exit 1\n",
    "fi\n",
    "if ! { mkdir -p /var/www/cgi-bin && cat > /var/www/cgi-bin/metrics && chmod 555 /var/www/cgi-bin/metrics; } << 'CGI'\n",
    "#!/bin/sh\n",
    "if f=$$(mktemp) && wget -q -T 10 -O \"$$f\" http://127.0.0.1:9188/metrics; then\n",
    "  printf 'Content-Type: text/plain; version=0.0.4; charset=utf-8\\r\\n\\r\\n'; cat \"$$f\"\n",
    "else\n",
    "  printf 'HTTP/1.1 502 Bad Gateway\\r\\nContent-Type: text/plain\\r\\n\\r\\nno answer from the exporter, or no room in /tmp for it\\n'\n",
    "fi\n",
    "rm -f \"$$f\"\n",
    "CGI\n",
    "then\n",
    "  echo \"pg-exporter: could not write its CGI to /var/www, the tmpfs compose.yaml gives it: the collector would scrape nothing\" >&2; sleep 30; exit 1\n",
    "fi\n",
    "/bin/postgres_exporter --web.listen-address=127.0.0.1:9188 \"$$@\" &\n",
    "e=$$!\n",
    "env -i PATH=/bin httpd -f -p \"$$addr:9187\" -h /var/www &\n",
    "h=$$!\n",
    "while kill -0 \"$$e\" 2> /dev/null && kill -0 \"$$h\" 2> /dev/null; do sleep 5; done\n",
    "echo \"pg-exporter: the exporter or its front (httpd) stopped, its own line above saying why if it left one; the container exits in 30 s and restarts\" >&2; sleep 30; exit 1\n",
  ].join(""), "pg-exporter"],
  command: [
    "--collector.stat_statements",
    "--collector.stat_statements.include_query",
    "--collector.stat_statements.query_length=120",
    "--collector.stat_statements.limit=100",
    "--collector.stat_statements.exclude_users=ob1_monitor",
  ],
  environment: { DATA_SOURCE_URI: "postgres:5432/openbrain?sslmode=disable", DATA_SOURCE_USER: "ob1_monitor", DATA_SOURCE_PASS: "${OB1_MONITOR_DB_PASSWORD:-}" },
  depends_on: { "pg-monitor-role": { condition: "service_completed_successfully" } },
  networks: { data: {}, telemetry: { aliases: ["pg-exporter.ob1.internal"] } },
  healthcheck: { test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:9188/"], interval: "30s", timeout: "5s", retries: 3, start_period: "30s", start_interval: "1s" },
  restart: "unless-stopped",
};
const PG_MONITOR_ROLE_SERVICE = {
  image: "${COMPOSE_PROJECT_NAME:-open-brain}-migrate",
  pull_policy: "never",
  profiles: ["observability"],
  environment: { DATABASE_URL: "postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/openbrain", OB1_MONITOR_DB_PASSWORD: "${OB1_MONITOR_DB_PASSWORD:-}" },
  command: ["bun", "login-role.ts", "--role", "ob1_monitor", "--password-env", "OB1_MONITOR_DB_PASSWORD", "--member-of", "pg_monitor"],
  depends_on: { postgres: { condition: "service_healthy" }, migrate: { condition: "service_completed_successfully" } },
  restart: "no",
  networks: ["data"],
};
/** compose.grafana-port.yaml's environment on lgtm, by value: Grafana's origin, its loopback port unless GRAFANA_ORIGIN names one, and nothing else — any other key there is Grafana's configuration, its anonymous access included (SMD-1849 PR 3a review passes 3, 6). */
const GRAFANA_PORT_LGTM_ENV = { LGTM_ORIGIN: "${GRAFANA_ORIGIN:-http://127.0.0.1:${GRAFANA_PORT:-3000}}" };
/** The operator GUI's link to Grafana (SMD-2280), by the overlay that reaches it, by value: the one key each sets on `app`. */
const GRAFANA_APP_ENV: Record<string, Mapping> = {
  "compose.grafana-public.yaml": { GRAFANA_ROUTE: "/grafana/" },
  "compose.grafana-port.yaml": { GRAFANA_LINK: "${GRAFANA_ORIGIN:-http://127.0.0.1:${GRAFANA_PORT:-3000}}/grafana/" },
};
/** Each overlay, by file: the keys it sets on each service it names (an overlay that carries a table sets only its mount, label and wait on the proxy), and its top-level keys beside `services` (x-* anchors aside). CI's "The proxy loads only the held route tables" holds the same of each combination, in its `declared` paths. */
const OVERLAYS: Record<string, { services: Record<string, string[]>; top: string[] }> = {
  // The proxy: its table's mount, its label and its wait.
  "compose.api-public.yaml": { services: { proxy: ["configs", "labels", "depends_on"] }, top: ["configs"] },
  "compose.hooks-public.yaml": { services: { proxy: ["configs", "labels", "depends_on"] }, top: ["configs"] },
  // No wait: the proxy starts with the profile off, and its 502 is a 404 (SMD-1849 PR 3a).
  "compose.grafana-public.yaml": { services: { proxy: ["configs", "labels"], app: ["environment"] }, top: ["configs"] },
  // Postgres's port, and the outward network it is published on (SMD-2583); Grafana's, the same way (SMD-1849 PR 3a).
  "compose.host-ports.yaml": { services: { postgres: ["networks", "ports"], ollama: ["ports"], jev: ["ports"] }, top: ["networks"] },
  // Grafana's loopback port: its network, its port and its origin, held by value (GRAFANA_PORT_LGTM_ENV).
  "compose.grafana-port.yaml": { services: { lgtm: ["networks", "ports", "environment"], app: ["environment"] }, top: ["networks"] },
};
/** compose.yaml's top-level keys, x-* anchors aside. */
const COMPOSE_TOP = ["name", "services", "networks", "volumes", "configs"];
/** compose.yaml's configs beside its route table: the forwarder's script (SMD-2583), the observability profile's dashboard and its provider (SMD-1849 PR 3c, check 37's) and its alert rules (SMD-3050, check 38's), each its content alone; where each lands is SERVICE_CONFIGS'. */
const BASE_CONFIGS = ["forwarder", "grafana-dashboard", "grafana-dashboard-provider", "grafana-alert-rules"];
/** The keys a compose.yaml service sets that act inside its own container: none shares another's namespaces (`pid`, `ipc`, `network_mode`, `volumes_from`), lifts its confinement (`privileged`, `devices`, `userns_mode`), runs a hook (`post_start`, which may be privileged), names it on a network (`container_name`, `hostname`), or reads a host file (`env_file`). The confinement keys are CONFINEMENT's, and `build`, `volumes` and `configs` SERVICE_BUILDS', SERVICE_MOUNTS' and SERVICE_CONFIGS', by value (a build's `network`, `privileged`, `entitlements`, `secrets` or `additional_contexts` act on the host's builder); `networks` is the networks rule's; `ports` is check 13's. A key added here is added on purpose: `x-env` is an extension compose ignores, under which compose.yaml's REST core anchors its block so it alone adds the plugin knobs no worker takes (SMD-2310). */
const SERVICE_KEYS = ["build", "image", "pull_policy", "profiles", "command", "entrypoint", "working_dir", "user", "environment", "labels", "depends_on", "healthcheck", "restart", "stop_grace_period", "stop_signal", "init", "tmpfs", "shm_size", "mem_limit", "pids_limit", "ulimits", "logging", "expose", "extra_hosts", "cap_drop", "cap_add", "security_opt", "read_only", "volumes", "configs", "networks", "ports", "x-env"];
/** Each compose.yaml service's confinement — its `cap_add`, `cap_drop`, `security_opt` and `read_only` — exactly; a service not named here sets none of them. A capability added, or a drop or no-new-privileges removed, is a change here, on purpose. The proxy's are PROXY_SERVICE's. */
const CONFINEMENT: Record<string, Mapping> = {
  "orchestration-runner": { cap_drop: ["ALL"], cap_add: ["SETUID", "SETGID", "KILL", "NET_ADMIN", "SETPCAP"], security_opt: ["no-new-privileges:true"] },
  // The coordinator (SMD-3476): root only to run each pass as its own user — to become it, signal it, and hand it its HOME and the dump volume.
  coordinator: { cap_drop: ["ALL"], cap_add: ["CHOWN", "SETUID", "SETGID", "KILL"], security_opt: ["no-new-privileges:true"] },
  auth: { read_only: true, cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"] },
  // The operator GUI (SMD-2280): the first service a browser reaches, so the image's files read-only and no capability.
  app: { read_only: true, cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"] },
  lgtm: { cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"] },
  "pg-exporter": { read_only: true, cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"] },
};
const CONFINEMENT_KEYS = ["cap_add", "cap_drop", "security_opt", "read_only"];
/** compose.yaml's named volumes (each the engine's default: driver options bind a host path), each service's mounts and each service's build, exactly; a service not named here mounts or builds nothing. A mount or a build added or changed — a path, a mode, another service's volume, a context — is a change here, on purpose. SMD-2685's review passes 1–3 each found a mount past the rule for which mounts are safe as it then stood (a variable's default joined to a path, a variable the host sets, `ro,rw`, a volume named `..`, `../deploy`, `.GIT` on macOS), so the list is held instead. The coordinator's `sleep-dumps` is a named volume of the engine's own, written only when OB1_SLEEP_DUMP_DIR hands the scheduler --dump-dir (SMD-3203). */
const COMPOSE_VOLUMES: Mapping = { pgdata: null, ollama: null, "jev-models": null, "n8n-data": null, "auth-data": null, "lgtm-data": null, "sleep-dumps": null };
const SERVICE_MOUNTS: Record<string, unknown[]> = {
  postgres: ["pgdata:/var/lib/postgresql/data"],
  // The coordinator runs the server image (SMD-3476): the dump volume alone, no checkout.
  coordinator: ["sleep-dumps:/var/lib/ob1/sleep-dumps"],
  ollama: ["ollama:/root/.ollama"],
  jev: ["jev-models:/models"],
  n8n: ["n8n-data:/home/node/.n8n"],
  "orchestration-runner": [{ type: "bind", source: "${IMPORTS_DIR:-./imports}", target: "/imports", read_only: true, bind: { selinux: "z" } }, "./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z"],
  auth: ["auth-data:/data"],
  lgtm: ["lgtm-data:/data"],
};
/** Each compose.yaml service's `configs:`, exactly, beside the proxy's and the forwarder's (held whole): lgtm's dashboard and provider (SMD-1849 PR 3c) and alert rules (SMD-3050); a service not named here mounts none. A config's content is fixed (BASE_CONFIGS, check 37), but where it lands — a path, a mode, an owner — is a mount, so it is held as SERVICE_MOUNTS holds those (review pass 1: a runner mounting the forwarder's script over an init path passed). */
const SERVICE_CONFIGS: Record<string, unknown[]> = {
  lgtm: LGTM_SERVICE.configs,
};
const SERVICE_BUILDS: Record<string, unknown> = {
  migrate: { context: "..", dockerfile: "db/Dockerfile" },
  api: { context: "..", dockerfile: "server-portable/Dockerfile", args: { OB1_GIT_SHA: "${OB1_GIT_SHA:-unknown}" } },
  jev: { context: "..", dockerfile: "jev/Dockerfile" },
  "orchestration-runner": { context: "..", dockerfile: "deploy/orchestration/runner.Dockerfile" },
  auth: { context: "./auth" },
};
/** The networks each file defines, exactly; a file not named here defines none. */
const FILE_NETWORKS: Record<string, Mapping> = {
  "compose.yaml": { mesh: { internal: true }, data: { internal: true }, egress: {}, "auth-egress": {}, edge: {}, front: { internal: true }, telemetry: { internal: true } },
  "compose.host-ports.yaml": { "postgres-port": {} },
  "compose.grafana-port.yaml": { "grafana-port": {} },
};
/** The networks each file's services join, and the names each answers to there, exactly; a service not named here sets no `networks` (compose.yaml's proxy aside, PROXY_SERVICE's). */
const SERVICE_NETWORKS: Record<string, Record<string, Mapping | string[]>> = {
  // Postgres on `data` alone, and only what connects to it beside it; the provider callers and the model services on `egress`; the authorization server's way out its own (SMD-2583).
  "compose.yaml": {
    postgres: ["data"],
    migrate: ["data"],
    api: { data: {}, egress: {}, mesh: { aliases: [meshName("api")] } },
    mcp: { mesh: { aliases: [meshName("mcp")] } },
    // The operator GUI (SMD-2280): a client of the REST core, reached by the proxy alone.
    app: { mesh: { aliases: ["app.ob1.internal"] } },
    coordinator: ["data", "egress"],
    ollama: ["egress"],
    "ollama-pull": ["egress"],
    jev: ["egress"],
    n8n: ["egress"],
    "orchestration-runner-role": ["data"],
    "orchestration-runner": ["data", "egress"],
    auth: { mesh: { aliases: ["auth.ob1.internal"] }, "auth-egress": {} },
    // The observability profile's collector and Grafana (SMD-1849 PR 3a): the servers send to it and the proxy shows it, on `mesh`; it scrapes pg-exporter on `telemetry` (PR 3b).
    lgtm: { mesh: { aliases: ["lgtm.ob1.internal"] }, telemetry: {} },
    // The observability profile's database numbers (SMD-1849 PR 3b): the role step on `data`; the exporter on `data` and `telemetry`, where lgtm alone scrapes it.
    "pg-monitor-role": ["data"],
    "pg-exporter": { data: {}, telemetry: { aliases: ["pg-exporter.ob1.internal"] } },
  },
  "compose.host-ports.yaml": { postgres: ["postgres-port"] },
  "compose.grafana-port.yaml": { lgtm: ["grafana-port"] },
};
/** A name compose takes for its own with no -f, in any case (compose finds it so on a case-insensitive disk, macOS, measured): an override it reads beside compose.yaml, or a default name — docker-compose.y*ml, compose.yml, a case variant of compose.yaml — that compose warns about and skips beside compose.yaml but a checkout on such a disk can put in its place. */
const AUTOLOADED_COMPOSE = /^(compose\.override|(docker|podman|container)-compose(\.override)?)\.ya?ml$|^compose\.yml$/i;
const autoloadedCompose = (file: string) => AUTOLOADED_COMPOSE.test(file) || (file.toLowerCase() === "compose.yaml" && file !== "compose.yaml");
/** A name outside printable ASCII, which macOS folds as no ASCII test does: compose read `docKer-compose.override.yml`, with U+212A, as docker-compose.override.yml (pass 4, measured). */
const nonAsciiName = (file: string) => /[^\x20-\x7e]/.test(file);
/** The files check 28 reads under deploy/: every compose file, in any case, and any file whose name is not printable ASCII. */
const sweptCompose = (file: string) => (nonAsciiName(file) || /^((docker|podman|container)-)?compose.*\.ya?ml$/i.test(file));
/** Check 28's rules, by id; each must be the only catch of at least one probe. */
const ROUTE_RULES = ["parse", "characters", "tags", "table", "proxy", "keys", "networks"] as const;
type RouteRule = (typeof ROUTE_RULES)[number];
/** Every way a compose file under deploy/ strays from check 28's rules, each with its rule; none when it holds. */
function routeTableProblems(file: string, text: string): { rule: RouteRule; message: string }[] {
  const out: { rule: RouteRule; message: string }[] = [];
  const flag = (rule: RouteRule, message: string) => { out.push({ rule, message }); };
  const odd = oddCharacters(text);
  if (odd.length) flag("characters", `line ${odd.join(", ")} carries a control, format or separator character other than the space and the line feed — compose breaks a line at U+0085, U+2028 and U+2029 and Bun.YAML does not, so what this check reads as a comment can be keys compose reads: an anchor the route table takes, or an overlay's config that replaces it`);
  // A tag compose resolves and Bun.YAML does not: `!!binary` turns a key this check sees as base64 text into `proxy`, `name` or `mesh` for compose (pass 6, measured). Such a tag is written with a `!!` or named `!x!` handle, verbatim (`!<…>`), percent-escaped (`!%21binary`, pass 7), or through a handle a `%TAG` directive redefines; and compose honours !reset and !override, which Bun.YAML reads past. Any other local tag Bun.YAML reads past as compose does. A shell `[!0-9]` in a block scalar is none of these.
  const tagged = [...text.matchAll(/(^|[\s\[{,:?-])!(<|[A-Za-z0-9-]*[!%]|reset\b|override\b)|^%/gm)].map((m) => text.slice(0, m.index).split("\n").length);
  if (tagged.length) flag("tags", `line ${[...new Set(tagged)].join(", ")} carries a \`!!\` or named \`!x!\` tag handle, a verbatim \`!<…>\` or percent-escaped tag, a \`!reset\` or \`!override\`, or a \`%\` directive, comments included — compose decodes a \`!!binary\` key and Bun.YAML keeps it as base64 text, so a key this check reads as nothing is \`proxy\`, \`name\`, \`configs\` or \`mesh\` to compose (SMD-2658 review pass 6, measured), and it honours !reset and !override where Bun.YAML reads past them (a canary server's networks stripped, SMD-2685)`);
  if (nonAsciiName(file)) return [...out, { rule: "proxy", message: "has a name outside printable ASCII under deploy/ — macOS folds such a name onto an ASCII one (U+212A to k, U+017F to s) that no ASCII test sees, and compose read one as docker-compose.override.yml with no -f: name it in ASCII" }];
  if (autoloadedCompose(file)) return [...out, { rule: "proxy", message: "is a name compose takes for its own with no -f — an override it reads beside compose.yaml, or a default name a checkout on a case-insensitive disk can put in compose.yaml's place — and a deploy/README.md command runs compose that way, so what it sets reaches the stack while CI, which names each file with -f, never renders it: make it an overlay named with -f, and give it a combination in CI's \"The proxy loads only the held route tables\"" }];
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (e) {
    return [...out, { rule: "parse", message: `does not parse as YAML: ${(e as Error).message}` }];
  }
  if (!isMapping(doc)) return [...out, { rule: "parse", message: `is not one YAML mapping (${Array.isArray(doc) ? "a sequence or several documents" : typeof doc})` }];
  const spec = ROUTE_FILES.find(([f]) => f === file);
  const base = file === "compose.yaml";
  const overlay = OVERLAYS[file];
  const services = isMapping(doc.services) ? doc.services : {};
  const proxy = isMapping(services.proxy) ? services.proxy : undefined;
  // What a file may do to the proxy: compose.yaml defines it, as PROXY_SERVICE; an overlay with a table adds that table's mount.
  if (base) {
    const diffs: string[] = [];
    pathDiffs(JSON.parse(JSON.stringify(omitKeys(proxy, ["labels", "logging"]))), PROXY_SERVICE, "services.proxy", diffs);
    if (diffs.length) flag("proxy", `${diffs.slice(0, 6).join("; ")}${diffs.length > 6 ? `; and ${diffs.length - 6} more` : ""} — compose.yaml's proxy is check 28's PROXY_SERVICE, its label aside: a hook, a hosts entry, a volume, another provider or a variable a deploy/.env could move reaches the origin, so a change to the proxy is made there too, on purpose (SMD-2685)`);
    // The forwarder, whole, and its script byte for byte in its config and its label (SMD-2583).
    const forwarder = isMapping(services.forwarder) ? services.forwarder : undefined;
    const fdiffs: string[] = [];
    pathDiffs(JSON.parse(JSON.stringify(omitKeys(forwarder, ["labels", "logging"]))), FORWARDER_SERVICE, "services.forwarder", fdiffs);
    if (fdiffs.length) flag("proxy", `${fdiffs.slice(0, 6).join("; ")}${fdiffs.length > 6 ? `; and ${fdiffs.length - 6} more` : ""} — compose.yaml's forwarder is check 28's FORWARDER_SERVICE, its label aside: it holds the stack's published port and every client's bytes, so a change to it is made there too, on purpose (SMD-2583)`);
    // The break-glass listener, whole, its label the same script (SMD-3307).
    const breakglass = isMapping(services.breakglass) ? services.breakglass : undefined;
    const bdiffs: string[] = [];
    pathDiffs(JSON.parse(JSON.stringify(omitKeys(breakglass, ["labels", "logging"]))), BREAKGLASS_SERVICE, "services.breakglass", bdiffs);
    pathDiffs(breakglass && isMapping(breakglass.labels) ? breakglass.labels["ob1.forwarder"] : undefined, FORWARDER_SCRIPT, "services.breakglass.labels.ob1.forwarder", bdiffs);
    const botherLabels = Object.keys(breakglass && isMapping(breakglass.labels) ? breakglass.labels : {}).filter((k) => k !== "ob1.forwarder");
    if (botherLabels.length) bdiffs.push(`services.breakglass.labels carries ${botherLabels.join(", ")} beside ob1.forwarder, where its one label is its script`);
    if (bdiffs.length) flag("proxy", `${bdiffs.slice(0, 6).join("; ")}${bdiffs.length > 6 ? `; and ${bdiffs.length - 6} more` : ""} — compose.yaml's breakglass is check 28's BREAKGLASS_SERVICE, its label the forwarder's script: it publishes the GUI's key sign-in while the stack is configured, on loopback alone, so a change to it is made there too, on purpose (SMD-3307)`);
    // The MCP server built on the REST core, whole (SMD-2287): what it holds, how it starts, its health.
    const mcp = isMapping(services.mcp) ? services.mcp : undefined;
    const mdiffs: string[] = [];
    pathDiffs(JSON.parse(JSON.stringify(omitKeys(mcp, ["logging"]))), MCP_SERVICE, "services.mcp", mdiffs);
    if (mdiffs.length) flag("proxy", `${mdiffs.slice(0, 6).join("; ")}${mdiffs.length > 6 ? `; and ${mdiffs.length - 6} more` : ""} — compose.yaml's mcp is check 28's MCP_SERVICE: it is on the mesh beside the proxy with none of the server's secrets, so a knob handed to it, its entrypoint, its health or its wait on the REST core is changed there too, on purpose (SMD-2287)`);
    // The operator GUI, whole (SMD-2280): what it holds, how it starts, its confinement, its health.
    const app = isMapping(services.app) ? services.app : undefined;
    const adiffs: string[] = [];
    pathDiffs(JSON.parse(JSON.stringify(omitKeys(app, ["logging"]))), APP_SERVICE, "services.app", adiffs);
    if (adiffs.length) flag("proxy", `${adiffs.slice(0, 6).join("; ")}${adiffs.length > 6 ? `; and ${adiffs.length - 6} more` : ""} — compose.yaml's app is check 28's APP_SERVICE: the browser's way into the brain, holding no key, so a knob handed to it, its image, user, confinement, health or wait is changed there too, on purpose — and COMPOSE_PROFILES is what turns its key sign-in off while the stack is configured (SMD-2280)`);
    // The observability collector, whole (SMD-1849 PR 3a): Grafana's sign-in, its exposure and what it calls out to are its environment.
    const lgtm = isMapping(services.lgtm) ? services.lgtm : undefined;
    const ldiffs: string[] = [];
    pathDiffs(JSON.parse(JSON.stringify(omitKeys(lgtm, ["logging", "labels"]))), LGTM_SERVICE, "services.lgtm", ldiffs);
    if (ldiffs.length) flag("proxy", `${ldiffs.slice(0, 6).join("; ")}${ldiffs.length > 6 ? `; and ${ldiffs.length - 6} more` : ""} — compose.yaml's lgtm is check 28's LGTM_SERVICE: Grafana's anonymous access, its admin password's refusal, the backends' loopback and every call out are its keys, so a change to it is made there too, on purpose (SMD-1849 PR 3a)`);
    // The Postgres exporter and its role's step, whole (SMD-1849 PR 3b review pass 1): the role it reads as and what it names are their keys.
    for (const [name, held, lit] of [["pg-exporter", PG_EXPORTER_SERVICE, "PG_EXPORTER_SERVICE"], ["pg-monitor-role", PG_MONITOR_ROLE_SERVICE, "PG_MONITOR_ROLE_SERVICE"]] as const) {
      const svc = isMapping(services[name]) ? services[name] : undefined;
      const pdiffs: string[] = [];
      pathDiffs(JSON.parse(JSON.stringify(omitKeys(svc, ["logging"]))), held, `services.${name}`, pdiffs);
      if (pdiffs.length) flag("proxy", `${pdiffs.slice(0, 6).join("; ")}${pdiffs.length > 6 ? `; and ${pdiffs.length - 6} more` : ""} — compose.yaml's ${name} is check 28's ${lit}: the role the exporter reads Postgres as, its one membership, which statements it names and (SMD-3023) the exporter on loopback behind its one-CGI front on telemetry are its keys, so a change to it is made there too, on purpose (SMD-1849 PR 3b)`);
    }
    const fconfig = isMapping(doc.configs) && isMapping(doc.configs.forwarder) ? doc.configs.forwarder : undefined;
    const sdiffs: string[] = [];
    pathDiffs(fconfig?.content, FORWARDER_SCRIPT, "configs.forwarder.content", sdiffs);
    if (fconfig && canonJson(Object.keys(fconfig)) !== canonJson(["content"])) sdiffs.push(`configs.forwarder carries ${Object.keys(fconfig).filter((k) => k !== "content").join(", ")} beside its content, where the script is its content alone`);
    pathDiffs(forwarder && isMapping(forwarder.labels) ? forwarder.labels["ob1.forwarder"] : undefined, FORWARDER_SCRIPT, "services.forwarder.labels.ob1.forwarder", sdiffs);
    const fotherLabels = Object.keys(forwarder && isMapping(forwarder.labels) ? forwarder.labels : {}).filter((k) => k !== "ob1.forwarder");
    if (fotherLabels.length) sdiffs.push(`services.forwarder.labels carries ${fotherLabels.join(", ")} beside ob1.forwarder, where its one label is its script`);
    const odd = [...new Set([...FORWARDER_SCRIPT].filter((ch) => ch === "$"))];
    if (odd.length) sdiffs.push(`deploy/forwarder.ts holds ${odd.map((ch) => `\`${ch}\``).join(" and ")}: compose reads a \`$\` in the inline copy as a variable, from deploy/.env or the shell, so the script that runs is not this file (review pass 1)`);
    if (sdiffs.length) flag("table", `${sdiffs.join("; ")} — the forwarder's config and its label are each deploy/forwarder.ts, byte for byte (FORWARDER_SCRIPT): the script that chooses where every client's bytes go is changed there, where CI runs its --self-check (SMD-2583)`);
  }
  const configs = Object.keys(isMapping(doc.configs) ? doc.configs : {});
  const foreign = configs.filter((c) => c !== spec?.[1] && !(base && BASE_CONFIGS.includes(c)));
  if (foreign.length) flag("proxy", `defines config${foreign.length > 1 ? "s" : ""} ${foreign.join(", ")} — each file defines only its own table's config (ROUTE_FILES: ${ROUTE_FILES.map(([f, c]) => `${f}: ${c}`).join("; ")}; compose.yaml's ${BASE_CONFIGS.join(", ")} too), so an overlay cannot replace another's table in a combination CI does not render`);
  if (proxy && spec && !base) {
    const [, config, target] = spec;
    if (canonJson(proxy.configs) !== canonJson([{ source: config, target }])) flag("proxy", `mounts ${JSON.stringify(proxy.configs ?? null)} on the proxy where it should mount only its table: [{"source":"${config}","target":"${target}"}]`);
  }
  // What each file sets: compose.yaml its services' own containers; an overlay what OVERLAYS declares of it.
  if (!base && !overlay) flag("keys", `is not an overlay check 28 knows — an overlay is an OVERLAYS entry naming the keys it sets on each service, and a combination in CI's "The proxy loads only the held route tables" declaring the same; one that carries a route table is a ROUTE_FILES entry too`);
  const TOP_WHY: Record<string, string> = {
    name: "an overlay's `name:` renames every network the proxy joins to another project's (SMD-2658 review pass 4, measured); compose.yaml names it",
    secrets: "a secret mounts a file wherever its target says, the proxy's route directory or a static traefik.yml included",
    include: "an included file is a compose file this check does not read",
  };
  const top = Object.keys(doc).filter((k) => !k.startsWith("x-") && !(base ? COMPOSE_TOP : ["services", ...(overlay?.top ?? [])]).includes(k));
  for (const k of top) flag("keys", `has a top-level \`${k}\` — ${TOP_WHY[k] ?? (base ? `compose.yaml's are ${COMPOSE_TOP.join(", ")}` : "an overlay defines only what its OVERLAYS entry declares")}`);
  if (base && canonJson(doc.volumes ?? null) !== canonJson(COMPOSE_VOLUMES)) flag("keys", `defines volumes ${JSON.stringify(doc.volumes ?? null)} where check 28's COMPOSE_VOLUMES holds ${JSON.stringify(COMPOSE_VOLUMES)} — each the engine's default, since driver options bind a host path, and a volume named like a path (\`..\`) is a bind of it`);
  for (const [name, def] of Object.entries(services)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) flag("keys", `names a service ${JSON.stringify(name)} — compose adds a service's name on each network it joins, so a dotted one answers as that name, a backend's mesh name (mcp.ob1.internal) included, and takes the proxy's traffic for it (SMD-2685): a service name is lower-case letters, digits and hyphens`);
    const svc = isMapping(def) ? def : {};
    if (!base) {
      const may = overlay?.services[name] ?? [];
      const extra = Object.keys(svc).filter((k) => !may.includes(k));
      if (extra.length) flag("keys", `sets ${extra.map((k) => `services.${name}.${k}`).join(", ")} — an overlay sets only what its OVERLAYS entry declares${may.length ? ` (${name}: ${may.join(", ")})` : ""}; anything else it set would reach the stack in a review of this file alone (a mesh alias, a sidecar in the proxy's PID namespace: SMD-2685)`);
      if (file === "compose.grafana-port.yaml" && name === "lgtm" && canonJson(svc.environment ?? null) !== canonJson(GRAFANA_PORT_LGTM_ENV)) flag("keys", `sets services.lgtm.environment ${JSON.stringify(svc.environment ?? null)} where check 28's GRAFANA_PORT_LGTM_ENV holds ${JSON.stringify(GRAFANA_PORT_LGTM_ENV)} — the loopback port names Grafana's origin and nothing else: any other key there is Grafana's configuration, its anonymous access included`);
      if (name === "app" && file in GRAFANA_APP_ENV && canonJson(svc.environment ?? null) !== canonJson(GRAFANA_APP_ENV[file])) flag("keys", `sets services.app.environment ${JSON.stringify(svc.environment ?? null)} where check 28's GRAFANA_APP_ENV holds ${JSON.stringify(GRAFANA_APP_ENV[file])} — the overlay names the operator GUI's link to the Grafana it reaches and nothing else: any other key there steers the GUI, its origin or its REST core included (SMD-2280)`);
      continue;
    }
    if (name === "proxy" || name === "forwarder" || name === "breakglass") continue;
    const extra = Object.keys(svc).filter((k) => !SERVICE_KEYS.includes(k));
    if (extra.length) flag("keys", `sets ${extra.map((k) => `services.${name}.${k}`).join(", ")} — a compose.yaml service sets only check 28's SERVICE_KEYS, which act inside its own container: \`pid: service:proxy\` with a capability wrote a route file through /proc/<pid>/root that Traefik loaded live (SMD-2685, measured), and a hook may run privileged; a key that is safe is added there on purpose`);
    const confinement = Object.fromEntries(CONFINEMENT_KEYS.filter((k) => k in svc).map((k) => [k, svc[k]]));
    if (canonJson(confinement) !== canonJson(CONFINEMENT[name] ?? {})) flag("keys", `services.${name}'s confinement is ${JSON.stringify(confinement)} where check 28's CONFINEMENT holds ${JSON.stringify(CONFINEMENT[name] ?? {})} — a capability added, or a drop or no-new-privileges removed, is a change there on purpose (a security_opt beyond no-new-privileges lifts seccomp, AppArmor or SELinux)`);
    if (canonJson(svc.build ?? null) !== canonJson(SERVICE_BUILDS[name] ?? null)) flag("keys", `services.${name}.build is ${JSON.stringify(svc.build ?? null)} where check 28's SERVICE_BUILDS holds ${JSON.stringify(SERVICE_BUILDS[name] ?? null)} — a build's network, privileges, entitlements, secrets and contexts act on the host's builder, so one is changed there on purpose`);
    if (canonJson(svc.configs ?? null) !== canonJson(SERVICE_CONFIGS[name] ?? null)) flag("keys", `services.${name}.configs is ${JSON.stringify(svc.configs ?? null)} where check 28's SERVICE_CONFIGS holds ${JSON.stringify(SERVICE_CONFIGS[name] ?? null)} — a config lands where its entry says, at its mode and owner, over any file there, so one is mounted there on purpose`);
    if (canonJson(svc.volumes ?? null) !== canonJson(SERVICE_MOUNTS[name] ?? null)) flag("keys", `services.${name}.volumes is ${JSON.stringify(svc.volumes ?? null)} where check 28's SERVICE_MOUNTS holds ${JSON.stringify(SERVICE_MOUNTS[name] ?? null)} — a mount is changed there on purpose: an engine's socket hands the service every container, the proxy's included, and a writable checkout or .git runs code on the host`);
  }
  // Who joins which network, under which names.
  if (base && doc.name !== "open-brain") flag("networks", `names the project ${JSON.stringify(doc.name ?? null)} where it is open-brain — the name prefixes every network, so another project's puts this stack's services on its mesh beside its own, two answering to one mesh name (SMD-2685 review pass 2)`);
  const wantNets = FILE_NETWORKS[file] ?? null;
  if (canonJson(doc.networks ?? null) !== canonJson(wantNets)) flag("networks", `defines networks ${JSON.stringify(doc.networks ?? null)} where check 28's FILE_NETWORKS holds ${JSON.stringify(wantNets)} — a network renamed, made external or defined twice under one name puts the proxy, or a service that answers as a backend, on another network (SMD-2658 review pass 3; SMD-2685's second key into stable's mesh)`);
  for (const [name, def] of Object.entries(services)) {
    if (base && (name === "proxy" || name === "forwarder" || name === "breakglass")) continue;
    const got = isMapping(def) ? def.networks ?? null : null;
    const want = SERVICE_NETWORKS[file]?.[name] ?? null;
    // compose.yaml's every service is named there: one that names no network lands on compose's default, beside nothing else (SMD-2583 review pass 1: null held null).
    if (base && !(name in (SERVICE_NETWORKS[file] ?? {}))) flag("networks", `services.${name} is not in check 28's SERVICE_NETWORKS — name its networks there and in its \`networks:\` (data only if it connects to Postgres, egress if it calls out), since a service that names none lands on compose's default network (SMD-2583)`);
    else if (canonJson(got) !== canonJson(want)) flag("networks", `services.${name}.networks is ${JSON.stringify(got)} where check 28's SERVICE_NETWORKS holds ${JSON.stringify(want)} — only a backend answers to its own mesh name: two containers aliased mcp.ob1.internal, and the one registered first took 30 of 30 of the proxy's requests (SMD-2685, measured)`);
  }
  if (!spec) return out;
  const [, config, , label, name, table] = spec;
  const configMap = isMapping(doc.configs) ? doc.configs : {};
  const diffs: string[] = [];
  pathDiffs(isMapping(configMap[config]) ? configMap[config].content : undefined, table, `configs.${config}.content`, diffs);
  if (isMapping(configMap[config]) && canonJson(Object.keys(configMap[config])) !== canonJson(["content"])) diffs.push(`configs.${config} carries ${Object.keys(configMap[config]).filter((k) => k !== "content").join(", ")} beside its content, where the table is its content alone`);
  pathDiffs(proxy && isMapping(proxy.labels) ? proxy.labels[label] : undefined, table, `services.proxy.labels.${label}`, diffs);
  const otherLabels = Object.keys(proxy && isMapping(proxy.labels) ? proxy.labels : {}).filter((k) => k !== label);
  if (otherLabels.length) diffs.push(`services.proxy.labels carries ${otherLabels.join(", ")} beside ${label}, where the file's one label on the proxy is its table`);
  if (diffs.length) flag("table", `${diffs.join("; ")} — the route table's config and its label are each check 28's ${name}, byte for byte, with no comment in it (Traefik renders a route file as a Go template, so a comment there can emit a router): a route changed on purpose is changed there too, and a note on it is a YAML comment above the block`);
  return out;
}
/** [what the probe changes, the file under deploy/, the text it replaces there (once; "" makes the file, which must not exist), its replacement] — each must turn check 28 false. */
const ROUTE_TABLE_PROBES: [string, string, string, string][] = [
  ["a Go template on a comment line in compose.yaml's table, which Traefik renders as a catch-all router", "compose.yaml", "    routers:\n      auth:\n", "    routers:\n      # {{ \"\\n    all:\\n      rule: \\\"PathPrefix(`/`)\\\"\\n      priority: 100\\n      service: canary\" }}\n      auth:\n"],
  ["a catch-all router on a line led by a no-break space in compose.yaml's table, a key to YAML and a comment to a reader", "compose.yaml", "    routers:\n      auth:\n", "    routers:\n      \u00a0#all: {rule: \"PathPrefix(`/`)\", priority: 100, entryPoints: [web], service: canary}\n      auth:\n"],
  ["a comment line in compose.yaml's table", "compose.yaml", "      auth-absent:\n        errors:\n", "      # a note\n      auth-absent:\n        errors:\n"],
  ["a catch-all router back under every unrouted path, as the legacy route was (SMD-2532)", "compose.yaml", "      health:\n        rule:", "      all:\n        rule: \"PathPrefix(`/`)\"\n        priority: 1\n        entryPoints: [web]\n        middlewares: [auth-absent]\n        service: server\n      health:\n        rule:"],
  ["Grafana's anonymous access on in the observability collector", "compose.yaml", "      GF_AUTH_ANONYMOUS_ENABLED: \"false\"\n", "      GF_AUTH_ANONYMOUS_ENABLED: \"true\"\n"],
  ["the proxy's label its own table", "compose.yaml", "      ob1.proxy-routes: *proxy-routes\n", "      ob1.proxy-routes: \"http: {}\"\n"],
  ["the mounted config its own table", "compose.yaml", "    content: *proxy-routes\n", "    content: \"http: {}\"\n"],
  ["compose.yaml's anchor redefined behind U+2028 on a comment, which compose reads and Bun.YAML does not (measured)", "compose.yaml", "\nservices:\n", "\n# a note\u2028x-shadow: &proxy-routes \"http: {}\"\n\nservices:\n"],
  ["compose.yaml's anchor redefined behind U+0085 on a comment", "compose.yaml", "\nservices:\n", "\n# a note\u0085x-shadow: &proxy-routes \"http: {}\"\n\nservices:\n"],
  ["compose.host-ports.yaml replacing the table behind U+2028 on a comment, which compose merges and Bun.YAML does not see (measured, pass 1)", "compose.host-ports.yaml", "\nservices:\n", "\n# a note\u2028configs: {proxy-routes: {content: 'http: {routers: {all: {rule: \"PathPrefix(`/`)\", priority: 100, service: canary}}}'}}\n\nservices:\n"],
  ["compose.grafana-port.yaml replacing the table behind U+2029 on a comment", "compose.grafana-port.yaml", "\nservices:\n", "\n# a note\u2029configs: {proxy-routes: {content: 'http: {}'}}\n\nservices:\n"],
  ["compose.yaml that does not parse", "compose.yaml", "x-proxy-routes: &proxy-routes |\n", "x-proxy-routes: &proxy-routes [\n"],
  ["a Go template on a comment line in compose.api-public.yaml's table", "compose.api-public.yaml", "    middlewares:\n", "    middlewares:\n      # {{ \"note\" }}\n"],
  ["compose.api-public.yaml's label its own table", "compose.api-public.yaml", "      ob1.proxy-api-route: *api-route\n", "      ob1.proxy-api-route: \"http: {}\"\n"],
  // What a file may do to the proxy (pass 2, each run against compose's render).
  ["a setting on compose.yaml's proxy by a variable CI renders as its default", "compose.yaml", "      TRAEFIK_PING: \"true\"\n", "      TRAEFIK_PING: \"true\"\n      TRAEFIK_ENTRYPOINTS_WEB_ADDRESS: ${OB1_PROXY_ADDRESS:-:8000}\n"],
  ["compose.grafana-port.yaml turning Grafana's anonymous access on beside its origin (review passes 3, 6)", "compose.grafana-port.yaml", "      LGTM_ORIGIN: \"${GRAFANA_ORIGIN:-http://127.0.0.1:${GRAFANA_PORT:-3000}}\"\n", "      LGTM_ORIGIN: \"${GRAFANA_ORIGIN:-http://127.0.0.1:${GRAFANA_PORT:-3000}}\"\n      GF_AUTH_ANONYMOUS_ENABLED: \"true\"\n"],
  ["compose.yaml's authorization server mounting the forwarder's script over a file of its own (SMD-1849 PR 3c review pass 1)", "compose.yaml", "      - auth-data:/data\n", "      - auth-data:/data\n    configs: [{source: forwarder, target: /app/server.ts, mode: 0777}]\n"],
  ["compose.host-ports.yaml mounting a second route file on the proxy", "compose.host-ports.yaml", "\nservices:\n", "\nservices:\n  proxy:\n    configs: [{source: proxy-routes, target: /etc/traefik/dynamic/zz.yaml}]\n"],
  ["compose.api-public.yaml giving the proxy a root hook that writes a route file (measured, pass 2)", "compose.api-public.yaml", "    depends_on:\n      api:\n", "    post_start: [{command: [sh, -c, \"echo > /etc/traefik/dynamic/x.yaml\"], user: root}]\n    depends_on:\n      api:\n"],
  ["compose.api-public.yaml mounting its table over compose.yaml's", "compose.api-public.yaml", "        target: /etc/traefik/dynamic/api.yaml\n", "        target: /etc/traefik/dynamic/routes.yaml\n"],
  ["compose.host-ports.yaml replacing compose.api-public.yaml's table, seen only with both named (pass 2)", "compose.host-ports.yaml", "\nservices:\n", "\nconfigs:\n  proxy-api-route:\n    content: \"http: {}\"\n\nservices:\n"],
  ["a secret in compose.yaml, which may mount a route file or a static traefik.yml", "compose.yaml", "\nvolumes:\n", "\nsecrets:\n  extra: {environment: OB1_PROXY_EXTRA}\n\nvolumes:\n"],
  ["a compose.override.yaml, which compose reads with no -f, so CI never renders what it sets — here nothing on the proxy (pass 2)", "compose.override.yaml", "", "services:\n  server:\n    environment:\n      OB1_NOTE: \"1\"\n"],
  ["a Compose.Override.yaml, which compose on macOS reads with no -f as it does compose.override.yaml (measured, pass 3)", "Compose.Override.yaml", "", "services:\n  server:\n    environment:\n      OB1_NOTE: \"1\"\n"],
  ["a docker-compose.override.yml, which compose reads beside compose.yaml with no -f", "docker-compose.override.yml", "", "services:\n  server:\n    environment:\n      OB1_NOTE: \"1\"\n"],
  ["a Compose.yaml, which a checkout on a case-insensitive disk can put in compose.yaml's place", "Compose.yaml", "", "services:\n  server:\n    environment:\n      OB1_NOTE: \"1\"\n"],
  ["a podman-compose.yaml, which podman-compose reads with no -f (SMD-2685 review pass 6, measured on 1.6.0)", "podman-compose.yaml", "", "services:\n  server:\n    environment:\n      OB1_NOTE: \"1\"\n"],
  ["a container-compose.override.yaml, which podman-compose reads with no -f", "container-compose.override.yaml", "", "services:\n  server:\n    environment:\n      OB1_NOTE: \"1\"\n"],
  ["a docker-compose.override.yml spelt with U+212A, which compose on macOS reads with no -f (measured, pass 4)", "doc\u212ager-compose.override.yml", "", "services:\n  server:\n    environment:\n      OB1_NOTE: \"1\"\n"],
  ["compose.host-ports.yaml naming the project, which renames the proxy's networks (measured, pass 4)", "compose.host-ports.yaml", "\nservices:\n", "\nname: open-brain-canary\n\nservices:\n"],
  ["compose.host-ports.yaml naming the project behind a !!binary key, which compose decodes and Bun.YAML does not (measured, pass 6)", "compose.host-ports.yaml", "\nservices:\n", "\n!!binary bmFtZQ==: open-brain-canary\n\nservices:\n"],
  ["compose.grafana-port.yaml defining compose.api-public.yaml's config behind a verbatim !<…binary> key (measured, pass 7)", "compose.grafana-port.yaml", "\nservices:\n", "\n!<tag:yaml.org,2002:binary> Y29uZmlncw==: {proxy-api-route: {content: \"http: {}\"}}\n\nservices:\n"],
  ["a %TAG directive in compose.grafana-port.yaml, which can redefine the primary handle so that !binary is !!binary (measured, pass 7)", "compose.grafana-port.yaml", "# The observability profile's Grafana on a loopback port of its own (SMD-1849", "%TAG ! tag:yaml.org,2002:\n---\n# The observability profile's Grafana on a loopback port of its own (SMD-1849"],
  ["compose.grafana-port.yaml with a !!binary key after a comma in a flow mapping (measured, pass 7)", "compose.grafana-port.yaml", "\nservices:\n", "\nx-flow: {a: 1,!!binary bmFtZQ==: open-brain-canary}\n\nservices:\n"],
  ["compose.grafana-port.yaml with a !!binary key opening a flow mapping", "compose.grafana-port.yaml", "\nservices:\n", "\nx-flow: {!!binary bmFtZQ==: open-brain-canary}\n\nservices:\n"],
  ["compose.host-ports.yaml naming the project behind a percent-escaped !%21binary key (measured, pass 7)", "compose.host-ports.yaml", "\nservices:\n", "\n!%21binary bmFtZQ==: open-brain-canary\n\nservices:\n"],
  ["compose.api-public.yaml defining a second config, which a later overlay could mount", "compose.api-public.yaml", "\nconfigs:\n  proxy-api-route:\n", "\nconfigs:\n  extra-routes:\n    content: \"http: {}\"\n  proxy-api-route:\n"],
  ["compose.api-public.yaml's config made external beside its content", "compose.api-public.yaml", "    content: *api-route\n", "    content: *api-route\n    external: true\n"],
  ["compose.host-ports.yaml including a file this check does not read", "compose.host-ports.yaml", "\nservices:\n", "\ninclude: [debug/extra.yaml]\n\nservices:\n"],
  ["compose.host-ports.yaml putting the mesh on another project's network (pass 3)", "compose.host-ports.yaml", "\nnetworks:\n  postgres-port: {}\n", "\nnetworks:\n  postgres-port: {}\n  mesh:\n    name: someone-elses_mesh\n    external: true\n"],
  // Another service taking the proxy's traffic (SMD-2685; SMD-2658's review pass 3 ran each live).
  ["Ollama answering as the MCP server on the mesh from compose.host-ports.yaml (measured: the one registered first took 30 of 30 requests)", "compose.host-ports.yaml", "  ollama:\n    ports:\n", "  ollama:\n    networks:\n      mesh:\n        aliases: [mcp.ob1.internal]\n    ports:\n"],
  ["compose.yaml's REST core answering as the authorization server too, which takes /auth sign-in POSTs while the auth profile is off", "compose.yaml", "        aliases: [api.ob1.internal]\n", "        aliases: [api.ob1.internal, auth.ob1.internal]\n"],
  ["compose.grafana-port.yaml joining the stack's mesh by a second key, external by its name, with a shadow on it answering as the MCP server (SMD-2685, measured on the canary's overlay before SMD-2874)", "compose.grafana-port.yaml", "\nnetworks:\n  grafana-port: {}\n", "  shadow:\n    image: oven/bun:1.4.3-alpine\n    networks:\n      mesh-2:\n        aliases: [mcp.ob1.internal]\n\nnetworks:\n  mesh-2:\n    name: open-brain_mesh\n    external: true\n  grafana-port: {}\n"],
  ["compose.grafana-port.yaml defining a second key for the stack's mesh", "compose.grafana-port.yaml", "\nnetworks:\n  grafana-port: {}\n", "\nnetworks:\n  mesh-2:\n    name: open-brain_mesh\n    external: true\n  grafana-port: {}\n"],
  ["compose.yaml's mesh no longer internal", "compose.yaml", "  mesh:\n    internal: true\n  data:\n", "  mesh:\n    internal: false\n  data:\n"],
  // The network move (SMD-2583): Postgres where only what connects to it is, and no service back on compose's default network.
  ["compose.yaml's data network given a route out", "compose.yaml", "  data:\n    internal: true\n  egress: {}\n", "  data: {}\n  egress: {}\n"],
  ["compose.yaml's Postgres on the mesh too, beside every backend the proxy reaches", "compose.yaml", "    networks: [data]\n    # As the servers': with none, a reboot", "    networks: [data, mesh]\n    # As the servers': with none, a reboot"],
  ["the authorization server on the stack's shared egress, beside Ollama, Jev, n8n and the runner", "compose.yaml", "        aliases: [auth.ob1.internal]\n      auth-egress: {}\n", "        aliases: [auth.ob1.internal]\n      egress: {}\n"],
  ["a new compose.yaml service that names no network, under a profile of its own, which lands on compose's default network (review pass 1)", "compose.yaml", "\nnetworks:\n  # The ADR's networks", "  debug:\n    image: oven/bun:1.4.3-alpine\n    profiles: [\"debug\"]\n    logging: *logging\n\nnetworks:\n  # The ADR's networks"],
  ["n8n on compose's default network again", "compose.yaml", "    networks: [egress]\n    volumes:\n      # The store", "    networks: [egress, default]\n    volumes:\n      # The store"],
  ["compose.host-ports.yaml putting Postgres on the stack's egress", "compose.host-ports.yaml", "    networks: [postgres-port]\n", "    networks: [postgres-port, egress]\n"],
  ["compose.host-ports.yaml's Postgres network named as another project's", "compose.host-ports.yaml", "\nnetworks:\n  postgres-port: {}\n", "\nnetworks:\n  postgres-port:\n    name: open-brain-canary_data\n    external: true\n"],
  ["a !override on lgtm's networks in compose.grafana-port.yaml, which compose honours and Bun.YAML reads past", "compose.grafana-port.yaml", "  lgtm:\n    networks: [grafana-port]\n", "  lgtm:\n    networks: !override [grafana-port]\n"],
  ["a sidecar in compose.yaml in the proxy's PID namespace with SYS_PTRACE, which wrote a route file Traefik loaded live (measured)", "compose.yaml", "\nnetworks:\n  # The ADR's networks", "  sidecar:\n    image: oven/bun:1.4.3-alpine\n    pid: \"service:proxy\"\n    cap_add: [SYS_PTRACE]\n\nnetworks:\n  # The ADR's networks"],
  ["compose.yaml's Postgres privileged in the host's PID namespace", "compose.yaml", "    shm_size:", "    privileged: true\n    pid: host\n    shm_size:"],
  ["compose.host-ports.yaml putting a sidecar in the proxy's PID namespace", "compose.host-ports.yaml", "  jev:\n    ports:\n", "  jev:\n    pid: \"service:proxy\"\n    cap_add: [SYS_PTRACE]\n    ports:\n"],
  ["a compose.yaml service named as the MCP server's mesh name", "compose.yaml", "\nnetworks:\n  # The ADR's networks", "  mcp.ob1.internal:\n    image: oven/bun:1.4.3-alpine\n\nnetworks:\n  # The ADR's networks"],
  ["the import runner given SYS_PTRACE too", "compose.yaml", "    cap_add: [SETUID, SETGID, KILL, NET_ADMIN, SETPCAP]\n", "    cap_add: [SETUID, SETGID, KILL, NET_ADMIN, SETPCAP, SYS_PTRACE]\n"],
  ["the authorization server unconfined by seccomp", "compose.yaml", "    security_opt: [\"no-new-privileges:true\"]\n    # The server stops on SIGTERM", "    security_opt: [\"no-new-privileges:true\", \"seccomp=unconfined\"]\n    # The server stops on SIGTERM"],
  ["the import runner mounting the engine's socket", "compose.yaml", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n      - /var/run/docker.sock:/var/run/docker.sock\n"],
  ["the import runner mounting the engine's socket past a variable's default (SMD-2685 review pass 1, which compose resolved to /var/run/docker.sock)", "compose.yaml", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n      - ${OB1_X:-./}/../../../../../var/run/docker.sock:/var/run/docker.sock\n"],
  ["the import runner mounting the engine's socket through a variable inside the path", "compose.yaml", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n      - ./a${OB1_X:-/../../../../..}/var/run/docker.sock:/s\n"],
  ["a mount from a variable with no default", "compose.yaml", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n      - ./a/${OB1_X}/x:/x\n"],
  ["the typed-decision tier built on the host's network", "compose.yaml", "      dockerfile: jev/Dockerfile\n", "      dockerfile: jev/Dockerfile\n      network: host\n"],
  ["a second label on compose.yaml's proxy", "compose.yaml", "      ob1.proxy-routes: *proxy-routes\n", "      ob1.proxy-routes: *proxy-routes\n      ob1.note: \"1\"\n"],
  ["the import runner mounting the directory a rootless engine keeps its socket in, by a variable the host sets (SMD-2685 review pass 2)", "compose.yaml", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n      - ${XDG_RUNTIME_DIR:-./run}:/run/host:ro\n"],
  ["the coordinator mounting the user's home in the long form, by a variable the host sets (SMD-2685 review pass 2)", "compose.yaml", "      - sleep-dumps:/var/lib/ob1/sleep-dumps\n", "      - sleep-dumps:/var/lib/ob1/sleep-dumps\n      - {type: bind, source: \"${HOME:-./home}\", target: /home/host, read_only: true}\n"],
  ["the import runner mounting the checkout's .git (SMD-2685 review pass 2)", "compose.yaml", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n      - ../.git:/g:ro\n"],
  ["the import runner mounting deploy/ as ./ (SMD-2685 review pass 2)", "compose.yaml", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n      - ./:/d:ro\n"],
  ["the import runner's pipeline list mounted writable", "compose.yaml", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:z\n"],
  ["a tmpfs given the engine's socket as its source", "compose.yaml", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n      - {type: tmpfs, source: /var/run/docker.sock, target: /s}\n"],
  ["the import runner keeping Docker's default capabilities", "compose.yaml", "    cap_drop: [ALL]\n    cap_add: [SETUID", "    cap_add: [SETUID"],
  ["the typed-decision tier built from a Dockerfile outside its context", "compose.yaml", "      dockerfile: jev/Dockerfile\n", "      dockerfile: ../../x/Dockerfile\n"],
  ["compose.yaml naming another project, whose mesh its server would join (SMD-2685 review pass 2)", "compose.yaml", "name: open-brain\n", "name: open-brain-two\n"],
  ["a volume named .., which compose mounts as the checkout's root, writable (SMD-2685 review pass 3)", "compose.yaml", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n      - ..:/up\n"],
  ["a top-level volume named ..", "compose.yaml", "\nvolumes:\n  pgdata:\n", "\nvolumes:\n  \"..\":\n  pgdata:\n"],
  ["the pipeline list mounted ro,rw, which compose reads as writable (SMD-2685 review pass 3)", "compose.yaml", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z,rw\n"],
  ["the import runner mounting deploy/, which holds deploy/.env, as ../deploy (SMD-2685 review pass 3)", "compose.yaml", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n", "      - ./orchestration/pipelines.json:/app/deploy/orchestration/pipelines.json:ro,z\n      - ../deploy:/d:ro\n"],
  ["n8n mounting the authorization server's store", "compose.yaml", "      - n8n-data:/home/node/.n8n\n", "      - n8n-data:/home/node/.n8n\n      - auth-data:/auth-data\n"],
  ["the Postgres volume binding a host directory by its driver options", "compose.yaml", "\nvolumes:\n  pgdata:\n", "\nvolumes:\n  pgdata:\n    driver_opts: {type: none, o: bind, device: /var/run}\n"],
  ["compose.yaml's mcp handed the database's URL (SMD-2287)", "compose.yaml", "    command: [\"../mcp-server/index.ts\"]\n    environment:\n", "    command: [\"../mcp-server/index.ts\"]\n    environment:\n      DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/openbrain\n"],
  ["compose.yaml's proxy given a hosts entry for its backend's name", "compose.yaml", "    dns_search: [\".\"]\n    healthcheck:\n      test: [\"CMD\", \"traefik\", \"healthcheck\"]", "    dns_search: [\".\"]\n    extra_hosts: [\"mcp.ob1.internal:10.0.0.9\"]\n    healthcheck:\n      test: [\"CMD\", \"traefik\", \"healthcheck\"]"],
  // The forwarder and the proxy behind it (SMD-2583).
  ["compose.yaml's proxy publishing a port again, back on an outward network", "compose.yaml", "    networks:\n      front:\n        aliases: [proxy.ob1.internal]\n      mesh: {}\n", "    ports:\n      - \"127.0.0.1:8001:8000\"\n    networks:\n      edge: {}\n      front:\n        aliases: [proxy.ob1.internal]\n      mesh: {}\n"],
  ["compose.yaml's forwarder on the mesh too, beside every backend", "compose.yaml", "      - \"${SERVER_BIND:-127.0.0.1}:${SERVER_PORT:-8000}:8000\"\n    networks: [edge, front]\n", "      - \"${SERVER_BIND:-127.0.0.1}:${SERVER_PORT:-8000}:8000\"\n    networks: [edge, front, mesh]\n"],
  ["compose.yaml's breakglass on the mesh too, beside every backend", "compose.yaml", "      - \"127.0.0.1:${BREAKGLASS_PORT:-8001}:8001\"\n    networks: [edge, front]\n", "      - \"127.0.0.1:${BREAKGLASS_PORT:-8001}:8001\"\n    networks: [edge, front, mesh]\n"],
  ["compose.yaml's forwarder given a capability back", "compose.yaml", "  forwarder:\n    image: docker.io/oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373\n    # Nothing it needs is root's, as the proxy's: it listens on 8000 and\n    # writes only to stderr. Not read_only, for the proxy's reason: compose\n    # writes the inline script into the container's own filesystem.\n    user: \"65534:65534\"\n    cap_drop: [ALL]\n", "  forwarder:\n    image: docker.io/oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373\n    # Nothing it needs is root's, as the proxy's: it listens on 8000 and\n    # writes only to stderr. Not read_only, for the proxy's reason: compose\n    # writes the inline script into the container's own filesystem.\n    user: \"65534:65534\"\n    cap_drop: [ALL]\n    cap_add: [NET_RAW]\n"],
  ["the forwarder's inline script dialling whatever its lookup answers", "compose.yaml", "return addresses.find((a) => own.has(a.toLowerCase()) === false", "return addresses[0] ?? addresses.find((a) => own.has(a.toLowerCase()) === false"],
  ["the forwarder's label a script other than its config's", "compose.yaml", "    # recreates the container, as the proxy's route table does.\n    labels:\n      ob1.forwarder: *forwarder\n", "    # recreates the container, as the proxy's route table does.\n    labels:\n      ob1.forwarder: \"an older script\"\n"],
  ["breakglass's label a script other than the forwarder's", "compose.yaml", "        target: /forwarder.ts\n    labels:\n      ob1.forwarder: *forwarder\n    ports:\n      - \"127.0.0.1", "        target: /forwarder.ts\n    labels:\n      ob1.forwarder: \"an older script\"\n    ports:\n      - \"127.0.0.1"],
  ["compose.yaml's front given a route out", "compose.yaml", "  front:\n    internal: true\n", "  front: {}\n"],
  ["a compose.debug.yaml no OVERLAYS entry declares", "compose.debug.yaml", "", "services:\n  shadow:\n    image: oven/bun:1.4.3-alpine\n"],
];
function checkRouteTables() {
  // Every compose file under deploy/, an overlay added later included.
  const texts = new Map(readdirSync(join(ROOT, "deploy")).filter((f) => sweptCompose(f) && statSync(join(ROOT, "deploy", f)).isFile()).sort().map((f) => [f, readFileSync(join(ROOT, "deploy", f), "utf8")]));
  for (const [file] of ROUTE_FILES) if (!texts.has(file)) { fail(`deploy/${file}`, "missing — check 28 holds the route table it carries (SMD-2658)"); return; }
  let clean = true;
  for (const [file, text] of texts) {
    for (const p of routeTableProblems(file, text)) { clean = false; fail(`deploy/${file}`, /SMD-\d+/.test(p.message) ? p.message : `${p.message} (${p.rule === "keys" || p.rule === "networks" ? "SMD-2685" : p.rule === "proxy" || p.rule === "tags" ? "SMD-2658, SMD-2685" : "SMD-2658"})`); }
  }
  const soleCatch = new Set<RouteRule>();
  for (const [what, file, from, to] of ROUTE_TABLE_PROBES) {
    const text = texts.get(file);
    const misanchored = from === "" ? (text !== undefined ? `makes deploy/${file}, which exists` : !sweptCompose(file) ? `makes deploy/${file}, which the sweep does not read` : "") : text === undefined ? `edits deploy/${file}, which is missing` : text.split(from).length !== 2 ? `finds its anchor ${text.split(from).length - 1} times in deploy/${file}, not once` : "";
    if (misanchored) { fail(SELF, `check 28's probe "${what}" ${misanchored} — re-anchor it`); continue; }
    const rules = new Set(routeTableProblems(file, from === "" ? to : text!.replace(from, to)).map((p) => p.rule));
    if (rules.size === 0) fail(SELF, `check 28 no longer catches ${what} (its own probe)`);
    if (rules.size === 1) soleCatch.add([...rules][0]);
  }
  // What a release ships as its install, held here rather than by the generator's own self-check, which an edit to the generator edits too: the env asset becomes every install's .env, so pointing it at another file would publish what no check reads (SMD-2685 review pass 5).
  const assets: Record<string, string> = { "compose.yaml": "deploy/compose.yaml", "compose.release.yaml": "deploy/compose.release.yaml", "env.example": "deploy/.env.example", "compose.api-public.yaml": "deploy/compose.api-public.yaml", "compose.hooks-public.yaml": "deploy/compose.hooks-public.yaml", "compose.grafana-port.yaml": "deploy/compose.grafana-port.yaml", "compose.grafana-public.yaml": "deploy/compose.grafana-public.yaml" };
  if (canonJson(ASSETS) !== canonJson(assets)) fail("scripts/release-artifacts.ts", `ASSETS is ${JSON.stringify(ASSETS)} where check 28 holds ${JSON.stringify(assets)} — a release install's files are these, each held (the env asset by check 13, compose.yaml, compose.api-public.yaml, compose.hooks-public.yaml, compose.grafana-public.yaml and compose.grafana-port.yaml by check 28, the release's overlay by CI's "The proxy loads only the held route tables" and release.yml); a change to them is made in check 28 too, on purpose (SMD-2685)`);
  // …and the commands its notes tell an operator to run: the downloads of those files, the two keys minted with the release's own image (SMD-2287: a release install has no checkout), and the two compose commands over them, nothing else — a third `-f` there (`oci://…` is fetched from a registry) would load what no check reads into every install (SMD-2685 review pass 6). Comments aside; a tag's notes and a rehearsal's.
  const run = (mode: "tag" | "rehearsal") => {
    const notes = renderNotes({ facts: { mode, tag: "v9.9.9", version: "9.9.9", server_image: "ghcr.io/x/ob1-server:9.9.9" } as unknown as Parameters<typeof renderNotes>[0]["facts"], changelogSection: null, digests: {}, yieldText: "", yieldWindow: "" });
    return (/\n## Run it\n[^`]*```bash\n([^`]*)```/.exec(notes)?.[1] ?? "").split("\n").map((l) => l.replace(/(^|\s+)#.*$/, "")).filter(Boolean);
  };
  const compose = ["docker compose -f compose.yaml -f compose.release.yaml pull", "docker compose -f compose.yaml -f compose.release.yaml up -d --wait"];
  const download = (name: string) => `curl -fsSL${name === "env.example" ? " -o .env" : "O"} ${REPO_URL}/releases/download/v9.9.9/${name}`;
  const keygen = ["laptop --scope write", "mcp-forwarder --scope forward"].map((k) => `docker run --rm --entrypoint bun ghcr.io/x/ob1-server:9.9.9 keygen.ts --name ${k}`);
  for (const [mode, want] of [["tag", [...Object.keys(assets).map(download), ...keygen, ...compose]], ["rehearsal", compose]] as const) {
    const got = run(mode);
    if (canonJson(got) !== canonJson(want)) fail("scripts/release-artifacts.ts", `renderNotes' "Run it" block, for a ${mode}, runs ${JSON.stringify(got)} where check 28 holds ${JSON.stringify(want)} — an install runs exactly the held files, so another -f, env file or variable there loads what no check reads (SMD-2685)`);
  }
  // On a file that already strays, which rule alone catches each probe says nothing.
  if (clean) for (const rule of ROUTE_RULES) if (!soleCatch.has(rule)) fail(SELF, `check 28's rule "${rule}" is the only catch of none of its probes — add a probe that it alone catches, or remove the rule if another already holds what it does`);
}
checkRouteTables();

// ── 28b: deploy/README.md's path table says what the route tables route (SMD-2296) ──
//
// Check 28 holds each route table byte for byte, so a route changed on purpose
// is changed there too. deploy/README.md's "The paths today" table is the
// operator's reading of the same tables, and nothing held it: /hooks, /grafana
// and /dashboard were each added to it by hand. This holds, for compose.yaml's
// table and each overlay's in ROUTE_FILES:
//   paths  every path a router's rule names (a `Path` or `PathPrefix`, the
//       prefix's trailing slash dropped) is named in backticks in a row's
//       first cell — `OPTIONS /health` names /health — and every path a row
//       names there is a router's, or the row answers with a 404 (/canary,
//       /working, the rest of /.well-known: the proxy's own);
//   backend  the row naming a router's first path names, in backticks, the
//       service compose runs behind it (its URL's first label: `mcp`, `auth`,
//       `app`, `api`, `lgtm`), or says 404 for a router to noop@internal; an
//       overlay's router's row names the overlay's file too.
// What each row says beyond that — a path kept or stripped, a 502 — is prose
// this check does not read.
type PathRow = { paths: string[]; answer: string };
/** The rows of the README's `| Path | Answered by |` table: each first cell's paths (a `/…` inside backticks) and the answer cell; a string when the table is not there. */
function readmePathRows(readme: string): PathRow[] | string {
  const lines = readme.split("\n");
  const head = lines.findIndex((l) => l.trim() === "| Path | Answered by |");
  if (head < 0 || lines[head + 1]?.trim() !== "| --- | --- |") return 'has no "| Path | Answered by |" table under "The paths today"';
  const rows: PathRow[] = [];
  for (let i = head + 2; i < lines.length && lines[i].startsWith("| "); i++) {
    const inner = lines[i].trim().replace(/^\|\s*/, "").replace(/\s*\|$/, "");
    const cut = inner.indexOf(" | ");
    if (cut < 0) return `row ${i + 1} has no answer cell`;
    const spans = [...inner.slice(0, cut).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
    rows.push({ paths: spans.flatMap((s) => [...s.matchAll(/\/[^\s`]*/g)].map((m) => m[0])), answer: inner.slice(cut + 3) });
  }
  return rows;
}
/** A router's paths, as its rule names them: each `Path(…)` and `PathPrefix(…)` literal, a trailing slash dropped, once each. */
const rulePaths = (rule: string) => [...new Set([...rule.matchAll(/Path(?:Prefix)?\(`([^`]+)`\)/g)].map((m) => m[1].length > 1 ? m[1].replace(/\/$/, "") : m[1]))];
/** Where deploy/README.md's path table and the route tables disagree, one line each (empty when they agree). */
function pathTableProblems(readme: string, tables: readonly (readonly [file: string, table: string])[]): string[] {
  const rows = readmePathRows(readme);
  if (typeof rows === "string") return [rows];
  const out: string[] = [];
  const routed = new Set<string>();
  for (const [file, table] of tables) {
    const http = (Bun.YAML.parse(table) as { http: { routers: Record<string, { rule: string; service: string }>; services?: Record<string, { loadBalancer: { servers: { url: string }[] } }> } }).http;
    for (const [name, router] of Object.entries(http.routers)) {
      const paths = rulePaths(router.rule);
      for (const p of paths) {
        routed.add(p);
        if (!rows.some((r) => r.paths.includes(p))) out.push(`names no row for \`${p}\`, which ${file}'s router ${name} routes`);
      }
      const row = rows.find((r) => r.paths.includes(paths[0]));
      if (!row) continue;
      const url = http.services?.[router.service]?.loadBalancer.servers[0]?.url;
      const backend = router.service === "noop@internal" ? null : url ? new URL(url).hostname.split(".")[0] : undefined;
      if (backend === undefined) out.push(`cannot read the backend of ${file}'s router ${name} (service ${router.service})`);
      else if (backend === null ? !/\b404\b/.test(row.answer) : !row.answer.includes(`\`${backend}\``)) out.push(`\`${paths[0]}\`'s row ${backend === null ? "does not say 404" : `does not name \`${backend}\``}, where ${file}'s router ${name} sends it ${backend === null ? "to noop@internal" : `to ${backend}`}`);
      if (file !== "compose.yaml" && !row.answer.includes(`\`${file}\``)) out.push(`\`${paths[0]}\`'s row does not name \`${file}\`, whose router ${name} serves it`);
    }
  }
  for (const r of rows) for (const p of r.paths) if (!routed.has(p) && !/\b404\b/.test(r.answer)) out.push(`\`${p}\`'s row names an answer other than a 404, but no route table routes \`${p}\``);
  return out;
}
/** [what, the README's text replaced, its replacement, the problem it must raise] — each a drift 28b must catch, on the README as it is, by the rule meant for it. */
const PATH_TABLE_PROBES: [string, string, string, string][] = [
  ["a routed path's row dropped", "| `/dashboard` and everything under it |", "| the GUI |", "names no row for `/dashboard`"],
  ["a row naming another backend", "| `/mcp` and everything under it | `mcp` —", "| `/mcp` and everything under it | `app` —", "does not name `mcp`"],
  ["a row for a path no router routes, answered by a service", "| anything else |", "| `/canary/mcp` | `mcp`, the canary's MCP server |\n| anything else |", "`/canary/mcp`'s row names an answer other than a 404"],
  ["an overlay's row not naming its file", "With `compose.hooks-public.yaml` named", "With the hooks overlay named", "does not name `compose.hooks-public.yaml`"],
  ["a noop@internal router's row not saying 404", "| `/register`, `/authorize`, `/token` | the proxy's bodiless 404:", "| `/register`, `/authorize`, `/token` | the proxy, refused:", "`/register`'s row does not say 404"],
  ["the table's header renamed", "| Path | Answered by |", "| Route | Answered by |", 'has no "| Path | Answered by |" table'],
];
function checkPathTable() {
  const rel = "deploy/README.md";
  const readme = readFileSync(join(ROOT, rel), "utf8");
  const tables = ROUTE_FILES.map(([file, , , , , table]) => [file, table] as const);
  for (const p of pathTableProblems(readme, tables)) fail(rel, `${p} — the path table is the operator's reading of check 28's route tables, so a route changed there is changed here too (SMD-2296)`);
  for (const [what, from, to, want] of PATH_TABLE_PROBES) {
    if (readme.split(from).length !== 2) { fail(SELF, `check 28b's probe "${what}" finds its anchor ${readme.split(from).length - 1} times in ${rel}, not once — re-anchor it`); continue; }
    if (!pathTableProblems(readme.replace(from, to), tables).some((p) => p.includes(want))) fail(SELF, `check 28b no longer catches ${what} (its own probe, which expects "${want}")`);
  }
  // A router the README has never heard of, added to compose.yaml's table.
  const added = tables.map(([file, table]) => [file, file === "compose.yaml" ? table.replace("  routers:\n", `  routers:\n${routeRouter("probe", "PathPrefix(\`/probe/\`)", 30, "", "mcp")}`) : table] as const);
  if (!pathTableProblems(readme, added).some((p) => p.includes("`/probe`"))) fail(SELF, "check 28b no longer catches a router added to compose.yaml's table with no row (its own probe)");
}
checkPathTable();

// ── 29. Every service's log is bounded (SMD-1849) ───────────────────────────
//
// Docker's default json-file log is one file per container that grows until
// the disk is full, and the servers now write a line per request
// (server-portable/telemetry.ts). deploy/compose.yaml's x-logging names the
// bound — the json-file driver with a max-size and a max-file — and every
// service there names it as `logging: *logging`. The parsed value is what is
// held, so a service added without it, or with a bound of its own, fails
// here, and one that writes the same mapping out passes. The overlays define no
// service of their own, so this file is the one to read. Parsed with Bun.YAML, as the
// other compose checks are; probes on in-memory text.

/** One unbounded log: the service (null for the file's own x-logging) and what is wrong. */
type LogGap = [service: string | null, detail: string];
function unboundedLogsIn(text: string): LogGap[] {
  let doc: unknown;
  try { doc = Bun.YAML.parse(text); } catch (e) { return [[null, `does not parse: ${(e as Error).message}`]]; }
  if (!isMapping(doc) || !isMapping(doc.services)) return [[null, "has no top-level `services:` mapping"]];
  const gaps: LogGap[] = [];
  const bound = doc["x-logging"];
  const options = isMapping(bound) ? bound.options : undefined;
  const bounded = isMapping(bound) && bound.driver === "json-file" && isMapping(options)
    && /^[1-9]\d*[kmg]$/.test(String(options["max-size"])) && /^[1-9]\d*$/.test(String(options["max-file"]));
  if (!bounded) gaps.push([null, `x-logging is ${JSON.stringify(bound ?? null)}, not the json-file driver with a max-size (\`10m\`) and a max-file (\`3\`)`]);
  for (const [service, def] of Object.entries(doc.services)) {
    const logging = isMapping(def) ? def.logging : undefined;
    if (logging === undefined || JSON.stringify(logging) !== JSON.stringify(bound)) gaps.push([service, `names ${logging === undefined ? "no `logging:`" : `\`logging: ${JSON.stringify(logging)}\``}, not x-logging's bound`]);
  }
  return gaps;
}

const LOG_GOOD = `x-logging: &logging\n  driver: json-file\n  options:\n    max-size: "10m"\n    max-file: "3"\nservices:\n  server:\n    image: x\n    logging: *logging\n`;
/** [what, text, the services (null = x-logging) the rule reports]. */
const LOG_PROBES: [string, string, (string | null)[]][] = [
  ["every service bounded", LOG_GOOD, []],
  ["a service with no logging", `${LOG_GOOD}  extra:\n    image: y\n`, ["extra"]],
  ["a service with its own, larger bound", `${LOG_GOOD}  extra:\n    image: y\n    logging: {driver: json-file, options: {max-size: "1g", max-file: "3"}}\n`, ["extra"]],
  ["a service with no driver at all", `${LOG_GOOD}  extra:\n    image: y\n    logging: {driver: none}\n`, ["extra"]],
  ["x-logging with no max-size", LOG_GOOD.replace(`    max-size: "10m"\n`, ""), [null]],
  ["x-logging with no max-file", LOG_GOOD.replace(`    max-file: "3"\n`, ""), [null]],
  ["x-logging on the local driver", LOG_GOOD.replace("driver: json-file", "driver: local"), [null]],
  ["no x-logging, and nothing names one", `services:\n  server:\n    image: x\n`, [null, "server"]],
];

function checkBoundedLogs() {
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    fail(SELF, `check 29 parses deploy/compose.yaml with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-1849)`);
    return;
  }
  for (const [what, text, expected] of LOG_PROBES) {
    const got = unboundedLogsIn(text).map(([service]) => service);
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(SELF, `check 29 no longer reports exactly ${JSON.stringify(expected)} for its probe "${what}" (reported ${JSON.stringify(got)})`);
  }
  for (const [service, detail] of unboundedLogsIn(readFileSync(join(ROOT, "deploy/compose.yaml"), "utf8"))) {
    fail("deploy/compose.yaml", `${service === null ? "the file" : `service \`${service}\``}: ${detail} — every service names \`logging: *logging\`, so no container's log grows until the disk is full (SMD-1849)`);
  }
}
checkBoundedLogs();

// ── 30: no inspect template names a port binding's address field (SMD-2677) ──
//
// A Go template's field is the runtime's Go struct field, not the JSON key:
// a port binding's address is `HostIp` in docker's struct and `HostIP` in
// podman's, while both runtimes' JSON spell the key `HostIp`. deploy/canary.sh
// read it as `{{.HostIp}}`, which the docker CLI evaluates (against podman
// machine too) and podman's refuses: path-mode `up` ended on exit 125 under
// --runtime podman, and a connector check lost stable's LAN address from the
// hosts it matches. CI runs docker alone, so no job sees a template that only
// one CLI evaluates; this does. The address comes from `{{json .}}` of the
// binding, as canary.sh's bound_ip read it until SMD-2874 left it nothing to
// read.
/** A `{{ … }}` action naming `.HostIp` or `.HostIP` as a field: the action may span lines, not cross its closing `}}`. */
const HOST_IP_FIELD = /\{\{(?:[^}]|\}(?!\}))*?\.HostI[pP]/g;
/** [text, hit] — what check 30 must catch, and what it must not. */
const HOST_IP_PROBES: [string, boolean][] = [
  [`inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostIp}}{{"\\n"}}{{end}}{{end}}' "$1"`, true],
  ["podman inspect -f '{{ .HostIP }}' c", true],
  [`{{- (index (index .HostConfig.PortBindings "80/tcp") 0).HostIp -}}`, true],
  ["{{range $b}}{{\n  .HostIp\n}}{{end}}", true],
  [`inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{json .}}{{"\\n"}}{{end}}{{end}}' "$1"`, false],
  [`sed -n 's/.*"HostIp":"\\([^"]*\\)".*/\\1/p'`, false],
  ["(b ?? []).map((x) => `${service(c)}@${x.HostIp}`)", false],
  ["{{.HostPort}} — the field .HostIp, outside any action", false],
];
/** The 1-based lines of `text` where an action names the field, ascending: the line of the field itself, not of the action's `{{`. */
function hostIpFieldsIn(text: string): number[] {
  const lineOf = lineIndexer(text);
  return [...new Set([...text.matchAll(HOST_IP_FIELD)].map((m) => lineOf(m.index! + m[0].length - 1)))];
}
function checkHostIpTemplates() {
  for (const [probe, hit] of HOST_IP_PROBES) {
    const n = hostIpFieldsIn(probe).length;
    if (hit && n === 0) fail(SELF, `check 30 no longer catches its probe: ${JSON.stringify(probe)} (its own probe)`);
    if (!hit && n > 0) fail(SELF, `check 30 catches a non-probe: ${JSON.stringify(probe)} (its own probe)`);
  }
  const files = citationFiles();
  if (!files.includes("deploy/canary.sh")) fail(SELF, "check 30's listing does not reach deploy/canary.sh — the listing is broken, not the tree clean");
  for (const rel of files) {
    for (const line of hostIpFieldsIn(readFileSync(join(ROOT, rel), "utf8"))) {
      fail(`${rel}:${line}`, "a Go template names a port binding's address field — `.HostIp` is docker's struct field and `.HostIP` podman's, so the template fails under the other CLI (SMD-2677); read the binding's JSON, whose key both spell HostIp, as deploy/instance.ts's portsFromBindings does");
    }
  }
}
checkHostIpTemplates();

// ── Check 31: a plugin's code stays in its schema, its role and the SDK (SMD-2310) ──
//
// A plugin runs in the brain's servers. Its SQL runs on a connection logged
// in as ob1_plugins, then under SET LOCAL ROLE to its own role with its schema
// first on the path (db/migrate.ts, store-sql.ts's pluginTx), and Postgres
// refuses both roles the core's tables: that is the boundary. This check is
// the accident guard in front of it — code that would read like an attempt
// to leave it fails a push, so it is seen in review — not a sandbox: a
// plugin's TypeScript runs in the server's process, and curation is what
// holds hostile code (plugins/README.md). It reads:
//  - its SQL, a migration file or a TAGGED template literal in its
//    TypeScript (found by a lexer, `${…}` and nested templates included):
//    no core table's name anywhere (db/migrations/' CREATE TABLEs and the two
//    ledgers), no schema but its own (`public.`, another plugin's, pg_temp),
//    no Unicode-escaped name; no role, session or transaction change — SET or
//    RESET of role, session_authorization or search_path (quoted or not),
//    RESET ALL, set_config, SET SESSION, a temp object, a session advisory
//    lock, a cursor WITH HOLD, LISTEN, DISCARD, and outside a plpgsql body
//    BEGIN, END, ABORT, COMMIT, ROLLBACK (but ROLLBACK TO), START
//    TRANSACTION, PREPARE and EXECUTE as statements; inside one, EXECUTE
//    (dynamic SQL this check cannot read), COMMIT and ROLLBACK;
//  - its TypeScript: imports of the SDK and its own directory's files alone
//    (static, re-exported or bare), none of a test file from code that is not
//    one, and no global that reaches past ctx — fetch, eval, Function,
//    Reflect, globalThis, self, Bun, process, Deno, require, Worker,
//    WebSocket, XMLHttpRequest, EventSource, import() — by name, aliased or not;
//  - its directory: TypeScript, its migrations, a README and metadata.json,
//    nothing else; plugins/registry.ts imports and lists exactly the plugin
//    directories; a manifest's name is its directory's; migration files are
//    named by the core's rule;
//  - its GUI pages (SMD-2280 PR 3), which the GUI renders, since a plugin's
//    directory holds no Svelte: each page its manifest declares has its route
//    at dashboard/src/routes/plugins/<name><path>/, a +page.svelte and a
//    +page.server.ts alone, which awaits pluginAccess and reaches the brain by
//    nothing else (no other server module, fetch, process, locals,
//    import.meta or import()), so a disabled plugin's page is a 404 before any
//    call; and no route there is a page no manifest declares.

/** The core's tables: every CREATE TABLE in db/migrations/, uncommented, and the two ledgers. */
function coreTables(): Set<string> {
  const names = new Set(["schema_migrations", "plugin_migrations"]);
  const dir = join(ROOT, "db", "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql"))) {
    for (const m of sqlUncommented(readFileSync(join(dir, f), "utf8")).matchAll(/\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?/gi)) names.add(m[1].toLowerCase());
  }
  return names;
}

/** A plugin SQL hit: its line and what it does. */
type PluginHit = { line: number; what: string };

/** SQL with its comments and single-quoted strings blanked (sqlUncommented), its quoted identifiers read bare, and each dollar-quoted body marked: [start, end) spans. */
function pluginSqlCode(sqlText: string): { code: string; bodies: [number, number][] } {
  // A quoted identifier is its name: "role" is role, and "public"."thoughts" public.thoughts. Same length, so lines keep.
  const code = sqlUncommented(sqlText).replace(/"([^"]*)"/g, (_m, name: string) => ` ${name} `);
  const bodies: [number, number][] = [];
  const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(code))) {
    const close = code.indexOf(m[0], m.index + m[0].length);
    if (close < 0) break;
    bodies.push([m.index + m[0].length, close]);
    open.lastIndex = close + m[0].length;
  }
  return { code, bodies };
}

/** What a plugin's SQL reaches past its schema or its role for, one hit per finding. Pure over a text. */
function pluginSqlProblems(sqlText: string, core: ReadonlySet<string>, firstLine = 1): PluginHit[] {
  const { code, bodies } = pluginSqlCode(sqlText);
  const hits: PluginHit[] = [];
  const at = (index: number) => firstLine + code.slice(0, index).split("\n").length - 1;
  const inBody = (index: number) => bodies.some(([a, b]) => index >= a && index < b);
  const hit = (index: number, what: string) => hits.push({ line: at(index), what });
  // A Unicode-escaped name or string spells anything; nothing a plugin needs.
  // Read after the quotes are gone (pluginSqlCode), so the prefix alone: U& before a name or a string.
  for (const x of code.matchAll(/\bU&/gi)) hit(x.index!, "spells a name or string with U& escapes, which this check cannot read");
  for (const x of code.matchAll(/(?<![\w$.])([a-z_][a-z0-9_]*)(?![\w$])/gi)) {
    if (core.has(x[1].toLowerCase())) hit(x.index!, `names the core table ${x[1]}`);
  }
  for (const x of code.matchAll(/(?<![\w$])(public|plugin_[a-z0-9_]+|pg_temp[a-z0-9_]*)\s*\.\s*[a-z_]/gi)) hit(x.index!, `qualifies a name with the schema ${x[1]}: a plugin names its own tables bare, and no other schema's`);
  const SESSION: [RegExp, string][] = [
    [/\b(?:SET|RESET)\s+(?:LOCAL\s+|SESSION\s+)?(?:ROLE|SESSION_AUTHORIZATION|SESSION\s+AUTHORIZATION|SEARCH_PATH)\b/gi, "changes the role or the search path"],
    [/\bRESET\s+ALL\b/gi, "resets every setting, the role among them"],
    [/\bset_config\b/gi, "calls set_config, which sets the role or the path by name"],
    [/\bSET\s+SESSION\b/gi, "sets a setting for the session, past the transaction"],
    [/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY)\b/gi, "makes a temp object, which outlives the transaction and is searched before any schema"],
    [/\bpg_(?:try_)?advisory_(?:lock|unlock)(?:_shared|_all)?\b/gi, "takes or drops a session advisory lock, which outlives the transaction"],
    [/\bWITH\s+HOLD\b/gi, "holds a cursor past the transaction"],
    [/\bLISTEN\b/gi, "listens on the session, past the transaction"],
    [/\bDISCARD\b/gi, "discards session state"],
  ];
  for (const [re, what] of SESSION) for (const x of code.matchAll(re)) hit(x.index!, what);
  // Statements outside a plpgsql body; a body's BEGIN … END is its block.
  for (const x of code.matchAll(/(?:^|;)\s*(BEGIN|END|ABORT|COMMIT|ROLLBACK(?!\s+TO\b)|START\s+TRANSACTION|PREPARE|EXECUTE)\b/gi)) {
    const i = x.index! + x[0].indexOf(x[1]);
    if (!inBody(i)) hit(i, `runs ${x[1].replace(/\s+/g, " ").toUpperCase()} as a statement, which ends or works around the transaction the plugin's role holds in`);
  }
  // Inside a body: dynamic SQL, which this check cannot read, and a procedure's transaction control.
  for (const x of code.matchAll(/\b(EXECUTE|COMMIT|ROLLBACK(?!\s+TO\b))\b/gi)) {
    if (inBody(x.index!)) hit(x.index!, `runs ${x[1].toUpperCase()} in a plpgsql body: dynamic SQL or a transaction change this check cannot read`);
  }
  return hits;
}

/** A tagged template literal in TypeScript: its text, `${…}` read as one placeholder, and where it starts. Untagged ones (UI and log text) are not SQL. */
function taggedTemplates(text: string): { body: string; index: number }[] {
  const found: { body: string; index: number }[] = [];
  const NOT_TAGS = new Set(["return", "typeof", "case", "in", "of", "yield", "await", "new", "throw", "else", "do", "void", "delete", "instanceof"]);
  let i = 0;
  // Scans from i to the end of one template (i at its opening backtick); returns its body and the index after it.
  const template = (start: number): { body: string; end: number } => {
    let body = "";
    let j = start + 1;
    while (j < text.length) {
      const ch = text[j];
      if (ch === "\\") { body += text.slice(j, j + 2); j += 2; continue; }
      if (ch === "`") return { body, end: j + 1 };
      if (ch === "$" && text[j + 1] === "{") { body += "$1"; j = expression(j + 2); continue; }
      body += ch;
      j++;
    }
    return { body, end: j };
  };
  // Scans a `${…}` expression from j to just past its closing brace, reading the templates inside it too.
  const expression = (from: number): number => {
    let depth = 1;
    let j = from;
    while (j < text.length && depth > 0) {
      const ch = text[j];
      if (ch === "'" || ch === '"') { j = quoted(j); continue; }
      if (ch === "`") { const t = template(j); record(j, t.body); j = t.end; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    return j;
  };
  const quoted = (from: number): number => {
    const q = text[from];
    let j = from + 1;
    while (j < text.length && text[j] !== q && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
    return j + 1;
  };
  const record = (index: number, body: string) => {
    const before = text.slice(0, index).replace(/\s+$/, "");
    const word = before.match(/[A-Za-z_$][\w$]*$/)?.[0];
    // A tag is a name, a call or index result, or a name with type arguments (sql<Row>`…`).
    const tagged = word ? !NOT_TAGS.has(word) : /[)\]>]$/.test(before);
    if (tagged) found.push({ body, index });
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (ch === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 2; continue; }
    if (ch === "'" || ch === '"') { i = quoted(i); continue; }
    if (ch === "`") { const t = template(i); record(i, t.body); i = t.end; continue; }
    i++;
  }
  return found;
}

/** The SDK, the one module outside its directory a plugin may import. */
const PLUGIN_SDK = "../../server-portable/plugin-sdk.ts";
/** A test file, by the tree's spelling. */
const PLUGIN_TEST_FILE = /(^|\/)(test-[^/]+|[^/]+\.test)\.ts$/;
/** The globals that reach past ctx — by name, so an alias of one is caught where it is taken. */
const PLUGIN_GLOBALS = /(?<![\w$.])(fetch|eval|Function|Reflect|globalThis|self|Bun|process|Deno|require|Worker|SharedWorker|WebSocket|XMLHttpRequest|EventSource)(?![\w$])|(?<![\w$.])import\s*\(/g;

/** What a plugin's TypeScript reaches for, one hit per finding. `registry`: plugins/registry.ts, which imports each plugin's index.ts. Pure over a text. */
function pluginTsProblems(text: string, core: ReadonlySet<string>, opts: { registry?: boolean; testFile?: boolean } = {}): PluginHit[] {
  const hits: PluginHit[] = [];
  const lineAt = (index: number) => text.slice(0, index).split("\n").length;
  const code = blanked(text, true);
  const commentsGone = blanked(text, false);
  const imports = [
    ...[...commentsGone.matchAll(/\b(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']/g)],
    ...[...commentsGone.matchAll(/(?<![\w$.])import\s*["']([^"']+)["']/g)],
  ];
  for (const m of imports) {
    const spec = m[1];
    const allowed = opts.registry
      ? spec === "../server-portable/plugin-sdk.ts" || /^\.\/[a-z0-9-]+\/index\.ts$/.test(spec)
      : spec === PLUGIN_SDK || (spec.startsWith("./") && !spec.includes("..") && spec.endsWith(".ts"));
    if (!allowed) hits.push({ line: lineAt(m.index!), what: `imports ${spec}: a plugin imports ${PLUGIN_SDK} and its own directory's .ts files alone` });
    else if (!opts.testFile && PLUGIN_TEST_FILE.test(spec)) hits.push({ line: lineAt(m.index!), what: `imports the test file ${spec} from code that runs in the server` });
  }
  for (const m of code.matchAll(PLUGIN_GLOBALS)) {
    hits.push({ line: lineAt(m.index!), what: `uses ${m[0].replace(/\s+/g, "")}: a plugin reaches the brain through ctx.call and its tables through ctx.db, nothing else (a local of that name is renamed)` });
  }
  for (const t of taggedTemplates(commentsGone)) {
    for (const h of pluginSqlProblems(t.body, core, lineAt(t.index))) hits.push(h);
  }
  return hits;
}

const PLUGIN_PROBES: [string, "sql" | "ts", boolean][] = [
  // Its SQL, in a handler's tagged template.
  ["const r = await sql`SELECT count(*) FROM thoughts`;", "ts", true],
  ["const r = await sql`SELECT * FROM notes WHERE id = ${id}`;", "ts", false],
  ["const rows = await q<{ n: number }>`SELECT count(*) FROM thoughts`;", "ts", true],
  ["const r = await sql`SELECT * FROM notes n, ${\"x\"} WHERE ${`a ${b}`} = 1 AND id IN (SELECT id FROM thought_audit)`;", "ts", true],
  ["// SELECT * FROM thoughts\nconst x = 1;", "ts", false],
  ["const tick = \"`\";\nawait sql`RESET ROLE`;", "ts", true],
  ["await sql`INSERT INTO public.notes VALUES (1)`;", "ts", true],
  ["await sql`RESET ROLE`;", "ts", true],
  ["await sql`SET \"role\" = 'postgres'`;", "ts", true],
  ["await sql`SELECT pg_catalog.set_config('role', 'none', true)`;", "ts", true],
  ["await sql`SET session_authorization = DEFAULT`;", "ts", true],
  ["await sql`END; SELECT 1`;", "ts", true],
  ["await sql`ABORT`;", "ts", true],
  ["await sql`SELECT * FROM notes, U&\"\\0074houghts\"`;", "ts", true],
  ["await sql`DO $$ BEGIN EXECUTE 'RES' || 'ET ROLE'; END $$`;", "ts", true],
  // Text that is not SQL: an untagged template is UI or log text.
  ["log(`could not commit ${id}: prepare your notes, then listen`);", "ts", false],
  ["throw new Error(`skipped ${n} rows from jobs`);", "ts", false],
  ["return `FROM thoughts`;", "ts", false],
  // Its imports and globals.
  ["import { db } from \"../../server-portable/root.ts\";", "ts", true],
  ["import \"../../server-portable/store-sql.ts\";", "ts", true],
  ["export * from \"../../server-portable/root.ts\";", "ts", true],
  ["import { definePlugin, z } from \"../../server-portable/plugin-sdk.ts\";\nimport { helper } from \"./helper.ts\";", "ts", false],
  ["import { helper } from \"./helper.js\";", "ts", true],
  ["import { reset } from \"./test-backdoor.ts\";", "ts", true],
  ["import x from \"../other/index.ts\";", "ts", true],
  ["const r = await fetch(\"https://example.com\");", "ts", true],
  ["const f = fetch;", "ts", true],
  ["const g = globalThis[\"fe\" + \"tch\"];", "ts", true],
  ["const { env } = process;", "ts", true],
  ["(0, eval)(\"1\");", "ts", true],
  ["new Worker(\"./w.ts\");", "ts", true],
  ["const m = await import(name);", "ts", true],
  ["const s = \"fetch( is only text\";", "ts", false],
  ["const n = ctx.caller.name; const r = await ctx.call(\"fetch\", { id });", "ts", false],
  // Its migrations.
  ["CREATE TABLE IF NOT EXISTS notes (id uuid PRIMARY KEY);", "sql", false],
  ["-- FROM thoughts, in a comment\nCREATE TABLE IF NOT EXISTS notes (id int);", "sql", false],
  ["CREATE TABLE IF NOT EXISTS peek AS SELECT id FROM thoughts;", "sql", true],
  ["CREATE TABLE x (id uuid REFERENCES thought_audit (id));", "sql", true],
  ["SELECT * FROM notes, thoughts;", "sql", true],
  ["SELECT * FROM notes JOIN \"thoughts\" t ON true;", "sql", true],
  ["DO $$ BEGIN RAISE NOTICE 'x'; END $$;", "sql", false],
  ["CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $fn$\nBEGIN\n  NEW.updated_at := now();\n  RETURN NEW;\nEND;\n$fn$;", "sql", false],
  ["DO $$ BEGIN EXECUTE 'RESET ROLE'; END $$;", "sql", true],
  ["CREATE TABLE a (id int);\nCOMMIT;\nDROP TABLE thoughts;", "sql", true],
  ["CREATE TABLE a (id int);\nEND;\nSELECT 1;", "sql", true],
  ["BEGIN;\nCREATE TABLE a (id int);", "sql", true],
  ["CREATE TEMP TABLE shadow (x int);", "sql", true],
  ["SELECT pg_advisory_lock(1);", "sql", true],
  ["SELECT pg_advisory_xact_lock(1);", "sql", false],
  ["CREATE TABLE readings (temp numeric, prepared boolean);", "sql", false],
  ["SAVEPOINT a; ROLLBACK TO SAVEPOINT a;", "sql", false],
  ["CREATE TABLE b (id int); SELECT * FROM plugin_other.items;", "sql", true],
  ["SELECT 'FROM thoughts' AS text;", "sql", false],
  ["RESET \"role\";", "sql", true],
];

/** Where the GUI renders a plugin's pages (SMD-2280 PR 3): under this, one directory per page, `<name><path>/`. */
const PLUGIN_ROUTES = "dashboard/src/routes/plugins";
/** The files a plugin page's route holds: its markup, and the server load that reaches the plugin through pluginAccess. A `+server.ts`, a `+page.ts` or a layout would answer without it. */
const PLUGIN_ROUTE_FILES = new Set(["+page.svelte", "+page.server.ts"]);
/**
 * What a plugin page's server load may import: SvelteKit's, the GUI's own
 * modules but the server ones, and of those pluginAccess's alone — so it reaches
 * the brain only through the access the gate hands back, never rest.ts or the
 * REST client.
 */
const PLUGIN_PAGE_IMPORT = /^(?:@sveltejs\/kit|\$app\/(?:paths|navigation|environment|forms|state)|\.\/\$types|\$lib\/server\/plugins|\$lib\/(?!server\/)[\w/.-]+)$/;
/** A page's path as the core holds it (core/plugins.ts's GUI_PATH): checked first, so a malformed one is said as such, not as a route to make. */
const GUI_PAGE_PATH = /^(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
/** A `.` or `..` segment, which would spell a server module another way (`$lib/./server/rest`): refused in any import (review pass 3). */
const DOT_SEGMENT = /(?:^|\/)\.{1,2}(?:\/|$)/;
/** What reaches past pluginAccess with no import: a global or a module's own reach (review pass 3: a bare fetch with the session's key needed none). */
const PLUGIN_PAGE_REACH = /\b(?:fetch|process|require|globalThis|Bun|locals)\b|\bimport\s*\.\s*meta\b|\bimport\s*\(/;

/**
 * A plugin's GUI pages against the GUI's routes for them, each problem where it
 * is found. `declared`: each plugin's page paths, as its manifest's `gui.pages`
 * names them; `files`: every file under PLUGIN_ROUTES, by its path there, and
 * its text. Each declared path is a page path (said as such first); each
 * declared page has its directory, `<name><path>/`, holding a `+page.svelte`
 * and a `+page.server.ts` and nothing else, and none is a page no manifest
 * declares. The server file awaits pluginAccess(event) — the page's 404
 * unless the registry lists its route's page to the key, then the plugin's
 * operations — and reaches the brain by nothing else, so no load or action
 * calls the plugin ungated. Per page, not a layout: a layout's load is skipped
 * on a __data.json request that does not ask for it. Pure.
 */
function pluginPageProblems(declared: Record<string, string[]>, files: Record<string, string>): { where: string; what: string }[] {
  const problems: { where: string; what: string }[] = [];
  for (const [name, paths] of Object.entries(declared)) for (const path of paths) if (!GUI_PAGE_PATH.test(path)) problems.push({ where: `plugins/${name}/index.ts`, what: `declares the page ${JSON.stringify(path)}, which is no page path: segments of lower-case words and hyphens, each after a slash ("/notes", "/notes/all"), as the server holds them (bun test-plugins.ts in server-portable/ says the same)` });
  const pages = new Set(Object.entries(declared).flatMap(([name, paths]) => paths.filter((path) => GUI_PAGE_PATH.test(path)).map((path) => `${name}${path}`)));
  for (const page of pages) {
    for (const f of PLUGIN_ROUTE_FILES) if (!(`${page}/${f}` in files)) problems.push({ where: `${PLUGIN_ROUTES}/${page}`, what: `no ${f}: the plugin's manifest declares this page, and the GUI renders each declared page from its route here, its load reaching the plugin through pluginAccess` });
    const load = files[`${page}/+page.server.ts`];
    if (load === undefined) continue;
    // Strings kept to read the imports' specifiers; blanked too, so a string spelling a call or a name is neither.
    const code = blanked(load, false);
    const bare = blanked(load, true);
    const where = `${PLUGIN_ROUTES}/${page}/+page.server.ts`;
    if (!/\bawait\s+pluginAccess\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(bare)) problems.push({ where, what: "does not await pluginAccess(event) — the load's or action's own event, so the page gates on its own route: a plugin page reaches its plugin through the access the gate hands back, so a disabled plugin's page is a 404 before any call" });
    const imports = [...code.matchAll(/\b(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);
    for (const spec of imports) if (!PLUGIN_PAGE_IMPORT.test(spec) || (spec !== "./$types" && DOT_SEGMENT.test(spec))) problems.push({ where, what: `imports ${JSON.stringify(spec)}: a plugin page's load reaches the brain through pluginAccess alone ($lib/server/plugins), never rest.ts or the REST client` });
    const reach = PLUGIN_PAGE_REACH.exec(bare);
    if (reach) problems.push({ where, what: `names ${JSON.stringify(reach[0].replace(/\s+/g, ""))}: a plugin page's load reaches the brain through pluginAccess alone — no fetch, process, require, globalThis, Bun, locals, import.meta or import() — so this check reads all it reaches` });
  }
  for (const rel of Object.keys(files)) {
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const file = rel.slice(rel.lastIndexOf("/") + 1);
    if (!pages.has(dir)) problems.push({ where: `${PLUGIN_ROUTES}/${rel}`, what: "is in no page a plugin's manifest declares (gui.pages): the nav would never name it, and a plugin page holds its +page.svelte and +page.server.ts alone" });
    else if (!PLUGIN_ROUTE_FILES.has(file)) problems.push({ where: `${PLUGIN_ROUTES}/${rel}`, what: "a plugin page's route holds its +page.svelte and +page.server.ts alone: a +server.ts, a +page.ts or a layout would answer without pluginAccess" });
  }
  return problems;
}

/** pluginPageProblems' probes: each declared, files and how many problems. */
const GATED = "import { fail } from '@sveltejs/kit';\nimport { base } from '$app/paths';\nimport type { PageServerLoad } from './$types';\nimport { oneLine } from '$lib/format';\nimport { pluginAccess } from '$lib/server/plugins';\nexport const load = async (event) => { const ex = await pluginAccess(event); return {}; };";
const PLUGIN_PAGE_PROBES: [Record<string, string[]>, Record<string, string>, number][] = [
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED }, 0],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "" }, 1],
  [{ example: ["/notes"] }, {}, 2],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": "export const load = async (event) => { pluginAccess(event); return {}; };" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": "// await pluginAccess(event)\nexport const load = () => ({});" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED + "\nimport { read } from '$lib/server/rest';" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED + "\nimport { createRestClient } from '../../../../../../rest-client/index.ts';" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED + "\nexport { read } from '$lib/server/rest';" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED + "\nconst m = await import('$lib/server/rest');" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED + "\nimport { read } from '$lib/./server/rest';" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED + "\nimport { read } from '$lib/../lib/server/rest';" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED + "\nconst m = import.meta.glob('/src/lib/server/rest.ts', { eager: true });" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED + "\nconst r = await fetch('http://api/v1/plugins/example/notes');" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED + "\nconst k = event.locals.session;" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": "const s = 'await pluginAccess(';\nexport const load = () => ({});" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED + "\nconst words = 'a fetch of the notes';" }, 0],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED, "example/notes/+server.ts": "" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED, "example/notes/+page.ts": "" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED, "example/other/+page.svelte": "" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED, "+layout.server.ts": "" }, 1],
  [{}, { "example/notes/+page.svelte": "" }, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED + "\nimport { getRequestEvent } from '$app/server';" }, 1],
  [{ example: ["recent/"] }, {}, 1],
  [{ example: [""] }, {}, 1],
  [{ example: ["/notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": "export const load = async (event) => { await pluginAccess({ ...event, route: { id: '/plugins/other/x' } }); };" }, 1],
  [{ example: ["/notes", "Notes"] }, { "example/notes/+page.svelte": "", "example/notes/+page.server.ts": GATED }, 1],
];

async function checkPlugins() {
  const { migrationNameProblem } = await import("../db/config.mjs");
  const core = coreTables();
  if (!core.has("thoughts") || core.size < 10) fail(SELF, `check 31 reads ${core.size} core tables from db/migrations/ (thoughts ${core.has("thoughts") ? "among them" : "missing"}) — the reader is broken, not the plugins clean`);
  for (const [probe, kind, hit] of PLUGIN_PROBES) {
    const found = kind === "sql" ? pluginSqlProblems(probe, core) : pluginTsProblems(probe, core);
    if (hit && found.length === 0) fail(SELF, `check 31 no longer catches its probe: ${JSON.stringify(probe)}`);
    if (!hit && found.length > 0) fail(SELF, `check 31 catches a non-probe: ${JSON.stringify(probe)} — ${found.map((h) => h.what).join("; ")}`);
  }
  const coreGuiPath = /\bconst GUI_PATH = \/(.+)\/;/.exec(readFileSync(join(ROOT, "server-portable", "core", "plugins.ts"), "utf8"))?.[1];
  if (coreGuiPath !== GUI_PAGE_PATH.source) fail(SELF, `check 31's GUI_PAGE_PATH (${GUI_PAGE_PATH.source}) is not server-portable/core/plugins.ts's GUI_PATH (${coreGuiPath ?? "not found"}): the copy is held to the core's`);
  for (const [declared, files, n] of PLUGIN_PAGE_PROBES) {
    const found = pluginPageProblems(declared, files);
    if (found.length !== n) fail(SELF, `check 31's page rule finds ${found.length} problem(s), not ${n}, in its probe ${JSON.stringify(files)}: ${found.map((h) => h.what).join("; ")}`);
  }
  const base = join(ROOT, "plugins");
  if (!existsSync(base)) return;
  const dirs = readdirSync(base).filter((d) => statSync(join(base, d)).isDirectory() && !d.startsWith(".") && d !== "node_modules");
  /** Each plugin's GUI page paths, read from its manifest (`gui: { pages: [{ path: "…", … }] }`). */
  const declared: Record<string, string[]> = {};
  // The registry: exactly the directories, each by its index.ts, each in PLUGINS; held to the plugin rules itself.
  const registryPath = join(base, "registry.ts");
  const registry = existsSync(registryPath) ? readFileSync(registryPath, "utf8") : "";
  if (!registry) fail("plugins/registry.ts", "no registry: the server imports every plugin from plugins/registry.ts");
  for (const h of pluginTsProblems(registry, core, { registry: true })) fail(`plugins/registry.ts:${h.line}`, `${h.what} (check 31, SMD-2310)`);
  const registryCode = blanked(registry, false);
  const imported = new Map<string, string>();
  for (const m of registryCode.matchAll(/\bimport\s+(?!type\b)([A-Za-z_$][\w$]*)\s+from\s*["']\.\/([^/"']+)\/index\.ts["']/g)) imported.set(m[2], m[1]);
  const listed = new Set([...(registryCode.match(/\bPLUGINS\b[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
  for (const d of dirs) {
    const where = `plugins/${d}`;
    const index = join(base, d, "index.ts");
    if (!existsSync(index)) { fail(where, "no index.ts: a plugin's manifest is its index.ts"); continue; }
    const binding = imported.get(d);
    if (!binding) fail("plugins/registry.ts", `does not import ./${d}/index.ts: a plugin the registry does not import is one no server runs`);
    else if (!listed.has(binding)) fail("plugins/registry.ts", `imports ./${d}/index.ts as ${binding} but PLUGINS does not list it`);
    const manifest = blanked(readFileSync(index, "utf8"), false);
    const name = manifest.match(/\bdefinePlugin\s*\(\s*\{[\s\S]*?\bname:\s*["']([^"']+)["']/)?.[1];
    // The literal shape the example writes: a pages list held elsewhere, or a `]` inside a label, reads as no page — a
    // loud false positive (its route then "declared by no manifest"), never a silent pass; the core's own check rules.
    declared[d] = [...(manifest.match(/\bgui\s*:\s*\{\s*pages\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? "").matchAll(/\bpath\s*:\s*["']([^"']*)["']/g)].map((m) => m[1]);
    if (name !== d) fail(`${where}/index.ts`, `its manifest's name is ${JSON.stringify(name ?? null)}, not its directory's (${d}): OB1_PLUGINS, the migrator and the server name a plugin by one name`);
    // Every file in the directory: TypeScript, its migrations, a README and metadata.json — a .js file is code this check would not read.
    // Every file, dotfiles included: Bun imports `./.helper.ts`, so a dotfile is code this check must refuse (review pass 4).
    // Finder's .DS_Store alone is passed over: no runtime imports it as code (review pass 5).
    const files = walk(join(base, d), [], /^(?!\.DS_Store$)/).filter((f) => !f.includes(`${sep}node_modules${sep}`));
    const migrationFiles: string[] = [];
    for (const f of files) {
      const rel = relative(join(base, d), f).split(sep).join("/");
      if (/^migrations\/[^/]+\.sql$/.test(rel)) { migrationFiles.push(rel.slice("migrations/".length)); continue; }
      if (rel === "README.md" || rel === "metadata.json") continue;
      if (!rel.endsWith(".ts") || rel.endsWith(".d.ts")) { fail(`${where}/${rel}`, "a plugin holds TypeScript, its migrations/*.sql, a README.md and a metadata.json, nothing else: a file of another kind is code or data this check does not read (check 31, SMD-2310)"); continue; }
      for (const h of pluginTsProblems(readFileSync(f, "utf8"), core, { testFile: PLUGIN_TEST_FILE.test(rel) })) fail(`${where}/${rel}:${h.line}`, `${h.what} (check 31, SMD-2310)`);
    }
    const problem = migrationNameProblem(migrationFiles);
    if (problem) fail(`${where}/migrations`, problem);
    for (const f of migrationFiles) {
      for (const h of pluginSqlProblems(readFileSync(join(base, d, "migrations", f), "utf8"), core)) fail(`${where}/migrations/${f}:${h.line}`, `${h.what} (check 31, SMD-2310)`);
    }
  }
  for (const d of imported.keys()) if (!dirs.includes(d)) fail("plugins/registry.ts", `imports ./${d}/index.ts, which is no plugin directory`);
  // The GUI's routes for the pages: one directory each, asking the registry, and none undeclared (SMD-2280 PR 3).
  const routes = join(ROOT, ...PLUGIN_ROUTES.split("/"));
  const files: Record<string, string> = {};
  // A dotfile (Finder's .DS_Store, an editor's swap file) is no route: skipped here, where the import rule refuses relative imports; the plugin walk reads them.
  if (existsSync(routes)) for (const f of walk(routes, [], /^[^.]/)) files[relative(routes, f).split(sep).join("/")] = readFileSync(f, "utf8");
  for (const h of pluginPageProblems(declared, files)) fail(h.where, `${h.what} (check 31, SMD-2280)`);
}
await checkPlugins();

// ── 32. Every service's restart policy is held (SMD-2760) ────────────────────
//
// What comes back after a reboot is each container's restart policy: Docker
// starts its `unless-stopped` containers when the daemon starts, and podman's
// podman-restart.service, where enabled, starts those not stopped by hand.
// deploy/compose.yaml's postgres had none, so on Docker the servers would come
// back without their database; on podman, its unit disabled too, nothing came
// back, and the dogfood stack stayed down ~47 minutes on 2026-10-09.
// RESTART_POLICIES holds each service's policy by value: what serves is
// `unless-stopped`, what runs once is "no". The followers — board-sync, the
// two claim workers, the sleep scheduler — were `on-failure:3`, so that a
// refusal stopped rather than looped, and neither runtime starts that policy
// at boot: on 2026-10-22 both brains' sleep and stable's board-sync stayed
// down after a podman machine restart (SMD-3214). Since SMD-3476 they are
// children of one `unless-stopped` service, the coordinator
// (db/coordinator.ts), each through db/supervise.ts, which holds a refusal
// itself: a follower run any other way under that policy is the crash loop
// again, so supervisorGapsIn holds every command. jev is `unless-stopped` too,
// since it retries its own start (jev/serve.ts, SMD-3214 PR 3): it is no
// db/ follower, and its image has no db/. A service added, or a policy
// changed, is a change there on purpose. The overlays name no restart (check 28's OVERLAYS),
// so this file is the one to read.
/** Each compose.yaml service's `restart`, exactly. */
const RESTART_POLICIES: Record<string, string> = {
  postgres: "unless-stopped", migrate: "no", api: "unless-stopped", mcp: "unless-stopped", app: "unless-stopped", proxy: "unless-stopped", forwarder: "unless-stopped", breakglass: "unless-stopped",
  coordinator: "unless-stopped",
  ollama: "unless-stopped", "ollama-pull": "no", jev: "unless-stopped",
  n8n: "unless-stopped", "orchestration-runner-role": "no", "orchestration-runner": "unless-stopped", auth: "unless-stopped",
  lgtm: "unless-stopped", "pg-monitor-role": "no", "pg-exporter": "unless-stopped",
};
/** Where a compose file's services stray from `held`: [the service (null for the file), what is wrong]. */
function restartGapsIn(text: string, held: Record<string, string>): [service: string | null, detail: string][] {
  let doc: unknown;
  try { doc = Bun.YAML.parse(text); } catch (e) { return [[null, `does not parse: ${(e as Error).message}`]]; }
  if (!isMapping(doc) || !isMapping(doc.services)) return [[null, "has no top-level `services:` mapping"]];
  const gaps: [string | null, string][] = [];
  for (const [service, def] of Object.entries(doc.services)) {
    const restart = isMapping(def) ? def.restart : undefined;
    const shown = restart === undefined ? "unset, which is \"no\"" : JSON.stringify(restart);
    if (!(service in held)) gaps.push([service, `not in check 32's RESTART_POLICIES (its restart is ${shown})`]);
    else if (restart !== held[service]) gaps.push([service, `restart ${shown} where check 32's RESTART_POLICIES holds ${JSON.stringify(held[service])}`]);
  }
  for (const service of Object.keys(held)) if (!(service in doc.services)) gaps.push([service, "held in check 32's RESTART_POLICIES and not in the file"]);
  return gaps;
}
const FOLLOWER_SCRIPT = /\bdb\/(sleep|extract-entities|consolidate|sync-linear)\.ts\b/;
/** The coordinator's command, exactly, under the server image's `bun --no-install`: OB1_PASSES, not its argv, says what it runs. */
const COORDINATOR_COMMAND = ["db/coordinator.ts"];
/**
 * Where a compose file runs a db/ follower other than as the coordinator's
 * child (SMD-3214, SMD-3476): no command names one, and the `coordinator`
 * service's command is COORDINATOR_COMMAND, which runs each through
 * db/supervise.ts.
 */
function supervisorGapsIn(text: string): [service: string | null, detail: string][] {
  let doc: unknown;
  try { doc = Bun.YAML.parse(text); } catch (e) { return [[null, `does not parse: ${(e as Error).message}`]]; }
  if (!isMapping(doc) || !isMapping(doc.services)) return [[null, "has no top-level `services:` mapping"]];
  const gaps: [string | null, string][] = [];
  for (const [service, def] of Object.entries(doc.services)) {
    const cmd = isMapping(def) ? def.command : undefined;
    const words = Array.isArray(cmd) ? cmd.map(String) : typeof cmd === "string" ? [cmd] : [];
    const script = words.map((w) => FOLLOWER_SCRIPT.exec(w)?.[1]).find((m) => m !== undefined);
    if (script !== undefined) gaps.push([service, `runs db/${script}.ts itself, not as a child of the coordinator (db/coordinator.ts, OB1_PASSES), whose supervisor holds a refusal that \`unless-stopped\` would restart in a loop`]);
    else if (service === "coordinator" && JSON.stringify(words) !== JSON.stringify(COORDINATOR_COMMAND)) gaps.push([service, `its command is ${JSON.stringify(cmd ?? null)}, not ${JSON.stringify(COORDINATOR_COMMAND)}: OB1_PASSES says what it runs`]);
  }
  return gaps;
}
const SUPERVISED = `services:\n  coordinator:\n    command: ["db/coordinator.ts"]\n  other:\n    command: ["bun", "serve.ts"]\n`;
/** [what, text, the services (null = the file) the rule reports]. */
const SUPERVISOR_PROBES: [string, string, (string | null)[]][] = [
  ["the coordinator, beside a service that runs no follower", SUPERVISED, []],
  ["the sh -c of before SMD-3214", `${SUPERVISED}  sleep:\n    command: ["sh", "-c", "exec bun db/sleep.ts --follow"]\n`, ["sleep"]],
  ["a follower as the whole command", `${SUPERVISED}  board-sync:\n    command: ["bun", "db/sync-linear.ts", "--loop"]\n`, ["board-sync"]],
  ["a follower in a string command", `${SUPERVISED}  consolidate:\n    command: bun db/consolidate.ts --follow\n`, ["consolidate"]],
  ["a supervisor of before SMD-3476, a service of its own", `${SUPERVISED}  extract:\n    command: ["bun", "db/supervise.ts", "--worker", "extract", "--run", "exec bun db/extract-entities.ts --follow"]\n`, ["extract"]],
  ["the coordinator handed arguments", SUPERVISED.replace(`["db/coordinator.ts"]`, `["db/coordinator.ts", "--passes", "sleep"]`), ["coordinator"]],
  ["the coordinator with no command", SUPERVISED.replace(`    command: ["db/coordinator.ts"]\n`, "    image: x\n"), ["coordinator"]],
];
const RESTART_GOOD = `services:\n  postgres:\n    image: x\n    restart: unless-stopped\n  migrate:\n    image: y\n    restart: "no"\n`;
const RESTART_HELD = { postgres: "unless-stopped", migrate: "no" };
/** [what, text, the services (null = the file) the rule reports]. */
const RESTART_PROBES: [string, string, (string | null)[]][] = [
  ["every policy as held", RESTART_GOOD, []],
  ["postgres with none, as before SMD-2760", RESTART_GOOD.replace("    restart: unless-stopped\n", ""), ["postgres"]],
  ["postgres told not to restart", RESTART_GOOD.replace("restart: unless-stopped", "restart: \"no\""), ["postgres"]],
  ["postgres on always, which restarts a container stopped by hand", RESTART_GOOD.replace("restart: unless-stopped", "restart: always"), ["postgres"]],
  ["the one-shot migrator restarting", RESTART_GOOD.replace("restart: \"no\"", "restart: unless-stopped"), ["migrate"]],
  ["a service the map does not hold", `${RESTART_GOOD}  extra:\n    image: z\n    restart: unless-stopped\n`, ["extra"]],
  ["a service the map does not hold, with no policy", `${RESTART_GOOD}  extra:\n    image: z\n`, ["extra"]],
  ["a held service gone from the file", RESTART_GOOD.replace(/  migrate:[\s\S]*$/, ""), ["migrate"]],
  ["no services at all", "name: x\n", [null]],
];
function checkRestartPolicies() {
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    fail(SELF, `check 32 parses deploy/compose.yaml with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-2760)`);
    return;
  }
  for (const [what, text, expected] of RESTART_PROBES) {
    const got = restartGapsIn(text, RESTART_HELD).map(([service]) => service);
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(SELF, `check 32 no longer reports exactly ${JSON.stringify(expected)} for its probe "${what}" (reported ${JSON.stringify(got)})`);
  }
  for (const [what, text, expected] of SUPERVISOR_PROBES) {
    const got = supervisorGapsIn(text).map(([service]) => service);
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(SELF, `check 32 no longer reports exactly ${JSON.stringify(expected)} for its supervisor probe "${what}" (reported ${JSON.stringify(got)})`);
  }
  for (const [service, detail] of supervisorGapsIn(readFileSync(join(ROOT, "deploy/compose.yaml"), "utf8"))) {
    fail("deploy/compose.yaml", `${service === null ? "the file" : `service \`${service}\``}: ${detail} (SMD-3214)`);
  }
  for (const [service, detail] of restartGapsIn(readFileSync(join(ROOT, "deploy/compose.yaml"), "utf8"), RESTART_POLICIES)) {
    fail("deploy/compose.yaml", `${service === null ? "the file" : `service \`${service}\``}: ${detail} — what serves is \`unless-stopped\`, so it comes back after a reboot with what it reads; what runs once is "no"; a policy is changed there on purpose (SMD-2760, deploy/README.md "After a reboot")`);
  }
}
checkRestartPolicies();

// ── 33. One Bun, pinned everywhere (SMD-2894) ────────────────────────────────
//
// CI's setup-bun steps, every image built FROM oven/bun and compose's oven/bun
// services each name a Bun version, and nothing held them together: from
// 2026-10-11 a maintainer's machine ran 1.4.3 while every pin named 1.4.0, and
// a suite passed in CI and failed there (SMD-2885). Each is held to
// server-portable/Dockerfile's FROM, the image the stack serves from, so a bump
// is every pin or none. A tag is the version alone or with a variant
// (`1.4.3-alpine`); a run line in a README or a header is read too, since it is
// copied as written. A Dockerfile's FROM, a compose `image:` or a workflow's
// `container:` with no tag is Docker's `latest`, which is no pin. That a digest is its tag's image is the
// registry's fact, not the tree's: CI's "The stack runs the pinned Bun" asks the
// running forwarder, the one service pinned by digest.
const BUN_PIN_REF = "server-portable/Dockerfile";
/** An `oven/bun:<tag>` reference, with its digest when pinned by one. */
const BUN_IMAGE_TAG = /\boven\/bun:([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:@sha256:([0-9a-f]{64}))?/g;
/** A Dockerfile's FROM (any case, as Docker reads it), a compose `image:` or a workflow's `container:` naming oven/bun with no tag, or by digest alone. */
const BUN_IMAGE_UNTAGGED = /^\s*(?:FROM\s+(?:--platform=\S+\s+)?|-?\s*(?:image|container):\s*["']?)(?:docker\.io\/)?oven\/bun(@sha256:[0-9a-f]{64})?(?![:\w/@-])/gim;
type BunPin = { where: string; tag: string | null; digest?: string };
/** Every Bun image a text names, by line: its tag (null for none) and digest. */
function bunImagesIn(rel: string, text: string): BunPin[] {
  const lineOf = lineIndexer(text);
  const pins: BunPin[] = [...text.matchAll(BUN_IMAGE_TAG)].map((m) => ({ where: `${rel}:${lineOf(m.index!)}`, tag: m[1], digest: m[2] }));
  for (const m of text.matchAll(BUN_IMAGE_UNTAGGED)) pins.push({ where: `${rel}:${lineOf(m.index! + m[0].length - 1)}`, tag: null, digest: m[1]?.slice("@sha256:".length) });
  return pins;
}
/** Every setup-bun step in a parsed workflow: its `bun-version` as a string, or null when it names none. */
function setupBunPinsIn(rel: string, doc: unknown): BunPin[] {
  const pins: BunPin[] = [];
  const jobs = isMapping(doc) && isMapping(doc.jobs) ? doc.jobs : {};
  for (const [job, def] of Object.entries(jobs)) {
    const steps = isMapping(def) && Array.isArray(def.steps) ? def.steps : [];
    steps.forEach((step, i) => {
      if (!isMapping(step) || typeof step.uses !== "string" || !step.uses.startsWith("oven-sh/setup-bun@")) return;
      const v = isMapping(step.with) ? step.with["bun-version"] : undefined;
      pins.push({ where: `${rel}: job ${job}, step ${typeof step.name === "string" ? JSON.stringify(step.name) : i + 1}`, tag: v === undefined || v === null ? null : String(v) });
    });
  }
  return pins;
}
/** What strays from `version`: a setup-bun pin is the version, an image's tag is it or it with a variant, one tag has one digest. */
function bunPinProblems(pins: BunPin[], version: string, setup: BunPin[]): [where: string, detail: string][] {
  const problems: [string, string][] = [];
  for (const p of setup) {
    if (p.tag === null) problems.push([p.where, `uses oven-sh/setup-bun with no bun-version, which installs the latest Bun — pin ${version}`]);
    else if (p.tag !== version) problems.push([p.where, `pins bun-version ${p.tag}, not ${version}`]);
  }
  const digests = new Map<string, BunPin>();
  for (const p of pins) {
    if (p.tag === null) {
      problems.push([p.where, p.digest
        ? `names oven/bun by digest alone, which names no version this check can hold — pin oven/bun:${version}-<variant>@sha256:…`
        : `names oven/bun with no tag, which is Docker's latest — pin oven/bun:${version}-<variant>`]);
      continue;
    }
    if (p.tag !== version && !p.tag.startsWith(`${version}-`)) { problems.push([p.where, `names oven/bun:${p.tag}, not Bun ${version}`]); continue; }
    if (!p.digest) continue;
    const first = digests.get(p.tag);
    if (first === undefined) digests.set(p.tag, p);
    else if (first.digest !== p.digest) problems.push([p.where, `pins oven/bun:${p.tag} at sha256:${p.digest.slice(0, 12)}…, where ${first.where} pins it at sha256:${first.digest!.slice(0, 12)}… — one tag is one image`]);
  }
  return problems;
}
const BUN_PROBE_DIGEST_A = "a".repeat(64), BUN_PROBE_DIGEST_B = "b".repeat(64);
/** [what, text, the 1-based lines the rule reports]. Read as one file at version 9.9.9. */
const BUN_IMAGE_PROBES: [string, string, number[]][] = [
  ["a FROM, a compose image by digest twice and prose, all as pinned", `FROM oven/bun:9.9.9-alpine AS deps\n    image: docker.io/oven/bun:9.9.9-alpine@sha256:${BUN_PROBE_DIGEST_A}\n    image: oven/bun:9.9.9-alpine@sha256:${BUN_PROBE_DIGEST_A}\n# a stock oven/bun image, \`oven/bun\` the reverse\n`, []],
  ["a FROM left behind", "FROM oven/bun:9.9.9-alpine AS deps\nFROM oven/bun:9.9.8-alpine\n", [2]],
  ["a run line in a README left behind", "  docker run --rm oven/bun:9.9.8-alpine sh -c 'bun x.ts'\n", [1]],
  ["a version alone, no variant", "FROM oven/bun:9.9.9\n", []],
  ["a version that only starts with the pin", "FROM oven/bun:9.9.90-alpine\n", [1]],
  ["latest by name", "    image: oven/bun:latest\n", [1]],
  ["a FROM with no tag", "FROM oven/bun AS deps\n", [1]],
  ["a FROM with a platform and no tag", "FROM --platform=linux/amd64 oven/bun\n", [1]],
  ["a compose image with no tag, quoted", "    image: \"docker.io/oven/bun\"\n", [1]],
  ["a lowercase from with no tag (review pass 1)", "from oven/bun\n", [1]],
  ["a workflow job's container with no tag, and prose (review pass 1)", "    container: oven/bun\n    container: the oven/bun image\n", [1]],
  ["a compose image by digest alone (review pass 2)", `    image: docker.io/oven/bun@sha256:${BUN_PROBE_DIGEST_A}\n`, [1]],
  ["one tag at two digests", `    image: oven/bun:9.9.9-alpine@sha256:${BUN_PROBE_DIGEST_A}\n    image: oven/bun:9.9.9-alpine@sha256:${BUN_PROBE_DIGEST_B}\n`, [2]],
  ["two tags, each at its own digest", `    image: oven/bun:9.9.9-alpine@sha256:${BUN_PROBE_DIGEST_A}\n    image: oven/bun:9.9.9-slim@sha256:${BUN_PROBE_DIGEST_B}\n`, []],
];
/** [what, workflow YAML, the steps (by name) the rule reports]. */
const SETUP_BUN_PROBES: [string, string, string[]][] = [
  ["every setup-bun step pinned, another action beside", `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@x\n      - name: Bun\n        uses: oven-sh/setup-bun@x\n        with:\n          bun-version: "9.9.9"\n`, []],
  ["a setup-bun step with no bun-version", `jobs:\n  a:\n    steps:\n      - name: Bun\n        uses: oven-sh/setup-bun@x\n`, ["Bun"]],
  ["a setup-bun step left behind", `jobs:\n  a:\n    steps:\n      - name: Bun\n        uses: oven-sh/setup-bun@x\n        with:\n          bun-version: "9.9.8"\n  b:\n    steps:\n      - name: Bun too\n        uses: oven-sh/setup-bun@x\n        with: { bun-version: 9.9.9 }\n`, ["Bun"]],
  ["a setup-bun step on latest", `jobs:\n  a:\n    steps:\n      - name: Bun\n        uses: oven-sh/setup-bun@x\n        with:\n          bun-version: latest\n`, ["Bun"]],
];
function checkBunPins() {
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    fail(SELF, `check 33 parses the workflows with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-2894)`);
    return;
  }
  for (const [what, text, expected] of BUN_IMAGE_PROBES) {
    const got = bunPinProblems(bunImagesIn("probe", text), "9.9.9", []).map(([where]) => Number(where.split(":").pop()));
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(SELF, `check 33 no longer reports exactly lines ${JSON.stringify(expected)} for its probe "${what}" (reported ${JSON.stringify(got)})`);
  }
  // A digest alone is exact, so not "latest": its message says what it lacks (review pass 2).
  const digestOnly = bunPinProblems(bunImagesIn("probe", `\n    image: oven/bun@sha256:${BUN_PROBE_DIGEST_A}\n`), "9.9.9", []);
  if (digestOnly.length !== 1 || digestOnly[0][0] !== "probe:2" || !digestOnly[0][1].includes("by digest alone")) fail(SELF, `check 33 no longer says a pin by digest alone names no version, on its line (reported ${JSON.stringify(digestOnly)})`);
  for (const [what, yaml, expected] of SETUP_BUN_PROBES) {
    const got = bunPinProblems([], "9.9.9", setupBunPinsIn("probe.yml", Bun.YAML.parse(yaml))).map(([where]) => JSON.parse(where.split(", step ").pop()!));
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(SELF, `check 33 no longer reports exactly ${JSON.stringify(expected)} for its probe "${what}" (reported ${JSON.stringify(got)})`);
  }
  const ref = /^FROM\s+oven\/bun:(\d+\.\d+\.\d+)(?:-[a-z0-9]+)*\b/m.exec(readFileSync(join(ROOT, BUN_PIN_REF), "utf8"))?.[1];
  if (!ref) { fail(BUN_PIN_REF, "names no `FROM oven/bun:<version>`, which check 33 holds every Bun pin to (SMD-2894)"); return; }
  const files = citationFiles().filter((rel) => !rel.startsWith("changes/") && rel !== "CHANGELOG.md");
  const workflows = files.filter((rel) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel));
  if (!workflows.includes(".github/workflows/fork-checks.yml") || !files.includes(BUN_PIN_REF)) fail(SELF, "check 33's listing does not reach fork-checks.yml and the server's Dockerfile — the listing is broken, not the tree clean");
  const setup: BunPin[] = [];
  for (const rel of workflows) {
    try { setup.push(...setupBunPinsIn(rel, Bun.YAML.parse(readFileSync(join(ROOT, rel), "utf8")))); } catch (e) { fail(rel, `does not parse, so check 33 cannot read its setup-bun steps: ${(e as Error).message}`); }
  }
  if (!setup.length) fail(SELF, "check 33 found no setup-bun step in the workflows — the reading is broken, not the tree clean");
  const pins = files.flatMap((rel) => bunImagesIn(rel, readFileSync(join(ROOT, rel), "utf8")));
  for (const [where, detail] of bunPinProblems(pins, ref, setup)) fail(where, `${detail} — every Bun pin names the version ${BUN_PIN_REF} does (${ref}): bump them in one commit (check 33, SMD-2894)`);
}
checkBunPins();

// ── 34. Every suite is run (SMD-2895) ────────────────────────────────────────
//
// fork-checks.yml exists because upstream's suites ran in no workflow and one
// asserted the opposite of production for months. The fork repeated it in
// small: db/test-weekly-digest.ts (31 assertions, SMD-2239) and
// server-portable/test-jobs.ts (45, SMD-2273) were listed in no step, so they
// passed when someone ran them by hand and were checked by nothing else. A
// suite is a `test-*` script; a step of fork-checks.yml, the workflow every
// pull request runs, runs it when its `run` calls bun or node on it, read from
// the step's working-directory, the job's or the workflow's, or a directory a
// `cd` in the same step names (which of those applies is the shell's to say, so
// each is taken). release.yml is not read: it runs on a tag, and on a pull
// request only when its own paths change. A run counts only if the suite's
// failure fails the job, so nothing counts from a step or job with
// `continue-on-error` or `if: false` (or `${{ false }}`), or from a command
// followed by `|| true` or `|| :`, a continued line read as one. A matrix job
// is read once a cell, GitHub's way (matrixCells), its `${{ matrix.* }}` in env
// values, the run text and the working-directory filled in from the cell, so
// check 35 holds each shard of db-live to its line (SMD-3169). A step whose
// `if:` is `matrix.<key> == '<value>'` (or `!=`) on a string value, alone or
// joined by `&&` to parts that read no matrix, is read in the cells that run it
// alone, so a shard renamed under db-live's rest-only step leaves its suite
// unrun, not run four times; any other `if:` that reads the matrix, on a step
// that runs a suite, is reported as one check 34 cannot decide (review passes 2
// and 3), and an `if:` that reads no matrix is not evaluated unless it is
// `false`. A comment line runs nothing, and a quoted string is read as nothing
// either: an echo that names a suite does not run it, and so a suite run only
// inside `sh -c "…"`, or only through `bun run` and a package script, reads as
// unrun, which is the loud direction. What no workflow should run is named in
// SUITES_NOT_RUN with why, and an entry there that a workflow does run is
// stale.
const SUITE_WORKFLOW = ".github/workflows/fork-checks.yml";
const SUITES_NOT_RUN: Record<string, string> = {
  "db/test-support.ts": "the db/ suites' shared helpers, imported by them; it runs nothing itself",
  "server-portable/test-support.ts": "the server suites' shared helpers, imported by them; it runs nothing itself",
  "db/test-bench-reuse.ts": "nine bench runs at 150,000 rows, about three minutes; run by hand with with-postgres.sh (db/README.md, db/ci-parity.sh)",
  "recipes/atomizer/test-atomize.mjs": "calls a live model provider with the operator's key; a reachability check, not a suite",
  "recipes/authorship-edges/test-attribution.mjs": "an upstream recipe's own self-test, run by hand as its README says (the maintainer's call, SMD-2895)",
};
/** A tracked `test-*` script: what check 34 calls a suite. */
const SUITE_FILE = /(?:^|\/)test-[\w.-]*\.(?:ts|mts|mjs|js|cjs)$/;
/** bun or node, its flags, the script it runs, then the script's own flags. */
const SCRIPT_RUN = /\b(?:bun|node)\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*([^\s;&|()<>'"`]+\.(?:ts|mts|mjs|js|cjs))(?![\w.])((?:[ \t]+--?[\w-]+(?:=[^\s;&|()<>'"`]+)?)*)/g;
/** A `cd` in a run line, and the directory it names. */
const SHELL_CD = /\bcd\s+([^\s;&|()<>'"`]+)/g;
/** The `NAME=value` assignments that open a command, as the shell passes them to it. */
const SHELL_ASSIGNS = /^\s*((?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|()<>'"`]*\s+)*)/;
/** A script a step runs, at one path it can resolve to, and the step. */
type SuiteRun = { path: string; where: string };
/** A script a step runs: every directory it may run from (the step's, then each a `cd` names), its own flags, the environment the step and the command give it, and where. */
type ScriptRun = { dirs: string[]; script: string; args: string; env: Record<string, string>; job: string; where: string };
/** A quoted string in a run line, read as nothing. */
const SHELL_QUOTED = /"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/g;
/** What follows a command that swallows its failure, up to the end of its line or a `;`. */
const SHELL_SWALLOWED = /^[^\n;]*?\|\|\s*(?:true|:)(?![\w-])/;
/** A step or job whose failure cannot fail the job: `continue-on-error` set to anything but false, or `if: false`, bare or as `${{ false }}`. */
const failureIgnored = (v: Mapping): boolean =>
  (v["continue-on-error"] !== undefined && v["continue-on-error"] !== false) || v.if === false || (typeof v.if === "string" && /^\s*(?:\$\{\{\s*false\s*\}\}|false)\s*$/.test(v.if));
/** A matrix value as GitHub renders it into a string: null as nothing, another scalar as itself, anything else as JSON. */
const matrixText = (v: unknown): string => (v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
/**
 * A job's matrix cells as GitHub expands them: the product of its axes, less
 * every cell an `exclude` entry matches in each of its keys; then each
 * `include` entry is merged into every cell of that product whose axis
 * values it does not change (values an earlier include added it may), or,
 * when it fits none, added as a cell of its own, which no later include
 * extends — so a matrix of include alone is a cell an entry. A job with no
 * matrix is one empty cell; so is one whose matrix, an axis, its include or
 * exclude list or an entry of either an expression gives, which leaves its
 * `${{ matrix.* }}` unfilled and so matching no ci-parity.sh line — the loud
 * direction — and one whose product is empty (an empty axis, every cell
 * excluded), which GitHub refuses or runs nothing for.
 */
function matrixCells(strategy: unknown): Record<string, unknown>[] {
  const m = isMapping(strategy) ? strategy.matrix : undefined;
  if (!isMapping(m)) return [{}];
  const { include = [], exclude = [], ...axes } = m;
  if (!Array.isArray(include) || !Array.isArray(exclude) || ![...include, ...exclude].every(isMapping) || !Object.values(axes).every(Array.isArray)) return [{}];
  // A cell keeps each value as YAML gives it, so an if: can tell a string from a number; values compare as rendered.
  const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && matrixText(a) === matrixText(b);
  let cells: Record<string, unknown>[] = Object.keys(axes).length
    ? Object.entries(axes as Record<string, unknown[]>).reduce<Record<string, unknown>[]>((acc, [k, vs]) => acc.flatMap((c) => vs.map((v) => ({ ...c, [k]: v }))), [{}])
    : [];
  cells = cells.filter((c) => !exclude.some((x) => Object.keys(x).length > 0 && Object.entries(x).every(([k, v]) => same(c[k], v))));
  const added: Record<string, unknown>[] = [];
  for (const inc of include as Mapping[]) {
    const fits = cells.filter((c) => Object.entries(inc).every(([k, v]) => !Object.hasOwn(axes, k) || same(c[k], v)));
    if (fits.length) for (const c of fits) Object.assign(c, inc);
    else added.push({ ...inc });
  }
  cells.push(...added);
  return cells.length ? cells : [{}];
}
/** `${{ matrix.<key> }}` in a value. */
const MATRIX_REF = /\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/g;
/** A cell's value for a key, matched ignoring case as GitHub's contexts match property names; undefined when the cell has none. */
const cellValue = (cell: Record<string, unknown>, key: string): unknown => {
  const own = Object.keys(cell).find((k) => k.toLowerCase() === key.toLowerCase());
  return own === undefined ? undefined : cell[own];
};
/** A value with each `${{ matrix.<key> }}` filled in from a cell, a key the cell lacks rendering empty, as on GitHub. */
const fillMatrix = (v: string, cell: Record<string, unknown>): string =>
  v.replace(MATRIX_REF, (_, key: string) => {
    const value = cellValue(cell, key);
    return value === undefined ? "" : matrixText(value);
  });
/** One comparison of a matrix value with a string literal (`''` an escaped quote). */
const MATRIX_IF = /^\s*matrix\.([A-Za-z_][\w-]*)\s*(==|!=)\s*'((?:[^']|'')*)'\s*$/;
/** A string literal in an expression. */
const EXPRESSION_LITERAL = /'(?:[^']|'')*'/g;
/** Whether an expression reads the matrix context: `matrix` itself, not a property named so (`needs.matrix`) or text in a literal. */
const readsMatrix = (expr: string): boolean => /(?<![\w.$-])matrix\b/i.test(expr.replace(EXPRESSION_LITERAL, "''"));
/** An expression's parts split on `op` where it stands outside parentheses and string literals. */
function topLevelParts(expr: string, op: "&&" | "||"): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0, quoted = false;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && expr.startsWith(op, i)) { parts.push(expr.slice(start, i)); start = i + op.length; i += op.length - 1; }
  }
  parts.push(expr.slice(start));
  return parts;
}
/**
 * Whether a step's `if:` runs it in a cell of a readable matrix. An `if:`
 * that reads no matrix, or a cell of no readable matrix, is undefined: not
 * evaluated, so read as run. An `if:` that is a chain of `&&` (inside
 * `${{ }}` or not) is decided on its parts that read the matrix, each of
 * which must be `matrix.<key> == '<value>'` or `!=` on a string value:
 * compared ignoring case, as GitHub compares strings, a key the cell lacks
 * being '' as GitHub dereferences it. One such part false makes the `if:`
 * false, whatever the other parts (`!cancelled() && matrix.shard == 'rest'`,
 * review pass 3). Any other `if:` that reads the matrix — an `||` at its top,
 * a matrix part negated, parenthesised, reversed or indexed, a number or
 * boolean value, which GitHub would compare as numbers — is "unread": check
 * 34 reports it, so a shard renamed under one cannot leave a suite run by no
 * cell while the checks count it in each (review pass 2).
 */
function matrixIfHolds(cond: unknown, cell: Record<string, unknown>): boolean | "unread" | undefined {
  if (typeof cond !== "string" || !Object.keys(cell).length) return undefined;
  const expr = cond.replace(/^\s*\$\{\{([^]*)\}\}\s*$/, "$1");
  if (!readsMatrix(expr)) return undefined;
  if (topLevelParts(expr, "||").length > 1) return "unread";
  const decided: (boolean | "unread")[] = topLevelParts(expr, "&&").filter(readsMatrix).map((part) => {
    const m = MATRIX_IF.exec(part);
    const value = m ? cellValue(cell, m[1]) ?? "" : undefined;
    if (!m || typeof value !== "string") return "unread";
    return (value.toLowerCase() === m[3].replace(/''/g, "'").toLowerCase()) === (m[2] === "==");
  });
  return decided.includes(false) ? false : decided.includes("unread") ? "unread" : true;
}
/** Every script a parsed workflow's steps run by bun or node whose failure fails the job (checks 34 and 35); each step running one whose matrix `if:` it cannot decide goes in `unread`, its where, and is read as run. */
function scriptRunsIn(rel: string, doc: unknown, unread: Set<string> = new Set()): ScriptRun[] {
  const out: ScriptRun[] = [];
  const wdOf = (v: unknown): string | undefined => {
    const d = isMapping(v) && isMapping(v.run) ? v.run["working-directory"] : undefined;
    return typeof d === "string" ? d : undefined;
  };
  const envOf = (v: Mapping): Record<string, string> => isMapping(v.env) ? Object.fromEntries(Object.entries(v.env).map(([k, x]) => [k, String(x)])) : {};
  const top = isMapping(doc) ? wdOf(doc.defaults) : undefined;
  const topEnv = isMapping(doc) ? envOf(doc) : {};
  const jobs = isMapping(doc) && isMapping(doc.jobs) ? doc.jobs : {};
  for (const [job, def] of Object.entries(jobs)) {
    if (!isMapping(def) || failureIgnored(def)) continue;
    const jobWd = wdOf(def.defaults) ?? top ?? ".";
    const steps = Array.isArray(def.steps) ? def.steps : [];
    for (const cell of matrixCells(def.strategy)) {
      // A job with no readable matrix is one empty cell, its values left as written.
      const inCell = Object.keys(cell).length > 0;
      const fillText = (v: string): string => (inCell ? fillMatrix(v, cell) : v);
      const fill = (env: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, fillText(v)]));
      const cellName = inCell ? ` (${Object.values(cell).map(matrixText).join(", ")})` : "";
      const jobEnv = fill({ ...topEnv, ...envOf(def) });
      steps.forEach((step, i) => {
        if (!isMapping(step) || typeof step.run !== "string" || failureIgnored(step)) return;
        const stepName = typeof step.name === "string" ? JSON.stringify(step.name) : i + 1;
        const runs = matrixIfHolds(step.if, cell);
        if (runs === false) return;
        const runsBefore = out.length;
        // GitHub fills the run text and the directory before the shell sees them.
        const wd = posix.normalize(typeof step["working-directory"] === "string" ? fillText(step["working-directory"]) : jobWd);
        const text = fillText(step.run).replace(/\\\n/g, " ").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").replace(SHELL_QUOTED, '""');
        const dirs = [wd, ...[...text.matchAll(SHELL_CD)].map((m) => posix.normalize(posix.join(wd, m[1])))];
        const where = `${rel}: job ${job}${cellName}, step ${stepName}`;
        const stepEnv = { ...jobEnv, ...fill(envOf(step)) };
        for (const m of text.matchAll(SCRIPT_RUN)) {
          if (SHELL_SWALLOWED.test(text.slice(m.index! + m[0].length))) continue;
          // The command's own assignments open the segment it is in: after the
          // last newline, `;`, `&`, `|` or `(` before it.
          const before = text.slice(0, m.index!);
          const segment = before.slice(Math.max(...["\n", ";", "&", "|", "("].map((c) => before.lastIndexOf(c))) + 1);
          const inline = Object.fromEntries((SHELL_ASSIGNS.exec(segment)?.[1] ?? "").trim().split(/\s+/).filter(Boolean).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
          out.push({ dirs, script: m[1], args: m[2].trim().split(/\s+/).filter(Boolean).join(" "), env: { ...stepEnv, ...inline }, job, where });
        }
        if (runs === "unread" && out.length > runsBefore) unread.add(`${rel}: job ${job}, step ${stepName}`);
      });
    }
  }
  return out;
}
/** Every script a parsed workflow's steps run whose failure fails the job, at every path it can resolve to (check 34). */
function suitesRunIn(rel: string, doc: unknown, unread?: Set<string>): SuiteRun[] {
  return scriptRunsIn(rel, doc, unread).flatMap((r) => r.dirs.map((d) => ({ path: posix.normalize(posix.join(d, r.script)), where: r.where })));
}
/** What check 34 reports: a suite nothing runs and nothing excuses, an excused suite a workflow runs, an excuse for no suite. */
function suiteProblems(suites: string[], run: SuiteRun[], notRun: Record<string, string>): [where: string, detail: string][] {
  const problems: [string, string][] = [];
  for (const s of suites) {
    const by = run.find((r) => r.path === s);
    if (s in notRun) {
      if (by) problems.push([s, `is in SUITES_NOT_RUN ("${notRun[s]}"), but ${by.where} runs it — take it off the list`]);
    } else if (!by) problems.push([s, `is a suite no ${SUITE_WORKFLOW} step runs where its failure fails the job, so it passes or fails unseen — add a step that runs it, or name it in SUITES_NOT_RUN with why`]);
  }
  for (const [p, why] of Object.entries(notRun)) {
    if (!suites.includes(p)) problems.push([SELF, `SUITES_NOT_RUN names ${p}, which is no test-* script in the tree — take it off the list`]);
    else if (!why.trim()) problems.push([SELF, `SUITES_NOT_RUN names ${p} with no reason`]);
  }
  return problems;
}
/** [what, workflow YAML, the paths it runs, deduplicated and sorted]. */
const SUITE_RUN_PROBES: [string, string, string[]][] = [
  ["a step's working-directory", `jobs:\n  a:\n    steps:\n      - working-directory: db\n        run: bun test-a.ts\n`, ["db/test-a.ts"]],
  ["a path from the root, and node", `jobs:\n  a:\n    steps:\n      - run: bun recipes/x/test-b.mjs\n      - run: node y/test-c.mjs\n`, ["recipes/x/test-b.mjs", "y/test-c.mjs"]],
  ["the job's default working-directory, and the workflow's", `defaults:\n  run:\n    working-directory: w\njobs:\n  a:\n    defaults:\n      run:\n        working-directory: server-portable\n    steps:\n      - run: bun test-d.ts\n  b:\n    steps:\n      - run: bun test-e.ts\n`, ["server-portable/test-d.ts", "w/test-e.ts"]],
  ["a cd in a subshell, behind a timeout", `jobs:\n  a:\n    steps:\n      - working-directory: db\n        run: |\n          (cd ../server-portable && exec timeout --kill-after=10s "$limit" bun test-f.ts) > "$RUNNER_TEMP/f.log" 2>&1 &\n`, ["db/test-f.ts", "server-portable/test-f.ts"]],
  ["flags, and two runs in one line", `jobs:\n  a:\n    steps:\n      - run: bun --smol x/test-g.ts && bun x/test-h.ts --self-check\n`, ["x/test-g.ts", "x/test-h.ts"]],
  ["a comment line and an echo run nothing", `jobs:\n  a:\n    steps:\n      - run: |\n          # bun x/test-i.ts\n          echo "x/test-j.ts failed"\n          echo "::error::bun x/test-k.tsx"\n`, []],
  ["an echo that names bun on a suite runs nothing (review pass 1)", `jobs:\n  a:\n    steps:\n      - run: |\n          echo "bun x/test-l.ts failed"\n          printf '%s\\n' 'run bun x/test-m.ts by hand'\n`, []],
  ["a suite only inside sh -c reads as unrun (review pass 1)", `jobs:\n  a:\n    steps:\n      - run: sh -c "bun x/test-n.ts"\n`, []],
  ["a failure swallowed by || true or || : (review pass 1)", `jobs:\n  a:\n    steps:\n      - run: |\n          bun x/test-o.ts > "$RUNNER_TEMP/o.log" 2>&1 || true\n          bun x/test-p.ts && echo ok || :\n          bun x/test-q.ts || { echo "q failed"; exit 1; }\n          bun x/test-r.ts; false || true\n`, ["x/test-q.ts", "x/test-r.ts"]],
  ["a swallow on a continued line, and a package script (review pass 2)", `jobs:\n  a:\n    steps:\n      - run: |\n          bun x/test-y.ts \\\n            --flag || true\n          bun x/test-z.ts \\\n            --flag\n      - working-directory: s\n        run: bun run test:sql\n`, ["x/test-z.ts"]],
  ["continue-on-error or if: false on a step or a job (review pass 1)", `jobs:\n  a:\n    steps:\n      - run: bun x/test-s.ts\n        continue-on-error: true\n      - run: bun x/test-t.ts\n        continue-on-error: \${{ matrix.experimental }}\n      - run: bun x/test-u.ts\n        if: false\n      - run: bun x/test-v.ts\n        if: \${{ !cancelled() }}\n        continue-on-error: false\n  b:\n    continue-on-error: true\n    steps:\n      - run: bun x/test-w.ts\n  c:\n    if: false\n    steps:\n      - run: bun x/test-x.ts\n`, ["x/test-v.ts"]],
];
/** [what, suites, runs, not-run list, the wheres reported]. */
const SUITE_PROBLEM_PROBES: [string, string[], string[], Record<string, string>, string[]][] = [
  ["every suite run or excused", ["a/test-a.ts", "a/test-b.ts"], ["a/test-a.ts"], { "a/test-b.ts": "why" }, []],
  ["a suite nothing runs", ["a/test-a.ts", "a/test-b.ts"], ["a/test-a.ts"], {}, ["a/test-b.ts"]],
  ["an excused suite a workflow runs", ["a/test-a.ts"], ["a/test-a.ts"], { "a/test-a.ts": "why" }, ["a/test-a.ts"]],
  ["an excuse for a file that is gone", ["a/test-a.ts"], ["a/test-a.ts"], { "a/test-gone.ts": "why" }, [SELF]],
  ["an excuse with no reason", ["a/test-a.ts"], [], { "a/test-a.ts": " " }, [SELF]],
];
/** [what, an if:, a cell, what matrixIfHolds decides]. */
const MATRIX_IF_PROBES: [string, unknown, Record<string, unknown>, boolean | "unread" | undefined][] = [
  ["equal, ignoring case", "matrix.s == 'REST'", { s: "rest" }, true],
  ["unequal", "${{ matrix.s != 'rest' }}", { s: "rest" }, false],
  ["a misspelt value", "matrix.s == 'rset'", { s: "rest" }, false],
  ["an escaped quote", "matrix.s == 'it''s'", { s: "it's" }, true],
  ["a key the cell lacks is ''", "matrix.t == 'yes'", { s: "rest" }, false],
  ["a key the cell lacks, unequal", "matrix.t != 'yes'", { s: "rest" }, true],
  ["a key matched ignoring case", "matrix.S == 'rest'", { s: "rest" }, true],
  ["no matrix read", "github.event_name == 'push'", { s: "rest" }, undefined],
  ["no readable matrix", "matrix.s == 'rest'", {}, undefined],
  ["a property named matrix, and the word in a literal, read no matrix (review pass 3)", "needs.matrix.outputs.run == 'true' && contains(github.head_ref, 'matrix.s')", { s: "rest" }, undefined],
  ["an && chain, true (review pass 3)", "${{ !cancelled() && matrix.s == 'rest' }}", { s: "rest" }, true],
  ["an && chain, false (review pass 3)", "always() && matrix.s == 'rset'", { s: "rest" }, false],
  ["an && chain, false though another part is unread (review pass 3)", "matrix['s'] == 'rest' && matrix.s == 'rset'", { s: "rest" }, false],
  ["an && chain with a part unread (review pass 3)", "matrix.s == 'rest' && matrix['s'] == 'rest'", { s: "rest" }, "unread"],
  ["an || at the top, below which && binds (review pass 3)", "matrix.s == 'rset' && success() || always()", { s: "rest" }, "unread"],
  ["an && inside a literal is no chain (review pass 3)", "matrix.s == 'a && b'", { s: "a && b" }, true],
  ["a negated part (review pass 3)", "!(matrix.s == 'rest')", { s: "rest" }, "unread"],
  ["the whole matrix read (review pass 3)", "contains(toJSON(matrix), 'rest')", { s: "rest" }, "unread"],
  ["reversed operands", "'rest' == matrix.s", { s: "rest" }, "unread"],
  ["parentheses", "(matrix.s == 'rest')", { s: "rest" }, "unread"],
  ["an index", "matrix['s'] == 'rest'", { s: "rest" }, "unread"],
  ["a boolean value, which GitHub compares as a number", "matrix.b == 'true'", { b: true }, "unread"],
  ["a number value", "matrix.n != '01'", { n: 1 }, "unread"],
];
/** Step b's if: reads the matrix in a shape check 34 cannot decide; a's and c's it can or need not; d's it cannot either, but d runs no suite (review pass 3). */
const MATRIX_UNREAD_PROBE = `jobs:\n  a:\n    strategy:\n      matrix:\n        s: [x, y]\n    steps:\n      - name: a\n        if: always() && matrix.s == 'x'\n        run: bun test-a.ts\n      - name: b\n        if: matrix.s == 'x' || always()\n        run: bun test-b.ts\n      - name: c\n        if: success()\n        run: bun test-c.ts\n      - name: d\n        if: matrix.s == 'x' || always()\n        run: tar czf logs.tgz logs\n`;
function checkSuitesRun() {
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    fail(SELF, `check 34 parses the workflows with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-2895)`);
    return;
  }
  for (const [what, yaml, expected] of SUITE_RUN_PROBES) {
    const got = [...new Set(suitesRunIn("probe.yml", Bun.YAML.parse(yaml)).map((r) => r.path))].sort();
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(SELF, `check 34 no longer reads exactly ${JSON.stringify(expected)} as run for its probe "${what}" (read ${JSON.stringify(got)})`);
  }
  for (const [what, suites, run, notRun, expected] of SUITE_PROBLEM_PROBES) {
    const got = suiteProblems(suites, run.map((path) => ({ path, where: "probe.yml" })), notRun).map(([where]) => where);
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(SELF, `check 34 no longer reports exactly ${JSON.stringify(expected)} for its probe "${what}" (reported ${JSON.stringify(got)})`);
  }
  const files = citationFiles();
  const suites = files.filter((rel) => SUITE_FILE.test(rel));
  for (const [what, cond, cell, expected] of MATRIX_IF_PROBES) {
    const got = matrixIfHolds(cond, cell);
    if (got !== expected) fail(SELF, `check 34 no longer decides ${JSON.stringify(expected)} for its matrix if: probe "${what}" (decided ${JSON.stringify(got)})`);
  }
  const probeUnread = new Set<string>();
  scriptRunsIn("probe.yml", Bun.YAML.parse(MATRIX_UNREAD_PROBE), probeUnread);
  if (JSON.stringify([...probeUnread]) !== JSON.stringify(['probe.yml: job a, step "b"'])) fail(SELF, `check 34 no longer reports exactly step "b" of its probe as a matrix if: it cannot decide (reported ${JSON.stringify([...probeUnread])})`);
  const run: SuiteRun[] = [];
  const unread = new Set<string>();
  try { run.push(...suitesRunIn(SUITE_WORKFLOW, Bun.YAML.parse(readFileSync(join(ROOT, SUITE_WORKFLOW), "utf8")), unread)); } catch (e) { fail(SUITE_WORKFLOW, `does not parse, so check 34 cannot read what its steps run: ${(e as Error).message}`); }
  for (const where of unread) fail(where, "has an `if:` that reads the matrix in a shape check 34 cannot decide, so whether a cell runs the suite this step runs is unknown and it could run in none — write each part that reads the matrix as `matrix.<key> == '<value>'` (or `!=`) on a string value, joined to the rest by `&&` (check 34, SMD-3169)");
  // test-schema.ts from a step's working-directory, test-preflight.ts from a cd:
  // were either missed, the reading is broken, not the tree clean.
  for (const known of ["db/test-schema.ts", "server-portable/test-preflight.ts"]) {
    if (!run.some((r) => r.path === known)) fail(SELF, `check 34 does not read ${known} as run by fork-checks.yml — the reading is broken, not the tree clean`);
  }
  for (const [where, detail] of suiteProblems(suites, run, SUITES_NOT_RUN)) fail(where, `${detail} (check 34, SMD-2895)`);
}
checkSuitesRun();

// ── 44: a directory CI runs a script from does not auto-install (SMD-2978) ──
/**
 * 44: Bun fetches a package an import cannot resolve, from its cache or from npm, unless the bunfig.toml in the
 * directory it runs from sets `[install] auto = "disable"`. It reads that directory's file alone, not a parent's. So
 * a step whose job lacked an install passed on whatever npm served: test-live's [9] and test-search-path ran
 * server-portable/preflight.ts on a zod fetched at run time, since db-live installed db/ alone (SMD-2978). Each
 * directory a fork-checks.yml step may run a script from (check 34's reader: the step's working-directory and each
 * `cd` it names) that holds a package.json carries a bunfig.toml that sets it. A directory with no package.json is
 * not read: it has no install of its own to hold to, and a file at the root would reach every command run from it,
 * recipes with installs of their own included (changes/291's Not taken). So a script run from the root, deploy/ or
 * deploy/orchestration/ still auto-installs; none imports a package today (changes/smd-2978.md's Not taken).
 */
/** Why a bunfig.toml leaves auto-install on, given its text (null for no file); null when the file turns it off. */
function autoInstallLeftOn(text: string | null): string | null {
  if (text === null) return "has no bunfig.toml";
  let doc: unknown;
  try { doc = Bun.TOML.parse(text); } catch (e) { return `has a bunfig.toml that does not parse (${(e as Error).message})`; }
  const auto = isMapping(doc) && isMapping(doc.install) ? doc.install.auto : undefined;
  return auto === "disable" ? null : `has a bunfig.toml whose [install] auto is ${auto === undefined ? "unset" : JSON.stringify(auto)}`;
}
function checkNoAutoInstall() {
  if (typeof Bun === "undefined" || typeof Bun.TOML?.parse !== "function" || typeof Bun.YAML?.parse !== "function") {
    fail(SELF, `check 44 parses bunfig.toml with Bun.TOML and the workflow with Bun.YAML, and this runtime lacks one — run \`bun ${SELF}\`, as CI does (SMD-2978)`);
    return;
  }
  const cases: [string, string | null, boolean][] = [
    ["off", '[install]\nauto = "disable"\n', true],
    ["off, single-quoted, under a comment", "# why\n[install]\nauto = 'disable'\n", true],
    ["another mode", '[install]\nauto = "fallback"\n', false],
    ["commented out", '[install]\n# auto = "disable"\n', false],
    ["outside [install]", 'auto = "disable"\n[install]\n', false],
    ["under another table", '[run]\nauto = "disable"\n', false],
    ["a file that does not parse", '[install\nauto = "disable"\n', false],
    ["no file", null, false],
  ];
  const wrong = cases.filter(([, text, off]) => (autoInstallLeftOn(text) === null) !== off).map(([what]) => what);
  if (wrong.length) fail(SELF, `check 44 no longer reads its probes as written (${JSON.stringify(wrong)}): only \`auto = "disable"\` under [install] turns auto-install off (SMD-2978)`);
  let runs: ScriptRun[] = [];
  try { runs = scriptRunsIn(SUITE_WORKFLOW, Bun.YAML.parse(readFileSync(join(ROOT, SUITE_WORKFLOW), "utf8"))); } catch (e) { fail(SUITE_WORKFLOW, `does not parse, so check 44 cannot read where its steps run: ${(e as Error).message}`); return; }
  const dirs = [...new Set(runs.flatMap((r) => r.dirs))].filter((d) => existsSync(join(ROOT, d, "package.json"))).sort();
  // Three directories many steps run from: were any missed, the reading is broken. A cd's directory is check 34's
  // probe's to hold ("a cd in a subshell, behind a timeout"); no package directory is reached by a cd alone today.
  for (const known of ["db", "server-portable", "extensions"]) {
    if (!dirs.includes(known)) fail(SELF, `check 44 does not read ${known}/ as a directory fork-checks.yml runs a script from — the reading is broken, not the tree clean`);
  }
  for (const d of dirs) {
    const p = join(ROOT, d, "bunfig.toml");
    const why = autoInstallLeftOn(existsSync(p) ? readFileSync(p, "utf8") : null);
    if (why) fail(`${d}/bunfig.toml`, `${d}/ ${why}, but a ${SUITE_WORKFLOW} step runs a script from it, so an import its job's installs do not resolve is fetched from npm instead of failing — give it a bunfig.toml with \`[install]\` and \`auto = "disable"\`, as extensions/ has (check 44, SMD-2978)`);
  }
}
checkNoAutoInstall();

// ── 35. db/ci-parity.sh runs what CI runs (SMD-2903) ─────────────────────────
//
// ci-parity.sh is CI's local equivalent, and nothing held it to the workflow:
// by SMD-2895 it missed fourteen of the suites fork-checks.yml runs and every
// --self-check step, and ran the suites of CI's database-free jobs with
// DATABASE_URL set. Each script a fork-checks.yml step runs (check 34's reader:
// the same directories, flags, quoting and swallowed failures) is a line of
// ci-parity.sh's — `run` where the step sets DATABASE_URL, `nodb` where it does
// not — from one of the directories the step may run it from, with the same
// flags and the same environment besides the database URLs, which are the
// harness's; every typecheck step is a `typecheck` line. And the other way: a
// line no step runs as written is stale. What ci-parity.sh cannot run is
// excused by job or by script with why.
const PARITY_SCRIPT = "db/ci-parity.sh";
const PARITY_NOT_RUN: { jobs: Record<string, string>; scripts: Record<string, string> } = {
  jobs: {
    "deploy-stack": "the compose stack built from the images, with its networks and proxy; run it with docker compose (deploy/README.md)",
    "deploy-stack-brains": "a second brain, the tier refresh and a canary beside that stack, on Docker",
    "deploy-stack-auth": "the import runner and the authorization server on that stack, on Docker",
    "auth-poc": "the authorization POC's own stacks in Docker (eval-auth.ts --up)",
  },
  scripts: {
    "scripts/check-landing.ts": "reads a pull request's or merge group's commit range from the event",
    "scripts/migrate-to-sql-shim.ts": "the codemod's round-trip rewrites tracked files and judges them by git diff, so a working tree with changes would be rewritten",
  },
};
/** A line of ci-parity.sh that runs a script: its verb, directory, script, flags, the assignments before it, and its line. */
type ParityRun = { verb: "run" | "nodb"; dir: string; script: string; args: string; env: Record<string, string>; line: number };
/** `[NAME=value …] run|nodb DIR SCRIPT [FLAG…]`, and `typecheck DIR`, each a line of main(). */
const PARITY_RUN_LINE = /^\s*((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)(run|nodb)\s+(\S+)\s+(\S+\.(?:ts|mts|mjs|js|cjs))((?:\s+--?[\w-]+(?:=\S+)?)*)\s*$/;
const PARITY_TYPECHECK_LINE = /^\s*typecheck\s+(\S+)\s*$/;
/** Any line whose command is run, nodb or typecheck, read or not: one the two shapes above miss is reported, since bash runs it all the same. */
const PARITY_VERB_LINE = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*(?:run|nodb|typecheck)(?:\s|$)/;
function parityLinesIn(text: string): { runs: ParityRun[]; typechecks: { dir: string; line: number }[]; unread: number[] } {
  const runs: ParityRun[] = [];
  const typechecks: { dir: string; line: number }[] = [];
  const unread: number[] = [];
  text.split("\n").forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return;
    const l = raw.replace(/\s+#.*$/, "");
    const m = PARITY_RUN_LINE.exec(l);
    if (m) {
      const env = Object.fromEntries(m[1].trim().split(/\s+/).filter(Boolean).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1).replace(/^(["'])(.*)\1$/, "$2")]));
      runs.push({ verb: m[2] as "run" | "nodb", dir: posix.normalize(m[3]), script: m[4], args: m[5].trim().split(/\s+/).filter(Boolean).join(" "), env, line: i + 1 });
      return;
    }
    const t = PARITY_TYPECHECK_LINE.exec(l);
    if (t) typechecks.push({ dir: posix.normalize(t[1]), line: i + 1 });
    else if (PARITY_VERB_LINE.test(l)) unread.push(i + 1);
  });
  return { runs, typechecks, unread };
}
/** The environment the comparison holds: the database URLs are the harness's, so not compared; the verb says whether DATABASE_URL is set. */
const heldEntries = (env: Record<string, string>): [string, string][] => Object.entries(env).filter(([k]) => !k.endsWith("DATABASE_URL"));
const heldEnv = (env: Record<string, string>): string => JSON.stringify(heldEntries(env).sort(([a], [b]) => a.localeCompare(b)));
const parityLine = (verb: string, dir: string, script: string, args: string, env: Record<string, string>): string =>
  [...heldEntries(env).map(([k, v]) => `${k}=${v}`), verb, dir, script, args].filter(Boolean).join(" ");
/** What check 35 reports, both ways, for CI's script runs and typecheck directories against ci-parity.sh's lines. */
function parityProblems(ci: ScriptRun[], ciTsc: string[], ciJobs: string[], parity: ReturnType<typeof parityLinesIn>, notRun: typeof PARITY_NOT_RUN): [where: string, detail: string][] {
  const problems: [string, string][] = [];
  const excused = (r: ScriptRun) => r.job in notRun.jobs || r.dirs.some((d) => posix.join(d, r.script) in notRun.scripts);
  const verbOf = (r: ScriptRun): "run" | "nodb" => ("DATABASE_URL" in r.env ? "run" : "nodb");
  const matches = (r: ScriptRun, p: ParityRun) => r.dirs.includes(p.dir) && r.script === p.script && r.args === p.args && verbOf(r) === p.verb && heldEnv(r.env) === heldEnv(p.env);
  for (const r of ci) {
    if (excused(r) || parity.runs.some((p) => matches(r, p))) continue;
    problems.push([r.where, `runs ${r.script}${r.args ? ` ${r.args}` : ""}, which ${PARITY_SCRIPT} does not run as CI does — add \`${parityLine(verbOf(r), r.dirs[r.dirs.length - 1], r.script, r.args, r.env)}\` at its place in CI's order, or excuse it in PARITY_NOT_RUN with why`]);
  }
  for (const p of parity.runs) {
    if (ci.some((r) => !excused(r) && matches(r, p))) continue;
    problems.push([`${PARITY_SCRIPT}:${p.line}`, `\`${parityLine(p.verb, p.dir, p.script, p.args, p.env)}\` is run by no ${SUITE_WORKFLOW} step as written (directory, flags, environment, and whether DATABASE_URL is set) — match the step, or take the line out if CI no longer runs it`]);
  }
  for (const n of parity.unread) problems.push([`${PARITY_SCRIPT}:${n}`, "runs a script check 35 cannot read — write it `[NAME=value …] run|nodb DIR SCRIPT [--flag …]` or `typecheck DIR`, with no quoted value and no argument but flags, so it can be held to the workflow"]);
  const parityTsc = parity.typechecks.map((t) => t.dir);
  const ciTscDirs = new Set(ciTsc.map((x) => posix.normalize(x)));
  for (const d of ciTscDirs) if (!parityTsc.includes(d)) problems.push([SUITE_WORKFLOW, `type-checks ${d}, which ${PARITY_SCRIPT} does not — add \`typecheck ${d}\``]);
  for (const t of parity.typechecks) if (!ciTscDirs.has(t.dir)) problems.push([`${PARITY_SCRIPT}:${t.line}`, `type-checks ${t.dir}, which no ${SUITE_WORKFLOW} step does — take it out, or type-check it there (a step of its own, or a .github/ci/typecheck.sh step naming it)`]);
  for (const [job, why] of Object.entries(notRun.jobs)) {
    if (!ciJobs.includes(job)) problems.push([SELF, `PARITY_NOT_RUN excuses job ${job}, which ${SUITE_WORKFLOW} no longer has — take it off the list`]);
    else if (!why.trim()) problems.push([SELF, `PARITY_NOT_RUN excuses job ${job} with no reason`]);
  }
  for (const [script, why] of Object.entries(notRun.scripts)) {
    if (!ci.some((r) => r.dirs.some((d) => posix.join(d, r.script) === script))) problems.push([SELF, `PARITY_NOT_RUN excuses ${script}, which no ${SUITE_WORKFLOW} step runs — take it off the list`]);
    else if (!why.trim()) problems.push([SELF, `PARITY_NOT_RUN excuses ${script} with no reason`]);
  }
  return problems;
}
/** [what, workflow YAML, each run as `dir|script|args|env` for its last directory, sorted]. */
const SCRIPT_RUN_PROBES: [string, string, string[]][] = [
  ["flags kept, a redirect and a chain not", `jobs:\n  a:\n    steps:\n      - working-directory: evals\n        run: bun eval-a.ts --self-check > "$RUNNER_TEMP/a.log" && bun eval-b.ts --gate --x=1\n`, ['evals|eval-a.ts|--self-check|{}', 'evals|eval-b.ts|--gate --x=1|{}']],
  ["the step's env, a command's own assignments on a continued line, and not a flag's =", `jobs:\n  a:\n    env:\n      J: "1"\n    steps:\n      - working-directory: db\n        env:\n          DATABASE_URL: postgres://x\n          S: two\n        run: |\n          timeout --kill-after=10s "$limit" bun test-s.ts > "$RUNNER_TEMP/d.log" 2>&1 &\n          OB1_W=768 OB1_M=n \\\n            timeout --kill-after=10s "$limit" bun test-s.ts > "$RUNNER_TEMP/n.log" 2>&1 &\n`, ['db|test-s.ts||{"DATABASE_URL":"postgres://x","J":"1","OB1_M":"n","OB1_W":"768","S":"two"}', 'db|test-s.ts||{"DATABASE_URL":"postgres://x","J":"1","S":"two"}']],
  ["a lowercase assignment opening the command (review pass 1)", `jobs:\n  a:\n    steps:\n      - run: limit=5 bun x/test-l.ts\n`, ['.|x/test-l.ts||{"limit":"5"}']],
  ["a cd's directory last", `jobs:\n  a:\n    steps:\n      - working-directory: db\n        run: (cd ../server-portable && exec bun test-p.ts) &\n`, ['server-portable|test-p.ts||{}']],
  ["a matrix read once a cell, its value filled into the job's env and the step's, a key it lacks empty (SMD-3169)", `jobs:\n  a:\n    strategy:\n      matrix:\n        shard: [rest, sleep]\n    env:\n      J: j-\${{ matrix.shard }}\n    steps:\n      - run: bun test-m.ts\n        env:\n          S: \${{ matrix.shard }}\n          N: \${{matrix.none}}\n`, ['.|test-m.ts||{"J":"j-rest","N":"","S":"rest"}', '.|test-m.ts||{"J":"j-sleep","N":"","S":"sleep"}']],
  ["a matrix's exclude, an include that extends cells, one that would change an axis value and so is a cell of its own, and numbers (SMD-3169)", `jobs:\n  a:\n    strategy:\n      matrix:\n        os: [l, m]\n        n: [1, 2]\n        exclude:\n          - os: m\n            n: 2\n        include:\n          - os: l\n            extra: e\n          - os: w\n    steps:\n      - run: bun test-x.ts\n        env:\n          V: \${{ matrix.os }}/\${{ matrix.n }}/\${{ matrix.extra }}\n`, ['.|test-x.ts||{"V":"l/1/e"}', '.|test-x.ts||{"V":"l/2/e"}', '.|test-x.ts||{"V":"m/1/"}', '.|test-x.ts||{"V":"w//"}']],
  ["a step's matrix if: read in the cells it runs in, ignoring case, inside ${{ }} or not; one no cell runs; one on a key no cell has (''), none; an && chain decided on its matrix part (SMD-3169, review passes 1-3)", `jobs:\n  a:\n    strategy:\n      matrix:\n        s: [a, b]\n    env:\n      S: \${{ matrix.s }}\n    steps:\n      - run: bun test-a.ts\n        if: matrix.s == 'A'\n      - run: bun test-b.ts\n        if: \${{ matrix.s != 'a' }}\n      - run: bun test-n.ts\n        if: matrix.s == 'rset'\n      - run: bun test-k.ts\n        if: matrix.other == 'x'\n      - run: bun test-c.ts\n        if: matrix.s == 'a' && github.event_name == 'push'\n`, ['.|test-a.ts||{"S":"a"}', '.|test-b.ts||{"S":"b"}', '.|test-c.ts||{"S":"a"}']],
  ["a matrix value filled into the run text and the working-directory, its key matched ignoring case (SMD-3169, review pass 3)", `jobs:\n  a:\n    strategy:\n      matrix:\n        d: [db, evals]\n    steps:\n      - working-directory: \${{ matrix.d }}\n        run: OB1_D=\${{ matrix.D }} bun test-w.ts --\${{ matrix.d }}\n`, ['db|test-w.ts|--db|{"OB1_D":"db"}', 'evals|test-w.ts|--evals|{"OB1_D":"evals"}']],
  ["GitHub's own include example, and an exclude matching on some of a cell's keys (SMD-3169, review pass 2)", `jobs:\n  a:\n    strategy:\n      matrix:\n        fruit: [apple, pear]\n        animal: [cat, dog]\n        include:\n          - color: green\n          - color: pink\n            animal: cat\n          - fruit: apple\n            shape: circle\n          - fruit: banana\n          - fruit: banana\n            animal: cat\n    steps:\n      - run: bun test-f.ts\n        env:\n          V: \${{ matrix.fruit }}/\${{ matrix.animal }}/\${{ matrix.color }}/\${{ matrix.shape }}\n  b:\n    strategy:\n      matrix:\n        os: [l, m]\n        v: [1, 2]\n        e: [x, y]\n        exclude:\n          - os: m\n            v: 2\n    steps:\n      - run: bun test-e.ts\n        env:\n          V: \${{ matrix.os }}\${{ matrix.v }}\${{ matrix.e }}\n`, ['.|test-e.ts||{"V":"l1x"}', '.|test-e.ts||{"V":"l1y"}', '.|test-e.ts||{"V":"l2x"}', '.|test-e.ts||{"V":"l2y"}', '.|test-e.ts||{"V":"m1x"}', '.|test-e.ts||{"V":"m1y"}', '.|test-f.ts||{"V":"apple/cat/pink/circle"}', '.|test-f.ts||{"V":"apple/dog/green/circle"}', '.|test-f.ts||{"V":"banana///"}', '.|test-f.ts||{"V":"banana/cat//"}', '.|test-f.ts||{"V":"pear/cat/pink/"}', '.|test-f.ts||{"V":"pear/dog/green/"}']],
  ["an if: of \${{ false }} runs nothing, as a bare false does (SMD-3169, review pass 2)", `jobs:\n  a:\n    steps:\n      - run: bun test-q.ts\n        if: \${{ false }}\n      - run: bun test-r.ts\n        if: "false"\n`, []],
  ["a matrix whose exclude entry an expression gives left unfilled, and null rendered as nothing (SMD-3169, review pass 1)", `jobs:\n  a:\n    strategy:\n      matrix:\n        s: [one, two]\n        exclude:\n          - \${{ fromJSON(inputs.x) }}\n    steps:\n      - run: bun test-e.ts\n        env:\n          S: \${{ matrix.s }}\n  b:\n    strategy:\n      matrix:\n        s: [null]\n    steps:\n      - run: bun test-z.ts\n        env:\n          S: <\${{ matrix.s }}>\n`, ['.|test-e.ts||{"S":"${{ matrix.s }}"}', '.|test-z.ts||{"S":"<>"}']],
  ["a matrix of include alone, and one an expression gives left unfilled (SMD-3169)", `jobs:\n  a:\n    strategy:\n      matrix:\n        include:\n          - s: one\n          - s: two\n    steps:\n      - run: bun test-i.ts\n        env:\n          S: \${{ matrix.s }}\n  b:\n    strategy:\n      matrix: \${{ fromJSON(inputs.m) }}\n    steps:\n      - run: bun test-j.ts\n        env:\n          S: \${{ matrix.s }}\n`, ['.|test-i.ts||{"S":"one"}', '.|test-i.ts||{"S":"two"}', '.|test-j.ts||{"S":"${{ matrix.s }}"}']],
];
const PARITY_PROBE_TEXT = [
  "run() { suite db \"$@\"; }",
  "  # run db test-commented.ts",
  "  run db                 test-live.ts",
  "  OB1_FIXTURE_RESET=1 run evals eval-p.ts --fixture-check",
  "  nodb .                 deploy/forwarder.ts --self-check",
  "  nodb db                test-cli.ts",
  "  typecheck db",
  "  typecheck jev",
].join("\n");
const PARITY_PROBE_CI = (): ScriptRun[] => [
  { dirs: ["db"], script: "test-live.ts", args: "", env: { DATABASE_URL: "x" }, job: "db-live", where: "w:live" },
  { dirs: ["evals"], script: "eval-p.ts", args: "--fixture-check", env: { DATABASE_URL: "x", OB1_FIXTURE_RESET: "1" }, job: "data-layer", where: "w:p" },
  { dirs: ["."], script: "deploy/forwarder.ts", args: "--self-check", env: {}, job: "repo", where: "w:fwd" },
  { dirs: ["db"], script: "test-cli.ts", args: "", env: {}, job: "replay", where: "w:cli" },
  { dirs: ["db", "server-portable"], script: "test-pre.ts", args: "", env: { DATABASE_URL: "x", UPGRADE_DATABASE_URL: "y" }, job: "data-layer", where: "w:pre" },
  { dirs: ["."], script: "scripts/check-landing.ts", args: "--event", env: { EVENT: "${{ github.event_name }}" }, job: "repo", where: "w:landing" },
  { dirs: ["deploy"], script: "x.ts", args: "", env: {}, job: "stack", where: "w:stack" },
];
const PARITY_PROBE_NOT_RUN = { jobs: { stack: "why" }, scripts: { "scripts/check-landing.ts": "why" } };
/** [what, the probe's ci-parity text changed, its CI runs changed, CI's tsc dirs, the wheres reported]. */
const PARITY_PROBES: [string, (t: string) => string, (c: ScriptRun[]) => ScriptRun[], string[], string[]][] = [
  ["the probe as written, a cd's directory taken", (t) => `${t}\n  run server-portable test-pre.ts`, (c) => c, ["db", "jev"], []],
  ["a step ci-parity.sh lacks", (t) => t, (c) => c, ["db", "jev"], ["w:pre"]],
  ["a line no step runs", (t) => `${t}\n  run server-portable test-pre.ts\n  nodb db test-gone.ts`, (c) => c, ["db", "jev"], [`${PARITY_SCRIPT}:10`]],
  ["the database verb wrong", (t) => t.replace("nodb db                test-cli.ts", "run db test-cli.ts") + "\n  run server-portable test-pre.ts", (c) => c, ["db", "jev"], ["w:cli", `${PARITY_SCRIPT}:6`]],
  ["an environment variable dropped", (t) => t.replace("OB1_FIXTURE_RESET=1 run", "run") + "\n  run server-portable test-pre.ts", (c) => c, ["db", "jev"], ["w:p", `${PARITY_SCRIPT}:4`]],
  ["a flag changed", (t) => t.replace("--fixture-check", "--gate") + "\n  run server-portable test-pre.ts", (c) => c, ["db", "jev"], ["w:p", `${PARITY_SCRIPT}:4`]],
  ["the same script from the wrong directory", (t) => `${t}\n  run db test-pre.ts`.replace("nodb db                test-cli.ts", "nodb server-portable test-cli.ts"), (c) => c, ["db", "jev"], ["w:cli", `${PARITY_SCRIPT}:6`]],
  ["a typecheck missing, and one CI does not run", (t) => `${t}\n  run server-portable test-pre.ts`, (c) => c, ["db", "evals"], [SUITE_WORKFLOW, `${PARITY_SCRIPT}:8`]],
  ["lines check 35 cannot read, which bash runs all the same (review pass 1)", (t) => `${t}\n  run server-portable test-pre.ts  # a trailing comment is read\n  run db test-a.ts --role reader\n  OB1_X="a b" run db test-a.ts\n  nodb db some-binary\n  typecheck`, (c) => c, ["db", "jev"], [`${PARITY_SCRIPT}:10`, `${PARITY_SCRIPT}:11`, `${PARITY_SCRIPT}:12`, `${PARITY_SCRIPT}:13`]],
  ["an excuse for a job and a script CI no longer has", (t) => `${t}\n  run server-portable test-pre.ts`, (c) => c.filter((r) => r.job !== "stack" && r.script !== "scripts/check-landing.ts"), ["db", "jev"], [SELF, SELF]],
];
function checkCiParity() {
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    fail(SELF, `check 35 parses the workflow with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-2903)`);
    return;
  }
  for (const [what, yaml, expected] of SCRIPT_RUN_PROBES) {
    const got = scriptRunsIn("probe.yml", Bun.YAML.parse(yaml)).map((r) => `${r.dirs[r.dirs.length - 1]}|${r.script}|${r.args}|${JSON.stringify(Object.fromEntries(Object.entries(r.env).sort(([a], [b]) => a.localeCompare(b))))}`).sort();
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(SELF, `check 35 no longer reads exactly ${JSON.stringify(expected)} for its probe "${what}" (read ${JSON.stringify(got)})`);
  }
  // SMD-2280 PR 2b: `bun run check` alone in a step is a typecheck of its working-directory; one in a chain is not read.
  const svelteRead = svelteCheckStepsIn({ jobs: { a: { steps: [{ "working-directory": "dashboard", run: "bun run check" }, { "working-directory": "x", run: "bun run check && bun run build" }, { run: "bun run checks" }] } } } as unknown as WorkflowDoc);
  if (JSON.stringify(svelteRead) !== JSON.stringify(["dashboard"])) fail(SELF, `check 35 no longer reads a lone \`bun run check\` step as its directory's typecheck, and nothing else (read ${JSON.stringify(svelteRead)})`);
  const probeLines = parityLinesIn(PARITY_PROBE_TEXT);
  if (probeLines.runs.length !== 4 || probeLines.typechecks.length !== 2 || probeLines.runs[1].env.OB1_FIXTURE_RESET !== "1") fail(SELF, `check 35 no longer reads its probe ci-parity text as four runs (one with OB1_FIXTURE_RESET) and two typechecks (read ${JSON.stringify(probeLines)})`);
  for (const [what, text, ci, tsc, expected] of PARITY_PROBES) {
    const runs = ci(PARITY_PROBE_CI());
    const got = parityProblems(runs, tsc, [...new Set(runs.map((r) => r.job))], parityLinesIn(text(PARITY_PROBE_TEXT)), PARITY_PROBE_NOT_RUN).map(([where]) => where);
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(SELF, `check 35 no longer reports exactly ${JSON.stringify(expected)} for its probe "${what}" (reported ${JSON.stringify(got)})`);
  }
  let doc: unknown;
  try { doc = Bun.YAML.parse(readFileSync(join(ROOT, SUITE_WORKFLOW), "utf8")); } catch (e) { fail(SUITE_WORKFLOW, `does not parse, so check 35 cannot read what its steps run: ${(e as Error).message}`); return; }
  const ci = scriptRunsIn(SUITE_WORKFLOW, doc);
  // CI's tsc steps and its SvelteKit checks (`bun run check`, SMD-2280 PR 2b), each a `typecheck DIR` in ci-parity.sh.
  const ciTsc = [...tscStepsIn(doc as WorkflowDoc), ...svelteCheckStepsIn(doc as WorkflowDoc)];
  const ciJobs = isMapping(doc) && isMapping(doc.jobs) ? Object.keys(doc.jobs) : [];
  const parity = parityLinesIn(readFileSync(join(ROOT, PARITY_SCRIPT), "utf8"));
  // FORK.md says to run it as ./db/ci-parity.sh, which a lost executable bit
  // refuses (review pass 3: a restore by copy dropped it); a checkout carries
  // the committed mode, so the file's mode is what a commit would hold.
  if (!(statSync(join(ROOT, PARITY_SCRIPT)).mode & 0o100)) fail(PARITY_SCRIPT, "is not executable, so `./db/ci-parity.sh`, as FORK.md runs it, is refused — `chmod +x db/ci-parity.sh` (check 35, SMD-2903)");
  // Were these missed, the reading is broken, not the two files in step.
  if (!parity.runs.some((p) => p.script === "test-live.ts") || !parity.typechecks.length || !ci.some((r) => r.script === "test-live.ts") || !ciTsc.length) fail(SELF, `check 35 reads no test-live.ts or no typecheck in ${SUITE_WORKFLOW} or ${PARITY_SCRIPT} — the reading is broken, not the two in step`);
  for (const [where, detail] of parityProblems(ci, ciTsc, ciJobs, parity, PARITY_NOT_RUN)) fail(where, `${detail} (check 35, SMD-2903)`);
}
checkCiParity();

// ── 36: the edge proxy is held whole, and the table it renders (SMD-2876) ──
//
// deploy/edge/ is a project of its own in front of several brains, each
// reached through its published port (docs/one-brain-per-stack.md). Checks 13
// and 28 read the files directly in deploy/, so this holds what is under
// deploy/edge/:
//   files  its compose file is compose.yaml alone — another (an override
//       compose reads with no -f, a second shape) would run what nothing holds;
//   characters, tags, parse  as check 28's: compose and Bun.YAML read the
//       file alike;
//   service  the file is EDGE_COMPOSE, value for value: project ob1-edge; the
//       bridge shape on a network of its own, published on 127.0.0.1, and the
//       host shape on the host's, listening on 127.0.0.1 and [::1], each under
//       its profile; compose.yaml's proxy's Traefik by digest (PROXY_SERVICE's
//       image) and the same access log, its environment named key by key so
//       no trust the brain's proxy gains (a PROXY line, a forwarded header)
//       is the edge's by inheritance — a client reaches the edge directly;
//       read only, confined, the file provider alone on the rendered table
//       mounted read-only, no socket;
//   table  edge.ts renders the example registry, in each shape, as
//       EDGE_ROUTE_TABLE: a router by host per brain with the strip of the two
//       headers a brain's proxy reads from its own and the 404 for a brain
//       that is down, and a service at the shape's dial host and the brain's
//       port — nothing else, no comment (Traefik renders the file as a Go
//       template), and parseRegistry refuses a name or domain that could carry one.
// That each shape reaches a brain, and the brain no network of the edge's, CI
// holds live ("The edge proxy reaches both brains through their published ports").
/** deploy/edge/compose.yaml's Traefik environment, each key named here rather than taken from the proxy's, so a
 *  trust the brain's proxy gains (a forwarded header, a PROXY line) is never the edge's by inheritance: its
 *  entrypoints, the file provider, and the proxy's access log (no query string, header or userinfo) and ping. */
const edgeEnvironment = (entrypoints: Record<string, string>, ping: string) => ({
  ...entrypoints,
  TRAEFIK_PROVIDERS_FILE_DIRECTORY: "/etc/traefik/dynamic",
  TRAEFIK_ACCESSLOG: "true",
  TRAEFIK_ACCESSLOG_FORMAT: "json",
  TRAEFIK_ACCESSLOG_FIELDS_QUERYPARAMETERS_DEFAULTMODE: "drop",
  TRAEFIK_ACCESSLOG_FIELDS_HEADERS_DEFAULTMODE: "drop",
  TRAEFIK_ACCESSLOG_FIELDS_NAMES_CLIENTUSERNAME: "drop",
  TRAEFIK_PING: "true",
  TRAEFIK_PING_ENTRYPOINT: "ping",
  TRAEFIK_ENTRYPOINTS_PING_ADDRESS: ping,
  TRAEFIK_GLOBAL_CHECKNEWVERSION: "false",
  TRAEFIK_GLOBAL_SENDANONYMOUSUSAGE: "false",
});
const EDGE_LOGGING = { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } };
const edgeService = (profile: string, addresses: string) => ({
  profiles: [profile],
  image: PROXY_SERVICE.image,
  user: "65534:65534",
  cap_drop: ["ALL"],
  security_opt: ["no-new-privileges:true"],
  read_only: true,
  volumes: ["./dynamic:/etc/traefik/dynamic:ro,z"],
  labels: { "ob1.edge-routes-sha256": "${EDGE_ROUTES_SHA256:-unrendered}", "ob1.edge-addresses": addresses },
  healthcheck: { test: ["CMD", "traefik", "healthcheck"], interval: "5s", timeout: "3s", retries: 5, start_period: "10s", start_interval: "1s" },
  restart: "unless-stopped",
  logging: EDGE_LOGGING,
});
/** deploy/edge/compose.yaml as Bun.YAML reads it, x-* anchors aside. */
const EDGE_COMPOSE = {
  name: "ob1-edge",
  services: {
    edge: {
      ...edgeService("bridge", "127.0.0.1:${EDGE_PORT:-8090}"),
      environment: edgeEnvironment({ TRAEFIK_ENTRYPOINTS_WEB_ADDRESS: ":8000", TRAEFIK_ENTRYPOINTS_WEB_HTTP_ALIASHEADERSSTRATEGY: "delete" }, "127.0.0.1:8082"),
      ports: ["127.0.0.1:${EDGE_PORT:-8090}:8000"], networks: ["web"], dns_search: ["."],
    },
    "edge-host": {
      ...edgeService("host", "127.0.0.1:${EDGE_PORT:-8090},[::1]:${EDGE_PORT:-8090},127.0.0.1:${EDGE_PING_PORT:-8091}"),
      environment: edgeEnvironment({ TRAEFIK_ENTRYPOINTS_WEB_ADDRESS: "127.0.0.1:${EDGE_PORT:-8090}", TRAEFIK_ENTRYPOINTS_WEB_HTTP_ALIASHEADERSSTRATEGY: "delete", TRAEFIK_ENTRYPOINTS_WEB6_ADDRESS: "[::1]:${EDGE_PORT:-8090}", TRAEFIK_ENTRYPOINTS_WEB6_HTTP_ALIASHEADERSSTRATEGY: "delete" }, "127.0.0.1:${EDGE_PING_PORT:-8091}"),
      network_mode: "host",
    },
  },
  networks: { web: {} },
};
/** What deploy/edge/edge.ts renders for deploy/edge/brains.example.yaml in a shape, byte for byte. */
const edgeRouteTable = (dial: string, entrypoints: string) => "http:\n  routers:\n"
  + `    _edge-probe:\n      rule: "Host(\`_edge.localhost\`)"\n      entryPoints: [${entrypoints}]\n      service: noop@internal\n`
  + ["canary", "stable"].map((b) => `    ${b}:\n      rule: "Host(\`${b}.localhost\`)"\n      entryPoints: [${entrypoints}]\n      middlewares: [edge-strip, brain-absent]\n      service: ${b}\n`).join("")
  + "  middlewares:\n    edge-strip:\n      headers:\n        customRequestHeaders:\n          X-Brain-Forwarder: \"\"\n          X-OB1-Legacy-Route: \"\"\n"
  + routeErrors("brain-absent", "502")
  + "  services:\n" + [["canary", 8011], ["stable", 8010]].map(([b, p]) => routeService(String(b), `http://${dial}:${p}`)).join("");
const EDGE_ROUTE_TABLE = { bridge: edgeRouteTable("host.containers.internal.", "web"), host: edgeRouteTable("127.0.0.1", "web, web6") } as const;
const EDGE_RULES = ["files", "characters", "tags", "parse", "service", "table"] as const;
type EdgeRule = (typeof EDGE_RULES)[number];
type EdgeTree = { files: string[]; compose: string; example: string; render: (example: string, shape: "bridge" | "host") => string };
/** Every way deploy/edge/ strays from check 36, each with its rule; none when it holds. */
function edgeProblems(t: EdgeTree): { rule: EdgeRule; message: string }[] {
  const out: { rule: EdgeRule; message: string }[] = [];
  const flag = (rule: EdgeRule, message: string) => { out.push({ rule, message }); };
  const extra = t.files.filter((f) => /compose/i.test(f) && f !== "compose.yaml");
  if (extra.length) flag("files", `${extra.join(", ")}: a compose file beside compose.yaml, which no check holds — compose reads an override with no -f, and the edge runs one file, by profile per shape`);
  const odd = oddCharacters(t.compose);
  if (odd.length) flag("characters", `compose.yaml line ${odd.join(", ")} carries a control, format or separator character other than the space and the line feed, which compose and Bun.YAML read apart (check 28's rule)`);
  const tagged = [...t.compose.matchAll(/(^|[\s\[{,:?-])!(<|[A-Za-z0-9-]*[!%]|reset\b|override\b)|^%/gm)].map((m) => t.compose.slice(0, m.index).split("\n").length);
  if (tagged.length) flag("tags", `compose.yaml line ${[...new Set(tagged)].join(", ")} carries a tag compose resolves and Bun.YAML reads past, or a % directive (check 28's rule)`);
  let doc: unknown;
  try { doc = Bun.YAML.parse(t.compose); } catch (e) { return [...out, { rule: "parse", message: `compose.yaml does not parse as YAML: ${(e as Error).message}` }]; }
  if (!isMapping(doc)) return [...out, { rule: "parse", message: "compose.yaml is not one YAML mapping" }];
  const diffs: string[] = [];
  pathDiffs(JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith("x-"))))), EDGE_COMPOSE, "", diffs);
  if (diffs.length) flag("service", `compose.yaml: ${diffs.slice(0, 6).join("; ")}${diffs.length > 6 ? `; and ${diffs.length - 6} more` : ""} — the edge is check 36's EDGE_COMPOSE: it sits in front of every brain and carries each client's key, so a change to it is made there too, on purpose`);
  for (const shape of ["bridge", "host"] as const) {
    let got: string;
    try { got = t.render(t.example, shape); } catch (e) { flag("table", `edge.ts does not render brains.example.yaml in the ${shape} shape: ${(e as Error).message}`); continue; }
    const tdiffs: string[] = [];
    pathDiffs(got, EDGE_ROUTE_TABLE[shape], "", tdiffs);
    if (tdiffs.length) flag("table", `edge.ts renders brains.example.yaml in the ${shape} shape otherwise than check 36's EDGE_ROUTE_TABLE: ${tdiffs[0].replace("(the file) ", "")} — a route the edge serves changes here too, on purpose`);
  }
  return out;
}
/** [what the probe changes, the file under deploy/edge/, the text it replaces there (once), its replacement] — each must turn check 36 false. */
const EDGE_PROBES: [string, "compose.yaml" | "edge.ts" | "files", string, string][] = [
  ["a compose.override.yaml beside the edge's file", "files", "", "compose.override.yaml"],
  ["a line led by U+2028 in the edge's file", "compose.yaml", "\nservices:\n", "\n# a note x-shadow: 1\nservices:\n"],
  ["an !override on the edge's networks, the same list to Bun.YAML", "compose.yaml", "    networks: [web]\n", "    networks: !override [web]\n"],
  ["the edge's file not YAML", "compose.yaml", "services:\n", "services: [\n"],
  ["the bridge shape published on every interface", "compose.yaml", "\"127.0.0.1:${EDGE_PORT:-8090}:8000\"", "\"${EDGE_PORT:-8090}:8000\""],
  ["the host shape off [::1], where another process would take the clients that try it first", "compose.yaml", "      TRAEFIK_ENTRYPOINTS_WEB6_ADDRESS: \"[::1]:${EDGE_PORT:-8090}\"\n", ""],
  ["the host table's routers off [::1]'s entrypoint", "edge.ts", "host: \"web, web6\"", "host: \"web\""],
  ["the edge joining a brain's network", "compose.yaml", "networks:\n  web: {}\n", "networks:\n  web: {}\n  brain:\n    name: open-brain_mesh\n    external: true\n"],
  ["the engine's socket mounted into the host shape's edge", "compose.yaml", "      - ./dynamic:/etc/traefik/dynamic:ro,z\n    labels:\n      ob1.edge-routes-sha256: ${EDGE_ROUTES_SHA256:-unrendered}\n      ob1.edge-addresses: \"127.0.0.1:${EDGE_PORT:-8090},[::1]:${EDGE_PORT:-8090},127.0.0.1:${EDGE_PING_PORT:-8091}\"\n", "      - ./dynamic:/etc/traefik/dynamic:ro,z\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n    labels:\n      ob1.edge-routes-sha256: ${EDGE_ROUTES_SHA256:-unrendered}\n      ob1.edge-addresses: \"127.0.0.1:${EDGE_PORT:-8090},[::1]:${EDGE_PORT:-8090},127.0.0.1:${EDGE_PING_PORT:-8091}\"\n"],
  ["the edge trusting a PROXY line from the private ranges", "compose.yaml", "      TRAEFIK_ENTRYPOINTS_WEB_ADDRESS: \":8000\"\n", "      TRAEFIK_ENTRYPOINTS_WEB_ADDRESS: \":8000\"\n      TRAEFIK_ENTRYPOINTS_WEB_PROXYPROTOCOL_TRUSTEDIPS: \"10.0.0.0/8\"\n"],
  ["the edge's table not deleting X-Brain-Forwarder", "edge.ts", "          X-Brain-Forwarder: \\\"\\\"\\n", ""],
  ["the edge's table routing a brain by path, beside its host", "edge.ts", "rule: \"Host(\\`${b.name}.${r.domain}\\`)\"", "rule: \"Host(\\`${b.name}.${r.domain}\\`) || PathPrefix(\\`/${b.name}\\`)\""],
  ["the bridge shape dialling a brain's mesh name", "edge.ts", "bridge: \"host.containers.internal.\"", "bridge: \"mcp.ob1.internal.\""],
];
async function checkEdge() {
  const dir = join(ROOT, "deploy", "edge");
  if (!existsSync(join(dir, "compose.yaml")) || !existsSync(join(dir, "edge.ts")) || !existsSync(join(dir, "brains.example.yaml"))) { fail("deploy/edge", "compose.yaml, edge.ts or brains.example.yaml is missing — check 36 holds the edge proxy (SMD-2876)"); return; }
  const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
  const compose = readFileSync(join(dir, "compose.yaml"), "utf8");
  const edgeTs = readFileSync(join(dir, "edge.ts"), "utf8");
  const example = readFileSync(join(dir, "brains.example.yaml"), "utf8");
  // edge.ts loaded from its text, so a probe's edit is what renders: a copy in a scratch directory, its import of
  // ../instance.ts by that file's path.
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const scratch = mkdtempSync(join((await import("node:os")).tmpdir(), "ob1-check36-"));
  let n = 0;
  const renderOf = async (text: string) => {
    const file = join(scratch, `edge-${n++}.ts`);
    writeFileSync(file, text.replace('from "../instance.ts"', `from ${JSON.stringify(join(ROOT, "deploy", "instance.ts"))}`));
    const mod = await import(file) as typeof import("../deploy/edge/edge.ts");
    return (ex: string, shape: "bridge" | "host") => { const r = mod.parseRegistry(ex).registry; if (!r) throw new Error(mod.parseRegistry(ex).problems.join("; ")); return mod.renderRoutes(r, shape); };
  };
  try { await checkEdgeTree(files, compose, edgeTs, example, renderOf); } finally { rmSync(scratch, { recursive: true, force: true }); }
}
async function checkEdgeTree(files: string[], compose: string, edgeTs: string, example: string, renderOf: (text: string) => Promise<EdgeTree["render"]>) {
  const tree: EdgeTree = { files, compose, example, render: await renderOf(edgeTs) };
  const problems = edgeProblems(tree);
  for (const p of problems) fail(`deploy/edge/${p.rule === "table" ? "edge.ts" : "compose.yaml"}`, `${p.message} (check 36, SMD-2876)`);
  const soleCatch = new Set<EdgeRule>();
  for (const [what, file, from, to] of EDGE_PROBES) {
    const text = file === "compose.yaml" ? compose : file === "edge.ts" ? edgeTs : "";
    if (file !== "files" && text.split(from).length !== 2) { fail(SELF, `check 36's probe "${what}" finds its anchor ${text.split(from).length - 1} times in deploy/edge/${file}, not once — re-anchor it`); continue; }
    const probed: EdgeTree = file === "files" ? { ...tree, files: [...files, to] } : file === "compose.yaml" ? { ...tree, compose: compose.replace(from, to) } : { ...tree, render: await renderOf(edgeTs.replace(from, to)) };
    const rules = new Set(edgeProblems(probed).map((p) => p.rule));
    if (rules.size === 0) fail(SELF, `check 36 no longer catches ${what} (its own probe)`);
    if (rules.size === 1) soleCatch.add([...rules][0]);
  }
  if (!problems.length) for (const rule of EDGE_RULES) if (!soleCatch.has(rule)) fail(SELF, `check 36's rule "${rule}" is the only catch of none of its probes — add a probe that it alone catches, or remove the rule if another already holds what it does`);
}
await checkEdge();
// ── 37. The provisioned dashboard reads what the stack writes (SMD-1849 PR 3c) ──
//
// The observability profile's Grafana loads one dashboard at its start and
// opens on it: deploy/observability/dashboard.json, which compose.yaml carries
// inline as the `grafana-dashboard` config (each `$` doubled, since compose
// reads one as a variable) beside its provider, the
// `grafana-dashboard-provider` config, both mounted on `lgtm` (check 28's
// LGTM_SERVICE and SERVICE_CONFIGS), which carries each one's sha256 as a
// label: compose recreates a container when a label changes and not when only
// an inline config does (docker/compose#11900). A panel naming a metric or a
// label nothing writes shows "No data" for ever and looks like a quiet stack,
// so every Prometheus name a query reads is one the servers' instruments
// write (read from server-portable/'s code: an instrument `x.y.duration` in
// seconds is `x_y_duration_seconds_bucket`, `_count` and `_sum` under the
// pinned image's translation, PR 3a's measurement), or one PR 3b's exporter
// or the image's collector writes (DASHBOARD_IMAGE_SERIES, measured on the
// pins), and every label it reads is one that name carries. Each data source
// is one the image provisions; each variable a query names is defined; no two
// panels overlap. CI's "The observability profile's dashboard reads every
// series it names" runs each query on a running profile; this holds what can
// be read without one.
/** The data sources the pinned otel-lgtm image provisions that a panel here may name, uid → type (measured on 0.36.0's grafana-datasources.yaml; its fourth, Pyroscope, holds no series the servers send). */
const DASHBOARD_DATASOURCES: Record<string, string> = { prometheus: "prometheus", loki: "loki", tempo: "tempo" };
/** The labels every series under the pinned image's Prometheus carries, from the resource: `job` and `instance`, and the attributes its OTLP receiver promotes (measured on 0.36.0; a tier's `deployment_environment_name`, `service_namespace` where set). */
const DASHBOARD_RESOURCE_LABELS = ["job", "instance", "service_name", "service_instance_id", "service_version", "service_namespace", "deployment_environment_name"];
/** The labels each instrument's points carry beside the resource's (its histogram's `le` aside), by its name in Prometheus, held here and measured on a scratch stack: the request's are telemetry.ts's METRIC_KEYS, which checkDashboard holds this list to; the provider's, the store's and a job's are spans.ts's and jobs.ts's labels with `error.type` (and, for a store fault with a SQLSTATE, `db.response.status_code`), held by hand. */
const DASHBOARD_INSTRUMENT_LABELS: Record<string, string[]> = {
  http_server_request_duration_seconds: ["http_request_method", "http_route", "http_response_status_code", "error_type", "mcp_method_name", "ob1_door", "ob1_rpc", "ob1_tool", "ob1_outcome"],
  gen_ai_client_operation_duration_seconds: ["gen_ai_operation_name", "gen_ai_request_model", "server_address", "server_port", "error_type", "ob1_probe"],
  db_client_operation_duration_seconds: ["db_system_name", "db_operation_name", "ob1_store", "error_type", "db_response_status_code"],
  ob1_job_duration_seconds: ["ob1_job_kind", "error_type"],
};
const COLLECTOR_EXPORTER = ["exporter", "server_address", "server_port", "url_path"];
const COLLECTOR_RECEIVER = ["receiver", "transport"];
/** Prometheus series that are not the servers' instruments, each with its labels beside the resource's, measured on the pins (where not, said): postgres_exporter v0.20.1 with PR 3b's flags (`up` the collector's scrape of it), and otel-lgtm 0.36.0's collector about itself (its send_failed series appear at a first failure, with no zero before it: they come by the collector's scrape of itself, not OTLP). */
const DASHBOARD_IMAGE_SERIES: Record<string, string[]> = {
  up: [], pg_up: [], pg_database_size_bytes: ["datname"],
  pg_stat_activity_count: ["datname", "state", "usename", "backend_type", "wait_event", "wait_event_type"],
  pg_stat_database_blks_hit_total: ["datid", "datname"], pg_stat_database_blks_read_total: ["datid", "datname"], pg_stat_database_numbackends: ["datid", "datname"],
  pg_stat_statements_calls_total: ["datname", "queryid", "user"], pg_stat_statements_seconds_total: ["datname", "queryid", "user"],
  pg_stat_statements_rows_total: ["datname", "queryid", "user"], pg_stat_statements_query_id_total: ["query", "queryid"],
  otelcol_exporter_sent_spans_total: COLLECTOR_EXPORTER, otelcol_exporter_sent_metric_points_total: COLLECTOR_EXPORTER, otelcol_exporter_sent_log_records_total: COLLECTOR_EXPORTER,
  otelcol_exporter_send_failed_spans_total: COLLECTOR_EXPORTER, otelcol_exporter_send_failed_metric_points_total: COLLECTOR_EXPORTER, otelcol_exporter_send_failed_log_records_total: COLLECTOR_EXPORTER,
  otelcol_receiver_refused_spans_total: COLLECTOR_RECEIVER, otelcol_receiver_refused_metric_points_total: COLLECTOR_RECEIVER, otelcol_receiver_refused_log_records_total: COLLECTOR_RECEIVER,
  otelcol_receiver_failed_spans_total: COLLECTOR_RECEIVER, otelcol_receiver_failed_metric_points_total: COLLECTOR_RECEIVER, otelcol_receiver_failed_log_records_total: COLLECTOR_RECEIVER,
  // A queue-full drop's: born at a first one (none seen), the collector's own name for it on this pin, with the queue's own labels
  // (exporter, data_type: measured on its otelcol_exporter_queue_size beside it), not the sender's (review passes 4, 5; the names unmeasured).
  otelcol_exporter_enqueue_failed_spans_total: ["exporter", "data_type"], otelcol_exporter_enqueue_failed_metric_points_total: ["exporter", "data_type"], otelcol_exporter_enqueue_failed_log_records_total: ["exporter", "data_type"],
  otelcol_process_uptime_total: [],
};
/** compose.yaml's `grafana-dashboard-provider` config, byte for byte: the one file (DASHBOARD_PATH), its folder, Grafana's UI refused a save of it, and kept, unprovisioned, should the file go. */
const DASHBOARD_PROVIDER = [
  "apiVersion: 1\n",
  "providers:\n",
  "  - name: open-brain-dashboard\n",
  "    type: file\n",
  "    folder: Open Brain\n",
  "    disableDeletion: true\n",
  "    allowUiUpdates: false\n",
  "    options:\n",
  `      path: ${DASHBOARD_PATH}\n`,
  "      foldersFromFilesStructure: false\n",
].join("");
const DASHBOARD_FILE = "deploy/observability/dashboard.json";
/** The alert rules' file (SMD-3050, check 38's), as the generator names it. */
const ALERT_FILE = INLINE_FILES.find((f) => f.config === "grafana-alert-rules")!.path;
const DASHBOARD_UNITS: Record<string, string> = { s: "_seconds", ms: "_milliseconds", By: "_bytes" };
/** The instruments server-portable/'s code records, by the name a histogram is made or a span's metric is given under (`histogram("x.duration", SPEC` or `name: "x.duration", spec: SPEC`), each named in Prometheus with its spec's unit (`unit: "s"` → `_seconds`) and labelled as DASHBOARD_INSTRUMENT_LABELS holds, and each observable gauge by its name and the unit in its own options (`createObservableGauge("process.uptime", { unit: "s"` → `process_uptime_seconds`, SMD-3050); a name whose spec it cannot find, or whose unit it does not know, is named with no unit, which no query here reads. */
function instrumentNamesIn(texts: string[]): Map<string, string[]> {
  const all = texts.join("\n");
  const names = new Map<string, string[]>();
  for (const m of all.matchAll(/(?:histogram\(|name: )"([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*\.duration)",\s*(?:spec:\s*)?([A-Z][A-Z0-9_]*)/g)) {
    const spec = new RegExp(`const ${m[2]}\\b[^=\\n]*=\\s*\\{([^}]{0,600})\\}`).exec(all);
    const unit = spec ? /\bunit:\s*"([^"]+)"/.exec(spec[1])?.[1] : undefined;
    const base = `${m[1].replace(/\./g, "_")}${(unit && DASHBOARD_UNITS[unit]) ?? ""}`;
    const labels = DASHBOARD_INSTRUMENT_LABELS[base] ?? [];
    names.set(`${base}_bucket`, [...labels, "le"]);
    for (const suffix of ["_count", "_sum"]) names.set(base + suffix, labels);
  }
  for (const m of all.matchAll(/createObservableGauge\("([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)",\s*\{([^}]{0,300})\}/g)) {
    const unit = /\bunit:\s*"([^"]+)"/.exec(m[2])?.[1];
    const base = `${m[1].replace(/\./g, "_")}${(unit && DASHBOARD_UNITS[unit]) ?? ""}`;
    names.set(base, DASHBOARD_INSTRUMENT_LABELS[base] ?? []);
  }
  return names;
}
const PROMQL_KEYWORDS = new Set(["by", "without", "on", "ignoring", "group_left", "group_right", "bool", "offset", "or", "and", "unless", "atan2", "inf", "nan"]);
/** The expression with each string's content blanked to `~`, its quotes and length kept: a regex run on it sees no `by (` or `{` inside a matcher's value, and an index into it is one into the expression. */
function maskStrings(expr: string): string {
  return expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, (q) => q[0] + "~".repeat(q.length - 2) + q[0]);
}
/** Each backtick string (PromQL's raw string, no escapes) written as a double-quoted one, so the readings of `"…"` and `'…'` read it too (SMD-3050 review pass 2: a `(` in one moved a count, a matcher in one went unread). */
const unraw = (expr: string) => expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, (q) => (q[0] === "`" ? JSON.stringify(q.slice(1, -1)) : q));
/** The expression with each `#` comment outside a string taken out (PromQL's run to the line's end), its line kept: a `(` or a word in one is not the query's (SMD-3050 review pass 1). */
function withoutComments(expr: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      out += c;
      if (c === "\\" && quote !== "`") out += expr[++i] ?? "";
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") { quote = c; out += c; }
    else if (c === "#") { while (i + 1 < expr.length && expr[i + 1] !== "\n") i++; }
    else out += c;
  }
  return out;
}
/** A grouping list's labels, a quoted one (Prometheus 3) unquoted. */
function groupingList(list: string): string[] {
  return list.split(",").map((l) => l.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2")).filter(Boolean);
}
const SELECTING_AGGREGATIONS = new Set(["topk", "bottomk", "limitk", "limit_ratio"]);
/**
 * The labels an expression's result keeps where its outermost operation is an aggregation: its `by` list,
 * or every label its names carry but its `without` list, or none (a selecting one — topk — keeps its input's);
 * undefined where the outermost operation is anything else (a function, a binary operation), which this reading
 * does not follow: a legend there is held to every label the expression's names carry (review pass 5).
 */
function outermostGrouping(expr: string, carried: Set<string>): Set<string> | undefined {
  const masked = maskStrings(expr);
  const head = /^\s*([a-z_]+)\s*(?:(by|without)\s*\(([^)]*)\)\s*)?\(/i.exec(masked);
  if (!head || !/^(sum|min|max|avg|group|stddev|stdvar|count|count_values|quantile|topk|bottomk|limitk|limit_ratio)$/i.test(head[1])) return undefined;
  let depth = 0, close = -1;
  for (let i = head[0].length - 1; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")" && --depth === 0) { close = i; break; }
  }
  if (close < 0) return undefined;
  const rest = masked.slice(close + 1);
  const trailing = /^\s*(by|without)\s*\(([^)]*)\)\s*$/i.exec(rest);
  if (rest.trim() !== "" && !trailing) return undefined;
  if (SELECTING_AGGREGATIONS.has(head[1].toLowerCase())) return carried;
  const kind = (head[2] ?? trailing?.[1])?.toLowerCase();
  const at = head[2] ? head.index + head[0].lastIndexOf("(", head[0].length - 2) : close + 1 + rest.indexOf("(");
  const list = kind ? groupingList(expr.slice(at + 1, expr.indexOf(")", at))) : [];
  const kept = kind === "by" ? new Set(list) : kind === "without" ? new Set([...carried].filter((l) => !list.includes(l))) : new Set<string>();
  if (head[1].toLowerCase() === "count_values") { const v = /\(\s*["']([^"']*)["']/.exec(expr.slice(head[0].length - 1)); if (v) kept.add(v[1]); }
  return kept;
}
/** What a PromQL expression (or a `label_values(metric, label)` variable query) reads: the metric names — what is left once strings, matchers, ranges, offsets, numbers, grouping lists, functions and keywords are taken out, and each `__name__="…"` matcher's — any `__name__` matched by regex (which this cannot hold), each selector's matcher labels by the name it selects (null where it names none), the labels its grouping lists and label_replace sources read, and those label_replace and count_values make. */
function promqlReads(given: string): { names: string[]; nameRegex: boolean; selectors: [string | null, string[]][]; labels: string[]; made: string[] } {
  const expr = unraw(given);
  const lv = /^\s*label_values\(\s*(?:(.+?)\s*,\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*$/s.exec(expr);
  if (lv) { const inner = lv[1] ? promqlReads(lv[1]) : { names: [], nameRegex: false, selectors: [], labels: [], made: [] }; return { ...inner, labels: [...inner.labels, lv[2]] }; }
  const labels: string[] = [];
  const made: string[] = [];
  const names: string[] = [];
  const selectors: [string | null, string[]][] = [];
  let nameRegex = false;
  for (const block of expr.matchAll(/([A-Za-z_:][A-Za-z0-9_:]*)?\s*\{((?:[^{}"]|"(?:[^"\\]|\\.)*")*)\}/g)) {
    let name: string | null = block[1] && !PROMQL_KEYWORDS.has(block[1].toLowerCase()) ? block[1] : null;
    const read: string[] = [];
    for (const el of block[2].match(/(?:[^,"']|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')+/g) ?? []) {
      const bare = /^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*$/.exec(el);
      if (bare) { const n = bare[1] ?? bare[2]; names.push(n); name ??= n; continue; }
      const m = /^\s*(?:([A-Za-z_][A-Za-z0-9_]*)|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*(=~|!~|!=|=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*$/.exec(el);
      if (!m) continue;
      const label = m[1] ?? m[2] ?? m[3];
      const value = m[5] ?? m[6];
      if (label === "__name__") { if (m[4] === "=") { names.push(value); name ??= value; } else nameRegex = true; } else read.push(label);
    }
    selectors.push([name, read]);
  }
  const masked = maskStrings(expr);
  for (const m of masked.matchAll(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\(([^)]*)\)/gi)) labels.push(...groupingList(expr.slice(m.index! + m[0].length - 1 - m[1].length, m.index! + m[0].length - 1)));
  // label_replace's dst is made only where it is not its own src: one that relabels a label in place (an empty value named) needs the series to carry it (review pass 3).
  for (const m of expr.matchAll(/,\s*"([^"]*)"\s*,\s*"(?:[^"\\]|\\.)*"\s*,\s*"([^"]*)"\s*,\s*"(?:[^"\\]|\\.)*"\s*\)/g)) { if (m[1] !== m[2]) made.push(m[1]); if (m[2]) labels.push(m[2]); }
  for (const m of expr.matchAll(/\bcount_values\s*(?:\b(?:by|without)\s*\([^)]*\)\s*)?\(\s*"([^"]*)"/g)) made.push(m[1]);
  let e = expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  e = e.replace(/\{[^}]*\}/g, " ").replace(/\[[^\]]*\]/g, " ");
  e = e.replace(/\boffset\s+-?[0-9][0-9a-z.]*/gi, " ").replace(/@\s*[^\s)]+/g, " ");
  e = e.replace(/\b0x[0-9a-f]+\b/gi, " ").replace(/\b[0-9]+(?:\.[0-9]*)?(?:e[+-]?[0-9]+)?\b/gi, " ");
  e = e.replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/gi, " ");
  for (const m of e.matchAll(/[A-Za-z_:][A-Za-z0-9_:]*/g)) {
    if (e.slice(m.index! + m[0].length).trimStart().startsWith("(")) continue;
    if (PROMQL_KEYWORDS.has(m[0].toLowerCase())) continue;
    names.push(m[0]);
  }
  return { names, nameRegex, selectors, labels, made };
}
/** One Prometheus query's names and labels, held to what the stack writes (check 37's rules for a panel, check 38's for an alert rule): [the rule, what is wrong]. `text` has its variables already put in; `legend` is the labels a legend shows, each held to those the result keeps. */
function promqlProblems(where: string, given: string, written: Map<string, string[]>, legend: string[] = []): ["name" | "label", string][] {
  const out: ["name" | "label", string][] = [];
  const text = withoutComments(given);
  const reads = promqlReads(text);
  const unknown = [...new Set(reads.names)].filter((n) => !written.has(n));
  if (unknown.length || reads.nameRegex) out.push(["name", `${where} reads ${[...unknown, ...(reads.nameRegex ? ["a __name__ matched by regex"] : [])].join(", ")}, which nothing in the stack writes as far as this check can hold, so it reads nothing for ever (a panel's "No data", a rule that never fires) — the names there are: the servers' instruments in server-portable/*.ts (instrumentNamesIn reads their \`*.duration\` histograms and their observable gauges alone: a new server metric, of another kind or in a subdirectory, is taught to it, not listed as an image's) and check 37's DASHBOARD_IMAGE_SERIES, measured on the pinned images`]);
  const carried = new Set([...DASHBOARD_RESOURCE_LABELS, ...reads.made, ...reads.names.flatMap((n) => written.get(n) ?? [])]);
  const stray = [...new Set(reads.labels)].filter((l) => !carried.has(l));
  for (const [name, read] of reads.selectors) {
    const own = new Set([...DASHBOARD_RESOURCE_LABELS, ...(name === null ? [...carried] : written.get(name) ?? [])]);
    for (const l of read) if (!own.has(l) && !stray.includes(l)) stray.push(l);
  }
  // A legend shows a label its result keeps: the outermost aggregation's, where that is the outermost operation (review pass 5), else one its names carry or label_replace makes (review pass 4).
  const kept = outermostGrouping(text, carried) ?? carried;
  for (const l of legend) if (l !== "__name__" && !kept.has(l) && !stray.includes(l)) stray.push(l);
  if (stray.length && !unknown.length) out.push(["label", `${where} reads label${stray.length > 1 ? "s" : ""} ${stray.join(", ")}, which the name it selects (a matcher) or none of ${reads.names.length ? [...new Set(reads.names)].join(", ") : "the names it reads (it reads none)"} (a grouping) carries (DASHBOARD_INSTRUMENT_LABELS, DASHBOARD_IMAGE_SERIES, DASHBOARD_RESOURCE_LABELS): a matcher on it matches nothing, and a grouping by it is one series`]);
  return out;
}
type DashboardRule = "copy" | "provider" | "recreate" | "json" | "identity" | "datasource" | "name" | "label" | "variable" | "layout";
const sha256Of = (text: string) => `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;
/** Every way the dashboard, its inline copy, its provider or lgtm's labels stray: [the rule, what is wrong]. `inline` and `provider` are the configs' mappings and `labels` lgtm's, as Bun.YAML reads compose.yaml; `written` each name the stack writes, with its labels; `others` the labels lgtm carries for the other inline configs (the alert rules', SMD-3050), each its sha256. */
function dashboardProblems(fileText: string, inline: unknown, provider: unknown, labels: unknown, written: Map<string, string[]>, others: Record<string, string> = {}): [DashboardRule, string][] {
  const out: [DashboardRule, string][] = [];
  const contentOf = (c: unknown) => isMapping(c) ? c.content : undefined;
  if (!isMapping(inline) || contentOf(inline) !== fileText.replace(/\$/g, "$$$$") || canonJson(Object.keys(inline)) !== canonJson(["content"])) out.push(["copy", `compose.yaml's configs.grafana-dashboard is not ${DASHBOARD_FILE} with each \`$\` doubled, as its content alone: compose reads a single \`$\` as a variable, so the dashboard Grafana loads would not be the file — run \`bun scripts/inline-grafana.ts\`, which writes it and lgtm's labels`]);
  if (!isMapping(provider) || contentOf(provider) !== DASHBOARD_PROVIDER || canonJson(Object.keys(provider)) !== canonJson(["content"])) out.push(["provider", `compose.yaml's configs.grafana-dashboard-provider is not check 37's DASHBOARD_PROVIDER byte for byte, as its content alone: it decides which file Grafana loads and whether its UI may save a change`]);
  const wantLabels = { "ob1.grafana-dashboard": sha256Of(fileText), "ob1.grafana-dashboard-provider": sha256Of(DASHBOARD_PROVIDER), ...others };
  if (canonJson(labels ?? null) !== canonJson(wantLabels)) out.push(["recreate", `compose.yaml's services.lgtm.labels is ${JSON.stringify(labels ?? null)} where it is ${JSON.stringify(wantLabels)}: compose recreates lgtm when a label changes and not when only an inline config does (docker/compose#11900), so without each config's sha256 an upgrade's \`up -d\` leaves Grafana on the old dashboard or rules — \`bun scripts/inline-grafana.ts\` writes them`]);
  let d: unknown;
  try { d = JSON.parse(fileText); } catch (e) { out.push(["json", `does not parse as JSON, so Grafana loads no dashboard: ${(e as Error).message}`]); return out; }
  if (!isMapping(d) || !Array.isArray(d.panels)) { out.push(["json", "is not a dashboard: no `panels` array"]); return out; }
  if (d.uid !== "ob1" || d.editable !== false || d.title !== "Open Brain") out.push(["identity", `has uid ${JSON.stringify(d.uid)}, editable ${JSON.stringify(d.editable)} and title ${JSON.stringify(d.title)} where they are "ob1" (the address deploy/README.md names, /grafana/d/ob1), false (Grafana's UI may not save a provisioned dashboard) and "Open Brain" (the home page's address is its slug): a copy saved in Grafana and exported has its own uid, "… Copy" and true`]);
  const vars = isMapping(d.templating) && Array.isArray(d.templating.list) ? d.templating.list.filter(isMapping) : [];
  const defined = new Set(vars.map((v) => String(v.name)));
  const ids = new Set<unknown>();
  const boxes: [string, number, number, number, number][] = [];
  const queries: [string, string, string][] = []; // [where, datasource uid, text]
  const legends = new Map<string, string[]>(); // where → the labels its legend shows
  const checkSource = (where: string, ds: unknown) => {
    if (!isMapping(ds) || typeof ds.uid !== "string" || DASHBOARD_DATASOURCES[ds.uid] === undefined || DASHBOARD_DATASOURCES[ds.uid] !== ds.type) out.push(["datasource", `${where} names data source ${JSON.stringify(ds ?? null)}, not one the pinned image provisions (${Object.entries(DASHBOARD_DATASOURCES).map(([u, t]) => `${t} "${u}"`).join(", ")}): its panel would say the data source was not found`]);
    return isMapping(ds) ? String(ds.uid) : "";
  };
  for (const v of vars) {
    const uid = checkSource(`variable ${v.name}`, v.datasource);
    const q = isMapping(v.query) ? v.query.query : v.query;
    if (typeof q === "string") queries.push([`variable ${v.name}`, uid, q]);
  }
  // A collapsed row holds its panels in its own `panels` (Grafana's model): read them too, placed by their own gridPos.
  const top = d.panels.filter(isMapping);
  const all = top.flatMap((p) => [p, ...(Array.isArray(p.panels) ? p.panels.filter(isMapping) : [])]);
  for (const p of all) {
    const where = `panel ${JSON.stringify(p.title)}`;
    if (ids.has(p.id)) out.push(["identity", `${where} reuses id ${JSON.stringify(p.id)}: Grafana keeps one of the two`]);
    ids.add(p.id);
    const g = isMapping(p.gridPos) ? p.gridPos : {};
    const [x, y, w, h] = [g.x, g.y, g.w, g.h].map(Number);
    if (![x, y, w, h].every(Number.isInteger) || x < 0 || w < 1 || h < 1 || x + w > 24) out.push(["layout", `${where} has gridPos ${JSON.stringify(p.gridPos ?? null)}, not whole numbers inside Grafana's 24 columns`]);
    else if (top.includes(p)) {
      for (const [other, ox, oy, ow, oh] of boxes) if (x < ox + ow && ox < x + w && y < oy + oh && oy < y + h) out.push(["layout", `${where} overlaps panel ${other}: Grafana moves one of them down`]);
      boxes.push([JSON.stringify(p.title), x, y, w, h]);
    }
    if (p.type === "row") continue;
    checkSource(where, p.datasource);
    for (const t of (Array.isArray(p.targets) ? p.targets : []).filter(isMapping)) {
      const uid = checkSource(`${where} query ${t.refId}`, t.datasource);
      const text = typeof t.expr === "string" ? t.expr : typeof t.query === "string" ? t.query : "";
      queries.push([`${where} query ${t.refId}`, uid, text]);
      if (uid === "prometheus" && typeof t.legendFormat === "string") legends.set(`${where} query ${t.refId}`, [...t.legendFormat.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]));
    }
  }
  for (const [where, uid, text] of queries) {
    for (const m of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) if (!m[1].startsWith("__") && !defined.has(m[1])) out.push(["variable", `${where} names $${m[1]}, which the dashboard does not define: Grafana sends it as written`]);
    if (/\[\[[A-Za-z_][A-Za-z0-9_]*(?::[^\]]*)?\]\]/.test(text)) out.push(["variable", `${where} names a variable in the old \`[[…]]\` form, which this check does not read: write it \`$name\``]);
    if (uid !== "prometheus") continue;
    out.push(...promqlProblems(where, text.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, "1"), written, legends.get(where) ?? []));
  }
  return out;
}
const DASHBOARD_PROBE = {
  uid: "ob1", editable: false, title: "Open Brain",
  templating: { list: [{ name: "service", datasource: { type: "prometheus", uid: "prometheus" }, query: { query: "label_values(http_server_request_duration_seconds_count, service_name)" } }] },
  panels: [
    { type: "row", id: 1, title: "r", gridPos: { x: 0, y: 0, w: 24, h: 1 }, datasource: undefined as unknown, targets: [] as { refId: string; datasource: { type: string; uid: string }; expr: string }[], panels: [] as unknown[], collapsed: false },
    { type: "timeseries", id: 2, title: "a", datasource: { type: "prometheus", uid: "prometheus" } as unknown, gridPos: { x: 0, y: 1, w: 12, h: 8 }, targets: [{ refId: "A", datasource: { type: "prometheus", uid: "prometheus" }, expr: 'histogram_quantile(0.99, sum by (le, ob1_tool) (rate(http_server_request_duration_seconds_bucket{service_name=~"$service"}[$__rate_interval] offset 1h)))' }], panels: [] as unknown[], collapsed: false },
    { type: "logs", id: 3, title: "b", datasource: { type: "loki", uid: "loki" } as unknown, gridPos: { x: 12, y: 1, w: 12, h: 8 }, targets: [{ refId: "A", datasource: { type: "loki", uid: "loki" }, expr: '{service_name=~"$service"} | json' }], panels: [] as unknown[], collapsed: false },
  ],
};
/** The probe dashboard's text, changed by `mutate`. */
function dashboardProbe(mutate?: (d: typeof DASHBOARD_PROBE) => void): string {
  const d = structuredClone(DASHBOARD_PROBE);
  mutate?.(d);
  return JSON.stringify(d, null, 1);
}
const DASHBOARD_PROBE_CODE = 'const REQUEST_DURATION: HistogramSpec = {\n  unit: "s",\n  bounds: [1],\n};\nhistogram("http.server.request.duration", REQUEST_DURATION)';
const DASHBOARD_PROBE_WRITTEN = new Map([...instrumentNamesIn([DASHBOARD_PROBE_CODE]), ["pg_stat_statements_seconds_total", ["datname", "queryid", "user"]], ["pg_stat_statements_query_id_total", ["query", "queryid"]]]);
const inlined = (text: string) => ({ content: text.replace(/\$/g, "$$$$") });
const HELD = { content: DASHBOARD_PROVIDER };
const labelled = (text: string, provider = DASHBOARD_PROVIDER) => ({ "ob1.grafana-dashboard": sha256Of(text), "ob1.grafana-dashboard-provider": sha256Of(provider) });
/** [what, the file's text, its inline config, the provider config, lgtm's labels, the rules reported]. */
const DASHBOARD_PROBES: [string, string, unknown, unknown, unknown, DashboardRule[]][] = [
  ["the dashboard as held", dashboardProbe(), inlined(dashboardProbe()), HELD, labelled(dashboardProbe()), []],
  ["an inline copy whose dollar signs compose would read as variables", dashboardProbe(), { content: dashboardProbe() }, HELD, labelled(dashboardProbe()), ["copy"]],
  ["an inline copy from an older file", dashboardProbe((d) => { d.panels[1].title = "a2"; }), inlined(dashboardProbe()), HELD, labelled(dashboardProbe((d) => { d.panels[1].title = "a2"; })), ["copy"]],
  ["an inline copy mounted from a file instead", dashboardProbe(), { ...inlined(dashboardProbe()), file: "./observability/dashboard.json" }, HELD, labelled(dashboardProbe()), ["copy"]],
  ["a provider letting the UI save a change", dashboardProbe(), inlined(dashboardProbe()), { content: DASHBOARD_PROVIDER.replace("allowUiUpdates: false", "allowUiUpdates: true") }, labelled(dashboardProbe()), ["provider"]],
  ["a provider reading a directory", dashboardProbe(), inlined(dashboardProbe()), { content: DASHBOARD_PROVIDER.replace(DASHBOARD_PATH, "/otel-lgtm") }, labelled(dashboardProbe()), ["provider"]],
  ["lgtm's label naming an older dashboard, so an upgrade's up -d keeps it", dashboardProbe(), inlined(dashboardProbe()), HELD, labelled(dashboardProbe((d) => { d.panels[1].title = "a0"; })), ["recreate"]],
  ["lgtm with no labels, as before review pass 1", dashboardProbe(), inlined(dashboardProbe()), HELD, undefined, ["recreate"]],
  ["lgtm's provider label naming an older provider (review pass 2)", dashboardProbe(), inlined(dashboardProbe()), HELD, labelled(dashboardProbe(), DASHBOARD_PROVIDER.replace("folder: Open Brain", "folder: Old")), ["recreate"]],
  ["a third label on lgtm (review pass 2)", dashboardProbe(), inlined(dashboardProbe()), HELD, { ...labelled(dashboardProbe()), "ob1.extra": "x" }, ["recreate"]],
  ["a file that is not JSON", "{", inlined("{"), HELD, labelled("{"), ["json"]],
  ...([
    ["another uid", (d) => { d.uid = "x"; }, ["identity"]],
    ["an editable dashboard", (d) => { d.editable = true as false; }, ["identity"]],
    ["a copy's title (review pass 4)", (d) => { (d as Record<string, unknown>).title = "Open Brain Copy"; }, ["identity"]],
    ["two panels with one id", (d) => { d.panels[2].id = 2; }, ["identity"]],
    ["a data source the image does not provision", (d) => { d.panels[2].datasource = { type: "loki", uid: "loki2" }; }, ["datasource"]],
    ["a query's data source of another type than its uid's", (d) => { d.panels[1].targets[0].datasource = { type: "loki", uid: "prometheus" }; }, ["datasource"]],
    ["a variable on a data source the image does not provision", (d) => { d.templating.list[0].datasource = { type: "prometheus", uid: "mimir" }; }, ["datasource"]],
    ["a metric nothing writes", (d) => { d.panels[1].targets[0].expr = d.panels[1].targets[0].expr.replace("duration_seconds_bucket", "duration_bucket"); }, ["name"]],
    ["a metric named by an exact __name__ matcher that nothing writes", (d) => { d.panels[1].targets[0].expr = 'sum(rate({__name__="ghost_metric_total"}[5m]))'; }, ["name"]],
    ["a metric named by a regex on __name__", (d) => { d.panels[1].targets[0].expr = 'sum(rate({__name__=~"http_.+"}[5m]))'; }, ["name"]],
    ["a variable query on a metric nothing writes", (d) => { d.templating.list[0].query.query = "label_values(ob1_request_duration_count, service_name)"; }, ["name"]],
    ["a panel in a collapsed row reading a metric nothing writes", (d) => { d.panels[0].collapsed = true; d.panels[0].panels = [{ type: "timeseries", id: 9, title: "hidden", datasource: { type: "prometheus", uid: "prometheus" }, gridPos: { x: 0, y: 1, w: 12, h: 8 }, targets: [{ refId: "A", datasource: { type: "prometheus", uid: "prometheus" }, expr: "sum(rate(ghost_metric_total[5m]))" }] }]; }, ["name"]],
    ["a grouping by a label the metric does not carry", (d) => { d.panels[1].targets[0].expr = d.panels[1].targets[0].expr.replace("by (le, ob1_tool)", "by (le, ob1_tools)"); }, ["label"]],
    ["a matcher on a label the metric does not carry", (d) => { d.panels[1].targets[0].expr = d.panels[1].targets[0].expr.replace('service_name=~"$service"', 'ob1_outcomes="error"'); }, ["label"]],
    ["…written as a backtick string (SMD-3050 review pass 2)", (d) => { d.panels[1].targets[0].expr = d.panels[1].targets[0].expr.replace('service_name=~"$service"', "ob1_outcomes=`error`"); }, ["label"]],
    ["a matcher on a label another name in the expression carries but its own does not (review pass 2)", (d) => { d.panels[1].targets[0].expr = 'sum(rate(pg_stat_statements_seconds_total[5m])) * on (queryid) group_left (query) max by (queryid, query) (pg_stat_statements_query_id_total{datname="x"})'; }, ["label"]],
    ["a label_replace relabelling a label in place that its series does not carry (review pass 3)", (d) => { d.panels[1].targets[0].expr = 'label_replace(sum by (ob1_tools) (rate(http_server_request_duration_seconds_count[5m])), "ob1_tools", "(none)", "ob1_tools", "")'; }, ["label"]],
    ["a label_replace whose source its series does not carry", (d) => { d.panels[1].targets[0].expr = 'label_replace(sum(rate(http_server_request_duration_seconds_count[5m])), "door", "$1", "ob1_doors", "(.*)")'; }, ["label"]],
    ["a label_replace making a new label, grouped by after", (d) => { d.panels[1].targets[0].expr = 'sum by (door) (label_replace(rate(http_server_request_duration_seconds_count[5m]), "door", "$1", "ob1_door", "(.*)"))'; }, []],
    ["a quoted metric name nothing writes (Prometheus 3's selector)", (d) => { d.panels[1].targets[0].expr = 'min({"ghost_up", job="postgres"})'; }, ["name"]],
    ["a quoted metric name nothing writes, after a matcher (review pass 4)", (d) => { d.panels[1].targets[0].expr = 'min({job="postgres", "ghost_up"})'; }, ["name"]],
    ["a quoted label name the metric does not carry", (d) => { d.panels[1].targets[0].expr = 'sum(rate(http_server_request_duration_seconds_count{"ghost.label"="x"}[5m]))'; }, ["label"]],
    ["a quoted grouping label the metric carries", (d) => { d.panels[1].targets[0].expr = 'sum by ("ob1_tool") (rate(http_server_request_duration_seconds_count[5m]))'; }, []],
    ["a legend showing a label the query does not keep", (d) => { (d.panels[1].targets[0] as Record<string, unknown>).legendFormat = "{{ob1_tools}}"; }, ["label"]],
    ["a legend showing a label a without list keeps (review pass 5)", (d) => { d.panels[1].targets[0].expr = 'sum without (le, instance) (rate(http_server_request_duration_seconds_bucket[5m]))'; (d.panels[1].targets[0] as Record<string, unknown>).legendFormat = "{{ob1_tool}}"; }, []],
    ["a legend showing the label a without list drops", (d) => { d.panels[1].targets[0].expr = 'sum without (ob1_outcome) (rate(http_server_request_duration_seconds_count[5m]))'; (d.panels[1].targets[0] as Record<string, unknown>).legendFormat = "{{ob1_outcome}}"; }, ["label"]],
    ["a `by (x)` inside a matcher's value is no grouping", (d) => { d.panels[1].targets[0].expr = 'rate(http_server_request_duration_seconds_count{ob1_tool=~"by (x)"}[5m])'; (d.panels[1].targets[0] as Record<string, unknown>).legendFormat = "{{ob1_tool}}"; }, []],
    ["a single-quoted matcher on a label the metric does not carry", (d) => { d.panels[1].targets[0].expr = "sum(rate(http_server_request_duration_seconds_count{ghost_label='x'}[5m]))"; }, ["label"]],
    ["a single-quoted value holding a comma is one matcher, on a label the metric does not carry", (d) => { d.panels[1].targets[0].expr = "sum(rate(http_server_request_duration_seconds_count{ghost_label='a,b'}[5m]))"; }, ["label"]],
    ["a single-quoted metric name nothing writes", (d) => { d.panels[1].targets[0].expr = "min({'ghost_up', job=\"postgres\"})"; }, ["name"]],
    ["a legend showing the label a grouping dropped", (d) => { d.panels[1].targets[0].expr = 'sum by (ob1_door) (rate(http_server_request_duration_seconds_count[5m]))'; (d.panels[1].targets[0] as Record<string, unknown>).legendFormat = "{{ob1_tool}}"; }, ["label"]],
    ["a matcher beside an exact __name__ on a label that name does not carry", (d) => { d.panels[1].targets[0].expr = 'max by (queryid) (pg_stat_statements_seconds_total) * on (queryid) group_left (query) max by (queryid, query) ({__name__="pg_stat_statements_query_id_total", datname="x"})'; }, ["label"]],
    ["a regex class in a log query is no variable", (d) => { d.panels[2].targets[0].expr = '{service_name=~"$service"} |~ "[[:alpha:]]+"'; }, []],
    ["atan2, offset, a number and count_values' label read as none of the names", (d) => { d.panels[1].targets[0].expr = 'count_values by (v) ("v", http_server_request_duration_seconds_count offset 1h) atan2 1e3'; }, []],
    ["a variable the dashboard does not define", (d) => { d.panels[2].targets[0].expr = '{service_name=~"$server"}'; }, ["variable"]],
    ["a variable in the old [[…]] form", (d) => { d.panels[2].targets[0].expr = '{service_name=~"[[service]]"}'; }, ["variable"]],
    ["two panels on one place", (d) => { d.panels[2].gridPos.x = 6; }, ["layout"]],
    ["a panel past the 24 columns", (d) => { d.panels[2].gridPos.x = 13; }, ["layout"]],
  ] as [string, (d: typeof DASHBOARD_PROBE) => void, DashboardRule[]][]).map(([what, mutate, rules]): [string, string, unknown, unknown, unknown, DashboardRule[]] => [what, dashboardProbe(mutate), inlined(dashboardProbe(mutate)), HELD, labelled(dashboardProbe(mutate)), rules]),
];
/** [what, code, a name instrumentNamesIn must read (or, led by "!", must not)]. */
const INSTRUMENT_PROBES: [string, string, string][] = [
  ["an instrument in seconds", DASHBOARD_PROBE_CODE, "http_server_request_duration_seconds_count"],
  ["an instrument whose unit became milliseconds is not the seconds name", DASHBOARD_PROBE_CODE.replace('unit: "s"', 'unit: "ms"'), "!http_server_request_duration_seconds_count"],
  ["a span's metric by its spec", 'const JOB_DURATION: HistogramSpec = {\n  unit: "s",\n};\nmetric: { name: "ob1.job.duration", spec: JOB_DURATION, labels }', "ob1_job_duration_seconds_bucket"],
  ["an observable gauge in seconds (SMD-3050)", 'provider.getMeter("ob1").createObservableGauge("process.uptime", { unit: "s", description: "x" })', "process_uptime_seconds"],
  ["an observable gauge whose unit became milliseconds is not the seconds name", 'provider.getMeter("ob1").createObservableGauge("process.uptime", { unit: "ms", description: "x" })', "!process_uptime_seconds"],
];
function checkDashboard() {
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    fail(SELF, `check 37 parses deploy/compose.yaml with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-1849)`);
    return;
  }
  for (const [what, text, inline, provider, labels, expected] of DASHBOARD_PROBES) {
    const got = dashboardProblems(text, inline, provider, labels, DASHBOARD_PROBE_WRITTEN).map(([rule]) => rule);
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(SELF, `check 37 no longer reports exactly ${JSON.stringify(expected)} for its probe "${what}" (reported ${JSON.stringify(got)})`);
  }
  for (const [what, code, name] of INSTRUMENT_PROBES) {
    const has = instrumentNamesIn([code]).has(name.replace(/^!/, ""));
    if (has === name.startsWith("!")) fail(SELF, `check 37's instrument reading no longer holds its probe "${what}" (${name})`);
  }
  const code = readdirSync(join(ROOT, "server-portable")).filter((f) => f.endsWith(".ts") && !f.startsWith("test-")).map((f) => readFileSync(join(ROOT, "server-portable", f), "utf8"));
  const instruments = instrumentNamesIn(code);
  const metricKeys = /const METRIC_KEYS = \[([^\]]*)\]/.exec(readFileSync(join(ROOT, "server-portable/telemetry.ts"), "utf8"));
  const requestLabels = metricKeys ? [...metricKeys[1].matchAll(/"([a-z0-9_.]+)"/g)].map((m) => m[1].replace(/\./g, "_")) : [];
  if (!requestLabels.length) { fail(SELF, "check 37 reads no METRIC_KEYS from server-portable/telemetry.ts — the reading is broken, or the request's labels moved: the dashboard reads them"); return; }
  if (canonJson([...requestLabels].sort()) !== canonJson([...DASHBOARD_INSTRUMENT_LABELS.http_server_request_duration_seconds].sort())) fail(SELF, `check 37's DASHBOARD_INSTRUMENT_LABELS.http_server_request_duration_seconds is ${JSON.stringify(DASHBOARD_INSTRUMENT_LABELS.http_server_request_duration_seconds)} where telemetry.ts's METRIC_KEYS give ${JSON.stringify(requestLabels)}: a label the request's point no longer carries leaves a panel's legend blank, and the dashboard reads them (SMD-1849 PR 3c review pass 2)`);
  // Were these missed, the reading is broken, not the dashboard.
  for (const n of Object.keys(DASHBOARD_INSTRUMENT_LABELS)) if (!instruments.has(`${n}_count`)) { fail(SELF, `check 37 reads no ${n} from server-portable/'s code, in seconds — the reading is broken, or the instrument moved: the dashboard reads it`); return; }
  const composeText = readFileSync(join(ROOT, "deploy/compose.yaml"), "utf8");
  const doc = Bun.YAML.parse(composeText);
  const configs = isMapping(doc) && isMapping(doc.configs) ? doc.configs : {};
  const lgtm = isMapping(doc) && isMapping(doc.services) && isMapping(doc.services.lgtm) ? doc.services.lgtm : {};
  let fileText: string;
  try { fileText = readFileSync(join(ROOT, DASHBOARD_FILE), "utf8"); } catch { fail(DASHBOARD_FILE, "missing — compose.yaml's lgtm loads it as the observability profile's dashboard (check 37, SMD-1849)"); return; }
  // The alert rules' file (check 38's), whose sha256 is lgtm's third label.
  let alertText: string | undefined;
  try { alertText = readFileSync(join(ROOT, ALERT_FILE), "utf8"); } catch { fail(ALERT_FILE, "missing — compose.yaml's lgtm loads it as the observability profile's alert rules (check 38, SMD-3050)"); }
  // Missing, the label is left as it stands and the dashboard still held (review pass 2).
  const standing: Record<string, string> = isMapping(lgtm.labels) && typeof lgtm.labels["ob1.grafana-alert-rules"] === "string" ? { "ob1.grafana-alert-rules": lgtm.labels["ob1.grafana-alert-rules"] } : {};
  const others: Record<string, string> = alertText === undefined ? standing : { "ob1.grafana-alert-rules": sha256Of(alertText) };
  // The generator the README and these messages name, run on the tree: where it can no longer write compose.yaml's copies, it says so here (review pass 5).
  if (alertText !== undefined) try { inlinedGrafana(composeText, { "grafana-dashboard": fileText, "grafana-alert-rules": alertText }); } catch (e) { fail("scripts/inline-grafana.ts", `can no longer write compose.yaml's inline copies of the dashboard and the alert rules: ${(e as Error).message} — the README sends an operator to it (checks 37 and 38, SMD-1849, SMD-3050)`); }
  const written = new Map([...instruments, ...Object.entries(DASHBOARD_IMAGE_SERIES)]);
  for (const [rule, detail] of dashboardProblems(fileText, configs["grafana-dashboard"], configs["grafana-dashboard-provider"], lgtm.labels, written, others)) {
    fail(rule === "copy" || rule === "provider" || rule === "recreate" ? "deploy/compose.yaml" : DASHBOARD_FILE, `${detail} (check 37, SMD-1849)`);
  }
}
checkDashboard();

// ── 38. The provisioned alert rules read what the stack writes, and send only names and numbers (SMD-3050) ──
//
// lgtm's Grafana loads deploy/observability/alert-rules.yaml at its start, from
// the `grafana-alert-rules` config (inline as the dashboard is, each `$`
// doubled; lgtm's label for it is check 37's), into the dashboard's folder. A
// rule whose query reads a name or label nothing writes never fires, and looks
// like a quiet stack, so each Prometheus query is held as a panel's is
// (promqlProblems, check 37's names and labels). The file provisions no contact
// point, policy or template: a rule that fires is in Grafana's alert list, and
// nothing leaves the machine until an operator adds a contact point (SMD-1849's
// telemetry stays local; deploy/README.md, "Alerts"). What a contact point
// would carry is each alert's labels and annotations, so each query is an
// aggregation at its outermost by ALERT_LABELS alone (or by nothing) and makes
// no label — no query's text, no database or role — and an annotation templates
// only those and the rule's values; and a `$` stands nowhere Grafana expands
// one. What Grafana refuses outright is not copied: it refuses the file and
// lgtm does not start, which CI's observability step sees — that step reads the
// rules back, holds four normal and the provider rule pending after its
// traffic, then the Postgres rule pending with pg-exporter stopped. This holds
// what can be read without a running profile.
/** The labels an alert may carry beside Grafana's own (alertname, grafana_folder): what a contact point sends with it. One added is a label every notification carries, on purpose. */
const ALERT_LABELS = ["service_name", "deployment_environment_name", "gen_ai_operation_name", "error_type"];
/** The rules, by uid: one dropped or added is a change here, and in deploy/README.md's list, on purpose. */
const ALERT_RULE_UIDS = ["ob1-server-silent", "ob1-server-failures", "ob1-provider-failures", "ob1-postgres-unreached", "ob1-telemetry-lost"];
/** An annotation's template: a label (`{{ $labels.x }}`) or a value (`{{ $values.A.Value }}`), either through one of Grafana's humanizers, trim markers allowed. */
const ALERT_TEMPLATE = /^\{\{-?\s*(?:(?:humanize|humanizePercentage|humanizeDuration)\s+)?\$(?:labels\.([A-Za-z_][A-Za-z0-9_]*)|values\.([A-Za-z0-9_]+)\.Value)\s*-?\}\}$/;
/**
 * The labels an alert from `expr` carries, where its outermost operation is an aggregation `by` a list (that list) or
 * with no grouping (none) — exact, as Prometheus defines an aggregation's result; undefined for any other shape (a binary
 * operation, a function, `without`, a selecting or label-making aggregation, a `by` on both sides, which Prometheus
 * refuses), which check 38 refuses, so it never has to follow PromQL's operators (review pass 1: a label read through
 * `or`, `group_left` or a comment slipped past a reading of them).
 */
function alertGrouping(expr: string): string[] | undefined {
  const masked = maskStrings(expr);
  const head = /^\s*(sum|min|max|avg|group|count|stddev|stdvar|quantile)\s*(?:(by|without)\s*\(([^)]*)\)\s*)?\(/di.exec(masked);
  if (!head) return undefined;
  let depth = 0, close = -1;
  for (let i = head[0].length - 1; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")" && --depth === 0) { close = i; break; }
  }
  if (close < 0) return undefined;
  const rest = masked.slice(close + 1);
  const trailing = /^\s*(by|without)\s*\(([^)]*)\)\s*$/di.exec(rest);
  if (rest.trim() !== "" && !trailing) return undefined;
  if (head[2] && trailing) return undefined;
  const kind = (head[2] ?? trailing?.[1])?.toLowerCase();
  if (kind === undefined) return [];
  if (kind === "without") return undefined;
  const [from, to] = head[2] ? head.indices![3] : trailing!.indices![2].map((x) => x + close + 1);
  return groupingList(expr.slice(from, to));
}
/** Each place in the file a `$` stands where Grafana expands it as it provisions (`$VAR`, `${VAR}`, `$__env{…}`, `$__file{…}`, measured on the pin for a title and labels): every key and string but an annotation's value and a query's model, which it reads raw (review passes 2, 3). */
function expandedDollars(v: unknown, path: string, raw: boolean): string[] {
  if (typeof v === "string") return !raw && v.includes("$") ? [path] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => expandedDollars(x, `${path}[${i}]`, raw));
  if (!isMapping(v)) return [];
  return Object.entries(v).flatMap(([k, x]) => [
    ...(k.includes("$") ? [`${path}.${k} (its key)`] : []),
    ...expandedDollars(x, `${path}.${k}`, raw || /\.annotations$/.test(path) || (k === "model" && /\.data\[\d+\]$/.test(path))),
  ]);
}
type AlertRuleProblem = "copy" | "yaml" | "contact" | "delete" | "group" | "identity" | "query" | "name" | "label" | "sent" | "template";
/**
 * Every way the alert rules' file, or its inline copy, strays: [the rule, what is wrong]. `inline` is the config's mapping
 * as Bun.YAML reads compose.yaml; `written` each name the stack writes, with its labels; `uids` the rules the file holds.
 * What Grafana itself refuses (an interval, an evaluator, a uid's length) is not copied here: it refuses the file and
 * `lgtm` does not start (measured), which CI's observability step reads (review pass 3).
 */
function alertRulesProblems(fileText: string, inline: unknown, written: Map<string, string[]>, uids: string[] = ALERT_RULE_UIDS): [AlertRuleProblem, string][] {
  const out: [AlertRuleProblem, string][] = [];
  if (!isMapping(inline) || inline.content !== fileText.replace(/\$/g, "$$$$") || canonJson(Object.keys(inline)) !== canonJson(["content"])) out.push(["copy", `compose.yaml's configs.grafana-alert-rules is not ${ALERT_FILE} with each \`$\` doubled, as its content alone: compose reads a single \`$\` as a variable, so the rules Grafana loads would not be the file — run \`bun scripts/inline-grafana.ts\`, which writes it and lgtm's labels`]);
  let d: unknown;
  try { d = Bun.YAML.parse(fileText); } catch (e) { out.push(["yaml", `does not parse as YAML, so Grafana loads no rule: ${(e as Error).message}`]); return out; }
  if (!isMapping(d) || d.apiVersion !== 1 || !Array.isArray(d.groups)) { out.push(["yaml", "is not Grafana's alerting provisioning file: apiVersion 1 and a `groups` list"]); return out; }
  const extra = Object.keys(d).filter((k) => !["apiVersion", "groups", "deleteRules"].includes(k));
  if (extra.length) out.push(["contact", `provisions ${extra.join(", ")} beside its rules: the file ships no contact point, policy or template — a rule that fires stays in Grafana's alert list, and nothing leaves the machine until an operator adds a contact point (deploy/README.md, "Alerts")`]);
  const dollars = expandedDollars(d, "file", false);
  if (dollars.length) out.push(["sent", `holds a \`$\` at ${dollars.join(", ")}, where Grafana expands it from its environment or a file as it loads the rule ($VAR, $__env{…}, $__file{…}; measured): lgtm's admin password, say, would ride every notification — a \`$\` belongs in an annotation's template or a query alone`]);
  const groups = d.groups.filter(isMapping);
  if (groups.length !== 1 || d.groups.length !== 1) { out.push(["group", `has ${d.groups.length} groups where it has one, "Open Brain"`]); if (!groups.length) return out; }
  const g = groups[0];
  if (g.orgId !== 1 || g.name !== "Open Brain" || g.folder !== "Open Brain" || !Array.isArray(g.rules)) out.push(["group", `its group is orgId ${JSON.stringify(g.orgId)}, name ${JSON.stringify(g.name)}, folder ${JSON.stringify(g.folder)} where it is orgId 1, "Open Brain" in the dashboard's folder "Open Brain", with a \`rules\` list`]);
  const rules = Array.isArray(g.rules) ? g.rules.filter(isMapping) : [];
  // A rule taken out of the file stays in Grafana, evaluating, until a deletion names it (measured): the one way out.
  const deletions = d.deleteRules;
  if (deletions !== undefined && (!Array.isArray(deletions) || deletions.some((x) => !isMapping(x) || x.orgId !== 1 || typeof x.uid !== "string" || canonJson(Object.keys(x).sort()) !== canonJson(["orgId", "uid"]) || rules.some((r) => r.uid === x.uid)))) out.push(["delete", `its deleteRules is not a list of { orgId: 1, uid } naming rules the file no longer holds: ${JSON.stringify(deletions)}`]);
  const seenUid = new Set<unknown>(), seenTitle = new Set<unknown>();
  for (const r of rules) {
    const where = `rule ${JSON.stringify(r.uid)}`;
    if (typeof r.uid !== "string" || r.uid === "" || seenUid.has(r.uid) || typeof r.title !== "string" || r.title === "" || seenTitle.has(r.title)) out.push(["identity", `${where} (${JSON.stringify(r.title)}) has no uid or title of its own: Grafana keeps the last of two rules with one uid, and two with one title send one alertname`]);
    seenUid.add(r.uid); seenTitle.add(r.title);
    if ("notification_settings" in r) out.push(["contact", `${where} names a receiver in notification_settings: the file ships no contact point, so the rule would route to one that is not there`]);
    if ("labels" in r && r.labels !== undefined && (!isMapping(r.labels) || Object.values(r.labels).some((v) => typeof v !== "string" || v.includes("{{")))) out.push(["sent", `${where} sets labels of its own, ${JSON.stringify(r.labels)}, that are not plain words: every notification of it carries them, so a templated one would carry what the template reads`]);
    if (r.isPaused === true) out.push(["query", `${where} is paused, so it never fires`]);
    if ("record" in r) out.push(["query", `${where} has a \`record\` block, which makes it a recording rule that never fires`]);
    const data = Array.isArray(r.data) ? r.data.filter(isMapping) : [];
    const refs = data.map((q) => q.refId);
    const kept = new Set<string>();
    let read = true; // whether every query was read, so `kept` is the result's whole
    for (const q of data) {
      const model = isMapping(q.model) ? q.model : {};
      if (q.datasourceUid === "prometheus" && typeof model.expr === "string") {
        out.push(...promqlProblems(`${where} query ${q.refId}`, model.expr, written));
        const expr = withoutComments(model.expr);
        const keeps = alertGrouping(expr);
        const making = /\b(label_replace|label_join|count_values)\b/i.exec(maskStrings(expr));
        if (keeps === undefined || making) {
          out.push(["sent", `${where} query ${q.refId} ${making ? `makes a label (${making[1]})` : "is not an aggregation at its outermost — by a list, or by nothing"}: an alert carries every label its result keeps, values and all, so each query here is \`<sum|min|max|avg|group|count|stddev|stdvar|quantile> by (<labels of ALERT_LABELS>) (…)\` or the same by nothing, and makes no label — wrap it in one, which also says exactly what it keeps`]);
          read = false;
        } else {
          for (const l of keeps) kept.add(l);
          const sent = keeps.filter((l) => !ALERT_LABELS.includes(l));
          if (sent.length) out.push(["sent", `${where} query ${q.refId}'s result keeps ${sent.join(", ")}, which every notification of it would carry: an alert carries ALERT_LABELS alone (${ALERT_LABELS.join(", ")}) — group its result by those, or add one there on purpose`]);
        }
      } else if (q.datasourceUid !== "__expr__") {
        out.push(["query", `${where} query ${q.refId} is ${q.datasourceUid === "prometheus" ? "a Prometheus query with no expr" : `on data source ${JSON.stringify(q.datasourceUid)}`}: a rule here reads the pinned image's Prometheus ("prometheus", an expr this check reads) and Grafana's expressions ("__expr__") alone — another source's result, a log line's say, would ride the notification unread`]);
        read = false;
      }
    }
    const annotations = isMapping(r.annotations) ? r.annotations : {};
    for (const [key, value] of Object.entries(annotations)) {
      const text = String(value);
      for (const t of text.match(/\{\{[^}]*\}\}/g) ?? []) {
        const m = ALERT_TEMPLATE.exec(t);
        if (!m || (m[1] !== undefined && read && !kept.has(m[1])) || (m[2] !== undefined && !refs.includes(m[2]))) out.push(["template", `${where}'s ${key} templates ${t}, not a label its result keeps (${[...kept].join(", ") || "none"}) or one of its values (${refs.join(", ")}), through humanize at most: a notification carries the annotation, so it says names and numbers alone (and a label the result does not keep prints [no value])`]);
      }
      if ((text.match(/\{\{/g) ?? []).length !== (text.match(/\{\{[^}]*\}\}/g) ?? []).length) out.push(["template", `${where}'s ${key} has a \`{{\` that does not close as one template: this check reads each template whole`]);
    }
  }
  const have = rules.map((r) => r.uid);
  if (canonJson([...have].sort()) !== canonJson([...uids].sort())) out.push(["identity", `holds rules ${JSON.stringify(have)} where check 38's ALERT_RULE_UIDS holds ${JSON.stringify(uids)}: a rule dropped or added is a change there, and in deploy/README.md's list, on purpose (one dropped is also a deleteRules entry, or it stays in Grafana)`]);
  return out;
}
type AlertProbeRule = Mapping & { data: Mapping[]; annotations: Mapping };
type AlertProbe = Mapping & { groups: (Mapping & { rules: AlertProbeRule[] })[] };
const ALERT_PROBE: AlertProbe = {
  apiVersion: 1,
  groups: [{ orgId: 1, name: "Open Brain", folder: "Open Brain", interval: "30s", rules: [{
    uid: "probe", title: "Probe", condition: "B", noDataState: "OK", execErrState: "Error", for: "5m",
    data: [
      { refId: "A", datasourceUid: "prometheus", model: { refId: "A", instant: true, expr: 'max by (service_name) (sum by (service_name) (rate(http_server_request_duration_seconds_count{ob1_outcome="error"}[10m])) / sum by (service_name) (rate(http_server_request_duration_seconds_count[10m])))' } },
      { refId: "B", datasourceUid: "__expr__", model: { refId: "B", type: "threshold", expression: "A", conditions: [{ evaluator: { type: "gt", params: [0.05] } }] } },
    ],
    annotations: { summary: "{{ $labels.service_name }} failed {{ humanizePercentage $values.A.Value }}" },
  }] }],
};
/** The probe file's text, changed by `mutate`. */
function alertProbe(mutate?: (d: AlertProbe) => void): string {
  const d = structuredClone(ALERT_PROBE);
  mutate?.(d);
  return Bun.YAML.stringify(d, null, 2);
}
const rule0 = (d: AlertProbe) => d.groups[0].rules[0];
const exprA = (d: AlertProbe, expr: string) => { rule0(d).data[0].model = { ...rule0(d).data[0].model as Mapping, expr }; };
/** [what, mutation, the rules that alone must catch it]. */
const ALERT_PROBES: [string, (d: AlertProbe) => void, AlertRuleProblem[]][] = [
  ["the probe as held", () => {}, []],
  ["a contact point beside the rules", (d) => { d.contactPoints = [{ orgId: 1, name: "x", receivers: [{ uid: "x", type: "webhook", settings: { url: "http://x" } }] }]; }, ["contact"]],
  ["a policy beside the rules", (d) => { d.policies = [{ orgId: 1, receiver: "x" }]; }, ["contact"]],
  ["a rule routed to a receiver", (d) => { rule0(d).notification_settings = { receiver: "x" }; }, ["contact"]],
  ["a rule taken out, deleted by uid (review pass 3)", (d) => { d.deleteRules = [{ orgId: 1, uid: "ob1-gone" }]; }, []],
  ["a deletion naming a rule the file holds", (d) => { d.deleteRules = [{ orgId: 1, uid: "probe" }]; }, ["delete"]],
  ["a deletion in another organisation", (d) => { d.deleteRules = [{ orgId: 2, uid: "ob1-gone" }]; }, ["delete"]],
  ["a group in another folder", (d) => { d.groups[0].folder = "General"; }, ["group"]],
  ["a group of another name", (d) => { d.groups[0].name = "Other"; }, ["group"]],
  ["a group of another organisation", (d) => { d.groups[0].orgId = 2; }, ["group"]],
  ["a second group", (d) => { d.groups.push({ ...structuredClone(d.groups[0]), name: "Other", rules: [] }); }, ["group"]],
  ["a rule twice", (d) => { d.groups[0].rules.push(structuredClone(rule0(d))); }, ["identity"]],
  ["a uid twice under two titles", (d) => { d.groups[0].rules.push({ ...structuredClone(rule0(d)), title: "Other" }); }, ["identity"]],
  ["a title twice under two uids", (d) => { d.groups[0].rules.push({ ...structuredClone(rule0(d)), uid: "probe2" }); }, ["identity"]],
  ["a query on Loki", (d) => { rule0(d).data[0].datasourceUid = "loki"; }, ["query"]],
  ["a paused rule", (d) => { rule0(d).isPaused = true; }, ["query"]],
  ["a recording rule", (d) => { rule0(d).record = { metric: "x", from: "A" }; }, ["query"]],
  ["a name nothing writes", (d) => exprA(d, "sum by (service_name) (http_server_requests_total)"), ["name"]],
  ["a matcher on a label the name does not carry", (d) => exprA(d, 'sum by (service_name) (http_server_request_duration_seconds_count{datname="x"})'), ["label"]],
  ["a result keeping a statement's text", (d) => { exprA(d, "sum by (query) (pg_stat_statements_query_id_total)"); rule0(d).annotations.summary = "{{ $labels.query }}"; }, ["sent"]],
  ["a result keeping every label (no aggregation)", (d) => exprA(d, "rate(http_server_request_duration_seconds_count[10m])"), ["sent"]],
  ["a binary operation whose first operand keeps a tool's name", (d) => exprA(d, "sum by (service_name, ob1_tool) (http_server_request_duration_seconds_count) > 0"), ["sent"]],
  ["an `or` whose second operand keeps a tool's name", (d) => exprA(d, "sum by (service_name) (http_server_request_duration_seconds_count) or sum by (ob1_tool) (http_server_request_duration_seconds_count)"), ["sent"]],
  ["a label-only first operand of `and` keeping a label of its own (review pass 1)", (d) => { exprA(d, 'label_replace(vector(1), "query", "x", "", "") and on () sum by (service_name) (http_server_request_duration_seconds_count)'); rule0(d).annotations.summary = "{{ $labels.query }}"; }, ["sent"]],
  ["a group_left adding a tool's name (review pass 1)", (d) => exprA(d, "group by (service_name) (http_server_request_duration_seconds_count) * on (service_name) group_left (ob1_tool) group by (service_name, ob1_tool) (http_server_request_duration_seconds_count)"), ["sent"]],
  ["a statement's text put in an allowed label by label_replace (review pass 1)", (d) => exprA(d, 'group by (service_name) (label_replace(pg_stat_statements_query_id_total, "service_name", "$1", "query", "(.*)"))'), ["sent"]],
  ["a comment hiding an `or` that keeps a tool's name (review pass 1)", (d) => exprA(d, "group by (service_name) ( # (\nhttp_server_request_duration_seconds_count) or group by (ob1_tool) (http_server_request_duration_seconds_count) # )"), ["sent"]],
  ["a backtick string's parenthesis hiding an `or` (review pass 2)", (d) => exprA(d, "sum by (service_name) (http_server_request_duration_seconds_count{ob1_outcome=`(`}) or sum by (ob1_tool) (http_server_request_duration_seconds_count{ob1_outcome=`)`})"), ["sent"]],
  ["an aggregation `by` written after it", (d) => { exprA(d, "sum(http_server_request_duration_seconds_count) by (service_name)"); }, []],
  ["…keeping a tool's name", (d) => { exprA(d, "sum(http_server_request_duration_seconds_count) by (ob1_tool)"); rule0(d).annotations.summary = "{{ $labels.ob1_tool }}"; }, ["sent"]],
  ["a `by` on both sides, which Prometheus refuses (review pass 3)", (d) => exprA(d, "sum by (service_name) (http_server_request_duration_seconds_count) by (ob1_tool)"), ["sent"]],
  ["a quantile by allowed labels", (d) => exprA(d, "quantile by (service_name) (0.9, http_server_request_duration_seconds_count)"), []],
  ["a statement's text put in an allowed label by label_join", (d) => exprA(d, 'group by (service_name) (label_join(pg_stat_statements_query_id_total, "service_name", "", "query"))'), ["sent"]],
  ["count_values with a grouping before its parenthesis (review pass 2)", (d) => exprA(d, 'group by (service_name) (count_values by (service_name) ("service_name", pg_stat_statements_query_id_total))'), ["sent"]],
  ["a `#` inside a matcher's string, no comment", (d) => exprA(d, 'max by (service_name) (http_server_request_duration_seconds_count{ob1_tool!="#"})'), []],
  ["…after an escaped quote", (d) => exprA(d, 'max by (service_name) (http_server_request_duration_seconds_count{ob1_tool!="\\"#"})'), []],
  ["a `$` in a query's string, which Grafana reads raw", (d) => exprA(d, 'max by (service_name) (http_server_request_duration_seconds_count{ob1_tool!="$x"})'), []],
  ["a backtick string's quote pairing past an `or` (review pass 2)", (d) => exprA(d, "group by (service_name) (http_server_request_duration_seconds_count{ob1_outcome!=`\"`}) or group by (ob1_tool) (http_server_request_duration_seconds_count{ob1_outcome!=`\"`})"), ["sent"]],
  ["…hiding a label_replace (review pass 2)", (d) => exprA(d, 'group by (service_name) (pg_stat_statements_query_id_total{queryid!=`"`} or label_replace(pg_stat_statements_query_id_total{queryid!=`"(`}, "service_name", "$1", "query", "(.*)"))'), ["sent"]],
  ["a comment inside the query, its words no name", (d) => exprA(d, "max by (service_name) ( # the share the server failed\nsum by (service_name) (rate(http_server_request_duration_seconds_count[10m])))"), []],
  ["an aggregation `without` a list", (d) => exprA(d, "sum without (ob1_tool) (http_server_request_duration_seconds_count)"), ["sent"]],
  ["a file that is not YAML", () => {}, ["yaml"]],
  ["a rule's own label, a plain word", (d) => { rule0(d).labels = { severity: "critical" }; }, []],
  ["a rule's own label, templated", (d) => { rule0(d).labels = { tool: "{{ .Labels.ob1_tool }}" }; }, ["sent"]],
  ["a rule's own label reading lgtm's environment (review pass 2)", (d) => { rule0(d).labels = { severity: "$GF_SECURITY_ADMIN_PASSWORD" }; }, ["sent"]],
  ["…or a file", (d) => { rule0(d).labels = { host: "$__file{/etc/hostname}" }; }, ["sent"]],
  ["…in a label's key", (d) => { rule0(d).labels = { $GF_SECURITY_ADMIN_PASSWORD: "x" }; }, ["sent"]],
  ["a title reading lgtm's environment", (d) => { rule0(d).title = "Probe $GF_SECURITY_ADMIN_PASSWORD"; }, ["sent"]],
  ["a dashboard uid reading lgtm's environment, which every notification's links carry (review pass 3)", (d) => { rule0(d).dashboardUid = "$GF_SECURITY_ADMIN_PASSWORD"; rule0(d).panelId = 1; }, ["sent"]],
  ["an annotation's `$` outside a template, which Grafana reads raw", (d) => { rule0(d).annotations.description = "costs $5"; }, []],
  ["an annotation's template with trim markers", (d) => { rule0(d).annotations.summary = "{{- $labels.service_name -}}"; }, []],
  ["an annotation's template holding a lone `}` (review pass 1)", (d) => { rule0(d).annotations.summary = '{{ printf "%s}" $labels.instance }}'; }, ["template"]],
  ["an annotation templating a label its result does not keep", (d) => { rule0(d).annotations.summary = "{{ $labels.ob1_tool }}"; }, ["template"]],
  ["an annotation templating anything else", (d) => { rule0(d).annotations.summary = "{{ .Value }}"; }, ["template"]],
  ["an annotation templating a value no query has", (d) => { rule0(d).annotations.summary = "{{ $values.Z.Value }}"; }, ["template"]],
];
function checkAlertRules() {
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    fail(SELF, `check 38 parses the alert rules with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-3050)`);
    return;
  }
  const uids = ["probe"];
  for (const [what, mutate, expected] of ALERT_PROBES) {
    const text = what === "a file that is not YAML" ? "groups: [unclosed\n" : alertProbe(mutate);
    // Each probe's own rules are its held list: the list's rule has a probe of its own, below.
    const own = (() => { const d = structuredClone(ALERT_PROBE); mutate(d); return d.groups.flatMap((g) => g.rules.map((r) => String(r.uid))); })();
    const got = alertRulesProblems(text, { content: text.replace(/\$/g, "$$$$") }, DASHBOARD_PROBE_WRITTEN, own).map(([rule]) => rule);
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(SELF, `check 38 no longer reports exactly ${JSON.stringify(expected)} for its probe "${what}" (reported ${JSON.stringify(got)})`);
  }
  const held = alertProbe();
  const stale = alertRulesProblems(held, { content: alertProbe((d) => { rule0(d).title = "Older"; }).replace(/\$/g, "$$$$") }, DASHBOARD_PROBE_WRITTEN, uids).map(([rule]) => rule);
  if (JSON.stringify(stale) !== JSON.stringify(["copy"])) fail(SELF, `check 38 no longer reports exactly ["copy"] for its probe "an inline copy from an older file" (reported ${JSON.stringify(stale)})`);
  const undoubled = alertRulesProblems(held, { content: held }, DASHBOARD_PROBE_WRITTEN, uids).map(([rule]) => rule);
  if (JSON.stringify(undoubled) !== JSON.stringify(["copy"])) fail(SELF, `check 38 no longer reports exactly ["copy"] for its probe "an inline copy with each \`$\` single" (reported ${JSON.stringify(undoubled)})`);
  const extra = alertRulesProblems(held, { content: held.replace(/\$/g, "$$$$") }, DASHBOARD_PROBE_WRITTEN, ["probe", "ob1-other"]).map(([rule]) => rule);
  if (JSON.stringify(extra) !== JSON.stringify(["identity"])) fail(SELF, `check 38 no longer reports exactly ["identity"] for its probe "a rule dropped from the held list" (reported ${JSON.stringify(extra)})`);
  let fileText: string;
  try { fileText = readFileSync(join(ROOT, ALERT_FILE), "utf8"); } catch { return; } // check 37 said it is missing
  const doc = Bun.YAML.parse(readFileSync(join(ROOT, "deploy/compose.yaml"), "utf8"));
  const configs = isMapping(doc) && isMapping(doc.configs) ? doc.configs : {};
  const code = readdirSync(join(ROOT, "server-portable")).filter((f) => f.endsWith(".ts") && !f.startsWith("test-")).map((f) => readFileSync(join(ROOT, "server-portable", f), "utf8"));
  const written = new Map([...instrumentNamesIn(code), ...Object.entries(DASHBOARD_IMAGE_SERIES)]);
  for (const [rule, detail] of alertRulesProblems(fileText, configs["grafana-alert-rules"], written)) {
    fail(rule === "copy" ? "deploy/compose.yaml" : ALERT_FILE, `${detail} (check 38, SMD-3050)`);
  }
}
checkAlertRules();

// ── Check 39: a status-set change runs the refresh and rebuilds the gate it moves (SMD-3160) ──
// 071's ob1_source_gate stores, per source row, whether its thought's
// status_type is in node_lifecycle_types(). A migration that changes the set
// leaves those rows wrong until a rebuild after it — the full one, or 108's
// keyed one, which reconciles only the types it is given (a type left out
// stays wrong on every brain, and only drift() would say so) — and a change to
// either set leaves every pooled session on the old set until
// ob1_refresh_set_readers() (108) drops their plans. The rule reads canonical
// forms only and refuses any other: two passes of a statement parser found a
// seam each, and a loud refusal costs an author a rewrite where a quiet miss
// costs every brain (review pass 3).
//   * The text read is comment-stripped, and its literals — '…', E'…', "…"
//     and $tag$…$tag$ — are blanked for every search below but the set's own
//     literal and a keyed call's list, read back from the same place.
//   * Every CREATE [OR REPLACE] FUNCTION [schema.]node_lifecycle_types (or
//     node_settled_types), and every RENAME TO one, anywhere — in a string, a
//     body or an EXECUTE included — is a definition. Each must be a line
//     starting `CREATE OR REPLACE FUNCTION node_lifecycle_types()` outside
//     any literal, else the file is "unreadable", with the form to write.
//   * A definition's body — inside its first dollar quote, or to its first
//     `;` if it has none — must be exactly `SELECT '{a,b}'::text[]`, a plpgsql
//     `[DECLARE …] BEGIN RETURN '{a,b}'::text[]; END`, or (with no dollar
//     quote) BEGIN ATOMIC SELECT / RETURN of it: a set built from the literal
//     (`|| ARRAY['c']`) is not read as the literal. The file's last
//     definition is the set it leaves, compared to the last earlier file that
//     defined that set.
//   * After that definition, the calls are lines outside any literal:
//     `SELECT * FROM ob1_rebuild_source_gate();` or
//     `SELECT * FROM ob1_rebuild_source_gate_for_types('{…}');` lines naming
//     together exactly the types added and dropped (a lifecycle change only),
//     and, for either set in any file from the one that defines it on,
//     `SELECT ob1_refresh_set_readers();`.
type SetChangeRule = "rebuild" | "types" | "refresh" | "unreadable";
const SET_FUNCTIONS = ["node_lifecycle_types", "node_settled_types"] as const;
const SET_FORM = (fn: string) => `every definition a line starting CREATE OR REPLACE FUNCTION ${fn}() outside any string or body, whose body is SELECT '{a,b}'::text[] (or a plpgsql BEGIN RETURN '{a,b}'::text[]; END) — e.g. AS $$ SELECT '{a,b}'::text[] $$;`;
const FULL_LINE = /^SELECT \* FROM ob1_rebuild_source_gate\(\);/m;
const KEYED_LINE = /^SELECT \* FROM ob1_rebuild_source_gate_for_types\('[^'\n]*'\);/gm;
const KEYED_LIST = /^SELECT \* FROM ob1_rebuild_source_gate_for_types\('\{([^}']*)\}'\);$/;
const REFRESH_LINE = /^SELECT ob1_refresh_set_readers\(\);/m;
const REFRESH_DEF = /^CREATE OR REPLACE FUNCTION ob1_refresh_set_readers\(\)/m;
const SET_LITERAL = /'\{([^}']*)\}'\s*::\s*text\s*\[\s*\]/g;
const DOLLAR_AT = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/;
const BODY_SHAPES = [/^\s*SELECT\s+SET\s*;?\s*$/i, /^\s*(?:DECLARE\s+(?:[^;]*;\s*)*)?BEGIN\s+RETURN\s+SET\s*;\s*END\s*;?\s*$/i];
const BARE_SHAPE = /\b(?:BEGIN\s+ATOMIC\s+SELECT|RETURN)\s+SET\s*;$/i;
const setOf = (literal: string) => new Set(literal.split(",").map((t) => t.trim().replace(/^"(.*)"$/, "$1")).filter((t) => t !== ""));
/** Where the dollar quote starting at `i` opens (its delimiter), or null: a `$` glued to an identifier (`a$b`) or a `$1` is no quote. */
function dollarAt(text: string, i: number): string | null {
  if (text[i] !== "$" || /[A-Za-z0-9_$]/.test(text[i - 1] ?? "")) return null;
  return DOLLAR_AT.exec(text.slice(i, i + 64))?.[0] ?? null;
}
/** The text with the inside of every literal blanked, its length and line breaks kept; an unterminated one runs to the end. */
function blankLiterals(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const escapes = c === "'" && /[eE]/.test(text[i - 1] ?? "") && !/[A-Za-z0-9_$]/.test(text[i - 2] ?? "");
      let j = i + 1;
      while (j < text.length) {
        if (escapes && text[j] === "\\") j += 2;
        else if (text[j] === c) break;  // a doubled quote ends one string and opens the next: blanked alike
        else j++;
      }
      blank(i + 1, Math.min(j, text.length));
      i = j + 1;
      continue;
    }
    const tag = dollarAt(text, i);
    if (tag) {
      const close = text.indexOf(tag, i + tag.length);
      blank(i + tag.length, close < 0 ? text.length : close);
      i = close < 0 ? text.length : close + tag.length;
      continue;
    }
    i++;
  }
  return out.join("");
}
/**
 * A set's state after a file: null when the file does not define it; else
 * the set its last definition leaves (null when check 39 cannot read every
 * definition, or that one's body) and the text after that definition, raw
 * and blanked alike.
 */
function lastSetIn(code: string, blanked: string, fn: string): { set: Set<string> | null; after: string; afterBlanked: string } | null {
  const anyDef = new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:"?\\w+"?\\s*\\.\\s*)?"?${fn}\\b|\\bRENAME\\s+TO\\s+"?${fn}\\b`, "gi");
  const defs = [...code.matchAll(anyDef)].length;
  if (defs === 0) return null;
  const lines = [...blanked.matchAll(new RegExp(`^CREATE OR REPLACE FUNCTION ${fn}\\(\\)`, "gm"))];
  const unread = { set: null, after: "", afterBlanked: "" };
  if (lines.length !== defs) return unread;
  const last = lines.at(-1)!, at = last.index! + last[0].length;
  const restB = blanked.slice(at);
  let open = -1, tag: string | null = null;
  for (let k = 0; k < restB.length && restB[k] !== ";"; k++) if ((tag = dollarAt(restB, k))) { open = k; break; }
  let body: string, shapes: RegExp[], endAt: number;
  if (tag) {
    const close = restB.indexOf(tag, open + tag.length);
    if (close < 0) return unread;
    body = code.slice(at + open + tag.length, at + close);
    shapes = BODY_SHAPES;
    endAt = close + tag.length;
  } else {
    const semi = restB.indexOf(";");
    if (semi < 0) return unread;
    body = code.slice(at, at + semi + 1);
    shapes = [BARE_SHAPE];
    endAt = semi + 1;
  }
  const literals = [...body.matchAll(SET_LITERAL)];
  if (literals.length !== 1 || !shapes.some((s) => s.test(body.replace(SET_LITERAL, "SET")))) return unread;
  return { set: setOf(literals[0][1]), after: code.slice(at + endAt), afterBlanked: restB.slice(endAt) };
}
const symmetric = (a: Set<string>, b: Set<string>) => [...[...b].filter((t) => !a.has(t)), ...[...a].filter((t) => !b.has(t))].sort();
/** Each migration (in order) that changes a set without its follow-up lines after the definition: the refresh (from the file that defines it on), and for node_lifecycle_types() a rebuild of exactly what it moves. */
function setChangeProblems(files: readonly { name: string; text: string }[]): [SetChangeRule, string, string][] {
  const out: [SetChangeRule, string, string][] = [];
  const prev: Record<string, Set<string> | null> = { node_lifecycle_types: null, node_settled_types: null };
  let refreshKnown = false;
  for (const { name, text } of files) {
    const code = stripSqlComments(text) as string;
    const blanked = blankLiterals(code);
    if (REFRESH_DEF.test(blanked)) refreshKnown = true;
    for (const fn of SET_FUNCTIONS) {
      const found = lastSetIn(code, blanked, fn);
      if (found === null) continue;
      if (found.set === null) {
        out.push(["unreadable", name, `it defines ${fn}() in a place or form check 39 does not read — write ${SET_FORM(fn)} — so the types a change moves are known`]);
        prev[fn] = null;
        continue;
      }
      const was = prev[fn];
      prev[fn] = found.set;
      if (was === null) continue;
      const moved = symmetric(was, found.set);
      if (moved.length === 0) continue;
      const after = found.afterBlanked;
      if (fn === "node_lifecycle_types") {
        const keyed = [...after.matchAll(KEYED_LINE)].map((m) => [...setOf(KEYED_LIST.exec(found.after.slice(m.index!, m.index! + m[0].length))?.[1] ?? "")]);
        const full = FULL_LINE.test(after);
        const call = `SELECT * FROM ob1_rebuild_source_gate_for_types('{${moved.join(",")}}');`;
        if (!full && keyed.length === 0) {
          out.push(["rebuild", name, `it changes node_lifecycle_types() (moving ${moved.join(", ")}) and has no rebuild of 071's gate mirror as a line after it — add the line ${call}`]);
        } else if (!full) {
          const named = [...new Set(keyed.flat())].sort();
          if (named.join() !== moved.join()) out.push(["types", name, `its keyed rebuild lines name {${named.join(",")}}, but the change moves {${moved.join(",")}} — every type it adds and drops: ${call}`]);
        }
      }
      if (refreshKnown && !REFRESH_LINE.test(after)) {
        out.push(["refresh", name, `it changes ${fn}() and has no SELECT ob1_refresh_set_readers(); line after it — without it pooled sessions, 071's gate triggers among them, keep the old set`]);
      }
    }
  }
  return out;
}
const SET_BASE = { name: "001_base.sql", text: "CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{a,b}'::text[] $$;\nCREATE OR REPLACE FUNCTION node_settled_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{b}'::text[] $$;\nCREATE OR REPLACE FUNCTION ob1_refresh_set_readers() RETURNS int LANGUAGE sql AS $$ SELECT 0 $$;\n" };
const setChange = (body: string) => ({ name: "002_change.sql", text: body });
const ABC = "CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{a,b,c}'::text[] $$;\n";
const RF = "SELECT ob1_refresh_set_readers();\n";
const SET_PROBES: [string, string, SetChangeRule[]][] = [
  ["a change with the refresh and the full rebuild", `${ABC}${RF}SELECT * FROM ob1_rebuild_source_gate();\n`, []],
  ["a change with the refresh and the keyed form", `${ABC}${RF}SELECT * FROM ob1_rebuild_source_gate_for_types('{c}');\n`, []],
  ["a change that adds and drops, keyed in two lines", `CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{a,c}'::text[] $$;\n${RF}SELECT * FROM ob1_rebuild_source_gate_for_types('{c}');\nSELECT * FROM ob1_rebuild_source_gate_for_types('{b}');\n`, []],
  ["the set over two lines, a settled set as a literal after it", `CREATE OR REPLACE FUNCTION node_lifecycle_types()\nRETURNS text[] LANGUAGE sql IMMUTABLE\nAS $$ SELECT '{a,b,c}'::text[] $$;\nCREATE OR REPLACE FUNCTION node_settled_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{b}'::text[] $$;\n${RF}SELECT * FROM ob1_rebuild_source_gate_for_types('{c}');\n`, []],
  ["the set's body over lines, its dollar quote alone on the last", `CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$\nSELECT '{a,b,c}'::text[]\n$$;\n${RF}SELECT * FROM ob1_rebuild_source_gate_for_types('{c}');\n`, []],
  ["the set in a BEGIN ATOMIC body", `CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE\nBEGIN ATOMIC\nSELECT '{a,b,c}'::text[];\nEND;\n${RF}SELECT * FROM ob1_rebuild_source_gate_for_types('{c}');\n`, []],
  ["the set in a plpgsql body, a declaration and BEGIN at the start of lines", `CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $f$\nDECLARE\n  v int;\nBEGIN\nRETURN '{a,b,c}'::text[];\nEND $f$;\n${RF}SELECT * FROM ob1_rebuild_source_gate_for_types('{c}');\n`, []],
  ["a change to the settled set alone, with the refresh", `CREATE OR REPLACE FUNCTION node_settled_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{a,b}'::text[] $$;\n${RF}`, []],
  ["the same set again", "CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{b,a}'::text[] $$;\n", []],
  ["$$ in strings around the real calls, and a $-glued identifier", `${ABC}SELECT 'cost: $$';\nSELECT 1 AS a$b$c;\n${RF}SELECT * FROM ob1_rebuild_source_gate_for_types('{c}');\nSELECT 'x$$';\n`, []],
  ["an E-string with an escaped quote and $$ before the calls", `${ABC}SELECT E'it\\'s $$';\n${RF}SELECT * FROM ob1_rebuild_source_gate_for_types('{c}');\n`, []],
  ["a change with the refresh and no rebuild", `${ABC}${RF}`, ["rebuild"]],
  ["two definitions, the second a change, a refresh and no rebuild", `CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{a,b}'::text[] $$;\nSELECT * FROM ob1_rebuild_source_gate();\n${ABC}${RF}`, ["rebuild"]],
  ["a change whose rebuild is only in a comment or a DO block", `${ABC}${RF}-- SELECT * FROM ob1_rebuild_source_gate();\nDO $d$\nBEGIN\nSELECT * FROM ob1_rebuild_source_gate();\nEND $d$;\n`, ["rebuild"]],
  ["a change whose rebuild comes before the set", `SELECT * FROM ob1_rebuild_source_gate_for_types('{c}');\n${ABC}${RF}`, ["rebuild"]],
  ["a change whose rebuild is in a wrapper's body", `${ABC}${RF}CREATE OR REPLACE FUNCTION wrap() RETURNS void LANGUAGE plpgsql AS $b$\nBEGIN\n  PERFORM ob1_rebuild_source_gate();\nEND $b$;\n`, ["rebuild"]],
  ["a change whose rebuild is a line in a wrapper's sql body", `${ABC}${RF}CREATE OR REPLACE FUNCTION wrap() RETURNS SETOF record LANGUAGE sql AS $b$\nSELECT * FROM ob1_rebuild_source_gate();\n$b$;\n`, ["rebuild"]],
  ["$$ in a string, then the calls in a wrapper's body", `${ABC}SELECT '$$';\nCREATE OR REPLACE FUNCTION wrap() RETURNS SETOF record LANGUAGE sql AS $$\nSELECT ob1_refresh_set_readers();\nSELECT * FROM ob1_rebuild_source_gate();\n$$;\n`, ["rebuild", "refresh"]],
  ["the calls only inside a comment's string", `${ABC}COMMENT ON FUNCTION node_lifecycle_types() IS 'run after it:\nSELECT ob1_refresh_set_readers();\nSELECT * FROM ob1_rebuild_source_gate();\n';\n`, ["rebuild", "refresh"]],
  ["a change that adds and drops, keyed with what it adds alone", `CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{a,c}'::text[] $$;\n${RF}SELECT * FROM ob1_rebuild_source_gate_for_types('{c}');\n`, ["types"]],
  ["a change keyed with more than it moves", `${ABC}${RF}SELECT * FROM ob1_rebuild_source_gate_for_types('{c,x}');\n`, ["types"]],
  ["a change with the rebuild and no refresh", `${ABC}SELECT * FROM ob1_rebuild_source_gate_for_types('{c}');\n`, ["refresh"]],
  ["a change whose refresh is a line in a wrapper's sql body", `${ABC}CREATE OR REPLACE FUNCTION wrap() RETURNS int LANGUAGE sql AS $b$\nSELECT ob1_refresh_set_readers();\n$b$;\nSELECT * FROM ob1_rebuild_source_gate_for_types('{c}');\n`, ["refresh"]],
  ["a change to the settled set alone, with no refresh", "CREATE OR REPLACE FUNCTION node_settled_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{a,b}'::text[] $$;\n", ["refresh"]],
  ["a settled set in a form the check does not read", `CREATE OR REPLACE FUNCTION node_settled_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['a'] $$;\n${RF}`, ["unreadable"]],
  ["a set in a form the check does not read", "CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['a','b','c'] $$;\n" + RF + "SELECT * FROM ob1_rebuild_source_gate();\n", ["unreadable"]],
  ["a set defined in an EXECUTE string", `DO $d$ BEGIN EXECUTE 'CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $f$ SELECT 1 $f$'; END $d$;\n${RF}SELECT * FROM ob1_rebuild_source_gate();\n`, ["unreadable"]],
  ["a body holding two different sets", `CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN random() < 2 THEN '{a,b,c}'::text[] ELSE '{a}'::text[] END $$;\n${RF}SELECT * FROM ob1_rebuild_source_gate();\n`, ["unreadable"]],
  ["a canonical definition, then a qualified one adding a type", `CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{a,b}'::text[] $$;\nCREATE OR REPLACE FUNCTION public.node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{a,b,d}'::text[] $$;\n`, ["unreadable"]],
  ["a canonical definition, then a lowercase one", `${ABC}${RF}SELECT * FROM ob1_rebuild_source_gate();\ncreate or replace function node_lifecycle_types() returns text[] language sql immutable as $$ select '{a,b,c,d}'::text[] $$;\n`, ["unreadable"]],
  ["a function renamed to the set", `CREATE OR REPLACE FUNCTION new_set() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{a,b,c}'::text[] $$;\nALTER FUNCTION new_set() RENAME TO node_lifecycle_types;\n`, ["unreadable"]],
  ["a canonical definition inside a helper's body, after the change", `${ABC}${RF}SELECT * FROM ob1_rebuild_source_gate_for_types('{c}');\nCREATE OR REPLACE FUNCTION restore_sets() RETURNS void LANGUAGE plpgsql AS $b$\nBEGIN\nEXECUTE $q$\nCREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $f$ SELECT '{a,b}'::text[] $f$\n$q$;\nEND $b$;\n`, ["unreadable"]],
  ["a set built from the literal", `CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{a,b}'::text[] || ARRAY['c'] $$;\n${RF}SELECT * FROM ob1_rebuild_source_gate();\n`, ["unreadable"]],
  ["a BEGIN ATOMIC body built from the literal", `CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE\nBEGIN ATOMIC\nSELECT '{a,b}'::text[] || ARRAY['c'];\nEND;\n${RF}SELECT * FROM ob1_rebuild_source_gate();\n`, ["unreadable"]],
  ["a settled set built from the literal", `CREATE OR REPLACE FUNCTION node_settled_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT array_append('{b}'::text[], 'a') $$;\n${RF}`, ["unreadable"]],
  ["a set under a quoted, qualified name", `CREATE OR REPLACE FUNCTION "public"."node_lifecycle_types"() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{a,b,c}'::text[] $$;\n${RF}SELECT * FROM ob1_rebuild_source_gate();\n`, ["unreadable"]],
];
function checkSetChanges() {
  for (const [what, body, expected] of SET_PROBES) {
    const got = setChangeProblems([SET_BASE, setChange(body)]).map(([rule]) => rule);
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(SELF, `check 39 no longer reports exactly ${JSON.stringify(expected)} for its probe "${what}" (reported ${JSON.stringify(got)})`);
  }
  // The file that defines the refresh is held to it; one before it is not (105's own block).
  const definer = setChangeProblems([{ name: "001_base.sql", text: SET_BASE.text.split("\n").slice(0, 2).join("\n") }, setChange(`${SET_BASE.text.split("\n")[2]}\nCREATE OR REPLACE FUNCTION node_settled_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{a,b}'::text[] $$;\n`)]).map(([rule]) => rule);
  if (JSON.stringify(definer) !== JSON.stringify(["refresh"])) fail(SELF, `check 39 no longer reports exactly ["refresh"] for its probe "the file that defines the refresh changes a set without calling it" (reported ${JSON.stringify(definer)})`);
  const early = setChangeProblems([{ name: "001_base.sql", text: SET_BASE.text.split("\n")[0] }, setChange(`${ABC}SELECT * FROM ob1_rebuild_source_gate();\n`)]).map(([rule]) => rule);
  if (JSON.stringify(early) !== JSON.stringify([])) fail(SELF, `check 39 no longer reports exactly [] for its probe "a change before the refresh exists, with the full rebuild" (reported ${JSON.stringify(early)})`);
  const dir = join(ROOT, "db/migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => ({ name: f, text: readFileSync(join(dir, f), "utf8") }));
  for (const [, name, detail] of setChangeProblems(files)) fail(`db/migrations/${name}`, `${detail} (check 39, SMD-3160)`);
}
checkSetChanges();

// No display-time filter. One excused `_template` violations, for a placeholder
// link that contributionDirs() has skipped since the filter was written — so
// its only live effect was to hide a check-5 hit in a _template SQL file that
// every contributor copies.
console.log(`Checked ${dirs.length} contributions across ${CATEGORIES.length} categories.`);

if (violations.length === 0) {
  console.log("PASS — no consistency violations.\n");
  process.exit(0);
}

console.error(`\nFAIL — ${violations.length} violation(s):\n`);
for (const v of violations) console.error(`  ${v.where}\n    ${v.msg}`);
console.error("");
process.exit(1);
