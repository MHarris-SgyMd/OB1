# The authorization server's image (SMD-2285): `bun server.ts`, built from
# deploy/auth/ alone, the same Bun as server-portable/Dockerfile. The proof of
# concept builds this image for its winner (evals/auth/compose.oidc-provider.yaml).
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
CMD ["bun", "server.ts"]
