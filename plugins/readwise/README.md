# Readwise Plugin

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@mlava](https://github.com/mlava)** as the Readwise Capture integration, a server of its own; a plugin of the brain's since SMD-2690.

## What it does

Readwise posts each new highlight to a webhook the brain serves, and the plugin stores it as a thought. Readwise collects highlights from Kindle, Apple Books, Reader, Instapaper, Hypothesis, podcast apps and physical books (its OCR app), so one webhook covers them all.

- **The webhook**, `POST /hooks/readwise/highlight`, is served by the brain's REST core once the operator turns it on (below). It does three things for each `readwise.highlight.created` event:
  - It checks the secret Readwise echoes in the body against the one the operator set.
  - It captures the passage, and the reader's note after it (`— note`), as a thought of trust `ingested`, with `source: readwise`. The core embeds it and extracts its metadata as it does any capture; with a model provider that is not local, only once the egress policy lets the hook's text out (step 1). The thought carries the highlight's and the book's Readwise ids as metadata (`readwise_highlight_id`, `readwise_book_id`).
  - It records the rest of what Readwise sent in the plugin's own table: the note, location, colour, url, tags and times. A time that is not an ISO 8601 string (as Readwise sends them) is stored as none; the highlight is captured all the same.
- **Each highlight is captured once.** A highlight Readwise sends again is answered with the thought the first delivery captured, and nothing runs. Its id is kept for good, because Readwise signs no time.
- **Other events are ignored.** An empty body (Readwise's **Test Endpoint** button) is answered 200, and so is any other event type that carries the secret. Neither changes anything.
- **`readwise_list_highlights`** (read) lists the highlights the webhook captured, newest highlighted first, optionally one book's. Each names the thought its text is in (`fetch` reads it) and is marked `trust: ingested`: its note, url, tags and the rest are what the sender posted. It is an MCP tool on the brain's own connector, and `GET /v1/plugins/readwise/highlights` on the REST core (`/api/v1/…` through the proxy, with `compose.api-public.yaml`). A highlight whose thought was deleted is still listed, and still answered `duplicate`, naming the thought `fetch` no longer finds.

**What the standalone server did that the plugin does not:**
- **No book title or author.** A plugin makes no outbound call, so the plugin cannot ask Readwise's API for the book's title and author. A highlight carries Readwise's book id alone (filling a books table the plugin can read is SMD-3878). The [readwise-import recipe](../../recipes/readwise-import/) and its [readwise-books schema](../../schemas/readwise-books/) keep a books table.
- **No `source_type` or `type` columns.** The webhook is a capture-only caller, so the thought's `source_type` and `type` columns (the enhanced-thoughts schema's) are not set. `metadata.source` is `readwise`, and the core's extractor gives the thought its type. The readwise-books schema's `get_book_highlights` filters on `source_type`, so it does not find the plugin's highlights; `readwise_list_highlights` does.
- **No metadata merge on known text.** A highlight whose text the brain already holds (up to case and spacing) is answered with that thought, whoever captured it, and the thought keeps the metadata it had: a capture-only caller's re-capture changes nothing. The highlight's own row still names the thought.
- **No health check.** The old server answered a GET with 200 ("readwise-capture is live"). A hook takes POST alone: a GET is answered `405`. The REST core's own `/health` is the one to probe.
- **No book counter.** The old server bumped `readwise_books.num_highlights` for each highlight (`increment_book_highlight_count`). The plugin writes no book row, so nothing calls it now.
- **One extra model call per highlight.** Every capture now runs the core's metadata extraction as well as its embedding. That is the same cost as any other capture on the brain, and more than the old server's embedding alone.

**Readwise's secret is a bearer secret.** Readwise signs nothing and sends no time: the secret travels in each delivery's body, so anyone who has seen one delivery (a proxy log, a leaked request) can post highlights of their own, captured as ingested text. Readwise's highlight ids rise one by one, so a forger can also send the next ones first, and the real highlights are then answered `duplicate` and lost. Keep the webhook URL behind TLS; if a delivery leaks, see [If a delivery leaks](#if-a-delivery-leaks).

## Prerequisites

- A working brain stack (`deploy/compose.yaml`) that Readwise can reach over HTTPS: the TLS proxy or tunnel in front of it ([docs/01-getting-started.md](../../docs/01-getting-started.md), Step 6).
- A key with read scope to list highlights: `bun keygen.ts --name me --scope read` in `server-portable/` prints the key, and a line to add to `MCP_ACCESS_KEYS` in `deploy/.env` ([SETUP.md](../../SETUP.md) has the rest). Add it before step 2, which recreates the servers that read it. A write key lists highlights too.
- A Readwise account. Its Free and paid plans both offer webhooks at [readwise.io/webhook](https://readwise.io/webhook).

## Turn it on

1. **Turn the plugin on.** Add it to `deploy/.env`, with the secret each plugin's login role's password is derived from. If `OB1_PLUGIN_DB_PASSWORD` is already set for another plugin, keep it: one secret serves them all. Names in `OB1_PLUGINS` are comma-separated.

   Readwise makes the webhook's secret only after it creates the webhook, and it creates one only once its **Test Endpoint** gets a 2xx. The brain answers 503 to a webhook with no secret. So set a placeholder secret for now, and replace it in step 4:

   ```
   OB1_PLUGINS=readwise
   OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
   OB1_HOOKS=readwise
   OB1_HOOK_SECRETS=readwise=<openssl rand -hex 32, replaced in step 4>
   ```

   `OB1_HOOKS` and `OB1_HOOK_SECRETS` hold every webhook plugin, the secrets as `plugin=secret` pairs separated by spaces.

   With a model provider that is not local, the egress policy decides whether a capture's text may leave for it, and the default (`deny`) lets nothing out that no term allows. The hook captures as `hook:readwise`, so allow it, beside any terms already there: `OB1_EGRESS_ALLOW=actor:hook:readwise`. Without it each highlight is saved with no vector and no extracted metadata; the vector mender fills the vectors in once the term is there ([deploy/.env.example](../../deploy/.env.example), "What may leave the box").
2. **Recreate the services so they read it.** From `deploy/`, run `docker compose up -d migrate api mcp`, then `docker compose up -d --force-recreate --no-deps app`. Then name the webhook overlay, so the proxy routes `/hooks`: `docker compose -f compose.yaml -f compose.hooks-public.yaml up -d proxy forwarder`. Name the stack's other `-f` files in each.
   - The migrator makes the plugin's role, its schema and its login role `ob1_plugins_readwise`, and applies `001_highlights.sql` and `002_deliveries.sql`.
   - Recreating `app` signs everyone out of the GUI: its sessions live in its memory.
3. **Register the webhook in Readwise.**
   - At [readwise.io/webhook](https://readwise.io/webhook), add a webhook. The URL is `https://<your brain's host>/hooks/readwise/highlight`. For the event, choose `readwise.highlight.created` alone: the plugin ignores the rest.
   - Click **Test Endpoint**. It should pass: the brain answers its empty body 200.
   - Save the webhook. Readwise shows the secret it made under the webhook's masked **Secret** field.
4. **Set Readwise's secret.** Put that secret in place of the placeholder (`OB1_HOOK_SECRETS=readwise=<Readwise's secret>`), and recreate the REST core and then the GUI: `docker compose up -d api`, then `docker compose up -d --force-recreate --no-deps app`, each with the stack's other `-f` files. Until then, every real delivery is refused with `401 BAD_SECRET`.
5. **Check it.**
   - The REST core's preflight, at the top of its log (`docker compose logs api`): its `plugin webhooks` row says `readwise` is served, and its `plugin tables` row says the role, schema and migrations are in place.
   - Make a highlight anywhere Readwise collects from. Within a minute or so (Readwise batches some sources), `readwise_list_highlights` lists it, and `fetch` with its `thought_id` shows the passage.

Remove the name from `OB1_PLUGINS` and `OB1_HOOKS`, and its `readwise=` pair from `OB1_HOOK_SECRETS` (or preflight warns of a secret no webhook uses), and recreate the same services, to turn it off. The webhook path then answers 404, and Readwise's deliveries fail until the webhook is deleted there. The plugin's tables and rows stay, and come back when it is turned on again.

## Moving from the standalone server

The standalone server (`integrations/readwise-capture`) wrote each highlight into `thoughts`, with Readwise's fields in its metadata, and kept a book cache, `public.readwise_books`, which stays for the readwise-import recipe that still writes it. The old thoughts stay as they are. The plugin starts with an empty `highlights` table, so `readwise_list_highlights` lists only what it captures itself. Don't run the old server beside the plugin.

To list the old highlights too, copy them across. The block below seeds the plugin's table from the thoughts the old server captured, and marks each highlight's id as captured. Run it as the database owner in `psql`: on the compose stack, from `deploy/`, pipe it to `docker compose exec -T postgres psql -U postgres -d openbrain`. The readwise-import recipe's thoughts carry the same `source` and ids, so they are copied too, and a highlight it imported is then never captured twice. It is one transaction, so a refused row copies nothing and the block can be run again. A highlight already in the plugin's table is left as it is:

```sql
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO plugin_readwise.highlights (highlight_id, thought_id, book_id, note, location, location_type, color, url, tags, highlighted_at)
  SELECT DISTINCT ON ((t.metadata->>'readwise_highlight_id')::bigint)
         (t.metadata->>'readwise_highlight_id')::bigint, t.id, (t.metadata->>'readwise_book_id')::bigint,
         CASE WHEN t.metadata->>'note' ~ '^[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$' THEN NULL ELSE t.metadata->>'note' END, (t.metadata->>'location')::double precision, nullif(t.metadata->>'location_type', ''),
         nullif(t.metadata->>'color', ''), nullif(t.metadata->>'url', ''),
         (SELECT coalesce(array_agg(x ORDER BY n), '{}') FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(t.metadata->'tags') = 'array' THEN t.metadata->'tags' ELSE '[]'::jsonb END) WITH ORDINALITY AS a(x, n)),
         (t.metadata->>'highlighted_at')::timestamptz
    FROM public.thoughts t
   WHERE t.metadata->>'source' = 'readwise'
     -- First captured by no key: the old server and readwise-import named none; any key may label a capture readwise.
     AND (SELECT a.actor_name FROM public.thought_audit a WHERE a.thought_id = t.id AND a.action = 'capture' ORDER BY a.seq LIMIT 1) IS NULL
     AND t.metadata->>'readwise_highlight_id' ~ '^[1-9][0-9]{0,15}$' AND t.metadata->>'readwise_book_id' ~ '^[1-9][0-9]{0,15}$'
   ORDER BY (t.metadata->>'readwise_highlight_id')::bigint, t.created_at
ON CONFLICT (highlight_id) DO NOTHING;
INSERT INTO plugin_readwise.deliveries (id, thought_id)
  SELECT highlight_id::text, thought_id FROM plugin_readwise.highlights
ON CONFLICT (id) DO NOTHING;
COMMIT;
```

- **Which thoughts.** Those whose `metadata.source` is `readwise`, with a numeric highlight and book id, first captured by no key: the old server and readwise-import wrote with none. A key's capture labelled `readwise` (any capture key may label one so) is left out, so it cannot mark a real highlight's id as captured. When one highlight's id is on two thoughts, the first captured is kept.
- **A refused copy.** A `location` that is not a number or a `highlighted_at` that is not a time stops the copy, which names the value. Fix that thought's metadata, or leave it out with one more condition in the `WHERE`, and run the block again.
- **The ids as captured.** The second insert marks each copied highlight's id as captured, so Readwise sending one again is answered with its thought rather than captured twice.
- **The old server's metadata** stays on the old thoughts. A new highlight's thought carries the two ids alone.

## Troubleshooting

- **`400 NOT_JSON`.** The body was not a JSON object.
- **`400 BAD_HIGHLIGHT`.** The event lacked a field the plugin reads, or one was not of its kind or past its bound; `fields` names them. Nothing was captured. Each field has a bound in characters (an emoji is one): the passage 16,384, the note 8,192, the url 4,096, the location type and colour 64, and up to 100 tags of 128.
- **`401 BAD_SECRET`.** The secret in `OB1_HOOK_SECRETS` is not the one Readwise made for this webhook. Copy it again from the webhook's entry, then recreate `api` ("Turn it on", step 4).
- **`readwise_list_highlights` answers `403 FORBIDDEN`.** The key cannot read: a capture-only key cannot list.
- **`404`.** A JSON `{"code":"NO_ROUTE"}` is the REST core's: the plugin is not in `OB1_HOOKS` and `OB1_PLUGINS` on the running REST core. A plain-text `404 page not found` is the proxy's: it was started without `compose.hooks-public.yaml`.
- **`405`.** A GET: the webhook takes POST alone. The old server's GET health check is the REST core's `/health` now.
- **`409 IN_FLIGHT`.** A delivery of the same highlight is still being captured. A resend after it finishes is answered with its thought. One whose server stopped mid-capture holds its id for an hour, then a resend captures it.
- **`413 TOO_LARGE`.** The body was over 512 KiB, which the plugin refuses before it parses it (the REST core refuses one over 1 MiB first). A highlight is a few KB.
- **`422 CORE_REFUSED`.** The core refused the capture, and `refused` names its code; the highlight's id is given back, so a resend captures it once the cause is fixed. A refusal the core says is worth retrying is answered `503` instead. A model provider that does not answer, or an egress policy that keeps the text from it, is no refusal: the thought is saved, and its vector filled later. One that answers with an error is `503 EMBEDDING_PROVIDER_REFUSED`, below.
- **`503 EMBEDDING_PROVIDER_REFUSED`** (`refused: EMBEDDING_PROVIDER_ERROR`). The brain's embedding provider refused the capture — its key, its model or its address (a redirect, or a gateway answering for it), or the request (a 400, which a hosted provider answers to every call for a setting it will not take) — not for the highlight alone: the REST core's log names which, and `OB1_LLM_BASE_URL`, its key or `OB1_EMBEDDING_MODEL` is the operator's to mend. The highlight's id is given back, so Readwise's resend captures it once that is done (SMD-2892).
- **`500 FAILED`.** The store was down, or the highlight's row failed to write; the REST core's log has the cause. The highlight's id is given back, so a resend captures it, as the same thought if its text was saved.
- **`503 HOOK_NOT_CONFIGURED`** (Readwise's Test Endpoint fails). The webhook has no secret, or the REST core was not recreated after `OB1_HOOK_SECRETS` was set. Set the placeholder ("Turn it on", step 1) and recreate `api`.

## If a delivery leaks

Readwise's secret travels in each delivery's body, and its ids are kept for good, so a new secret stops new forgeries but does not clear those already made.

1. Delete the webhook in Readwise and make a new one, which gets a new secret, and set it ("Turn it on", step 4).
2. Look over what was captured since the leak: `readwise_list_highlights` lists each highlight, its thought and when it was captured.
3. Tell the forged highlights from the real ones against your Readwise library: its export lists every highlight's id and text. A forger who sends a real highlight's next id first uses an id the library has, so compare the text `fetch` shows for each row's thought with the library's text for that id, not the id alone.
4. Before deleting anything, look at each forged highlight's thought, as the database owner in `psql`. A forger who sends text the brain already holds (a real highlight's, say) gets a row naming that existing thought, which is not theirs, and two forgeries of one text name one thought. This shows who first captured the thought and when, which highlights name it, and who else has written to it:

   ```sql
   SELECT a.actor_name, a.created_at,
          (SELECT string_agg(h.highlight_id::text, ', ' ORDER BY h.highlight_id) FROM plugin_readwise.highlights h WHERE h.thought_id = a.thought_id) AS highlights,
          (SELECT string_agg(DISTINCT coalesce(b.actor_name, '(no key)'), ', ') FROM public.thought_audit b WHERE b.thought_id = a.thought_id AND b.actor_name IS DISTINCT FROM 'hook:readwise') AS others
     FROM public.thought_audit a WHERE a.thought_id = '<thought id>' AND a.action = 'capture' ORDER BY a.seq LIMIT 1;
   ```

   The thought is the forger's when `actor_name` is `hook:readwise`, `created_at` is after the leak, every id in `highlights` is a forged one, and `others` names no one who changed its text or metadata. `vector-mender` or `reembed` there only filled its vector; so may a key that can only capture, which leaves no row when it sends text the brain already holds unless the thought had no vector, which it then fills. `(no key)` is a write made with none, such as SQL by hand. So the trail is a guide, not proof: read the thought (`fetch`) before you delete it (`delete_thought`, with a write key). Check every forged highlight before step 5: once their rows are gone, the query no longer shows them.
5. Then delete each forged highlight's rows, so the real highlight is captured if it is sent again: `DELETE FROM plugin_readwise.highlights WHERE highlight_id = <id>; DELETE FROM plugin_readwise.deliveries WHERE id = '<id>';`. Readwise documents no retries, so a real highlight already answered `duplicate` is captured only when it is posted to the webhook again by hand, as Readwise posts it.
