/**
 * store.ts — the authorization server's state in one SQLite file (SMD-2285,
 * Work step 3): an oidc-provider adapter on bun:sqlite, so a restart keeps
 * every session, grant, refresh token and registered client. The library's
 * own memory adapter forgets them all, and keeps at most 1,000 entries.
 *
 * One table, one row per stored object, keyed by its model and id. Beside
 * the payload, the three columns the library looks things up by (a grant's
 * id, a session's uid, a device flow's user code) and the expiry the library
 * gives on every save. An expired row is never returned, and `purge()` deletes
 * it a day later, with every registered client that has had nothing of its
 * own alive for a day. The file holds no secret the environment does not already
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
 * Beyond the library's contract, for the server (SMD-2285's third cut):
 * - `countClients()`, the registered clients stored, which the server holds
 *   to OB1_AUTH_MAX_CLIENTS;
 * - `purge()`, which the server runs once listening and hourly. Registration is
 *   open, as MCP clients expect, so without it the clients of abandoned
 *   sign-ins, and of anyone registering for the sake of it, would fill the
 *   cap for good. A client is idle once it is more than a day old and
 *   nothing that names it (a grant, a code, a refresh token, a sign-in under
 *   way) has been alive for a day; it goes with its registration access
 *   token. The static clients are
 *   configuration, not rows, and a metadata-document client is never stored.
 *
 * WAL mode, so a backup's `VACUUM INTO` runs beside the server
 * (deploy/README.md, "Authorization server").
 *
 *   bun deploy/auth/store.ts --self-check   # the adapter's rules, on a scratch file (CI)
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * A day, in seconds: how long an expired row is kept before purge() deletes
 * it, and how long a registered client is kept with nothing of its own
 * alive. Keeping expired rows the day is what lets purge() see that a
 * client's last grant lapsed less than a day ago.
 */
export const IDLE_S = 86_400;

/**
 * A JSON path read that cannot throw: NULL for a payload SQLite will not
 * parse. SQLite refuses JSON nested past 1,000 levels (2,000 on older builds),
 * which JSON.parse takes, and a client's registration can carry that: one
 * such row made every purge throw, for good (review, measured). upsert()
 * refuses such a payload; this keeps a row written before that, or by hand,
 * from stopping the purge.
 */
const read = (col: string, path: string) => `CASE WHEN json_valid(${col}) THEN json_extract(${col}, '${path}') END`;

