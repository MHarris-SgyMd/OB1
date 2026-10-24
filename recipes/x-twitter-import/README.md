# X/Twitter Import

<div align="center">

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@alanshurafa](https://github.com/alanshurafa)**

*Reviewed and merged by the Open Brain maintainer team — thank you for building the future of AI memory!*

</div>

> Import your X (Twitter) data export — tweets, DMs, and Grok chats — into Open Brain.

## What It Does

Parses X (formerly Twitter) data exports and turns three types of content into searchable thoughts:
- **Tweets** — your original tweets (retweets filtered out), one thought per day
- **DMs** — direct message conversations (minimum 3 messages)
- **Grok chats** — conversations with X's Grok AI assistant

The script is an emitter of the brain's ingestion contract (SMD-2493). It prints one item per thought, one JSON object per line, and writes nothing itself. The brain's pipeline writes the rows (`db/ingest-records.ts`), and `db/reembed.ts` embeds them at the brain's own model. So the script needs no database credentials and no embedding key.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md)), and this repository checked out beside it
- **X/Twitter data export** — request from X Settings → Your Account → Download an archive
- **Bun** (the runtime the brain's tools use)

## Steps

1. **Request your X data export:**
   - Go to X Settings → Your Account → Download an archive of your data
   - Wait for the email notification (can take 24-48 hours)
   - Download and extract the archive
   - You should see a `data/` folder containing `tweets.js`, `direct-messages.js`, etc.

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

4. **Emit the items** into a file only you can read: they hold your tweets and messages. From the repository root:

   ```bash
   F=$(mktemp)
   bun recipes/x-twitter-import/import-x-twitter.mjs /path/to/twitter-export > "$F"
   ```

   `--types tweets` or `--types dms,grok` takes some types only; `--skip N` and `--limit N` take a slice.

5. **Count them** with the pipeline's dry run. It checks every line and writes nothing; a malformed line refuses the whole file, naming the line and the field:

   ```bash
   bun db/ingest-records.ts --url postgres://… --source items --items "$F" --allow x:export --dry-run
   ```

6. **Write them, embed them, and delete the file:**

   ```bash
   bun db/ingest-records.ts --url postgres://… --source items --items "$F" --allow x:export
   bun db/reembed.ts --url postgres://…
   rm "$F"
   ```

   `--allow x:export` clears the export's scope: the pipeline ingests outside content only for a scope you name. `--items -` reads the emitter's output from a pipe instead, with no file at all (`bun recipes/x-twitter-import/import-x-twitter.mjs /path/to/twitter-export | bun db/ingest-records.ts … --items -`): the emitter parses the whole export before it prints a line, so one that fails prints nothing and nothing is written.

`db/README.md`, "Items from a file", has the whole contract.

## Expected Outcome

After the import:
- Tweets are grouped by day, each day one thought (`tweets:2019-03-05`); tweets with no usable date are one more (`tweets:undated`), dated by the brain when it writes it. Days are UTC: a tweet at 8 pm in California is on the next day's thought
- DM conversations become individual thoughts, and Grok chats are grouped by chat ID
- A thought's text holds about 100,000 characters at most, plus its short header, since a search hit returns its thought whole. A longer conversation (or a day of hundreds of tweets) continues in parts, keyed `<key>#2` and on, titled "(part 2)" onward, each dated by its own first message
- Each thought is labelled `metadata.source: x`, with its source record (the archive's own JSON) in `thought_sources` under the system `x`, and `metadata.kind` saying which it is: `tweets`, `dm` or `grok`. The Grok chats are `x`'s too: they come from the X archive, and one import is one source
- Each thought is dated by its first tweet or message, not when the import ran. A date the brain would refuse (in the future, or a day the calendar lacks) is left out, the run names how many on stderr, and the brain dates that thought when it writes it
- The fields the import used to set as columns ride as metadata: `type: reference`, `source_type: x_twitter_import`, `importance`, `quality_score` and `sensitivity_tier`
- Retweets are automatically excluded
- Short DM conversations (<3 messages) are filtered out
- Running the import again on the same archive writes nothing new

A DM conversation is identified by its conversation id, a Grok chat by its chat id, and a day of tweets by its day. So a later archive that grew, or that lost tweets you deleted, updates only the thoughts whose day or conversation changed, in place, and a deleted tweet leaves its day's thought. The pipeline adds and updates; it does not remove. So a thought the archive no longer feeds keeps its last text:
- a day whose every tweet you deleted;
- a conversation the archive no longer holds;
- the old last part of a conversation or day that now needs a part fewer: its messages are then in two thoughts until you delete that one.

A conversation that grows only extends its last part or adds one, so the earlier parts stay exactly as they were. A message deleted from the middle moves the boundaries of the parts after it, and those update in place.

**Scale reference:** Tested with 1,000+ tweets and DMs imported successfully.

## Troubleshooting

**Issue: "Tweets: no tweets.js or tweet.js in …"**
X data exports use different filenames across versions. The script reads `tweets.js`, or `tweet.js` when there is no `tweets.js` (and likewise `direct-messages.js` or `direct-message.js`, `grok-conversations.js` or `grokConversations.js`), in the archive's `data/` folder or the folder you named. Check your `data/` folder for the actual filename, and point the script at the archive's top folder.

**Issue: Twitter JS file won't parse**
Twitter wraps JSON in a `window.YTD.tweets.part0 = [...]` prefix. The script strips this automatically. If parsing still fails, the script stops and names the file; it may be corrupted, so re-download it from X.

**Issue: "N tweets → 0 daily thoughts"**
Tweets under 30 characters and retweets (starting with "RT @") are filtered out. If all your tweets are short, lower the threshold in the `processTweets()` function.
