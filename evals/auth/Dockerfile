# The authorization-server POC's image (SMD-2285): the stand-ins, the CIMD
# host, the bait and the runner-up run `bun <file>` from it. The winner is the
# deploy's own image (deploy/auth/Dockerfile). Built from the REPO ROOT, the
# same Bun as server-portable/Dockerfile, because the runner-up renders the
# deploy's pages and fetches through its guard, and every piece reads the
# deploy's layout: deploy/auth/'s three dependency-free modules sit at the path
# the imports name. The root .dockerignore lets these files in.
FROM oven/bun:1.4.0-alpine AS deps
WORKDIR /app/evals/auth
COPY evals/auth/package.json evals/auth/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.0-alpine
WORKDIR /app/evals/auth
ENV NODE_ENV=production
COPY --from=deps /app/evals/auth/node_modules ./node_modules
COPY evals/auth/*.ts evals/auth/package.json ./
COPY deploy/auth/layout.ts deploy/auth/pages.ts deploy/auth/fetch-guard.ts /app/deploy/auth/
USER bun
