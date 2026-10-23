# Grok Export Import

> Import xAI Grok conversation history into Open Brain as searchable thoughts.

## What It Does

Parses xAI Grok conversation exports (JSON format with MongoDB-style dates) and turns each conversation into one thought. Handles nested conversation/response structures and MongoDB date objects.

The script is an emitter of the brain's ingestion contract (SMD-2493). It prints one item per conversation, one JSON object per line, and writes nothing itself. The brain's pipeline writes the rows (`db/ingest-records.ts`), and `db/reembed.ts` embeds them at the brain's own model. So the script needs no database credentials and no embedding key.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md)), and this repository checked out beside it
- **Grok data export**: the JSON file from X/Grok
- **Bun** (the runtime the brain's tools use)

## Steps

1. **Export your Grok data:**
   - Request the data export from grok.com's settings, and unzip what it sends
   - Find the JSON file that holds the conversations
   - Grok chats inside an X archive (`data/grok-conversations.js`) are not this file: the [X/Twitter Import](../x-twitter-import/) recipe reads those, under the `x` system, so import them there and not here as well

2. **Classify the ingester, once per brain, before its first import**, so the rows it writes read as outside text (`metadata.trust: ingested`) rather than unknown. From the repository root, with `docker compose` or `podman compose` and the `-f` files the stack runs with:

   ```bash
   docker compose -f deploy/compose.yaml exec -T postgres psql -U postgres -d openbrain -c "SELECT set_agent_kind('ingest-records', 'ingested')"
   ```

   The kind is stamped when a row is written. Rows imported before you classified keep no trust until `SELECT backfill_thought_actors();` restamps them.

3. **Reach the brain from this checkout.** The three `db/` commands below need the database on this machine:
   - The stack publishes it only with `deploy/compose.host-ports.yaml` as a second `-f` (`docker compose -f deploy/compose.yaml -f deploy/compose.host-ports.yaml up -d`). Adding the file to a running stack recreates the database and server containers, so the brain is down for a minute.
   - The URL is `postgres://postgres:<POSTGRES_PASSWORD from deploy/.env>@127.0.0.1:5432/openbrain`, with your `POSTGRES_PORT` if you set one.
   - `reembed.ts` embeds at the model its own environment names. Export `OB1_EMBEDDING_MODEL`, `OB1_EMBEDDING_DIM` and any chunk settings from `deploy/.env` by hand; don't `source` the file. Set `OB1_LLM_BASE_URL` to where this machine reaches the model: `http://127.0.0.1:11434/v1` for Ollama on the host, or the stack's through the host-ports file. Don't use the container-side name (`ollama`, `host.containers.internal`) that `deploy/.env` holds.
   - If `reembed.ts` says the model differs and suggests `--switch-model`, stop and set the brain's model instead: that flag re-embeds the whole brain under the model the shell names (`db/README.md`, "Re-embedding, and bulk passes in general").

4. **Emit the items** into a file only you can read: they hold your conversations. From the repository root:

   ```bash
   F=$(mktemp)
   bun recipes/grok-export-import/import-grok.mjs /path/to/grok-export.json > "$F"
   ```

   Give the script the JSON file, or a folder holding several (every `*.json` directly inside it is read). `--skip N` and `--limit N` take a slice of the conversations. A conversation the parser cannot read is named on stderr and skipped; a file that is not JSON stops the run.

5. **Count them** with the pipeline's dry run. It checks every line and writes nothing; a malformed line refuses the whole file, naming the line and the field:

   ```bash
   bun db/ingest-records.ts --url postgres://… --source items --items "$F" --allow grok:export --dry-run
   ```

6. **Write them, embed them, and delete the file:**

   ```bash
   bun db/ingest-records.ts --url postgres://… --source items --items "$F" --allow grok:export
   bun db/reembed.ts --url postgres://…
   rm "$F"
   ```

   `--allow grok:export` clears the export's scope: the pipeline ingests outside content only for a scope you name. `--items -` reads the emitter's output from a pipe instead, with no file at all (`bun recipes/grok-export-import/import-grok.mjs /path/to/grok-export.json | bun db/ingest-records.ts … --items -`): the emitter parses the whole export before it prints a line, so one that fails prints nothing and nothing is written.

`db/README.md`, "Items from a file", has the whole contract.

## Expected Outcome

After the import:
- Each Grok conversation is one thought, labelled `metadata.source: grok`, with its source record in `thought_sources` under the system `grok`. A conversation past about 100,000 characters is several, in order: the first keyed by the conversation's id, the next `<id>#2`, and so on, each titled "(part 2)" onward
- The thought is dated when the conversation was created, not when the import ran. MongoDB-style dates (`$date.$numberLong`) are parsed
- The fields the import used to set as columns ride as metadata: `type: reference`, `source_type: grok_import`, `importance`, `quality_score` and `sensitivity_tier`
- Running the import again writes nothing new. A conversation is identified by its own id (grok.com's nested export shape included), so a later export that grew updates its thought in place
- Running `search_thoughts` finds relevant Grok conversations once `reembed.ts` has run

A thought's text holds about 100,000 characters at most, plus its short header, since a search hit returns its thought whole. Earlier versions cut a conversation at 30,000 and lost the rest. Now a longer one continues in parts, each dated by the conversation:
- A conversation that grows only extends its last part or adds one, so the earlier parts stay exactly as they were.
- A message deleted from the middle moves the boundaries of the parts after it, and those update in place.
- If the conversation then needs a part fewer, its old last part keeps its last text, so those messages are in two thoughts until you delete the old one.

One message longer than the bound alone is cut, and says so; the source record keeps it whole.

**Scale reference:** Tested with 750+ Grok conversations imported successfully.

## Troubleshooting

**Issue: Date parsing errors**
Grok uses MongoDB's `{$date: {$numberLong: "..."}}` format. The script handles this automatically. If you see wrong dates, check that the JSON file hasn't been modified. A conversation with no date it can read (or one the brain would refuse, such as a date in the future) is emitted without one, and the brain dates it when it is written. A date with no timezone is read as UTC.

**Issue: "conversations" field not found**
The script looks for `parsed.conversations` first, then treats the root as an array. Different Grok export versions may structure the data differently.

**Issue: the dry run refuses the file**
The message names the line and the field. The emitter already drops what would refuse the file (a NUL character, a broken surrogate pair, an impossible date) and emits two conversations with the same id once (from the first file in name order, so keep one export per folder), so anything the pipeline still refuses is worth reporting as an issue against this recipe.
