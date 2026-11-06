# Extension Generator Spec

This document is a machine-readable specification for generating a new extension. An extension is a **guide** in `extensions/<slug>/` and a **plugin** in `plugins/<slug>/` that runs inside the brain's own servers (SMD-2311; this spec since SMD-3747). An AI agent given this spec and a description of the extension should be able to produce every file below in one pass.

Extensions are curated: a new one is discussed with the maintainers first ([extensions/README.md](../README.md), "Contributing"). [plugins/README.md](../../plugins/README.md) is the authority on what a plugin may do; where this spec and it differ, it wins.

## Output Files

| File | Start from | Purpose |
|------|------------|---------|
| `plugins/<slug>/index.ts` | `extensions/_template/plugin/index.ts` | The manifest: the plugin's operations, each an MCP tool and a REST route |
| `plugins/<slug>/migrations/001_<table>.sql` | `extensions/_template/plugin/migrations/001_entries.sql` | The plugin's tables, made in its own schema by the brain's migrator |
| `plugins/<slug>/README.md` | `extensions/_template/plugin/README.md` | The reference: each operation's input, output and refusals; turning it on; troubleshooting |
| `plugins/<slug>/metadata.json` | `extensions/_template/plugin/metadata.json` | `"category": "plugins"` |
| `plugins/registry.ts` | (edit) | Import the manifest and add it to `PLUGINS`; the server runs only plugins listed here |
| `server-portable/test-plugin-ports.ts` | (edit) | The slug in `PORTED` and a section driving every operation over a real database |
| `extensions/<slug>/README.md` | `extensions/_template/README.md` | The guide: why, what you'll learn, turn it on, test prompts, what's next |
| `extensions/<slug>/metadata.json` | `extensions/_template/metadata.json` | `"category": "extensions"`, with `learning_order` |

Copy `extensions/_template/plugin/` to `plugins/<slug>/` whole, then shape it. The plugin needs no `package.json`: zod comes from the SDK. It needs no server, port, key list or connector of its own.

---

## plugins/<slug>/index.ts

The template's shape, kept:

```typescript
import { definePlugin, ok, operation, refuse, z } from "../../server-portable/plugin-sdk.ts";

export default definePlugin({
  name: "<slug>",            // the directory's name
  title: "Human-Readable Name",
  description: "What the plugin keeps and what an agent can ask of it.",
  operations: {
    add_thing: operation({
      title: "Add a thing",
      description: "When an agent should call it.",
      scope: "write",          // read, capture or write
      annotations: { destructiveHint: false, openWorldHint: false },
      method: "POST",
      path: "/things",
      input: { name: z.string().trim().min(1).max(200).describe("What it is") },
      output: { thing: Thing },
      async handler(ctx, { name }) {
        const [row] = await ctx.db.tx((sql) => sql<ThingRow>`
          INSERT INTO things (name) VALUES (${name}) RETURNING id, name, created_at`);
        return ok({ thing: asThing(row) });
      },
    }),
  },
});
```

Rules (plugins/README.md has them in full). Each says what holds it: the server, which refuses to start on a manifest that breaks it; check 31 or 41, which fail a push; or the maintainer's review alone.

1. **Operations.** Each has a title, a description that says *when* an agent should call it (the agent reads it to choose a tool), a scope, a method and a path under the plugin's, an input and an output as zod shapes, and a handler. *(Review; the server refuses a blank description.)* The MCP tool is named `<slug with _>_<key>`: no two may share a name, and none may take a core tool's. No two of a plugin's routes may match one request (`/items/{id}` beside `/items/latest`). *(The server.)*
2. **Inputs.** Every field has `.describe()`, which the agent reads. *(Review.)* A GET's or DELETE's fields ride the query string: text, a number, a boolean, or a list of text defaulted to `[]`. Anything else (an object, a nullable, a list of numbers) is a POST's or PATCH's body field. A path field is text. *(The server.)*
3. **Answers.** A handler returns `ok(value)`, held to the output schema, or `refuse(status, CODE, facts)`: 400, 403, 404, 409 or 422, an `UPPER_CASE` code, and facts that say what to do next. An output does not transform. *(The server: at start for the output, at the call for a refusal.)* An output declares only what the caller may see. *(Review.)*
4. **Hints.** A read is read-only already. Mark a tool closed-world (`openWorldHint: false`) when it reaches the plugin's own tables alone, an add `destructiveHint: false`, and a change that overwrites or a delete `destructiveHint: true` (job-hunt's updates are). *(Review.)*
5. **SQL.** A tagged template (`` sql`…` ``) inside `ctx.db.tx`, each `${value}` a bound parameter. Tables named bare, never with a schema. Named columns, never `SELECT *` or `RETURNING *` (check 41; `count(*)` is fine). No role, session, transaction or `search_path` change, no temp object, no advisory session lock (check 31). Postgres's `count()`, `sum()` and `avg()` come back as a bigint or numeric string: cast in SQL (`count(*)::int`, `avg(x)::float8`) to match a `z.number()` output, or the call fails at run time, as only a test over a real database shows.
6. **The brain's thoughts** are reached through `ctx.call(name, input)` alone, a core operation called as the caller behind the caller's scope ([plugins/example](../../plugins/example/) shows one). A row that names a thought holds its id; there are no foreign keys into the core. *(Review; check 31 refuses a core table's name in the plugin's SQL.)*
7. **Imports and globals.** Import `server-portable/plugin-sdk.ts` and the plugin's own `.ts` files, nothing else. Name no global that reaches past `ctx`: `fetch`, `process`, `Bun`, `globalThis`, `eval`, `import()` and their kin. *(Check 31.)*
8. **The user.** The brain is one operator's. Keep no `user_id` and scope no row by one: every key that may read sees every row. *(Review.)*
9. **A row that is a to-do** (a task, a reading-list item still to read) keeps an open item: the SDK's `keepRowItem(ctx, { row, text, due, owner?, done? })`, called after the plugin's own transaction commits, with an operation that keeps every row's at once (`sync_open_items`, as home-maintenance and family-calendar have). plugins/README.md, "Held by the maintainer's review", says how. *(Review.)*

