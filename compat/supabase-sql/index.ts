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
 * ── The catalog (SMD-1588, FORK.md change 77) ────────────────────────────────
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
 * `.or()`'s `cs`). A table that appears after the first read is seen on its
 * first use (an empty answer is not kept); a column that appears is seen when
 * a filter, an order, a payload or a select list names it (the map is re-read
 * once) or when a row comes back carrying it (the next call's map is fresh);
 * one dropped or retyped is not until the process restarts — PostgREST's own
 * cache reloads on a signal, not on its own.
 *
 * ── Resource embedding ───────────────────────────────────────────────────────
 * `.select("*, maintenance_tasks ( id, name )")`, `"*, recipes:recipe_id (name)"`
 * and `"*, children(*)"` are served: the relation is a table with exactly one
 * foreign key to or from the table it sits in, or a foreign-key column of that
 * table; a many-to-one embed is an object (`null` when the key is), a
 * one-to-many one an array (`[]` when empty) — or the one row where the
 * referencing columns are unique, a one-to-one — keyed by the alias or the
 * relation's name, as PostgREST keys them. Nested to any depth since SMD-1798
 * (`applications(*, job_postings(*, companies(*)))`, each level a correlated
 * subquery on the level above), and hinted: `!inner` keeps only the rows that
 * have an embedded row (an EXISTS beside the filters, nested with the embeds),
 * `!fk_name` and `!fk_column` choose the key where two join the tables,
 * `!left` is the default. Refused, with a message saying which: a relation
 * with no foreign key to its table or with more than one and no hint (name the
 * column or the key), a hint that names no key, a table embedded in itself by
 * name, a filter on an embedded column (`.neq("thoughts.tier", …)`, refused
 * as an identifier). An embed in a write's RETURNING list is served as in a
 * select — the table's name there is the row just written. Whether a relation
 * has one foreign key or two is the catalog's to say, at the first call.
 * Silently mishandling a join is the failure class this migration has been
 * removing, so nothing here guesses.
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
 * ── What PostgREST answers (SMD-1602) ────────────────────────────────────────
 * Five places this shim answered what PostgREST does not, found by change 77's
 * review and closed here — each a silent wrong answer, the failure class this
 * module exists to avoid: a count without `head` is the total, not the page;
 * `.single()` over several rows is PGRST116, not the first row; `head` without
 * a count is no rows, not every row; an upsert's conflict target is the primary
 * key when none is named, and every payload column is assigned so the row is
 * always returned; `.rpc()`'s shape is what `pg_proc.proretset` declares, not
 * how many cells came back. And an array column is read through `to_json` —
 * PostgREST's rendering — because Bun's binary decoder hands a `uuid[]` back as
 * literal text and refuses a `real[]` holding a NULL; a table with an array
 * column therefore has its `*` spelled out from the map (see columnSql).
 *
 * ── Error convention ─────────────────────────────────────────────────────────
 * supabase-js resolves with `{ data, error }` and does not throw. This matches
 * that exactly, including on SQL errors, so existing `if (error)` branches keep
 * working; the error is a `PostgrestError`, an `Error` subclass as supabase-js's
 * is, so a file that does `if (error) throw error` hands its caller the message
 * rather than `[object Object]` (two extension tools did). Programming errors —
 * an invalid identifier, a nested embed, an `.or()` that begins with grouping —
 * throw, because they are bugs in the caller rather than runtime conditions;
 * what an `.or()` term asks for is the exception, because four tools build
 * their expression from a user's text, so a term the shim cannot serve is
 * PostgREST's 400 as `{ error }`.
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
 * driven has needed more. Change 77 has the column map in hand for a table
 * verb, and a `date` column's Date (UTC midnight, whatever the process's
 * zone) becomes the bare date PostgREST gives — `2026-09-21` — because five
 * extension tools read one (`week_start`, `follow_up_date`, `expected_close_
 * date`, `last_used`) and an embedded row already carried that spelling:
 * `row_to_json` builds it in the database, with Postgres's own spellings for
 * every type, which is what PostgREST gives for an embed too. A function's
 * rows take the map of what it declares — its OUT columns (`RETURNS TABLE`),
 * the table it returns rows of (`RETURNS SETOF thoughts`), its one scalar —
 * so the same `follow_up_date` is one shape whichever path a tool takes.
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
    } else if (ArrayBuffer.isView(v) && !(v instanceof DataView) && (cols ? cols.get(k)?.category === "A" : !(v instanceof Uint8Array))) {
      // Bun decodes an int[] column into an Int32Array, which JSON renders as {"0":1,"1":2}; PostgREST gives a list.
      // With a column map, only an array column's; without one (a function's rows with no OUT columns), every view
      // but a byte view — a bytea column's Buffer stays what Bun hands back either way.
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
 * a tag with a comma or a space survives; null (and undefined, as JSON has no
 * word for it) is `NULL`, a nested array a nested literal, an object its JSON
 * (a `jsonb[]` column), a Date its ISO instant. Bound with an explicit cast to
 * the declared type.
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
type Overload = { names: string[]; types: string[]; categories: string[]; outs: Columns; returns: { type: string; category: string; table: string | null; set: boolean } };
type CatalogStore = { columns: Map<string, Promise<Columns>>; absent: Map<string, Set<string>>; natts: Map<string, number>; fks: Map<string, Promise<ForeignKey[]>>; fns: Map<string, Promise<Overload[]>>; pks: Map<string, Promise<string[]>> };

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
    if (!store) STORES.set(url, (store = { columns: new Map(), absent: new Map(), natts: new Map(), fks: new Map(), fns: new Map(), pks: new Map() }));
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
   * find new columns forgets the absent names, since the schema moved — and
   * so does a query that named an absent column and then failed with anything
   * but "undefined column" (`forget()`, from execute): the column exists now
   * and the map is stale, so the next call reads again. A column queried
   * before the migration that adds it costs one failed call, not a restart.
   */
  async columnsOf(table: string, expect: Iterable<string> = []): Promise<Columns> {
    const read = this.memo(this.store.columns, table, () => this.readColumns(table));
    // One set per table, made before the await, so two callers naming two missing columns at once add to the same
    // object rather than each writing its own back over the other's.
    let absent = this.store.absent.get(table);
    if (!absent) this.store.absent.set(table, (absent = new Set<string>()));
    let cols = await read;
    const missing = [...expect].filter((name) => cols.size > 0 && !cols.has(name) && !absent.has(name));
    if (missing.length) {
      // Twenty callers missing the same name share one re-read: only the caller whose map is still the current
      // one drops it; the rest find the replacement already in flight.
      if (this.store.columns.get(table) === read) this.store.columns.delete(table);
      const fresh = await this.memo(this.store.columns, table, () => this.readColumns(table));
      if (fresh.size > cols.size) absent.clear();
      cols = fresh;
      // Bounded: a comma in user text can inject a well-formed term with any column name (`x, foo.eq.1`), and the set
      // is keyed by what callers name; past 64 names it starts over rather than growing with the traffic.
      if (absent.size >= 64) absent.clear();
      for (const name of missing) if (!cols.has(name)) absent.add(name);
    }
    return cols;
  }

  /** Whether any of these names is remembered as absent from the table — the query then runs on a map that skipped a refresh. */
  skippedRefresh(table: string, names: Iterable<string>): boolean {
    const absent = this.store.absent.get(table);
    return !!absent && [...names].some((n) => absent.has(n));
  }

  /** Drop what is remembered about a table's columns; the next call reads them again. */
  forget(table: string): void {
    this.store.columns.delete(table);
    this.store.absent.delete(table);
    this.store.natts.delete(table);
  }

  /**
   * `pg_class.relnatts` as it stood when the table's columns were read: the
   * count of attributes the table has ever had (a dropped one still counts),
   * which a query on a spelled-out star carries back beside its rows, so a
   * column added under a running client is seen on the next call as a
   * changed count rather than as a key the map lacks (SMD-1602).
   */
  nattsOf(table: string): number | undefined {
    return this.store.natts.get(table);
  }

  private readColumns(table: string): Promise<Columns> {
    return (async () => {
      const rows = (await this.sql.unsafe(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, t.typcategory AS category, c.relnatts::int AS natts
           FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid JOIN pg_class c ON c.oid = a.attrelid
          WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
        [ident(table, "table")] as never[]
      )) as unknown as { name: string; type: string; category: string; natts: number }[];
      if (rows.length) this.store.natts.set(table, Number(rows[0].natts));
      return new Map(rows.map((r) => [r.name, { type: r.type, category: r.category }]));
    })();
  }

  /**
   * The table's primary key columns, in key order — what PostgREST resolves
   * an upsert's conflict target to when the caller names none (SMD-1602).
   * Empty for a table with no primary key, and then not kept (memo's rule),
   * which costs a read per such upsert; nothing in the tree upserts into one.
   */
  primaryKeyOf(table: string): Promise<string[]> {
    return this.memo(this.store.pks, table, async () => {
      const rows = (await this.sql.unsafe(
        `SELECT a.attname AS name
           FROM pg_index i JOIN unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord) ON true
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          WHERE i.indrelid = to_regclass($1) AND i.indisprimary
          ORDER BY k.ord`,
        [ident(table, "table")] as never[]
      )) as unknown as { name: string }[];
      return rows.map((r) => r.name);
    });
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
                (SELECT array_agg(y.typcategory::text ORDER BY u.ord) FROM unnest(p.proallargtypes) WITH ORDINALITY u(t, ord) JOIN pg_type y ON y.oid = u.t) AS all_categories,
                format_type(p.prorettype, NULL) AS ret_type, rt.typcategory::text AS ret_category, p.proretset AS ret_set,
                CASE WHEN rt.typtype = 'c' AND rc.relkind IN ('r', 'v', 'm', 'p', 'c') AND pg_table_is_visible(rc.oid) THEN rc.relname END AS ret_table
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                JOIN pg_type rt ON rt.oid = p.prorettype LEFT JOIN pg_class rc ON rc.oid = rt.typrelid
          WHERE p.proname = $1 AND n.nspname = ANY (current_schemas(true))`,
        [fn.trim()] as never[]
      )) as unknown as { names: string[] | null; modes: string[] | null; types: string[] | null; categories: string[] | null; all_types: string[] | null; all_categories: string[] | null; ret_type: string; ret_category: string; ret_set: boolean; ret_table: string | null }[];
      return rows.map((r) => {
        // proargnames covers OUT arguments too (a RETURNS TABLE function's columns); proargtypes only the IN ones;
        // proallargtypes every one, in proargnames' order, when any is OUT.
        const names = (r.names ?? []).filter((_, i) => !r.modes || ["i", "b", "v"].includes(r.modes[i]));
        const outs: Columns = new Map();
        (r.names ?? []).forEach((name, i) => {
          if (r.modes && ["o", "t", "b"].includes(r.modes[i]) && r.all_types?.[i]) outs.set(name, { type: r.all_types[i], category: r.all_categories?.[i] ?? "" });
        });
        return { names, types: r.types ?? [], categories: r.categories ?? [], outs, returns: { type: r.ret_type, category: r.ret_category, table: r.ret_table, set: r.ret_set === true } };
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
  | { kind: "column"; sql: string; name: string }
  | { kind: "embed"; key: string; relation: string; hint: string | null; inner: SelectItem[] };

/**
 * PostgREST's select list: `*`, columns, and resource embedding —
 * `relation (cols)`, `alias:relation (cols)`, `relation(*)` — the relation
 * being a table or a foreign-key column of the table it sits in, whitespace
 * anywhere (`maintenance_tasks (\n id,\n name\n )` is the tree's spelling),
 * nested to any depth (`applications(*, job_postings(*, companies(*)))`, the
 * tree's deepest, SMD-1798) and hinted: `relation!inner(…)` keeps only the
 * rows that have an embedded row, `relation!fk_name(…)` and
 * `relation!fk_column(…)` choose the key where two join the tables
 * (`graph_nodes!graph_edges_target_node_id_fkey(…)`), `!left` is the default
 * said aloud. What is refused is refused here, at the call, as a programming
 * error: a cast or a JSON path in the list (ident() refuses those), an embed
 * with no columns, text around one.
 */
function parseSelect(spec: string): SelectItem[] {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "*") return [{ kind: "star" }];
  // Split on the commas outside parentheses.
  const items: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { items.push(trimmed.slice(start, i)); start = i + 1; }
  }
  if (depth !== 0) throw refusal(`select("${spec}") has unbalanced parentheses.`);
  items.push(trimmed.slice(start));
  return items.map((raw): SelectItem => {
    const item = raw.trim();
    if (item === "*") return { kind: "star" };
    // `key[:relation][!hint] ( inner )` — the inner list is everything between the first `(` and the last `)`.
    const open = item.indexOf("(");
    const embed = open > 0 && item.endsWith(")")
      ? /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([A-Za-z_][A-Za-z0-9_]*))?(?:\s*!\s*([A-Za-z_][A-Za-z0-9_]*))?\s*$/.exec(item.slice(0, open))
      : null;
    if (embed) {
      const [, first, second, hintRaw] = embed;
      const innerText = item.slice(open + 1, -1).trim();
      if (innerText === "") throw refusal(`select("${spec}") embeds "${first}" with no columns — name them, or (*).`);
      const inner = parseSelect(innerText);
      const hint = hintRaw && hintRaw !== "left" ? hintRaw : null;
      return { kind: "embed", key: first, relation: second ?? first, hint, inner };
    }
    if (/\(|\)|!/.test(item)) throw refusal(`select("${spec}"): "${item}" is not a column or an embed (relation (cols), alias:relation (cols), relation!hint (cols)).`);
    return { kind: "column", sql: ident(item, "column"), name: item };
  });
}

/** One term of an or() expression: a filter, a group holding terms of its own, or text PostgREST cannot parse either. */
type OrTerm = { col: string; op: string; value: string; negate: boolean } | { broken: string } | { group: "and" | "or"; negate: boolean; terms: OrTerm[] };

/** PostgREST's `in.(a,b,"c, d")` list: split at the commas outside double quotes, each item trimmed and unquoted; `()` is []. */
function inList(list: string): string[] {
  const items: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quoted) { if (ch === "\\" && i + 1 < list.length) cur += list[++i]; else if (ch === '"') quoted = false; else cur += ch; continue; }
    if (ch === '"') quoted = true;
    else if (ch === ",") { items.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim() !== "" || items.length) items.push(cur.trim());
  return items;
}

type Filter = (cols: Columns) => { sql: string; values: unknown[] };
type Op = "select" | "insert" | "update" | "upsert" | "delete";

/** `error` is a PostgrestError at runtime (change 77); the type stays the structural one migrated files were written against. */
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
  /** Whether the last compile spelled a `*` out from the map (an array-bearing table): a 42703 then means the map named a column since dropped. */
  private spelledOut = false;

  constructor(private sql: SQL, private catalog: Catalog, private table: string) {}

  private names(col: string): void {
    const base = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(col.trim())?.[1];
    if (base) this.named.add(base);
  }

  // ── verbs ──────────────────────────────────────────────────────────────────

  select(cols = "*", opts?: { count?: "exact" | "planned" | "estimated"; head?: boolean }): this {
    // `.select()` after insert/update/delete means RETURNING, not a new query: the verb stands, only the list moves.
    this.items = parseSelect(cols);
    for (const item of this.items) if (item.kind === "column") this.names(item.name);
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
    // `in.()` selects nothing without reading the column, so the column is not one this query names: a name that
    // never reaches the SQL must not drive the catalog's refresh (or its forget-on-success, which would re-read
    // the table on every such call against a column it lacks).
    if (operator === "in" && Array.isArray(value) && value.length === 0 && !negate) return () => ({ sql: "FALSE", values: [] });
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
        // Matches PostgREST: the negation of in.() selects every row whose column is not NULL (`NOT (x = ANY('{}'))`
        // is NULL for a NULL x); the positive form returned above, before the column was counted as named.
        return () => ({ sql: `${column(col).sql} IS NOT NULL`, values: [] });
      }
      const c = column(col);
      return (cols) => {
        const b = value.map((v) => bound(cols.get(col.trim()), v));
        return { sql: not(`${c.sql} IN (${b.map((x) => (c.text ? "?::text" : `?${x.cast}`)).join(", ")})`), values: b.map((x) => x.value) };
      };
    }
    if (operator === "cs") {
      const name = col.trim();
      const c = ident(name, "column");
      return (cols) => {
        const info = cols.get(name);
        if (info?.category === "A") {
          // An array column: the caller's array, or the literal text PostgREST's `cs.{a,b}` carries.
          const v = Array.isArray(value) ? arrayLiteral(value) : value;
          return { sql: not(`${c} @> ?::${info.type}`), values: [v] };
        }
        // jsonb: an object or array is bound as such; `.or()`'s text is parsed to one first (a string would be a JSON scalar).
        let v = value;
        if (typeof value === "string") {
          // Text reaches here from or() only, where it may be a user's: PostgREST's 400, resolved as { error }.
          try { v = JSON.parse(value); } catch { throw new PostgrestError(`PGRST100: cs.${value} is not JSON, and "${col}" is ${info ? "not an array column" : "not a column the table has"}`, { code: "PGRST100" }); }
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
   * PostgREST's `.or("a.gt.1,b.is.null")` — `column.op.value` terms combined
   * with OR, `cs` among the operators (`ingredients.cs.[{"name":"x"}]`), and,
   * since SMD-1798, grouping: `and(…)`, `or(…)`, `not.and(…)`, `not.or(…)`,
   * nested to any depth, each holding a list of its own —
   * `and(start_date.lte.X,or(end_date.gte.Y,end_date.is.null)),day_of_week.not.is.null`
   * is family-calendar's, two `and(…)` terms metadata-norm's — and
   * `col.in.(a,b)`, job-hunt's. The flat form was the only one served, and an
   * expression that began with grouping threw.
   *
   * Read as PostgREST reads it, term by term: a column (a name or a JSON
   * path) up to the first dot, an operator up to the next, then a value —
   * a balanced `[…]` or `{…}` group when it starts with one (a `cs` value's
   * JSON or array literal, brackets and quotes inside it belonging to it), a
   * balanced `(…)` list for `in`, a double-quoted string when it starts with
   * `"` (PostgREST's quoting), or plain text up to the next comma;
   * `col.not.op.value` negates as PostgREST's does. A term that starts with
   * `and(`, `or(`, `not.and(` or `not.or(` — no space before the parenthesis,
   * as PostgREST's grammar has none — is a group to its balanced `)` (a
   * double-quoted string inside it may hold anything), its inside a list of
   * its own. Plain text is split at a comma and nothing else — a quote, a
   * parenthesis or a bracket in an ILIKE pattern is pattern text (four tools
   * interpolate user text into their expression: `name.ilike.%${query}%,…`),
   * and a plain comma in that text splits a term PostgREST cannot parse
   * either. That term, a group nothing closes, grouping words a comma left at
   * a term start (`x, and (y`), an empty group, and whatever a comma-made term
   * asks of term() that it refuses (`v1.2.3` reads as operator "2") resolve as
   * `{ error }` with PostgREST's `PGRST100` at execution — the tool's own error
   * handling sees it — while the terms that did parse stay parameterised.
   */
  or(expression: string): this {
    return this.where(this.logic(this.parseTerms(expression), "or", false, expression));
  }

  /** The terms of an or() expression, or of a group inside one — see or(). */
  private parseTerms(expression: string): OrTerm[] {
    const terms: OrTerm[] = [];
    let i = 0;
    const n = expression.length;
    /** The index of the `)` balancing the `(` at `from`, quotes honoured; n when nothing closes it. */
    const closeOf = (from: number): number => {
      let depth = 0, quoted = false, k = from;
      for (; k < n; k++) {
        const ch = expression[k];
        if (quoted) { if (ch === "\\") k++; else if (ch === '"') quoted = false; continue; }
        if (ch === '"') quoted = true;
        else if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (depth === 0) return k; }
      }
      return n;
    };
    /** After a group, a list or a quoted value only a comma or the end may follow: advance past it, or the term is broken to the next comma. */
    const after = (termStart: number, j: number): "next" | "end" | "broken" => {
      const rest = expression.slice(j).match(/^\s*(,|$)/);
      if (!rest) { const stop = expression.indexOf(",", j); terms.push({ broken: expression.slice(termStart, stop < 0 ? n : stop).trim() }); i = stop < 0 ? n + 1 : stop + 1; return "broken"; }
      i = j + rest[0].length + (rest[1] === "," ? 0 : 1);
      return rest[1] === "," ? "next" : "end";
    };
    while (i <= n) {
      const termStart = i;
      // A group: `and(`, `or(`, `not.and(`, `not.or(` flush against its parenthesis, to the `)` that balances it.
      const g = /^(not\.)?(and|or)\(/.exec(expression.slice(i));
      if (g) {
        const open = i + g[0].length - 1;
        const close = closeOf(open);
        if (close >= n) { terms.push({ broken: expression.slice(termStart).trim() }); break; }
        const inside = expression.slice(open + 1, close);
        const group: OrTerm = { group: g[2] as "and" | "or", negate: !!g[1], terms: inside.trim() === "" ? [] : this.parseTerms(inside) };
        const step = after(termStart, close + 1);
        if (step === "broken") continue;
        terms.push(group);
        if (step === "end") break;
        continue;
      }
      const firstDot = expression.indexOf(".", i);
      const head = expression.slice(i, firstDot < 0 ? n : firstDot).trim();
      const secondDot = firstDot < 0 ? -1 : expression.indexOf(".", firstDot + 1);
      // A term is `column.op.value`, the column a name or a JSON path. Anything else here is what a comma in a
      // previous plain value left behind (` Salt%,category` — user text, `x, and (y`) — the broken term, up to the next comma.
      if (firstDot < 0 || secondDot < 0 || !/^[A-Za-z_][A-Za-z0-9_]*(?:->>?[A-Za-z_][A-Za-z0-9_]*)*$/.test(head)) {
        const stop = expression.indexOf(",", i);
        terms.push({ broken: expression.slice(termStart, stop < 0 ? n : stop).trim() });
        i = stop < 0 ? n + 1 : stop + 1;
        continue;
      }
      const col = head;
      let op = expression.slice(firstDot + 1, secondDot).trim();
      let j = secondDot + 1;
      let negate = false;
      if (op === "not") {
        // PostgREST's negation inside or(): `col.not.eq.1`, `col.not.is.null`.
        const thirdDot = expression.indexOf(".", j);
        if (thirdDot < 0) { const stop = expression.indexOf(",", i); terms.push({ broken: expression.slice(termStart, stop < 0 ? n : stop).trim() }); i = stop < 0 ? n + 1 : stop + 1; continue; }
        op = expression.slice(j, thirdDot).trim();
        negate = true;
        j = thirdDot + 1;
      }
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
      } else if (open === "(" && op === "in") {
        // PostgREST's `in.(a,b,"c, d")`: the list to the `)` that balances it, without its parentheses.
        const close = closeOf(j);
        if (close >= n) { terms.push({ broken: expression.slice(termStart).trim() }); break; }
        value = expression.slice(j + 1, close);
        j = close + 1;
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
      const step = after(termStart, j);
      if (step === "broken") continue;
      terms.push({ col, op, value, negate });
      if (step === "end") break;
    }
    return terms;
  }

  /**
   * The terms of an or() expression, or of one group inside it, as one
   * filter: each term rendered by term() and combined with OR or AND, wrapped
   * in NOT for a negated group. PostgREST answers 400 to a term it cannot
   * parse; so does this, at execution, as `{ error }` with `PGRST100` — never
   * a throw out of a tool's handler for text a user typed. The same for what
   * a comma-made term asks of term() that it refuses (an operator that is not
   * one, a `cs` value that is not JSON), and for an empty group. An `in` term's
   * list is split at its commas, a double-quoted item holding anything.
   */
  private logic(terms: OrTerm[], op: "and" | "or", negate: boolean, expression: string): Filter {
    const badRequest = (what: string) => (): never => { throw new PostgrestError(`PGRST100: ${what} in or("${expression}") — PostgREST answers 400 here too`, { code: "PGRST100" }); };
    const filters = terms.map((t): Filter => {
      if ("broken" in t) return badRequest(`"${t.broken}" is not column.operator.value (a comma or an unclosed group in a value)`);
      if ("group" in t) return t.terms.length ? this.logic(t.terms, t.group, t.negate, expression) : badRequest(`an empty ${t.group}() group`);
      try {
        return this.term(t.col, t.op, t.op === "in" ? inList(t.value) : t.value, t.negate);
      } catch (e) {
        return badRequest(e instanceof Error ? e.message.replace(/^compat\/supabase-sql: /, "") : String(e));
      }
    });
    return (cols) => {
      const rendered = filters.map((f) => f(cols));
      return { sql: `${negate ? "NOT " : ""}(${rendered.map((r) => r.sql).join(op === "and" ? " AND " : " OR ")})`, values: rendered.flatMap((r) => r.values) };
    };
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
   * The foreign key an embed walks, resolved against the table it sits in
   * (`base`). The relation is a foreign-key column of the base (`recipes:
   * recipe_id (…)`: many-to-one through that key), or a table with exactly one
   * foreign key between the two, in either direction — the base's key to it is
   * many-to-one, its key to the base one-to-many — or, with a hint, the key the
   * hint names: a constraint's name (`graph_nodes!graph_edges_target_node_id_
   * fkey`) or a foreign-key column of the base, which is how PostgREST
   * disambiguates two keys to one table (SMD-1798). `!inner` is not a key.
   */
  private async resolveEmbed(item: Extract<SelectItem, { kind: "embed" }>, base: string): Promise<{ fk: ForeignKey; manyToOne: boolean }> {
    const [fks, cols] = await Promise.all([this.catalog.foreignKeysOf(base), this.catalog.columnsOf(base)]);
    const keyHint = item.hint && item.hint !== "inner" ? item.hint : null;
    if (keyHint) {
      // A constraint's name: the key's referencing side says the direction (a self-reference is many-to-one, the
      // base's own key). Else a foreign-key column of the base to the relation.
      const named = fks.filter((f) => f.name === keyHint && ((f.from === base && f.to === item.relation) || (f.to === base && f.from === item.relation)));
      if (named.length === 1) return { fk: named[0], manyToOne: named[0].from === base };
      const viaColumn = fks.filter((f) => f.from === base && f.to === item.relation && f.fromCols.length === 1 && f.fromCols[0] === keyHint);
      if (viaColumn.length === 1) return { fk: viaColumn[0], manyToOne: true };
      throw refusal(`select embeds "${item.relation}" through "!${keyHint}", which names neither a foreign key between it and "${base}" nor a foreign-key column of "${base}".`);
    }
    if (cols.has(item.relation)) {
      const via = fks.filter((f) => f.from === base && f.fromCols.length === 1 && f.fromCols[0] === item.relation);
      if (via.length !== 1) throw refusal(`select embeds "${item.relation}", a column of "${base}" that is not a single-column foreign key.`);
      return { fk: via[0], manyToOne: true };
    }
    const out = fks.filter((f) => f.from === base && f.to === item.relation);
    const back = fks.filter((f) => f.to === base && f.from === item.relation && f.from !== f.to);
    const self = fks.filter((f) => f.from === base && f.to === base && item.relation === base);
    if (self.length) throw refusal(`select embeds "${item.relation}" in itself — which side is meant is not decidable from the table's name; name the column: alias:fk_column (…).`);
    if (out.length + back.length === 0) throw refusal(`select embeds "${item.relation}", and no foreign key joins it to "${base}" (or the table is off the search path).`);
    if (out.length + back.length > 1) throw refusal(`select embeds "${item.relation}", and more than one foreign key joins it to "${base}" — name the column (alias:fk_column (…)) or the key (${item.relation}!fk_name (…)).`);
    return { fk: out[0] ?? back[0], manyToOne: out.length === 1 };
  }

  /**
   * One embed as a correlated subquery, nested to any depth. Many-to-one is
   * `row_to_json` of the one row (NULL when the key is), keyed as the alias;
   * one-to-many is `json_agg` of the rows, `[]` when there are none — unless
   * the referencing columns carry a unique index, a one-to-one, which is the
   * one row again — PostgREST's shapes. The embedded table is aliased by depth
   * (`__e1`, `__e2`, …) so a self-reference still names the outer row, and a
   * nested embed's rows are correlated to the level above it, not the base. An
   * inner embed inside the subquery narrows its rows as `!inner` narrows the
   * base's (innerClause).
   */
  private async embedSql(item: Extract<SelectItem, { kind: "embed" }>, base: { table: string; alias: string }, depth: number): Promise<string> {
    const { fk, manyToOne } = await this.resolveEmbed(item, base.table);
    const oneRow = manyToOne || fk.unique;
    const targetTable = manyToOne ? fk.to : fk.from;
    const alias = `__e${depth}`;
    const pairs = (manyToOne ? fk.toCols : fk.fromCols).map((c, i) =>
      `${alias}.${ident(c, "column")} = ${base.alias}.${ident((manyToOne ? fk.fromCols : fk.toCols)[i], "column")}`);
    const parts: string[] = [];
    const inners: string[] = [];
    for (const inner of item.inner) {
      if (inner.kind === "star") parts.push(`${alias}.*`);
      else if (inner.kind === "column") parts.push(`${alias}.${ident(inner.name, "column")}`);
      else {
        parts.push(await this.embedSql(inner, { table: targetTable, alias }, depth + 1));
        if (inner.hint === "inner") inners.push(await this.innerClause(inner, { table: targetTable, alias }, depth + 1));
      }
    }
    const rows = `SELECT ${parts.join(", ")} FROM ${ident(targetTable, "table")} AS ${alias} WHERE ${[...pairs, ...inners].join(" AND ")}`;
    const value = oneRow
      ? `(SELECT row_to_json(__r) FROM (${rows}) __r)`
      : `COALESCE((SELECT json_agg(__r) FROM (${rows}) __r), '[]'::json)`;
    return `${value} AS ${ident(item.key, "embed alias")}`;
  }

  /**
   * `!inner`: PostgREST keeps only the rows of the table an inner embed sits
   * in that have at least one embedded row — an EXISTS over the same key,
   * carrying the inner embeds nested inside it (`applications!inner(*,
   * job_postings!inner(*))` keeps an interview only when its application has a
   * posting). A many-to-one through a NOT NULL key is satisfied by every row,
   * and the clause says so harmlessly.
   */
  private async innerClause(item: Extract<SelectItem, { kind: "embed" }>, base: { table: string; alias: string }, depth: number): Promise<string> {
    const { fk, manyToOne } = await this.resolveEmbed(item, base.table);
    const targetTable = manyToOne ? fk.to : fk.from;
    const alias = `__x${depth}`;
    const pairs = (manyToOne ? fk.toCols : fk.fromCols).map((c, i) =>
      `${alias}.${ident(c, "column")} = ${base.alias}.${ident((manyToOne ? fk.fromCols : fk.toCols)[i], "column")}`);
    const nested: string[] = [];
    for (const inner of item.inner) if (inner.kind === "embed" && inner.hint === "inner") nested.push(await this.innerClause(inner, { table: targetTable, alias }, depth + 1));
    return `EXISTS (SELECT 1 FROM ${ident(targetTable, "table")} AS ${alias} WHERE ${[...pairs, ...nested].join(" AND ")})`;
  }

  /** The base table's `!inner` clauses, to go in the query's WHERE; empty when no top-level embed is inner or the table is unknown. */
  private async innerClauses(cols: Columns): Promise<string[]> {
    if (cols.size === 0) return [];
    const base = { table: this.table.trim(), alias: ident(this.table.trim(), "table") };
    const out: string[] = [];
    for (const item of this.items) if (item.kind === "embed" && item.hint === "inner") out.push(await this.innerClause(item, base, 1));
    return out;
  }

  /**
   * An array column is read through `to_json`, which renders it as Postgres
   * renders JSON (PostgREST's own rendering: a `uuid[]` a list of strings, a
   * `date[]` bare dates), where Bun's binary decoder hands a `uuid[]` back as
   * the literal text `{…}` and refuses a `real[]` holding a NULL outright
   * (`ERR_POSTGRES_NULLS_IN_ARRAY_NOT_SUPPORTED_YET` — the query log's
   * `result_scores`, SMD-1602). So on a table with an array column a `*` is
   * spelled out from the map, arrays wrapped, with `relnatts` read beside the
   * rows so a column added under a running client is still seen on the next
   * call (execute compares it with the count the map was read at); on a table
   * without one, `*` stays `*`, and a row carrying a key the map lacks is the
   * signal, as before.
   */
  private columnSql(name: string, info: ColumnInfo | undefined): string {
    return info?.category === "A" ? `to_json(${ident(name, "column")}) AS ${ident(name, "column")}` : ident(name, "column");
  }

  /**
   * The select list, or a write's RETURNING list — the same rendering: in a
   * RETURNING list the table's name is the row just written, so an embed's
   * correlated subquery joins to it as it joins to a selected row
   * (`.insert(contact).select("*, companies (id, name)")`, job-hunt's;
   * refused until SMD-1798).
   */
  private async projection(cols: Columns): Promise<string> {
    const parts: string[] = [];
    const hasArray = [...cols.values()].some((c) => c.category === "A");
    this.spelledOut = false;
    const base = { table: this.table.trim(), alias: ident(this.table.trim(), "table") };
    for (const item of this.items) {
      if (item.kind === "star") {
        if (!hasArray) { parts.push("*"); continue; }
        for (const [name, info] of cols) parts.push(this.columnSql(name, info));
        parts.push(`(SELECT c.relnatts FROM pg_class c WHERE c.oid = to_regclass('${base.alias}'))::int AS __natts`);
        this.spelledOut = true;
      }
      else if (item.kind === "column") parts.push(this.columnSql(item.name, cols.get(item.name)));
      // A table the catalog cannot see has no keys to embed through: the embed is left out so the query itself
      // reports the missing table (42P01, as `{ error }`) rather than a refusal naming a foreign key.
      else if (cols.size === 0) continue;
      else parts.push(await this.embedSql(item, base, 1));
    }
    return parts.join(", ") || "*";
  }

  /**
   * The query, and — for a counted select that is not head-only — the count
   * query PostgREST would run for `Content-Range`: the same WHERE, no page.
   * The page itself carries `count(*) OVER ()`, the total before LIMIT and
   * OFFSET; `countText` is run only when the page comes back empty (an offset
   * past the end), where the window has no row to ride on (SMD-1602).
   */
  private async compile(): Promise<{ text: string; values: unknown[]; cols: Columns; countText?: string }> {
    const table = this.table.trim();
    const t = ident(table, "table");
    for (const row of this.payload) for (const c of Object.keys(row)) this.names(c);
    const cols = await this.catalog.columnsOf(table, this.named);

    if (this.op === "select") {
      const filters = this.whereClause(cols, 0);
      // `!inner` embeds narrow the base rows too: their EXISTS clauses join the WHERE.
      const inner = await this.innerClauses(cols);
      const clauses = [...(filters.text ? [filters.text.slice(" WHERE ".length)] : []), ...inner];
      const where = { text: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", values: filters.values };
      // head: no rows, whether or not a count was asked for — supabase-js answers `data: null` to both; PostgREST runs
      // the query for its headers alone. One count query serves both forms; the count is answered only when asked.
      if (this.headOnly) return { text: `SELECT count(*)::int AS __count FROM ${t}${where.text}`, values: where.values, cols };
      let projection = await this.projection(cols);
      if (this.wantCount) projection += ", count(*) OVER () AS __count";
      let text = `SELECT ${projection} FROM ${t}${where.text}`;
      if (this.orderBy.length) text += ` ORDER BY ${this.orderBy.join(", ")}`;
      if (this.limitN !== null) text += ` LIMIT ${Number(this.limitN)}`;
      if (this.offsetN !== null) text += ` OFFSET ${Number(this.offsetN)}`;
      return { text, values: where.values, cols, countText: this.wantCount ? `SELECT count(*)::int AS __count FROM ${t}${where.text}` : undefined };
    }

    const returning = await this.projection(cols);
    // A value bound by its column's type: an array column takes an array literal with a cast (change 77).
    const bind = (c: string, v: unknown, values: unknown[]): string => {
      const b = bound(cols.get(c), v);
      values.push(b.value);
      return `$${values.length}${b.cast}`;
    };

    if (this.op === "insert" || this.op === "upsert") {
      // Union of keys across rows, so a heterogeneous batch still inserts. A key whose value is undefined in every
      // row is not a column: supabase-js's JSON drops it and Postgres applies the column's DEFAULT, where a NULL here
      // was a 23502 against a NOT NULL DEFAULT column (a row lacking a key another row has still gets NULL).
      const names = [...new Set(this.payload.flatMap((r) => Object.keys(r).filter((k) => r[k] !== undefined)))];
      if (names.length === 0) throw refusal("insert() called with no columns");
      const quoted = names.map((c) => ident(c, "column"));
      const values: unknown[] = [];
      const tuples = this.payload.map((row) => `(${names.map((c) => bind(c, row[c] ?? null, values)).join(", ")})`);
      let text = `INSERT INTO ${t} (${quoted.join(", ")}) VALUES ${tuples.join(", ")}`;
      if (this.op === "upsert") {
        // PostgREST's upsert: the conflict target is `onConflict`'s columns, or the table's primary key when none is
        // named — never the payload's first key, which was 42P10 whenever that key was not unique — and every payload
        // column is assigned from EXCLUDED, the target's among them, so the statement is always DO UPDATE and always
        // returns the row (`DO NOTHING` returned none, and a following `.single()` was PGRST116) (SMD-1602).
        const targetNames = this.conflictTarget
          ? this.conflictTarget.split(",").map((c) => c.trim()).filter(Boolean)
          : await this.catalog.primaryKeyOf(table);
        if (targetNames.length === 0) throw refusal(`upsert() into "${table}" names no onConflict column and the table has no primary key — PostgREST resolves the conflict target to the primary key; name the unique columns: upsert(row, { onConflict: "a,b" }).`);
        const target = targetNames.map((c) => ident(c, "conflict column")).join(", ");
        text += ` ON CONFLICT (${target}) DO UPDATE SET ${quoted.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`;
      }
      text += ` RETURNING ${returning}`;
      return { text, values, cols };
    }

    if (this.op === "update") {
      const row = this.payload[0] ?? {};
      const names = Object.keys(row).filter((k) => row[k] !== undefined); // as supabase-js's JSON drops them
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

  /**
   * Exposed for tests and for anyone debugging what the shim generates. Reads
   * the catalog, so it is a promise (change 77); it rejects where execute()
   * would resolve `{ error }` for what compiles badly — an `.or()` term that is
   * PostgREST's 400 — since there is no result to carry the error in.
   */
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
    let compiled = false;
    const table = this.table.trim();
    try {
      const { text, values, cols, countText } = await this.compile();
      compiled = true;
      const raw = (await this.sql.unsafe(text, values as never[])) as unknown as Record<string, unknown>[];
      // The page's total (count(*) OVER (), the same on every row) and the map's attribute count ride on the rows and
      // are lifted off them before the caller sees a row.
      let total: number | null = raw.length && "__count" in raw[0] ? Number(raw[0].__count) : null;
      const natts = raw.length && "__natts" in raw[0] ? Number(raw[0].__natts) : undefined;
      const rows = raw.map((r) => {
        if (!("__count" in r) && !("__natts" in r)) return jsonShaped(r, cols);
        const { __count: _c, __natts: _n, ...rest } = r;
        return jsonShaped(rest, cols);
      });
      // The query named a column remembered as absent and RAN: the column exists, the map is stale (a `date` column
      // added after it was first named would shape as an instant for the process's life) — forget it for the next call.
      // So too when a row comes back with a column the map does not know (`select("*")` after an ADD COLUMN names
      // nothing, but the row does): this row is shaped by the old map, the next call's by a fresh one. On a table whose
      // `*` is spelled out from the map, no such key can come back; the attribute count read beside the rows says it.
      const known = (k: string) => cols.size === 0 || cols.has(k) || this.items.some((it) => it.kind === "embed" && it.key === k);
      const grown = natts !== undefined && this.catalog.nattsOf(table) !== undefined && natts !== this.catalog.nattsOf(table);
      if (this.catalog.skippedRefresh(table, this.named) || grown || (rows[0] && Object.keys(rows[0]).some((k) => !known(k)))) this.catalog.forget(table);

      if (this.headOnly) {
        // head: no rows, as supabase-js answers; the count only when asked (`{ head: true }` alone streamed the table).
        return { data: null, error: null, count: this.wantCount ? Number(raw[0]?.__count ?? 0) : null };
      }
      if (this.rowMode !== "many") {
        // PostgREST's object response: exactly one row, or PGRST116 — several rows are the error too (an arbitrary first
        // row was the answer before), and maybeSingle() differs only on none.
        if (rows.length === 1) return { data: rows[0] as T, error: null, count: null };
        if (rows.length === 0 && this.rowMode === "maybeSingle") return { data: null, error: null, count: null };
        return { data: null, error: new PostgrestError("JSON object requested, multiple (or no) rows returned", { code: "PGRST116" }), count: null };
      }
      // A counted page that came back empty (an offset past the end) has no row for the window to ride on: the count
      // query PostgREST would run for Content-Range, the same WHERE without the page.
      if (this.wantCount && total === null) {
        if (countText) total = Number(((await this.sql.unsafe(countText, values as never[])) as unknown as { __count: number }[])[0]?.__count ?? 0);
        else total = rows.length;
      }
      return { data: rows as T, error: null, count: this.wantCount ? total : null };
    } catch (e) {
      if (isRefusal(e)) throw e;
      const error = toPostgrestError(e);
      // The query ran on a map that skipped a refresh for a column remembered as absent, and failed with something
      // other than "that column does not exist": the column is there now and the map is stale — forget it, so the
      // next call reads the table again (a 42703 confirms the absence and keeps the memo). A 42703 on a spelled-out
      // `*` is the map's own naming of a column since dropped: forget it too, so the next call spells the fresh set.
      if (compiled && ((error.code !== "42703" && this.catalog.skippedRefresh(table, this.named)) || (error.code === "42703" && this.spelledOut))) this.catalog.forget(table);
      return { data: null, error, count: null };
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

/** The pool size when OB1_PG_POOL is unset. */
export const DEFAULT_PG_POOL = 10;

/**
 * OB1_PG_POOL as a pool size: a positive integer, else the default. `""` is
 * unset — a compose file forwarding `${OB1_PG_POOL:-}` sends "" for an unset
 * knob, and Number("") is 0, which Bun's SQL refuses at construction, so a
 * shim server composed that way would not start. The same rule as
 * server-portable/store-sql.ts's poolSizeFrom, which SMD-1843's sixth review
 * pass found this shim still lacked; SMD-1881 is one shared reader for both.
 */
export function poolSizeFrom(raw: string | undefined, fallback = DEFAULT_PG_POOL): number {
  const n = raw && raw.trim() ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export class SupabaseSqlClient {
  readonly sql: SQL;
  private catalog: Catalog;
  private pool: { sql: SQL; clients: number };
  private closed = false;

  constructor(private databaseUrl: string, opts: { max?: number } = {}) {
    let pool = POOLS.get(databaseUrl);
    if (!pool) POOLS.set(databaseUrl, (pool = { sql: new SQL({ url: databaseUrl, max: opts.max ?? poolSizeFrom(process.env.OB1_PG_POOL) }), clients: 0 }));
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
      let overloads = (await this.catalog.argTypesOf(fn)).filter((o) => names.every((n) => o.names.includes(n)));
      // Overloads that share an argument's name but not its type are told apart by the value, as PostgREST's JSON
      // body tells them apart: a JS array is for an array, json or vector parameter, not a text one. Without this,
      // `tagged(search_tags text[])` beside `tagged(search_tags text)` — in one schema or across two visible ones —
      // left the array unbound, Bun sent "a,b", and Postgres chose the text overload without a word.
      const fits = (o: Overload, n: string) => {
        const v = args[n];
        const i = o.names.indexOf(n);
        const type = o.types[i] ?? "", category = o.categories[i] ?? "";
        if (Array.isArray(v)) return category === "A" || /^(?:jsonb?|vector)$/.test(type);
        if (v !== null && typeof v === "object") return /^jsonb?$/.test(type);
        return true;
      };
      const fitting = overloads.filter((o) => names.every((n) => fits(o, n)));
      if (fitting.length) overloads = fitting;
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
      // The rows shaped as a table's are, by what the function declares — its OUT columns (`RETURNS TABLE`, OUT
      // parameters), the table whose rows it returns (`RETURNS SETOF thoughts`), or its one scalar column, named as
      // the function is — when every candidate overload declares the same; candidates that differ leave the rows as
      // they come (one with no OUT columns beside one with some is a difference, not an agreement).
      const shapes = await Promise.all(overloads.map(async (o) => {
        if (o.outs.size) return o.outs;
        if (o.returns.table) return this.catalog.columnsOf(o.returns.table);
        return new Map([[fn.trim(), { type: o.returns.type, category: o.returns.category }]]) as Columns;
      }));
      const key = (m: Columns) => JSON.stringify([...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v.type]));
      const outs = shapes.length && shapes.every((m) => key(m) === key(shapes[0])) ? shapes[0] : undefined;
      // An array column of a declared shape is read through to_json, as a table's is (columnSql's reason: a `uuid[]`
      // path column arrives as literal text otherwise); a shape the candidates disagree on is read as it comes.
      // The call is aliased with the function's own name: a scalar function's one column takes the alias's name, and
      // the shape map keys it by the function's.
      const projection = outs && [...outs.values()].some((c) => c.category === "A")
        ? [...outs].map(([name, info]) => (info.category === "A" ? `to_json(${f}.${ident(name, "column")}) AS ${ident(name, "column")}` : `${f}.${ident(name, "column")}`)).join(", ")
        : "*";
      const rows = ((await this.sql.unsafe(`SELECT ${projection} FROM ${call} AS ${f}`, values as never[])) as unknown as Record<string, unknown>[]).map((r) => jsonShaped(r, outs));

      // What the function declares decides the shape, as it does for PostgREST (SMD-1602): a set-returning function
      // yields rows — one row of one column included, `[{ col: v }]`, where the old rule collapsed it to `v` and the
      // caller's `data.length` was a string's — unless its rows are scalars (`RETURNS SETOF int`), which PostgREST
      // lists bare; a scalar function yields its value, a function returning one composite row that row as an
      // object. Where the candidates disagree on `proretset`, or the function is unknown to the catalog, the shape is
      // the old rule's: one row of one column is the value.
      const sets = new Set(overloads.map((o) => o.returns.set));
      const set = sets.size === 1 ? [...sets][0] : undefined;
      if (set === true) {
        const scalarRows = overloads.every((o) => o.outs.size === 0 && !o.returns.table && !/^[CP]$/.test(o.returns.category));
        return { data: (scalarRows ? rows.map((r) => Object.values(r)[0]) : rows) as T, error: null, count: null };
      }
      if (set === false) {
        const row = rows[0] ?? null;
        return { data: (row && Object.keys(row).length === 1 ? Object.values(row)[0] : row) as T, error: null, count: null };
      }
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
