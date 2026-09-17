/**
 * compat/supabase-sql — a supabase-js-shaped client that speaks SQL.
 *
 * The problem this solves: 54 files outside the core server call PostgREST through
 * supabase-js, across 33,000 lines. Hand-porting them to SQL is weeks of work on
 * code that is mostly community recipes, and it would fork every one of them away
 * from upstream permanently.
 *
 * But the API surface they use is small and closed — under thirty methods, and
 * measurably so: `.from .select .insert .update .upsert .delete .rpc`, fourteen
 * filters, and seven modifiers (the README tables them). That is shimmable. With
 * this module a file migrates by changing one line:
 *
 *     - import { createClient } from "@supabase/supabase-js";
 *     + import { createClient } from "../../compat/supabase-sql/index.ts";
 *
 * and passing a Postgres URL where it passed a project URL. The rest of the file
 * is untouched, which keeps it mergeable from upstream.
 *
 * ── The catalog (SMD-1588, FORK.md change 76) ────────────────────────────────
 * PostgREST knows the schema; supabase-js callers lean on that without knowing
 * it. A JavaScript array in a payload is a `text[]` literal for one column and
 * a JSON array for the next (`tags TEXT[]` beside `instructions JSONB` in one
 * insert), `.contains()` is array containment on the first and jsonb
 * containment on the second, `.select("*, recipes:recipe_id (name)")` is a
 * join PostgREST finds through the foreign key, and a `text[]` argument to
 * `.rpc()` is an array literal because the function says so. Bun's driver
 * serialises a value by the type the server describes for the parameter, and
 * has no array-literal form: a JS array reaches a `text[]` column as its
 * `String()` — `a,b`, or `""` for `[]` — and is refused as malformed. Value
 * shape cannot decide any of these. So the shim reads the catalog the way
 * PostgREST does — a table's column types, its foreign keys in both directions,
 * a function's argument names and types — once per name per process, cached by
 * connection URL (the servers create a client per request), and renders from
 * that. Seven of the twenty-nine extension tools failed on these gaps when
 * change 74's review drove them; two more surfaced when every argument branch
 * was driven (a tag filter on a `text[]` column, an ingredient filter through
 * `.or()`'s `cs`). A schema change after the first query is not seen until the
 * process restarts — the same holds for PostgREST's own cache.
 *
 * ── Resource embedding, one hop ──────────────────────────────────────────────
 * `.select("*, maintenance_tasks ( id, name )")`, `"*, recipes:recipe_id (name)"`
 * and `"*, children(*)"` are served: the relation is a table with exactly one
 * foreign key to or from this one, or a foreign-key column of this table; a
 * many-to-one embed is an object (`null` when the key is), a one-to-many one an
 * array (`[]` when empty) — or the one row where the referencing columns are
 * unique, a one-to-one — keyed by the alias or the relation's name, as
 * PostgREST keys them. Refused, with a message saying which: a nested embed, an
 * embedding hint (`!inner`, `!fk_name`), a relation with no foreign key to this
 * table or with more than one (name the column: `alias:fk_column (…)`), and an
 * embed in a RETURNING list. The codemod's blockers refuse the two of these
 * it can see in a file's text — a nested embed, a hint; whether a relation has
 * one foreign key or two is the catalog's to say, at the first call. Silently
 * mishandling a join is the failure class this migration has been removing, so
 * nothing here guesses.
 *
 * Also unsupported, because nothing in the repo uses them: `.auth`, `.storage`,
 * `.channel`, `.functions.invoke`.
 *
 * ── JSON paths, and the shape of a row (SMD-1544, FORK.md change 73) ─────────
 * PostgREST's JSON-path column — `metadata->>generated_by`, `meta->a->>key` —
 * is accepted in the comparison filters, `is`, `in`, `match`, an `.or()` term
 * and `.order()`: rendered `"metadata"->>'key'`, the key a quoted literal, the
 * bound value cast to text, which is the text comparison PostgREST makes. Not
 * in `.contains()`, whose operator is the column's. A path ending in `->`
 * (jsonb), an array index (`->0`), and a path in a select list, a payload or a
 * conflict target are refused. Rows come back JSON-shaped as PostgREST's are in
 * the one respect a driven file needed: a timestamp is an ISO string, not
 * Bun's Date. The bio worker is the one shim-migrated file that filters on a
 * JSON path and the first whose code slices a timestamp; driven, it hit both —
 * a 500 at its first query, then at its prompt.
 *
 * ── Error convention ─────────────────────────────────────────────────────────
 * supabase-js resolves with `{ data, error }` and does not throw. This matches
 * that exactly, including on SQL errors, so existing `if (error)` branches keep
 * working; the error is a `PostgrestError`, an `Error` subclass as supabase-js's
 * is, so a file that does `if (error) throw error` hands its caller the message
 * rather than `[object Object]` (two extension tools did). Programming errors —
 * an invalid identifier, a nested embed — throw, because they are bugs in the
 * caller rather than runtime conditions.
 */

import { SQL } from "bun";

/** Postgres identifiers cannot be parameterised, so they are validated and quoted. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string, what: string): string {
  const trimmed = name.trim();
  if (!IDENT.test(trimmed)) {
    throw new Error(
      `compat/supabase-sql: refusing to interpolate ${what} "${name}". ` +
        `Identifiers must match ${IDENT} — values belong in filters, which are parameterised.`
    );
  }
  return `"${trimmed}"`;
}

const refusal = (what: string) => new Error(`compat/supabase-sql: ${what}`);

/**
 * A filter or ORDER BY column: a plain identifier, or PostgREST's JSON path —
 * `metadata->>generated_by`, `meta->nested->>level` — rendered with the column
 * quoted as an identifier and each key as a string literal
 * (`"metadata"->>'generated_by'`). A key is identifier-shaped, so nothing in
 * it needs escaping; it is quoted anyway. The path must end in `->>`, whose
 * result is text: the caller's bound value is then cast to text, which is the
 * comparison PostgREST makes (it renders the value as an unknown literal
 * against a text expression — `->>'score' >= '20'` is a text comparison there
 * too), and without the cast Bun binds a number as an integer and Postgres
 * has no `text >= integer`. A path ending in `->` yields jsonb, and what a
 * bound parameter means against it depends on the value's JavaScript type
 * (PostgREST reads it as JSON); refused, with `.contains()` named for
 * containment. An array index (`->0`) is not identifier-shaped and falls to
 * ident()'s refusal, as does a path anywhere but a comparison or an order: a
 * select list, a payload key, a conflict target, and `.contains()`, whose
 * operator is the column's (the file that wants containment under a key has
 * `.contains("meta", { key: … })`). SMD-1544 (FORK.md change
 * 73): the bio worker's source and profile queries filter on `metadata->>…`,
 * and ident()'s refusal was a 500 at the worker's first query on the fork.
 */
