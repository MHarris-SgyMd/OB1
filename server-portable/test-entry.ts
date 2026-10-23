import { DEFAULT_EMBEDDING_DIM } from "../db/config.mjs";
import { createAssert } from "../db/test-support.ts";
import { FORK_VERSION } from "../db/version.mjs";
/**
 * test-entry.ts
 *
 * What test-server.ts held that no MCP server under test reaches: index.ts run
 * as the image runs it, as child processes — a keyed /health's deadline, the
 * stop on SIGTERM and SIGINT — and the pure rules those answers are built
 * from: brain-info.ts's record, the drain's bounds, the call count, the grace
 * period's parse and where compose and preflight read it.
 *
 * ── Why a suite of its own ─────────────────────────────────────────────────────
 * test-server runs twice since SMD-2287: against index.ts, and with
 * OB1_MCP_UNDER_TEST=client through the MCP server as a REST client. These
 * sections, its [13a], [13c] and most of [13d] until SMD-3201, spawned
 * `bun --no-env-file index.ts` or called a module directly whatever the
 * switch said, so the second pass re-ran some 16 s of the same assertions.
 * Here they run once, and survive SMD-2287 PR 6's retirement of the switch.
 * What of the stop does read the server under test, its count of a tool call
 * whose client left, stays test-server's [13d], in both passes.
 *
 * Run: bun test-entry.ts
 */

const { assert, report } = createAssert();

// The children's env: what of test-server's these rows read — no store of
// this process's own, one access key — and a local provider stub, which holds
// one call's embedding for SLOW_CALL_MS ([3]'s tool call at a stop). Each
// child is handed its own DATABASE_URL. test-server's named keys and OAuth
// settings are read by none of them.
delete process.env.OB1_STORE;
delete process.env.DATABASE_URL;
delete process.env.SUPABASE_URL;
process.env.OPENROUTER_API_KEY = "stub-openrouter";
process.env.MCP_ACCESS_KEY = "test-key-xyz";

const KEY = "test-key-xyz";

/** [3]'s query, whose embedding the stub holds: a tool call still running when its client has left and the stop lands. */
const SLOW_QUERY = "a call the stop waits on";
const SLOW_CALL_MS = 1_500;
const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.method === "GET") return Response.json({ object: "list", data: [] });
    const body = (await req.json()) as { input?: string };
    if (new URL(req.url).pathname.endsWith("/embeddings")) {
      if (String(body.input ?? "").includes(SLOW_QUERY)) await Bun.sleep(SLOW_CALL_MS);
      const v = new Array(DEFAULT_EMBEDDING_DIM).fill(0);
      v[String(body.input ?? "").length % DEFAULT_EMBEDDING_DIM] = 1;
      return Response.json({ data: [{ embedding: v }] });
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ topics: [], type: "idea", people: [] }) } }] });
  },
});
process.env.OB1_LLM_BASE_URL = `http://127.0.0.1:${provider.port}/v1`;
process.env.OB1_LLM_LOCAL = "1";

// ── Tests ────────────────────────────────────────────────────────────────────

