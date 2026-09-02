/**
 * compat/supabase-sql — a supabase-js-shaped client that speaks SQL.
 *
 * The problem this solves: 54 files outside the core server call PostgREST through
 * supabase-js, across 33,000 lines. Hand-porting them to SQL is weeks of work on
 * code that is mostly community recipes, and it would fork every one of them away
 * from upstream permanently.
 *
 * But the API surface they use is small and closed — about twenty methods, and
 * measurably so: `.from .select .insert .update .upsert .delete .rpc`, ten
 * filters, and five modifiers. That is shimmable. With this module a file migrates
 * by changing one line:
 *
 *     - import { createClient } from "@supabase/supabase-js";
 *     + import { createClient } from "../../compat/supabase-sql/index.ts";
 *
 * and passing a Postgres URL where it passed a project URL. The rest of the file
 * is untouched, which keeps it mergeable from upstream.
 *
 * ── What is deliberately NOT supported ───────────────────────────────────────
 * PostgREST resource embedding — `.select("*, other_table(*)")` — needs foreign
 * key introspection to become a join. Three of the 54 files use it. Rather than
 * guess and return subtly wrong rows, those selects throw with a message saying
 * so. Silently mishandling a join is exactly the failure class this migration has
 * been removing.
 *
 * Also unsupported, because nothing in the repo uses them: `.auth`, `.storage`,
 * `.channel`, `.functions.invoke`.
 *
 * ── Error convention ─────────────────────────────────────────────────────────
 * supabase-js resolves with `{ data, error }` and does not throw. This matches
 * that exactly, including on SQL errors, so existing `if (error)` branches keep
 * working. Programming errors — an invalid identifier, an embedded select — throw,
 * because they are bugs in the caller rather than runtime conditions.
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

/** `"id, content, metadata"` → `"id", "content", "metadata"`. Rejects embeds. */
function columnList(cols: string): string {
  const spec = cols.trim();
  if (spec === "" || spec === "*") return "*";
  if (/\(/.test(spec)) {
    throw new Error(
      `compat/supabase-sql: select("${spec}") uses PostgREST resource embedding, which ` +
        `needs foreign-key introspection to become a SQL join and is not supported. ` +
        `Write the join as an explicit .rpc() or a SQL view instead.`
    );
  }
  return spec
    .split(",")
    .map((c) => {
      const bare = c.trim();
      // `count` is a PostgREST pseudo-column; callers use it via { count: "exact" }.
      if (bare === "*") return "*";
      return ident(bare, "column");
    })
    .join(", ");
}

/**
 * Normalise a Bun.sql error into the shape supabase-js callers expect.
 *
 * Bun reports the Postgres SQLSTATE in `errno` and puts a generic
 * "ERR_POSTGRES_SERVER_ERROR" in `code`. PostgREST puts the SQLSTATE in `code`,
 * and recipes branch on it — `error.code === "23505"` for a duplicate key is a
 * common pattern. Map it across, or every one of those branches silently stops
 * matching.
 */
function toPostgrestError(e: unknown): { message: string; code?: string } {
  const err = e as { message?: string; code?: string; errno?: string | number; detail?: string };
  const sqlstate = err?.errno !== undefined ? String(err.errno) : undefined;
  return {
    message: err?.message ?? String(e),
    // Prefer the SQLSTATE; fall back to Bun's marker when there is no server error.
    code: /^[0-9A-Z]{5}$/.test(sqlstate ?? "") ? sqlstate : err?.code,
  };
}

type Filter = { sql: string; values: unknown[] };
type Op = "select" | "insert" | "update" | "upsert" | "delete";

export type Result<T> = { data: T | null; error: { message: string; code?: string } | null; count: number | null };

export class QueryBuilder<T = Record<string, unknown>[]> implements PromiseLike<Result<T>> {
  private op: Op = "select";
  private cols = "*";
  private filters: Filter[] = [];
  private orderBy: string[] = [];
  private limitN: number | null = null;
  private offsetN: number | null = null;
  private payload: Record<string, unknown>[] = [];
  private conflictTarget: string | null = null;
  private wantCount: "exact" | null = null;
  private headOnly = false;
  private rowMode: "many" | "single" | "maybeSingle" = "many";

  constructor(private sql: SQL, private table: string) {}

  // ── verbs ──────────────────────────────────────────────────────────────────

  select(cols = "*", opts?: { count?: "exact" | "planned" | "estimated"; head?: boolean }): this {
    // `.select()` after insert/update/delete means RETURNING, not a new query.
    if (this.op === "select") this.op = "select";
    this.cols = columnList(cols);
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

  private cmp(col: string, operator: string, value: unknown): this {
    this.filters.push({ sql: `${ident(col, "column")} ${operator} ?`, values: [value] });
    return this;
  }

  eq(c: string, v: unknown) { return this.cmp(c, "=", v); }
  neq(c: string, v: unknown) { return this.cmp(c, "<>", v); }
  gt(c: string, v: unknown) { return this.cmp(c, ">", v); }
  gte(c: string, v: unknown) { return this.cmp(c, ">=", v); }
  lt(c: string, v: unknown) { return this.cmp(c, "<", v); }
  lte(c: string, v: unknown) { return this.cmp(c, "<=", v); }
  like(c: string, v: string) { return this.cmp(c, "LIKE", v); }
  ilike(c: string, v: string) { return this.cmp(c, "ILIKE", v); }

  is(c: string, v: null | boolean): this {
    // `IS` takes a literal, not a parameter.
    const lit = v === null ? "NULL" : v ? "TRUE" : "FALSE";
    this.filters.push({ sql: `${ident(c, "column")} IS ${lit}`, values: [] });
    return this;
  }

  in(c: string, values: unknown[]): this {
    if (values.length === 0) {
      this.filters.push({ sql: "FALSE", values: [] }); // matches PostgREST: in.() selects nothing
      return this;
    }
    this.filters.push({
      sql: `${ident(c, "column")} IN (${values.map(() => "?").join(", ")})`,
      values: [...values],
    });
    return this;
  }

  /**
   * jsonb containment — PostgREST's `.contains()` on a jsonb column is `@>`.
   *
   * The value is bound as an OBJECT, never a pre-stringified one. Bun.sql sends a
   * JS string to a jsonb parameter as a JSON scalar string, so `JSON.stringify()`
   * here would make the comparison `object @> string`, which is always false and
   * returns zero rows with no error. That is the same double-encoding trap
   * db/migrations/005 rejects at the database.
   */
  contains(c: string, v: Record<string, unknown> | unknown[] | string): this {
    this.filters.push({
      sql: `${ident(c, "column")} @> ?::jsonb`,
      values: [typeof v === "string" ? v : (v as unknown)],
    });
    return this;
  }

  /**
   * PostgREST's `.or("a.gt.1,b.is.null")` — a flat list of `column.op.value`
   * terms combined with OR.
   *
   * Only the flat form is supported. PostgREST also allows nesting —
   * `or(and(a.eq.1,b.eq.2),c.eq.3)` — which needs a real parser, and every `.or()`
   * in this repo is flat. Anything else throws rather than being half-understood.
   */
  or(expression: string): this {
    if (/\band\s*\(|\bor\s*\(/.test(expression)) {
      throw new Error(
        `compat/supabase-sql: or("${expression}") uses nested and()/or() grouping, ` +
          `which is not supported. Express it as an .rpc() or split the query.`
      );
    }

    const ops: Record<string, string> = {
      eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", ilike: "ILIKE",
    };
    const values: unknown[] = [];
    const terms = expression.split(",").map((raw) => {
      const term = raw.trim();
      const firstDot = term.indexOf(".");
      const secondDot = term.indexOf(".", firstDot + 1);
      if (firstDot < 1 || secondDot < 0) {
        throw new Error(`compat/supabase-sql: or() term "${term}" is not column.operator.value`);
      }
      const col = ident(term.slice(0, firstDot), "column");
      const op = term.slice(firstDot + 1, secondDot);
      const value = term.slice(secondDot + 1);

      if (op === "is") {
        const lit = value === "null" ? "NULL" : value === "true" ? "TRUE" : value === "false" ? "FALSE" : null;
        if (lit === null) throw new Error(`compat/supabase-sql: or() "is.${value}" must be null, true or false`);
        return `${col} IS ${lit}`;
      }
      const sqlOp = ops[op];
      if (!sqlOp) throw new Error(`compat/supabase-sql: or() operator "${op}" is not supported`);
      values.push(value);
      return `${col} ${sqlOp} ?`;
    });

    this.filters.push({ sql: `(${terms.join(" OR ")})`, values });
    return this;
  }

  /** Equality across several columns at once. */
  match(criteria: Record<string, unknown>): this {
    for (const [c, v] of Object.entries(criteria)) this.cmp(c, "=", v);
    return this;
  }

  // ── modifiers ──────────────────────────────────────────────────────────────

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    const dir = opts?.ascending === false ? "DESC" : "ASC";
    const nulls = opts?.nullsFirst === undefined ? "" : opts.nullsFirst ? " NULLS FIRST" : " NULLS LAST";
    this.orderBy.push(`${ident(col, "column")} ${dir}${nulls}`);
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

  /** Renders `?` placeholders as $1..$n in order. */
  private render(parts: string, values: unknown[]): { text: string; values: unknown[] } {
    let i = 0;
    return { text: parts.replace(/\?/g, () => `$${++i}`), values };
  }

  private whereClause(startAt: number): { text: string; values: unknown[] } {
    if (this.filters.length === 0) return { text: "", values: [] };
    const values: unknown[] = [];
    let i = startAt;
    const clauses = this.filters.map((f) => {
      const rendered = f.sql.replace(/\?/g, () => `$${++i}`);
      values.push(...f.values);
      return rendered;
    });
    return { text: ` WHERE ${clauses.join(" AND ")}`, values };
  }

  private build(): { text: string; values: unknown[] } {
    const t = ident(this.table, "table");

    if (this.op === "select") {
      const projection = this.headOnly && this.wantCount ? "count(*)::int AS __count" : this.cols;
      const where = this.whereClause(0);
      let text = `SELECT ${projection} FROM ${t}${where.text}`;
      if (!this.headOnly) {
        if (this.orderBy.length) text += ` ORDER BY ${this.orderBy.join(", ")}`;
        if (this.limitN !== null) text += ` LIMIT ${Number(this.limitN)}`;
        if (this.offsetN !== null) text += ` OFFSET ${Number(this.offsetN)}`;
      }
      return { text, values: where.values };
    }

    if (this.op === "insert" || this.op === "upsert") {
      // Union of keys across rows, so a heterogeneous batch still inserts.
      const cols = [...new Set(this.payload.flatMap((r) => Object.keys(r)))];
      if (cols.length === 0) throw new Error("compat/supabase-sql: insert() called with no columns");
      const quoted = cols.map((c) => ident(c, "column"));
      const values: unknown[] = [];
      let i = 0;
      const tuples = this.payload.map(
        (row) => `(${cols.map((c) => { values.push(row[c] ?? null); return `$${++i}`; }).join(", ")})`
      );
      let text = `INSERT INTO ${t} (${quoted.join(", ")}) VALUES ${tuples.join(", ")}`;
      if (this.op === "upsert") {
        const target = this.conflictTarget
          ? this.conflictTarget.split(",").map((c) => ident(c, "conflict column")).join(", ")
          : quoted[0];
        const sets = quoted.filter((c) => c !== `"${this.conflictTarget}"`).map((c) => `${c} = EXCLUDED.${c}`);
        text += ` ON CONFLICT (${target}) DO ${sets.length ? `UPDATE SET ${sets.join(", ")}` : "NOTHING"}`;
      }
      text += ` RETURNING ${this.cols}`;
      return { text, values };
    }

    if (this.op === "update") {
      const row = this.payload[0] ?? {};
      const cols = Object.keys(row);
      if (cols.length === 0) throw new Error("compat/supabase-sql: update() called with no columns");
      const values: unknown[] = [];
      let i = 0;
      const sets = cols.map((c) => { values.push(row[c]); return `${ident(c, "column")} = $${++i}`; });
      const where = this.whereClause(i);
      return {
        text: `UPDATE ${t} SET ${sets.join(", ")}${where.text} RETURNING ${this.cols}`,
        values: [...values, ...where.values],
      };
    }

    const where = this.whereClause(0);
    return { text: `DELETE FROM ${t}${where.text} RETURNING ${this.cols}`, values: where.values };
  }

  /** Exposed for tests and for anyone debugging what the shim generates. */
  toSQL(): { text: string; values: unknown[] } {
    return this.build();
  }

  /**
   * Runs the query. May reject: a caller bug (bad identifier, embedded select)
   * rejects, while a runtime SQL failure resolves as `{ error }` the way
   * supabase-js does.
   */
  private async execute(): Promise<Result<T>> {
    let text: string;
    let values: unknown[];
    // Compilation happens outside the try so a programming error propagates as a
    // rejection rather than being reported as a database error.
    ({ text, values } = this.build());

    try {
      const rows = (await this.sql.unsafe(text, values as never[])) as unknown as Record<string, unknown>[];

      if (this.headOnly && this.wantCount) {
        return { data: null, error: null, count: Number(rows[0]?.__count ?? 0) };
      }
      if (this.rowMode !== "many") {
        if (rows.length === 0) {
          return this.rowMode === "single"
            ? { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" }, count: null }
            : { data: null, error: null, count: null };
        }
        return { data: rows[0] as T, error: null, count: null };
      }
      return { data: rows as T, error: null, count: this.wantCount ? rows.length : null };
    } catch (e) {
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

export class SupabaseSqlClient {
  readonly sql: SQL;

  constructor(databaseUrl: string, opts: { max?: number } = {}) {
    this.sql = new SQL({ url: databaseUrl, max: opts.max ?? Number(process.env.OB1_PG_POOL ?? 10) });
  }

  from<T = Record<string, unknown>[]>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this.sql, table);
  }

  /** Calls a stored function by name with named arguments, as PostgREST does. */
  async rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
    try {
      const names = Object.keys(args);
      const call = names.length
        ? `${ident(fn, "function")}(${names.map((n, i) => `${ident(n, "argument")} => $${i + 1}`).join(", ")})`
        : `${ident(fn, "function")}()`;
      // Argument binding has to split by shape, because Bun gets each one wrong
      // in a different direction and PostgREST gets both right by accident: it
      // sends a JSON body and lets Postgres coerce to the declared parameter type.
      //
      //   NUMERIC ARRAYS — an embedding for a `vector` parameter. Bun binds a JS
      //   array as a Postgres array literal, and `{1,0,0}` is not valid `vector`
      //   input. Passed as JSON text, `[1,0,0]`, Postgres coerces it correctly.
      //
      //   EVERYTHING ELSE — arrays of objects, and objects, for `jsonb`
      //   parameters. These must NOT be pre-stringified: Bun binds a JS string to
      //   jsonb as a JSON *scalar string*, so `jsonb_array_length` then fails with
      //   "cannot get array length of a scalar". Bun serialises the value itself
      //   correctly, so hand it over untouched.
      //
      // The split is a heuristic, not introspection. A numeric array genuinely
      // destined for a `jsonb` parameter would arrive as text and a real
      // Postgres array parameter (`int[]`) would need `{1,2}` rather than
      // `[1,2]`; nothing in this repo has either. A caller that grows one wants an
      // explicit cast in its own SQL rather than more guessing here.
      const values = names.map((n) => {
        const v = args[n];
        const numeric = Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number");
        return numeric ? JSON.stringify(v) : v;
      });
      const rows = (await this.sql.unsafe(`SELECT * FROM ${call}`, values as never[])) as unknown as Record<string, unknown>[];

      // A set-returning function yields rows; a scalar one yields a single column
      // holding the value. PostgREST makes the same distinction.
      if (rows.length === 1 && Object.keys(rows[0]).length === 1) {
        const only = Object.values(rows[0])[0];
        return { data: only as T, error: null, count: null };
      }
      return { data: rows as T, error: null, count: null };
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("compat/supabase-sql:")) throw e;
      return { data: null, error: toPostgrestError(e), count: null };
    }
  }

  async close(): Promise<void> {
    await this.sql.close();
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
