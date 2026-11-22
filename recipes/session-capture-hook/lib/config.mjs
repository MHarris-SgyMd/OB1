/**
 * lib/config.mjs — the session hook's config (SMD-4338): the endpoint as the
 * hook uses it, a url's userinfo split off, the brains a run delivers to (one,
 * or a `brains` list, SMD-3313) with their keys, connectors and claim keys,
 * and the settings every brain shares (the opt-in model summary, SMD-2014).
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLAIM_MAX_AGE_MS, CONFIG_PATH, STATE_BASE } from "./state.mjs";
import { POST_TIMEOUT_MS } from "./rpc.mjs";

/** The config's shape, as the messages that ask for it write it. */
const CONFIG_SHAPE = '{"url": "http://127.0.0.1:8010/mcp", "key": "<capture key>"}';
/** The several-brain shape (SMD-3313): each brain its own url and key, the first's state where a one-brain config keeps it. */
const BRAINS_SHAPE = '{"brains": [{"name": "stable", "url": "http://127.0.0.1:8010/mcp", "key_file": "<path>"}, {"name": "canary", "url": "http://127.0.0.1:8011/mcp", "key_file": "<path>"}]}';
/** A brain's name: it names a directory and prefixes every line said of that brain. */
const BRAIN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** An MCP server's name as the harness spells it in a tool's name (`mcp__<server>__<tool>`): a brain's `connector` (SMD-3314). */
const CONNECTOR_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Where the url came from, as a message names it: the variable wins over the file, as loadConfig reads them. */
const urlSource = () => (process.env.OB1_BRAIN_URL ? "OB1_BRAIN_URL" : CONFIG_PATH);

/**
 * The endpoint as the hook uses it: an http(s) URL with one trailing
 * slash on its PATH, its query kept as given (SMD-2743: the slash went on the
 * end of the string, so `/mcp?x=1` became `/mcp?x=1/`). A `?key=` is refused
 * unechoed: the key goes in the config's `key`, sent as a header, and a url is
 * printed. `where` names the url's source. One with no `scheme://` is read as
 * http, as Bun's fetch read `localhost:8010/mcp` before this parsed it (review
 * pass 2: refusing it stopped a config that captured).
 */
