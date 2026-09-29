#!/usr/bin/env bun
/**
 * eval-reference-windows.ts (SMD-2269) — why qwen2.5:7b cannot answer a
 * reference-list window in JSON, and what (if anything) recovers it.
 *
 * SMD-2260 (PR #213) keeps a windowed thought's parsed windows when others are
 * malformed; on the stable brain the windows left out are almost all the
 * bibliography windows of three research papers, whose entities never reach the
 * graph. SMD-2260's Work item 3 asked for a MEASUREMENT, not an assumption, of
 * three candidate answers:
 *   1. a larger answer budget for the dense-name window;
 *   2. detect a bibliography window and skip it (as left-out-on-purpose, DISTINCT
 *      from malformed, so a real defect is never hidden — SMD-2266's alarm);
 *   3. neither — if the typed-decision path (SMD-2017/2252/2321) makes it moot.
 *
 * This script measures, it does not ship a fix. It runs read-only against the
 * dogfood stable brain (the papers and the SMD-1961 long-doc gold live there)
 * and calls the entity extractor at the host Ollama, using two INERT hooks on
 * ExtractWindowing (never set by windowingFor, so the worker is unchanged):
 *   - `observe`   — per-window finish_reason + a raw-answer sample, so a
 *                   malformed window is classed cut-at-budget / wrong-shape-JSON
 *                   / prose / aborted-loop, which the merged Extraction cannot say;
 *   - `budgetTimes` — a max_tokens multiplier, to measure candidate 1 faithfully.
 *
 * Sections (all run by default; --papers skips the long-doc pass):
 *   A. DIAGNOSE the three papers — the failure shape per malformed window
 *      (Work item 1), and the bibliography classifier's agreement with it.
 *   B. BUDGET arms — re-answer each malformed window at ×1/×2/×3 the budget; does
 *      a larger budget recover it, and at what time cost (Work item 2, candidate 1)?
 *   C. BIBLIOGRAPHY skip — the classifier's recall cost over the long-doc corpus
 *      (gold-valid entities that live ONLY in a flagged window) and its
 *      false-positive rate on content windows + a prose control (candidate 2,
 *      Work item 2/3).
 *
 * Run (read-only) from a one-off container on the brain's network:
 *   podman run --rm --network open-brain_default --env-file deploy/.env \
 *     -e OB1_LLM_LOCAL=1 -e OB1_LLM_BASE_URL=http://host.containers.internal:11434/v1 \
 *     -e OB1_METADATA_MODEL=qwen2.5:7b -e OB1_EMBEDDING_MODEL=qwen3-embedding:4b \
 *     -v <worktree>:/repo -w /repo oven/bun:1.4.0-alpine \
 *     sh -c 'export DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/openbrain"; bun evals/eval-reference-windows.ts'
 */
import { SQL } from "bun";
import { resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { extractEntities, windowingFor, boundedWindows, type ExtractWindowObservation } from "../server-portable/entities.ts";
import { chunkContent, type Chunk } from "../server-portable/chunk.ts";
import { normalizeEntityName } from "../server-portable/entity-gate.ts";
import { readFileSync } from "node:fs";

const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.error("DATABASE_URL required (built inside the container from $POSTGRES_PASSWORD)."); process.exit(2); }
const args = process.argv.slice(2);
const has = (n: string) => args.includes(`--${n}`);
const PAPERS_ONLY = has("papers");
const TIMEOUT_MS = 300_000;

const cfg = resolveEmbedConfig(process.env as EmbedEnv);
const W = windowingFor(cfg);
const sql = new SQL({ url: URL_, max: 2 });

// The three residual research papers whose reference lists SMD-2260 left out.
const PAPERS = [
  "0c959c19-0000-4000-8000-ff9c197dbe16",
  "400669a3-0000-4000-8000-d9484ec67d9b",
  "cb6b844e-0000-4000-8000-516d10684a23",
];

// ── The bibliography classifier (candidate 2) ─────────────────────────────────
// Deterministic, no model, no egress. Lives here, not in the worker: shipping it
// is the deferred follow-up. A window is a reference list when it is dense in
// "Lastname, F." author initials AND in years — the shape of a citation run —
// or opens under a References/Bibliography heading with several such authors.

