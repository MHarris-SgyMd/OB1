# The environment db/tier.ts runs in: open-brain-tier (SMD-2036).
#
# tier.ts --refresh runs under Bun and shells to pg_dump / pg_restore, and no
# image the stack runs carries both: oven/bun has no Postgres client, the
# pgvector image has no Bun, and a host need not have either at the right major.
# This is the pair, and nothing else — no code is copied in. deploy/tier.sh
# mounts the checkout read-only and runs the tree's own tier.ts and migrate.ts,
# because a refresh migrates the copy forward WITH THAT TREE; an image of the
# code would migrate with whatever tree it was built from.
#
# deploy/tier.sh builds it from stdin with no context (`build - < this file`), so
# there is no .dockerignore to keep in step, and runs it with the command; the
# CMD here is only what a bare `run` does (tier.ts prints its usage). Not
# published by release.yml — it is an operator's tool that runs a checkout, not
# a release artifact.
FROM oven/bun:1.4.0-alpine
# The client major matches the stack's server, pgvector/pgvector:0.8.6-pg16.
# refreshToolsReady refuses a pg_dump older than the source server, and a newer
# one is no better: pg_dump 17 writes `SET transaction_timeout`, a setting a
# pg16 server does not have, so its restore errors. The package name pins the major; Alpine moves the
# minor within it. The check makes a repository that ever resolves the name to
# another major a failed build, not a refused refresh. Bump it with the server.
RUN apk add --no-cache postgresql16-client \
 && pg_dump --version | grep -Eq '\) 16\.' \
 && pg_restore --version | grep -Eq '\) 16\.'
USER bun
WORKDIR /repo/db
CMD ["bun", "tier.ts"]