export function endpointOf(raw, where) {
  const s = String(raw).trim();
  let u = null;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`); } catch { /* refused below */ }
  if (!u || !/^https?:$/.test(u.protocol)) throw new Error(`the url in ${where} is not an http(s) URL — write it as http://127.0.0.1:8010/mcp`);
  if (u.searchParams.has("key")) throw new Error(`the url in ${where} carries a key (?key=) — the hook sends its key as a header, from "key" (or "key_file") in ${CONFIG_PATH} or OB1_CAPTURE_KEY; put it there and take ?key= off the url`);
  u.pathname = u.pathname.replace(/\/*$/, "/");
  u.hash = "";
  return u.href;
}

/**
 * A url's user and password, out of it: the url without them, and the Basic
 * credential they make (UTF-8), or none — server-portable/embed.ts's split,
 * copied since the hook runs alone, always rebuilt from the parse (the hook
 * compares no two urls, so the written spelling need not be kept): Bun's
 * fetch sends userinfo as Basic from 1.4.3 and dropped it before, so it is
 * never left in a url for fetch to decide, nor for a status line to print
 * (SMD-2885). Which key goes with the url is the hook's own pairing in
 * loadConfig, not the server's, and a key wins over the userinfo here too.
 */
export function splitUserinfo(raw) {
  let u;
  try { u = new URL(raw); } catch { return { url: raw }; }
  if (!u.username && !u.password) return { url: raw };
  const dec = (p) => { try { return decodeURIComponent(p); } catch { return p; } };
  const basic = Buffer.from(`${dec(u.username)}:${dec(u.password)}`, "utf8").toString("base64");
  // Rebuilt from the parse, not cut from the string: `http:/u:p@h` is userinfo
  // too, and the host the parser read is the one dialled (second review pass).
  u.username = "";
  u.password = "";
  return { url: u.href, basic };
}

/**
 * The brains a run delivers to, each its own endpoint, key and state root
 * (SMD-3313), and the settings they share (the opt-in model summary). From the
 * config file — the one-brain shape `{"url", "key"|"key_file"}`, or a `brains`
 * list `[{"name", "url", "key"|"key_file"}, …]` whose first brain keeps the
 * state a one-brain config keeps, and each after it STATE_BASE/brains/<name> —
 * or from OB1_BRAIN_URL / OB1_CAPTURE_KEY in the environment (a test, a
 * container), which is one brain and wins over the file's. The key never
 * appears in a hook's command line, where it would sit in a settings file
 * every tool on the machine can read. Returns [{ name, root, cfg }].
 */
export function loadBrains() {
  let cfg = {};
  if (existsSync(CONFIG_PATH)) {
    // A BOM, which a Windows editor writes, is not the config's. The parser's
    // own message is not passed on: it quotes the token it stopped at, and an
    // unquoted key is that token (SMD-2743 review).
    const text = readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
    if (!text.trim()) throw new Error(`${CONFIG_PATH} is empty — write it as ${CONFIG_SHAPE}`);
    try { cfg = JSON.parse(text); } catch { throw new Error(`${CONFIG_PATH} is not valid JSON — check its quotes and commas, and that it has no comments (the parser's message is not shown: it can quote the key)`); }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(`${CONFIG_PATH} is JSON but not an object — write it as ${CONFIG_SHAPE}`);
    try {
      const mode = statSync(CONFIG_PATH).mode & 0o077;
      if (mode !== 0 && process.platform !== "win32") console.error(`session-capture: ${CONFIG_PATH} is readable by others — chmod 600 it`);
    } catch { /* unreadable stat: the read above already succeeded */ }
  }
  const shared = sharedSettings(cfg);
  // A key file that cannot be read is named by its setting and path, not the bare errno (SMD-4411 review pass 1: the log
  // said `EACCES … open '…/canary-write.key'` alone, and nothing named the forget it cost).
  const readKeyFile = (file, setting, where) => { try { return readFileSync(file, "utf8").trim(); } catch (e) { throw new Error(`the ${setting} in ${where}, ${file}, cannot be read (${e?.code ?? "error"})${String(file).startsWith("~") ? " — write it as a full path: ~ is not expanded" : ""}`); } };
  const keyOf = (b, where = CONFIG_PATH) => { const k = b.key || (b.key_file ? readKeyFile(b.key_file, "key_file", where) : ""); return k ? String(k) : ""; };
  // The work claims' key (SMD-3602): the very key an agent claims with — its
  // connector's own, since a server takes one key per name — which renews the
  // claims a worktree keeps tokens for. Claims are an add-on: a claim key that
  // cannot be read (a missing file, an empty one) turns claims off for that
  // brain, says so at --check and at a checkpoint, and leaves the capture
  // running (review pass 4). Where the key came from is kept for --check.
  const claimSettings = (b, where, envKey) => {
    // Turned off, not thrown: a claim mistake never stops the capture (review pass 5).
    if (b.claim_key !== undefined && b.claim_key_file !== undefined) return { claimKeyError: `${where} sets both "claim_key" and "claim_key_file" — give one` };
    if (envKey) return { claimKey: String(envKey), claimKeySource: "OB1_CLAIM_KEY" };
    if (b.claim_key !== undefined) return b.claim_key ? { claimKey: String(b.claim_key), claimKeySource: "claim_key" } : { claimKeyError: `the claim_key in ${where} is empty — give it the write key your agents claim with` };
    if (b.claim_key_file === undefined) return {};
    const file = String(b.claim_key_file);
    let k;
    try { k = readFileSync(file, "utf8").trim(); } catch (e) { return { claimKeyFile: file, claimKeyError: `the claim_key_file in ${where}, ${file}, cannot be read (${e?.code ?? "error"})${file.startsWith("~") ? " — write it as a full path: ~ is not expanded" : ""}` }; }
    return k ? { claimKey: k, claimKeySource: "claim_key_file", claimKeyFile: file } : { claimKeyFile: file, claimKeyError: `the claim_key_file in ${where}, ${file}, is empty — put the write key your agents claim with in it` };
  };
  // One brain: the environment's url, or the file's one-brain shape. A brains
  // list beside OB1_BRAIN_URL is passed over for the variable's one brain, as the
  // variable has always won over the file's url.
  if (process.env.OB1_BRAIN_URL || cfg.brains === undefined) {
    const url = process.env.OB1_BRAIN_URL || cfg.url;
    const key = process.env.OB1_CAPTURE_KEY || keyOf(cfg);
    // Work claims (SMD-3602) are renewed on the brain whose `connector` is the
    // token file's `server`, and nowhere else. The one-brain file names its
    // connector beside its claim key; the brain OB1_BRAIN_URL names has neither,
    // so it renews no claims — no token goes to a brain it may not have come
    // from (review passes 2 and 3).
    const fromEnv = Boolean(process.env.OB1_BRAIN_URL);
    // Beside OB1_BRAIN_URL a claim key in the file goes unused — at the top or in
    // a brains list's entries — and --check says so (review passes 4 and 5).
    const fileHasClaimKey = (b) => Boolean(b) && (b.claim_key !== undefined || b.claim_key_file !== undefined);
    let claim = fromEnv ? (fileHasClaimKey(cfg) || (Array.isArray(cfg.brains) && cfg.brains.some(fileHasClaimKey)) ? { claimKeyIgnored: true } : {}) : claimSettings(cfg, CONFIG_PATH, process.env.OB1_CLAIM_KEY);
    let connector = fromEnv ? undefined : cfg.connector;
    // The one-brain shape's connector serves the claims alone: a bad one turns claims off, never the capture (review pass 5).
    if (connector !== undefined && !(typeof connector === "string" && CONNECTOR_RE.test(connector))) {
      claim = { claimKeyError: `${CONFIG_PATH} has a "connector" that is no MCP server's name — letters, digits, hyphens and underscores, as the harness names it (open-brain)` };
      connector = undefined;
    }
    // Before the missing-key error: a connector URL pasted with its ?key= and no
    // `key` is told where the key goes, not to write a url it already has.
    const endpoint = url ? endpointOf(url, urlSource()) : undefined;
    if (!endpoint || !key) {
      throw new Error(`no endpoint or key — write ${CONFIG_PATH} as ${CONFIG_SHAPE} (mint the key with: bun server-portable/keygen.ts --name session-hook --scope capture)`);
    }
    return [{ name: "brain", root: STATE_BASE, cfg: { url: endpoint, key, where: urlSource(), ...(connector ? { connector } : {}), ...claim, ...shared } }];
  }
  // Several brains (SMD-3313). Each is named, once, as a directory may be; its
  // url and key are its own, never the file's top-level ones, which beside a
  // list would be a second answer to which brain is meant.
  const list = cfg.brains;
  if (!Array.isArray(list) || !list.length) throw new Error(`${CONFIG_PATH}'s "brains" is not a list of brains — write it as ${BRAINS_SHAPE}`);
  for (const k of ["url", "key", "key_file", "claim_key", "claim_key_file"]) if (cfg[k] !== undefined) throw new Error(`${CONFIG_PATH} sets "${k}" beside "brains" — set each brain's url and key inside its own entry, as ${BRAINS_SHAPE}`);
  const seen = new Set();
  const seenConnectors = new Set();
  return list.map((b, i) => {
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error(`${CONFIG_PATH}'s brain ${i + 1} is not an object — write it as {"name", "url", "key" or "key_file"}`);
    const name = typeof b.name === "string" ? b.name : "";
    if (!BRAIN_NAME_RE.test(name)) throw new Error(`${CONFIG_PATH}'s brain ${i + 1} needs a "name" of lower-case letters, digits and hyphens (it names a directory under ${STATE_BASE})`);
    if (seen.has(name)) throw new Error(`${CONFIG_PATH} names brain "${name}" twice — each brain's name is its own`);
    seen.add(name);
    const where = `${CONFIG_PATH} (brain "${name}")`;
    const endpoint = b.url ? endpointOf(b.url, where) : undefined;
    const key = keyOf(b, where);
    if (!endpoint || !key) throw new Error(`brain "${name}" in ${CONFIG_PATH} has no url or key — give it both (a capture key minted on that brain: bun server-portable/keygen.ts --name session-hook --scope capture)`);
    // The write fan-out (SMD-3314): `connector`, the name of the harness's MCP
    // server whose writes reach this brain directly — its writes are copied to
    // the others; and a `write_key` (or `write_key_file`), the key a copy is
    // written to this brain with. Both optional: without them nothing is copied.
    if (b.connector !== undefined && !(typeof b.connector === "string" && CONNECTOR_RE.test(b.connector))) throw new Error(`brain "${name}" in ${CONFIG_PATH} has a "connector" that is no MCP server's name — letters, digits, hyphens and underscores, as the harness names it (open-brain)`);
    if (b.write_key !== undefined && b.write_key_file !== undefined) throw new Error(`brain "${name}" in ${CONFIG_PATH} sets both "write_key" and "write_key_file" — give one`);
    const writeKey = b.write_key || (b.write_key_file ? readKeyFile(b.write_key_file, "write_key_file", where) : "");
    if ((b.write_key !== undefined || b.write_key_file !== undefined) && !writeKey) throw new Error(`brain "${name}" in ${CONFIG_PATH} has an empty write key — mint one on that brain: bun server-portable/keygen.ts --name claude-code --scope write`);
    if (b.connector !== undefined && seenConnectors.has(b.connector)) throw new Error(`${CONFIG_PATH} names connector "${b.connector}" for two brains — a connector's writes reach one brain`);
    if (b.connector !== undefined) seenConnectors.add(b.connector);
    const claim = claimSettings(b, `brain "${name}" in ${CONFIG_PATH}`, undefined);
    return { name, listed: true, root: i === 0 ? STATE_BASE : join(STATE_BASE, "brains", name), cfg: { url: endpoint, key, where, ...(b.connector ? { connector: b.connector } : {}), ...(writeKey ? { writeKey: String(writeKey) } : {}), ...claim, ...shared } };
  });
}

/**
 * One brain's settings: the named brain's, or the first (the one a one-brain
 * config is). Throws as loadBrains does, and on a name the config lacks.
 */
export function loadConfig(name) {
  const brains = loadBrains();
  if (name === undefined) return brains[0].cfg;
  const b = brains.find((x) => x.name === name);
  if (!b) throw new Error(`no brain named "${name}" in ${CONFIG_PATH} (its brains: ${brains.map((x) => x.name).join(", ")})`);
  return b.cfg;
}

/** The settings every brain shares: the opt-in model summary's (SMD-2014), read from the file and the environment. */
function sharedSettings(cfg) {
  // The opt-in model summary (SMD-2014). Off unless `summary` is "model"; then a
  // local model rewrites the derived summary into what was decided. The endpoint
  // is the OB1_LLM shape (OpenAI /chat/completions). "Local" is DECLARED
  // (`model_local`), never guessed from the address, exactly as the server's
  // egress gate declares it (SMD-1903); the hook carries its OWN policy, since
  // it is a client on another machine. A hook-specific env wins, then the config
  // file, then the server's own OB1_* env for a box that already runs one.
  const env = process.env;
  const summary = String(env.OB1_SESSION_CAPTURE_SUMMARY || cfg.summary || "derived").toLowerCase() === "model" ? "model" : "derived";
  // The URL and its key are read as a pair per tier so a partial override never
  // pairs one provider's key with another's endpoint (review pass 4): this hook's
  // own env or config first, else the server's own OB1_CHAT_*/OB1_LLM_*. The
  // server's KEY is used only when the server's URL is — never sent to a
  // hook-specific endpoint the server key was not minted for.
  const hookModelUrl = env.OB1_SESSION_CAPTURE_MODEL_URL || cfg.model_url;
  const hookModelKey = env.OB1_SESSION_CAPTURE_MODEL_KEY || cfg.model_key;
  // A user and password in the model url are that endpoint's credential: sent
  // as Basic unless a key is set, whose Bearer takes their place (SMD-2885).
  const modelSplit = splitUserinfo(String(hookModelUrl || env.OB1_CHAT_BASE_URL || env.OB1_LLM_BASE_URL || ""));
  const modelRaw = env.OB1_SESSION_CAPTURE_MODEL || cfg.model || env.OB1_METADATA_MODEL;
  const modelKey = hookModelKey || (hookModelUrl ? undefined : env.OB1_CHAT_API_KEY || env.OB1_LLM_API_KEY);
  const modelLocal = cfg.model_local ?? (env.OB1_CHAT_LOCAL === "1" || env.OB1_LLM_LOCAL === "1");
  const egressRaw = String(env.OB1_EGRESS_POLICY || cfg.egress || "deny").toLowerCase();
  const egress = EGRESS_MODES.has(egressRaw) ? egressRaw : "deny"; // an unknown or unparseable value fails closed to deny, as the server's gate does
  // A number of milliseconds above zero, else the default: a negative value is
  // truthy but would abort the fetch at once and always fall back (first review
  // pass 2), and 0 or a non-number means "use the default" (SMD-2014).
  const modelTimeoutRaw = Number(env.OB1_SESSION_CAPTURE_MODEL_TIMEOUT || cfg.model_timeout || 0);
  // The model call holds the inflight claim, and the post that follows can take
  // up to six rpc attempts (POST_TIMEOUT_MS each); both must finish inside ONE
  // claim window or a sibling run's sweep reclaims this live child's payload
  // mid-call and posts the episode twice (review pass 4). So the timeout is
  // capped below the window minus the worst-case post — which also keeps it
  // under the 32-bit setTimeout ceiling a larger value would truncate to a
  // near-zero abort (review pass 3), and 0 or a non-positive value takes the
  // default (review pass 2).
  const modelTimeoutMax = CLAIM_MAX_AGE_MS - 6 * POST_TIMEOUT_MS - 30_000;
  const modelTimeout = Number.isFinite(modelTimeoutRaw) && modelTimeoutRaw > 0 ? Math.min(modelTimeoutRaw, modelTimeoutMax) : undefined;
  return {
    summary,
    // The base the OpenAI path hangs off: trailing slashes stripped, and a
    // trailing `/chat/completions` a user pasted from a full endpoint removed,
    // so modelSummary's own `/chat/completions` is not doubled into a 404 that
    // would silently fall back (review pass 2).
    modelUrl: modelSplit.url ? modelSplit.url.replace(/\/*$/, "").replace(/\/chat\/completions$/, "") : undefined,
    model: modelRaw ? String(modelRaw) : undefined,
    modelKey: modelKey ? String(modelKey) : undefined,
    modelBasic: modelSplit.basic,
    modelLocal: !!modelLocal,
    egress,
    modelTimeout,
  };
}

/** The egress modes the hook honours, mirroring the server's (SMD-1903): deny (the default, and the fail-closed value), allow, off. */
const EGRESS_MODES = new Set(["deny", "allow", "off"]);

export { BRAIN_NAME_RE, CONNECTOR_RE, urlSource };
