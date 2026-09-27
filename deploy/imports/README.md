# Exports for the import runner

The `orchestration` profile's import runner (`deploy/orchestration/runner.ts`)
mounts this directory read-only at `/imports`. Each pipeline in
`deploy/orchestration/pipelines.json` reads its own subdirectory:
`imports/<pipeline>/`. Put an export there, such as a ChatGPT `.zip` or a
Perplexity `.xlsx`, and the pipeline's next run, scheduled or on demand,
ingests it. A rerun writes nothing new.

**The export must be readable by the pipeline's uid.** Each pipeline's
emitter runs as a uid of its own, derived from the pipeline's name, which
the runner logs at start (`compose logs orchestration-runner`). The emitter
has no group, so the export must be readable by that uid or by everyone. A
directory it cannot read fails the run, naming the uid and the path.

**Keeping one pipeline's exports to its own emitter.** A world-readable
export can be read by every pipeline's emitter. To keep one pipeline's to
its own, grant its uid read access and take everyone's away, keeping your
own:

```bash
setfacl -R -m u:<uid>:rX -m d:u:<uid>:rX imports/<pipeline>
chmod -R o-rwx imports/<pipeline>
```

Then check it from inside, as another uid, which must fail:
`compose exec orchestration-runner su-exec 30001:30001 ls /imports/<pipeline>`.

That holds where the engine enforces the host's file modes:
- **Rootful Docker or podman on Linux:** it holds as written.
- **Rootless podman or Docker:** the uid inside is mapped, so run the
  commands through `podman unshare`.
- **Docker Desktop and podman-machine (macOS, Windows):** file modes are
  not enforced across the VM's mount at all. A directory shown as mode 700
  was still read by another uid (measured), so there every emitter reads
  every export.

Renaming a pipeline gives it a new uid; grant the new one.

Everything here except this file and `.gitignore` is ignored by git. It is
also kept out of every image's build context (the root `.dockerignore`),
since an export is private data. `IMPORTS_DIR` in `deploy/.env` points
the runner at another directory. `deploy/README.md` ("Orchestration") has
the whole flow.
