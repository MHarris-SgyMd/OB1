# Extension Generator Spec

This document is a machine-readable specification for generating a new Open Brain extension. An extension is a **guide** in `extensions/<slug>/` and a **plugin** in `plugins/<slug>/` that runs inside the brain's own servers (SMD-2311; this spec since SMD-3747). An AI agent given this spec and a description of the extension should be able to produce every file below in one pass.

Extensions are curated: a new one is discussed with the maintainers first ([extensions/README.md](../README.md), "Contributing"). [plugins/README.md](../../plugins/README.md) is the authority on what a plugin may do; where this spec and it differ, it wins.

## Output Files

| File | Start from | Purpose |
|------|------------|---------|
| `plugins/<slug>/index.ts` | `extensions/_template/plugin/index.ts` | The manifest: the plugin's operations, each an MCP tool and a REST route |
| `plugins/<slug>/migrations/001_<table>.sql` | `extensions/_template/plugin/migrations/001_entries.sql` | The plugin's tables, made in its own schema by the brain's migrator |
| `plugins/<slug>/README.md` | `extensions/_template/plugin/README.md` | The reference: each operation's input, output and refusals; turning it on; troubleshooting |
| `plugins/<slug>/metadata.json` | `extensions/_template/plugin/metadata.json` | `"category": "plugins"` |
| `plugins/registry.ts` | (edit) | Import the manifest and add it to `PLUGINS`; the server runs only plugins listed here |
| `extensions/<slug>/README.md` | `extensions/_template/README.md` | The guide: why, what you'll learn, turn it on, test prompts, what's next |
| `extensions/<slug>/metadata.json` | `extensions/_template/metadata.json` | `"category": "extensions"`, with `learning_order` |

Copy `extensions/_template/plugin/` to `plugins/<slug>/` whole, then shape it. The plugin needs no `package.json`: zod comes from the SDK. It needs no server, port, key list or connector of its own.

---

## File 1: plugins/<slug>/index.ts

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

Rules (plugins/README.md has them in full; the server refuses to start on the first group, check 31 fails a push on the second):

1. **Operations.** Each has a title, a description that says *when* an agent should call it (the agent reads it to choose a tool), a scope, a method and a path under the plugin's, an input and an output as zod shapes, and a handler. The MCP tool is named `<slug with _>_<key>`: no two may share a name, and none may take a core tool's.
2. **Inputs.** Every field has `.describe()`. A GET's or DELETE's fields ride the query string: text, a number, a boolean, or a list of text defaulted to `[]`. Anything else (an object, a nullable, a list of numbers) is a POST's or PATCH's body field. A path field is text.
3. **Answers.** A handler returns `ok(value)`, held to the output schema, or `refuse(status, CODE, facts)`: 400, 403, 404, 409 or 422, an `UPPER_CASE` code, and facts that say what to do next. An output declares only what the caller may see, and does not transform.
4. **Hints.** A read is read-only already. Mark a tool closed-world (`openWorldHint: false`) when it reaches the plugin's own tables alone, and an add `destructiveHint: false`.
5. **SQL.** A tagged template (`` sql`…` ``) inside `ctx.db.tx`, each `${value}` a bound parameter. Tables named bare, never with a schema. Named columns, never `*` or `RETURNING *` (check 41). No role, session, transaction or `search_path` change, no temp object, no advisory session lock.
6. **The brain's thoughts** are reached through `ctx.call(name, input)` alone, a core operation called as the caller behind the caller's scope ([plugins/example](../../plugins/example/) shows one). A row that names a thought holds its id; there are no foreign keys into the core.
7. **Imports and globals.** Import `server-portable/plugin-sdk.ts` and the plugin's own `.ts` files, nothing else. Name no global that reaches past `ctx`: `fetch`, `process`, `Bun`, `globalThis`, `eval`, `import()` and their kin.
8. **The user.** The brain is one operator's. Keep no `user_id` and scope no row by one: every key that may read sees every row.

---

## File 2: plugins/<slug>/migrations/001_<table>.sql

1. `CREATE TABLE IF NOT EXISTS`, and `CREATE INDEX IF NOT EXISTS` for the columns operations filter or order by.
2. Every table has `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` and `created_at timestamptz NOT NULL DEFAULT now()`. Put the input's limits in `CHECK`s too, so a row the operations would refuse cannot be stored.
3. Table names are the plugin's own: none may be a core table's (`jobs`, `pages`, `open_items` and the rest; check 31 names the clash).
4. No `DROP`, `TRUNCATE`, or `DELETE` without a `WHERE` (check 21). No `GRANT`, no row-level security, nothing from Supabase's `auth` schema (check 12): the plugin's own role owns its tables, and no other role needs them.
5. Never touch the core `thoughts` table.
6. A file once applied is never edited: a change is a new file, `002_….sql`.

---

## File 3: plugins/<slug>/README.md

From the template: what it does (its tables, then one table row per operation with its MCP tool, REST route, scope, input and output, then formats, searching, truncation, refusals and MCP hints), prerequisites, turning it on, and troubleshooting.

---

## Files 4 and 7: metadata.json

Both validate against `/.github/metadata.schema.json`.

- **The plugin's:** `"category": "plugins"`, `"tools": []` (it needs nothing installed), tags including `plugin`.
- **The guide's:** `"category": "extensions"`, `learning_order` its place in the path (1 to 6, curated), `"tools": []`.
- `services` lists external APIs beyond the brain's own Postgres and model provider (e.g., `["Gmail API"]`).
- Add `created` and `updated` dates (`YYYY-MM-DD`) when you write them.

---

## File 6: extensions/<slug>/README.md

From the template, every section kept: why it matters, the learning path, what it does (the plugin, its tables and its tools), what you'll learn, prerequisites, the three steps (turn on the plugin, check your AI sees it, test it with 3 to 5 prompts that exercise the tools), cross-extension integration, expected outcome, troubleshooting, next steps, and the link to [docs/05-tool-audit.md](../../docs/05-tool-audit.md), which the automated review checks for.

---

## Naming Conventions

| Thing | Pattern | Example |
|-------|---------|---------|
| Directories, `OB1_PLUGINS` name, manifest `name` | `{kebab-case}` | `job-hunt` |
| Schema, roles | `plugin_{snake}`, `ob1_plugin_{snake}` (made by the migrator) | `plugin_job_hunt` |
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
- [ ] `bun test-plugins.ts` in `server-portable/` passes, and the plugin's operations are driven over a real database in `server-portable/test-plugin-ports.ts` (a section per plugin, as the six have)
- [ ] Both `metadata.json` files validate against `/.github/metadata.schema.json`
- [ ] The guide's test prompts call every tool, and it links `docs/05-tool-audit.md`
- [ ] No credentials, API keys, or secrets in any file; no binary files over 1MB

---

## Example Prompt for AI Agent

> Create a new Open Brain extension called "Reading List" that tracks books, articles, and papers. Users should be able to add items with title, author, URL, status (to-read, reading, finished), notes, and a rating. Include operations for adding items, searching by title/author/status, changing an item's status, and getting stats on reading habits. Follow extensions/_template/AGENT_SPEC.md.

This prompt, combined with this spec, should produce every file above, ready for a PR.