const JSON_PATH = /^([A-Za-z_][A-Za-z0-9_]*)((?:->>?[A-Za-z_][A-Za-z0-9_]*)+)$/;

function column(name: string): { sql: string; text: boolean } {
  const trimmed = name.trim();
  const m = JSON_PATH.exec(trimmed);
  if (!m) return { sql: ident(trimmed, "column"), text: false };
  const segments = m[2].match(/->>?[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const last = segments[segments.length - 1];
  if (!last.startsWith("->>") || segments.slice(0, -1).some((s) => s.startsWith("->>"))) {
    throw refusal(
      `refusing to interpolate column "${name}". A JSON path must end in ->> ` +
        `(the key's text): a path ending in -> yields jsonb, and what a bound value means against it ` +
        `depends on the value's JavaScript type. Use ->> to compare the text, or .contains() for containment.`
    );
  }
  return {
    sql: `"${m[1]}"` + segments.map((s) => (s.startsWith("->>") ? `->>'${s.slice(3)}'` : `->'${s.slice(2)}'`)).join(""),
    text: true,
  };
}

/**
 * PostgREST answers JSON, so a timestamp reaches a supabase-js caller as a
 * string; Bun.sql hands back a Date. A migrated file written for PostgREST
 * slices the string (`created_at.slice(0, 10)`, the bio worker's prompt), and
 * a Date's `.slice` is a 500. A Date with a finite time is rendered as
 * `toISOString()` gives it (`Z`, milliseconds) rather than Postgres's own
 * spelling (`+00:00`, microseconds), which PostgREST would give: both parse,
 * both slice to the same date, and a consumer comparing the spellings had a
 * bug on either client. The rule is timestamptz-shaped: a `date` or a
 * `timestamp without time zone` column is a Date to Bun too and arrives as a
 * `Z` instant (`2026-09-16T00:00:00.000Z` for a date) where PostgREST spells
 * `2026-09-16` and `2026-09-16T18:39:59.275494` — `.slice(0, 10)` agrees, an
 * equality against the bare date does not (change 73's rule; the `date` case
 * is closed below for a table's rows and a function's, the zone-less
 * timestamp's stays — no migrated file reads one).
 * Everything else stays as Bun returns it — ±Infinity for an infinite
 * timestamp, `Date(NaN)` for a BC date over a simple query (a parameterised
 * one hands a finite extended-year Date, which becomes
 * `-000043-03-15T00:00:00.000Z`; server-portable/store.ts's `isoTimestamp`
 * reads every one of these to the same result), numerics as text — nothing
 * driven has needed more. Change 76 has the column map in hand for a table
 * verb, and a `date` column's Date (UTC midnight, whatever the process's
 * zone) becomes the bare date PostgREST gives — `2026-09-21` — because five
 * extension tools read one (`week_start`, `follow_up_date`, `expected_close_
 * date`, `last_used`) and an embedded row already carried that spelling:
 * `row_to_json` builds it in the database, with Postgres's own spellings for
 * every type, which is what PostgREST gives for an embed too. A function's
 * rows take the map of its OUT columns (`RETURNS TABLE`), so the same
 * `follow_up_date` is one shape whichever path a tool takes.
 */
function jsonShaped(row: Record<string, unknown>, cols?: Columns): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(row)) {
    const type = cols?.get(k)?.type;
    const shaped = (d: Date, t: string | undefined) => (t === "date" || t === "date[]" ? d.toISOString().slice(0, 10) : d.toISOString());
    if (v instanceof Date && Number.isFinite(v.getTime())) {
      (out ??= { ...row })[k] = shaped(v, type);
    } else if (Array.isArray(v) && v.some((x) => x instanceof Date)) {
      // A date[] or timestamptz[] column: each element as the scalar column would be.
      (out ??= { ...row })[k] = v.map((x) => (x instanceof Date && Number.isFinite(x.getTime()) ? shaped(x, type) : x));
    } else if (cols?.get(k)?.category === "A" && ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      // Bun decodes an int[] column into an Int32Array, which JSON renders as {"0":1,"1":2}; PostgREST gives a list.
      // Only for an array column: a bytea column's Buffer is a view too and stays what Bun hands back.
      (out ??= { ...row })[k] = Array.from(v as unknown as ArrayLike<number>);
    }
  }
  return out ?? row;
}

/**
 * A JavaScript array as Postgres's array-literal text — `{"a","b"}`, `{}` —
 * for a column or argument the catalog says is an array. Bun serialises a JS
 * array parameter by the server-described type and has no literal form for
 * one: `["a","b"]` reaches a `text[]` column as `a,b`, `[]` as `""`, and
 * Postgres refuses both as malformed (22P02); an `int[]` fails in the wire
 * protocol itself. Elements are double-quoted with `\` and `"` escaped, so
 * a tag with a comma or a space survives; null is `NULL`, a nested array a
 * nested literal, an object its JSON (a `jsonb[]` column), a Date its ISO
 * instant. Bound with an explicit cast to the declared type.
 */
function arrayLiteral(values: unknown[]): string {
  const element = (x: unknown): string => {
    if (x === null || x === undefined) return "NULL";
    if (Array.isArray(x)) return arrayLiteral(x);
    const text = x instanceof Date ? x.toISOString() : typeof x === "object" ? JSON.stringify(x) : String(x);
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  };
  return `{${values.map(element).join(",")}}`;
}

// ── The catalog ──────────────────────────────────────────────────────────────

type ColumnInfo = { type: string; category: string };
type Columns = Map<string, ColumnInfo>;
type ForeignKey = { name: string; from: string; fromCols: string[]; to: string; toCols: string[]; unique: boolean };
type Overload = { names: string[]; types: string[]; categories: string[]; outs: Columns };
type CatalogStore = { columns: Map<string, Promise<Columns>>; absent: Map<string, Set<string>>; fks: Map<string, Promise<ForeignKey[]>>; fns: Map<string, Promise<Overload[]>> };

/** One store per connection URL: the extension servers create a client per request, and the schema does not change between them. */
const STORES = new Map<string, CatalogStore>();

/**
 * What PostgREST knows about the schema and a supabase-js caller leans on: a
 * table's column types (which of them are arrays, which jsonb), its foreign
 * keys in both directions, and a function's argument names and types. Each is
 * read once per name per process and shared across clients on the same URL;
 * a read that fails (the database unreachable) is not kept, so the next call
 * tries again. A table or function that does not exist reads as empty, and
 * the query that follows fails as it would have — 42P01, 42883 — resolved as
 * `{ error }`.
 */
class Catalog {
  private store: CatalogStore;

  constructor(private sql: SQL, url: string) {
    let store = STORES.get(url);
    if (!store) STORES.set(url, (store = { columns: new Map(), absent: new Map(), fks: new Map(), fns: new Map() }));
    this.store = store;
  }

