# Instagram Import

<div align="center">

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@alanshurafa](https://github.com/alanshurafa)**

*Reviewed and merged by the Open Brain maintainer team — thank you for building the future of AI memory!*

</div>

> Import your Instagram data — DMs, comments, and post captions — into Open Brain.

## What It Does

Parses Instagram's data export and turns three types of content into searchable thoughts:
- **Messages** — DM conversations (minimum 3 messages per conversation)
- **Comments** — Your comments on posts, one thought per day
- **Posts** — Your post captions, one thought per day

Handles Meta's double-encoded UTF-8 text (latin1 → UTF-8 conversion).

The script is an emitter of the brain's ingestion contract (SMD-2493). It prints one item per thought, one JSON object per line, and writes nothing itself. The brain's pipeline writes the rows (`db/ingest-records.ts`), and `db/reembed.ts` embeds them at the brain's own model. So the script needs no database credentials and no embedding key.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md)), and this repository checked out beside it
- **Instagram data export** — download from Instagram Settings
- **Bun** (the runtime the brain's tools use)

## Steps

1. **Request your Instagram data:**
   - Go to Instagram → Settings → Accounts Center → Your information and permissions → Download your information
   - Select **JSON** format
   - Download and extract the archive
   - Look for the `your_instagram_activity/` folder

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

4. **Emit the items** into a file only you can read: they hold your messages. From the repository root:

   ```bash
   F=$(mktemp)
   bun recipes/instagram-import/import-instagram.mjs /path/to/instagram-export > "$F"
   ```

   `--types messages` or `--types comments,posts` takes some types only; `--skip N` and `--limit N` take a slice. A file of the export that is not valid JSON stops the run, naming it: re-download the export rather than import a conversation with messages missing.

5. **Count them** with the pipeline's dry run. It checks every line and writes nothing; a malformed line refuses the whole file, naming the line and the field:

   ```bash
   bun db/ingest-records.ts --url postgres://… --source items --items "$F" --allow instagram:export --dry-run
   ```

6. **Write them, embed them, and delete the file:**

   ```bash
   bun db/ingest-records.ts --url postgres://… --source items --items "$F" --allow instagram:export
   bun db/reembed.ts --url postgres://…
   rm "$F"
   ```

   `--allow instagram:export` clears the export's scope: the pipeline ingests outside content only for a scope you name. `--items -` reads the emitter's output from a pipe instead, with no file at all (`bun recipes/instagram-import/import-instagram.mjs /path/to/instagram-export | bun db/ingest-records.ts … --items -`): the emitter parses the whole export before it prints a line, so one that fails prints nothing and nothing is written.

`db/README.md`, "Items from a file", has the whole contract.

## Expected Outcome

After the import:
- Each thought is labelled `metadata.source: instagram`, with its source record (the export's own JSON) in `thought_sources` under the system `instagram`, and `metadata.kind` saying which it is: `dm`, `comments` or `captions`
- Every message of a conversation is in its text. A thought's text holds about 100,000 characters at most, plus its short header, since a search hit returns its thought whole. A longer conversation continues in parts (`dm:1234567#2` and on, titled "(part 2)" onward), each dated by its own first message. (Earlier versions kept the first 200 messages and nothing after.)
- Comments and captions are grouped by day, each day one thought (`comments:2023-07-22`); those with no usable date are one more (`comments:undated`), dated by the brain when it writes it. Days are UTC: a comment at 8 pm in California is on the next day's thought
- Each thought is dated by its first message, comment or caption, not when the import ran. A date the brain would refuse (in the future, say) is left out, the run names how many on stderr, and the brain dates that thought when it writes it
- The fields the import used to set as columns ride as metadata: `type: reference`, `source_type: instagram_import`, `importance`, `quality_score` and `sensitivity_tier: personal`. The weekly digest (`db/weekly-digest.ts`) leaves a row out by that metadata as it does by the column, unless it is run with `--include-personal`
- Running the import again on the same export writes nothing new
- Running `search_thoughts { query: "that restaurant recommendation" }` finds relevant DMs once `reembed.ts` has run

A DM conversation is identified by the thread id its inbox folder ends in (`alice_1234567` is `dm:1234567`), which a rename of the other person does not move; a folder without one is identified by its name. A day of comments or captions is identified by its day. So a later export that grew, or that lost a comment you deleted, updates only the thoughts whose day or conversation changed, in place. The pipeline adds and updates; it does not remove. So a thought the export no longer feeds keeps its last text:
- a day whose every comment you deleted;
- a conversation the export no longer holds;
- the old last part of a conversation that now needs a part fewer (messages unsent from its middle, or an export narrowed to a date range): its messages are then in two thoughts until you delete that one.

A conversation that grows only extends its last part or adds one, so the earlier parts stay exactly as they were. A message deleted from the middle moves the boundaries of the parts after it, and those update in place.

**Scale reference:** Tested with 502 Instagram items imported successfully.

## Troubleshooting

**Issue: "No 'your_instagram_activity' folder … nothing emitted"**
The export structure varies by download method. Look inside your extracted archive for a folder named `your_instagram_activity`. If it's nested deeper, point the script at the parent folder.

**Issue: Garbled text (wrong characters)**
Meta exports encode text as latin1-interpreted UTF-8. The script fixes this automatically with `fixMetaEncoding()`, and leaves text alone that is already well-formed (an emoji or an accent the export did not mangle). If text still looks wrong, the file may use a different encoding.

**Issue: No messages found**
DMs are in `your_instagram_activity/messages/inbox/`. Each conversation is in its own folder with `message_1.json`, `message_2.json`, etc. Check that this structure exists in your export.
