# The migrator as an image: ob1-migrate (SMD-1860).
#
# deploy/compose.yaml used to run migrate.ts off a read-only mount of a checkout's
# db/ on a stock oven/bun image, so nothing published could apply a release's
# schema on a machine with no checkout. This image is that service, built from
# the REPO ROOT like server-portable/Dockerfile — the root .dockerignore keeps
# the context to what the two images need — and published per tag by
# .github/workflows/release.yml beside ob1-server, so the two move together: the
# server's preflight compares the brain's schema_version with its own
# FORK_VERSION, and this is what wrote it.
#
# No `bun install`: migrate.ts imports only Bun built-ins, node: modules and
# db/config.mjs + db/version.mjs (db/package.json's one dependency, PGlite, is the
# tests'). The benches, tests and workers beside it in db/ stay out.
FROM oven/bun:1.4.0-alpine
WORKDIR /app
# The runner, the two contracts it shares with the server, and the migrations —
# at the paths migrate.ts reads them (./config.mjs, ./version.mjs, ./migrations).
COPY db/migrate.ts db/config.mjs db/version.mjs ./
COPY db/migrations ./migrations
# version.mjs resolves releases.json at its parent's parent — / here, as in the
# server image — so `bun migrate.ts --dry-run` names the release each pending
# migration belongs to, from the manifest as it stood at this build's commit.
COPY releases.json /releases.json
# DATABASE_URL and the OB1_* knobs are injected at runtime (deploy/compose.yaml
# forwards them); nothing is baked in.
USER bun
CMD ["bun", "migrate.ts"]