/** The store's statements, prepared once: inside the open's `try`, so a table of another shape is refused there too. */
function prepare(db: Database) {
  const live = "(expires_at IS NULL OR expires_at > $now)";
  return {
    readable: db.query<{ ok: number }, { payload: string }>(`SELECT json_valid($payload) AS ok`),
    upsert: db.query(`INSERT INTO oidc (model, id, payload, grant_id, uid, user_code, expires_at) VALUES ($model, $id, $payload, $grant, $uid, $code, $exp)
      ON CONFLICT (model, id) DO UPDATE SET payload = excluded.payload, grant_id = excluded.grant_id, uid = excluded.uid, user_code = excluded.user_code, expires_at = excluded.expires_at`),
    find: db.query<{ payload: string }, { model: string; id: string; now: number }>(`SELECT payload FROM oidc WHERE model = $model AND id = $id AND ${live}`),
    byUid: db.query<{ payload: string }, { model: string; uid: string; now: number }>(`SELECT payload FROM oidc WHERE model = $model AND uid = $uid AND ${live}`),
    byCode: db.query<{ payload: string }, { model: string; code: string; now: number }>(`SELECT payload FROM oidc WHERE model = $model AND user_code = $code AND ${live}`),
    consume: db.query(`UPDATE oidc SET payload = json_set(payload, '$.consumed', $at) WHERE model = $model AND id = $id`),
    destroy: db.query(`DELETE FROM oidc WHERE model = $model AND id = $id`),
    revoke: db.query(`DELETE FROM oidc WHERE grant_id = $grant AND model IN (${GRANTABLE.map((m) => `'${m}'`).join(", ")})`),
    countClients: db.query<{ n: number }, []>(`SELECT count(*) AS n FROM oidc WHERE model = 'Client'`),
    // A client older than $before that nothing alive since $before names: a
    // grant, a code or a refresh token (by its clientId), or a sign-in under
    // way (an interaction, by its request's client_id). Its registration access
    // token does not count: it never expires, and it is the client's own, not
    // a use of it. One pass over the table for the names in use, not one per
    // client: per client, a purge of 200 clients over 300,000 rows took 10 s
    // with the server answering nothing (bun:sqlite is synchronous), measured.
    idleClients: db.query<{ id: string }, { before: number }>(`SELECT c.id FROM oidc c WHERE c.model = 'Client'
      AND coalesce(${read("c.payload", "$.client_id_issued_at")}, 0) <= $before
      AND c.id NOT IN (
        SELECT ${read("r.payload", "$.clientId")} FROM oidc r WHERE r.model NOT IN ('Client', 'RegistrationAccessToken', 'Interaction')
          AND (r.expires_at IS NULL OR r.expires_at > $before) AND ${read("r.payload", "$.clientId")} IS NOT NULL
        UNION
        SELECT ${read("i.payload", "$.params.client_id")} FROM oidc i WHERE i.model = 'Interaction'
          AND (i.expires_at IS NULL OR i.expires_at > $before) AND ${read("i.payload", "$.params.client_id")} IS NOT NULL)`),
    // Every idle client and every row naming one, in one statement ($ids a JSON array).
    dropClients: db.query(`DELETE FROM oidc WHERE (model = 'Client' AND id IN (SELECT value FROM json_each($ids)))
      OR ${read("payload", "$.clientId")} IN (SELECT value FROM json_each($ids))`),
    dropExpired: db.query(`DELETE FROM oidc WHERE expires_at IS NOT NULL AND expires_at <= $before`),
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
      const json = JSON.stringify(payload);
      // A payload SQLite cannot read (nested past its depth limit) would stop the purge: refused, so the library's save fails and nothing is stored.
      if (!q.readable.get({ payload: json })?.ok) throw new Error(`the store refuses a ${model} payload SQLite cannot read as JSON (nested too deep)`);
      q.upsert.run({
        model,
        id,
        payload: json,
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
  /** One pass, in one transaction: idle clients (with everything that names them), then rows expired a day ago. */
  const purge = db.transaction(() => {
    const before = clock() - IDLE_S;
    const idle = q.idleClients.all({ before }).map((r) => r.id);
    if (idle.length) q.dropClients.run({ ids: JSON.stringify(idle) });
    const expired = q.dropExpired.run({ before }).changes;
    return { clients: idle.length, expired };
  });
  return Object.assign(factory, {
    // The last connection's close checkpoints the WAL into the file (macOS's
    // SQLite then keeps the WAL file, empty; Linux's removes it). A second
    // close is a no-op.
    close: () => db.close(),
    /** The registered clients stored now. */
    countClients: () => q.countClients.get()?.n ?? 0,
    purge: (): { clients: number; expired: number } => purge(),
  });
}

/** The adapter's rules on a scratch file: each a named probe, the run failing on the first that does not hold. */
async function selfCheck(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "ob1-auth-store-"));
  const file = join(dir, "auth.sqlite");
  let failed = 0;
  const expect = (what: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : ` — ${detail}`}`);
    if (!ok) failed++;
  };
  /** How many rows of a model and id a file holds: one handle per file, closed at the end. */
  const handles: Database[] = [];
  const counter = (path: string) => {
    const h = new Database(path);
    handles.push(h);
    const q = h.query<{ n: number }, [string, string]>("SELECT count(*) AS n FROM oidc WHERE model = ? AND id = ?");
    return (model: string, id: string) => q.get(model, id)?.n ?? 0;
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

    // purge() and countClients(), on a file of their own.
    let u = 2_000_000;
    const pclock = () => u;
    const ps = sqliteAdapter(join(dir, "purge.sqlite"), pclock);
    const day = IDLE_S;
    const registered = (id: string, issuedAgo: number) => ps("Client").upsert(id, { client_id: id, client_id_issued_at: u - issuedAgo });
    await registered("fresh", 60); // registered a minute ago, never used
    await registered("abandoned", day + 60); // over a day old, never used
    await ps("RegistrationAccessToken").upsert("rat-abandoned", { clientId: "abandoned" });
    await registered("granted", 10 * day); // old, with a live grant
    await ps("Grant").upsert("g-live", { clientId: "granted", accountId: "operator" }, 30 * day);
    await registered("lapsed-lately", 10 * day); // its grant lapsed an hour ago
    await ps("Grant").upsert("g-lately", { clientId: "lapsed-lately" }, -3600 - CLOCK_TOLERANCE);
    await registered("lapsed-long", 10 * day); // its refresh token lapsed two days ago
    await ps("RefreshToken").upsert("rt-long", { clientId: "lapsed-long", grantId: "g-long" }, -2 * day - CLOCK_TOLERANCE);
    await ps("Session").upsert("s-old", { uid: "u-old" }, -2 * day - CLOCK_TOLERANCE); // expired two days ago
    await ps("Session").upsert("s-new", { uid: "u-new" }, -60 - CLOCK_TOLERANCE); // expired a minute ago
    expect("countClients() counts the registered clients stored", ps.countClients() === 5);
    const purged = ps.purge();
    const inPurge = counter(join(dir, "purge.sqlite"));
    const gone = async (model: string, id: string) => inPurge(model, id) === 0;
    expect(
      "purge() removes a client over a day old that nothing ever used, with its registration token, and one whose last token lapsed over a day ago, with that token",
      (await gone("Client", "abandoned")) && (await gone("RegistrationAccessToken", "rat-abandoned")) && (await gone("Client", "lapsed-long")) && (await gone("RefreshToken", "rt-long")),
      JSON.stringify(purged),
    );
    expect(
      "purge() keeps a client registered within the day, one with a live grant, and one whose grant lapsed within the day",
      !(await gone("Client", "fresh")) && !(await gone("Client", "granted")) && !(await gone("Client", "lapsed-lately")) && !(await gone("Grant", "g-live")),
    );
    expect("purge() deletes a row expired over a day ago and keeps one expired within the day", (await gone("Session", "s-old")) && !(await gone("Session", "s-new")));
    expect("purge() says what it removed", purged.clients === 2 && purged.expired === 1, JSON.stringify(purged));
    expect("countClients() counts what is left", ps.countClients() === 3);
    u += 2 * day;
    const later = ps.purge();
    expect("two days on, every client with nothing alive goes, and the lapsed grant with its client", later.clients === 2 && (await gone("Client", "fresh")) && (await gone("Client", "lapsed-lately")) && (await gone("Grant", "g-lately")) && !(await gone("Client", "granted")), JSON.stringify(later));
    ps.close();

    // The day itself, and its edges: a day is 86,400 s, not whatever IDLE_S says.
    expect("a day is 86,400 s", IDLE_S === 86_400);
    let w = 3_000_000;
    const edge = sqliteAdapter(join(dir, "edge.sqlite"), () => w);
    await edge("Client").upsert("day-old", { client_id: "day-old", client_id_issued_at: w - 86_400 });
    await edge("Client").upsert("day-old-less-1", { client_id: "day-old-less-1", client_id_issued_at: w - 86_399 });
    await edge("Client").upsert("code-only", { client_id: "code-only", client_id_issued_at: w - 10 * 86_400 });
    await edge("AuthorizationCode").upsert("code-1", { clientId: "code-only", grantId: "gx" }, 60);
    await edge("Client").upsert("signing-in", { client_id: "signing-in", client_id_issued_at: w - 10 * 86_400 });
    await edge("Interaction").upsert("int-1", { params: { client_id: "signing-in" }, uid: "int-1" }, 600);
    await edge("Client").upsert("grant-day-ago", { client_id: "grant-day-ago", client_id_issued_at: w - 10 * 86_400 });
    await edge("Grant").upsert("g-day-ago", { clientId: "grant-day-ago" }, -86_400 - CLOCK_TOLERANCE); // lapsed exactly a day ago
    await edge("Client").upsert("grant-day-ago-less-1", { client_id: "grant-day-ago-less-1", client_id_issued_at: w - 10 * 86_400 });
    await edge("Grant").upsert("g-day-ago-less-1", { clientId: "grant-day-ago-less-1" }, -86_399 - CLOCK_TOLERANCE); // a second inside the day
    await edge("Session").upsert("s-edge", { uid: "u-edge" }, -86_400 - CLOCK_TOLERANCE); // its expiry exactly a day ago
    await edge("Session").upsert("s-edge-1", { uid: "u-edge-1" }, -86_399 - CLOCK_TOLERANCE); // a second inside the day
    edge.purge();
    const inEdge = counter(join(dir, "edge.sqlite"));
    const left = (id: string, model = "Client") => inEdge(model, id) === 1;
    expect("a client exactly a day old with nothing alive goes; a second younger, it stays", !left("day-old") && left("day-old-less-1"));
    expect("a client whose last grant lapsed exactly a day ago goes; a second later, it stays", !left("grant-day-ago") && left("grant-day-ago-less-1"));
    expect("a live authorization code alone keeps its client", left("code-only"));
    expect("a sign-in under way (an interaction naming the client) keeps its client", left("signing-in"));
    expect("a row whose expiry was exactly a day ago goes; a second later, it stays", !left("s-edge", "Session") && left("s-edge-1", "Session"));
    // A live interaction with no client_id, or one expired over a day ago, keeps no client; an interaction expired exactly a day ago keeps none.
    await edge("Client").upsert("nameless-beside", { client_id: "nameless-beside", client_id_issued_at: w - 10 * 86_400 });
    await edge("Interaction").upsert("int-nameless", { uid: "int-nameless", params: {} }, 600);
    await edge("Client").upsert("int-long-gone", { client_id: "int-long-gone", client_id_issued_at: w - 10 * 86_400 });
    await edge("Interaction").upsert("int-old", { uid: "int-old", params: { client_id: "int-long-gone" } }, -2 * 86_400 - CLOCK_TOLERANCE);
    await edge("Client").upsert("int-day-ago", { client_id: "int-day-ago", client_id_issued_at: w - 10 * 86_400 });
    await edge("Interaction").upsert("int-edge", { uid: "int-edge", params: { client_id: "int-day-ago" } }, -86_400 - CLOCK_TOLERANCE);
    edge.purge();
    expect("an interaction with no client_id stops nothing being purged, and one expired over a day ago, or exactly a day ago, keeps no client", !left("nameless-beside") && !left("int-long-gone") && !left("int-day-ago"));

    // A payload SQLite cannot read: refused at write, and one already stored stops nothing.
    const deep = (n: number): unknown => (n ? { d: deep(n - 1) } : 1);
    let refusedDeep = "";
    try {
      await edge("Client").upsert("too-deep", { client_id: "too-deep", jwks: { keys: [], x: deep(2_500) } });
    } catch (e) {
      refusedDeep = (e as Error).message;
    }
    expect("a payload nested past SQLite's depth limit is refused at write, and not stored", /SQLite cannot read as JSON/.test(refusedDeep) && !left("too-deep") && edge.countClients() >= 0, refusedDeep || "stored");
    const poison = new Database(join(dir, "edge.sqlite"));
    poison.query("INSERT INTO oidc (model, id, payload, expires_at) VALUES ('Client', 'poison', ?, NULL)").run(JSON.stringify({ client_id: "poison", x: deep(2_500) }));
    poison.query("INSERT INTO oidc (model, id, payload, expires_at) VALUES ('Grant', 'poison-g', ?, ?)").run(JSON.stringify({ clientId: "x", y: deep(2_500) }), w - 3 * 86_400);
    poison.close();
    await edge("Client").upsert("idle-beside-poison", { client_id: "idle-beside-poison", client_id_issued_at: w - 10 * 86_400 });
    let purgeThrew = "";
    let afterPoison = { clients: 0, expired: 0 };
    try {
      afterPoison = edge.purge();
    } catch (e) {
      purgeThrew = (e as Error).message;
    }
    expect(
      "rows SQLite cannot read, already stored, stop no purge: the unreadable client goes as idle, the expired row goes, and an idle client beside them goes",
      purgeThrew === "" && !left("poison") && !left("poison-g", "Grant") && !left("idle-beside-poison"),
      purgeThrew || JSON.stringify(afterPoison),
    );
    edge.close();

    // At scale, one pass: 2,000 clients, half idle, over 30,000 rows. Per client it took seconds with the server answering nothing.
    const big = sqliteAdapter(join(dir, "big.sqlite"), () => w);
    const raw = new Database(join(dir, "big.sqlite"));
    raw.transaction(() => {
      const ins = raw.query("INSERT INTO oidc (model, id, payload, expires_at) VALUES (?, ?, ?, ?)");
      for (let i = 0; i < 2_000; i++) ins.run("Client", `c${i}`, JSON.stringify({ client_id: `c${i}`, client_id_issued_at: w - 10 * 86_400 }), null);
      for (let i = 0; i < 30_000; i++) ins.run("Grant", `g${i}`, JSON.stringify({ clientId: `c${(i % 1_000) * 2}` }), w + 86_400);
    })();
    raw.close();
    const t0 = performance.now();
    const bigPurge = big.purge();
    const took = performance.now() - t0;
    expect("a purge of 2,000 clients over 30,000 rows takes one pass, under 2 s, and removes the 1,000 idle ones", took < 2_000 && bigPurge.clients === 1_000 && big.countClients() === 1_000, `${took.toFixed(0)} ms, ${JSON.stringify(bigPurge)}`);
    big.close();
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
    for (const h of handles) h.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} probe(s) failed` : "\nall probes hold");
  return failed ? 1 : 0;
}

if (import.meta.main && process.argv.includes("--self-check")) process.exit(await selfCheck());
