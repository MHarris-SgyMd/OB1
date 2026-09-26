# Exports for the import runner

The `orchestration` profile's import runner (`deploy/orchestration/runner.ts`)
mounts this directory read-only at `/imports`. Each pipeline in
`deploy/orchestration/pipelines.json` reads its own subdirectory:
`imports/<pipeline>/`. Put an export there, such as a ChatGPT `.zip` or a
Perplexity `.xlsx`, and the pipeline's next run, scheduled or on demand,
ingests it. A rerun writes nothing new.

Everything here except this file and `.gitignore` is ignored by git. It is
also kept out of every image's build context (the root `.dockerignore`),
since an export is private data. `IMPORTS_DIR` in `deploy/.env` points
the runner at another directory. `deploy/README.md` ("Orchestration") has
the whole flow.