  /**
   * One read per key, shared while it is in flight. A read that fails is
   * not kept. Nor is an EMPTY answer — a table that does not exist yet (a
   * server that took a request before its schema.sql was applied), a
   * function not yet created — because a process that cached "no columns"
   * would bind every array raw and route every `cs` to jsonb for its whole
   * life; the next call reads again, and finds the schema when it is there.
   */
  private memo<T extends { size: number } | unknown[]>(map: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
    let p = map.get(key);
    if (!p) {
      p = read();
      map.set(key, p);
      p.then((v) => { if ((Array.isArray(v) ? v.length : v.size) === 0) map.delete(key); }, () => map.delete(key));
    }
    return p;
  }

  /**
   * The table's columns — read again when the caller names one the cached map
   * lacks (`ALTER TABLE … ADD COLUMN tags text[]` under a running server: a
   * map from before the column would bind the array raw for the process's
   * life). A name the fresh read lacks either is the caller's mistake, and
   * Postgres says so (42703), or is a JSON path's base, which is a column;
   * it is remembered as absent, so a file filtering on a column its deployed
   * schema does not have costs one re-read, not one per call for the life of
   * the process (pass 2 measured 200 reads for 200 calls). A read that does
   * find new columns forgets the absent names, since the schema moved.
   */
  async columnsOf(table: string, expect: Iterable<string> = []): Promise<Columns> {
    let cols = await this.memo(this.store.columns, table, () => this.readColumns(table));
    const absent = this.store.absent.get(table) ?? new Set<string>();
    const missing = [...expect].filter((name) => cols.size > 0 && !cols.has(name) && !absent.has(name));
    if (missing.length) {
      this.store.columns.delete(table);
      const fresh = await this.memo(this.store.columns, table, () => this.readColumns(table));
      if (fresh.size > cols.size) absent.clear();
      cols = fresh;
      for (const name of missing) if (!cols.has(name)) absent.add(name);
      this.store.absent.set(table, absent);
    }
    return cols;
  }

  private readColumns(table: string): Promise<Columns> {
    return (async () => {
      const rows = (await this.sql.unsafe(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, t.typcategory AS category
           FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
          WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
        [ident(table, "table")] as never[]
      )) as unknown as { name: string; type: string; category: string }[];
      return new Map(rows.map((r) => [r.name, { type: r.type, category: r.category }]));
    })();
  }

  /**
   * Every foreign key this table takes part in, as the referencing and the
   * referenced side, by relation name — of tables the search path resolves,
   * so a name here is the one table `FROM "name"` will reach. A same-named
   * table in a schema behind the visible one is left out rather than counted
   * under the visible one's name (the silent wrong join this change exists
   * to avoid).
   */
  foreignKeysOf(table: string): Promise<ForeignKey[]> {
    return this.memo(this.store.fks, table, async () => {
      const rows = (await this.sql.unsafe(
        `SELECT c.conname AS name, f.relname AS "from", t.relname AS "to",
                (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS from_cols,
                (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS to_cols,
                EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
                          AND (SELECT array_agg(x.v ORDER BY x.v) FROM unnest(i.indkey::int2[]) WITH ORDINALITY x(v, ord) WHERE x.ord <= i.indnkeyatts)
                              = (SELECT array_agg(x ORDER BY x) FROM unnest(c.conkey) x)) AS "unique"
           FROM pg_constraint c JOIN pg_class f ON f.oid = c.conrelid JOIN pg_class t ON t.oid = c.confrelid
          WHERE c.contype = 'f' AND (c.conrelid = to_regclass($1) OR c.confrelid = to_regclass($1))
            AND pg_table_is_visible(f.oid) AND pg_table_is_visible(t.oid)`,
        [ident(table, "table")] as never[]
      )) as unknown as { name: string; from: string; to: string; from_cols: string[]; to_cols: string[]; unique: boolean }[];
      return rows.map((r) => ({ name: r.name, from: r.from, fromCols: r.from_cols, to: r.to, toCols: r.to_cols, unique: r.unique }));
    });
  }

  /**
   * Each overload of a function on the search path: its IN argument names,
   * declared types and type categories, in order — and its OUT columns (a
   * `RETURNS TABLE` function's, an OUT parameter's) as a column map, so the
   * rows a function answers are shaped as a table's are (a `date` column the
   * bare date): `crm_search_contacts` answers through a function on one path
   * and through the table on another, and PostgREST gives one shape.
   */
  argTypesOf(fn: string): Promise<Overload[]> {
    return this.memo(this.store.fns, fn, async () => {
      const rows = (await this.sql.unsafe(
        `SELECT p.proargnames::text[] AS names, p.proargmodes::text[] AS modes,
                (SELECT array_agg(format_type(u.t, NULL) ORDER BY u.ord) FROM unnest(p.proargtypes) WITH ORDINALITY u(t, ord)) AS types,
                (SELECT array_agg(y.typcategory::text ORDER BY u.ord) FROM unnest(p.proargtypes) WITH ORDINALITY u(t, ord) JOIN pg_type y ON y.oid = u.t) AS categories,
                (SELECT array_agg(format_type(u.t, NULL) ORDER BY u.ord) FROM unnest(p.proallargtypes) WITH ORDINALITY u(t, ord)) AS all_types,
                (SELECT array_agg(y.typcategory::text ORDER BY u.ord) FROM unnest(p.proallargtypes) WITH ORDINALITY u(t, ord) JOIN pg_type y ON y.oid = u.t) AS all_categories
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname = $1 AND n.nspname = ANY (current_schemas(true))`,
        [fn.trim()] as never[]
      )) as unknown as { names: string[] | null; modes: string[] | null; types: string[] | null; categories: string[] | null; all_types: string[] | null; all_categories: string[] | null }[];
      return rows.map((r) => {
        // proargnames covers OUT arguments too (a RETURNS TABLE function's columns); proargtypes only the IN ones;
        // proallargtypes every one, in proargnames' order, when any is OUT.
        const names = (r.names ?? []).filter((_, i) => !r.modes || ["i", "b", "v"].includes(r.modes[i]));
        const outs: Columns = new Map();
        (r.names ?? []).forEach((name, i) => {
          if (r.modes && ["o", "t", "b"].includes(r.modes[i]) && r.all_types?.[i]) outs.set(name, { type: r.all_types[i], category: r.all_categories?.[i] ?? "" });
        });
        return { names, types: r.types ?? [], categories: r.categories ?? [], outs };
      });
    });
  }
}

