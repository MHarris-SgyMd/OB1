/**
 * Workers-only stub for the `bun` module.
 *
 * store-sql.ts imports Bun's Postgres client. store.ts only imports that module
 * dynamically, and Workers never selects the SQL store — but wrangler's bundler
 * resolves dynamic imports statically, so the build fails on `Could not resolve
 * "bun"` unless the specifier maps to something.
 *
 * Mapped here via `[alias]` in wrangler.toml. Nothing in this file should ever
 * run: reaching it means a Workers deployment was configured with OB1_STORE=sql,
 * which cannot work — Workers has no TCP connection pool. Fail loudly and say so
 * rather than returning a broken client.
 */

const message =
  "OB1_STORE=sql is not supported on Cloudflare Workers: it needs a pooled Postgres " +
  "connection, which Workers cannot hold. Use OB1_STORE=postgrest here, or deploy to " +
  "a container runtime (Bun or Node) for the SQL store.";

export class SQL {
  constructor() {
    throw new Error(message);
  }
}

export default { SQL };
