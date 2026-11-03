# Professional CRM Plugin

The people in a professional network, each touchpoint with them, the opportunities they bring, and the brain's thoughts linked to them, kept in the brain itself (SMD-2311). An agent can say who to follow up with, who is going cold, and what to know before a meeting. It is the learning path's [Extension 5](../../extensions/professional-crm/), which was a standalone MCP server with its own keys until it became this plugin.

## What it does

Four tables of its own, in the schema `plugin_professional_crm`, made by `migrations/001_professional_crm.sql`:

- `professional_contacts`: each person, with where they work, how to reach them, how you met, tags, notes, when you last spoke (`last_contacted`) and the day to get back in touch (`follow_up_date`).
- `contact_interactions`: each touchpoint with a contact (a meeting, email, call, coffee, event, LinkedIn message or other), when it happened, what it was about, and any follow-up promised.
- `opportunities`: deals, projects and collaborations, each at a stage, with its worth and expected close, and with a contact or none.
- `contact_thoughts`: the brain's thoughts linked to a contact, each once.

| Operation | MCP tool | REST route | Scope | Input | Output |
|---|---|---|---|---|---|
| Add a contact | `professional_crm_add_contact` | `POST /v1/plugins/professional-crm/contacts` | `write` | `name`; `company`, `title`, `email`, `phone`, `linkedin_url`, `how_we_met`, `tags`, `notes`, `follow_up_date` optional | `{ contact }` |
| Search contacts | `professional_crm_search_contacts` | `GET /v1/plugins/professional-crm/contacts` | `read` | `query`, `tag` optional; `limit`, 1 to 200, default 20 | `{ contacts, truncated }` |
| Change a contact | `professional_crm_update_contact` | `PATCH /v1/plugins/professional-crm/contacts/{contact_id}` | `write` | `contact_id`; any of `add_contact`'s fields | `{ contact }` |
| Log an interaction | `professional_crm_log_interaction` | `POST /v1/plugins/professional-crm/contacts/{contact_id}/interactions` | `write` | `contact_id`, `interaction_type`, `summary`; `occurred_at`, `follow_up_needed`, `follow_up_notes`, `follow_up_date` optional | `{ interaction, contact }` |
| A contact's history | `professional_crm_get_contact_history` | `GET /v1/plugins/professional-crm/contacts/{contact_id}` | `read` | `contact_id`; `limit`, 1 to 500, default 50 | `{ contact, interactions, interaction_count, truncated, opportunities, linked_thoughts }` |
| Add an opportunity | `professional_crm_create_opportunity` | `POST /v1/plugins/professional-crm/opportunities` | `write` | `title`; `contact_id`, `description`, `stage`, `value`, `expected_close_date`, `notes` optional | `{ opportunity }` |
| List opportunities | `professional_crm_list_opportunities` | `GET /v1/plugins/professional-crm/opportunities` | `read` | `stage`, `open`, `contact_id` optional; `limit`, 1 to 200, default 50 | `{ opportunities, truncated }` |
| Change an opportunity | `professional_crm_update_opportunity` | `PATCH /v1/plugins/professional-crm/opportunities/{opportunity_id}` | `write` | `opportunity_id`; any of `create_opportunity`'s fields | `{ opportunity }` |
| Follow-ups due | `professional_crm_get_follow_ups` | `GET /v1/plugins/professional-crm/follow-ups` | `read` | `days_ahead`, 0 to 365, default 7; `time_zone`; `limit` of each list, 1 to 500, default 100 | `{ overdue, upcoming, promised, overdue_count, upcoming_count, promised_count, truncated }` |
| Link a thought to a contact | `professional_crm_link_thought` | `POST /v1/plugins/professional-crm/contacts/{contact_id}/thoughts` | `write` | `contact_id`, `thought_id`; `time_zone` | `{ contact, line, ingested, already_linked }` |
| Meeting prep | `professional_crm_prep_context` | `GET /v1/plugins/professional-crm/contacts/{contact_id}/prep` | `read` | `contact_id`; `interaction_limit`, 1 to 100, default 10; `time_zone` | `{ contact, relationship, recent_interactions, pending_follow_ups, opportunities, linked_thoughts }` |
| Contacts going cold | `professional_crm_stale_contacts` | `GET /v1/plugins/professional-crm/stale-contacts` | `read` | `days_threshold`, 1 to 3650, default 30; `time_zone`; `limit`, 1 to 200, default 20 | `{ threshold_days, contacts, truncated }` |

