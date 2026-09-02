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
# The embedding contract, imported by preflight.ts. Kept at ../db/ inside the
# image so the import path is identical in the container and in a checkout.
COPY db/config.mjs db/config.d.mts /db/

# Secrets are injected at runtime, never baked in:
#   MCP_ACCESS_KEY, OPENROUTER_API_KEY
#   OB1_STORE=postgrest  → SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
#   OB1_STORE=sql        → DATABASE_URL
# Optional: OPEN_BRAIN_CITATION_BASE_URL, PORT (default 8000), OB1_PG_POOL
EXPOSE 8000
USER bun

# Refuse to serve when misconfigured.
#
# The data layer is built lazily on first use, so without this the container
# starts, answers `initialize` and `tools/list`, passes any HTTP liveness probe,
# and only fails when a user captures their first thought. A crashloop is visible;
# a server that looks healthy and is not, is not. preflight exits non-zero on a
# bad configuration, unreachable database, or missing schema.
ENTRYPOINT ["/bin/sh", "-c", "bun preflight.ts && exec bun index.ts"]

# Liveness only. The MCP endpoint requires auth, so a probe cannot exercise a real
# tool; an unauthenticated POST returns HTTP 200 with a JSON-RPC -32001 envelope,
# which proves the process is serving and leaks nothing. Readiness — is the
# database actually reachable — is the entrypoint's job, above.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- --post-data='{}' --header='Content-Type: application/json' \
      http://127.0.0.1:${PORT:-8000}/ >/dev/null || exit 1
