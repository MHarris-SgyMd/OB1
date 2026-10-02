/**
 * store.ts — the authorization server's state in one SQLite file (SMD-2285,
 * Work step 3): an oidc-provider adapter on bun:sqlite, so a restart keeps
 * every session, grant, refresh token and registered client. The library's
 * own memory adapter forgets them all, and keeps at most 1,000 entries.
 *
 * One table, one row per stored object, keyed by its model and id. Beside
 * the payload, the three columns the library looks things up by (a grant's
 * id, a session's uid, a device flow's user code) and the expiry the library
 * gives on every save. An expired row is never returned; PR 3 of the step
 * purges them. The file holds no secret the environment does not already
 * hold: the signing key, the cookie keys and the static clients' secrets stay
 * in deploy/.env, and a registered client's secret is its own.
 *
 * It behaves as the memory adapter does, which the proof of concept passed
 * against:
 * - `upsert` replaces a row whole, expiry included;
 * - `consume` stamps the payload's `consumed` with the time, which is how the
 *   library spots a replayed code or rotated refresh token;
 * - `revokeByGrantId` removes every grantable row of the grant, whichever
 *   model's adapter is asked (the library asks each in turn);
 * - `find`, `findByUid` and `findByUserCode` return a payload or `undefined`.
 *
 * WAL mode, so a backup's `VACUUM INTO` runs beside the server
 * (deploy/README.md, "Authorization server").
 *
 *   bun deploy/auth/store.ts --self-check   # the adapter's rules, on a scratch file (CI)
 */
import { Database } from "bun:sqlite";

/** The models whose rows a grant's revocation removes (the memory adapter's list). */
const GRANTABLE = ["AccessToken", "AuthorizationCode", "RefreshToken", "DeviceCode", "BackchannelAuthenticationRequest", "PreAuthorizedCode"];