- **Names.** The old server's tools were `crm_add_contact` and so on. The plugin's own name prefixes its tools now, so they are `professional_crm_add_contact`, and the operations are named without the old `crm_`. `list_opportunities` and `update_opportunity` are new: the old server could neither find an opportunity that named no contact nor move one on to won.
- **Formats.** Dates are `YYYY-MM-DD` from the year 0001, and timestamps are ISO text in UTC. `occurred_at` is a moment with its offset (`2026-11-03T15:00:00Z`, `…-05:00`). An email must be an email address, and a LinkedIn URL a URL starting `http://` or `https://`; anything else belongs in notes. Text is trimmed and holds no NUL. Tags are kept lower-case, each once, in the order given.
- **The user's time zone.** The reads that count days (follow-ups, meeting prep, going cold) and a thought's link line take `time_zone`, an IANA name (`America/Los_Angeles`), and count both ends in it: the user's today and the day a contact was last spoken to, so coffee this evening in Los Angeles is 0 days ago there. Without it they count in UTC. An offset (`+05:30`, `UTC+5`) is refused: Postgres reads a bare offset POSIX's way, west positive, and would count the other side of the world. The other plugins take the user's date as `today`: their rows hold dates, and this one's interactions are moments, whose day depends on the zone.
- **Searching contacts.** `query` matches word by word: every word must be in the name, company, title, email, phone, LinkedIn URL, how you met, notes or tags, in any case and as part of a word ("anth" finds Anthropic). Commas and semicolons split words too. `tag` matches a whole tag in any case. Those whose name holds every word come first, then the rest by name: a search for "Sarah Chen" lists Sarah before the contact whose notes say she introduced you. The old search ranked by Postgres's English full-text search, which missed part of a word; it has gone, with its column and function.
- **Changing a contact or an opportunity.** Only the fields given change. One given as `null` is cleared. Tags, when given, replace the list. An opportunity's `value` is kept to the cent, rounded.
- **Interactions.** Logging one moves the contact's `last_contacted` on to it, never back: an older interaction logged later leaves the latest (the old trigger moved it back). An interaction more than a day ahead is refused: an interaction is one that happened. `occurred_at` takes seconds and an offset (`2026-11-03T19:00:00-08:00`). `follow_up_notes` record what was promised, `follow_up_needed` alone does too, and `follow_up_needed: false` says nothing was. The contact's `follow_up_date` stays as it was unless the log gives `follow_up_date`: a date sets it, and null clears it, as when this interaction was the follow-up.
- **Follow-ups.** `get_follow_ups` answers "who do I need to follow up with?" in one call: the contacts whose `follow_up_date` has passed (overdue, the oldest first) or falls within `days_ahead` days (upcoming, the soonest first), each with `days_until`, negative when overdue; and what was promised and not yet followed up (`promised`), across every contact, whatever their date. A promise stands while no interaction with the contact has a later time (`occurred_at`, then when it was logged). Any later one counts as following it up, another promise too, and so does one logged earlier with a later time; one logged later with an earlier time, a backfill, does not. The counts are of all of them, and `limit` cuts each list.
- **Meeting prep.** The briefing gives the profile, the days since you last spoke (null if never), every interaction counted, the latest `interaction_limit` of them, and what was promised and not yet followed up, as `get_follow_ups` says it, however far back. The old briefing looked only at the latest ten interactions, listed every marked one among them as pending however they were followed up, and dropped one marked without notes. It also counts the open opportunities and sums their worth (`open_value`), and lists the linked thoughts by id and when linked: their text is in the notes.
- **Going cold.** `stale_contacts` lists the contacts not spoken to in `days_threshold` days or more, the longest first, each with `days_since_contact`. A contact never spoken to counts from when they were added (`days_since_contact` null), so someone added today is not cold. The old list put every contact never spoken to first, so a long list of them hid the ones actually going cold.
- **Linking a thought.** `link_thought` reads the thought through the brain's own `fetch`, as the caller: a thought the caller cannot read, or one that is not there, is refused. The plugin's SQL names nothing of the core's.
  - The thought's text, at most 2,000 characters (cut with …), is appended to the contact's notes on a line dated in the user's time zone and naming the thought: `[Linked thought 2026-11-03, thought <id>]: …`.
  - A thought captured from an outside source (trust `ingested`) carries the brain's own notice into the line, before its text, and the link says `ingested`: outside text is never read back as the user's own notes.
  - Linking it again appends nothing while its own line is in the notes (`already_linked`, answering that line); other text naming the thought does not count. If the notes were rewritten without it, linking appends it again. Two links of it at once append it once.
  - The notes stop at 100,000 characters: an add or a change takes them that long, and a link that would pass it is refused (`NOTES_FULL`). Characters are counted as characters, an emoji as one, and a cut never halves one. Blank notes are none.
  - Besides the plugin's own row, the core logs the `fetch` as a click-through, as it logs any (SMD-3212).
