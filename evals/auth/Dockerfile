# The authorization-server POC's one image (SMD-2285): every service in
# compose.yaml and the candidate overlays runs `bun <file>` from it. Built from
# evals/auth/, the same Bun as server-portable/Dockerfile.
FROM oven/bun:1.4.0-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY *.ts package.json ./
USER bun