type Payload = Record<string, unknown> & { grantId?: string; uid?: string; userCode?: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oidc (
  model TEXT NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  grant_id TEXT,
  uid TEXT,
  user_code TEXT,
  expires_at INTEGER,
  PRIMARY KEY (model, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS oidc_grant ON oidc (grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS oidc_uid ON oidc (model, uid) WHERE uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS oidc_user_code ON oidc (model, user_code) WHERE user_code IS NOT NULL;
`;

const nowS = () => Math.floor(Date.now() / 1000);

/**
 * The library's clock tolerance, in seconds: it accepts a token until its
 * `exp` plus this, and its memory adapter keeps a row as long. server.ts sets
 * the provider's `clockTolerance` from it, so the two cannot differ.
 */
export const CLOCK_TOLERANCE = 15;

/** The store's statements, prepared once: inside the open's `try`, so a table of another shape is refused there too. */
function prepare(db: Database) {
  const live = "(expires_at IS NULL OR expires_at > $now)";
  return {
    upsert: db.query(`INSERT INTO oidc (model, id, payload, grant_id, uid, user_code, expires_at) VALUES ($model, $id, $payload, $grant, $uid, $code, $exp)
      ON CONFLICT (model, id) DO UPDATE SET payload = excluded.payload, grant_id = excluded.grant_id, uid = excluded.uid, user_code = excluded.user_code, expires_at = excluded.expires_at`),
    find: db.query<{ payload: string }, { model: string; id: string; now: number }>(`SELECT payload FROM oidc WHERE model = $model AND id = $id AND ${live}`),
    byUid: db.query<{ payload: string }, { model: string; uid: string; now: number }>(`SELECT payload FROM oidc WHERE model = $model AND uid = $uid AND ${live}`),
    byCode: db.query<{ payload: string }, { model: string; code: string; now: number }>(`SELECT payload FROM oidc WHERE model = $model AND user_code = $code AND ${live}`),
    consume: db.query(`UPDATE oidc SET payload = json_set(payload, '$.consumed', $at) WHERE model = $model AND id = $id`),
    destroy: db.query(`DELETE FROM oidc WHERE model = $model AND id = $id`),
    revoke: db.query(`DELETE FROM oidc WHERE grant_id = $grant AND model IN (${GRANTABLE.map((m) => `'${m}'`).join(", ")})`),
  };
}

/**
 * Open (or create) the store at `path` and return the adapter factory
 * oidc-provider's `adapter` option takes: one adapter per model name, with
 * `close()` for a clean stop. A file that will not open as this store throws
 * one Error saying what to do. `clock` is for the self-check.
 */
export function sqliteAdapter(path: string, clock: () => number = nowS) {
  let db: Database;
  let q: ReturnType<typeof prepare>;
  try {
    db = new Database(path, { create: true, strict: true });
    // The wait first, so it covers the switch to WAL as well.
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    db.exec(SCHEMA);
    q = prepare(db);
  } catch (e) {
    const { code, message } = e as { code?: string; message: string };
    // A file the server cannot open or write is a permissions matter, and
    // dropping the volume would cost every sign-in for nothing; a file that
    // is not this store (corrupt, or another shape) is not.
    const what = code === "SQLITE_CANTOPEN" || code === "SQLITE_READONLY" || code === "SQLITE_PERM"
      ? "the server's user cannot open or write it: check the directory's owner (in the image, /data is bun's, mode 700) and the volume's"
      : "restore it from a backup, or remove the auth-data volume to start empty, after which every client signs in again";
    throw new Error(`the store at ${path} will not open (${code ?? "error"}: ${message}): ${what} (deploy/README.md, "Authorization server")`);
  }
  const parsed = (row: { payload: string } | null) => (row ? (JSON.parse(row.payload) as Payload) : undefined);

  const factory = (model: string) => ({
    async upsert(id: string, payload: Payload, expiresIn?: number) {
      q.upsert.run({
        model,
        id,
        payload: JSON.stringify(payload),
        grant: GRANTABLE.includes(model) ? (payload.grantId ?? null) : null,
        uid: payload.uid ?? null,
        code: payload.userCode ?? null,
        exp: typeof expiresIn === "number" ? clock() + expiresIn + CLOCK_TOLERANCE : null,
      });
    },
    async find(id: string) {
      return parsed(q.find.get({ model, id, now: clock() }));
    },
    async findByUid(uid: string) {
      return parsed(q.byUid.get({ model, uid, now: clock() }));
    },
    async findByUserCode(userCode: string) {
      return parsed(q.byCode.get({ model, code: userCode, now: clock() }));
    },
    async consume(id: string) {
      q.consume.run({ model, id, at: clock() });
    },
    async destroy(id: string) {
      q.destroy.run({ model, id });
    },
    async revokeByGrantId(grantId: string) {
      q.revoke.run({ grant: grantId });
    },
  });
  // The last connection's close checkpoints the WAL into the file (macOS's
  // SQLite then keeps the WAL file, empty; Linux's removes it). A second
  // close is a no-op.
  return Object.assign(factory, { close: () => db.close() });
}

/** The adapter's rules on a scratch file: each a named probe, the run failing on the first that does not hold. */
async function selfCheck(): Promise<number> {
  const { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "ob1-auth-store-"));
  const file = join(dir, "auth.sqlite");
  let failed = 0;
  const expect = (what: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : ` — ${detail}`}`);
    if (!ok) failed++;
  };
  try {
    let t = 1_000_000;
    const clock = () => t;
    let open = sqliteAdapter(file, clock);
    const session = open("Session");
    const code = open("AuthorizationCode");
    const refresh = open("RefreshToken");
    const access = open("AccessToken");
    const grant = open("Grant");
    const client = open("Client");
    const device = open("DeviceCode");

    await session.upsert("s1", { uid: "u1", accountId: "operator" }, 60);
    expect("a saved payload is found by its id", (await session.find("s1"))?.accountId === "operator");
    expect("a session is found by its uid", (await session.findByUid("u1"))?.accountId === "operator");
    await open("Interaction").upsert("i1", { uid: "u9" }, 60);
    await open("Interaction").upsert("i2", { userCode: "WXYZ-0000" }, 60);
    expect("a uid or user code another model holds finds nothing", (await session.findByUid("u9")) === undefined && (await open("DeviceCode").findByUserCode("WXYZ-0000")) === undefined);
    expect("an id another model holds is not found", (await code.find("s1")) === undefined);
    await session.upsert("s1", { uid: "u2", accountId: "operator", touched: true }, 60);
    expect("an upsert replaces the row whole, its uid included", (await session.findByUid("u1")) === undefined && (await session.findByUid("u2"))?.touched === true);

    t += 61;
    expect("a row past its expiry but inside the clock tolerance is still found, as the memory adapter keeps it", (await session.find("s1"))?.accountId === "operator");
    t += CLOCK_TOLERANCE;
    expect("an expired row is not found", (await session.find("s1")) === undefined && (await session.findByUid("u2")) === undefined);
    await session.upsert("s1", { uid: "u2", accountId: "operator" }, 60);
    expect("an expired row saved again is found again", (await session.find("s1"))?.accountId === "operator");

    await client.upsert("c1", { client_id: "c1", redirect_uris: ["https://client.example/cb"] });
    t += 10 * 365 * 86_400;
    expect("a row saved with no expiry never expires (a registered client)", (await client.find("c1"))?.client_id === "c1");

    await code.upsert("k1", { grantId: "g1", accountId: "operator" }, 60);
    await refresh.upsert("r1", { grantId: "g1" }, 3600);
    await access.upsert("a1", { grantId: "g1" }, 600);
    await refresh.upsert("r2", { grantId: "g2" }, 3600);
    await grant.upsert("g1", { accountId: "operator", grantId: "g1" }, 86_400);
    await code.consume("k1");
    const consumed = await code.find("k1");
    expect("consume stamps the payload's `consumed` with the time", consumed?.consumed === t && consumed?.accountId === "operator");
    await access.revokeByGrantId("g1");
    expect(
      "revoking a grant through one model's adapter removes every grantable row of it",
      (await code.find("k1")) === undefined && (await refresh.find("r1")) === undefined && (await access.find("a1")) === undefined,
    );
    expect("revoking a grant leaves another grant's rows", (await refresh.find("r2")) !== undefined);
    expect("revoking a grant leaves the Grant itself, which the library destroys on its own", (await grant.find("g1"))?.accountId === "operator");
    await grant.destroy("g1");
    expect("destroy removes the row", (await grant.find("g1")) === undefined);

    await device.upsert("d1", { userCode: "ABCD-EFGH", grantId: "g3" }, 600);
    expect("a device code is found by its user code", (await device.findByUserCode("ABCD-EFGH")) !== undefined);
    await device.upsert("d1", { userCode: "IJKL-MNOP", grantId: "g3" }, 600);
    expect("an upsert moves the user code with the row", (await device.findByUserCode("ABCD-EFGH")) === undefined && (await device.findByUserCode("IJKL-MNOP")) !== undefined);
    t += 601 + CLOCK_TOLERANCE;
    expect("an expired device code is not found by its user code", (await device.findByUserCode("IJKL-MNOP")) === undefined);

    await code.upsert("same", { accountId: "code" }, 60);
    await refresh.upsert("same", { accountId: "refresh" }, 60);
    await code.consume("same");
    await code.destroy("same");
    const other = await refresh.find("same");
    expect("consume and destroy touch only their own model's row of an id", other?.accountId === "refresh" && other?.consumed === undefined);

    open.close();
    open = sqliteAdapter(file, clock);
    expect("a second open of the file finds what the first saved (a restart)", (await open("Client").find("c1"))?.client_id === "c1" && (await open("RefreshToken").find("r2")) !== undefined);
    const look = new Database(file);
    expect("the file is in WAL mode, so a backup can run beside the server", look.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode === "wal");
    look.close();
    open.close();
    expect("close() checkpoints the WAL into the file, so a stop leaves nothing in it", !existsSync(`${file}-wal`) || statSync(`${file}-wal`).size === 0);
    let again = "";
    try {
      open.close();
    } catch (e) {
      again = (e as Error).message;
    }
    expect("a second close() is a no-op (a second stop signal)", again === "", again);
    const junk = join(dir, "junk.sqlite");
    await Bun.write(junk, "not a database, ".repeat(512));
    let refused = "";
    try {
      sqliteAdapter(junk, clock);
    } catch (e) {
      refused = (e as Error).message;
    }
    expect("a file that is not a store is refused with what to do", refused.includes(`the store at ${junk} will not open (SQLITE_NOTADB`) && refused.includes("restore it from a backup"), refused || "opened");
    const shaped = join(dir, "shaped.sqlite");
    new Database(shaped).exec("CREATE TABLE oidc (model TEXT, id TEXT, grant_id TEXT, uid TEXT, user_code TEXT)"); // indexable, so it fails at the statements, not the schema
    refused = "";
    try {
      sqliteAdapter(shaped, clock);
    } catch (e) {
      refused = (e as Error).message;
    }
    expect("a store of another shape is refused the same way, not with a bare error", refused.includes(`the store at ${shaped} will not open`) && refused.includes("restore it from a backup"), refused || "opened");
    const locked = join(dir, "locked");
    mkdirSync(locked, { mode: 0o500 });
    refused = "";
    try {
      sqliteAdapter(join(locked, "auth.sqlite"), clock);
    } catch (e) {
      refused = (e as Error).message;
    }
    chmodSync(locked, 0o700);
    // As root (a container's default) the directory's mode does not stop the open, and there is nothing to refuse.
    expect(
      "a directory the server cannot write is a permissions matter, with no advice to drop the volume",
      process.getuid?.() === 0 || (refused.includes("SQLITE_CANTOPEN") && refused.includes("check the directory's owner") && !refused.includes("remove the auth-data volume")),
      refused || "opened",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} probe(s) failed` : "\nall probes hold");
  return failed ? 1 : 0;
}

if (import.meta.main && process.argv.includes("--self-check")) process.exit(await selfCheck());
