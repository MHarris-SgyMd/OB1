/**
 * search-path.ts — a search_path setting read as Postgres reads it, and the
 * statement that puts public on it (SMD-2242), and pgvector's schema (SMD-2238).
 *
 * Preflight's `schema` row, when `public.thoughts` exists but does not resolve
 * for the server's role, names the path's fix as a whole statement: the role's
 * own schemas, kept, with public added. Its `vector extension` row, when
 * pgvector's schema is off the path, names the same statement with that schema
 * added too: on one screen the two rows print one statement, and either, run,
 * mends both. The setting it starts from
 * (`current_setting('search_path')`) is the session's own text, from the role,
 * the database or the connection. `SET` and `ALTER ROLE … SET` store it
 * re-quoted, but a connection string's `options`, `set_config` and `SET
 * search_path FROM CURRENT` store it as written. So it is parsed, never
 * echoed: an echoed path printed invalid SQL for an empty path
 * (which reads back as `""`) and for a raw `$user`, and pasted a stored
 * `x;drop …;--` into the remedy an operator runs.
 *
 * The parse is Postgres's SplitIdentifierString: names separated by commas;
 * whitespace around each, as scanner_isspace sees it — space, tab, newline,
 * carriage return and form feed, and from PostgreSQL 17 vertical tab, nothing
 * outside ASCII; a quoted name kept as written, `""` inside it a quote; an
 * unquoted name folded A–Z only, as downcase_identifier does in a UTF-8
 * database. The empty name a `''` path reads back as is dropped. Settings
 * Postgres rejects (`a,,b`, `a b`, an unterminated quote) never reach here: its
 * check hook refuses them on every route.
 */

/**
 * A search_path setting's schemas, in order, as Postgres resolves them.
 * `serverVersionNum` is the server's `server_version_num`: 17 counts a
 * vertical tab as whitespace, 16 reads it as part of a name.
 */
export function searchPathSchemas(setting: string, serverVersionNum: number): string[] {
  const isSpace = (c: string | undefined) =>
    c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || (c === "\v" && serverVersionNum >= 170000);
  const names: string[] = [];
  let i = 0;
  while (i < setting.length) {
    while (isSpace(setting[i])) i++;
    let name = "";
    if (setting[i] === '"') {
      for (i++; i < setting.length; i++) {
        if (setting[i] !== '"') name += setting[i];
        else if (setting[i + 1] === '"') { name += '"'; i++; }
        else { i++; break; }
      }
    } else {
      while (i < setting.length && setting[i] !== "," && !isSpace(setting[i])) name += setting[i++];
      name = name.replace(/[A-Z]+/g, (m) => m.toLowerCase());
    }
    while (i < setting.length && setting[i] !== ",") i++;
    i++;
    if (name !== "") names.push(name);
  }
  return names;
}

/** An identifier, always double-quoted: valid for any name, `$user` among them, which a search_path needs quoted. */
export const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * The mended path: the role's schemas kept, in order, each quoted but public;
 * public where it stands, or last; then `extension` (pgvector's schema), when it is
 * another and not on the path already. Nothing is moved, so the role's own
 * names resolve as before.
 */
const mended = (schemas: string[], extension?: string | null) => [
  ...schemas.map((s) => (s === "public" ? s : quoteIdent(s))),
  ...(schemas.includes("public") ? [] : ["public"]),
  ...(extension && extension !== "public" && !schemas.includes(extension) ? [quoteIdent(extension)] : []),
];

/** The path with public (and pgvector's schema, when given) put on it: see `mended`. */
export const withPublic = (schemas: string[], extension?: string | null) => mended(schemas, extension).join(", ");

/**
 * The same path as a connection string's `options` value, `-c search_path=…`,
 * percent-encoded: the form both Bun and libpq (psql, pg_dump) read — libpq
 * refuses a `search_path` URI parameter. No space between names, and a space
 * or backslash inside one escaped with a backslash, since `options` splits on
 * whitespace; the characters encodeURIComponent leaves bare that a shell
 * reads (`!'()*~`) encoded too, so the value pastes safely.
 */
export const withPublicInOptions = (schemas: string[], extension?: string | null) =>
  encodeURIComponent(`-csearch_path=${mended(schemas, extension).join(",").replace(/[\\ \t\n\r\f\v]/g, (c) => `\\${c}`)}`)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The fix that makes the mended path the connection's, as a remedy line.
 * `login` (session_user), `role` (current_user) and `db` come quoted, as
 * quote_ident gives them; `source` is pg_settings' for search_path, or null
 * when the role may not read it.
 *
 * - An `ALTER ROLE` on the login role, whose settings load — not a role its
 *   settings SET ROLE to — `IN DATABASE`, since a role's setting there outranks
 *   its plain one and the database's. A superuser, a CREATEROLE role (from
 *   PostgreSQL 16, one with ADMIN on it), or the login role itself may run it;
 *   under a SET ROLE the login role drops it first (`RESET ROLE` returns to the
 *   role its settings SET), and neither the role it becomes nor the database's
 *   owner may.
 * - Source `client`: the connection string sets the path (a `search_path=`
 *   parameter, or `-c search_path=` in `options=`) and outranks every ALTER
 *   ROLE, so that setting is replaced, never appended to: Bun joins two
 *   options with a comma, libpq keeps the last, and Bun's `search_path=`
 *   outranks options.
 * - Source `session` (a pooler replaying the connection string's, a login
 *   trigger) or unread: the statement, with that caveat.
 */
export function pathFix(p: { schemas: string[]; extension?: string | null; login: string; role: string; db: string; source: string | null }): string {
  const path = withPublic(p.schemas, p.extension);
  const alter = p.login !== p.role
    ? `SET ROLE NONE; ALTER ROLE ${p.login} IN DATABASE ${p.db} SET search_path = ${path};  (as ${p.login}, or a superuser)`
    : `ALTER ROLE ${p.login} IN DATABASE ${p.db} SET search_path = ${path};`;
  return p.source === "client"
    ? `the connection string sets search_path (a search_path= parameter, or -c search_path= in options=), which outranks any ALTER ROLE: remove that and put this in options=, beside any other -c setting there (separated by %20): ${withPublicInOptions(p.schemas, p.extension)}`
    : p.source === "session"
    ? `${alter}  (this session's path was SET after login — by a pooler replaying the connection string's, or a login trigger — which outranks it; change it there)`
    : p.source === null
    ? `${alter}  (unless the connection string sets search_path, which outranks it)`
    : alter;
}
