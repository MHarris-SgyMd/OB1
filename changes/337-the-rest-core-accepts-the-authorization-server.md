# 337. The REST core accepts the authorization server's tokens — a sign-in's or a service's token acts as the access key scope it names, and refresh tokens rotate within a 10 s reuse grace (SMD-2286)

**What changed.**
- **`server-portable/oauth-token.ts`** (new; `auth.ts`, byte-synced into the vendored servers, is untouched):
  - `tokenSettings(env)`: on a configured stack with a sound origin, the issuer `<origin>/auth` and the audience `<origin>/api`; else null, and no token is accepted.
  - `checkerOver(settings, keys)`:
    - First, on the claims read unverified (refusing only), it refuses another issuer, any audience but exactly `<origin>/api`, and an expired or exp-less token, so each is 401 even with no keys to be had.
    - Then jose checks the ES256 signature, `typ: at+jwt`, issuer, `sub` and `exp`.
    - A key reader's failure, other than a missing or doubled `kid`, is `unavailable`.
  - `keyScopeOf`: `brain:write` is write, `brain:read` alone read, `brain:capture` alone capture; anything else is the outcome `scope`.
  - The principal: `oauth:<sub>`, a `keyHash` of sha256 `oauth\n<issuer>\n<sub>` (the registry's key and job ownership's), and `act = oauth:<act.sub>` from an exchanged token. A `sub` or `act.sub` outside `[A-Za-z0-9._~-]{1,128}` is refused.
  - `cachedKeys(read, now)`, the key set kept on a monotonic clock:
    - A read is needed with no set, a stale one (600 s, the access tokens' lifetime) or one lacking the `kid`. A request that needs one joins any in flight, else reads unless one was tried within 30 s.
    - Once the set is stale and reads fail, the set serves 600 s from then, so every token issued before the outage lives to its end.
    - A missing `kid` after a successful read is `invalid`; with no read made it is `unavailable`.
  - `jwksOver(url)` (a 200 with a non-empty `keys` array, no redirect, 2 s) and `remoteChecker(settings)` over `http://auth.ob1.internal.:3000/auth/jwks`.
- **`server-portable/rest/app.ts` `caller()`**: when no key matched and the bearer has a JWT's shape (`oauth-edge.ts` `JWT_SHAPE`, exported), the token check runs; keys still come first.
  - Answers, each with `credential: "token"`: 401 `UNAUTHORIZED` `invalid_token`; 403 `FORBIDDEN` `insufficient_scope` (RFC 6750 §3.1, the POC's A8); 503 `BUSY` `Retry-After: 30`; a revoked subject's 401 `REVOKED`.
  - A token's own `act` stands beside the forwarder slot, whose key is still checked.
- **`server-portable/api.ts`**: `tokens()` builds one remote checker per issuer and audience, read per request from the environment as the keys are. `restApp()` takes an optional token check for a suite. `jose` 6.2.12 is pinned (deploy/auth's pin).
- **`server-portable/agents.ts`**: `recordedScope` sends an `oauth:` subject's scope as none, so tokens of two scopes from one subject never rewrite its row in turn.
- **`rest/openapi.ts`** describes the token answers (401, 403 at whoami and the plugins too, 503, the bearer scheme); `rest-client/` is regenerated.
- **`deploy/auth/layout.ts`**:
  - `keyScopeOf` and `noKeysScope` follow the REST core's rule; `test-rest.ts` holds the two equal over all 32 sets.
  - `OB1_AUTH_SERVICES` refuses read+capture without write, and the id `operator` (a client-credentials token's `sub` is its id).
  - `refreshTtl` is 14 days, cut to what is left of 30 since the chain's `iiat`.
  - `chainRotates` stops rotation at 30 days.
  - `REFRESH_REUSE_GRACE_S` is 10 (the maintainer's choice), with its price stated.
- **`deploy/auth/store.ts`**: a refresh token spent less than 10 s ago (never a negative age) reads as unspent, so the library rotates it again rather than revoking the grant; a later `consume` keeps the first spend's time. The library's revoke-on-replay branch is hard-coded, so the store is where the grace can live.
- **`deploy/auth/server.ts`**:
  - `ttl.RefreshToken = refreshTtl`, `rotateRefreshToken = chainRotates`.
  - The interaction sends read+capture back `invalid_scope` before a sign-in, and the exchange refuses that narrowing.
  - `target.ts` pins the `Provider` settings at 13.
  - The break-glass mentions name SMD-2280.
- **`deploy/auth/pages.ts`**: the consent page words each brain scope as its key. **`restart-check.ts --tokens <scope>`** signs in, consents, takes an `/mcp` token and exchanges it as `mcp`.
- **CI**, deploy-stack-auth, "The REST core accepts the authorization server's tokens, and only its own":
  - Two real sign-ins and exchanges, then whoami `oauth:operator`/write/act `oauth:mcp`.
  - The `/mcp` token is 401; a read token's capture is 403.
  - A write capture's audit row reads `oauth:operator oauth:mcp`.
  - With the authorization server stopped: 200 on the keys already read, and 503 `Retry-After: 30` with none read.
  - Secrets go by `-e NAME`.
- **`evals/eval-auth.ts`**, winner only:
  - **G5r:** rotation; two refreshes at once both answered; the chain goes on; the consent wording.
  - **P1:** a confidential client rotates too.
  - **P2:** read+capture is refused before any page.
  - **P3:** the exchange refuses read+capture.
  - Self-checks for the scope rule, `refreshTtl`, `chainRotates` and the service refusals.
- **Docs:**
  - `docs/operator-surface-tiers.md` (Identity as built, the lifetimes decided, the GUI's part SMD-2280's, stale step-4 attributions).
  - `deploy/README.md` "Tokens at the REST core" (the egress variable, classifying with the command and why `agent`, a registry ban and where a leaked token is answered, the keys in an outage, the reuse grace) and the services paragraph (the upgrade split, the client-credentials command).
  - `server-portable/README.md`, `evals/README.md`, `.env.example`, `compose.yaml`'s comment and `oauth-edge.ts`'s header.

**Why.** Before this, the REST core checked no token at all, refresh tokens ran on the library's defaults, and scopes like read+capture had no key meaning. Step 3 (the GUI's sign-in, break-glass, the revocation page) moved to SMD-2280, since nothing serves `/dashboard`; the MCP server's exchange is PR 2, live with SMD-2287 PR 5.

**Held.**
- **`test-rest.ts` 470/470**, section [5d]:
  - the scope table and its agreement with the authorization server's;
  - tokens at their operations, and two 403s;
  - 13 refusals, 401 `credential: "token"` with nothing run;
  - `act` beside the forwarder slot, revocation, keys first, unconfigured;
  - every `cachedKeys` cell, on a clock of its own: concurrency, outage windows, idle, recovery, boundaries, a throwing reader, a wall-clock jump via `setSystemTime`.
- **`test-rest-sql.ts` [6c] 210/210** on real Postgres: an exchanged token's capture, with its audit row `oauth:operator` and act `{name: "oauth:mcp"}`; the registry's row with no scope; a read token refused; a service's subject; a revoked subject refused.
- **`test-agents.ts` 108/108; the auth self-checks** (store's grace at 4 s, 9 s and 10 s, after a step back, and a code's none; provision, limits, target); **`eval-auth.ts --self-check` 137; rest-client 148/148.**
- **45 mutants in `/private/tmp/smd2286/mutants.py`; 42 killed.** The three survivors (jose's own issuer, audience and required-exp options) are equivalent to the claim check before the keys. `server.ts`'s rotation, refresh-TTL wiring and two read+capture refusals are killed by the live script below.
- **Live** (`/private/tmp/smd2286/live-as.sh`, the real authorization server under Bun, 18/18):
  - exchanged tokens accepted at `/auth/jwks`, `/mcp` tokens refused;
  - P1–P3 as eval-auth checks them;
  - refresh rows 1,209,600 s with one `iiat`;
  - a replay at once rotates, and at 11 s revokes the grant.

  Only that script holds the refresh-TTL wiring: a 30-day cut needs a chain over 16 days old.
- **Reviewers ran** the MCP SDK v2 client through sign-in and refreshes (0 sign-outs in 36 bursts of 2–10 parallel), an end-to-end run on real Postgres (`test-e2e-sql` 621/621 twice), and a load run: a token costs about ten times a key, at tens of µs.

**Review passes.** Each row changed the mechanism; record fixes are in the passes' commit bodies.

| Pass | Finding | Caught | Fix |
|---|---|---|---|
| 1 | Two refreshes at once revoked the grant (the SDK has no lock; 10/10 runs) | run-it | a reuse grace in the store (maintainer's choice) |
| 1 | jose's key set never served stale in an outage | run-it | `cachedKeys` |
| 1 | A failed key read was retried on every request | run-it | 30 s between reads |
| 1 | A new signing key was 401 within jose's cooldown | run-it | 503 until it can be read for |
| 1 | No-scope tokens were 401, the record says 403 | cold-read | 403 `insufficient_scope` |
| 1 | An `aud` list holding the audience passed | run-it | exactly `<origin>/api` |
| 1 | Secrets on `exec` command lines in CI | cold-read | `-e NAME` |
| 1 | A reader's plain error to the guard was untested | mutant | a throwing reader held to 503 |
| 2 | A request during a stale re-read got 503 | run-it | it joins the read in flight |
| 2 | A blip while fresh started the outage clock early | run-it | counted from stale and failing together |
| 2 | A wall-clock step froze the cache | run-it | monotonic clock |
| 2 | A reader throwing at once wedged the cache | run-it | the read goes through a resolved promise |
| 2 | Replays inside the grace fork the chain undetected | run-it | 10 s, not 60 (maintainer's choice) |
| 2 | `refreshTtl`'s 1 s floor could stretch a chain | cold-read | no rotation past 30 days |
| 3 | CI's `target.ts` pin failed | run-it | 13 |
| 3 | The deploy passed `Date.now` to the cache | cold-read | the cache's own clock |
| 3 | A revoked subject's 401 did not say token | run-it | `credential: "token"` |
| 3 | The registry's scope flipped per request | run-it | none recorded for `oauth:` |
| 3 | A foreign token was 503 with keys cold | run-it | refused on its claims first |
| 3 | A wall-clock step back reopened the grace | run-it | a negative age is no grace |
| 3 | An empty key set replaced a good one | run-it | a failed read |
| 4 | Forged expired tokens drew cheap 503s | run-it | refused on `exp` first |
| 5 | The audit row was proved only by an unrun CI step | walkthrough | `test-rest-sql.ts` [6c] |
| 5 | The server's rotation setting was held by nothing | walkthrough | eval P1 |
| 5 | The server's read+capture refusals were held by nothing | walkthrough | eval P2, P3 |

**Not taken.**
- The refusal reason in the request line: it holds no free text (SMD-3110).
- `insufficient_scope` headers on per-operation 403s: REST clients are not step-up MCP clients, and PR 2 words its own.
- An `agentId` on a token's `act`, and tokens on `/health`.
- Closing the library's narrowing paths to read+capture: they fail closed at the REST core.
- Refusing an exchange to an empty scope: harmless, and A8's expectations ride on it.

**Follow-ups.**
- SMD-3064: one principal for every operator client.
- SMD-3110: refusal detail in the request line.
- SMD-3111: an unthrottled token endpoint and an unindexed purge.
- PR 2: what `mcp-server/` must do with a token's 401, 403, 503 and REVOKED, and a rest-client bearer option.
