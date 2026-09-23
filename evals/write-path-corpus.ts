/**
 * write-path-corpus.ts — the frozen corpus the write-path eval runs
 * (eval-write-path.ts; Linear SMD-1713).
 *
 * Twenty fictional working sessions over twelve fictional subjects, each
 * session a few captures by one of two keys: `op` (the operator, classified
 * `operator` in 046's registry) and `bot` (an agent, classified `agent`).
 * Planted among the captures are the SALIENT facts a later deliverable must
 * carry and the ERRORS it must not — a decision the next session reversed, a
 * number the operator later mistyped, an agent's inference that contradicts
 * what the operator said — and, deliberately, the cases where a mechanism
 * should HURT: an agent's true fact on a subject the operator also spoke on,
 * and two true facts of one subject that carry different numbers.
 *
 * Why this is a TypeScript module and not a fixture under `fixtures/`
 *   check-fork-consistency check 9 (SMD-1295) reads every committed fixture as
 *   an allowlist: a string is a uuid or free text under one of four keys, and
 *   anything else is thought content that must not be committed. Its own
 *   probes pin "a leaked thought body" whatever the file claims about itself.
 *   The rule is worth more whole than with a counted exception that would
 *   have to tell fiction from an export by file name, so the corpus is
 *   source: typed, typechecked with the evals (`tsconfig.json` includes every
 *   top-level `*.ts`), read by nothing but the eval. Nothing here is a real
 *   person, product or number.
 *
 * Every text names exactly one subject by its phrase, so the scripted
 * provider (eval-write-path.ts) embeds it on that subject's axis and the
 * entity stub names that subject; a deliverable names several. The digits in
 * a text are the stub judge's only signal: two texts under one subject whose
 * numbers differ read as a conflict. Decisions carry no digits, so the
 * supersedes arm and the judge arm catch different plants.
 */

export const SUBJECTS = {
  marzipan: "Project Marzipan",
  quicksilver: "the Quicksilver cache",
  harpsichord: "the Harpsichord release",
  gramophone: "the Gramophone ingest",
  zeppelin: "the Zeppelin budget",
  tamarind: "the Tamarind rota",
  periwinkle: "the Periwinkle API",
  obsidian: "the Obsidian backup",
  saffron: "Saffron onboarding",
  lantern: "the Lantern dashboard",
  cobalt: "the Cobalt migration",
  meridian: "the Meridian vendor",
} as const;

export type SubjectKey = keyof typeof SUBJECTS;
export type Writer = "op" | "bot";

/**
 * What an item is to the scorer. `salient` must reach the deliverable as a
 * plain line. The three error kinds must not: `stale` is the older of two
 * decisions (`replacedBy` names the newer item, which carries `supersedes`
 * when that arm is on); `wrong_number` is the operator's later slip against
 * the item `correct`; `inference` is an agent's unsourced claim against the
 * operator's item `against`.
 */
export type Planted =
  | { kind: "salient" }
  | { kind: "stale"; replacedBy: string }
  | { kind: "wrong_number"; correct: string }
  | { kind: "inference"; against: string };

export type Item = {
  /** Short, unique; the runner maps it to the thought id the server returned. */
  id: string;
  subject: SubjectKey;
  writer: Writer;
  text: string;
  planted: Planted;
  /** The item this capture replaces — written as `supersedes` when the arm is on, never otherwise. */
  supersedes?: string;
};

export type Session = { title: string; items: Item[] };

/** A deliverable's spec: the subjects it must report on, in this order. */
export type DeliverableSpec = { title: string; subjects: SubjectKey[] };

const op = (id: string, subject: SubjectKey, text: string, planted: Planted = { kind: "salient" }, supersedes?: string): Item =>
  ({ id, subject, writer: "op", text, planted, ...(supersedes ? { supersedes } : {}) });
const bot = (id: string, subject: SubjectKey, text: string, planted: Planted = { kind: "salient" }): Item =>
  ({ id, subject, writer: "bot", text, planted });

