# 250. One origin for the stack — a reverse proxy is the only published port, and the server is a path on it (SMD-1846)

**What changed.** `deploy/compose.yaml` gains `proxy`: Traefik v3.7.13, pinned to its multi-arch index digest, run as `nobody` with every capability dropped. It publishes `${SERVER_BIND:-127.0.0.1}:${SERVER_PORT:-8000}`, the mapping the server had, so a `deploy/.env` written before it publishes the same address and port. The server loses `ports:` and is reached as `server:8000` on the compose network, by the proxy and by n8n as before. The route table is `x-proxy-routes`, a YAML block at the top of the file that compose hands Traefik's file provider as an inline `configs:` entry; three routers (a fourth, `auth`, comes with PR 2 below), each on the `web` entrypoint alone, path kept as it came (the server answers POST at every path and `/health` under any prefix, so it needs no base-path setting):

- `mcp` (priority 30): `/mcp` and everything under it — the endpoint clients are now given;
- `health` (20): `GET`/`HEAD /health` at the origin root, for a GET-only probe;
- `legacy` (1): everything but `/.well-known` — what clients reach at the root today: `POST /?key=`, `GET /` (the server's 405, which an MCP SDK client reads as "no stream here"), `/worker-status`, `/jobs/<id>` (whose poll links `scan_thoughts` returns root-relative).

No router matches `/.well-known` or anything under it (until PR 2's `auth` router, below, for the authorization server's three), so Traefik answers those 404 itself and the server never sees them. That puts the claude.ai discovery 404 (SMD-1246, change 42) in whatever owns the origin root, which a connector at `https://host/mcp` asks: `/.well-known/oauth-protected-resource/mcp`. Traefik matches the cleaned, decoded path, so `//.well-known/`, `/%2ewell-known/` and `/mcp/../.well-known/` are refused too (measured) — all but an encoded slash, which it leaves encoded: `/.well-known%2Fx` reaches the server's 405, as before the proxy. The access log is JSON with query parameters, headers and `ClientUsername` dropped: a connector's `?key=`, an OAuth redirect's `code` and `state` (SMD-2285's, routed since PR 2) and an absolute-form target's userinfo never reach disk. Header aliases (`X_Brain_Key`) are deleted; `Host` passes as the client sent it.

`deploy/smoke.sh` defaults to `http://127.0.0.1:<SERVER_PORT>/mcp`. `deploy/canary.sh` reads the canary's port from its proxy container (a pre-proxy canary's: its server's), starts the proxy beside the recreated server, and registers the connector at `http://127.0.0.1:<port>/mcp`. Check 13's inventory names `proxy` where it named `server`. The release rehearsal pulls the proxy's image before its `up --pull never`.

**Why.** Every service the fork is adding — the GUI, the authorization server, the REST core's opt-in `/api`, the canary — would have been a host port an operator picks, opens and hands a client separately (the dogfood stack already moved to 8010 when 8000 was taken). The ADR (`docs/operator-surface-tiers.md`, decision 4) put one proxy in front.

**Routes by file, not by label.** The ticket proposed Traefik's docker provider reading container labels. That provider reads the engine's socket, which is root on the host, from inside the one process a network client reaches; `docs/orchestration-tool.md` declined the same socket for n8n. It works on podman (measured, with `security_opt: label=disable`), and was declined on that ground. Adding a service is the service plus a router in `x-proxy-routes`. The inline config keeps the table inside `compose.yaml`, the file a release ships, so a pinned stack fetches nothing more.

**A changed route recreates the proxy.** Compose copies an inline config into the container at creation and does not recreate it when the config alone changes (measured on Compose 5.5: the old container kept the old table across two `up`s; docker/compose issue 11900). So the same text is a label on the proxy, `ob1.proxy-routes`; a changed label does recreate it (measured). CI holds the label equal to the config.

**The port's handover.** The proxy depends on the server, so the first `up` after this change recreates the old server (freeing the port) before it creates the proxy; the reverse order would bind while the old server held it. The cost: `up server` alone never starts the proxy, so the README's rebuild line, the FAQ's key-rotation line and `evals/eval-orchestration.ts --up` name both. A rollback to an older `compose.yaml` leaves the proxy an orphan on the port, so it takes `--remove-orphans`.

**Held.** "Full stack, no Supabase":
- the published-ports step renders one port (the proxy's, 8010, on loopback), no `ports:` on the server, the proxy image by digest, the label equal to the config, and the services `migrate postgres proxy server`;
- the smoke runs through the proxy at `/mcp`, and again at the origin root (the legacy route, `GET /`'s 405 included);
- a new step, "The proxy answers discovery itself, logs no key and streams unbuffered":
  - `/.well-known` and both discovery paths get Traefik's own 404 body (the server's would be `Not Found`);
  - `POST /?key=` still reaches the brain;
  - no proxy log line carries the smoke key after calls with it in `?key=`, `code=`, `state=` and an absolute-form target's userinfo (which must get the server's 200, so it was taken and logged), and the callback's line is present with its bare path;
  - with the CI provider stub holding an embedding 6 s (`/tmp/provider-stub-slow-embed`), a `search_thoughts` stream's 5 s keepalive frame arrives at least 0.5 s before the result.