const AUTHOR_INITIALS = /\b[A-Z][a-zA-Z'’-]+,\s+[A-Z]\.(?:\s*[A-Z]\.)*/g;
const YEARS = /\b(?:19|20)\d{2}[a-z]?\b/g;
const HEADING = /(?:^|\n)\s*(?:references|bibliography|works cited)\s*(?:\n|$)/i;
const CITE_CUES = /\b(?:et al\.?|arXiv|doi:|preprint|In Proceedings|Proceedings of|Advances in Neural|Transactions on|Association for Comput)/gi;

/** Author-initial and year counts per 1,000 characters, so a threshold does not depend on window size. */
function bibliographySignal(text: string): { authors: number; years: number; cites: number; heading: boolean; per1k: { authors: number; years: number } } {
  const authors = (text.match(AUTHOR_INITIALS) ?? []).length;
  const years = (text.match(YEARS) ?? []).length;
  const cites = (text.match(CITE_CUES) ?? []).length;
  const k = Math.max(1, text.length / 1000);
  return { authors, years, cites, heading: HEADING.test(text), per1k: { authors: authors / k, years: years / k } };
}

/** A window is a reference list: a dense author-and-year run, or a References heading with a few authors. */
function looksLikeBibliography(text: string): boolean {
  const s = bibliographySignal(text);
  const dense = s.per1k.authors >= 4 && s.per1k.years >= 4 && s.authors >= 5;
  const headed = s.heading && s.authors >= 3;
  return dense || headed;
}

// ── Section A: diagnose the failure shape ─────────────────────────────────────

type WinClass = "ok" | "aborted-loop" | "cut-at-budget" | "wrong-shape-json" | "prose" | "empty";
function classify(o: ExtractWindowObservation): WinClass {
  if (o.aborted) return "aborted-loop";
  if (!o.malformed) return "ok";
  if (o.finishReason === "length") return "cut-at-budget";
  const s = (o.answerSample ?? "").trimStart();
  if (s === "") return "empty";
  return s.startsWith("{") || s.startsWith("[") ? "wrong-shape-json" : "prose";
}

async function contentOf(ids: string[]): Promise<Map<string, string>> {
  const rows = (await sql`SELECT id::text AS id, content FROM thoughts WHERE id IN ${sql(ids)}`) as { id: string; content: string }[];
  return new Map(rows.map((r) => [r.id, r.content]));
}

/** The windows extractEntities actually sends for a thought — chunked then bounded/cut to maxWindows, keyed by their sent index (SMD-2269 review: the sent text, not the raw chunk). */
function sentWindows(text: string): Map<number, string> {
  const chunks: Chunk[] = chunkContent(text, { maxTokens: W.windowTokens, overlapTokens: W.overlapTokens });
  return new Map(boundedWindows(text, chunks, W).windows.map((w) => [w.index, w.content]));
}

type Paper = { id: string; obs: ExtractWindowObservation[]; classes: WinClass[]; winText: Map<number, string>; leftOut: number[] };

async function diagnose(): Promise<Paper[]> {
  const content = await contentOf(PAPERS);
  const out: Paper[] = [];
  console.log(`\n══ A. Failure shape — three stable papers, ${cfg.metadataModel}, shipped windowing (${W.windowTokens}-token windows, retry ${W.retryRunaway}, streamAbort ${W.streamAbort}) ══\n`);
  for (const id of PAPERS) {
    const text = content.get(id);
    if (!text) { console.log(`  ${id.slice(0, 8)}: MISSING on this brain`); continue; }
    const winText = sentWindows(text);
    const obs: ExtractWindowObservation[] = [];
    let leftOut: number[] = [];
    // Shipped windowing (aborts a loop fast, retries a runaway read-whole) plus
    // observe. observe fires on the FIRST attempt of each window (the retry omits
    // it), so `obs` is the first-attempt failure shape; `coverage.malformed` on the
    // returned Extraction is the windows STILL left out AFTER the retry — the
    // population the graph actually loses, and what SMD-2260/2269 is about. A
    // window that times out throws the doc; the observations already stand.
    try {
      const ex = await extractEntities(text, cfg, TIMEOUT_MS, { kind: "extraction" }, { ...W, observe: (r) => { obs.push(r); process.stderr.write(`    … ${id.slice(0, 8)} window ${r.index + 1}/${r.of} ${classify(r)}\n`); } });
      leftOut = ex.coverage?.malformed ?? [];
    } catch (e) {
      console.log(`  ${id.slice(0, 8)}: extraction threw after ${obs.length} window(s) — ${(e as Error).message.slice(0, 80)}`);
    }
    const classes = obs.map(classify);
    out.push({ id, obs, classes, winText, leftOut });
    const firstBad = classes.filter((c) => c !== "ok").length;
    console.log(`\n  ${id.slice(0, 8)} — ${obs.length} windows sent; first attempt ${firstBad} malformed; left out after the shipped retry: ${leftOut.length} (${leftOut.length ? leftOut.map((i) => i + 1).join(", ") : "none"})`);
    console.log("    win  tokens   budget  finish   first-attempt      leftOut?  bib?  sample");
    console.log("    " + "─".repeat(104));
    for (const o of obs) {
      const c = classify(o);
      if (c === "ok") continue; // a left-out window always failed its first attempt too, so this shows every left-out one
      const bib = looksLikeBibliography(winText.get(o.index) ?? "") ? "yes" : "no";
      const lo = leftOut.includes(o.index) ? "LEFT-OUT" : "recovered";
      console.log(`    ${String(o.index + 1).padStart(3)}  ${String(o.tokens).padStart(6)}  ${String(o.budget ?? "-").padStart(7)}  ${(o.finishReason ?? "-").padEnd(7)}  ${c.padEnd(17)}  ${lo.padEnd(8)}  ${bib.padEnd(4)}  ${JSON.stringify((o.answerSample ?? "").slice(0, 40))}`);
    }
  }
  // Cross-paper summary — first-attempt shape AND the post-retry left-out population.
  const firstAll = out.flatMap((p) => p.classes);
  const firstBad = firstAll.filter((c) => c !== "ok");
  const tally = (cls: WinClass) => firstBad.filter((c) => c === cls).length;
  const leftOutAll = out.flatMap((p) => p.leftOut.map((i) => ({ paper: p.id, index: i })));
  const bibOfLeftOut = leftOutAll.filter((l) => looksLikeBibliography(out.find((p) => p.id === l.paper)!.winText.get(l.index) ?? "")).length;
  console.log(`\n  Across the three papers: ${firstAll.length} windows.`);
  console.log(`    First attempt: ${firstBad.length} malformed — aborted-loop ${tally("aborted-loop")} · cut-at-budget ${tally("cut-at-budget")} · wrong-shape-json ${tally("wrong-shape-json")} · prose ${tally("prose")} · empty ${tally("empty")}.`);
  console.log(`    After the shipped read-whole retry: ${leftOutAll.length} windows left out of the graph — the read-whole retry rescues the false stream-aborts, the answer budget still cuts the rest.`);
  console.log(`    The bibliography classifier flags ${bibOfLeftOut}/${leftOutAll.length} of the left-out windows.`);
  return out;
}

// ── Section B: does a larger budget recover the malformed windows? ─────────────

async function budgetArms(diag: Paper[]) {
  console.log(`\n══ B. Larger answer budget — re-answering each LEFT-OUT window at ×1/×2/×3 (candidate 1) ══\n`);
  // The population the ticket is about: windows still left out AFTER the shipped
  // read-whole retry, not first-attempt failures the retry already rescues.
  const targets: { paper: string; index: number; text: string }[] = [];
  for (const p of diag) for (const idx of p.leftOut) targets.push({ paper: p.id, index: idx, text: p.winText.get(idx) ?? "" });
  if (!targets.length) { console.log("  no windows left out after the shipped retry — nothing to recover."); return; }
  console.log(`  ${targets.length} left-out windows; each re-answered on its own, read whole, no penalty (so ×1→×2 isolates the budget). "Recovered" = the answer parses to entities of the expected shape.\n`);
  console.log("  mult  recovered  entities  median s");
  console.log("  " + "─".repeat(40));
  for (const mult of [1, 2, 3]) {
    let recovered = 0, entities = 0;
    const secs: number[] = [];
    for (const t of targets) {
      if (!t.text.trim()) continue;
      const t0 = Date.now();
      let ok = false, ents = 0;
      // One window, read whole, one call at the scaled budget (no stream-abort, no
      // retry): whether it parses at this budget is ex.malformed.
      try {
        const ex = await extractEntities(t.text, cfg, TIMEOUT_MS, { kind: "extraction" }, { ...W, streamAbort: false, retryRunaway: false, budgetTimes: mult });
        ok = !ex.malformed; ents = ex.entities.length;
      } catch { ok = false; }
      secs.push((Date.now() - t0) / 1000);
      if (ok) { recovered++; entities += ents; }
      process.stderr.write(`    … ×${mult} ${t.paper.slice(0, 8)} w${t.index + 1} ${ok ? `ok (${ents})` : "still malformed"}\n`);
    }
    const median = secs.sort((a, b) => a - b)[Math.floor(secs.length / 2)] ?? 0;
    console.log(`  ×${mult}  ${String(recovered).padStart(9)}  ${String(entities).padStart(8)}  ${median.toFixed(1).padStart(8)}`);
  }
}

// ── Section C: the bibliography-skip candidate on the long-doc corpus ──────────

async function bibliographyOnCorpus() {
  console.log(`\n══ C. Bibliography skip over the SMD-1961 long-doc corpus (candidate 2, no model) ══\n`);
  const gold = JSON.parse(readFileSync(new URL("./fixtures/longdoc-grades.json", import.meta.url), "utf8")) as
    { mentions: { thought: string; entity: string; valid: 0 | 1; type: number }[] };
  const thoughtIds = [...new Set(gold.mentions.map((m) => m.thought))];
  const entityIds = [...new Set(gold.mentions.map((m) => m.entity))];
  const contents = await contentOf(thoughtIds);
  const names = new Map<string, string>(((await sql`SELECT id::text AS id, name FROM ob1_entities WHERE id IN ${sql(entityIds)}`) as { id: string; name: string }[]).map((r) => [r.id, r.name]));

  // gold-valid entity names per thought
  const goldByThought = new Map<string, Set<string>>();
  for (const m of gold.mentions) {
    if (m.valid !== 1) continue;
    const nm = names.get(m.entity); if (!nm) continue;
    const k = normalizeEntityName(nm); if (!k) continue;
    (goldByThought.get(m.thought) ?? goldByThought.set(m.thought, new Set()).get(m.thought)!).add(k);
  }

  let docs = 0, totalWindows = 0, flaggedWindows = 0;
  let goldScored = 0, goldUnmatched = 0, goldOnlyInFlagged = 0; // recall cost over names locatable in the text
  let contentWindowsFlagged = 0; // false positive: a flagged window that HOLDS a gold-valid name (not a pure reference list)
  const norm = (s: string) => " " + (normalizeEntityName(s) ?? "").toLowerCase() + " ";
  for (const tid of thoughtIds) {
    const content = contents.get(tid); const wantSet = goldByThought.get(tid);
    if (!content || !wantSet || wantSet.size === 0) continue;
    docs++;
    const windows = [...sentWindows(content).entries()].map(([index, c]) => ({ index, content: c }));
    totalWindows += windows.length;
    const flags = windows.map((w) => looksLikeBibliography(w.content));
    flaggedWindows += flags.filter(Boolean).length;
    const normed = windows.map((w) => norm(w.content));
    // Where does each gold name occur? (normalised space-delimited containment.)
    for (const name of wantSet) {
      const needle = " " + name.toLowerCase() + " ";
      const inWindows = normed.map((h) => h.includes(needle));
      if (!inWindows.some(Boolean)) { goldUnmatched++; continue; } // not locatable (punctuation-adjacent or resolution artefact) — not scored either way
      goldScored++;
      const survives = windows.some((w, i) => inWindows[i] && !flags[i]);
      if (!survives) goldOnlyInFlagged++;
    }
    // A flagged window that contains a gold-valid name is not a pure reference list.
    for (let i = 0; i < windows.length; i++) {
      if (!flags[i]) continue;
      if ([...wantSet].some((n) => normed[i].includes(" " + n.toLowerCase() + " "))) contentWindowsFlagged++;
    }
  }
  console.log(`  ${docs} graded docs, ${totalWindows} windows; the classifier flags ${flaggedWindows} (${(100 * flaggedWindows / Math.max(1, totalWindows)).toFixed(1)}%).`);
  console.log(`  recall cost: ${goldOnlyInFlagged}/${goldScored} locatable gold-valid names would be LOST (their only window is flagged) — ${(100 * goldOnlyInFlagged / Math.max(1, goldScored)).toFixed(2)}% (${goldUnmatched} names not locatable as a space-delimited token, not scored).`);
  console.log(`  false positives: ${contentWindowsFlagged} flagged windows still hold a gold-valid name (a content window wrongly skipped).`);

  // Prose control: meeting-note prose must never be flagged.
  const prose = "The morning session went over the remaining open questions from last week. "
    + "Most of the discussion concerned how the rollout should be sequenced. "
    + "Priya approved the rollout for the observability team in 2024 and Dev will pair on it. "
    + "Several people asked for the timeline to be written down, and it was.";
  console.log(`  prose control flagged: ${looksLikeBibliography(prose)} (must be false); signal ${JSON.stringify(bibliographySignal(prose).per1k)}`);
}

// ── Run ───────────────────────────────────────────────────────────────────────

console.log(`  model ${cfg.metadataModel} via ${cfg.chat.base}; windows ${W.windowTokens} tok, budget on=${W.outputBudget}, retry=${W.retryRunaway}, streamAbort=${W.streamAbort}`);
const diag = await diagnose();
await budgetArms(diag);
if (!PAPERS_ONLY) await bibliographyOnCorpus();
await sql.close();