export const SESSIONS: Session[] = [
  { title: "Kick-off", items: [
    op("mz1", "marzipan", "Project Marzipan replaces the nightly export with a streamed feed."),
    op("qs1", "quicksilver", "The Quicksilver cache holds 4096 entries before it evicts."),
  ] },
  { title: "Release planning", items: [
    op("hs1", "harpsichord", "We decided the Harpsichord release ships as one bundle.", { kind: "stale", replacedBy: "hs2" }),
    op("mz2", "marzipan", "Project Marzipan keeps the old export readable for a month after the switch."),
  ] },
  { title: "Ingest review", items: [
    op("gr1", "gramophone", "The Gramophone ingest reads one file per run and stops."),
    op("zp1", "zeppelin", "The Zeppelin budget is 40 thousand for the quarter."),
  ] },
  { title: "Rota", items: [
    op("tm1", "tamarind", "We decided the Tamarind rota rotates weekly.", { kind: "stale", replacedBy: "tm2" }),
    op("mz3", "marzipan", "Project Marzipan is owned by the platform group."),
  ] },
  { title: "API limits", items: [
    op("pw1", "periwinkle", "The Periwinkle API allows 100 requests a minute per key."),
    bot("ob1", "obsidian", "The Obsidian backup runs nightly to the cold store."),
  ] },
  { title: "Onboarding", items: [
    op("sf1", "saffron", "Saffron onboarding takes 5 sessions from first login."),
    op("mz4", "marzipan", "Project Marzipan has no user-facing change in its first phase."),
  ] },
  { title: "Dashboard", items: [
    op("ln1", "lantern", "The Lantern dashboard refreshes from the read replica, not the primary."),
    op("ln2", "lantern", "We decided the Lantern dashboard shows every team on one page.", { kind: "stale", replacedBy: "ln3" }),
  ] },
  { title: "Agent's notes after the ingest review", items: [
    bot("gr2", "gramophone", "The Gramophone ingest reads every file in the folder, I infer from the logs.", { kind: "inference", against: "gr1" }),
    bot("ob2", "obsidian", "The Obsidian backup keeps thirty days of restore points."),
  ] },
  { title: "Migration plan", items: [
    op("cb1", "cobalt", "The Cobalt migration moves the ledger table first."),
    op("cb2", "cobalt", "The Cobalt migration keeps the old table for a fortnight after the cut."),
  ] },
  { title: "Vendor", items: [
    op("md1", "meridian", "The Meridian vendor invoices 30 days after delivery."),
    op("mz5", "marzipan", "Project Marzipan reports its lag on the shared status board."),
  ] },
  { title: "Release plan, revisited", items: [
    op("hs2", "harpsichord", "Decision revisited: the Harpsichord release ships as two bundles, core first.", { kind: "salient" }, "hs1"),
    op("zp2", "zeppelin", "The Zeppelin budget has 3 approvers on the sign-off."),
  ] },
  { title: "Rota, revisited", items: [
    op("tm2", "tamarind", "Decision revisited: the Tamarind rota rotates fortnightly.", { kind: "salient" }, "tm1"),
    op("mz6", "marzipan", "Project Marzipan pauses the feed during the quarterly close."),
  ] },
  { title: "Cache notes, second look", items: [
    op("qs2", "quicksilver", "The Quicksilver cache holds 2048 entries before it evicts.", { kind: "wrong_number", correct: "qs1" }),
    op("qs3", "quicksilver", "The Quicksilver cache is warmed from the previous day's keys."),
  ] },
  { title: "Agent's notes on the API", items: [
    bot("pw2", "periwinkle", "The Periwinkle API allows 500 requests a minute per key, judging by the traffic.", { kind: "inference", against: "pw1" }),
    bot("hs3", "harpsichord", "The Harpsichord release notes are drafted in the shared folder."),
  ] },
  { title: "Onboarding, second look", items: [
    op("sf2", "saffron", "Saffron onboarding takes 7 sessions from first login.", { kind: "wrong_number", correct: "sf1" }),
    op("mz7", "marzipan", "Project Marzipan's feed is checked against the export once a week."),
  ] },
  { title: "Dashboard, revisited", items: [
    op("ln3", "lantern", "Decision revisited: the Lantern dashboard shows one team per page.", { kind: "salient" }, "ln2"),
    op("gr3", "gramophone", "The Gramophone ingest writes a marker file when a run finishes."),
  ] },
  { title: "Agent's notes on the dashboard", items: [
    bot("ln4", "lantern", "The Lantern dashboard reads the primary directly, going by the connection names.", { kind: "inference", against: "ln1" }),
  ] },
  { title: "Vendor, second look", items: [
    op("md2", "meridian", "The Meridian vendor invoices 60 days after delivery.", { kind: "wrong_number", correct: "md1" }),
  ] },
  { title: "Agent's notes on the vendor", items: [
    bot("md3", "meridian", "The Meridian vendor's contact moved to the account desk."),
  ] },
  { title: "Loose ends", items: [
    op("cb3", "cobalt", "The Cobalt migration runs in the maintenance window."),
  ] },
];

/** The four deliverables written after every session, three subjects each. */
export const DELIVERABLES: DeliverableSpec[] = [
  { title: "Platform status", subjects: ["marzipan", "quicksilver", "cobalt"] },
  { title: "Release and rota", subjects: ["harpsichord", "tamarind", "lantern"] },
  { title: "Ingest and backup", subjects: ["gramophone", "obsidian", "periwinkle"] },
  { title: "Money and people", subjects: ["zeppelin", "saffron", "meridian"] },
];

/** Every item, in capture order. */
export const ITEMS: Item[] = SESSIONS.flatMap((s) => s.items);

/** How many hits the reader asks for per subject; Project Marzipan has seven items so the cut is real. */
export const READER_K = 5;