- The tier, canary, dashboard and SIGTERM steps dial `/mcp`. The canary step reads `compose port proxy 8000`.
- `release.yml`'s rehearsal holds the proxy's image to a digest under the overlay.

Six drop-the-mechanism mutants, each a compose override on a running stack, each killed by its own assertion and nothing else: the query kept in the log; `ClientUsername` kept; a Traefik `buffering` middleware on `/mcp`; `/.well-known/` routed to the server; no legacy route (the proxy step); `GET /` excluded from the legacy route (the root smoke).

**Measured after** (podman machine, macOS; scratch projects):
- `smoke.sh` passes 11/11 at `http://127.0.0.1:<port>/mcp`, and against `http://server:8000` from a container on the network, unproxied, so nothing in the server changed.
- Stream: the keepalive frame at 5.02 s, the result at 6.03 s; a 90 s call streamed 24 keepalives and its result at 90.07 s, as unproxied.
- `compose stop server` after a proxied call: 338 ms, exit 0, with the proxy holding an idle connection.
- An `up -d --build` from the old `compose.yaml` to this one: about 1.5 s with nothing on the port, then `POST /?key=` as before.

**Review passes.**

| Pass | Finding | Caught by | Fix |
|---|---|---|---|
| 1 | The release rehearsal's `up --pull never` met a proxy image it never pulled | cold read | pass 1 |
| 1 | `up server` alone (README rebuild, FAQ, eval-orchestration) left nothing on the port | cold read | pass 1 |
| 1 | `GET /` as the proxy's 404 made SDK clients at the root report an error on every connect | run-it | pass 1 |
| 1 | A rollback left the orphan proxy on the port and the stack down | run-it | pass 1 |
| 1 | Every router was also on the ping entrypoint; `/health` took every method; a bare `/.well-known` reached the server | cold read | pass 1 |
| 1 | An absolute-form target's userinfo reached the log as `ClientUsername` | run-it | pass 1 |
| 2 | The leak check never confirmed the absolute-form probe was taken and logged | run-it | pass 2 |
| 2 | One recipe's rebuild line still named the server alone; the README's rule read wider than the first `up` | cold read | pass 2 |
| CI | The proxy step's streaming search reached the query log ahead of the tier step, whose `--replay` re-embeds it from a container with no route to the stub | CI | the step moved after the canary steps |

**Not taken.**
- nginx: it buffers a response unless told not to, and the tool calls answer as SSE.
- Caddy would also do, and wins on TLS. With no socket the label registry was no longer the deciding feature, and the query-string rule here is one setting.
- `read_only` on the proxy: compose writes an inline config into the container's filesystem and refuses to for a read-only one.
- CORS headers on the proxy's own 404s: the MCP SDK's discovery reads a CORS failure as a 404 and goes on.
- Moving the whole stack onto the mesh and egress networks: it buys isolation only once the MCP server can be mesh-only, so it goes with the REST core (SMD-2284). The loopback break-glass entrypoint goes with the GUI's key sign-in, its only reader (SMD-2286 step 3).
- Gating the authorization server's routes on `COMPOSE_PROFILES` in the proxy: compose cannot add a route by profile. They answer while the server does, and *configured* is the server's to enforce at its start (SMD-2382).
- TLS at the proxy waits for a public origin (SMD-2382).

