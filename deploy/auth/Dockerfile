# The authorization server's image (SMD-2285): `bun server.ts`, built from
# deploy/auth/ alone, the same Bun as server-portable/Dockerfile. deploy/compose.yaml's
# `auth` profile runs it, and the proof of concept builds it for its winner
# (evals/auth/compose.oidc-provider.yaml).
FROM oven/bun:1.4.0-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY *.ts package.json ./
# The store's directory (config.ts DEFAULT_DB), the server's user's alone: a
# named volume mounted here starts as a copy of it, owner and mode included.
RUN mkdir -m 700 /data && chown bun:bun /data
USER bun
CMD ["bun", "server.ts"]
