/**
 * search-path.ts — a search_path setting read as Postgres reads it, and the
 * statement that puts public on it (SMD-2242).
 *
 * Preflight's `schema` row, when `public.thoughts` exists but does not resolve
 * for the server's role, names the path's fix as a whole statement: the role's
 * own schemas, kept, with public added. The setting it starts from
 * (`current_setting('search_path')`) is the session's own text, from the role, the database or the connection. `SET` and
 * `ALTER ROLE … SET` store it re-quoted, but a connection string's `options`,
 * `set_config` and `SET search_path FROM CURRENT` store it as written. So it is
 * parsed, never echoed: an echoed path printed invalid SQL for an empty path
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

const publicLast = (schemas: string[]) => [...schemas.filter((s) => s !== "public").map(quoteIdent), "public"];

/** The path with public put on it: the role's schemas kept, in order, each quoted, and public last. */
export const withPublic = (schemas: string[]) => publicLast(schemas).join(", ");

/**
 * The same path as a connection string's `options` value, `-c search_path=…`,
 * percent-encoded: the form both Bun and libpq (psql, pg_dump) read — libpq
 * refuses a `search_path` URI parameter. No space between names, and a space
 * or backslash inside one escaped with a backslash, since `options` splits on
 * whitespace.
 */
export const withPublicInOptions = (schemas: string[]) =>
  encodeURIComponent(`-csearch_path=${publicLast(schemas).join(",").replace(/[\\ \t\n\r\f\v]/g, (c) => `\\${c}`)}`);
