# Journals/Blogger Import

<div align="center">

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@alanshurafa](https://github.com/alanshurafa)**

*Reviewed and merged by the Open Brain maintainer team — thank you for building the future of AI memory!*

</div>

> Import blog posts from Google Blogger Atom XML exports into Open Brain.

## What It Does

Parses Google Blogger's Atom XML export format and turns blog posts and comments into thoughts. Works with any standard Atom feed export. Blog posts are stored as `type: journal` thoughts.

The script is an emitter of the brain's ingestion contract (SMD-2493). It prints one item per post or comment, one JSON object per line, and writes nothing itself. The brain's pipeline writes the rows (`db/ingest-records.ts`), and `db/reembed.ts` embeds them at the brain's own model. So the script needs no database credentials and no embedding key.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md)), and this repository checked out beside it
- **Blogger export files** — `.atom` files from Google Blogger
- **Bun** (the runtime the brain's tools use)

## Steps

1. **Export your blog data:**
   - Go to your Blogger Dashboard → Settings → Manage Blog → Back up content
   - Download the `.atom` file
   - If you have multiple blogs, export each one

2. **Place all `.atom` files in a folder:**

   ```
   blogger-exports/
   ├── my-tech-blog.atom
   ├── personal-journal.atom
   └── travel-blog.atom
   ```

3. **Classify the ingester, once per brain, before its first import**, so the rows it writes read as outside text (`metadata.trust: ingested`) rather than unknown. From the repository root, with `docker compose` or `podman compose` and the `-f` files the stack runs with:

   ```bash
   docker compose -f deploy/compose.yaml exec -T postgres psql -U postgres -d openbrain -c "SELECT set_agent_kind('ingest-records', 'ingested')"
   ```

   The kind is stamped when a row is written. Rows imported before you classified keep no trust until `SELECT backfill_thought_actors();` restamps them.

4. **Reach the brain from this checkout.** The three `db/` commands below need the database on this machine:
   - The stack publishes it only with `deploy/compose.host-ports.yaml` as a second `-f` (`docker compose -f deploy/compose.yaml -f deploy/compose.host-ports.yaml up -d`). Adding the file to a running stack recreates the database and server containers, so the brain is down for a minute.
   - The URL is `postgres://postgres:<POSTGRES_PASSWORD from deploy/.env>@127.0.0.1:5432/openbrain`, with your `POSTGRES_PORT` if you set one.
   - `reembed.ts` embeds at the model its own environment names. Export `OB1_EMBEDDING_MODEL`, `OB1_EMBEDDING_DIM` and any chunk settings from `deploy/.env` by hand; don't `source` the file. Set `OB1_LLM_BASE_URL` to where this machine reaches the model: `http://127.0.0.1:11434/v1` for Ollama on the host, or the stack's through the host-ports file. Don't use the container-side name (`ollama`, `host.containers.internal`) that `deploy/.env` holds.
   - If `reembed.ts` says the model differs and suggests `--switch-model`, stop and set the brain's model instead: that flag re-embeds the whole brain under the model the shell names (`db/README.md`, "Re-embedding, and bulk passes in general").

5. **Emit the items** into a file only you can read: they hold your posts. From the repository root:

   ```bash
   F=$(mktemp)
   bun recipes/journals-blogger-import/import-blogger.mjs /path/to/blogger-exports > "$F"
   ```

   `--skip N` and `--limit N` take a slice of the entries. The path may be one backup file, or a folder holding `.atom` files, the dashboard's `.xml` backups, or an extracted Google Takeout (backups are found within six folders). One blog backed up twice (an entry in two files) is refused, naming both: keep the newest. An export with no post or comment entry in it exits 2, naming it, unless `--skip` or `--limit` narrowed the run; one whose records the script's filters all skip (short) emits nothing and exits 0.

6. **Count them** with the pipeline's dry run. It checks every line and writes nothing; a malformed line refuses the whole file, naming the line and the field:

   ```bash
   bun db/ingest-records.ts --url postgres://… --source items --items "$F" --allow blogger:export --dry-run
   ```

7. **Write them, embed them, and delete the file:**

   ```bash
   bun db/ingest-records.ts --url postgres://… --source items --items "$F" --allow blogger:export
   bun db/reembed.ts --url postgres://…
   rm "$F"
   ```

   `--allow blogger:export` clears the export's scope: the pipeline ingests outside content only for a scope you name. `--items -` reads the emitter's output from a pipe instead, with no file at all (`bun recipes/journals-blogger-import/import-blogger.mjs /path/to/blogger-exports | bun db/ingest-records.ts … --items -`): the emitter parses the whole export before it prints a line, so one that fails prints nothing and nothing is written.

`db/README.md`, "Items from a file", has the whole contract.

## With the orchestration profile

On a brain running the `orchestration` profile (`docs/orchestration-tool.md`), the import runner runs this import as its `blogger` pipeline, so there is no checkout to run from. In this order, from the repository root:
1. **Classify the runner, once, before the first export goes in.** Its rows carry its own name, not `ingest-records`, and the kind is stamped when a row is written:

   ```bash
   docker compose -f deploy/compose.yaml exec -T postgres psql -U postgres -d openbrain -c "SELECT set_agent_kind('orchestration-runner', 'ingested')"
   ```

   Rows a run wrote before that keep no trust until the same command with `SELECT backfill_thought_actors()` restamps them.
2. **On a brain that ran the profile before this import was added**, rebuild the runner and provision again. The old image lacks the emitter, so the runner refuses to start once it reads the new `pipelines.json`, and n8n has no workflow for the pipeline until provisioning makes one:

   ```bash
   docker compose -f deploy/compose.yaml --profile orchestration up -d --build orchestration-runner
   bun deploy/orchestration/provision.ts
   ```
3. **Put the backup in `deploy/imports/blogger/`**: the `.atom` files, the dashboard's `.xml`, or a Google Takeout as extracted. One backup per blog: several blogs side by side are one import, but one blog backed up twice fails the run, naming both files. It must be readable by the pipeline's own uid (`deploy/imports/README.md`).
4. **It runs weekly**, and writes and embeds the rows itself. To run it at once, POST to the import's on-demand workflow with the run key, `N8N_WEBHOOK_KEY` in `deploy/.env` (`deploy/README.md`, "On demand"; 5678 is `N8N_PORT`'s default):

   ```bash
   N8N_WEBHOOK_KEY=$(sed -n 's/^N8N_WEBHOOK_KEY=//p' deploy/.env)
   curl -sS --fail-with-body -X POST -H "x-n8n-run-key: $N8N_WEBHOOK_KEY" http://127.0.0.1:5678/webhook/ob1-import-blogger
   ```

   It answers with the run's report; a failed run answers 409, 422 or 500 with its reason in `why`. While curl runs, the key shows in the host's process list.

   An empty folder writes nothing and succeeds. A folder holding only a zip, an export nested too deep, or an export with no post or comment entry in it fails the run, naming the cause. An export whose records the importer's filters all skip writes nothing and succeeds.

The runner's container holds 2 GB of memory. An export that emits more than about 100 MiB of items can run it out (an X archive of 200,000 tweets did): the run fails, saying the emitter was killed, most likely for memory. Import one that large from a checkout, as above, where `wc -c "$F"` shows the size.

## Expected Outcome

After the import:
- Each blog post or comment is one thought, labelled `metadata.source: blogger`, with its `<entry>` element kept byte for byte in `thought_sources` under the system `blogger`
- Post titles are preserved, and each thought is dated by its `<published>` date, not when the import ran
- HTML content is stripped to plain text (line breaks preserved): the export's escaping is undone before the tags are removed, so no `<p>` survives into the text
- Blog comments are thoughts of their own (`metadata.kind: comment`)
- Settings and template entries are automatically filtered out
- The enhanced fields ride as metadata: `type: journal`, `source_type: blogger_import`, `importance`, `quality_score` and `sensitivity_tier`
- Running the import again writes nothing new. An entry is identified by its Atom `<id>`, so an edited post updates its thought in place. An entry two backup files both hold is one blog backed up twice, and the run is refused, naming both files: keep the newest. An import removes nothing, so a record deleted from a newer export keeps its thought. Never put an older export in place of a newer one: its records would overwrite the newer ones.

A thought's text holds about 100,000 characters at most, since a search hit returns its thought whole (earlier versions cut at 30,000). A post longer than that is cut, and says so; its `<entry>` in the source record keeps it whole.

**Scale reference:** Tested with 3,000+ blog posts across multiple blogs imported successfully.

## Troubleshooting

**Issue: No entries found in .atom file**
The parser looks for `<entry>` tags with `kind#post` or `kind#comment` categories (the `term` in single or double quotes). Blogger settings and template entries are filtered out. If your Atom file uses a different schema, check the XML structure.

**Issue: HTML tags appearing in imported text**
The HTML stripper handles common tags and entities. If you see raw HTML in your thoughts, the post may use unusual HTML structures. The content is still searchable.

**Issue: Wrong dates on posts**
The parser uses the `<published>` tag from the Atom feed, with its timezone (a date with none is read as UTC). If dates look wrong, check the timezone in your Blogger export settings. A date the brain would refuse, such as one in the future, is left out, and the brain dates that entry when it is written.