**Follow-ups.**
- SMD-2306: the legacy route's deprecation header, the upgrade guide and its removal (then `/` is the proxy's 404). When it goes: the root-relative `/jobs/<id>` links `scan_thoughts` returns need the mount; `OPTIONS /health` (a browser's preflight) needs a route of its own, since the health router takes GET and HEAD; and the docs still giving new clients the root URL (SETUP.md, `docs/01-getting-started.md`, `docs/03-faq.md`, `primitives/remote-mcp`, the recipe READMEs) move to `/mcp`.
- SMD-1849: the proxy's access log, one JSON line per request, is not rotated.
- SMD-2474: `canary.sh` reports a stop that failed as done (met in review pass 2, not introduced here).
- SMD-2294: the tier stack onto proxy paths.
- SMD-2307: one body cap and timeout chain, the proxy included.

**The authorization server's routes (PR 2).**
- The proxy joins `mesh` beside the default network, and gains an `auth` router (priority 40, entrypoint `web`). It sends these to `http://auth.ob1.internal.:3000`, which serves them all itself (SMD-2285):
  - `/auth` and everything under it;
  - `/.well-known/oauth-authorization-server/auth` (RFC 8414);
  - `/.well-known/openid-configuration/auth` (OIDC);
  - the bare `/.well-known/oauth-authorization-server`, the one Claude Code reads.
- It answers only while the server does. With the profile off, or the server stopped or still starting, Traefik's 502 for a name that does not resolve would be the answer. The `auth-absent` middleware (`errors`, status `502`, `noop@internal`, `statusRewrites: 502 → 404`) turns it into a bodiless 404, so the origin says "no OAuth here" as before (decision 16).
- Its other answers pass untouched: 201 on a registration, and the cap's 503 with `Retry-After: 3600` (measured). The middleware takes any 502, but the server sends none itself; one it drops mid-flight is a 404 too.
- `/.well-known/oauth-protected-resource/mcp` stays the proxy's 404 until the MCP server serves that document (SMD-2382, SMD-2286).
- **Configured is enforced at the server's start.** `deploy/auth/config.ts` refuses to start (exit 2, beside the other problems) unless `COMPOSE_PROFILES`, which compose now passes in from `deploy/.env`, names `auth` (ADR decision 16). So `--profile auth` given only on the command line never answers, and "answers" means configured and reachable. `provision.ts`'s check of the file reports the same, and `--init` names it among what is still to set. A refused start says why and exits after 30 s, the import runner's pattern. Exiting at once restarted it about three times a second, and the loop went on after `up --wait` had failed (review pass 2, measured).
- **No search domains in the proxy** (`dns_search: ["."]`), with the route's name written rooted. With the server absent, the name was otherwise tried again under each of the host's search domains (a tailnet's, an ISP's). In review, a decoy aliased `auth.ob1.internal.<search domain>` on the default network received a sign-in POST, password and all. With both, the one lookup is the stack's own name under the reserved `.internal`, and `server` still resolves. That one lookup still reaches the host's resolver while the server is absent, so one that answers every name (a `*.internal` wildcard, an ISP rewriting NXDOMAIN) would still be sent `/auth` traffic. A black-hole resolver for the proxy would close it; it is left as the remaining risk until the mesh holds every service (SMD-2284).
- **The session cookie is `Path=/auth`** (`deploy/auth/server.ts`, `cookies.long`). The library's default `/`, on a shared origin, would ride every `/mcp` and root request (and later `/dashboard` and `/api`), and it alone completes a grant. The interaction cookies were already on their own paths.
- **Upgrading.** An operator who runs `--profile auth` must have `COMPOSE_PROFILES=auth` in `deploy/.env` before the next `up`, or the server refuses to start. With it, that `up` publishes `/auth` through whatever tunnel fronts the origin. A stack whose proxy predates this change needs `proxy` named beside `auth` (`up -d --wait auth proxy`): `up auth` alone leaves the old proxy without the router and off the mesh. A shell `COMPOSE_PROFILES` beats the file's, and a command-line `--profile` replaces it. A deploy from the release's files alone cannot start the server at all, since no auth image is pinned yet and the profile builds from a checkout (as before).
- **Held by** CI's authorization-server step, through the proxy:
  - the bare discovery path is an empty 404 before the server starts and after it stops;
  - while it runs, the bare and RFC 8414 paths return its document with issuer `https://brain.example.test/auth`;
  - past the cap, a registration gets the 503 with its `Retry-After`;
  - the proxy's `resolv.conf` has no search domain;
  - a start whose `COMPOSE_PROFILES` lacks `auth` is refused, by name, beside the other refusals;
  - a real sign-in (`restart-check.ts --session-cookie`) gets a session cookie with `Path=/auth`.

  `provision.ts --self-check` holds the rule's cases: unset, other profiles, a profile containing the word, and four accepted spellings.
- **Mutants:** four, each killed by its own check:
  - no `auth-absent` (a 502 before start);
  - a rewrite of every 5xx (the cap's 503 became a 404);
  - the proxy off `mesh` (a 404 with the server running);
  - no `auth` router (the proxy's "404 page not found").
- **Measured** on podman against the real server:
  - the four paths answer 404, 200 and 404 across off, running and stopped;
  - both smokes pass 11/11 beside them;
  - with a spoofed `Host`, `X-Forwarded-Host` or `Forwarded`, every URL in the documents stays under the configured issuer;
  - a full sign-in, consent and token exchange completes through the proxy, and the access log holds no code, state, token or key.
- **Review pass 1** (cold read and run-it):
  - DNS search domains (run-it, cold read);
  - the session cookie's path (cold read);
  - configured not enforced (flagged by the build, chosen by the maintainer);
  - stale text and upgrade notes (cold read).
  - Left with their tickets: a hung server hangs its client, since Traefik sets no response timeout (SMD-2307, as the server route); and whether a key-configured connector starts OAuth once the bare document answers 200, a live check before enabling `auth` on stable (SMD-2382).
- **Review pass 2** (cold read and run-it), nothing above one MEDIUM, the stop signal:
  - the configured refusal's hot restart loop, now 30 s apart (run-it);
  - the shell's and the command line's precedence over the file, said in the README, `.env.example` and the refusal (run-it, cold read);
  - `--init`'s hint (cold read);
  - the resolv.conf check now needs a resolver line, so an empty read fails (cold read);
  - the remaining DNS lookup and the release-files gap, recorded above (cold read).
  - Re-checked by both, all held: the decoy got nothing; each DNS fix alone protects; a second authorization reuses the `/auth` session; the cookie mutants print `/`; a wrong password never prints `/auth`.

**Upstream status.** Fork-only: upstream deploys to Supabase Edge Functions, whose gateway owns the origin.
