# Container target (EKS, ECS, Fly.io, Railway, Render).
# Cloudflare Workers uses wrangler.toml instead; Deno Deploy needs neither.
FROM oven/bun:1.4.0-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json index.ts ./

# Secrets are injected at runtime, never baked in:
#   MCP_ACCESS_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY
# Optional: OPEN_BRAIN_CITATION_BASE_URL, PORT (default 8000)
EXPOSE 8000
USER bun

# Liveness only — the MCP endpoint requires auth, so a health probe cannot use it.
# An unauthenticated POST returns HTTP 200 with a JSON-RPC -32001 envelope, which
# is a valid "process is serving" signal and leaks nothing.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- --post-data='{}' --header='Content-Type: application/json' \
      http://127.0.0.1:${PORT:-8000}/ >/dev/null || exit 1

CMD ["bun", "index.ts"]