/**
 * The bound form of a value for a column or argument of a known type: a JS
 * array as an array literal with a cast where the type is an array; for a
 * `vector` argument, JSON text (`[1,0,0]`), which Postgres coerces where a
 * Postgres array literal is not valid vector input — the shape `.rpc()`
 * always sent an embedding in; everything else as it is (an object or an
 * array for a `jsonb` column is serialised by the driver correctly, and MUST
 * NOT be pre-stringified — Bun binds a JS string to jsonb as a JSON scalar
 * string, the double-encoding trap db/migrations/005 rejects at the database).
 */
function bound(info: ColumnInfo | undefined, v: unknown): { value: unknown; cast: string } {
  // By the type's category, not its name: a domain over `text[]` is category A under its own name.
  if (Array.isArray(v) && info?.category === "A") return { value: arrayLiteral(v), cast: `::${info.type}` };
  // `vector` for an argument; `vector(1536)` for a column (format_type carries the typmod).
  if (Array.isArray(v) && /^vector(\(\d+\))?$/.test(info?.type ?? "")) return { value: JSON.stringify(v), cast: "" };
  return { value: v, cast: "" };
}

/**
 * Normalise a Bun.sql error into the shape supabase-js callers expect.
 *
 * Bun reports the Postgres SQLSTATE in `errno` and puts a generic
 * "ERR_POSTGRES_SERVER_ERROR" in `code`. PostgREST puts the SQLSTATE in `code`,
 * and recipes branch on it — `error.code === "23505"` for a duplicate key is a
 * common pattern. Map it across, or every one of those branches silently stops
 * matching. The result extends `Error`, as supabase-js's `PostgrestError`
 * does: a file that does `if (error) throw error` hands the MCP SDK (or any
 * caller) an `Error` whose message is the database's, where a plain object
 * rendered as `[object Object]` and hid every real message.
 */
export class PostgrestError extends Error {
  code?: string;
  details?: string;
  hint?: string;
  constructor(message: string, fields: { code?: string; details?: string; hint?: string } = {}) {
    super(message);
    this.name = "PostgrestError";
    if (fields.code !== undefined) this.code = fields.code;
    if (fields.details !== undefined) this.details = fields.details;
    if (fields.hint !== undefined) this.hint = fields.hint;
  }
}

function toPostgrestError(e: unknown): PostgrestError {
  const err = e as { message?: string; code?: string; errno?: string | number; detail?: string; hint?: string };
  const sqlstate = err?.errno !== undefined ? String(err.errno) : undefined;
  return new PostgrestError(err?.message ?? String(e), {
    // Prefer the SQLSTATE; fall back to Bun's marker when there is no server error.
    code: /^[0-9A-Z]{5}$/.test(sqlstate ?? "") ? sqlstate : err?.code,
    details: err?.detail,
    hint: err?.hint,
  });
}

/** A caller bug — a bad identifier, a nested embed — thrown by the shim itself, not a database condition. */
const isRefusal = (e: unknown) => e instanceof Error && e.message.startsWith("compat/supabase-sql:");

// ── The select list ──────────────────────────────────────────────────────────

type SelectItem =
  | { kind: "star" }
  | { kind: "column"; sql: string }
  | { kind: "embed"; key: string; relation: string; cols: string[] | "*" };

/**
 * PostgREST's select list: `*`, columns, and one hop of resource embedding —
 * `relation (cols)`, `alias:relation (cols)`, `relation(*)` — the relation
 * being a table or a foreign-key column of this one, whitespace anywhere
 * (`maintenance_tasks (\n id,\n name\n )` is the tree's spelling). What is
 * refused is refused here, at the call, as a programming error: a nested
 * embed, an embedding hint (`!inner`, `!fk_name`, which choose a join or a
 * key the shim would otherwise have to guess), a cast or a JSON path in the
 * list (ident() refuses those, as before).
 */
function parseSelect(spec: string): SelectItem[] {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "*") return [{ kind: "star" }];
  if (/\([^()]*\(/.test(trimmed)) throw refusal(`select("${spec}") nests one resource embedding inside another, which is not supported — one hop is; write the deeper join as an .rpc() or a SQL view.`);
  if (/!/.test(trimmed)) throw refusal(`select("${spec}") uses a PostgREST embedding hint (!inner, !fk_name), which is not supported — name the foreign-key column instead: alias:fk_column (…).`);
  // Split on the commas outside parentheses.
  const items: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { items.push(trimmed.slice(start, i)); start = i + 1; }
  }
  items.push(trimmed.slice(start));
  return items.map((raw): SelectItem => {
    const item = raw.trim();
    if (item === "*") return { kind: "star" };
    const embed = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([A-Za-z_][A-Za-z0-9_]*))?\s*\(([^()]*)\)$/.exec(item);
    if (embed) {
      const [, first, second, inner] = embed;
      const cols = inner.trim() === "*" ? "*" : inner.split(",").map((c) => c.trim()).filter(Boolean);
      if (cols !== "*") for (const c of cols) ident(c, "embedded column");
      if (cols !== "*" && cols.length === 0) throw refusal(`select("${spec}") embeds "${first}" with no columns — name them, or (*).`);
      return second ? { kind: "embed", key: first, relation: second, cols } : { kind: "embed", key: first, relation: first, cols };
    }
    if (/\(|\)/.test(item)) throw refusal(`select("${spec}"): "${item}" is not a column or a one-hop embed (relation (cols) or alias:relation (cols)).`);
    return { kind: "column", sql: ident(item, "column") };
  });
}

type Filter = (cols: Columns) => { sql: string; values: unknown[] };
type Op = "select" | "insert" | "update" | "upsert" | "delete";

export type Result<T> = { data: T | null; error: { message: string; code?: string } | null; count: number | null };

export class QueryBuilder<T = Record<string, unknown>[]> implements PromiseLike<Result<T>> {
  private op: Op = "select";
  private items: SelectItem[] = [{ kind: "star" }];
  private filters: Filter[] = [];
  private orderBy: string[] = [];
  private limitN: number | null = null;
  private offsetN: number | null = null;
  private payload: Record<string, unknown>[] = [];
  private conflictTarget: string | null = null;
  private wantCount: "exact" | null = null;
  private headOnly = false;
  private rowMode: "many" | "single" | "maybeSingle" = "many";
  /** The columns the filters, the order and the payload name — what the catalog's map must know (see columnsOf). */
  private named = new Set<string>();

  constructor(private sql: SQL, private catalog: Catalog, private table: string) {}

  private names(col: string): void {
    const base = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(col.trim())?.[1];
    if (base) this.named.add(base);
  }

  // ── verbs ──────────────────────────────────────────────────────────────────

