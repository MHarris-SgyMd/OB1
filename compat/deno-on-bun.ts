/**
 * compat/deno-on-bun.ts — Deno's two globals the shim-migrated files use, on Bun.
 *
 * Fix 13's codemod moved a file off supabase-js onto compat/supabase-sql by
 * changing one import line, and the shim imports `bun`. The files it migrated
 * were written as Supabase Edge Functions: they read their environment through
 * `Deno.env.get` and end in `Deno.serve`. So as fix 13 left them they ran
 * nowhere — Deno cannot resolve `bun`, and Bun has no `Deno` (SMD-1480,
 * FORK.md change 74). This module is the second one-line change: imported
 * first, it gives Bun exactly the two members those files use, and the file
 * runs as written —
 *
 *     bun extensions/home-maintenance/index.ts
 *
 * with SUPABASE_URL a postgres:// connection string (the shim's convention),
 * the access keys in MCP_ACCESS_KEYS, and PORT the port to listen on (8000,
 * Deno's default, when unset). scripts/migrate-to-sql-shim.ts adds and
 * removes the import; check 11 of scripts/check-fork-consistency.ts holds it
 * as a file's first import, so nothing the file imports reads `Deno.env`
 * before it is defined.
 *
 * Deliberately no more than the two: `Deno.readTextFile`, `Deno.args`,
 * `Deno.exit` and the rest stay undefined, so a migrated file that starts
 * using one fails at the call with "Deno.readTextFile is not a function" —
 * loud, at the line — rather than running on a quiet emulation of an API
 * whose semantics differ. Check 11 refuses those uses in the text as well.
 * Nothing is installed where `Deno` already exists: on Deno itself (where the
 * shim's `bun` import fails anyway), and under extensions/test-auth.ts and
 * extensions/test-writes.ts, whose own stand-in captures the handler instead
 * of listening and is installed before any server is imported.
 *
 *   Deno.env.get(name)            → process.env[name]
 *   Deno.serve(handler)           → Bun.serve({ fetch: handler, port: PORT ?? 8000 })
 *   Deno.serve({ port, hostname }, handler)
 *   Deno.serve({ port, hostname, handler })
 *                                 → the same, the options winning over PORT
 *
 * `Deno.serve` returns what Deno's does in the two respects a file could
 * read: `finished`, a promise that resolves when the server stops, and
 * `shutdown()`, which stops it. It prints Deno's `Listening on http://…/`
 * line. Anything else on Deno's `HttpServer` is absent, as are the options
 * no shim file uses: `onListen` and `signal` are ignored.
 */

type Handler = (req: Request) => Response | Promise<Response>;
type ServeOptions = { port?: number; hostname?: string; handler?: Handler };

if (!("Deno" in globalThis)) {
  const serve = (a: Handler | ServeOptions, b?: Handler) => {
    const opts: ServeOptions = typeof a === "function" ? {} : a;
    const handler = typeof a === "function" ? a : (b ?? a.handler);
    if (typeof handler !== "function") throw new TypeError("compat/deno-on-bun: Deno.serve needs a handler");
    if (typeof Bun === "undefined") throw new Error("compat/deno-on-bun: Deno.serve runs under Bun (the SQL shim is Bun's client) — `bun <file>`");
    // An empty PORT is unset, not port 0 (which would be a random port, silently).
    const port = opts.port ?? (process.env.PORT ? Number(process.env.PORT) : 8000);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`compat/deno-on-bun: PORT must be a port number, not ${JSON.stringify(process.env.PORT)}`);
    const server = Bun.serve({ fetch: handler, port, hostname: opts.hostname });
    let stopped: () => void = () => {};
    const finished = new Promise<void>((resolve) => { stopped = resolve; });
    console.log(`Listening on http://${server.hostname}:${server.port}/`);
    return {
      finished,
      addr: { transport: "tcp", hostname: server.hostname, port: server.port },
      shutdown: async () => { await server.stop(); stopped(); },
    };
  };
  Object.defineProperty(globalThis, "Deno", {
    value: { env: { get: (name: string) => process.env[name] }, serve },
    configurable: true, enumerable: false, writable: true,
  });
}
