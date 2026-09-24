# Bun, like server-portable/Dockerfile (SMD-1800; `denoland/deno` until then).
FROM oven/bun:1.4.0-alpine

# Built with integrations/ as the context — `docker build -f Dockerfile ..` from
# this directory — because index.ts imports the shared auth module from
# ../_shared/auth.ts (ob1-fork, SMD-1455) and Docker cannot COPY from outside
# the context. The image mirrors the repository layout so the import resolves.
WORKDIR /app/kubernetes-deployment
ENV NODE_ENV=production

# The pinned install: package.json names the MCP stack at the versions the rest
# of the tree runs, bun.lock the whole transitive tree.
COPY kubernetes-deployment/package.json kubernetes-deployment/bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy the shared auth module and the server source
COPY _shared/auth.ts /app/_shared/auth.ts
COPY kubernetes-deployment/index.ts ./

# Run as non-root
USER bun

EXPOSE 8000

# `bun index.ts` serves the module's default export — `{ port, fetch }`, the
# core server's shape (SMD-1799) — on PORT, default 8000. The Postgres client
# is Bun's own, so the image installs no driver.
CMD ["bun", "index.ts"]