---

## plugins/<slug>/migrations/001_<table>.sql

1. `CREATE TABLE IF NOT EXISTS`, and `CREATE INDEX IF NOT EXISTS` for the columns operations filter or order by.
2. Every table has `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` and `created_at timestamptz NOT NULL DEFAULT now()`. Put the input's limits in `CHECK`s too, so a row the operations would refuse cannot be stored.
3. Table names are the plugin's own: none may be a core table's (`jobs`, `pages`, `open_items` and the rest; check 31 names the clash).
4. No `DROP TABLE`, `DROP SCHEMA`, `TRUNCATE`, or `DELETE` without a `WHERE` (check 21). No row-level security and nothing from Supabase's `auth` schema or roles (check 12). No `GRANT` either (review): the plugin's own role owns its tables, and no other role needs them.
5. Never touch the core `thoughts` table.
6. A file once applied is never edited: a change is a new file, `002_….sql`.

---

## plugins/registry.ts

Import the manifest by name beside the others and add it to `PLUGINS`. The server runs only plugins listed here, and check 31 fails a push whose registry and `plugins/` directories disagree.

---

## plugins/<slug>/README.md

From the template: what it does (its tables, then one table row per operation with its MCP tool, REST route, scope, input and output, then formats, searching, truncation, refusals and MCP hints), prerequisites, turning it on, and troubleshooting.

---

## The two metadata.json files

Both validate against `/.github/metadata.schema.json`.

- **The plugin's:** `"category": "plugins"`, `"tools": []` (it needs nothing installed), tags including `plugin`.
- **The guide's:** `"category": "extensions"`, `learning_order` its place in the path, `"tools": []`. The path is six extensions, curated: a new one, once the maintainers agree, takes the next number, its row goes into every guide's "Learning Path" table, `extensions/README.md`'s table and `plugins/README.md`'s, and every guide's "Extension N of 6" heading counts it.
- `services` lists external APIs beyond the brain's own Postgres and model provider (e.g., `["Gmail API"]`).
- Add `created` and `updated` dates (`YYYY-MM-DD`) when you write them.

---

## extensions/<slug>/README.md

From the template, every section kept: why it matters, the learning path, what it does (the plugin, its tables and its tools), what you'll learn, prerequisites, the three steps (turn on the plugin, check your AI sees it, test it with 3 to 5 prompts that exercise the tools), cross-extension integration, expected outcome, troubleshooting, next steps, and the link to [docs/05-tool-audit.md](../../docs/05-tool-audit.md), which the review checks for.

---

## Naming Conventions

| Thing | Pattern | Example |
|-------|---------|---------|
| Directories, `OB1_PLUGINS` name, manifest `name` | `{kebab-case}` | `job-hunt` |
| Schema, roles | `plugin_{snake}`; `ob1_plugin_{snake}` and its login role `ob1_plugins_{snake}` (made by the migrator) | `plugin_job_hunt`, `ob1_plugin_job_hunt`, `ob1_plugins_job_hunt` |
| Table names | `{snake_case}` | `companies`, `job_postings` |
| Operation keys | `{snake_case}` | `add_company`, `search_job_contacts` |
| MCP tool | `{slug with _}_{key}` | `job_hunt_add_company` |
| REST route | `/v1/plugins/{slug}{path}` | `/v1/plugins/job-hunt/companies` |

---

## Validation Checklist

Before submitting, verify:

- [ ] `plugins/<slug>/index.ts`'s `name` is its directory's, and `plugins/registry.ts` imports it and lists it in `PLUGINS`
- [ ] Every operation's description says when to call it, and every input field has `.describe()`
- [ ] Its SQL names its columns and its own tables alone, bare; its migration uses `IF NOT EXISTS`, checks its limits, and does not touch `thoughts`
- [ ] `bun scripts/check-consistency.ts` passes (checks 31 and 41 read the plugin)
- [ ] `bunx tsc --noEmit` in `server-portable/` passes: it reaches each plugin through the registry, as CI's typecheck does
- [ ] `bun test-plugins.ts` in `server-portable/` passes (after `bun install` there and in `mcp-server/` and `rest-client/`)
- [ ] The slug is in `PORTED` in `server-portable/test-plugin-ports.ts`, which turns it on for the suite's migrator, and a section there drives every operation over a real database: its drift guard fails an operation of a `PORTED` plugin that no section calls. Run it with `../db/with-postgres.sh bun test-plugin-ports.ts` from `server-portable/` (it starts a throwaway Postgres in a container). Nothing fails a plugin left out of `PORTED`: review holds it
- [ ] Both `metadata.json` files validate against `/.github/metadata.schema.json`
- [ ] The guide's 3 to 5 test prompts exercise the tools, and it links `docs/05-tool-audit.md`
- [ ] No credentials, API keys, or secrets in any file; no binary files over 1MB

---

## Example Prompt for AI Agent

> Create a new Daemonic Brain extension called "Reading List" that tracks books, articles, and papers. Users should be able to add items with title, author, URL, status (to-read, reading, finished), notes, and a rating. Include operations for adding items, searching by title/author/status, changing an item's status, and getting stats on reading habits. Follow extensions/_template/AGENT_SPEC.md.

This prompt, combined with this spec, should produce every file above, ready for a PR.