  select(cols = "*", opts?: { count?: "exact" | "planned" | "estimated"; head?: boolean }): this {
    // `.select()` after insert/update/delete means RETURNING, not a new query.
    if (this.op === "select") this.op = "select";
    this.items = parseSelect(cols);
    if (opts?.count) this.wantCount = "exact";
    if (opts?.head) this.headOnly = true;
    return this;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]): this {
    this.op = "insert";
    this.payload = Array.isArray(values) ? values : [values];
    return this;
  }

  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string }
  ): this {
    this.op = "upsert";
    this.payload = Array.isArray(values) ? values : [values];
    this.conflictTarget = opts?.onConflict ?? null;
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.op = "update";
    this.payload = [values];
    return this;
  }

  delete(): this {
    this.op = "delete";
    return this;
  }

  // ── filters ────────────────────────────────────────────────────────────────

  private static readonly CMP: Record<string, string> = {
    eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", ilike: "ILIKE",
  };

  /**
   * One PostgREST filter term, `column.operator.value`, as a clause — rendered
   * when the query compiles, because `cs` (containment) is the column's
   * operator: `@>` on a `text[]` column with an array literal, `@>` on a jsonb
   * one with the value bound as an object (never a pre-stringified one — Bun
   * binds a JS string to a jsonb parameter as a JSON scalar string, so
   * `object @> string` is always false with no error; the same trap
   * db/migrations/005 rejects). `negate` is `.not()`'s: `IS NOT` for `is`, and
   * `NOT (…)` around everything else, which is how PostgREST renders
   * `not.eq.1` too (`NOT (x = 1)`, not `x <> 1` — they differ on NULL).
   */
  private term(col: string, operator: string, value: unknown, negate = false): Filter {
    this.names(col);
    const not = (sql: string) => (negate ? `NOT (${sql})` : sql);
    if (operator === "is") {
      const lit = value === null || value === "null" ? "NULL" : value === true || value === "true" ? "TRUE" : value === false || value === "false" ? "FALSE" : null;
      if (lit === null) throw refusal(`is(${String(value)}) must be null, true or false`);
      const c = column(col);
      return () => ({ sql: `${c.sql} IS ${negate ? "NOT " : ""}${lit}`, values: [] });
    }
    if (operator === "in") {
      if (!Array.isArray(value)) throw refusal(`in() takes an array of values`);
      if (value.length === 0) {
        // Matches PostgREST: in.() selects nothing, and its negation selects every row whose column is not NULL
        // (`NOT (x = ANY('{}'))` is NULL for a NULL x). The column is not read for the positive form.
        return () => ({ sql: negate ? `${column(col).sql} IS NOT NULL` : "FALSE", values: [] });
      }
      const c = column(col);
      return (cols) => {
        const b = value.map((v) => bound(cols.get(col.trim()), v));
        return { sql: not(`${c.sql} IN (${b.map((x) => (c.text ? "?::text" : `?${x.cast}`)).join(", ")})`), values: b.map((x) => x.value) };
      };
    }
    if (operator === "cs") {
      const c = ident(col, "column");
      return (cols) => {
        const info = cols.get(col.trim());
        if (info?.category === "A") {
          // An array column: the caller's array, or the literal text PostgREST's `cs.{a,b}` carries.
          const v = Array.isArray(value) ? arrayLiteral(value) : value;
          return { sql: not(`${c} @> ?::${info.type}`), values: [v] };
        }
        // jsonb: an object or array is bound as such; `.or()`'s text is parsed to one first (a string would be a JSON scalar).
        let v = value;
        if (typeof value === "string") {
          try { v = JSON.parse(value); } catch { throw refusal(`cs.${value} is not JSON, and "${col}" is not an array column`); }
        }
        return { sql: not(`${c} @> ?::jsonb`), values: [v] };
      };
    }
    const sqlOp = QueryBuilder.CMP[operator];
    if (!sqlOp) throw refusal(`operator "${operator}" is not supported`);
    const c = column(col);
    // A JS array against an array column (`eq.{a,b}` in PostgREST) is the literal too — the same binding the payloads get.
    return (cols) => {
      const b = bound(cols.get(col.trim()), value);
      return { sql: not(`${c.sql} ${sqlOp} ${c.text ? "?::text" : `?${b.cast}`}`), values: [b.value] };
    };
  }

  private where(f: Filter): this { this.filters.push(f); return this; }

  eq(c: string, v: unknown) { return this.where(this.term(c, "eq", v)); }
  neq(c: string, v: unknown) { return this.where(this.term(c, "neq", v)); }
  gt(c: string, v: unknown) { return this.where(this.term(c, "gt", v)); }
  gte(c: string, v: unknown) { return this.where(this.term(c, "gte", v)); }
  lt(c: string, v: unknown) { return this.where(this.term(c, "lt", v)); }
  lte(c: string, v: unknown) { return this.where(this.term(c, "lte", v)); }
  like(c: string, v: string) { return this.where(this.term(c, "like", v)); }
  ilike(c: string, v: string) { return this.where(this.term(c, "ilike", v)); }
  is(c: string, v: null | boolean) { return this.where(this.term(c, "is", v)); }
  in(c: string, values: unknown[]) { return this.where(this.term(c, "in", values)); }

  /**
   * Containment — PostgREST's `.contains()` is `@>` with the column's own
   * operator: array containment on a `text[]` column (`tags @> '{"ai"}'`), jsonb
   * containment on a jsonb one (`metadata @> '{"k": 1}'`). Which, the catalog
   * says at compile time; the tree has both (`recipes.tags`, `thoughts.metadata`).
   */
  contains(c: string, v: Record<string, unknown> | unknown[] | string) { return this.where(this.term(c, "cs", v)); }

  /**
   * PostgREST's `.not(column, operator, value)` — the negation of the named
   * filter: `not("next_due", "is", null)` is `next_due IS NOT NULL`; the other
   * operators are wrapped in `NOT (…)`. The two calls in the tree are both
   * `is` null (SMD-1588; the method did not exist, and two tools answered
   * `.not is not a function`).
   */
  not(c: string, operator: string, v: unknown) { return this.where(this.term(c, operator, v, true)); }

  /**
   * PostgREST's `.or("a.gt.1,b.is.null")` — a flat list of `column.op.value`
   * terms combined with OR; `cs` among the operators (`ingredients.cs.[{"name":"x"}]`).
   *
   * Read as PostgREST reads it, term by term: a column (a name or a JSON
   * path) up to the first dot, an operator up to the next, then a value —
   * a balanced `[…]` or `{…}` group when it starts with one (a `cs` value's
   * JSON or array literal, brackets and quotes inside it belonging to it), a
   * double-quoted string when it starts with `"` (PostgREST's quoting), or
   * plain text up to the next comma. Plain text is split at a comma and
   * nothing else — a quote, a parenthesis or a bracket in an ILIKE pattern
   * is pattern text (four tools interpolate user text into their expression:
   * `name.ilike.%${query}%,…`), and a plain comma in that text splits a term
   * PostgREST cannot parse either. That term, and a group nothing closes,
   * resolve as `{ error }` with PostgREST's `PGRST100` at execution — the
   * tool's own error handling sees it — while the terms that did parse stay
   * parameterised. Only the flat form is supported: a term that is itself
   * `and(…)`/`or(…)`/`not.and(…)` grouping, which needs a real parser, is a
   * programming error in the file's own text and throws at the call (the
   * words "and (" inside a value are text). Every `.or()` in the tree is flat.
   */
  or(expression: string): this {
    type Term = { col: string; op: string; value: string } | { broken: string };
    const terms: Term[] = [];
    let i = 0;
    const n = expression.length;
    while (i <= n) {
      const termStart = i;
      const firstDot = expression.indexOf(".", i);
      const head = expression.slice(i, firstDot < 0 ? n : firstDot).trim();
      if (/^(?:not\.)?(?:and|or)\s*\(/.test(expression.slice(i).trimStart())) {
        throw refusal(
          `or("${expression}") uses nested and()/or() grouping, ` +
            `which is not supported. Express it as an .rpc() or split the query.`
        );
      }
      const secondDot = firstDot < 0 ? -1 : expression.indexOf(".", firstDot + 1);
      // A term is `column.op.value`, the column a name or a JSON path. Anything else here is what a comma in a
      // previous plain value left behind (` Salt%,category` — user text) — the broken term, up to the next comma.
      if (firstDot < 0 || secondDot < 0 || !/^[A-Za-z_][A-Za-z0-9_]*(?:->>?[A-Za-z_][A-Za-z0-9_]*)*$/.test(head)) {
        const stop = expression.indexOf(",", i);
        terms.push({ broken: expression.slice(termStart, stop < 0 ? n : stop).trim() });
        i = stop < 0 ? n + 1 : stop + 1;
        continue;
      }
      const col = head;
      const op = expression.slice(firstDot + 1, secondDot).trim();
      let j = secondDot + 1;
      let value: string;
      const open = expression[j];
      if (open === "[" || open === "{") {
        // A balanced group: brackets and braces nest, a double-quoted string inside it may hold anything.
        let depth = 0, quoted = false, k = j;
        for (; k < n; k++) {
          const ch = expression[k];
          if (quoted) { if (ch === "\\") k++; else if (ch === '"') quoted = false; continue; }
          if (ch === '"') quoted = true;
          else if (ch === "[" || ch === "{") depth++;
          else if (ch === "]" || ch === "}") { depth--; if (depth === 0) { k++; break; } }
        }
        if (depth !== 0) { terms.push({ broken: expression.slice(termStart).trim() }); break; }
        value = expression.slice(j, k);
        j = k;
      } else if (open === '"') {
        // PostgREST's quoted value: to the closing quote, a backslash escaping the next character.
        let k = j + 1;
        for (; k < n && expression[k] !== '"'; k++) if (expression[k] === "\\") k++;
        if (k >= n) { terms.push({ broken: expression.slice(termStart).trim() }); break; }
        value = expression.slice(j + 1, k).replace(/\\(.)/g, "$1");
        j = k + 1;
      } else {
        const stop = expression.indexOf(",", j);
        value = expression.slice(j, stop < 0 ? n : stop);
        j = stop < 0 ? n : stop;
      }
      // After a group or a quoted value only a comma or the end may follow.
      const rest = expression.slice(j).match(/^\s*(,|$)/);
      if (!rest) { const stop = expression.indexOf(",", j); terms.push({ broken: expression.slice(termStart, stop < 0 ? n : stop).trim() }); i = stop < 0 ? n + 1 : stop + 1; continue; }
      terms.push({ col, op, value });
      i = j + rest[0].length + (rest[1] === "," ? 0 : 1);
      if (rest[1] !== ",") break;
    }
    const filters = terms.map((t): Filter => {
      if ("broken" in t) {
        // PostgREST answers 400 to a term it cannot parse; so does this, at execution, as { error } — never a throw
        // out of a tool's handler for text a user typed.
        return () => { throw new PostgrestError(`PGRST100: "${t.broken}" is not column.operator.value in or("${expression}") — a comma or an unclosed group in a value; PostgREST answers 400 here too`, { code: "PGRST100" }); };
      }
      if (t.op === "in") throw refusal(`or() operator "in" is not supported`);
      return this.term(t.col, t.op, t.value);
    });
    return this.where((cols) => {
      const rendered = filters.map((f) => f(cols));
      return { sql: `(${rendered.map((r) => r.sql).join(" OR ")})`, values: rendered.flatMap((r) => r.values) };
    });
  }

  /** Equality across several columns at once. */
  match(criteria: Record<string, unknown>): this {
    for (const [c, v] of Object.entries(criteria)) this.eq(c, v);
    return this;
  }

  // ── modifiers ──────────────────────────────────────────────────────────────

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.names(col);
    const dir = opts?.ascending === false ? "DESC" : "ASC";
    const nulls = opts?.nullsFirst === undefined ? "" : opts.nullsFirst ? " NULLS FIRST" : " NULLS LAST";
    this.orderBy.push(`${column(col).sql} ${dir}${nulls}`);
    return this;
  }

  limit(n: number): this { this.limitN = n; return this; }

  /** PostgREST's range is inclusive on both ends. */
  range(from: number, to: number): this {
    this.offsetN = from;
    this.limitN = to - from + 1;
    return this;
  }

  single(): this { this.rowMode = "single"; return this; }
  maybeSingle(): this { this.rowMode = "maybeSingle"; return this; }

  // ── compilation ────────────────────────────────────────────────────────────

  private whereClause(cols: Columns, startAt: number): { text: string; values: unknown[] } {
    if (this.filters.length === 0) return { text: "", values: [] };
    const values: unknown[] = [];
    let i = startAt;
    const clauses = this.filters.map((f) => {
      const r = f(cols);
      values.push(...r.values);
      return r.sql.replace(/\?/g, () => `$${++i}`);
    });
    return { text: ` WHERE ${clauses.join(" AND ")}`, values };
  }

  /**
   * One embed as a correlated subquery. The relation is a foreign-key column of
   * this table (`recipes:recipe_id (…)`: many-to-one through that key), or a
   * table with exactly one foreign key between the two, in either direction —
   * this table's key to it is many-to-one, its key to this table one-to-many.
   * Many-to-one is `row_to_json` of the one row (NULL when the key is), keyed
   * as the alias; one-to-many is `json_agg` of the rows, `[]` when there are
   * none — unless the referencing columns carry a unique index, a one-to-one,
   * which is the one row again — PostgREST's shapes. The embedded table is aliased `__e` so a
   * self-reference still names the outer row by the table's own name.
   */
  private async embed(item: Extract<SelectItem, { kind: "embed" }>, cols: Columns): Promise<string> {
    const base = this.table.trim();
    const fks = await this.catalog.foreignKeysOf(base);
    let fk: ForeignKey, manyToOne: boolean;
    if (cols.has(item.relation)) {
      const via = fks.filter((f) => f.from === base && f.fromCols.length === 1 && f.fromCols[0] === item.relation);
      if (via.length !== 1) throw refusal(`select embeds "${item.relation}", a column of "${base}" that is not a single-column foreign key.`);
      fk = via[0]; manyToOne = true;
    } else {
      const out = fks.filter((f) => f.from === base && f.to === item.relation);
      const back = fks.filter((f) => f.to === base && f.from === item.relation && f.from !== f.to);
      const self = fks.filter((f) => f.from === base && f.to === base && item.relation === base);
      if (self.length) throw refusal(`select embeds "${item.relation}" in itself — which side is meant is not decidable from the table's name; name the column: alias:fk_column (…).`);
      if (out.length + back.length === 0) throw refusal(`select embeds "${item.relation}", and no foreign key joins it to "${base}" (or the table is off the search path).`);
      if (out.length + back.length > 1) throw refusal(`select embeds "${item.relation}", and more than one foreign key joins it to "${base}" — name the column: alias:fk_column (…).`);
      manyToOne = out.length === 1;
      fk = out[0] ?? back[0];
    }
    // A one-to-many whose referencing columns are unique is a one-to-one: PostgREST gives the one row, or null.
    const oneRow = manyToOne || fk.unique;
    const target = ident(manyToOne ? fk.to : fk.from, "table");
    const pairs = (manyToOne ? fk.toCols : fk.fromCols).map((c, i) =>
      `__e.${ident(c, "column")} = ${ident(base, "table")}.${ident((manyToOne ? fk.fromCols : fk.toCols)[i], "column")}`);
    const projection = item.cols === "*" ? "__e.*" : item.cols.map((c) => `__e.${ident(c, "column")}`).join(", ");
    const rows = `SELECT ${projection} FROM ${target} AS __e WHERE ${pairs.join(" AND ")}`;
    const value = oneRow
      ? `(SELECT row_to_json(__r) FROM (${rows}) __r)`
      : `COALESCE((SELECT json_agg(__r) FROM (${rows}) __r), '[]'::json)`;
    return `${value} AS ${ident(item.key, "embed alias")}`;
  }

  private async projection(cols: Columns, returning: boolean): Promise<string> {
    const parts: string[] = [];
    for (const item of this.items) {
      if (item.kind === "star") parts.push("*");
      else if (item.kind === "column") parts.push(item.sql);
      // A table the catalog cannot see has no keys to embed through: the embed is left out so the query itself
      // reports the missing table (42P01, as `{ error }`) rather than a refusal naming a foreign key.
      else if (cols.size === 0) continue;
      else if (returning) throw refusal(`select("…${item.key}(…)") embeds a relation in a RETURNING list, which is not supported — read the row back with a second select.`);
      else parts.push(await this.embed(item, cols));
    }
    return parts.join(", ") || "*";
  }

  private async compile(): Promise<{ text: string; values: unknown[]; cols: Columns }> {
    const table = this.table.trim();
    const t = ident(table, "table");
    for (const row of this.payload) for (const c of Object.keys(row)) this.names(c);
    const cols = await this.catalog.columnsOf(table, this.named);

    if (this.op === "select") {
      const projection = this.headOnly && this.wantCount ? "count(*)::int AS __count" : await this.projection(cols, false);
      const where = this.whereClause(cols, 0);
      let text = `SELECT ${projection} FROM ${t}${where.text}`;
      if (!this.headOnly) {
        if (this.orderBy.length) text += ` ORDER BY ${this.orderBy.join(", ")}`;
        if (this.limitN !== null) text += ` LIMIT ${Number(this.limitN)}`;
        if (this.offsetN !== null) text += ` OFFSET ${Number(this.offsetN)}`;
      }
      return { text, values: where.values, cols };
    }

    const returning = await this.projection(cols, true);
    // A value bound by its column's type: an array column takes an array literal with a cast (change 76).
    const bind = (c: string, v: unknown, values: unknown[]): string => {
      const b = bound(cols.get(c), v);
      values.push(b.value);
      return `$${values.length}${b.cast}`;
    };

    if (this.op === "insert" || this.op === "upsert") {
      // Union of keys across rows, so a heterogeneous batch still inserts.
      const names = [...new Set(this.payload.flatMap((r) => Object.keys(r)))];
      if (names.length === 0) throw refusal("insert() called with no columns");
      const quoted = names.map((c) => ident(c, "column"));
      const values: unknown[] = [];
      const tuples = this.payload.map((row) => `(${names.map((c) => bind(c, row[c] ?? null, values)).join(", ")})`);
      let text = `INSERT INTO ${t} (${quoted.join(", ")}) VALUES ${tuples.join(", ")}`;
      if (this.op === "upsert") {
        const target = this.conflictTarget
          ? this.conflictTarget.split(",").map((c) => ident(c, "conflict column")).join(", ")
          : quoted[0];
        const sets = quoted.filter((c) => c !== `"${this.conflictTarget}"`).map((c) => `${c} = EXCLUDED.${c}`);
        text += ` ON CONFLICT (${target}) DO ${sets.length ? `UPDATE SET ${sets.join(", ")}` : "NOTHING"}`;
      }
      text += ` RETURNING ${returning}`;
      return { text, values, cols };
    }

    if (this.op === "update") {
      const row = this.payload[0] ?? {};
      const names = Object.keys(row);
      if (names.length === 0) throw refusal("update() called with no columns");
      const values: unknown[] = [];
      const sets = names.map((c) => `${ident(c, "column")} = ${bind(c, row[c], values)}`);
      const where = this.whereClause(cols, values.length);
      return {
        text: `UPDATE ${t} SET ${sets.join(", ")}${where.text} RETURNING ${returning}`,
        values: [...values, ...where.values],
        cols,
      };
    }

    const where = this.whereClause(cols, 0);
    return { text: `DELETE FROM ${t}${where.text} RETURNING ${returning}`, values: where.values, cols };
  }

  /** Exposed for tests and for anyone debugging what the shim generates. Reads the catalog, so it is a promise (change 76). */
  async toSQL(): Promise<{ text: string; values: unknown[] }> {
    const { text, values } = await this.compile();
    return { text, values };
  }

  /**
   * Runs the query. May reject: a caller bug (bad identifier, nested embed, no
   * foreign key for an embed) rejects, while a runtime failure — a SQL error,
   * the database unreachable, in the query or in the catalog read before it —
   * resolves as `{ error }` the way supabase-js does.
   */
  private async execute(): Promise<Result<T>> {
    try {
      const { text, values, cols } = await this.compile();
      const rows = ((await this.sql.unsafe(text, values as never[])) as unknown as Record<string, unknown>[]).map((r) => jsonShaped(r, cols));

      if (this.headOnly && this.wantCount) {
        return { data: null, error: null, count: Number(rows[0]?.__count ?? 0) };
      }
      if (this.rowMode !== "many") {
        if (rows.length === 0) {
          return this.rowMode === "single"
            ? { data: null, error: new PostgrestError("JSON object requested, multiple (or no) rows returned", { code: "PGRST116" }), count: null }
            : { data: null, error: null, count: null };
        }
        return { data: rows[0] as T, error: null, count: null };
      }
      return { data: rows as T, error: null, count: this.wantCount ? rows.length : null };
    } catch (e) {
      if (isRefusal(e)) throw e;
      return { data: null, error: toPostgrestError(e), count: null };
    }
  }

  /**
   * Delegates to a real promise rather than doing the work inline.
   *
   * A custom `then` that throws does NOT reject the awaiting promise: `await`
   * calls `then(onfulfilled, onrejected)` and only reacts to those callbacks, so a
   * throw escapes as an unhandled rejection that no try/catch around the await can
   * see. Returning `execute().then(...)` routes both outcomes correctly.
   */
  then<R1 = Result<T>, R2 = never>(
    onfulfilled?: ((v: Result<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((r: unknown) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  catch<R = never>(onrejected?: ((r: unknown) => R | PromiseLike<R>) | null): Promise<Result<T> | R> {
    return this.execute().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<Result<T>> {
    return this.execute().finally(onfinally);
  }
}

/**
 * One pool per connection URL, shared by every client made for it. The
 * vendored servers call `createClient` inside each request handler — a
 * Supabase Edge Function's shape, where an invocation is short-lived and its
 * client dies with it — and never close it. Under Bun the process lives on
 * (change 74), and a pool per request held its connection open for the life
 * of the process: the tool suite's eighty-odd calls left 84 connections
 * open against Postgres's default limit of 100, so a server would have been
 * refused after about ninety-five tool calls. Clients on one URL now share a
 * pool (the first client's `max` sizes it), counted, and the pool closes when
 * the last client that will close does; a server that never closes holds one
 * pool, not one per request.
 */
const POOLS = new Map<string, { sql: SQL; clients: number }>();

export class SupabaseSqlClient {
  readonly sql: SQL;
  private catalog: Catalog;
  private pool: { sql: SQL; clients: number };
  private closed = false;

  constructor(private databaseUrl: string, opts: { max?: number } = {}) {
    let pool = POOLS.get(databaseUrl);
    if (!pool) POOLS.set(databaseUrl, (pool = { sql: new SQL({ url: databaseUrl, max: opts.max ?? Number(process.env.OB1_PG_POOL ?? 10) }), clients: 0 }));
    pool.clients++;
    this.pool = pool;
    this.sql = pool.sql;
    this.catalog = new Catalog(this.sql, databaseUrl);
  }

  from<T = Record<string, unknown>[]>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this.sql, this.catalog, table);
  }

  /**
   * Calls a stored function by name with named arguments, as PostgREST does.
   *
   * Each argument is bound by the type the function declares for it (the
   * catalog's `pg_proc` read, once per name): an array-typed argument takes a
   * JS array as an array literal with a cast (`search_tags text[]` — sent raw,
   * Bun's `String()` of it was "malformed array literal", and the one caller
   * fell back to an ILIKE scan without saying so); a `vector` argument takes
   * JSON text, `[1,0,0]`, which Postgres coerces where an array literal is not
   * valid vector input; a `jsonb` one takes the object or array untouched —
   * never pre-stringified, since Bun binds a JS string to jsonb as a JSON
   * scalar string, and `jsonb_array_length` then fails with "cannot get array
   * length of a scalar". Where overloads disagree on a name's type, or the
   * function is unknown, the value goes as it is — except a numeric array,
   * which goes as JSON text, the rule this method had before it read the
   * catalog — and Postgres resolves the call as before.
   */
  async rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
    try {
      const f = ident(fn, "function");
      const names = Object.keys(args);
      for (const n of names) ident(n, "argument");
      const overloads = (await this.catalog.argTypesOf(fn)).filter((o) => names.every((n) => o.names.includes(n)));
      const typeOf = (n: string): ColumnInfo | undefined => {
        const types = new Set(overloads.map((o) => `${o.types[o.names.indexOf(n)]}\u0000${o.categories[o.names.indexOf(n)]}`));
        if (types.size !== 1) return undefined;
        const [type, category] = [...types][0].split("\u0000");
        return { type, category };
      };
      const values: unknown[] = [];
      const call = names.length
        ? `${f}(${names.map((n) => {
            const v = args[n];
            const type = typeOf(n);
            const numeric = Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number");
            const b = type === undefined && numeric ? { value: JSON.stringify(v), cast: "" } : bound(type, v);
            values.push(b.value);
            return `${ident(n, "argument")} => $${values.length}${b.cast}`;
          }).join(", ")})`
        : `${f}()`;
      // The rows shaped by the overload's OUT columns when the call resolves to one (or every candidate agrees).
      const outs = overloads.length && overloads.every((o) => [...o.outs].every(([k, v]) => overloads[0].outs.get(k)?.type === v.type)) ? overloads[0].outs : undefined;
      const rows = ((await this.sql.unsafe(`SELECT * FROM ${call}`, values as never[])) as unknown as Record<string, unknown>[]).map((r) => jsonShaped(r, outs));

      // A set-returning function yields rows; a scalar one yields a single column
      // holding the value. PostgREST makes the same distinction.
      if (rows.length === 1 && Object.keys(rows[0]).length === 1) {
        const only = Object.values(rows[0])[0];
        return { data: only as T, error: null, count: null };
      }
      return { data: rows as T, error: null, count: null };
    } catch (e) {
      if (isRefusal(e)) throw e;
      return { data: null, error: toPostgrestError(e), count: null };
    }
  }

  /** Releases this client's hold on the shared pool; the pool itself closes with the last hold. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (--this.pool.clients > 0) return;
    if (POOLS.get(this.databaseUrl) === this.pool) POOLS.delete(this.databaseUrl);
    STORES.delete(this.databaseUrl); // the next client on this URL reads the catalog afresh
    await this.pool.sql.close();
  }
}

/**
 * Drop-in for supabase-js `createClient`. The second argument is accepted and
 * ignored so the call site does not have to change: with SQL the credentials live
 * in the connection URL, and there is no separate service key.
 */
export function createClient(databaseUrl: string, _serviceKey?: string, opts?: { max?: number }): SupabaseSqlClient {
  if (!databaseUrl || !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error(
      `compat/supabase-sql: expected a postgres:// connection URL, got "${String(databaseUrl).slice(0, 40)}". ` +
        `This shim replaces PostgREST — pass DATABASE_URL where the original passed SUPABASE_URL.`
    );
  }
  return new SupabaseSqlClient(databaseUrl, opts ?? {});
}
