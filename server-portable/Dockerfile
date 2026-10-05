# Container target (EKS, ECS, Fly.io, Railway, Render).
# Cloudflare Workers uses wrangler.toml instead; Deno Deploy needs neither.
# Built from the REPO ROOT, not server-portable/ — see deploy/compose.yaml. The
# server needs db/config.mjs, which a narrower context cannot reach.
FROM oven/bun:1.4.0-alpine AS deps
WORKDIR /app
COPY server-portable/package.json server-portable/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
# Copy every source file rather than naming them. An explicit list silently broke
# the image when auth.ts was added — the container crashlooped on a missing module.
# .dockerignore keeps tests and tooling out.
COPY server-portable/*.ts server-portable/package.json ./
COPY server-portable/shims ./shims
COPY server-portable/core ./core
COPY server-portable/rest ./rest
# The embedding contract and the version helpers, both imported by preflight.ts.
# Kept at ../db/ inside the image so the import path is identical in the container
# and in a checkout; releases.json at their parent's parent, where version.mjs
# resolves it, so preflight's "migrations applied beyond the version the brain
# names" warning reads the release ranges as they stood at this build's commit
# (SMD-1860 — before, the image carried none, and in a container that warning
# could never fire).
COPY db/config.mjs db/config.d.mts db/version.mjs db/version.d.mts /db/
COPY releases.json /releases.json

# The commit this image was built from, reported by brain_info and the keyed
# /health body (SMD-2041). A build arg baked into the environment: compose
# passes it from OB1_GIT_SHA, the release job the tag's commit, and neither
# forwards one at runtime. It is an ENV, so a runtime variable of the same name
# (`docker run -e`, a Kubernetes `env:` entry) does override it — set none.
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
#   DATABASE_URL — the SQL store, which is the default (OB1_STORE unset or sql;
#                  SUPABASE_URL holding a postgres:// URL is read as the same thing)
#   OB1_STORE=postgrest → SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (kept for
#                  Cloudflare Workers; preflight reports it as retired on Bun)
# Optional: OPEN_BRAIN_CITATION_BASE_URL, PORT (default 8000), OB1_PG_POOL,
# OB1_STOP_GRACE (the platform's grace period for a stop, whole seconds 1–3600;
# default 10)
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
# The entry is the command: index.ts, the MCP server, unless a service names
# another — the REST core's `command: ["api.ts"]` in deploy/compose.yaml
# (SMD-2284). One image, one preflight, two servers.
ENTRYPOINT ["/bin/sh", "-c", "trap 'exit 143' TERM; trap 'exit 130' INT; bun preflight.ts & wait $! || exit $?; exec bun \"$@\"", "entry"]
CMD ["index.ts"]

# Liveness only — the MCP server's. The MCP endpoint requires auth, so a probe
# cannot exercise a real tool; an unauthenticated POST returns HTTP 200 with a
# JSON-RPC -32001 envelope, which proves the process is serving and leaks
# nothing. The REST core answers that POST 405; its service names its own
# check, a GET of its /health (deploy/compose.yaml). Readiness — is the
# database actually reachable — is the entrypoint's job, above.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- --post-data='{}' --header='Content-Type: application/json' \
      http://127.0.0.1:${PORT:-8000}/ >/dev/null || exit 1
