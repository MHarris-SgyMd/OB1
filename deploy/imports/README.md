# Exports for the import runner

The `orchestration` profile's import runner (`deploy/orchestration/runner.ts`)
mounts this directory read-only at `/imports`. Each pipeline in
`deploy/orchestration/pipelines.json` reads its own subdirectory:
`imports/<pipeline>/`. Put an export there and the pipeline's next run,
scheduled or on demand, ingests it. A rerun writes nothing new. Classify the
runner once, before the first export goes in, so its rows read
`trust: ingested`. From the repository root:

```bash
docker compose -f deploy/compose.yaml exec -T postgres psql -U postgres -d openbrain -c "SELECT set_agent_kind('orchestration-runner', 'ingested')"
```

Rows a run wrote before that keep no trust until the same command with
`SELECT backfill_thought_actors()` restamps them. The pipelines that ship
(SMD-2493):

| Folder | What goes in it |
|---|---|
| `imports/grok/` | the conversations JSON file itself (several files of one export may sit side by side), or one folder holding it; one export at a time |
| `imports/instagram/` | the extracted Instagram download (the folder holding `your_instagram_activity/`); one download at a time |
| `imports/blogger/` | the Blogger backup files (`.atom`, or the dashboard's `.xml`), or an extracted Google Takeout |
| `imports/x-twitter/` | the extracted X archive (the folder holding `data/`); one archive at a time |

**What a run makes of the folder.** Each recipe's README
(`recipes/<recipe>/`) says what its import makes of the export itself.
- Empty, or holding only dot-files, `__MACOSX/` and the `._*` files a zip
  made on a Mac carries: the run writes nothing and succeeds.
- An export: ingested. A zip beside it, as unzipping in place leaves one, is
  passed over, so extract a newer export rather than dropping its zip in.
- An export whose records the importer's own filters all skip (retweets,
  short notes): the run writes nothing and succeeds.
- These fail the run, naming the cause:
  - two exports side by side (two Grok exports, two X archives, two
    Instagram downloads, one blog backed up twice, one Grok conversation in
    two files): keep the newest, or merge the parts of one export into one
    folder. Several blogs side by side are one import;
  - something there the importer does not read: a zip still to extract, an
    Instagram download in HTML, an export nested deeper than it looks;
  - an export with no record of the importer's kind in it (another product's
    file, a vendor shape it does not know);
  - a folder or file it cannot read (below).

**Copy the export in; do not link it.** A symlinked folder inside
`imports/<pipeline>/` is not walked into (X does follow one named `data`), but
a link is followed wherever an importer opens a path by name: a Grok file,
X's archive files, Instagram's `messages/`, `comments/` and `content/`. It
reaches whatever the pipeline's uid can read, so only the ACL setup below
keeps one pipeline out of another's export. `imports/<pipeline>` itself as a
link to a folder outside this directory points nowhere inside the container,
and the runner refuses the run, saying so.

**Replacing an export.** A newer export put in place of the old one updates
its thoughts in place. An import removes nothing, so a record deleted from the
newer export keeps its thought. Never put an older export back: its records
would overwrite the newer ones.

**Size.** The runner's container holds 2 GB of memory (`mem_limit`), and the
runner holds what an emitter prints several times over. An export that emits
more than about 100 MiB of items can run it out (an X archive of 200,000
tweets did): the run fails, saying the emitter was killed, most likely for
memory. Import one that large from a checkout, as its recipe's README says.

**The export must be readable by the pipeline's uid.** Each pipeline's
emitter runs as a uid of its own, derived from the pipeline's name, which
the runner logs at start (`compose logs orchestration-runner`). The emitter
has no group, so the export must be readable by that uid or by everyone. A
folder it cannot read fails the run, naming the path (and, for the
pipeline's own folder, the uid); so does one inside the export. An unzip
that left the files `0600` and the folders `0700` is made readable to
every pipeline, and to every account on this host, with
`chmod -R a+rX imports/<pipeline>`; the next section keeps it to one.

**Keeping one pipeline's exports to its own emitter.** A world-readable
export can be read by every pipeline's emitter. To keep one pipeline's to
its own, grant its uid read access and take everyone's away, keeping your
own:

```bash
setfacl -R -m u:<uid>:rX -m d:u:<uid>:rX imports/<pipeline>
chmod -R o-rwx imports/<pipeline>
```

Then check it from inside. As the pipeline's own uid it must succeed, and as
another uid it must fail:
`compose exec orchestration-runner su-exec <uid>:<uid> ls /imports/<pipeline>`,
then the same with `30001:30001`. The runner asks the kernel the same
question as the pipeline's uid before each run, so an ACL counts.

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
the runner at another directory. Give it one of its own, outside the
checkout (a folder in it other than this one is neither ignored by git nor
kept out of builds): on an SELinux host
compose relabels the whole directory for the container (`:z`), and on a
filesystem without extended attributes (NFS, vfat) that relabel fails the
start. The directory itself must be searchable by others (mode `o+x`): the
runner refuses a run it cannot reach. `deploy/README.md` ("Orchestration") has
the whole flow.
