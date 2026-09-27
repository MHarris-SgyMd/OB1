# Exports for the import runner

The `orchestration` profile's import runner (`deploy/orchestration/runner.ts`)
mounts this directory read-only at `/imports`. Each pipeline in
`deploy/orchestration/pipelines.json` reads its own subdirectory:
`imports/<pipeline>/`. Put an export there, such as a ChatGPT `.zip` or a
Perplexity `.xlsx`, and the pipeline's next run, scheduled or on demand,
ingests it. A rerun writes nothing new.

Each pipeline's emitter runs as a uid of its own, which the runner logs at
start (`compose logs orchestration-runner`). It can read an export that is
world-readable, and so can every other pipeline's emitter. To keep one
pipeline's exports to its own emitter, give its directory to that uid:
`chown -R <uid>:<uid> imports/<pipeline> && chmod 700 imports/<pipeline>`.
That holds on a Linux host, where the mount keeps owners; a podman or Docker
Desktop VM maps them its own way, so check with `compose exec
orchestration-runner ls -ln /imports` after.

Everything here except this file and `.gitignore` is ignored by git. It is
also kept out of every image's build context (the root `.dockerignore`),
since an export is private data. `IMPORTS_DIR` in `deploy/.env` points
the runner at another directory. `deploy/README.md` ("Orchestration") has
the whole flow.
