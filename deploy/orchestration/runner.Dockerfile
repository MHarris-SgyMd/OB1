# The orchestration profile's import runner (SMD-2212): deploy/orchestration/runner.ts,
# with Bun for the pipeline and python3 for the emitters that are Python.
# Built from the repo root (compose: orchestration-runner), like the server and
# the migrator; the root .dockerignore lets in only what is copied here.
FROM oven/bun:1.4.0-alpine
# su-exec runs each step as its own user. A pipeline's emitter runs as a uid of
# its own (runner.ts emitterUid, no passwd entry needed), which owns nothing and
# cannot read the runner's or the ingester's environment (a process's
# /proc/<pid>/environ is its owner's), or reach another pipeline's emitter; the
# ingester and reembed run as the image's bun. An emitter's own packages (a
# recipe's requirements.txt) are added here when its recipe is converted
# (SMD-2147–2150, SMD-2021), each pinned, with the recipe's emitter copied below
# and its line in pipelines.json.
RUN apk add --no-cache python3 su-exec \
 && python3 --version
WORKDIR /app
# The pipeline's import graph, as the checkout has it, so `bun db/ingest-records.ts`
# and `bun db/reembed.ts` run here exactly as from a checkout. Not bundled: a
# bundle runs scripts/fork-index.ts's main block, which rewrites FORK.md.
COPY db/config.mjs db/config.d.mts db/version.mjs db/version.d.mts db/ingest-*.ts db/reembed.ts db/lease.ts /app/db/
COPY server-portable/*.ts /app/server-portable/
COPY scripts/fragments.ts scripts/fork-index.ts /app/scripts/
COPY evals/linear-corpus.ts /app/evals/
# pipelines.json is copied for the build-time self-check below; compose mounts
# the checkout's copy over it, the one provisioning reads.
COPY deploy/orchestration/runner.ts deploy/orchestration/pipelines.json /app/deploy/orchestration/
# A module the graph gained and this file does not copy, or an npm package (the
# image installs none), fails the build here, not the first run: every import
# resolved, then the runner's own rules. The one package named external is
# server-portable/store-postgrest.ts's, a store the pipeline never loads (it is
# imported lazily, for Workers); the bundler follows it anyway.
RUN bun build db/ingest-records.ts db/reembed.ts deploy/orchestration/runner.ts --target=bun --external @supabase/supabase-js --outdir=/tmp/resolve \
 && rm -rf /tmp/resolve \
 && bun deploy/orchestration/runner.ts --self-check
# Root, so that it can hand each step to its own user; compose drops every
# capability but those two and the one that signals a step's process. The
# runner refuses to start as root without su-exec.
EXPOSE 8090
CMD ["bun", "deploy/orchestration/runner.ts"]