console.log("[1] brain-info.ts's rules, without a database: the ledger's judgement, the rendering, why a read did not answer, the deadline keeping what was read, a failed savepoint or COMMIT (SMD-2041)");
{
  const { ago, boardPairsValue, boardSyncValue, brainInfo, deniedObject, formatBytes, heartbeatState, ledgerStatus, newProgress, snapshotFacts, parseHeartbeats, parseHnswOptions, proposalsValue, readDatabaseFacts, relationsValue, renderBrainInfo, unreadReason } = await import("./brain-info.ts");
  type Facts = Awaited<ReturnType<typeof readDatabaseFacts>>;
  assert(ledgerStatus(52, 52) === "current" && ledgerStatus(51, 52) === "behind" && ledgerStatus(53, 52) === "ahead" && ledgerStatus(null, 52) === null,
    "the ledger's highest against the tree's last: current, behind, ahead, unjudged");
  const hn = [parseHnswOptions("m=24,ef_construction=100"), parseHnswOptions("ef_construction=200"), parseHnswOptions(null), parseHnswOptions("m=8")];
  assert(JSON.stringify(hn) === JSON.stringify([{ m: 24, efConstruction: 100 }, { m: 16, efConstruction: 200 }, { m: 16, efConstruction: 64 }, { m: 8, efConstruction: 64 }]),
    `HNSW reloptions are read per key, pgvector's defaults where unset (${JSON.stringify(hn)})`);
  const sizes = [formatBytes(999), formatBytes(1000), formatBytes(45_200_000), formatBytes(10_779_671)];
  assert(sizes.join("|") === "999 B|1.0 kB|45.2 MB|10.8 MB", `bytes in decimal units, one place (${sizes.join("|")})`);
  const pgError = (msg: string, errno: string) => Object.assign(new Error(msg), { errno });
  assert(unreadReason(pgError("x", "42501")) === "refused" && unreadReason(pgError("x", "57014")) === "timeout" && unreadReason(pgError("x", "55P03")) === "timeout" && unreadReason(new Error("x")) === "error",
    "a failed read's reason is its SQLSTATE's: refused, timeout (statement or lock), anything else");

  // A fake client answering by statement text, in one transaction with a
  // savepoint per guarded read: ob1_entities refused, the ledger timed out,
  // thought_chunks absent everywhere, thought_audit present only in a schema
  // this role does not resolve. Each lands in `unread` by its own reason and
  // the rest answer.
  const statements: string[] = [];
  const hang = new Set<string>();
  let answerLedger = false;
  const answer = (text: string): unknown[] => {
    statements.push(text);
    if (lockFacets && /FROM thought_facets f\b/.test(text) && !/NOT consolidation_tickets_linked/.test(text)) throw pgError("canceling statement due to lock timeout", "55P03");
    if (lockProposals && /FROM supersession_proposals p\b/.test(text) && !/NOT consolidation_tickets_linked/.test(text)) throw pgError("canceling statement due to lock timeout", "55P03");
    if (/FROM board_findings_posted/.test(text)) {
      if (findingsRefused) throw pgError("permission denied for table board_findings_posted", "42501");
      return findingsAnswer;
    }
    if (/FROM ob1_entities/.test(text)) throw pgError("permission denied for table ob1_entities", "42501");
    if (/FROM schema_migrations/.test(text)) {
      if (answerLedger) return [{ name: "051_schema_version.sql" }, { name: "052_thought_changes.sql" }];
      throw pgError("canceling statement due to lock timeout", "55P03");
    }
    if (/set_config/.test(text)) return [{}];
    if (/server_version/.test(text)) {
      return [{
        postgres: "16.15", vec_version: "0.8.6", vec_schema: "public",
        resolved: { ob1_config: true, schema_migrations: true, thoughts: true, thought_audit: false, thought_chunks: false, ob1_entities: true, supersession_proposals: true, thought_facets: true, board_findings_posted: catalogFindings },
        anywhere: { ob1_config: "public", schema_migrations: "public", thoughts: "public", thought_audit: "vault", ob1_entities: "public", ...(catalogFindings ? { board_findings_posted: "public" } : {}) },
        hnsw: [{ index: "thoughts_embedding_idx", table: "thoughts", opts: "m=24,ef_construction=100" }],
        tickets_linked: catalogLinked,
      }];
    }
    if (/pg_database_size/.test(text)) return [{ n: 10_779_671 }];
    if (/linear_updated_at/.test(text)) return [{ w: boardAnswer }];
    if (/LIKE 'heartbeat:%'/.test(text)) return heartbeatRows;
    if (/NOT consolidation_tickets_linked/.test(text)) {
      if (boardTimeout) throw pgError("canceling statement due to statement timeout", "57014");
      return [{ n: /FROM supersession_proposals/.test(text) ? proposalsAnswer.board_pairs : 11 }];
    }
    if (/FROM supersession_proposals/.test(text)) return [proposalsAnswer];
    if (/FROM thought_facets/.test(text)) return [relationsAnswer];
    if (/FROM ob1_config/.test(text)) return [{ key: "schema_version", value: "1.1.0+upstream.9543c29" }];
    if (lockThoughts && /FROM thoughts\b/.test(text) && /count\(\*\)::float8/.test(text)) throw pgError("canceling statement due to lock timeout", "55P03");
    if (/count\(\*\)/.test(text)) return [{ n: 7 }];
    throw new Error(`unexpected statement: ${text.slice(0, 60)}`);
  };
  let boardAnswer: unknown = "2026-09-24T12:00:00.000Z";
  let heartbeatRows: unknown[] = [];
  let lockThoughts = false;
  let catalogLinked = true;
  let boardTimeout = false;
  let lockFacets = false;
  let relationsAnswer: Record<string, unknown> = { related: 9, evolves: 4, duplicate: 1, distinct: 3 };
  // 087's table: absent from the catalog unless a case puts it there (SMD-2682).
  let catalogFindings = false;
  let findingsRefused = false;
  let lockProposals = false;
  let findingsAnswer: Record<string, unknown>[] = [];
  let failRelease: RegExp | null = null;
  let proposalsAnswer: Record<string, unknown> = { pending: 6, stale: 2, oldest_s: 3 * 86400 + 7.4, board_pairs: 4 };
  const slow = new Set<string>();
  const tag = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    for (const h of hang) if (text.includes(h)) return new Promise<unknown[]>(() => {});
    for (const h of slow) if (text.includes(h)) return Bun.sleep(150).then(() => answer(text));
    return Promise.resolve().then(() => answer(text));
  };
  // The savepoint's RELEASE and the transaction's COMMIT can be slowed or
  // failed, to put a deadline or an error between a read and its end.
  let releaseMs = 0;
  let savepointMs = 0;
  let failCommit = false;
  const tx = Object.assign(tag, {
    savepoint: async <T>(fn: (sp: typeof tag) => Promise<T>) => {
      if (savepointMs) await Bun.sleep(savepointMs);
      const before = statements.length;
      const r = await fn(tag);
      if (releaseMs) await Bun.sleep(releaseMs);
      if (failRelease && statements.slice(before).some((t) => failRelease!.test(t))) throw pgError("server closed the connection unexpectedly", "08006");
      return r;
    },
  });
  const fake = Object.assign(tag, {
    begin: async <T>(fn: (t: typeof tx) => Promise<T>) => { const r = await fn(tx); if (failCommit) throw pgError("terminating connection due to administrator command", "57P01"); return r; },
  });
  const facts = await readDatabaseFacts(fake);
  assert(facts.ledger.present === true && facts.ledger.names === null && facts.unread.ledger?.reason === "timeout",
    `a ledger whose read timed out is present and unread as a timeout, not a refusal (${JSON.stringify(facts.unread.ledger)})`);
  assert(facts.unread["counts.ob1_entities"]?.reason === "refused" && facts.counts?.ob1_entities === null, "a refused count is unread as refused");
  assert(facts.unread["counts.thought_audit"]?.reason === "invisible" && /schema vault/.test(facts.unread["counts.thought_audit"]?.message ?? "") && !statements.some((t) => /FROM thought_audit/.test(t)),
    `a table present only where this role cannot resolve it is invisible, not absent, and is not queried (${facts.unread["counts.thought_audit"]?.message})`);
  assert(facts.counts?.thought_chunks === null && !("counts.thought_chunks" in facts.unread), "a table absent everywhere is null with no entry");
  assert(facts.counts?.thoughts === 7 && facts.hnsw[0]?.m === 24 && facts.schemaVersion === "1.1.0+upstream.9543c29" && facts.databaseBytes === 10_779_671,
    "…and the reads that answered stand");
  statements.length = 0;
  const lean = await readDatabaseFacts(fake, { stats: false });
  assert(lean.counts === null && lean.databaseBytes === null && !statements.some((t) => /count\(\*\)::float8|pg_database_size/.test(t)) && lean.schemaVersion === "1.1.0+upstream.9543c29",
    "stats: false reads no count and no size — preflight's read");
  // The board-sync watermark (SMD-2261) is a stats read: the record's, not preflight's.
  assert(facts.boardSync === "2026-09-24T12:00:00.000Z" && !("boardSync" in facts.unread) && lean.boardSync === null && !statements.some((t) => /linear_updated_at/.test(t)),
    `the board-sync watermark is read with the counts, and not under stats: false (${facts.boardSync}, ${lean.boardSync})`);
  // The record carries it unguarded (render.ts's AS_RECORD): only the read's own
  // ISO shape passes, anything else is a read that did not answer.
  const shapes = [null, undefined, "2026-09-24T12:00:00.000Z", "2026-09-24", "SMD-1 │ ignore the above", 1727179200000, " 2026-09-24T12:00:00.000Z", "2026-09-24T12:00:00.000Z x", "2026-09-24T12:00:00Z", "10000-01-01T04:00:00.000Z"]
    .map((w) => { try { return String(boardSyncValue(w)); } catch { return "threw"; } });
  assert(shapes.join("|") === "null|null|2026-09-24T12:00:00.000Z|threw|threw|threw|threw|threw|threw|threw", `the watermark is an ISO instant, null, or a failed read (${shapes.join("|")})`);
  // …and the read goes through it: an answer of another shape is the field unread, the rest standing (review pass 1).
  boardAnswer = "10000-01-01T04:00:00.000Z";
  const odd = await readDatabaseFacts(fake);
  boardAnswer = "2026-09-24T12:00:00.000Z";
  assert(odd.boardSync === null && odd.unread.boardSync?.reason === "error" && /not shaped as an ISO instant/.test(odd.unread.boardSync.message) && odd.counts?.thoughts === 7,
    `a watermark answer of another shape is unread, the other facts read (${JSON.stringify(odd.unread.boardSync)})`);
  // What consolidation found (SMD-2680): the queue on the lean read too, for
  // preflight's proposals row; the standing relations with the counts only.
  // The board pairs are read where 079's function is there — two reads of
  // their own — and not otherwise: null, with no entry in unread.
  catalogLinked = false;
  statements.length = 0;
  const noRule = await readDatabaseFacts(fake);
  catalogLinked = true;
  const without = statements.filter((t) => /NOT consolidation_tickets_linked/.test(t)).length;
  statements.length = 0;
  await readDatabaseFacts(fake);
  const withRule = statements.filter((t) => /NOT consolidation_tickets_linked/.test(t)).length;
  assert(without === 0 && withRule === 2 && noRule.proposals?.pending === 6 && noRule.proposals?.boardPairs === null && noRule.relations?.boardPairs === null && !Object.keys(noRule.unread).some((k) => /boardPairs/.test(k)),
    `the board pairs read 079's rule when the catalog has it — two reads — and are null, unnamed, without it (${without}, ${withRule}, ${JSON.stringify(noRule.proposals)})`);
  // An empty queue and no standing relation pair nothing: neither board
  // statement is sent, so a refusal of 079's predicate cannot speak for them
  // (run-it, review pass 4).
  proposalsAnswer = { pending: 0, stale: 2, oldest_s: null, board_pairs: 4 };
  relationsAnswer = { related: 0, evolves: 0, duplicate: 0, distinct: 0 };
  boardTimeout = true;
  statements.length = 0;
  const emptyQueue = await readDatabaseFacts(fake);
  boardTimeout = false;
  proposalsAnswer = { pending: 6, stale: 2, oldest_s: 3 * 86400 + 7.4, board_pairs: 4 };
  relationsAnswer = { related: 9, evolves: 4, duplicate: 1, distinct: 3 };
  assert(emptyQueue.proposals?.boardPairs === 0 && emptyQueue.relations?.boardPairs === 0 && !Object.keys(emptyQueue.unread).some((k) => /boardPairs/.test(k)) && !statements.some((t) => /NOT consolidation_tickets_linked/.test(t)),
    `an empty queue and no relation send no board statement and count none (${JSON.stringify(emptyQueue.proposals)}, ${JSON.stringify(emptyQueue.unread)})`);
  // …and under a refused lock on thoughts, or at a deadline, an empty queue
  // still reads 0 with no entry, and a queue not read leaves no board entry
  // beside its own (review pass 5).
  proposalsAnswer = { pending: 0, stale: 0, oldest_s: null, board_pairs: 0 };
  lockThoughts = true;
  const emptyLocked = await readDatabaseFacts(fake);
  lockThoughts = false;
  proposalsAnswer = { pending: 6, stale: 2, oldest_s: 3 * 86400 + 7.4, board_pairs: 4 };
  // At a deadline in the queue's board read, with no relation standing, the
  // snapshot names the queue's board count and settles the relations' to 0.
  relationsAnswer = { related: 0, evolves: 0, duplicate: 0, distinct: 0 };
  hang.add("NOT consolidation_tickets_linked");
  const dlProgress = newProgress();
  void readDatabaseFacts(fake, {}, dlProgress);
  await Bun.sleep(200);
  const dl = snapshotFacts(dlProgress)!;
  hang.delete("NOT consolidation_tickets_linked");
  relationsAnswer = { related: 9, evolves: 4, duplicate: 1, distinct: 3 };
  proposalsAnswer = { pending: 1, stale: "x", oldest_s: 1, board_pairs: 0 };
  const parentLost = await readDatabaseFacts(fake);
  proposalsAnswer = { pending: 6, stale: 2, oldest_s: 3 * 86400 + 7.4, board_pairs: 4 };
  assert(emptyLocked.proposals?.boardPairs === 0 && !("proposals.boardPairs" in emptyLocked.unread) && dl.unread["proposals.boardPairs"]?.reason === "deadline" && dl.relations?.boardPairs === 0 && !("relations.boardPairs" in dl.unread)
      && parentLost.proposals === null && !("proposals.boardPairs" in parentLost.unread),
    `an empty queue under a lock reads 0, unnamed; a deadline names a board count only beside a read queue; a queue not read leaves no board entry (${JSON.stringify(emptyLocked.proposals)}, ${JSON.stringify(Object.keys(dl.unread))}, ${JSON.stringify(Object.keys(parentLost.unread))})`);
  // A board read that times out takes its count alone: the queue and the
  // relations stand (run-it, review pass 2: at ~45k pending the one statement
  // passed the health cap and the whole queue went unread).
  boardTimeout = true;
  const slowBoard = await readDatabaseFacts(fake);
  boardTimeout = false;
  assert(slowBoard.proposals?.pending === 6 && slowBoard.proposals?.boardPairs === null && slowBoard.unread["proposals.boardPairs"]?.reason === "timeout"
      && slowBoard.relations?.related === 9 && slowBoard.relations?.boardPairs === null && slowBoard.unread["relations.boardPairs"]?.reason === "timeout" && !("proposals" in slowBoard.unread),
    `a board-pair read that times out leaves the queue and the relations read (${JSON.stringify(slowBoard.proposals)}, ${JSON.stringify(Object.keys(slowBoard.unread))})`);
  statements.length = 0;
  const leanFindings = await readDatabaseFacts(fake, { stats: false });
  assert(JSON.stringify(facts.proposals) === JSON.stringify({ pending: 6, stale: 2, oldestPendingS: 259207, boardPairs: 4 }) && JSON.stringify(leanFindings.proposals) === JSON.stringify(facts.proposals)
      && JSON.stringify(facts.relations) === JSON.stringify({ related: 9, evolves: 4, duplicate: 1, distinct: 3, boardPairs: 11 }) && leanFindings.relations === null && !statements.some((t) => /FROM thought_facets f\b/.test(t)),
    `the queue is read with or without the stats, the relations with them only (${JSON.stringify(leanFindings.proposals)}, ${JSON.stringify(leanFindings.relations)})`);
  // What became of the findings posted to the board (SMD-2682): a stats read
  // where 087's table resolves, each (pair, word) by its outcome, the found
  // apart; null and unnamed without the table; refused, malformed or behind a
  // refused lock on thought_facets, unread with the rest standing.
  const day = 86_400;
  const at0 = new Date("2026-10-01T00:00:00.000Z");
  const fRow = (o: Record<string, unknown>) => ({ posted_on: o.ticket_b, origin: "posted", posted_at: at0, linked_s: null, accepted: 0, rejected: 0, stale: 0, pending: 0, accepted_s: null, rejected_s: null, stands: null, ...o });
  findingsAnswer = [
    fRow({ ticket_a: "SMD-1", ticket_b: "SMD-2", word: "related", age_s: 40 * day, linked_s: 3 * day, stands: true }),
    fRow({ ticket_a: "SMD-1", ticket_b: "SMD-2", word: "outdates", age_s: 40 * day, accepted: 1, accepted_s: 1 * day }),
    fRow({ ticket_a: "SMD-3", ticket_b: "SMD-4", word: "outdates", age_s: 10 * day, posted_at: new Date("2026-10-02T00:00:00.000Z"), rejected: 1, rejected_s: 2 * day, linked_s: day }),
    fRow({ ticket_a: "SMD-5", ticket_b: "SMD-6", word: "evolves", age_s: 40 * day, stands: true }),
    fRow({ ticket_a: "SMD-7", ticket_b: "SMD-8", word: "related", age_s: 5 * day, stands: true }),
    fRow({ ticket_a: "SMD-9", ticket_b: "SMD-10", word: "outdates", age_s: 5 * day, stale: 1 }),
    fRow({ ticket_a: "SMD-11", ticket_b: "SMD-12", word: "duplicate", origin: "found", age_s: 2 * day, stands: false }),
  ];
  catalogFindings = true;
  statements.length = 0;
  const told = await readDatabaseFacts(fake);
  const leanTold = await readDatabaseFacts(fake, { stats: false });
  const toldSent = statements.filter((t) => /FROM board_findings_posted/.test(t)).length;
  findingsRefused = true;
  const toldRefused = await readDatabaseFacts(fake);
  findingsRefused = false;
  lockFacets = true;
  const toldLocked = await readDatabaseFacts(fake);
  lockFacets = false;
  // A lock refused on the queue's table: the queue's read waits on it once,
  // and the findings read — after it, joining it — is not tried (review pass 1:
  // it ran first and waited too).
  lockProposals = true;
  statements.length = 0;
  const toldQueueLocked = await readDatabaseFacts(fake);
  const queueSent = statements.filter((t) => /FROM supersession_proposals/.test(t)).length;
  lockProposals = false;
  findingsAnswer = [fRow({ ticket_a: "SMD-1", ticket_b: "SMD-2", word: "supersedes", age_s: 1 })];
  const toldOdd = await readDatabaseFacts(fake);
  findingsAnswer = [];
  const toldNone = await readDatabaseFacts(fake);
  catalogFindings = false;
  const wantTold = { posted: 6, comments: 5, found: 1, accepted: 2, rejected: 1, withdrawn: 0, open: 2, unanswered: 1, windowDays: 30, medianAnswerS: 2 * day };
  assert(JSON.stringify(told.findings) === JSON.stringify(wantTold) && !("findings" in told.unread) && leanTold.findings === null && toldSent === 1 && facts.findings === null && !("findings" in facts.unread)
      && toldRefused.findings === null && toldRefused.unread.findings?.reason === "refused" && toldRefused.relations?.related === 9
      && toldLocked.findings === null && /not tried — a lock on thought_facets/.test(toldLocked.unread.findings?.message ?? "")
      && toldQueueLocked.proposals === null && toldQueueLocked.unread.proposals?.reason === "timeout" && /not tried — a lock on supersession_proposals/.test(toldQueueLocked.unread.findings?.message ?? "") && queueSent === 1
      && toldOdd.findings === null && toldOdd.unread.findings?.reason === "error" && JSON.stringify(toldNone.findings) === JSON.stringify({ ...wantTold, posted: 0, comments: 0, found: 0, accepted: 0, rejected: 0, withdrawn: 0, open: 0, unanswered: 0, medianAnswerS: null }),
    `the findings posted are a stats read of 087's table, by outcome, the found apart; absent, null and unnamed; refused, malformed or behind a refused lock, unread (${JSON.stringify(told.findings)}, ${JSON.stringify(toldLocked.unread.findings)}, ${JSON.stringify(toldOdd.unread.findings)})`);
  const fServer = { version: FORK_VERSION, releaseRange: [49, 51] as const, latestMigration: 52, commit: "abc1234", store: "sql", tier: null, embedding: { model: "m", dim: 1024 } };
  const toldText = renderBrainInfo(await brainInfo(fServer, async () => told, 1000));
  const toldRows = [toldText, renderBrainInfo(await brainInfo(fServer, async () => toldNone, 1000)), renderBrainInfo(await brainInfo(fServer, async () => toldRefused, 1000)), renderBrainInfo(await brainInfo(fServer, async () => facts, 1000)),
    renderBrainInfo(await brainInfo(fServer, async () => ({ ...toldNone, findings: { ...toldNone.findings!, posted: 2, comments: 1, open: 2 } }), 1000)),
    renderBrainInfo(await brainInfo(fServer, async () => ({ ...toldNone, findings: { ...toldNone.findings!, posted: 1, comments: 1, withdrawn: 1 } }), 1000)), renderBrainInfo(await brainInfo(fServer, async () => leanTold, 1000)), renderBrainInfo(await brainInfo(fServer, async () => toldLocked, 1000)),
    renderBrainInfo(await brainInfo(fServer, async () => ({ ...toldLocked, unread: { findings: { reason: "timeout" as const, message: "canceling statement due to lock timeout" } } }), 1000)),
    // A brain behind this server: the read names 091's column (SMD-2913, review pass 1).
    renderBrainInfo(await brainInfo(fServer, async () => ({ ...toldLocked, unread: { findings: { reason: "error" as const, message: "column x.pass_settled_at does not exist" } } }), 1000)),
    renderBrainInfo(await brainInfo(fServer, async () => ({ ...toldLocked, unread: { findings: { reason: "error" as const, message: "column x.reviewed_at does not exist" } } }), 1000))]
    .map((t) => t.split("\n").find((l) => l.startsWith("Findings")) ?? "(no row)");
  assert(toldRows.join("\n") === [
    "Findings:        6 posted in 5 comment(s): 2 accepted, 1 rejected, 1 unanswered after 30 d, 2 open, 0 withdrawn — acceptance 50% (2 of 4: accepted over accepted, rejected and unanswered), median 2 d to an answer; 1 found on the board from another poster",
    "Findings:        none posted",
    "Findings:        ? (board_findings_posted not readable by this role)",
    "Findings:        no table — migration 087 is not applied",
    "Findings:        2 posted in 1 comment(s): 0 accepted, 0 rejected, 0 unanswered after 30 d, 2 open, 0 withdrawn — no rate yet (none answered, none past the window)",
    "Findings:        1 posted in 1 comment(s): 0 accepted, 0 rejected, 0 unanswered after 30 d, 0 open, 1 withdrawn — no rate yet (none answered, none past the window)",
    "(no row)",
    "Findings:        ? (thought_facets not read in time)",
    "Findings:        ? (not read in time)",
    "Findings:        ? (migration 091 is not applied)",
    "Findings:        ? (not read)",
  ].join("\n"), `the table's Findings row: the outcomes and the rate, none, ? when refused, no table, no rate yet, no row without the stats, and 091 named when its column is absent (${toldRows.join(" / ")})`);
  // The record carries both unguarded (render.ts's AS_RECORD): counts only, or the read did not answer.
  const qShapes = [
    { pending: 0, stale: 0, oldest_s: null }, { pending: "3", stale: 0, oldest_s: "12.6" }, { pending: 0, stale: 1, oldest_s: 99 }, { pending: 1, stale: 0, oldest_s: -5 },
    { pending: -1, stale: 0, oldest_s: null }, { pending: 1.5, stale: 0, oldest_s: 1 }, { pending: 1, stale: "x", oldest_s: 1 }, { pending: 1, stale: 0, oldest_s: "soon" }, undefined,
  ].map((r) => { try { return JSON.stringify(proposalsValue(r)); } catch { return "threw"; } });
  assert(qShapes.join("|") === '{"pending":0,"stale":0,"oldestPendingS":null,"boardPairs":null}|{"pending":3,"stale":0,"oldestPendingS":13,"boardPairs":null}|{"pending":0,"stale":1,"oldestPendingS":null,"boardPairs":null}|{"pending":1,"stale":0,"oldestPendingS":0,"boardPairs":null}|threw|threw|threw|threw|threw',
    `the queue's counts are counts and its age whole seconds, or the read did not answer (${qShapes.join("|")})`);
  const rShapes = [{ related: 1, evolves: 0, duplicate: 0, distinct: 2 }, { related: 1, evolves: null, duplicate: 0, distinct: 0 }, { related: "1; DROP", evolves: 0, duplicate: 0, distinct: 0 }, { related: 1, evolves: 0, duplicate: 0 }, { related: 1, evolves: 0, duplicate: 0, distinct: -1 }, undefined]
    .map((r) => { try { return JSON.stringify(relationsValue(r)); } catch { return "threw"; } });
  const bShapes = [{ n: 4 }, { n: "4" }, { n: -1 }, { n: null }, {}, undefined].map((r) => { try { return String(boardPairsValue("x", r)); } catch { return "threw"; } });
  assert(rShapes.join("|") === '{"related":1,"evolves":0,"duplicate":0,"distinct":2,"boardPairs":null}|threw|threw|threw|threw|threw' && bShapes.join("|") === "4|4|threw|threw|threw|threw",
    `the relations' and the board pairs' counts are counts, or the read did not answer (${rShapes.join("|")} / ${bShapes.join("|")})`);
  proposalsAnswer = { pending: 1, stale: "two", oldest_s: 1, board_pairs: 0 };
  const oddQueue = await readDatabaseFacts(fake);
  proposalsAnswer = { pending: 6, stale: 2, oldest_s: 3 * 86400 + 7.4, board_pairs: 4 };
  assert(oddQueue.proposals === null && oddQueue.unread.proposals?.reason === "error" && oddQueue.counts?.thoughts === 7,
    `a queue answer that is not counts is unread, the other facts read (${JSON.stringify(oddQueue.unread.proposals)})`);
  // A table whose lock a read of it alone was refused is not waited on again
  // in the same read (SMD-2680): the watermark and the two board counts touch
  // thoughts, and none is sent once its count was refused; the queue and the
  // relations, which do not, stand.
  lockThoughts = true;
  statements.length = 0;
  const lockProgress = newProgress();
  const lockedOut = await readDatabaseFacts(fake, {}, lockProgress);
  lockThoughts = false;
  // …and leaves nothing pending, so a deadline after it cannot rename it (run-it, review pass 1).
  assert(lockProgress.pending.size === 0, `a read not tried leaves nothing pending (${[...lockProgress.pending].join(", ")})`);
  const skipped = ["boardSync", "relations.boardPairs", "proposals.boardPairs"].filter((f) => lockedOut.unread[f]?.reason === "timeout" && /^not tried — a lock on thoughts \(the table or one of its indexes\) was refused/.test(lockedOut.unread[f]?.message ?? ""));
  assert(lockedOut.unread["counts.thoughts"]?.reason === "timeout" && skipped.length === 3 && lockedOut.proposals?.pending === 6 && lockedOut.relations?.related === 9 && !statements.some((t) => /linear_updated_at|NOT consolidation_tickets_linked/.test(t)) && lockedOut.schemaVersion !== null,
    `after a refused lock on thoughts the reads that touch it are named, not sent (${skipped.join(", ")})`);
  // A lock refused to the relations' read (thought_facets alone) is not
  // waited on by the queue's board count, which reads it through 079's
  // predicate (run-it, review pass 3).
  lockFacets = true;
  statements.length = 0;
  const facetsLocked = await readDatabaseFacts(fake);
  lockFacets = false;
  assert(facetsLocked.unread.relations?.reason === "timeout" && /^not tried — a lock on thought_facets/.test(facetsLocked.unread["proposals.boardPairs"]?.message ?? "")
      && facetsLocked.proposals?.pending === 6 && !statements.some((t) => /NOT consolidation_tickets_linked/.test(t)),
    `after a refused lock on thought_facets the queue's board count is not sent (${JSON.stringify(facetsLocked.unread["proposals.boardPairs"])})`);
  // A board read whose release fails takes its count back (review pass 3).
  failRelease = /NOT consolidation_tickets_linked/;
  const boardReleaseFailed = await readDatabaseFacts(fake);
  failRelease = null;
  assert(boardReleaseFailed.proposals?.pending === 6 && boardReleaseFailed.proposals?.boardPairs === null && boardReleaseFailed.unread["proposals.boardPairs"]?.reason === "error"
      && boardReleaseFailed.relations?.related === 9 && boardReleaseFailed.relations?.boardPairs === null && boardReleaseFailed.unread["relations.boardPairs"]?.reason === "error",
    `a failed release after a board read leaves its count null and unread, the queue and the relations read (${JSON.stringify(boardReleaseFailed.proposals)}, ${JSON.stringify(boardReleaseFailed.relations)})`);
  // A savepoint that fails after the findings reads wrote takes the values
  // back: neither field is both read and unread (the `clear`s; run-it, review pass 1).
  failRelease = /FROM supersession_proposals|FROM thought_facets/;
  const releaseFailed = await readDatabaseFacts(fake);
  failRelease = null;
  // …and the board reads after them, finding no field to fill, send nothing and record nothing.
  assert(releaseFailed.proposals === null && releaseFailed.unread.proposals?.reason === "error" && releaseFailed.relations === null && releaseFailed.unread.relations?.reason === "error"
      && !("proposals.boardPairs" in releaseFailed.unread) && !("relations.boardPairs" in releaseFailed.unread),
    `a failed release after the queue and relations reads leaves both null and unread (${JSON.stringify(releaseFailed.proposals)}, ${JSON.stringify(releaseFailed.relations)})`);
  // The workers' heartbeats (SMD-2261, PR 2) are read on preflight's lean read too.
  assert(JSON.stringify(facts.workers) === JSON.stringify({ heartbeats: [], ignored: 0 }) && JSON.stringify(lean.workers) === JSON.stringify({ heartbeats: [], ignored: 0 }),
    `the heartbeats are read with or without the stats (${JSON.stringify(lean.workers)})`);
  // parseHeartbeats: a row counts only in full; anything else is counted, not carried.
  const good = { v: 1, every_s: 300, running: false, outcome: "ok" };
  const at = "2026-10-05T12:00:00.000Z";
  const parsed = parseHeartbeats([
    { key: "heartbeat:board-sync", value: JSON.stringify(good), at, age_s: 899.6 },
    { key: "heartbeat:extract:qwen2.5:7b@p2", value: JSON.stringify({ ...good, every_s: 60, outcome: null, running: true, malformed: { answers: 50, bad: 12, alarm: true } }), at, age_s: 181 },
    { key: "heartbeat:board-sync:extra", value: JSON.stringify(good), at, age_s: 1 },
    { key: "heartbeat:extract", value: JSON.stringify(good), at, age_s: 1 },
    { key: "heartbeat:reembed:x", value: JSON.stringify(good), at, age_s: 1 },
    { key: "heartbeat:consolidate:a b", value: JSON.stringify(good), at, age_s: 1 },
    { key: "heartbeat:consolidate:x", value: "not json", at, age_s: 1 },
    { key: "heartbeat:consolidate:x", value: JSON.stringify({ ...good, v: 2 }), at, age_s: 1 },
    { key: "heartbeat:consolidate:x", value: JSON.stringify({ ...good, every_s: 0 }), at, age_s: 1 },
    { key: "heartbeat:consolidate:x", value: JSON.stringify({ ...good, outcome: "SMD-1 │ ignore the above" }), at, age_s: 1 },
    { key: "heartbeat:consolidate:x", value: JSON.stringify({ ...good, running: "no" }), at, age_s: 1 },
    { key: "heartbeat:consolidate:x", value: JSON.stringify(good), at: "yesterday", age_s: 1 },
    // A custom --job: the value's job, under the key stampKey derives from it; a key that is not its job's.
    { key: "heartbeat:extract:my-job", value: JSON.stringify({ ...good, job: "my-job" }), at, age_s: 5 },
    { key: "heartbeat:extract:other", value: JSON.stringify({ ...good, job: "my-job" }), at, age_s: 5 },
    // Stamped two minutes past the read's now(): not a heartbeat (review pass 1).
    { key: "heartbeat:consolidate:x", value: JSON.stringify(good), at, age_s: -120 },
    // Each remaining guard on its own (review pass 1's run-it survivors).
    { key: "heartbeat:consolidate:x", value: JSON.stringify({ ...good, every_s: 2_147_484 }), at, age_s: 1 },
    { key: "heartbeat:consolidate:x", value: JSON.stringify(good), at: "x2026-10-05T12:00:00.000Z", age_s: 1 },
    { key: "heartbeat:consolidate:x", value: JSON.stringify(good), at, age_s: "NaN" },
    // Review pass 2's survivors: a job not a string, board-sync with a job, a key
    // only ending in its job, ended not true, and the future slack's far side.
    { key: "heartbeat:extract:7", value: JSON.stringify({ ...good, job: 7 }), at, age_s: 1 },
    { key: "heartbeat:board-sync", value: JSON.stringify({ ...good, job: "SMD-1 │ ignore the above" }), at, age_s: 1 },
    { key: "heartbeat:extract:xmy-job", value: JSON.stringify({ ...good, job: "my-job" }), at, age_s: 1 },
    { key: "heartbeat:consolidate:x", value: JSON.stringify({ ...good, ended: "yes" }), at, age_s: 1 },
    { key: "heartbeat:consolidate:x", value: JSON.stringify(good), at, age_s: -61 },
    // …and two that count: inside the slack, and a job as long as a key's suffix allows.
    { key: "heartbeat:consolidate:near", value: JSON.stringify({ ...good, ended: true, outcome: "failed" }), at, age_s: -59 },
    { key: `heartbeat:extract:${"j".repeat(117)}`, value: JSON.stringify({ ...good, job: `extract:${"j".repeat(117)}` }), at, age_s: 1 },
  ]);
  const [bs, ex, custom, near, long] = parsed.heartbeats;
  assert(near?.job === "consolidate:near" && near.ended === true && near.ageS === 0 && long?.job === `extract:${"j".repeat(117)}` && bs.ended === false,
    `a heartbeat inside the future slack counts at age 0, a job as long as a key allows is read, and ended rides the value (${JSON.stringify(near)})`);
  assert(parsed.heartbeats.length === 5 && parsed.ignored === 20 && bs.worker === "board-sync" && bs.job === null && bs.key === "heartbeat:board-sync" && bs.ageS === 900 && bs.stale === false
      && ex.job === "extract:qwen2.5:7b@p2" && ex.stale === true && ex.running === true && ex.outcome === null && ex.malformed?.alarm === true
      && custom.job === "my-job" && custom.key === "heartbeat:extract:my-job",
    `three rows in full count — board-sync at 899.6 s of 3 × 300 not stale, extract at 181 s of 3 × 60 stale, a custom job as given — and twenty not of the shape are counted only (${parsed.heartbeats.length}, ${parsed.ignored})`);
  // A malformed block not of the shape is left off and the heartbeat still counts (review pass 3).
  const blocks = parseHeartbeats([{ answers: 5, bad: 6, alarm: false }, { answers: 50, bad: 1, alarm: "yes" }, null, { answers: -1, bad: 0, alarm: true }, { answers: 1.5, bad: 1, alarm: false }, { answers: "x", bad: 1, alarm: true }, { answers: 1, bad: "x", alarm: true }]
    .map((malformed, i) => ({ key: `heartbeat:consolidate:b${i}`, value: JSON.stringify({ ...good, malformed }), at, age_s: 1 })));
  assert(blocks.heartbeats.length === 7 && blocks.ignored === 0 && blocks.heartbeats.every((h) => h.malformed === null),
    `a heartbeat whose block is not of the shape counts, its block left off (${blocks.heartbeats.length}, ${blocks.ignored})`);
  const capped = parseHeartbeats([{ key: "heartbeat:board-sync", value: JSON.stringify(good), at, age_s: 1, total: 53 }]);
  assert(capped.heartbeats.length === 1 && capped.ignored === 52, `rows past the read's bound are counted as ignored (${capped.ignored})`);
  // The sleep scheduler's row (SMD-1794): read as board-sync's is, with no job.
  const slept = parseHeartbeats([
    { key: "heartbeat:sleep", value: JSON.stringify({ ...good, every_s: 60, running: true }), at, age_s: 30 },
    { key: "heartbeat:sleep:x", value: JSON.stringify(good), at, age_s: 1 },
    { key: "heartbeat:sleep", value: JSON.stringify({ ...good, job: "x" }), at, age_s: 1 },
  ]);
  assert(slept.heartbeats.length === 1 && slept.ignored === 2 && slept.heartbeats[0].worker === "sleep" && slept.heartbeats[0].job === null && slept.heartbeats[0].running === true,
    `heartbeat:sleep is read with no job, and one carrying a job, in its key or its value, is not (${slept.heartbeats.length}, ${slept.ignored})`);
  // Its sleep's mark (SMD-2678): carried when of the shape — a UTC instant from,
  // and to one or null — left off otherwise, the heartbeat still counted; and
  // never read off another worker's row.
  const marks = [
    { from: at, to: null }, { from: at, to: at },
    { from: "yesterday", to: null }, { from: at, to: "later" }, { from: at }, { to: at }, null, "x",
  ];
  const marked = parseHeartbeats(marks.map((s) => ({ key: "heartbeat:sleep", value: JSON.stringify({ ...good, slept: s }), at, age_s: 1 })));
  assert(marked.heartbeats.length === 8 && marked.ignored === 0
      && JSON.stringify(marked.heartbeats.map((h) => h.slept ?? null)) === JSON.stringify([{ from: at, to: null }, { from: at, to: at }, null, null, null, null, null, null]),
    `a sleep mark is carried only when of the shape, and its row counts either way (${JSON.stringify(marked.heartbeats.map((h) => h.slept ?? null))})`);
  const otherMark = parseHeartbeats([{ key: "heartbeat:board-sync", value: JSON.stringify({ ...good, slept: { from: at, to: null } }), at, age_s: 1 }]);
  assert(otherMark.heartbeats.length === 1 && otherMark.heartbeats[0].slept === undefined, "…and another worker's row carries none");
  // Its word on reading the query log (review pass 1): one of three, else left off; never another worker's.
  const readsOf = (key: string, reads: unknown) => parseHeartbeats([{ key, value: JSON.stringify({ ...good, reads }), at, age_s: 1 }]).heartbeats[0]?.reads;
  assert(readsOf("heartbeat:sleep", "yes") === "yes" && readsOf("heartbeat:sleep", "denied") === "denied" && readsOf("heartbeat:sleep", "missing") === "missing"
      && readsOf("heartbeat:sleep", "maybe") === undefined && readsOf("heartbeat:sleep", true) === undefined && readsOf("heartbeat:board-sync", "yes") === undefined,
    "the scheduler's reads word is carried when one of three, and never off another worker's row");
  // Its waiting passes and its refusal (SMD-2752): carried when of the shape, else left off; never another worker's.
  const markOf = (key: string, extra: Record<string, unknown>) => parseHeartbeats([{ key, value: JSON.stringify({ ...good, ...extra }), at, age_s: 1 }]).heartbeats[0];
  const waits = [["extract"], ["extract", "consolidate"], [], ["extract", "extract"], ["board-sync"], "extract", ["extract", "consolidate", "extract"]].map((w) => markOf("heartbeat:sleep", { waiting: w })?.waiting ?? null);
  assert(JSON.stringify(waits) === JSON.stringify([["extract"], ["extract", "consolidate"], null, null, null, null, null]) && markOf("heartbeat:board-sync", { waiting: ["extract"] })?.waiting === undefined,
    `the scheduler's waiting passes are carried by name, each once, and never off another worker's row (${JSON.stringify(waits)})`);
  const refusals = ["key", "identity", "lookup", "made-up", 2, null].map((r) => markOf("heartbeat:sleep", { refused: r })?.refused ?? null);
  // Since SMD-3214 db/supervise.ts's guard writes one on any compose follower's row, so every worker's is read.
  assert(JSON.stringify(refusals) === JSON.stringify(["key", "identity", "lookup", null, null, null]) && markOf("heartbeat:board-sync", { refused: "key" })?.refused === "key" && markOf("heartbeat:extract:x", { refused: "identity" })?.refused === "identity" && markOf("heartbeat:extract:x", { refused: "made-up" })?.refused === undefined && markOf("heartbeat:sleep", { refused: "made-up" }) !== undefined,
    `a refusal is carried when one of the list, on any worker's row, and its row counts either way (${JSON.stringify(refusals)})`);
  // The supervisor's next try (SMD-3214): on an ended row, of the shape, else left off — the row counted either way.
  const ended = { ended: true, outcome: "failed" };
  const restarts = [
    { in_s: 60, code: 2, tries: 1 }, { in_s: null, code: 2, tries: 0 }, { in_s: 900, code: 1, tries: 7 },
    { in_s: -1, code: 2, tries: 1 }, { in_s: 86_401, code: 2, tries: 1 }, { in_s: 60, code: 256, tries: 1 }, { in_s: 60, code: 2 }, { in_s: "60", code: 2, tries: 1 }, null, "soon",
  ].map((r) => markOf("heartbeat:board-sync", { ...ended, restart: r }));
  assert(restarts.every((h) => h !== undefined)
      && JSON.stringify(restarts.map((h) => h?.restart ?? null)) === JSON.stringify([{ inS: 60, code: 2, tries: 1 }, { inS: null, code: 2, tries: 0 }, { inS: 900, code: 1, tries: 7 }, null, null, null, null, null, null, null])
      && markOf("heartbeat:extract:x", { restart: { in_s: 60, code: 2, tries: 1 } })?.restart === undefined,
    `a restart is carried on an ended row when of the shape, never on a live one, and its row counts either way (${JSON.stringify(restarts.map((h) => h?.restart ?? null))})`);
  // Its words: held, with the cause and the next try by the row's own clock — the try past due said so — and none for a row no supervisor ended.
  const heldRow = (age_s: number, restart: unknown, extra: Record<string, unknown> = {}) =>
    parseHeartbeats([{ key: "heartbeat:sleep", value: JSON.stringify({ ...good, every_s: 60, ...ended, restart, ...extra }), at, age_s }]).heartbeats[0];
  const heldState = (h: ReturnType<typeof heldRow>) => heartbeatState(h!);
  const soon = heldState(heldRow(20, { in_s: 80, code: 2, tries: 2 }));
  const heldGuard = heldState(heldRow(5, { in_s: null, code: 2, tries: 0 }, { refused: "identity" }));
  const due = heldState(heldRow(120, { in_s: 60, code: 1, tries: 1 }));
  assert(/^held: exited 2, 2 end\(s\) in a row — its supervisor runs it again in 60 s \(last stamped 20 s ago/.test(soon)
      && /^held: refused \(identity\) — its supervisor runs it again only once the service is recreated/.test(heldGuard)
      && /^held: exited 1, 1 end\(s\) in a row — its supervisor ran it again 60 s ago, and it has not stamped since/.test(due)
      && heldState(heldRow(5, undefined)) === "ended on a failure (last stamped 5 s ago, every 60 s)",
    `a held row reads held, its cause and its next try — the try past due said so — and an ended row with none reads as before (${soon} | ${heldGuard} | ${due})`);
  // A follower ended on its start's refusal says the kind; the scheduler's row leaves it to preflight's own words (SMD-3214).
  const endedWith = (key: string) => heartbeatState(parseHeartbeats([{ key, value: JSON.stringify({ ...good, every_s: 60, ...ended, refused: "linear-key" }), at, age_s: 5 }]).heartbeats[0]!);
  assert(endedWith("heartbeat:board-sync") === "ended on a failure, refused at its start (linear-key) (last stamped 5 s ago, every 60 s)"
      && endedWith("heartbeat:sleep") === "ended on a failure (last stamped 5 s ago, every 60 s)",
    `an ended follower says its start's refusal by kind, the scheduler's row as before (${endedWith("heartbeat:board-sync")})`);
  // Its budget (SMD-2679): the stop's word on a sleep that is over, of the two, and the budget of the shape; else left off, the row counted.
  const stops = [{ from: at, to: at, budget: "clock" }, { from: at, to: at, budget: "statement" }, { from: at, to: null, budget: "clock" }, { from: at, to: at, budget: "rest" }]
    .map((m) => markOf("heartbeat:sleep", { slept: m })?.slept?.budget ?? null);
  // The bound rides with the word only, within its kind's range; `resting` only true, only the scheduler's.
  const limits = [{ budget: "clock", limit: 60 }, { budget: "statement", limit: 0 }, { budget: "clock", limit: 10_081 }, { budget: "statement", limit: -1 }, { limit: 60 }]
    .map((m) => markOf("heartbeat:sleep", { slept: { from: at, to: at, ...m } })?.slept?.limit ?? null);
  assert(JSON.stringify(limits) === JSON.stringify([60, 0, null, null, null]) && markOf("heartbeat:sleep", { resting: true })?.resting === true
      && markOf("heartbeat:sleep", { resting: "yes" })?.resting === undefined && markOf("heartbeat:board-sync", { resting: true })?.resting === undefined
      // Not on a row that speaks for nothing running: ended, or stale (review pass 2).
      && markOf("heartbeat:sleep", { resting: true, ended: true, outcome: "stopped" })?.resting === undefined
      && parseHeartbeats([{ key: "heartbeat:sleep", value: JSON.stringify({ ...good, every_s: 60, resting: true }), at, age_s: 181 }]).heartbeats[0]?.resting === undefined,
    `a stop's bound is carried with its word and within its kind's range, and resting only when true on the scheduler's row (${JSON.stringify(limits)})`);
  const BUDGET = { minutes: 60, statementTimeoutS: 300, workMemMb: 4, maintenanceWorkMemMb: 64, stops: 3 };
  const budgets = [BUDGET, { ...BUDGET, stops: -1 }, { ...BUDGET, workMemMb: 0 }, { ...BUDGET, minutes: 10_081 }, { ...BUDGET, statementTimeoutS: "300" }, null]
    .map((b) => markOf("heartbeat:sleep", { budget: b })?.budget?.stops ?? null);
  assert(JSON.stringify(stops) === JSON.stringify(["clock", "statement", null, null]) && JSON.stringify(budgets) === JSON.stringify([3, null, null, null, null, null])
      && markOf("heartbeat:board-sync", { budget: BUDGET })?.budget === undefined && markOf("heartbeat:sleep", { budget: { ...BUDGET, stops: -1 } }) !== undefined,
    `the scheduler's budget stop is carried on a sleep that is over and of the two, its budget when of the shape, never off another worker's row (${JSON.stringify(stops)}; ${JSON.stringify(budgets)})`);
  assert(heartbeatState(bs) === "alive (last stamped 15 min ago, every 300 s)" && heartbeatState(ex) === "stale (last stamped 3 min ago, every 60 s; 12 of its last 50 answers malformed)"
      && heartbeatState({ ...bs, outcome: "failed" }) === "alive, its last pass failed (last stamped 15 min ago, every 300 s)"
      && heartbeatState({ ...bs, running: true, waiting: ["extract"] }) === "waiting for the provider at a pass's start (last stamped 15 min ago, every 300 s)" && heartbeatState({ ...bs, running: true }) === "running a pass (last stamped 15 min ago, every 300 s)"
      && heartbeatState({ ...bs, stale: true, outcome: "failed" }) === "stale (last stamped 15 min ago, every 300 s, its last pass failed)"
      && heartbeatState({ ...bs, outcome: "stopped", ended: true }) === "stopped (last stamped 15 min ago, every 300 s)"
      && heartbeatState({ ...bs, outcome: "failed", ended: true }) === "ended on a failure (last stamped 15 min ago, every 300 s)"
      && heartbeatState({ ...bs, outcome: "failed", ended: true, stale: true }) === "ended on a failure (last stamped 15 min ago, every 300 s)"
      && heartbeatState({ ...bs, running: true, outcome: "failed" }) === "running a pass, its last pass failed (last stamped 15 min ago, every 300 s)",
    `heartbeatState words alive, failed, stale, stopped (fresh or not) and the alarm (${heartbeatState(ex)})`);
  assert([ago(45), ago(120), ago(5400), ago(200000)].join("|") === "45 s|2 min|2 h|2 d", `ago reads seconds, minutes, hours, days (${[ago(45), ago(120), ago(5400), ago(200000)].join("|")})`);
  const server0 = () => ({ version: FORK_VERSION, releaseRange: [49, 51] as const, latestMigration: 52, commit: "abc1234", store: "sql", tier: null, embedding: { model: "m", dim: 1024 } });
  heartbeatRows = [{ key: "heartbeat:board-sync", value: JSON.stringify(good), at, age_s: 10 }, { key: "heartbeat:x", value: "{}", at, age_s: 1 }];
  const withBeats = renderBrainInfo(await brainInfo(server0(), async () => readDatabaseFacts(fake), 1000));
  heartbeatRows = [];
  assert(/^Workers: +board-sync alive \(last stamped 10 s ago, every 300 s\) \(1 heartbeat row\(s\) not of the shape, ignored\)$/m.test(withBeats),
    `the table's Workers row names each heartbeat and the rows ignored (${withBeats.split("\n").find((l) => l.startsWith("Workers"))})`);
  // The row's other states: none stamped (with what was ignored), and ob1_config not read.
  heartbeatRows = [{ key: "heartbeat:x", value: "{}", at, age_s: 1 }];
  const noneRow = renderBrainInfo(await brainInfo(server0(), async () => readDatabaseFacts(fake), 1000)).split("\n").find((l) => l.startsWith("Workers"));
  heartbeatRows = [];
  const lostRow = renderBrainInfo(await brainInfo(server0(), async () => ({ ...facts, workers: null, unread: { workers: { reason: "refused", message: "permission denied for table ob1_config" } } }), 1000)).split("\n").find((l) => l.startsWith("Workers"));
  assert(/^Workers: +none stamped — no long-running worker has run here \(1 heartbeat row\(s\) not of the shape, ignored\)$/.test(noneRow ?? "") && /^Workers: +\? \(ob1_config not readable by this role\)$/.test(lostRow ?? ""),
    `the Workers row reads none stamped, or ? when not read (${noneRow} / ${lostRow})`);


  const server = { version: FORK_VERSION, releaseRange: [49, 51] as const, latestMigration: 52, commit: "abc1234", store: "sql", tier: null, embedding: { model: "m", dim: 1024 } };
  const planted = (highest: number | null, over: Partial<Facts> = {}): Facts => ({ ...facts, ledger: { present: true, names: highest === null ? [] : [`${highest}_x.sql`] }, highestMigration: highest, unread: {}, ...over });
  const ahead = await brainInfo(server, async () => planted(53), 1000);
  const aheadText = renderBrainInfo(ahead);
  assert(ahead.ledgerStatus === "ahead" && /^Migrations: +053 applied — this server's tree ends at 052 \(the brain is ahead of it\)$/m.test(aheadText),
    `a ledger past the tree is ahead, in the record and the table (${aheadText.split("\n").find((l) => l.startsWith("Migrations"))})`);
  const behindText = renderBrainInfo(await brainInfo(server, async () => planted(51), 1000));
  assert(/^Migrations: +051 applied — this server's tree ends at 052 \(the brain is behind it\)$/m.test(behindText), "…one short of it is behind");
  const db = ahead.database as { ledger: Record<string, unknown> };
  assert(JSON.stringify(db.ledger) === JSON.stringify({ present: true, readable: true }), `the record carries the ledger's standing, not its names (${JSON.stringify(db.ledger)})`);
  const unreadText = renderBrainInfo(await brainInfo(server, async () => planted(52, { unread: { ob1_config: { reason: "refused", message: "permission denied for table ob1_config" } }, schemaVersion: null }), 1000));
  assert(/^Schema version: +\? \(ob1_config not readable by this role\)$/m.test(unreadText) && /^Brain embedding: +\? \(ob1_config not readable by this role\)$/m.test(unreadText) && /^Not read: +ob1_config — not readable by this role: permission denied/m.test(unreadText),
    "an ob1_config this role cannot read is `?`, not `none recorded`");
  const readText = renderBrainInfo(await brainInfo(server, async () => facts, 1000));
  assert(/^Rows: +7 thoughts · \? audit events · no table chunks · \? entities$/m.test(readText) && /^Migrations: +schema_migrations not read in time/m.test(readText) && /^Database size: +10\.8 MB$/m.test(readText),
    `the table says which count was not read and which table is absent, and a timed-out ledger is not called a grant (${readText.split("\n").find((l) => l.startsWith("Migrations"))})`);
  const noBoard = renderBrainInfo(await brainInfo(server, async () => planted(52, { boardSync: null }), 1000));
  const lostBoard = renderBrainInfo(await brainInfo(server, async () => planted(52, { boardSync: null, unread: { boardSync: { reason: "timeout", message: "canceling statement due to statement timeout" } } }), 1000));
  assert(/^Board sync: +2026-09-24T12:00:00\.000Z$/m.test(readText) && /^Board sync: +none — no thought carries a usable Linear watermark$/m.test(noBoard) && /^Board sync: +\?$/m.test(lostBoard),
    `the table's board-sync row: the watermark, none, or ? when not read (${[readText, noBoard, lostBoard].map((t) => t.split("\n").find((l) => l.startsWith("Board sync"))).join(" / ")})`);
  // The findings rows (SMD-2680): the queue and the relations, none, ? when not read, and no table.
  const quiet = renderBrainInfo(await brainInfo(server, async () => planted(84, { proposals: { pending: 0, stale: 0, oldestPendingS: null, boardPairs: 0 }, relations: { related: 0, evolves: 0, duplicate: 0, distinct: 0, boardPairs: 0 } }), 1000));
  const staleOnly = renderBrainInfo(await brainInfo(server, async () => planted(84, { proposals: { pending: 0, stale: 3, oldestPendingS: null, boardPairs: 0 }, relations: { related: 2, evolves: 0, duplicate: 0, distinct: 0, boardPairs: 0 } }), 1000));
  // 102 (SMD-3117): the pairs judged distinct, beside the relations and outside their count — with relations, alone, and one.
  const withApart = renderBrainInfo(await brainInfo(server, async () => planted(100, { relations: { related: 2, evolves: 0, duplicate: 0, distinct: 5, boardPairs: 0 } }), 1000));
  const onlyApart = renderBrainInfo(await brainInfo(server, async () => planted(100, { relations: { related: 0, evolves: 0, duplicate: 0, distinct: 1, boardPairs: 0 } }), 1000));
  const lostFindings = renderBrainInfo(await brainInfo(server, async () => planted(52, { proposals: null, relations: null, unread: { proposals: { reason: "refused", message: "permission denied for table supersession_proposals" }, relations: { reason: "timeout", message: "canceling statement due to statement timeout" } } }), 1000));
  const boardLost = renderBrainInfo(await brainInfo(server, async () => planted(84, { unread: { "proposals.boardPairs": { reason: "timeout", message: "canceling statement due to statement timeout" } }, proposals: { pending: 6, stale: 0, oldestPendingS: 60, boardPairs: null } }), 1000));
  const execLost = renderBrainInfo(await brainInfo(server, async () => planted(84, { unread: { "proposals.boardPairs": { reason: "refused", message: "permission denied for function consolidation_tickets_linked" } }, proposals: { pending: 6, stale: 0, oldestPendingS: 60, boardPairs: null } }), 1000));
  const relBoardLost = renderBrainInfo(await brainInfo(server, async () => planted(84, { relations: { related: 2, evolves: 0, duplicate: 0, distinct: 0, boardPairs: null }, unread: { "relations.boardPairs": { reason: "timeout", message: "x" } } }), 1000));
  const pre079 = renderBrainInfo(await brainInfo(server, async () => planted(78, { proposals: { pending: 2, stale: 0, oldestPendingS: 60, boardPairs: null } }), 1000));
  const denied = [deniedObject("permission denied for table thoughts"), deniedObject("permission denied for function consolidation_tickets_linked"), deniedObject("canceling statement due to lock timeout")];
  assert(JSON.stringify(denied) === '[{"kind":"table","name":"thoughts"},{"kind":"function","name":"consolidation_tickets_linked"},null]', `a refusal names its table or function (${JSON.stringify(denied)})`);
  const noTables = renderBrainInfo(await brainInfo(server, async () => planted(52, { proposals: null, relations: null }), 1000));
  const pre084 = renderBrainInfo(await brainInfo(server, async () => planted(83, { relations: { related: 0, evolves: 0, duplicate: 0, distinct: 0, boardPairs: 0 } }), 1000));
  const line = (t: string, label: string) => t.split("\n").find((l) => l.startsWith(label)) ?? "";
  assert(/^Proposals: +6 pending \(the oldest judged 3 d ago; 4 pair two tickets the board does not link\); 2 stale$/m.test(readText) && /^Relations: +14 standing \(9 related, 4 evolves, 1 duplicate; 11 pair two tickets the board does not link\); 3 pairs judged distinct$/m.test(readText)
      && /^Relations: +2 standing \(2 related, 0 evolves, 0 duplicate\); 5 pairs judged distinct$/m.test(withApart) && /^Relations: +none standing; 1 pair judged distinct$/m.test(onlyApart)
      && /^Relations: +none — migration 084 is not applied$/m.test(pre084)
      && /^Proposals: +none pending$/m.test(quiet) && /^Relations: +none standing$/m.test(quiet)
      && /^Proposals: +none pending; 3 stale$/m.test(staleOnly) && /^Relations: +2 standing \(2 related, 0 evolves, 0 duplicate\)$/m.test(staleOnly)
      && /^Proposals: +\? \(supersession_proposals not readable by this role\)$/m.test(lostFindings) && /^Proposals: +2 pending \(the oldest judged 60 s ago\)$/m.test(pre079) && /^Proposals: +6 pending \(the oldest judged 60 s ago; board pairs \? \(not read in time\)\)$/m.test(boardLost) && /^Relations: +2 standing \(2 related, 0 evolves, 0 duplicate; board pairs \? \(not read in time\)\)$/m.test(relBoardLost) && /^Proposals: +6 pending \(the oldest judged 60 s ago; board pairs \? \(079's predicate not executable by this role\)\)$/m.test(execLost) && /^Relations: +\? \(thought_facets not read in time\)$/m.test(lostFindings)
      && /^Proposals: +no table — migration 029 is not applied$/m.test(noTables) && /^Relations: +no table — migration 042 is not applied$/m.test(noTables),
    `the table's findings rows: the counts, none (before 084, why), ? when not read, no table (${[readText, quiet, staleOnly, lostFindings, noTables, pre084].map((t) => `${line(t, "Proposals")} + ${line(t, "Relations")}`).join(" / ")})`);

  // The deadline keeps what was read (review pass 2: it threw every fact away).
  // A count that never answers: the catalog, the config and the ledger stand,
  // the hanging read and every one after it are `deadline`. Each call raced
  // against a guard of its own, so a missing deadline fails here by name.
  const guard = <T>(p: Promise<T>) => Promise.race([p, Bun.sleep(3000).then(() => null)]);
  hang.add("FROM thoughts");
  const t0 = performance.now();
  const partial = await guard(brainInfo(server, (progress) => readDatabaseFacts(fake, {}, progress), 100));
  const took = performance.now() - t0;
  hang.clear();
  const pd = partial && !("error" in partial.database) ? partial.database : null;
  assert(pd !== null && took < 1000 && pd.postgres === "16.15" && pd.schemaVersion === "1.1.0+upstream.9543c29"
      && pd.unread["counts.thoughts"]?.reason === "deadline" && pd.unread["counts.thoughts"]?.message === "not read before the deadline"
      && pd.unread.databaseBytes?.reason === "deadline" && pd.unread.ledger?.reason === "timeout",
    `at the deadline the facts read so far stand and the rest are named (${Math.round(took)} ms, ${JSON.stringify(pd?.unread)})`);
  // A table absent everywhere was settled before any read, so the deadline
  // never names it (review pass 3: it rendered '?' for 'no table').
  assert(pd !== null && !("counts.thought_chunks" in pd.unread) && pd.unread["counts.thought_audit"]?.reason === "invisible",
    "at the deadline an absent table is still absent, an invisible one still invisible");
  // A deadline between a read's write and its savepoint's RELEASE: the fact is
  // read, and not named `deadline` (review pass 3: the snapshot tore).
  releaseMs = 150;
  const torn = await guard(brainInfo(server, (progress) => readDatabaseFacts(fake, {}, progress), 60));
  releaseMs = 0;
  const td = torn && !("error" in torn.database) ? torn.database : null;
  assert(td !== null && td.schemaVersion === "1.1.0+upstream.9543c29" && !("ob1_config" in td.unread),
    `a fact written before its savepoint's release is read, not deadline (${JSON.stringify(td?.unread.ob1_config)})`);
  // A failure after the catalog answered — here the COMMIT — keeps what was
  // read (review pass 3: it threw every fact away).
  failCommit = true;
  const dropped = await guard(brainInfo(server, (progress) => readDatabaseFacts(fake, {}, progress), 1000));
  failCommit = false;
  assert(dropped !== null && !("error" in dropped.database) && dropped.database.postgres === "16.15" && dropped.database.schemaVersion === "1.1.0+upstream.9543c29"
      && /terminating connection/.test(dropped.database.unread.transaction?.message ?? ""),
    `a failure after every read answered keeps the facts, and is named rather than lost (review pass 4: ${JSON.stringify(dropped && !("error" in dropped.database) ? dropped.database.unread.transaction : null)})`);
  // A savepoint that fails after its read wrote (its RELEASE): the value is
  // taken back, so the ledger is not both read and unread (review pass 4:
  // `current` beside "schema_migrations not read").
  answerLedger = true;
  const tx2Facts = await (async () => {
    // The first savepoint is ob1_config's, the second the heartbeats'
    // (SMD-2261); fail the third, the ledger's.
    // Fresh function objects: Object.assign onto `tag` would replace the
    // shared fake's own savepoint and begin.
    let n = 0;
    const run = (strings: TemplateStringsArray) => tag(strings);
    const counting = Object.assign((strings: TemplateStringsArray) => run(strings), {
      savepoint: async <T>(fn: (sp: typeof run) => Promise<T>) => {
        const r = await fn(run);
        if (++n === 3) throw pgError("server closed the connection unexpectedly", "08006");
        return r;
      },
    });
    const client = Object.assign((strings: TemplateStringsArray) => run(strings), { begin: async <T>(fn: (t: typeof counting) => Promise<T>) => fn(counting) });
    return readDatabaseFacts(client);
  })();
  answerLedger = false;
  assert(tx2Facts.unread.ledger?.reason === "error" && tx2Facts.highestMigration === null && tx2Facts.ledger.names === null,
    `a ledger read whose savepoint then failed is unread, its highest taken back (${tx2Facts.highestMigration}, ${JSON.stringify(tx2Facts.unread.ledger)})`);
  // A deadline during a SAVEPOINT round trip starts no statement after it
  // (review pass 4: the abandoned read ran one more count).
  savepointMs = 120;
  statements.length = 0;
  await guard(brainInfo(server, (progress) => readDatabaseFacts(fake, {}, progress), 60));
  await Bun.sleep(300);
  savepointMs = 0;
  assert(!statements.some((t) => /FROM ob1_config/.test(t)), "a deadline during the SAVEPOINT round trip: the read inside it never runs");

  // Between cuts the version stays the last cut's; the tail says what this
  // tree adds (review pass 4). A release image's tree ends at the range.
  const between = await brainInfo(server, async () => planted(52), 1000);
  const cut = await brainInfo({ ...server, latestMigration: 51 }, async () => planted(51), 1000);
  assert(JSON.stringify(between.unreleased) === "[52,52]" && /^Version: .*\(release range 049–051; this tree adds 052, unreleased\)$/m.test(renderBrainInfo(between)) && cut.unreleased === null,
    `the version names the unreleased tail between cuts, and none at a cut (${JSON.stringify(between.unreleased)}, ${JSON.stringify(cut.unreleased)})`);
  // An abandoned read starts nothing more: a count that answers after the
  // deadline is the last statement it runs — no size read follows it.
  slow.add("FROM thoughts");
  statements.length = 0;
  await guard(brainInfo(server, (progress) => readDatabaseFacts(fake, {}, progress), 50));
  await Bun.sleep(300);
  slow.clear();
  assert(statements.some((t) => /FROM thoughts/.test(t)) && !statements.some((t) => /FROM thought_chunks|pg_database_size/.test(t)),
    "an abandoned read stops at the deadline: no read is started after it");
  hang.add("server_version");
  const none = await guard(brainInfo(server, (progress) => readDatabaseFacts(fake, {}, progress), 50));
  hang.clear();
  assert(none !== null && "error" in none.database && /no answer within 50 ms/.test(none.database.error) && none.ledgerStatus === null,
    "a catalog that never answers is the database's error at the deadline, the server's facts still there");
}

// The Vectors row (SMD-2889): how many wait, none, or why not read.
{
  const { vectorsLine } = await import("./brain-info.ts");
  assert(vectorsLine({ vectorless: 0, unread: {} }) === "every thought has one", "none waiting: said");
  assert(vectorsLine({ vectorless: 1, unread: {} }) === "1 thought waits for a vector — the servers' vector mender embeds it once the provider answers and the egress gate allows the call", `one: singular (${vectorsLine({ vectorless: 1, unread: {} })})`);
  assert(/^1,204 thoughts wait for a vector — the servers' vector mender embeds them/.test(vectorsLine({ vectorless: 1204, unread: {} })), "many: counted, plural");
  assert(/^\? \(thoughts /.test(vectorsLine({ vectorless: null, unread: { vectorless: { reason: "timeout", message: "canceling statement due to statement timeout" } } })) && vectorsLine({ vectorless: null, unread: {} }) === "no table",
    `not read: why; no table: said (${vectorsLine({ vectorless: null, unread: { vectorless: { reason: "timeout", message: "x" } } })})`);
}

// The Provider row (SMD-2890): not called yet, answering, or degraded since when, why, and what still works.
{
  const { providerWords, renderBrainInfo } = await import("./brain-info.ts");
  const R = { reprobeS: 15, reprobeByCall: true };
  assert(providerWords({ status: "unknown", ...R }) === "not called yet", "unknown: not called yet");
  // What answered says what is known (review pass 4): a call embeds; GET /models only reaches; a call refused or unusable is a fault.
  assert(providerWords({ status: "answering", at: "2026-10-22T00:00:00.000Z", by: "call", ...R }) === "answering (an embedding call answered 2026-10-22T00:00:00.000Z)", "answering by a call: it embeds");
  assert(providerWords({ status: "answering", at: "2026-10-22T00:00:00.000Z", by: "probe", ...R }) === "reachable (GET /models answered 2026-10-22T00:00:00.000Z); no embedding call made since", "answering by the probe: reachable, nothing said of the calls");
  assert(/^answering, but refusing its embedding calls \(it answered 404, 2026-10-22T00:00:00\.000Z\) — a capture fails outright until that is fixed: check the model is pulled and the key$/.test(providerWords({ status: "answering", at: "2026-10-22T00:00:00.000Z", by: "call", fault: "it answered 404", ...R })),
    "a fault: the provider there, a capture failing outright, what to check");
  const down = { status: "unreachable" as const, since: "2026-10-22T00:00:00.000Z", at: "2026-10-22T00:01:00.000Z", reason: "provider_unreachable", detail: "the connection was refused", clears: "probe" as const };
  assert(providerWords({ ...down, ...R }) === "unreachable since 2026-10-22T00:00:00.000Z (the connection was refused) — serving degraded: a capture lands without its vector, a search answers by exact matches; re-probed every 15 s by GET /models",
    `unreachable: since its first outage, why, what still works, the re-probe (${providerWords({ ...down, ...R })})`);
  assert(/; it is not re-probed, so a call that is answered clears this$/.test(providerWords({ ...down, reprobeS: null, reprobeByCall: false })), "…and with no re-probe, what clears it");
  // A call's 5xx GET /models cannot see (a proxy answering /models, its backend down): "failing its calls", re-probed by a call — or, the gate refusing that call, only a call ends it.
  const proxied = { ...down, reason: "provider_503", detail: "it answered 503", clears: "call" as const };
  assert(/^failing its calls since .*; re-probed every 15 s by one embedding call, as GET \/models cannot see a call's 503$/.test(providerWords({ ...proxied, ...R })),
    `a call's 503: failing, re-probed by a call (${providerWords({ ...proxied, ...R })})`);
  assert(/; GET \/models cannot see a call's 503 and the egress gate refuses the probe's embedding call, so only a call that is answered clears this$/.test(providerWords({ ...proxied, reprobeS: 15, reprobeByCall: false })),
    "…and with the gate refusing the probe's call, only a call clears it, and why");
  assert(/^unreachable since .*re-probed every 15 s by one embedding call, as GET \/models cannot see a call's timeout$/.test(providerWords({ ...proxied, reason: "provider_timeout", detail: "the request timed out (OB1_LLM_TIMEOUT)", ...R })),
    "a call's timeout: unreachable, re-probed by a call");
  const base = { version: "1.0.0", releaseRange: null, latestMigration: 1, commit: "c", store: "sql", tier: null, embedding: { model: "m", dim: 4 }, database: { error: "x" }, ledgerStatus: null } as never;
  const shown = renderBrainInfo({ ...(base as object), provider: { ...down, ...R } } as never);
  const lines = shown.split("\n");
  const at = lines.findIndex((l) => l.startsWith("Embedding:"));
  assert(/^Provider:\s+unreachable since 2026-10-22T00:00:00\.000Z/.test(lines[at + 1] ?? ""), `the row follows Embedding (${lines[at + 1]})`);
  assert(!/^Provider:/m.test(renderBrainInfo(base)), "…and a record without the field (an older server's, forwarded) has no row");
}

console.log("\n[2] A keyed /health answers within its deadline from a database that accepts and never replies, and one that refuses at once says so (SMD-2041 review passes 1–2)");
{
  // Two child servers, each with a database of its own making.
  // The first's database is a listener that takes the connection and says
  // nothing: the driver waits out its connect timeout (30 s), and both the
  // registry check and the read wait with it. Before review pass 1 the probe
  // got no reply at all. Since pass 2 a registry with no answer by the
  // deadline gets `ok` — it could still have said revoked. The second's
  // database refuses at once: the registry reports it cannot reach it (not a
  // refusal, agents.ts), and the record carries the database's error and the
  // commit the build arg baked.
  const { HEALTH_DEADLINE_MS } = await import("./index.ts");
  const freePort = () => { const p = Bun.serve({ port: 0, fetch: () => new Response() }); const n = p.port!; p.stop(true); return n; };
  const child = (port: number, databaseUrl: string) => Bun.spawn(["bun", "--no-env-file", "index.ts"], {
    cwd: import.meta.dir,
    env: { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl, MCP_ACCESS_KEY: KEY, OB1_GIT_SHA: "c0ffee1" },
    stdout: "ignore",
    stderr: "ignore",
  });
  const up = async (port: number) => {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) return true;
      await Bun.sleep(50);
    }
    return false;
  };
  const keyed = async (port: number, method: string) => {
    const t0 = performance.now();
    const r = await fetch(`http://127.0.0.1:${port}/health`, { method, headers: { "x-brain-key": KEY }, signal: AbortSignal.timeout(HEALTH_DEADLINE_MS + 5000) }).catch((e: Error) => e);
    const took = performance.now() - t0;
    return { took, status: r instanceof Response ? r.status : r.name, body: r instanceof Response ? await r.text() : "" };
  };
  const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
  const silentPort = freePort();
  const quiet = child(silentPort, `postgres://u:p@127.0.0.1:${silent.port}/db`);
  const refusedPort = freePort();
  const refusing = child(refusedPort, `postgres://u:p@127.0.0.1:${freePort()}/db`);
  try {
    assert(await up(silentPort) && await up(refusedPort), "both child servers answer a keyless probe");
    const get = await keyed(silentPort, "GET");
    assert(get.status === 200 && get.body === "ok" && get.took < HEALTH_DEADLINE_MS + 1500,
      `keyed GET /health, the database silent → 200 \`ok\` in ${Math.round(get.took)} ms (deadline ${HEALTH_DEADLINE_MS} ms)`);
    const head = await keyed(silentPort, "HEAD");
    assert(head.status === 200 && head.body === "" && head.took < 500, `keyed HEAD /health reads nothing and answers at once (${Math.round(head.took)} ms)`);
    const refused = await keyed(refusedPort, "GET");
    let info: Record<string, any> = {};
    try { info = JSON.parse(refused.body); } catch { /* asserted below */ }
    assert(refused.status === 200 && refused.took < HEALTH_DEADLINE_MS && typeof info.database?.error === "string" && info.ledgerStatus === null,
      `keyed GET /health, the database refusing → the record with the database's error in ${Math.round(refused.took)} ms (${info.database?.error})`);
    assert(info.version === FORK_VERSION && info.commit === "c0ffee1", `…carrying the server's own facts — the commit OB1_GIT_SHA names (${info.commit})`);
  } finally {
    quiet.kill();
    refusing.kill();
    silent.stop(true);
  }
}

console.log("\n[3] SIGTERM stops the server once what is in flight has ended, exit 0, within OB1_STOP_GRACE less 2 s, and says what it cut; SIGINT the same (SMD-2250)");
{
  // Child servers first, run the way the image runs them — index.ts the entry,
  // which is when the handlers go in. The first request in flight is a keyed
  // /health against a database that never replies ([2]'s), answered at its
  // deadline; the others stall before any response. As a child the process
  // is not PID 1, so without the handlers SIGTERM's default action kills it
  // at once: the request is cut off and there is no exit code, which is what
  // these rows fail on. Then the bounds against a stand-in server, the call
  // count, the grace period's parse and where compose and preflight read it.
  const { HEALTH_DEADLINE_MS } = await import("./index.ts");
  const freePort = () => { const p = Bun.serve({ port: 0, fetch: () => new Response() }); const n = p.port!; p.stop(true); return n; };
  const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
  // stdout and stderr both read: the per-request lines are warnings.
  const start = (env: Record<string, string> = {}) => {
    const port = freePort();
    const proc = Bun.spawn(["bun", "--no-env-file", "index.ts"], {
      cwd: import.meta.dir,
      env: { ...process.env, PORT: String(port), DATABASE_URL: `postgres://u:p@127.0.0.1:${silent.port}/db`, MCP_ACCESS_KEY: KEY, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = new Response(proc.stderr).text();
    return { port, proc, out: new Response(proc.stdout).text().then(async (o) => o + (await err)) };
  };
  const up = async (port: number) => {
    for (let i = 0; i < 200; i++) {
      if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) return true;
      await Bun.sleep(50);
    }
    return false;
  };
  // Bounded, and a child still running is killed, so its stdout ends and the row reads it rather than hanging.
  const exited = async (proc: ReturnType<typeof Bun.spawn>, ms: number) => {
    const code = await Promise.race([proc.exited.then(() => proc.exitCode), Bun.sleep(ms).then(() => "still running" as const)]);
    if (code === "still running") proc.kill("SIGKILL");
    return code;
  };

  const busy = start();
  // A malformed grace period: said, and read as the default (8 s of drain).
  const idle = start({ OB1_STOP_GRACE: "soon" });
  // With no connection string its store never builds, so it holds no pool: its stop must not say it closed one
  // (review pass 2; this child ran the PostgREST store, which held none, until SMD-3152 retired it).
  const ctrlC = start({ DATABASE_URL: "" });
  const cutter = start();
  // OB1_STOP_GRACE=3: the drain's bound is 1 s, so the real bound cuts on real Bun in a second.
  const graced = start({ OB1_STOP_GRACE: "3" });
  // A drained stop with a record still open (SMD-1849 PR 2c review pass 3).
  const leftBehind = start({ OB1_STOP_GRACE: "10" });
  // A tool call running past its client at the stop (SMD-2250 review pass 3); no store, so the call runs to its embedding.
  const calling = start({ DATABASE_URL: "" });
  try {
    assert(await up(busy.port) && await up(idle.port) && await up(ctrlC.port) && await up(cutter.port) && await up(graced.port) && await up(leftBehind.port) && await up(calling.port), "seven child servers answer a keyless probe (the first request, which hands the handlers the server)");

    const t0 = performance.now();
    const inFlight = fetch(`http://127.0.0.1:${busy.port}/health`, { headers: { "x-brain-key": KEY } })
      .then(async (r) => ({ status: r.status, body: await r.text(), at: performance.now() - t0 }), (e: Error) => ({ status: 0, body: e.message, at: performance.now() - t0 }));
    await Bun.sleep(300);
    busy.proc.kill("SIGTERM");
    // Polled, not slept on: a loaded runner may take a while to deliver the
    // signal, and until then the child rightly answers (review pass 1).
    let late = "";
    let refusedAt = Infinity;
    for (let i = 0; i < 40 && late !== "refused"; i++) {
      late = await fetch(`http://127.0.0.1:${busy.port}/health`).then((r) => `answered ${r.status}`, () => "refused");
      if (late === "refused") refusedAt = performance.now() - t0;
      else await Bun.sleep(50);
    }
    const answered = await inFlight;
    const code = await exited(busy.proc, HEALTH_DEADLINE_MS + 5_000);
    const took = performance.now() - t0;
    const log = await busy.out;
    assert(answered.status === 200 && answered.body === "ok" && answered.at >= HEALTH_DEADLINE_MS - 100,
      `the keyed /health in flight when SIGTERM landed is answered, 200 \`ok\` at its deadline (${Math.round(answered.at)} ms; got ${answered.status} ${answered.body.slice(0, 60)})`);
    assert(late === "refused" && refusedAt < answered.at, `…a new connection after the signal is refused while it is in flight (${late} at ${Math.round(refusedAt)} ms, the request answered at ${Math.round(answered.at)} ms)`);
    assert(code === 0 && took < HEALTH_DEADLINE_MS + 2_500, `…and the server exits 0 once it is, not at the drain bound (${code} at ${Math.round(took)} ms)`);
    assert(/SIGTERM: no longer accepting; 1 request in flight/.test(log) && /SIGTERM: stopped in [\d.]+ s; database pool not closed within 1000 ms; exit 0/.test(log),
      `…saying so on stdout, the request counted (${log.split("\n").filter((l) => l.startsWith("SIGTERM")).join(" | ")})`);

    const t1 = performance.now();
    idle.proc.kill("SIGTERM");
    const idleCode = await exited(idle.proc, 3_000);
    const idleLog = await idle.out;
    // Since SMD-2284 PR 3 the entry builds its store at start (root.ts's
    // serveHere, so the job reconcile runs then): the idle server holds a pool
    // on this silent database, and its stop closes it within the close bound.
    assert(idleCode === 0 && performance.now() - t1 < 2_500 && /0 requests in flight/.test(idleLog) && /database pool (?:closed|not closed within 1000 ms); exit 0/.test(idleLog),
      `an idle server stops at once — no request to drain, its pool within the close bound — exit 0 (${idleCode} in ${Math.round(performance.now() - t1)} ms)`);
    assert(/OB1_STOP_GRACE="soon" is not a whole number of seconds from 1 to 3600, with no unit .*; the stop drains as for 10 s/.test(idleLog) && /waited on for up to 8 s/.test(idleLog),
      "…and a malformed OB1_STOP_GRACE is said at start-up and read as the default, 8 s of drain");

    await fetch(`http://127.0.0.1:${ctrlC.port}/health`, { headers: { "x-brain-key": KEY } }); // builds its store
    ctrlC.proc.kill("SIGINT");
    const intCode = await exited(ctrlC.proc, 3_000);
    const intLog = await ctrlC.out;
    assert(intCode === 0 && /SIGINT: stopped in [\d.]+ s; no database pool was opened; exit 0/.test(intLog),
      `SIGINT stops it the same way, and a store that never built is not said to have a pool closed (${intCode}: ${intLog.split("\n").filter((l) => l.startsWith("SIGINT: stopped")).join("")})`);

    // A keyed call that stalls before its response — the registry lookup, on
    // the database that never replies — and two SIGTERMs: the second cuts the
    // drain short, the same path as the bound (onCut, then stop(true) not
    // waited on), in a fraction of the 8 s. Holds index.ts's flag, which picks
    // the cut line, on real Bun (review pass 2).
    const tc = performance.now();
    const stalled = fetch(`http://127.0.0.1:${cutter.port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": KEY },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then((r) => `answered ${r.status}`, () => "cut off");
    await Bun.sleep(300);
    cutter.proc.kill("SIGTERM");
    await Bun.sleep(200);
    cutter.proc.kill("SIGTERM");
    const cutCode = await exited(cutter.proc, 3_000);
    const cutLog = await cutter.out;
    const cutLines = cutLog.split("\n").filter((l) => /^request (cut off|abandoned)/.test(l));
    assert(cutCode === 1 && await stalled === "cut off" && performance.now() - tc < 2_500
      && cutLines.length === 1 && cutLines[0].startsWith("request cut off by the server's stop after 0.") && /SIGTERM: stopped in [\d.]+ s; database pool not closed: a second signal; exit 1|database pool not closed within 250 ms; exit 1/.test(cutLog),
      `a call stalled before its response, cut by a second signal: the cut line and not the client's, exit 1, the close given 250 ms (${cutCode} in ${Math.round(performance.now() - tc)} ms: ${cutLines.join(" | ").slice(0, 90)})`);
    // One SIGTERM, and the bound OB1_STOP_GRACE sets does the cutting.
    const tg = performance.now();
    const graceStalled = fetch(`http://127.0.0.1:${graced.port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": KEY },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then((r) => `answered ${r.status}`, () => "cut off");
    // Beside it, a keyed mirror held at the registry (the database never
    // answers; its deadline is 2.5 s, past the 1 s bound): only the stop's
    // cutOpenRequests can write its line — the MCP call above has its own
    // abort handler, this route none (review pass 4: no test held that call).
    const mirrorStalled = fetch(`http://127.0.0.1:${graced.port}/mcp/worker-status`, { headers: { "x-brain-key": KEY } })
      .then((r) => `answered ${r.status}`, () => "cut off");
    await Bun.sleep(300);
    graced.proc.kill("SIGTERM");
    const graceCode = await exited(graced.proc, 4_000);
    const graceLog = await graced.out;
    const graceTook = performance.now() - tg;
    await mirrorStalled;
    const graceLines = graceLog.split("\n").filter((l) => l.startsWith('{"ts"')).map((l) => JSON.parse(l) as Record<string, unknown>);
    assert(graceCode === 1 && await graceStalled === "cut off" && graceTook > 1_200 && graceTook < 3_000
      && /waited on for up to 1 s/.test(graceLog) && /still in flight.* after 1\.\d s, closed unfinished/.test(graceLog) && /^request cut off by the server's stop/m.test(graceLog)
      && graceLines.filter((l) => l.outcome === "cut" && l.route === undefined && l.agent === "MCP_ACCESS_KEY").length === 1,
      `OB1_STOP_GRACE=3 bounds the drain at 1 s: one SIGTERM, the stalled call cut at the bound with its line and its one JSON line, \`cut\`, exit 1 (${graceCode} in ${Math.round(graceTook)} ms)`);
    const mirrorCut = graceLines.filter((l) => l.route === "/worker-status");
    assert(mirrorCut.length === 1 && mirrorCut[0]?.outcome === "cut" && mirrorCut[0].tool === "worker_status" && mirrorCut[0].agent === "MCP_ACCESS_KEY" && mirrorCut[0].status === 0,
      `a keyed mirror held at the registry when the stop cuts it: one \`cut\` line, by its route and key, from the stop's cutOpenRequests (${JSON.stringify(mirrorCut)})`);
    // A keyed mirror whose client left while it waits on the registry. Bun 1.4.3 counts it done at once, so the stop
    // drains with it open and only the stop's endOpen writes its line — 0, \`abandoned\` (PR 2c review pass 3); Bun 1.4.0,
    // CI's and the image's, still counts it, so the drain waits for its handler, whose line says 200, \`abandoned\`
    // (review pass 4). Either way one line, and the branch is read from the child's own count.
    const leaving = new AbortController();
    const left = fetch(`http://127.0.0.1:${leftBehind.port}/mcp/jobs/${crypto.randomUUID()}`, { headers: { "x-brain-key": KEY }, signal: leaving.signal }).then(() => "answered", () => "left");
    await Bun.sleep(200);
    leaving.abort();
    await left;
    await Bun.sleep(50);
    leftBehind.proc.kill("SIGTERM");
    const leftCode = await exited(leftBehind.proc, 6_000);
    const leftLog = await leftBehind.out;
    const leftLines = leftLog.split("\n").filter((l) => l.startsWith('{"ts"')).map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.route === "/jobs/:id");
    const leftCounted = /1 request in flight/.test(leftLog);
    assert(leftCode === 0 && (leftCounted || /0 requests in flight/.test(leftLog)) && leftLines.length === 1 && leftLines[0]?.outcome === "abandoned"
      && leftLines[0].agent === "MCP_ACCESS_KEY" && leftLines[0].status === (leftCounted ? 200 : 0),
      `a mirror whose client left, at a drained stop: one \`abandoned\` line — the stop's, before the flush, where the runtime let it go; its handler's where the drain waited (${leftCode}, ${leftCounted ? "counted" : "let go"}; ${JSON.stringify(leftLines)})`);
    // A tool call whose client has left, still running when SIGTERM lands. Bun 1.4.3 no longer counts its request, so
    // only index.ts's count of tool calls holds the stop until the call ends; before review pass 3 a stop like this
    // exited under the call, and its capture was lost. Bun 1.4.0 still counts the request, which holds the stop too.
    const tw = performance.now();
    const leaver = new AbortController();
    const waitedOn = fetch(`http://127.0.0.1:${calling.port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": KEY },
      signal: leaver.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_thoughts", arguments: { query: SLOW_QUERY } } }),
    }).then(async (r) => { await r.text(); return "read"; }, () => "left");
    await Bun.sleep(300);
    leaver.abort();
    const leftCall = await waitedOn;
    await Bun.sleep(200);
    calling.proc.kill("SIGTERM");
    const callCode = await exited(calling.proc, SLOW_CALL_MS + 3_000);
    const callTook = performance.now() - tw;
    const callLog = await calling.out;
    const callStop = callLog.split("\n").find((l) => l.startsWith("SIGTERM: no longer accepting")) ?? "";
    assert(leftCall === "left" && callCode === 0 && callTook >= SLOW_CALL_MS && /; (?:0 requests in flight, 1 tool call running|1 request in flight)\b/.test(callStop),
      `a tool call running past its client when SIGTERM lands holds the stop until it ends, exit 0 (${leftCall}; ${callCode} at ${Math.round(callTook)} ms, the call ${SLOW_CALL_MS} ms; ${callStop})`);
  } finally {
    for (const { proc } of [busy, idle, ctrlC, cutter, graced, leftBehind, calling]) proc.kill("SIGKILL");
    silent.stop(true);
  }

  // The bounds, against a stand-in server: a request that never finishes is
  // cut off at the drain bound (exit 1, named), a second signal cuts the wait
  // short, a pool that will not close is left at its bound, and with no server
  // yet there is nothing to wait on. The stand-in's stop(true) never resolves
  // either, as Bun's does not while a handler has yet to return (review pass 1).
  const { drainOnSignal, isStoppable, createCallCount, drainBoundFrom } = await import("./shutdown.ts");
  const { cutByStopLine, abandonedRequestLine } = await import("./index.ts");
  const stuck = () => {
    const calls: string[] = [];
    return { calls, server: { pendingRequests: 1, stop: (force?: boolean) => { calls.push(force ? "stop(true)" : "stop()"); return new Promise<void>(() => {}); } } };
  };
  const harness = (opts: Partial<Parameters<typeof drainOnSignal>[0]> & { server: () => any }) => {
    const handlers = new Map<string, () => void>();
    const lines: string[] = [];
    const exits: number[] = [];
    // The flush's budget at the close's bound, so a stalled collector's row takes 100 ms, not FLUSH_BUDGET_MS (SMD-2902).
    const { stopped } = drainOnSignal({ close: async () => true, drainBoundMs: 200, closeBoundMs: 100, flushBudgetMs: 100, log: (l) => lines.push(l), exit: (c) => exits.push(c), on: (s, h) => handlers.set(s, h), ...opts });
    return { handlers, lines, exits, stopped };
  };
  /** The stop's exit code, or -1 when it has not run to its exit within 3 s: a hang fails its row rather than the suite. */
  const settled = (p: Promise<number>) => Promise.race([p, Bun.sleep(3_000).then(() => -1)]);

  let s = stuck();
  let h = harness({ server: () => s.server, onCut: () => s.calls.push("onCut") });
  const b0 = performance.now();
  h.handlers.get("SIGTERM")!();
  let c = await settled(h.stopped);
  assert(c === 1 && h.exits.join() === "1" && performance.now() - b0 >= 190 && s.calls.join() === "stop(),onCut,stop(true)" && h.lines.some((l) => /1 request still in flight after 0\.\d s, closed unfinished/.test(l)),
    `a request that never finishes is cut off at the drain bound: stop(), the cut told, stop(true) not waited on, exit 1, the line naming it (${s.calls.join()}; ${h.lines.join(" | ")})`);

  s = stuck();
  h = harness({ server: () => s.server, close: () => new Promise<boolean>(() => {}), closeBoundMs: 60_000, closeAfterCutMs: 50 });
  h.handlers.get("SIGTERM")!();
  c = await settled(h.stopped);
  assert(c === 1 && /database pool not closed within 50 ms; exit 1$/.test(h.lines.at(-1) ?? ""),
    `after a cut the pool is given the shorter bound, not the full one (${h.lines.at(-1)})`);

  s = stuck();
  h = harness({ server: () => s.server, drainBoundMs: 60_000 });
  const b1 = performance.now();
  h.handlers.get("SIGTERM")!();
  h.handlers.get("SIGINT")!();
  c = await settled(h.stopped);
  assert(c === 1 && performance.now() - b1 < 1_000 && h.lines.some((l) => l === "SIGINT again: not waiting for the rest") && s.calls.join() === "stop(),stop(true)",
    `a second signal cuts a 60 s wait short (${Math.round(performance.now() - b1)} ms, exit ${c})`);

  h = harness({ server: () => undefined, close: () => new Promise<boolean>(() => {}) });
  h.handlers.get("SIGTERM")!();
  c = await settled(h.stopped);
  assert(c === 0 && h.lines.some((l) => /0 requests in flight/.test(l)) && h.lines.some((l) => /database pool not closed within 100 ms; exit 0/.test(l)),
    `no server yet: nothing to wait on, exit 0; a pool that will not close is left at its bound and said (${h.lines.at(-1)})`);

  h = harness({ server: () => undefined, close: () => Promise.reject(new Error("boom")) });
  h.handlers.get("SIGTERM")!();
  assert(await settled(h.stopped) === 0 && /database pool not closed: boom; exit 0/.test(h.lines.at(-1) ?? ""), "a pool whose close throws is said, and the stop still exits 0");

  h = harness({ server: () => undefined, close: () => new Promise<boolean>(() => {}), closeBoundMs: 60_000 });
  const b2 = performance.now();
  h.handlers.get("SIGTERM")!();
  await Bun.sleep(20);
  h.handlers.get("SIGTERM")!();
  c = await settled(h.stopped);
  assert(c === 0 && performance.now() - b2 < 1_000 && /database pool not closed: a second signal; exit 0/.test(h.lines.at(-1) ?? ""),
    `…and a second signal during the pool's close ends that wait too (${Math.round(performance.now() - b2)} ms: ${h.lines.at(-1)})`);

  h = harness({ server: () => undefined, close: async () => false });
  h.handlers.get("SIGTERM")!();
  assert(await settled(h.stopped) === 0 && /; no database pool was opened; exit 0$/.test(h.lines.at(-1) ?? ""), "no pool opened is said as such, not as a pool closed");

  // The telemetry's flush is said on its own (SMD-1849 PR 2b review passes 1–2): a
  // collector that stalls is the telemetry's, never the pool's; none set, nothing said.
  type Flush = () => Promise<import("./shutdown.ts").FlushResult | undefined>;
  const flushLine = async (flush: Flush, close: () => Promise<boolean> = async () => false) => {
    const fh = harness({ server: () => undefined, close, flush });
    fh.handlers.get("SIGTERM")!();
    return { code: await settled(fh.stopped), line: fh.lines.at(-1) ?? "" };
  };
  const stalled = await flushLine(() => new Promise(() => {}));
  const went = await flushLine(async () => "sent", async () => true);
  const unset = await flushLine(async () => undefined, async () => true);
  const failed = await flushLine(async () => "failed");
  const none = await flushLine(async () => "none");
  const timedOut = await flushLine(async () => "timeout");
  assert(stalled.code === 0 && /; no database pool was opened; telemetry not all sent within 100 ms; exit 0$/.test(stalled.line) && /; database pool closed; telemetry sent; exit 0$/.test(went.line)
    && /; database pool closed; exit 0$/.test(unset.line) && /; telemetry not all sent; exit 0$/.test(failed.line) && /; no telemetry left to send; exit 0$/.test(none.line) && /; telemetry not all sent within 100 ms; exit 0$/.test(timedOut.line),
    `the telemetry's flush is its own clause: sent, not sent, none left, not within its bound — a stalled collector is not the pool's (${[stalled.line, went.line, unset.line, failed.line, none.line, timedOut.line].join(" | ")})`);
  // What the runtime no longer counts but a record holds open ends before the flush, on a drained stop and a cut
  // alike; and a cut that throws (a sink that fell over) leaves the flush and the exit to run (PR 2c review pass 3).
  const drainedOrder: string[] = [];
  const drainedStop = harness({ server: () => ({ pendingRequests: 0, stop: async () => {} }), endOpen: () => drainedOrder.push("endOpen"), flush: async () => { drainedOrder.push("flush"); return "sent" as const; } });
  drainedStop.handlers.get("SIGTERM")!();
  const drainedCode = await settled(drainedStop.stopped);
  const cutStuck = stuck();
  const cutOrder: string[] = [];
  const throwingCut = harness({ server: () => cutStuck.server, onCut: () => { cutOrder.push("onCut"); throw new Error("the sink fell over"); }, endOpen: () => cutOrder.push("endOpen"), flush: async () => { cutOrder.push("flush"); return "sent" as const; } });
  throwingCut.handlers.get("SIGTERM")!();
  const throwingCode = await settled(throwingCut.stopped);
  assert(drainedCode === 0 && drainedOrder.join() === "endOpen,flush" && throwingCode === 1 && cutOrder.join() === "onCut,endOpen,flush" && /; telemetry sent; exit 1$/.test(throwingCut.lines.at(-1) ?? ""),
    `open records ended before the flush on either path; a cut that throws still flushes and exits (${drainedOrder.join()} / ${cutOrder.join()}; ${throwingCut.lines.at(-1)})`);
  // Beside the pool's close, not after it: both stalled take the longer bound, not the two added (SMD-2902: each its
  // own, 300 ms and 400); and a second signal ends the flush's wait as it ends the pool's (review pass 2).
  const both = harness({ server: () => undefined, close: () => new Promise<boolean>(() => {}), closeBoundMs: 300, flushBudgetMs: 400, flush: () => new Promise(() => {}) });
  const b3 = performance.now();
  both.handlers.get("SIGTERM")!();
  await settled(both.stopped);
  const bothMs = performance.now() - b3;
  const twice = harness({ server: () => undefined, close: () => new Promise<boolean>(() => {}), closeBoundMs: 60_000, flush: () => new Promise(() => {}) });
  const b4 = performance.now();
  twice.handlers.get("SIGTERM")!();
  await Bun.sleep(20);
  twice.handlers.get("SIGTERM")!();
  await settled(twice.stopped);
  assert(bothMs >= 390 && bothMs < 650 && /database pool not closed within 300 ms; telemetry not all sent within 400 ms; exit 0$/.test(both.lines.at(-1) ?? "")
    && performance.now() - b4 < 1_000 && /database pool not closed: a second signal; telemetry not all sent: a second signal; exit 0$/.test(twice.lines.at(-1) ?? ""),
    `a stalled pool and a stalled collector take the longer of their bounds, not both (${Math.round(bothMs)} ms of 300 and 400: ${both.lines.at(-1)}), and a second signal ends both waits (${twice.lines.at(-1)})`);

  // SMD-2902: the flush's own bound — its budget, inside what the grace period leaves less a second before the kill,
  // never less than the close's — and, cut short, what each signal still held said (`unsent`) before the stop's line.
  const bounded = async (opts: Partial<Parameters<typeof drainOnSignal>[0]> & { server: () => any }) => {
    const told: string[] = [];
    const bh = harness({ unsent: (kind) => { told.push(kind); bh.lines.push(`unsent: ${kind}`); }, ...opts });
    const t = performance.now();
    bh.handlers.get("SIGTERM")!();
    const code = await settled(bh.stopped);
    return { code, ms: performance.now() - t, told, lines: bh.lines, line: bh.lines.at(-1) ?? "", within: Number(/telemetry not all sent within (\d+) ms/.exec(bh.lines.at(-1) ?? "")?.[1] ?? NaN) };
  };
  const stall = () => new Promise<never>(() => {});
  // A collector slower than the pool's close, inside the flush's budget: sent, not cut at the close's 100 ms.
  const slower = await bounded({ server: () => undefined, flushBudgetMs: 600, flush: () => Bun.sleep(300).then(() => "sent" as const) });
  // The grace period caps the budget: 1.4 s less the margin leaves about 400 ms of a 5 s budget.
  const capped = await bounded({ server: () => undefined, graceMs: 1_400, flushBudgetMs: 5_000, flush: stall });
  // A grace period with nothing left past the margin: the close's bound, as before.
  const floored = await bounded({ server: () => undefined, graceMs: 1_000, flushBudgetMs: 5_000, flush: stall });
  // After a cut at the 200 ms drain bound: what the grace leaves (1.5 s less 1 s less the 0.2 s drained), not the budget.
  const cutStall = stuck();
  const afterCut = await bounded({ server: () => cutStall.server, graceMs: 1_500, flushBudgetMs: 5_000, closeAfterCutMs: 50, flush: stall });
  assert(slower.code === 0 && /; database pool closed; telemetry sent; exit 0$/.test(slower.line) && slower.told.length === 0
    && capped.within >= 370 && capped.within <= 400 && capped.ms < 700 && floored.within === 100 && afterCut.code === 1 && afterCut.within >= 250 && afterCut.within <= 300,
    `the flush's own bound: a 300 ms collector sent under a 600 ms budget (${slower.line}); a 1.4 s grace caps a 5 s budget at ${capped.within} ms; a 1 s grace leaves the close's 100 ms (${floored.within}); after a cut at 200 ms, a 1.5 s grace leaves ${afterCut.within} ms`);
  const cutWord = (r: { told: string[]; lines: string[] }) => r.told.join("|") + " @" + r.lines.findIndex((l) => l.startsWith("unsent: ")) + "/" + (r.lines.length - 1);
  assert(capped.told.length === 1 && capped.told[0] === `on its way or batched when the flush's ${capped.within} ms ran out` && capped.lines.at(-2)?.startsWith("unsent: ")
    && afterCut.told.length === 1 && afterCut.lines.at(-2)?.startsWith("unsent: "),
    `a flush cut at its bound says what was still on its way, once, just before the stop's line (${cutWord(capped)}; ${cutWord(afterCut)})`);
  // A second signal while the flush waits, the pool already closed: the flush ends, and says what it held.
  const told2: string[] = [];
  const again = harness({ server: () => undefined, close: async () => true, flushBudgetMs: 60_000, flush: stall, unsent: (kind) => told2.push(kind) });
  const b5 = performance.now();
  again.handlers.get("SIGTERM")!();
  await Bun.sleep(30);
  again.handlers.get("SIGTERM")!();
  // A third at once: what the batches held is said once — a second cut would count them again (review pass 2).
  again.handlers.get("SIGTERM")!();
  const againCode = await settled(again.stopped);
  // A sink that throws is the telemetry's: the stop still says its line and exits.
  const throwing = await bounded({ server: () => undefined, graceMs: 1_200, flushBudgetMs: 5_000, flush: stall, unsent: () => { throw new Error("the sink fell over"); } });
  assert(againCode === 0 && performance.now() - b5 < 1_000 && /; database pool closed; telemetry not all sent: a second signal; exit 0$/.test(again.lines.at(-1) ?? "") && told2.length === 1 && told2.join() === "on its way or batched at a second signal"
    && throwing.code === 0 && /telemetry not all sent within \d+ ms; exit 0$/.test(throwing.line),
    `a second signal ends the flush's own wait and says what it held (${told2.join()}; ${again.lines.at(-1)}); an unsent sink that throws leaves the line and the exit (${throwing.line})`);
  // A second signal during the drain (review pass 1): the operator waits for none of the rest, so the flush gets the
  // close's after-cut bound, not its budget, and says what it held as the second signal's.
  const drainStuck = stuck();
  const told3: string[] = [];
  const duringDrain = harness({ server: () => drainStuck.server, drainBoundMs: 60_000, closeAfterCutMs: 50, flushBudgetMs: 60_000, graceMs: 120_000, flush: stall, unsent: (kind) => told3.push(kind) });
  const b6 = performance.now();
  duringDrain.handlers.get("SIGTERM")!();
  await Bun.sleep(30);
  duringDrain.handlers.get("SIGTERM")!();
  const duringCode = await settled(duringDrain.stopped);
  const duringMs = performance.now() - b6;
  // A flush that ended before a second signal cuts the close: nothing more is said of it (review pass 1).
  const told4: string[] = [];
  const ended = harness({ server: () => undefined, close: () => new Promise<boolean>(() => {}), closeBoundMs: 60_000, flush: async () => "sent" as const, unsent: (kind) => told4.push(kind) });
  ended.handlers.get("SIGTERM")!();
  await Bun.sleep(30);
  ended.handlers.get("SIGTERM")!();
  const endedCode = await settled(ended.stopped);
  const told5: string[] = [];
  const rejected = harness({ server: () => undefined, close: () => new Promise<boolean>(() => {}), closeBoundMs: 60_000, flush: () => Promise.reject(new Error("the SDK fell over")), unsent: (kind) => told5.push(kind) });
  rejected.handlers.get("SIGTERM")!();
  await Bun.sleep(30);
  rejected.handlers.get("SIGTERM")!();
  const rejectedCode = await settled(rejected.stopped);
  assert(rejectedCode === 0 && told5.length === 0 && /database pool not closed: a second signal; telemetry not all sent; exit 0$/.test(rejected.lines.at(-1) ?? ""),
    `a flush that rejected has ended too: a second signal says nothing more of it (${told5.length}: ${rejected.lines.at(-1)})`);
  assert(duringCode === 1 && duringMs < 400 && /; telemetry not all sent: a second signal; exit 1$/.test(duringDrain.lines.at(-1) ?? "") && told3.join() === "on its way or batched at a second signal"
    && endedCode === 0 && told4.length === 0 && /database pool not closed: a second signal; telemetry sent; exit 0$/.test(ended.lines.at(-1) ?? ""),
    `a second signal during the drain cuts the flush to the close's bound (${Math.round(duringMs)} ms, ${told3.join()}: ${duringDrain.lines.at(-1)}); a flush that had ended says nothing more (${told4.length}: ${ended.lines.at(-1)})`);

  const cut = cutByStopLine("tools/call capture_thought", 8_400);
  assert(cut.startsWith("request cut off by the server's stop after 8.4 s: tools/call capture_thought — still running when the stop closed it") && !/runs to its end/.test(cut) && cut !== abandonedRequestLine("tools/call capture_thought", 8_400),
    "a request the stop cuts off is said to be the stop's, not the client leaving (SMD-1864's line says the call runs to its end, which it will not)");

  const g = (raw: string | undefined) => { const r = drainBoundFrom(raw); return `${r.graceS}/${r.drainBoundMs}/${r.problem ? "said" : "-"}`; };
  const graceCases = [g(undefined), g(""), g("30"), g(" 20 "), g("2"), g("1"), g("3600"), g("0"), g("-5"), g("ten"), g("1.5"), g("30s"), g("1m"), g("3601"), g("1e3")];
  assert(graceCases.join(" ") === "10/8000/- 10/8000/- 30/28000/- 20/18000/- 2/500/- 1/500/- 3600/3598000/- 10/8000/said 10/8000/said 10/8000/said 10/8000/said 10/8000/said 10/8000/said 10/8000/said 10/8000/said",
    `drainBoundFrom: whole seconds from 1 to 3600, less 2 s, at least 0.5 s; unset and "" the default; a fraction, a unit, 0, a negative or past an hour the default, said (${graceCases.join(" ")})`);

  // Compose appends `s` to OB1_STOP_GRACE for every server's stop_grace_period,
  // with its own fallback: held equal to the code's default, since check 14
  // reads environment forwards only (review pass 4 — FORK.md's value defined twice).
  const { DEFAULT_STOP_GRACE_S } = await import("./shutdown.ts");
  const graceFallbacks: string[] = [];
  for (const file of ["compose.yaml", "compose.tiers.yaml"]) {
    const doc = Bun.YAML.parse(await Bun.file(new URL(`../deploy/${file}`, import.meta.url)).text()) as { services: Record<string, { build?: { dockerfile?: string }; image?: string; stop_grace_period?: string }> };
    const builds = (svc: { build?: { dockerfile?: string } }) => svc.build?.dockerfile === "server-portable/Dockerfile";
    // The server's image, built here or (a REST core) run by a building service's name.
    const serverImages = new Set(Object.values(doc.services).filter(builds).map((svc) => svc.image).filter(Boolean));
    for (const [name, svc] of Object.entries(doc.services)) {
      if (!builds(svc) && !serverImages.has(svc.image)) continue;
      graceFallbacks.push(`${file}:${name}=${/^\$\{OB1_STOP_GRACE:-(\d+)\}s$/.exec(svc.stop_grace_period ?? "")?.[1] ?? svc.stop_grace_period}`);
    }
  }
  // Ten: the server, the REST core (SMD-2284), the MCP server (SMD-2287) and
  // the operator GUI (SMD-2280) in compose.yaml, and each tier's server and
  // REST core in compose.tiers.yaml (SMD-2294).
  assert(graceFallbacks.length === 10 && graceFallbacks.every((x) => x.endsWith(`=${DEFAULT_STOP_GRACE_S}`)),
    `every compose server's stop_grace_period is \${OB1_STOP_GRACE:-${DEFAULT_STOP_GRACE_S}}s, the code's default (${graceFallbacks.join(", ")})`);

  // Preflight refuses a value compose would render wrong, and reports one it reads.
  const preflightWith = async (grace: string) => {
    const p = Bun.spawn(["bun", "--no-env-file", "preflight.ts"], { cwd: import.meta.dir, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", OB1_STOP_GRACE: grace }, stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    await p.exited;
    return out;
  };
  const badGrace = await preflightWith("1m");
  const goodGrace = await preflightWith("30");
  assert(/✗\s+stop grace\s+OB1_STOP_GRACE="1m" is not a whole number of seconds/.test(badGrace) && /30, not 30s/.test(badGrace) && /✓\s+stop grace\s+30 s \(OB1_STOP_GRACE\) — a stop drains what is in flight for up to 28 s/.test(goodGrace),
    "preflight fails a stop grace compose would render wrong (1m → a 1 ms kill), with the fix, and reports one it reads");
  // The vector mender's knob (SMD-2889): said when set — its interval, off, or a value the servers read as the default.
  const preflightMend = async (v: string) => {
    const p = Bun.spawn(["bun", "--no-env-file", "preflight.ts"], { cwd: import.meta.dir, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", OB1_VECTOR_MEND_INTERVAL: v }, stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    await p.exited;
    return out;
  };
  const [mendBad, mendOff, mendEvery] = await Promise.all([preflightMend("1d"), preflightMend("off"), preflightMend("120")]);
  assert(/vector mender\s+OB1_VECTOR_MEND_INTERVAL="1d" is not a whole number of seconds from 1 to 86400/.test(mendBad) && /✓\s+vector mender\s+off \(OB1_VECTOR_MEND_INTERVAL\)/.test(mendOff) && /✓\s+vector mender\s+every 120 s/.test(mendEvery),
    `preflight says the mender's knob: a bad value warned, off, an interval (${mendBad.split("\n").find((l) => /vector mender/.test(l))?.trim()})`);

  // A tool call runs on after its client has gone, which Bun's request count
  // does not see (review pass 3: a stop whose only call's client had just left
  // exited under it, and the capture was lost). The count, then the drain
  // waiting on it; the server under test counting a real call past its client
  // is test-server's [13d].
  const count = createCallCount();
  let release: () => void = () => {};
  const held = count.track(() => new Promise<string>((resolve) => { release = () => resolve("done"); }));
  const failing = count.track(async () => { throw new Error("boom"); }).catch((e: Error) => e.message);
  const idleEarly = await Promise.race([count.idle().then(() => "idle"), Bun.sleep(30).then(() => "waiting")]);
  const during = count.running;
  release();
  const results = [await held, await failing];
  const idleAfter = await Promise.race([count.idle().then(() => "idle"), Bun.sleep(30).then(() => "waiting")]);
  assert(during === 1 && idleEarly === "waiting" && idleAfter === "idle" && count.running === 0 && results.join() === "done,boom",
    `the call count: a running call holds idle(), a failed one is still let go, each result passed through (${during} running, ${idleEarly} → ${idleAfter})`);

  let callsLeft = 1;
  let callsIdle: () => void = () => {};
  const bc = performance.now();
  h = harness({ server: () => ({ pendingRequests: 0, stop: () => Promise.resolve() }), calls: { get running() { return callsLeft; }, idle: () => new Promise<void>((resolve) => { callsIdle = resolve; }) }, drainBoundMs: 5_000 });
  h.handlers.get("SIGTERM")!();
  setTimeout(() => { callsLeft = 0; callsIdle(); }, 150);
  c = await settled(h.stopped);
  assert(c === 0 && performance.now() - bc >= 140 && h.lines[0].includes("0 requests in flight, 1 tool call running"),
    `the drain waits for a tool call its request no longer counts, and says so (${Math.round(performance.now() - bc)} ms: ${h.lines[0].slice(0, 70)})`);

  h = harness({ server: () => ({ pendingRequests: 0, stop: () => new Promise<void>(() => {}) }), calls: { running: 0, idle: () => Promise.resolve() } });
  h.handlers.get("SIGTERM")!();
  c = await settled(h.stopped);
  assert(c === 0 && !h.lines.some((l) => /closed unfinished/.test(l)),
    `a bound that finds nothing left in flight is a drain, not "0 still in flight, closed unfinished" and exit 1 (${h.lines.at(-1)})`);

  h = harness({ server: () => ({ pendingRequests: 1, stop: () => Bun.sleep(170) }), close: () => new Promise<boolean>(() => {}), closeBoundMs: 60_000, closeAfterCutMs: 30 });
  h.handlers.get("SIGTERM")!();
  c = await settled(h.stopped);
  const lateClose = Number(/database pool not closed within (\d+) ms; exit 0$/.exec(h.lines.at(-1) ?? "")?.[1] ?? NaN);
  assert(c === 0 && lateClose >= 30 && lateClose <= 70,
    `a drain that ends late gives the close what is left of the bound, not its full second (${lateClose} ms of a 200 ms bound ended at about 170)`);
  assert(isStoppable({ stop: () => Promise.resolve(), pendingRequests: 0 }) && !isStoppable({ OB1_STORE: "sql" }) && !isStoppable(undefined) && !isStoppable(null),
    "isStoppable: Bun's server shape, not an env record, not nothing");
}

report();
