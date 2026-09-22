/**
 * env.ts — the `.env` reader lives in db/env.ts since SMD-1954's fifth review
 * pass (db/sync-linear.ts reads it from inside a container that mounts db/ and
 * server-portable/, not evals/); this re-export keeps every eval's `./env.ts`
 * import where it was. The search path is unchanged: $OB1_ENV_FILE, evals/.env,
 * <repo>/.env, deploy/.env.
 */
export { describeEnv, envFiles, loadEnv, parseEnv } from "../db/env.ts";
