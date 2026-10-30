# Container target (EKS, ECS, Fly.io, Railway, Render).
# Built from the REPO ROOT, not server-portable/ — see deploy/compose.yaml. The
# server needs db/config.mjs, which a narrower context cannot reach.
FROM oven/bun:1.4.3-alpine AS deps
WORKDIR /app/server-portable
COPY server-portable/package.json server-portable/bun.lock ./
RUN bun install --frozen-lockfile --production

# The MCP server as a REST client and its REST client (SMD-2287), each from its
# own lockfile, as in a checkout: mcp-server/ pins the MCP SDK v2 packages,
# rest-client/ openapi-fetch. A stage each, so a change to one lockfile
# installs that one alone, and BuildKit runs the three at once.
FROM oven/bun:1.4.3-alpine AS mcp-deps
WORKDIR /app/mcp-server
COPY mcp-server/package.json mcp-server/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.3-alpine AS rest-client-deps
WORKDIR /app/rest-client
COPY rest-client/package.json rest-client/bun.lock ./
RUN bun install --frozen-lockfile --production

# The operator GUI (SMD-2280), built here: SvelteKit's adapter-node writes a
# server with every package bundled into dashboard/build/, so this stage's
# install (all build tools) stays behind and the image carries the build
# alone. It imports the REST client, the auth switch's rule and the moved-ticket
# words (stated-status.ts, the search page) from beside it, as in a checkout, so
# they are copied in first; its type-only imports of
# server-portable/ are erased by the build. On the builder's own platform: the
# stage runs JavaScript (svelte-kit sync, vite build), which crashed Bun under
# QEMU when the release cross-builds the other architecture, and then hung
# (review pass 2, an amd64 build on arm64: cancelled at 843 s); its output is
# plain JS and CSS, the same on either, which the final stage copies in, and
# one build serves both, so a release's two images carry the same GUI. It needs
# a builder that defines BUILDPLATFORM — BuildKit, which compose v2 and buildx
# use, or buildah (podman); the classic builder (DOCKER_BUILDKIT=0) does not.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.3-alpine AS dashboard-build
WORKDIR /app/rest-client
COPY rest-client/package.json rest-client/bun.lock ./
RUN bun install --frozen-lockfile --production
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/bun.lock ./
# No lifecycle scripts: `prepare` (svelte-kit sync) would run before the config
# is copied, and swallow its own failure; `bun run build` syncs.
RUN bun install --frozen-lockfile --ignore-scripts
COPY rest-client/*.ts /app/rest-client/
COPY server-portable/oauth-edge.ts server-portable/auth.ts server-portable/brain-info.ts /app/server-portable/
COPY server-portable/stated-status.ts /app/server-portable/
COPY server-portable/core/filter.ts /app/server-portable/core/
COPY dashboard/svelte.config.js dashboard/vite.config.ts ./
COPY dashboard/src ./src
COPY dashboard/static ./static
RUN bun run build

# The image keeps the checkout's layout under /app — server-portable/, db/,
# plugins/, mcp-server/, rest-client/, dashboard/ and releases.json side by side — so every
# relative import resolves as it does in a checkout: the server's
# ../db/config.mjs, the MCP server's ../server-portable/ modules, and a plugin's
# ../../server-portable/plugin-sdk.ts, through which it reaches zod in
# server-portable's node_modules (SMD-2310; before, the server sat at /app and
# db/ at /db, which a plugin's import could not mirror).
FROM oven/bun:1.4.3-alpine
WORKDIR /app/server-portable
ENV NODE_ENV=production
COPY --from=deps /app/server-portable/node_modules ./node_modules
COPY --from=mcp-deps /app/mcp-server/node_modules /app/mcp-server/node_modules
COPY --from=rest-client-deps /app/rest-client/node_modules /app/rest-client/node_modules
# Copy every source file rather than naming them. An explicit list silently broke
# the image when auth.ts was added — the container crashlooped on a missing module.
# .dockerignore keeps tests and tooling out.
COPY server-portable/*.ts server-portable/package.json ./
COPY server-portable/core ./core
COPY server-portable/rest ./rest
# The MCP server as a REST client (SMD-2287) and the client it calls the REST
# core through, beside server-portable/, whose modules the MCP server imports
# as ../server-portable/ (.dockerignore keeps the client's generator and the
# suites' in-process stack out).
COPY mcp-server/*.ts mcp-server/package.json /app/mcp-server/
COPY rest-client/*.ts rest-client/package.json /app/rest-client/
# The operator GUI (SMD-2280): its built server and the entry that starts it,
# `bun ../dashboard/serve.ts`, which imports the REST client above and
# server-portable's oauth-edge.ts, as in a checkout.
COPY --from=dashboard-build /app/dashboard/build /app/dashboard/build
COPY dashboard/serve.ts dashboard/package.json /app/dashboard/
# Every plugin in the tree (SMD-2310): the registry imports each by name, and
# OB1_PLUGINS picks which run. Tests stay out (.dockerignore).
COPY plugins /app/plugins
# The embedding contract and the version helpers, both imported by preflight.ts,
# at ../db/ as in a checkout; releases.json at their parent's parent, where
# version.mjs resolves it, so preflight's "migrations applied beyond the
# version the brain names" warning reads the release ranges as they stood at
# this build's commit (SMD-1860 — before, the image carried none, and in a
# container that warning could never fire).
# db/: the embedding contract the server reads, and since SMD-3476 the
# coordinator and the core passes it runs, from this image as root
# (deploy/compose.yaml) — by name, the passes' import graph alone, which
# db/test-coordinator.ts holds this list to (and .dockerignore's allow-list).
COPY db/config.mjs db/config.d.mts db/version.mjs db/version.d.mts /app/db/
COPY db/coordinator.ts db/supervise.ts db/sleep.ts db/extract-entities.ts db/consolidate.ts db/sync-linear.ts \
     db/board-findings.ts db/linear-api.ts db/subject-sweep.ts db/rebuild.ts db/reembed.ts db/env.ts \
     db/cli.ts db/connect.ts db/lease.ts db/pass-stamp.ts db/worker-bootstrap.ts \
     db/ingest-contract.ts db/ingest-linear.ts db/ingest-structure.ts /app/db/
COPY releases.json /app/releases.json

# The commit this image was built from, reported by brain_info and the keyed
# /health body (SMD-2041). A build arg baked into the environment: compose
# passes it from OB1_GIT_SHA, the release job the tag's commit, and neither
# forwards one at runtime. It is an ENV, so a runtime variable of the same name
# (a service's `environment:` entry) does override it — set none.
# After every COPY, so a new commit rebuilds no earlier layer. Unset reads as
# `unknown`.
ARG OB1_GIT_SHA=unknown
# A RUN that reads the arg, before the ENV: podman's builder keys an ENV
# layer's cache without the arg's value, so a rebuild whose only change was
# the commit kept the previous build's (measured, podman 6.0.2); a RUN's key
# includes it, and every layer after a rebuilt one rebuilds. BuildKit keys
# both by it.
RUN printf 'server image built from commit %s\n' "$OB1_GIT_SHA"
ENV OB1_GIT_SHA=$OB1_GIT_SHA

# Secrets are injected at runtime, never baked in:
#   MCP_ACCESS_KEYS (or the legacy MCP_ACCESS_KEY), OPENROUTER_API_KEY or
#                  OB1_LLM_API_KEY (and OB1_CHAT_API_KEY when OB1_CHAT_BASE_URL
#                  names a hosted chat endpoint of its own)
#   DATABASE_URL — the SQL store, the only one (SUPABASE_URL holding a
#                  postgres:// URL is read as the same thing)
# Optional: OPEN_BRAIN_CITATION_BASE_URL, PORT (default 8000), OB1_PG_POOL,
# OB1_STOP_GRACE (the platform's grace period for a stop, whole seconds 1–3600;
# default 10)
# ../mcp-server/index.ts reads none of the above but PORT and OB1_STOP_GRACE:
#   OB1_FORWARDER_KEY — its forward-scope key, its hash in the REST core's
#                  MCP_ACCESS_KEYS; and OB1_AUTH_SECRET_MCP on a stack that
#                  trades OAuth tokens. Its other settings (the REST core's
#                  address, the plugins, the origin): mcp-server/README.md
# ../dashboard/serve.ts, the operator GUI (SMD-2280), reads no secret: each
#                  visitor's key is the call's. Its settings: dashboard/README.md
EXPOSE 8000
USER bun

# Refuse to serve when misconfigured.
#
# The data layer is built lazily on first use, so without this the container
# starts, answers `initialize` and `tools/list`, passes any HTTP liveness probe,
# and only fails when a user captures their first thought. A crashloop is visible;
# a server that looks healthy and is not, is not. preflight exits non-zero on a
# bad configuration, unreachable database, or missing schema.
#
# A stop during preflight ends the container (SMD-2250). The shell is PID 1
# until the `exec`, and PID 1 ignores a signal it has no handler for, so
# without the traps a stop sent then was lost: preflight finished, the server
# started, and the stop waited out the grace period and was killed (10.1 s,
# exit 137, measured). A trap runs only once the foreground command returns,
# hence preflight in the background and `wait`, which a trapped signal
# interrupts. From the `exec` on, the entry's own handlers answer (shutdown.ts),
# once its imports have loaded: a stop in that fraction of a second is still
# the grace period's kill.
#
# The entry is the command: api.ts, the REST core (SMD-2284), the one server
# that reads the store; until SMD-2287 PR 6b it was index.ts, the MCP server
# that read it itself. Two more run from this image without the preflight,
# with `bun` as the entrypoint: ../mcp-server/index.ts (SMD-2287) and the
# operator GUI's ../dashboard/serve.ts (SMD-2280), which read no store and
# hold no key list — the REST core does both.
ENTRYPOINT ["/bin/sh", "-c", "trap 'exit 143' TERM; trap 'exit 130' INT; bun preflight.ts & wait $! || exit $?; exec bun \"$@\"", "entry"]
CMD ["api.ts"]

# Liveness only: a keyless GET of /health, which all three servers answer 200 with
# no key, no store and nothing about the brain. Not a POST to the MCP
# endpoint, as before: that was an unauthenticated request every 30 s, which
# the server's request log (SMD-1849, telemetry.ts) would write as a refusal —
# half the log, as the REST core's liveness was before it was left out there;
# the REST core answered it 404 besides. Readiness — is the database actually
# reachable — is the entrypoint's job, above. Probed every second until it
# first passes (SMD-3194): Docker's default, 5 s, held every `up --wait`.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --start-interval=1s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-8000}/health >/dev/null || exit 1
