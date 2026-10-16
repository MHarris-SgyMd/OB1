# The environment db/tier.ts runs in: <project>-tier (SMD-2036, SMD-2875).
#
# tier.ts --refresh runs under Bun and shells to pg_dump / pg_restore, and no
# image the stack runs carries both: oven/bun has no Postgres client, the
# pgvector image has no Bun, and a host need not have either at the right major.
# This is the pair, and nothing else — no code is built in. deploy/tier.sh
# copies the tree's own code into each container it makes from this image
# (the files git lists, never the checkout: SMD-2875) and runs its tier.ts and
# migrate.ts, because a refresh migrates the copy forward WITH THAT TREE; an
# image of the code would migrate with whatever tree it was built from.
#
# deploy/tier.sh builds it from stdin with no context (`build - < this file`), so
# there is no .dockerignore to keep in step, and runs it with the command; the
# CMD here is only what a bare `run` does (tier.ts prints its usage). Not
# published by release.yml — it is an operator's tool that runs a checkout, not
# a release artifact.
FROM oven/bun:1.4.3-alpine
# The client major matches the stack's server, pgvector/pgvector:0.8.6-pg16.
# refreshToolsReady refuses a pg_dump older than either server (the source for
# the dump, --to for the probe that reads it before the reset). A newer one
# works, with noise: pg_dump 17 writes `SET transaction_timeout`, a setting a
# pg16 server does not have, and the restore reports it as an error (measured in
# review: exit 0 overall, rows intact). The package name pins the major and
# Alpine moves the minor within it. The check makes a repository that ever
# resolves the name to another major a failed build rather than a surprise.
# Bump it with the server.
RUN apk add --no-cache postgresql16-client \
 && pg_dump --version | grep -Eq '\) 16\.' \
 && pg_restore --version | grep -Eq '\) 16\.'
USER bun
WORKDIR /repo/db
CMD ["bun", "tier.ts"]
