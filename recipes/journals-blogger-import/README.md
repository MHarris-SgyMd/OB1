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

   `--skip N` and `--limit N` take a slice of the entries.

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

## Expected Outcome

After the import:
- Each blog post or comment is one thought, labelled `metadata.source: blogger`, with its `<entry>` element kept byte for byte in `thought_sources` under the system `blogger`
- Post titles are preserved, and each thought is dated by its `<published>` date, not when the import ran
- HTML content is stripped to plain text (line breaks preserved): the export's escaping is undone before the tags are removed, so no `<p>` survives into the text
- Blog comments are thoughts of their own (`metadata.kind: comment`)
- Settings and template entries are automatically filtered out
- The fields the import used to set as columns ride as metadata: `type: journal`, `source_type: blogger_import`, `importance`, `quality_score` and `sensitivity_tier`
- Running the import again writes nothing new. An entry is identified by its Atom `<id>`, so an edited post updates its thought in place, and an entry two export files both hold is emitted once, from the first file in name order (so an older backup beside a newer one can win: keep one export of each blog in the folder)

A thought's text holds about 100,000 characters at most, since a search hit returns its thought whole (earlier versions cut at 30,000). A post longer than that is cut, and says so; its `<entry>` in the source record keeps it whole.

**Scale reference:** Tested with 3,000+ blog posts across multiple blogs imported successfully.

## Troubleshooting

**Issue: No entries found in .atom file**
The parser looks for `<entry>` tags with `kind#post` or `kind#comment` categories (the `term` in single or double quotes). Blogger settings and template entries are filtered out. If your Atom file uses a different schema, check the XML structure.

**Issue: HTML tags appearing in imported text**
The HTML stripper handles common tags and entities. If you see raw HTML in your thoughts, the post may use unusual HTML structures. The content is still searchable.

**Issue: Wrong dates on posts**
The parser uses the `<published>` tag from the Atom feed, with its timezone (a date with none is read as UTC). If dates look wrong, check the timezone in your Blogger export settings. A date the brain would refuse, such as one in the future, is left out, and the brain dates that entry when it is written.