- **Refusals.**
  - A contact that is not there: `404 NO_SUCH_CONTACT`, saying where the ids are.
  - An opportunity that is not there: `404 NO_SUCH_OPPORTUNITY`.
  - A thought the caller cannot read, or that is not there: `404 NO_SUCH_THOUGHT`.
  - A change with no field: `422 NOTHING_TO_CHANGE`.
  - An interaction more than a day ahead: `422 FUTURE_DATE`.
  - A link that would take the notes past 100,000 characters: `422 NOTES_FULL`.
  - Any input out of its form or range: `400`, before anything is stored.
- **MCP hints.** Every tool is closed-world, and a read is read-only. `update_contact`, `update_opportunity` and `log_interaction` (which may set or clear the follow-up date) overwrite what was there, so they are marked destructive; the adds and the link are not.

**`user_id`.** Each table keeps upstream's multi-user `user_id` column, nullable, and nothing writes or reads it. The fork is one operator's brain (SMD-1716), so every key that may read sees every row (decided 2026-11-02). `DEFAULT_USER_ID` is gone.

## Prerequisites

- A working Open Brain stack (`deploy/compose.yaml`).
- A key with read scope (`bun keygen.ts --name me --scope read` in `server-portable/`), and one with write scope (`--scope write`) to add, change, log and link.

## Turn it on

1. Add the plugin to `deploy/.env`, with the secret each plugin's login role's password is derived from. If `OB1_PLUGIN_DB_PASSWORD` is already set for another plugin, keep it: one secret serves them all.

   ```
   OB1_PLUGINS=professional-crm
   OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
   ```

   Names are comma-separated: `OB1_PLUGINS=family-calendar,professional-crm` runs both.
2. Recreate the migrator and the servers so they read it: `docker compose up -d migrate api mcp` from `deploy/`, then `docker compose up -d --force-recreate --no-deps app`, so the operator GUI reaches the recreated REST core at once. Name the stack's other `-f` files in both. Recreating `app` signs everyone out of the GUI. The migrator makes the plugin's role, its schema and its login role `ob1_plugins_professional_crm`, and applies `001_professional_crm.sql`.
3. Check it:
   - preflight's `plugin tables` row says the role, schema and migrations are in place;
   - `GET /v1/whoami` lists the six reads for a read key, and all twelve tools for a write key;
   - your MCP client sees the same tools on the brain's own connector, with no new connector or key.

Remove the name from `OB1_PLUGINS` and recreate the same services to turn it off. Its tools and routes go, while its tables and rows stay and come back when it is turned on again.

## Moving from the standalone server

The standalone server kept its rows in `public.professional_contacts`, `public.contact_interactions` and `public.opportunities`. A plugin's migrations run as its own role in its own schema, and cannot adopt them. Neither dogfood brain held them. On a brain that does:

