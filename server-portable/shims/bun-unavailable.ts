/**
 * Workers-only stub for the `bun` module.
 *
 * store-sql.ts imports Bun's Postgres client. store.ts only imports that module
 * dynamically, and Workers never selects the SQL store (wrangler.toml pins
 * OB1_STORE=postgrest) — but wrangler's bundler resolves dynamic imports
 * statically, so the build fails on `Could not resolve "bun"` unless the
 * specifier maps to something.
 *
 * Mapped here via `[alias]` in wrangler.toml. Nothing in this file should ever
 * run: reaching it means a Workers deployment selected the SQL store — by
 * setting OB1_STORE=sql, or by losing the binding and getting the server's
 * default (change 94) — which cannot work: Workers has no TCP connection pool.
 * Fail loudly and say so rather than returning a broken client.
 */

const message =
  "The SQL store is not supported on Cloudflare Workers: it needs a pooled Postgres " +
  "connection, which Workers cannot hold. wrangler.toml sets OB1_STORE=postgrest for this " +
  "target — a deployment that unset or overrode it, or one whose OB1_STORE binding is missing, " +
  "gets the SQL store the server defaults to (change 94) and lands here. Set OB1_STORE=postgrest " +
  "on Workers, or deploy to a container runtime (Bun) for the SQL store.";

export class SQL {
  constructor() {
    throw new Error(message);
  }
}

export default { SQL };