1. Turn the plugin on (above).
2. Copy the rows across as the database owner, in `psql`. It is one transaction, so a refused row copies nothing and the whole block can be run again. A row already copied is left as it is, so running it again later copies only what is new:

   ```sql
   \set ON_ERROR_STOP on
   BEGIN;
   INSERT INTO plugin_professional_crm.professional_contacts (id, user_id, name, company, title, email, phone, linkedin_url, how_we_met, tags, notes, last_contacted, follow_up_date, created_at, updated_at)
     SELECT c.id, c.user_id, btrim(c.name), nullif(btrim(c.company), ''), nullif(btrim(c.title), ''), nullif(btrim(c.email), ''), nullif(btrim(c.phone), ''),
            nullif(btrim(c.linkedin_url), ''), nullif(btrim(c.how_we_met), ''),
            -- Tags lower-case, each once, in the order first given.
            (SELECT coalesce(array_agg(t ORDER BY n), '{}') FROM (SELECT DISTINCT ON (lower(btrim(t))) lower(btrim(t)) AS t, n
                FROM unnest(coalesce(c.tags, '{}')) WITH ORDINALITY AS u(t, n) WHERE btrim(t) <> '' ORDER BY lower(btrim(t)), n) d),
            c.notes, c.last_contacted, c.follow_up_date, c.created_at, c.updated_at
       FROM public.professional_contacts c
   ON CONFLICT (id) DO NOTHING;
   INSERT INTO plugin_professional_crm.contact_interactions (id, contact_id, user_id, interaction_type, occurred_at, summary, follow_up_needed, follow_up_notes, created_at)
     SELECT id, contact_id, user_id, interaction_type, occurred_at, btrim(summary), coalesce(follow_up_needed, false), nullif(btrim(follow_up_notes), ''), created_at
       FROM public.contact_interactions
   ON CONFLICT (id) DO NOTHING;
   -- last_contacted the latest interaction, on every run: the old trigger set it to the one logged last, which may be older,
   -- and a run again may copy a contact's newer interactions.
   UPDATE plugin_professional_crm.professional_contacts c SET last_contacted = m.latest
     FROM (SELECT contact_id, max(occurred_at) AS latest FROM plugin_professional_crm.contact_interactions GROUP BY contact_id) m
    WHERE m.contact_id = c.id AND (c.last_contacted IS NULL OR m.latest > c.last_contacted);
   INSERT INTO plugin_professional_crm.opportunities (id, user_id, contact_id, title, description, stage, value, expected_close_date, notes, created_at, updated_at)
     SELECT id, user_id, contact_id, btrim(title), description, coalesce(stage, 'identified'), value, expected_close_date, notes, created_at, updated_at
       FROM public.opportunities
   ON CONFLICT (id) DO NOTHING;
   COMMIT;
   ```

   - **`user_id`.** Each row keeps its `user_id`, in the column the plugin keeps and ignores.
   - **`last_contacted`** is the latest interaction's time, or the old value if it was later; a run again moves it on for interactions copied then.
   - **An email or a LinkedIn URL** is copied as it was, even one the tools would refuse; change it with `update_contact`, or move it to the notes.
   - **Tags** are copied lower-case, each once in the order first given. A blank text field is copied as none.
   - **Linked thoughts.** The old link appended the thought's text to the notes and recorded nothing else. The notes come across with those lines, and the plugin's own list of linked thoughts starts empty.
   - **The old search's column and function** are not copied: the plugin searches word by word.
   - **job-hunt's link.** Until job-hunt is a plugin too (SMD-2311 PR 4b), its standalone server's link still writes contacts into `public.professional_contacts`. Run the block again to bring those across.
   - **A refused copy.** The plugin's tables check what the old ones did not:
     - a name or a title of 1 to 200 characters;
     - a summary of 1 to 5,000 characters;
     - a value of 0 or more.

     The old tables already checked the interaction types and stages. If a row breaks one of these, the copy names the check and nothing is copied. Fix that row in `public` and run the block again.
   - **Leftover tables.** Once the plugin's answers look right, and job-hunt is a plugin, the old tables can be dropped by hand.

## Troubleshooting

- **The server refuses to start: "OB1_PLUGINS names … which is no plugin in this build".** The running image predates the plugin. Pull or rebuild it.
- **Preflight's `plugin tables` row says the server "cannot log in as ob1_plugins_professional_crm".** `OB1_PLUGIN_DB_PASSWORD` is not the secret the role was made with. [The example plugin's troubleshooting](../example/README.md#troubleshooting) says how to set it back or change both.
- **`403 FORBIDDEN` with `needs: "write"`.** A read key cannot add, change, log or link. Over MCP, a read key's tool list has no write tools at all.
- **`NO_SUCH_THOUGHT` for a thought you can see.** The link reads the thought as the key that called it: a key that may not read thoughts cannot link one.
- **An agent cannot find someone it added.** `search_contacts` matches every word of the query; ask with fewer words, or part of the name.
