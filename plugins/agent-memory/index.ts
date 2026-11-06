// Agent memory (SMD-2690): an agent runtime's governed recall and write-back,
// ported from integrations/agent-memory-api's standalone server and
// schemas/agent-memory's public tables. A write-back captures each memory's
// text as a thought through the core (capture_thought, the caller's key on its
// audit row) and keeps what the runtime said beside it (provenance, scope,
// review, use policy) in the plugin's own tables. A recall searches the brain
// by meaning (search_thoughts, the core's embedding provider), keeps the hits
// that are this workspace's memories, and ranks them by provenance and review
// as the old server did. A review's edit captures the new text as a thought
// of its own and points the memory at it: a thought may hold another memory's
// text too (the core keeps one thought per text), so it is never rewritten.
// Under a write key a recall is traced, so the runtime can say which memories
// it used.

import { definePlugin, ok, operation, refuse, z, type PluginOutcome, type PluginSql } from "../../server-portable/plugin-sdk.ts";

/**
 * A text the tables can store: no NUL (Postgres text refuses it) and no lone
 * surrogate, half of a character such as an emoji (a jsonb cast refuses one;
 * elsewhere it would be stored as U+FFFD). encodeURIComponent throws on a lone one.
 */
const stored = (s: string) => {
  if (s.includes("\u0000")) return false;
  try {
    encodeURIComponent(s);
    return true;
  } catch {
    return false;
  }
};
/** At most `max` UTF-16 units, at least `min`, and storable. */
const text = (max: number, min = 0) => z.string().min(min).max(max).refine(stored, "a NUL or a lone surrogate");

/** Each field's bound: an id or a label, a query, one memory's text, a uri, and how many of a list. A memory over 15,000 characters is refused as transcript-like anyway (unsafeReasons). */
export const LIMITS = { id: 200, query: 4_000, memory: 16_384, uri: 4_096, items: 50 } as const;
const Id = text(LIMITS.id);
const Texts = z.array(text(LIMITS.memory, 1)).max(LIMITS.items).default([]);

const VISIBILITIES = ["personal", "channel", "project", "workspace", "organization"] as const;
const MEMORY_TYPES = ["decision", "output", "lesson", "constraint", "open_question", "failure", "artifact_reference", "work_log"] as const;
const LIFECYCLE = ["active", "stale", "superseded", "disputed", "rejected"] as const;
const REVIEW = ["pending", "confirmed", "evidence_only", "restricted", "rejected", "stale", "merged"] as const;
const ACTIONS = ["confirm", "edit", "evidence_only", "restrict_scope", "mark_stale", "merge", "reject", "dispute", "supersede"] as const;

/** The request versions the old server took, and the answer each names: the agent-memory runtimes' and OpenClaw's. */
const RECALL_VERSIONS = ["openbrain.agent_memory.recall.v1", "openbrain.openclaw.recall.v1"] as const;
const WRITEBACK_VERSIONS = ["openbrain.agent_memory.writeback.v1", "openbrain.openclaw.writeback.v1"] as const;
const recallAnswerVersion = (v: string) => (v === "openbrain.openclaw.recall.v1" ? "openbrain.openclaw.recall_response.v1" : "openbrain.agent_memory.recall_response.v1");
const writebackAnswerVersion = (v: string) => (v === "openbrain.openclaw.writeback.v1" ? "openbrain.openclaw.writeback_response.v1" : "openbrain.agent_memory.writeback_response.v1");

const Channel = z.object({ kind: Id.nullish(), id: Id.nullish(), thread_id: Id.nullish() }).default({});
const Runtime = z.object({ name: Id.default("unknown"), version: Id.nullish() }).default({ name: "unknown" });

/** A memory as every operation answers it: the old server's shape, with its type, its review and its thought. */
const Artifact = z.object({ kind: z.string(), uri: z.string(), description: z.string().nullable() });
const Memory = z.object({
  memory_id: z.string(),
  /** The thought holding its text; null for one migrated whose thought was deleted. */
  thought_id: z.string().nullable(),
  memory_type: z.enum(MEMORY_TYPES),
  summary: z.string(),
  content: z.string(),
  source: z.object({ kind: z.literal("agent_memory"), uri: z.null(), title: z.string(), timestamp: z.string() }),
  provenance: z.object({ status: z.string(), confidence: z.number(), created_by: z.string(), model: z.string().nullable(), runtime: z.string().nullable() }),
  scope: z.object({ workspace_id: z.string(), project_id: z.string().nullable(), channel_id: z.string().nullable(), visibility: z.enum(VISIBILITIES) }),
  use_policy: z.object({ can_use_as_instruction: z.boolean(), can_use_as_evidence: z.boolean(), requires_user_confirmation: z.boolean() }),
  freshness: z.object({ created_at: z.string(), last_confirmed_at: z.string().nullable(), stale_after: z.string().nullable() }),
  review_status: z.enum(REVIEW),
  lifecycle_status: z.enum(LIFECYCLE),
  related_artifacts: z.array(Artifact),
});
type Memory = z.output<typeof Memory>;

/** A memory as memoriesOf reads it. */
type Row = {
  id: string; thought_id: string | null; workspace_id: string; project_id: string | null; channel_id: string | null;
  visibility: (typeof VISIBILITIES)[number]; memory_type: (typeof MEMORY_TYPES)[number]; summary: string; content: string;
  lifecycle_status: (typeof LIFECYCLE)[number]; provenance_status: string; confidence: number; created_by: string;
  runtime_name: string | null; model: string | null; can_use_as_instruction: boolean; can_use_as_evidence: boolean;
  requires_user_confirmation: boolean; review_status: (typeof REVIEW)[number]; last_confirmed_at: Date | null; stale_after: Date | null;
  created_at: Date; content_hash: string | null; metadata: Record<string, unknown>;
};
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
/** A JSON list as a bound parameter: Postgres reads it back as a set of rows. */
const json = (v: unknown) => JSON.stringify(v);

/** The artifacts of these memories, by memory. */
async function artifactsOf(sql: PluginSql, ids: string[]): Promise<Map<string, z.output<typeof Artifact>[]>> {
  const by = new Map<string, z.output<typeof Artifact>[]>();
  if (ids.length === 0) return by;
  const rows = await sql<{ memory_id: string; kind: string; uri: string; description: string | null }>`
    SELECT memory_id::text AS memory_id, artifact_kind AS kind, uri, description FROM artifacts
     WHERE memory_id IN (SELECT jsonb_array_elements_text((${json(ids)}::text)::jsonb)::uuid)
     ORDER BY created_at, id`;
  for (const r of rows) by.set(r.memory_id, [...(by.get(r.memory_id) ?? []), { kind: r.kind, uri: r.uri, description: r.description }]);
  return by;
}

function asMemory(m: Row, artifacts: Map<string, z.output<typeof Artifact>[]>): Memory {
  const created = iso(m.created_at)!;
  return {
    memory_id: m.id,
    thought_id: m.thought_id,
    memory_type: m.memory_type,
    summary: m.summary,
    content: m.content,
    source: { kind: "agent_memory", uri: null, title: m.summary, timestamp: created },
    provenance: { status: m.provenance_status, confidence: Number(m.confidence), created_by: m.created_by, model: m.model, runtime: m.runtime_name },
    scope: { workspace_id: m.workspace_id, project_id: m.project_id, channel_id: m.channel_id, visibility: m.visibility },
    use_policy: { can_use_as_instruction: m.can_use_as_instruction, can_use_as_evidence: m.can_use_as_evidence, requires_user_confirmation: m.requires_user_confirmation },
    freshness: { created_at: created, last_confirmed_at: iso(m.last_confirmed_at), stale_after: iso(m.stale_after) },
    review_status: m.review_status,
    lifecycle_status: m.lifecycle_status,
    related_artifacts: artifacts.get(m.id) ?? [],
  };
}

/** Rows as memories, their artifacts read once. */
const asMemories = async (sql: PluginSql, rows: Row[]) => {
  const artifacts = await artifactsOf(sql, rows.map((r) => r.id));
  return rows.map((r) => asMemory(r, artifacts));
};

/** A core operation's refusal, as this plugin's: retryable stays retryable (503), anything else is 422. */
const coreRefused = (r: { code: string; retryable: boolean }): PluginOutcome<never> =>
  refuse(r.retryable ? 503 : 422, "CORE_REFUSED", { refused: r.code });

/** What makes a write-back unsafe to keep, the old server's tests unchanged: a key, a credential, a large code block, a transcript. */
export function unsafeReasons(t: string): string[] {
  const reasons: string[] = [];
  if (/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/.test(t)) reasons.push("private_key");
  if (/(?:sk-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9_-]{20,})/.test(t)) reasons.push("api_key");
  if (/(?:password|passwd|secret|token)\s*[:=]\s*\S{12,}/i.test(t)) reasons.push("credential_like_string");
  if ((t.match(/```/g) || []).length >= 4 || t.split("\n").filter((l) => l.length > 120).length > 20) reasons.push("large_code_block");
  if (t.length > 15000 || t.split("\n").filter((l) => /^(user|assistant|system|agent|human):/i.test(l.trim())).length > 8) reasons.push("raw_transcript_like");
  return reasons;
}

/** SHA-256 of a text, hex: the old server's content hash, so a memory migrated keeps its idempotency key. */
async function sha256Hex(t: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A time a source ref gave, as stored: ISO in UTC, or null for one that is no time (the old server failed the write-back on it). */
function timeOf(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const at = new Date(t);
  return at.getUTCFullYear() < 1 || at.getUTCFullYear() > 9999 ? null : at.toISOString();
}

const RecallInput = {
  schema_version: z.enum(RECALL_VERSIONS).describe("The request's version: openbrain.agent_memory.recall.v1, or OpenClaw's openbrain.openclaw.recall.v1"),
  workspace_id: text(LIMITS.id, 1).describe("The workspace whose memories to recall"),
  project_id: Id.nullish().describe("The project; with scope.project_only (the default), only its memories"),
  task_id: Id.nullish().describe("The runtime's task, kept on the trace"),
  flow_id: Id.nullish().describe("The runtime's flow, kept on the trace"),
  task_type: Id.nullish().describe("The kind of task, kept on the trace"),
  channel: Channel.describe("Where the task runs: kind, id, thread_id"),
  runtime: Runtime.describe("The runtime asking: name and version"),
  model_intent: z.object({ provider: Id.nullish(), model: Id.nullish() }).default({}).describe("The model the runtime means to use, kept on the trace"),
  query: text(LIMITS.query, 1).describe("What the task is about, searched by meaning"),
  entities: z.record(Id, z.array(Id).max(LIMITS.items)).default({}).describe("Named entities by kind, kept on the trace"),
  scope: z.object({
    visibility: Id.nullish().describe("personal to include personal memories"),
    project_only: z.boolean().default(true).describe("With a project_id, its memories alone"),
    include_unconfirmed: z.boolean().default(false).describe("Include memories still waiting for review"),
    include_stale: z.boolean().default(false).describe("Include stale, superseded, rejected and disputed memories"),
  }).default({ project_only: true, include_unconfirmed: false, include_stale: false }),
  limits: z.object({
    max_items: z.number().int().min(1).max(50).default(10).describe("How many memories, 1 to 50"),
    max_tokens: z.number().int().min(256).max(20000).default(4000).describe("The runtime's token budget, kept on the trace"),
    recency_days: z.number().int().positive().nullish().describe("Kept on the trace"),
  }).default({ max_items: 10, max_tokens: 4000 }),
  sensitivity: z.record(Id, z.boolean()).default({}).describe("Sensitivity flags, kept on the trace"),
};
type Recall = z.output<z.ZodObject<typeof RecallInput>>;

/** Whether a memory may be recalled for this request: its workspace, its project when asked, its lifecycle and review, and personal ones only when asked. */
function scopeMatches(m: Row, req: Recall): boolean {
  if (m.workspace_id !== req.workspace_id) return false;
  if (req.scope.project_only && req.project_id && m.project_id !== req.project_id) return false;
  if (!req.scope.include_stale && ["stale", "superseded", "rejected", "disputed"].includes(m.lifecycle_status)) return false;
  if (!req.scope.include_unconfirmed && m.requires_user_confirmation && m.review_status === "pending") return false;
  if (m.visibility === "personal" && req.scope.visibility !== "personal") return false;
  return true;
}

/** The old server's ranking: similarity, then what the memory's provenance, policy, review and confidence add. */
export function rankMemory(m: Pick<Row, "provenance_status" | "can_use_as_instruction" | "can_use_as_evidence" | "review_status" | "confidence">, similarity = 0): number {
  const provenance = m.provenance_status === "user_confirmed" ? 0.3
    : m.provenance_status === "imported" ? 0.22
    : m.provenance_status === "observed" ? 0.15
    : m.provenance_status === "generated" ? 0.05
    : 0;
  const policy = m.can_use_as_instruction ? 0.2 : m.can_use_as_evidence ? 0.08 : -0.2;
  const review = m.review_status === "confirmed" ? 0.15
    : m.review_status === "evidence_only" ? 0.05
    : m.review_status === "pending" ? -0.08
    : -0.25;
  return similarity + provenance + policy + review + Number(m.confidence || 0) * 0.15;
}

const WritebackInput = {
  schema_version: z.enum(WRITEBACK_VERSIONS).describe("The request's version: openbrain.agent_memory.writeback.v1, or OpenClaw's openbrain.openclaw.writeback.v1"),
  workspace_id: text(LIMITS.id, 1).describe("The workspace the memories belong to"),
  project_id: Id.nullish().describe("The project; a memory with one is project-visible, without one personal"),
  task_id: Id.nullish().describe("The runtime's task"),
  flow_id: Id.nullish().describe("The runtime's flow"),
  step_id: Id.nullish().describe("The task's step, part of the default idempotency key"),
  idempotency_key: Id.nullish().describe("The write-back's key: each memory's is it with its index. Absent: one made of the workspace, runtime, task, step and the memory's hash"),
  content_hash: Id.nullish().describe("Accepted for the old clients; each memory's hash is computed"),
  trust: z.enum(["operator", "agent", "ingested"]).nullish().describe("What the memories are, forwarded to each capture: it can lower your key's trust, never raise it. Absent or null: your key's"),
  channel: Channel.describe("Where the task ran: kind, id, thread_id"),
  runtime: Runtime.describe("The runtime writing back: name and version"),
  models_used: z.array(z.object({ provider: Id, model: Id, role: Id })).max(LIMITS.items).default([]).describe("The models the task used; the first is recorded as the memories' model"),
  source_refs: z.array(z.object({ kind: Id, uri: text(LIMITS.uri).nullish(), title: text(LIMITS.uri).nullish(), timestamp: Id.nullish() })).max(LIMITS.items).default([])
    .describe("Where the memories came from, kept beside each one"),
  memory_payload: z.object({
    decisions: Texts, outputs: Texts, lessons: Texts, constraints: Texts, unresolved_questions: Texts, next_steps: Texts, failures: Texts,
    artifacts: z.array(z.object({ kind: Id, uri: text(LIMITS.uri, 1), description: text(LIMITS.uri).nullish() })).max(LIMITS.items).default([]),
    entities: z.record(Id, z.array(Id).max(LIMITS.items)).default({}),
  }).describe("The memories, by kind: each item of each list is one memory (a next step is a work_log, an artifact an artifact_reference)"),
  provenance: z.object({
    default_status: z.enum(["observed", "inferred", "user_confirmed", "imported", "generated"]).default("generated"),
    confidence: z.number().min(0).max(1).default(0.5),
    requires_review: z.boolean().default(true),
  }).default({ default_status: "generated", confidence: 0.5, requires_review: true })
    .describe("Where the memories stand: user_confirmed or imported with requires_review false are confirmed at once, usable as instructions; anything else waits for review"),
  retention: z.object({ ttl_days: z.number().int().positive().nullish(), stale_after_days: z.number().int().positive().max(36_500).nullish() }).default({})
    .describe("stale_after_days sets each memory's stale_after"),
  visibility: z.object({ workspace: Id.nullish(), project: Id.nullish(), channel: Id.nullish() }).default({}).describe("Accepted for the old clients; unused"),
};
type Writeback = z.output<z.ZodObject<typeof WritebackInput>>;

/** The memories a write-back holds, in the old server's order, each artifact_reference with its artifact. */
function memoryRows(req: Writeback) {
  const p = req.memory_payload;
  const rows: { memory_type: (typeof MEMORY_TYPES)[number]; content: string; artifact?: Writeback["memory_payload"]["artifacts"][number] }[] = [];
  for (const content of p.decisions) rows.push({ memory_type: "decision", content });
  for (const content of p.outputs) rows.push({ memory_type: "output", content });
  for (const content of p.lessons) rows.push({ memory_type: "lesson", content });
  for (const content of p.constraints) rows.push({ memory_type: "constraint", content });
  for (const content of p.unresolved_questions) rows.push({ memory_type: "open_question", content });
  for (const content of p.next_steps) rows.push({ memory_type: "work_log", content: `Next step: ${content}` });
  for (const content of p.failures) rows.push({ memory_type: "failure", content });
  for (const artifact of p.artifacts) rows.push({ memory_type: "artifact_reference", content: `${artifact.kind}: ${artifact.description || artifact.uri}\n${artifact.uri}`, artifact });
  return rows;
}

/** An audit row, in the transaction given. */
async function audit(sql: PluginSql, event: string, at: { workspace_id?: string | null; project_id?: string | null; memory_id?: string | null; trace_id?: string | null; actor_kind?: string; actor_label?: string | null; runtime_name?: string | null; task_id?: string | null }, payload: Record<string, unknown>) {
  await sql`
    INSERT INTO audit_events (event_type, workspace_id, project_id, memory_id, trace_id, actor_kind, actor_label, runtime_name, task_id, payload)
    VALUES (${event}, ${at.workspace_id ?? null}, ${at.project_id ?? null}, ${at.memory_id ?? null}::uuid, ${at.trace_id ?? null}::uuid, ${at.actor_kind ?? "system"},
            ${at.actor_label ?? null}, ${at.runtime_name ?? null}, ${at.task_id ?? null}, (${json(payload)}::text)::jsonb)`;
}

const MemoryId = z.string().uuid().describe("The memory's id");
const RequestId = z.string().uuid().describe("The recall's request_id");
const noSuchMemory = (memory_id: string) => refuse(404, "NO_SUCH_MEMORY", { memory_id });
const noSuchRecall = (request_id: string) => refuse(404, "NO_SUCH_RECALL", { request_id });

/** MCP hints: every operation reaches the plugin's own tables, and the core's thoughts through ctx.call. */
const ADDS = { destructiveHint: false, openWorldHint: false } as const;
const CHANGES = { destructiveHint: true, openWorldHint: false } as const;
const CLOSED = { openWorldHint: false } as const;

/** The flat metadata keys a memory's thought carries (capture_thought takes at most eight): the rest is the memory row's. */
function thoughtMetadata(m: { workspace_id: string; memory_type: string; runtime_name: string | null; provenance_status: string; project_id?: string | null; task_id?: string | null }) {
  const metadata: Record<string, string> = { agent_memory_workspace: m.workspace_id, agent_memory_type: m.memory_type, agent_memory_provenance: m.provenance_status };
  if (m.runtime_name) metadata.agent_memory_runtime = m.runtime_name;
  if (m.project_id) metadata.agent_memory_project = m.project_id;
  if (m.task_id) metadata.agent_memory_task = m.task_id;
  return metadata;
}


/**
 * These memories read whole, in the order given (an id no memory has left out).
 * Every read of a whole memory is this one statement, its columns named: a `*`
 * would fail this prepared statement once a migration adds a column (check 41).
 */
async function memoriesOf(sql: PluginSql, ids: string[]): Promise<Row[]> {
  if (ids.length === 0) return [];
  const rows = await sql<Row>`
    SELECT id, thought_id, workspace_id, project_id, channel_id, visibility, memory_type, summary, content, lifecycle_status, provenance_status,
           confidence::float8 AS confidence, created_by, runtime_name, model, can_use_as_instruction, can_use_as_evidence, requires_user_confirmation,
           review_status, last_confirmed_at, stale_after, created_at, content_hash, metadata
      FROM memories WHERE id IN (SELECT jsonb_array_elements_text((${json(ids)}::text)::jsonb)::uuid)`;
  const by = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  return ids.flatMap((id) => by.get(id.toLowerCase()) ?? []);
}
/** One memory read whole, or none. */
const memoryById = async (sql: PluginSql, id: string) => (await memoriesOf(sql, [id]))[0];
/** The ids a query chose, in its order, read whole. */
const chosen = (sql: PluginSql, picked: { id: string }[]) => memoriesOf(sql, picked.map((r) => r.id));

export default definePlugin({
  name: "agent-memory",
  title: "Agent memory",
  description: "An agent runtime's governed memory: write back what a task decided, learnt and produced (each memory captured as a thought, waiting for review unless a person confirmed it), recall the workspace's memories by meaning, ranked by provenance and review, say which were used, and review them.",
  operations: {
    recall: operation({
      title: "Recall agent memories",
      description: "The workspace's memories that match the query by meaning, ranked by similarity and by what their provenance, use policy, review and confidence add: only those in scope (the project's with project_only, none stale, superseded, rejected or disputed unless include_stale, none still waiting for review unless include_unconfirmed, personal ones only with scope.visibility personal), at most limits.max_items. Each says whether it may be followed as an instruction or used only as evidence. Under a write key the recall is traced and request_id names it, for record_usage; under a read key nothing is stored and request_id is null. Refused PROVIDER_UNAVAILABLE (503, retryable) while the brain's embedding provider does not answer.",
      scope: "read",
      annotations: CLOSED,
      method: "POST",
      path: "/recall",
      input: RecallInput,
      output: { schema_version: z.string(), request_id: z.string().nullable(), memories: z.array(Memory) },
      async handler(ctx, req) {
        // The old server read 4 candidates per memory asked for, at least 20; the core's search answers at most 100.
        const found = await ctx.call("search_thoughts", { query: req.query, limit: Math.min(100, Math.max(req.limits.max_items * 4, 20)) });
        if (!found.ok) return coreRefused(found.refusal);
        // Without a vector the hits are exact matches alone: no memory would be found by meaning, so the runtime is told to retry.
        const failed = found.value.vectorFailed;
        if (failed) return refuse(503, "PROVIDER_UNAVAILABLE", { message: "the brain's embedding provider did not answer", reason: failed.reason, base: failed.base });
        const similarity = new Map<string, number>();
        for (const hit of found.value.hits) if (!similarity.has(hit.id)) similarity.set(hit.id, Number(hit.similarity ?? 0));
        const tracing = ctx.caller.scope === "write";
        return ctx.db.tx(async (sql) => {
          const rows = similarity.size === 0 ? [] : await chosen(sql, await sql<{ id: string }>`
            SELECT id FROM memories
             WHERE workspace_id = ${req.workspace_id}
               AND thought_id IN (SELECT jsonb_array_elements_text((${json([...similarity.keys()])}::text)::jsonb)::uuid)
             ORDER BY created_at DESC LIMIT 500`);
          const ranked = rows
            .filter((m) => scopeMatches(m, req))
            .map((m) => {
              const sim = similarity.get(m.thought_id ?? "") ?? 0;
              return { m, sim, score: rankMemory(m, sim) };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, req.limits.max_items);
          const memories = await asMemories(sql, ranked.map((r) => r.m));
          // A read key leaves no trace: the trace exists to be marked used or ignored, a write that key cannot make.
          if (!tracing) return ok({ schema_version: recallAnswerVersion(req.schema_version), request_id: null, memories });
          const [trace] = await sql<{ id: string; request_id: string }>`
            INSERT INTO recall_traces (workspace_id, project_id, runtime_name, runtime_version, task_id, flow_id, channel_kind, channel_id, query, schema_version, request_payload, response_policy)
            VALUES (${req.workspace_id}, ${req.project_id ?? null}, ${req.runtime.name}, ${req.runtime.version ?? null}, ${req.task_id ?? null}, ${req.flow_id ?? null},
                    ${req.channel.kind ?? null}, ${req.channel.id ?? null}, ${req.query}, ${req.schema_version}, (${json(req)}::text)::jsonb,
                    (${json({ max_items: req.limits.max_items, include_unconfirmed: req.scope.include_unconfirmed })}::text)::jsonb)
            RETURNING id::text AS id, request_id::text AS request_id`;
          for (const [i, r] of ranked.entries()) {
            await sql`
              INSERT INTO recall_items (trace_id, memory_id, rank, similarity, ranking_score, use_policy_snapshot)
              VALUES (${trace.id}::uuid, ${r.m.id}::uuid, ${i + 1}, ${r.sim}, ${r.score},
                      (${json({ can_use_as_instruction: r.m.can_use_as_instruction, can_use_as_evidence: r.m.can_use_as_evidence, requires_user_confirmation: r.m.requires_user_confirmation })}::text)::jsonb)`;
          }
          await audit(sql, "recall_requested", { workspace_id: req.workspace_id, project_id: req.project_id, trace_id: trace.id, runtime_name: req.runtime.name, task_id: req.task_id, actor_label: ctx.caller.name },
            { returned_count: ranked.length });
          return ok({ schema_version: recallAnswerVersion(req.schema_version), request_id: trace.request_id, memories });
        });
      },
    }),
    writeback: operation({
      title: "Write back agent memories",
      description: "Keeps what a task decided, produced, learnt, was constrained by, left open, means to do next, failed at and made (memory_payload): each item one memory, its text captured as a thought (source agent-memory, trust as given, never above your key's) and its provenance, scope and review kept beside it. A memory is confirmed at once, usable as an instruction, only when provenance.default_status is user_confirmed or imported and requires_review is false; any other waits for review, usable as evidence. Each memory has an idempotency key, so the same write-back sent again answers the memories it wrote and writes nothing. Refused: no memory in the payload (NO_MEMORIES), a memory that looks like a private key, an API key, a credential, a large code block or a transcript (UNSAFE_WRITEBACK, which lists why, and writes nothing), and an idempotency key already holding other text (IDEMPOTENCY_KEY_REUSED). While the brain's embedding provider does not answer, a memory is kept all the same, and recall finds it once the brain's vector mender has filled its thought's vector in.",
      scope: "capture",
      annotations: ADDS,
      method: "POST",
      path: "/writeback",
      input: WritebackInput,
      output: { schema_version: z.string(), memories: z.array(Memory) },
      async handler(ctx, req) {
        const rows = memoryRows(req);
        if (rows.length === 0) return refuse(400, "NO_MEMORIES", { message: "memory_payload holds no memory" });
        const unsafe = rows.flatMap((row) => unsafeReasons(row.content).map((reason) => ({ reason, memory_type: row.memory_type })));
        if (unsafe.length > 0) {
          await ctx.db.tx((sql) => audit(sql, "memory_rejected", { workspace_id: req.workspace_id, project_id: req.project_id, runtime_name: req.runtime.name, task_id: req.task_id, actor_label: ctx.caller.name },
            { reason: "unsafe_writeback", unsafe }));
          return refuse(422, "UNSAFE_WRITEBACK", { unsafe });
        }
        const provider = req.models_used[0]?.provider ?? null;
        const model = req.models_used[0]?.model ?? null;
        const confirmed = ["user_confirmed", "imported"].includes(req.provenance.default_status) && !req.provenance.requires_review;
        // A template literal: check 31 reads a quoted "import" with a quote after it as an import statement.
        const createdBy = req.provenance.default_status === "imported" ? `import` : "agent";
        const staleAfter = req.retention.stale_after_days ? new Date(Date.now() + req.retention.stale_after_days * 86_400_000).toISOString() : null;
        const ids: string[] = [];
        for (const [index, row] of rows.entries()) {
          const contentHash = await sha256Hex(`${row.memory_type}:${row.content}`);
          const base = req.idempotency_key || `${req.workspace_id}:${req.runtime.name}:${req.task_id || "taskless"}:${req.step_id || "step"}:${contentHash}`;
          const key = `${base}:${index}`;
          const [held] = await ctx.db.tx((sql) => sql<{ id: string; content_hash: string | null }>`SELECT id::text AS id, content_hash FROM memories WHERE idempotency_key = ${key}`);
          if (held) {
            // The same memory sent again. A key holding other text is not answered with it: a key that can only capture reads no memory it did not send.
            if (held.content_hash !== contentHash) return refuse(409, "IDEMPOTENCY_KEY_REUSED", { idempotency_key: key, message: "this key already holds another memory" });
            ids.push(held.id);
            continue;
          }
          const metadata = thoughtMetadata({ workspace_id: req.workspace_id, memory_type: row.memory_type, runtime_name: req.runtime.name, provenance_status: req.provenance.default_status, project_id: req.project_id, task_id: req.task_id });
          const captured = await ctx.call("capture_thought", { content: row.content, source: "agent-memory", metadata, ...(req.trust ? { trust: req.trust } : {}) });
          // A thought saved with no vector (the provider down, or the egress policy keeping the text in) is still kept, and
          // its memory with it: the brain's vector mender fills the vector in, and recall finds it from then on.
          if (!captured.ok) return coreRefused(captured.refusal);
          const thoughtId = captured.value.id;
          const id = await ctx.db.tx(async (sql) => {
            const [made] = await sql<{ id: string }>`
              INSERT INTO memories (thought_id, workspace_id, project_id, channel_kind, channel_id, channel_thread_id, visibility, memory_type, summary, content,
                                    provenance_status, confidence, created_by, runtime_name, runtime_version, provider, model, task_id, flow_id,
                                    can_use_as_instruction, can_use_as_evidence, requires_user_confirmation, review_status, last_confirmed_at, stale_after,
                                    idempotency_key, content_hash, metadata)
              VALUES (${thoughtId}::uuid, ${req.workspace_id}, ${req.project_id ?? null}, ${req.channel.kind ?? null}, ${req.channel.id ?? null}, ${req.channel.thread_id ?? null},
                      ${req.project_id ? "project" : "personal"}, ${row.memory_type}, ${row.content.replace(/\s+/g, " ").slice(0, 140)}, ${row.content},
                      ${req.provenance.default_status}, ${req.provenance.confidence}, ${createdBy},
                      ${req.runtime.name}, ${req.runtime.version ?? null}, ${provider}, ${model}, ${req.task_id ?? null}, ${req.flow_id ?? null},
                      ${confirmed}, true, ${!confirmed}, ${confirmed ? "confirmed" : "pending"}, ${confirmed ? new Date().toISOString() : null}::timestamptz, ${staleAfter}::timestamptz,
                      ${key}, ${contentHash},
                      (${json({ source_refs: req.source_refs, models_used: req.models_used, retention: req.retention, writeback_schema_version: req.schema_version })}::text)::jsonb)
              ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
              RETURNING id::text AS id`;
            // Another write-back with this key landed first: its memory is this one.
            if (!made) return (await sql<{ id: string }>`SELECT id::text AS id FROM memories WHERE idempotency_key = ${key}`)[0].id;
            for (const s of req.source_refs) {
              await sql`
                INSERT INTO source_refs (memory_id, source_kind, uri, title, source_timestamp)
                VALUES (${made.id}::uuid, ${s.kind}, ${s.uri ?? null}, ${s.title ?? null}, ${timeOf(s.timestamp)}::timestamptz)`;
            }
            // Its own artifact alone (the old server gave each artifact_reference every artifact of the write-back).
            if (row.artifact) {
              await sql`
                INSERT INTO artifacts (memory_id, artifact_kind, uri, description)
                VALUES (${made.id}::uuid, ${row.artifact.kind}, ${row.artifact.uri}, ${row.artifact.description ?? null})`;
            }
            await audit(sql, "memory_written", { workspace_id: req.workspace_id, project_id: req.project_id, memory_id: made.id, runtime_name: req.runtime.name, task_id: req.task_id, actor_kind: "agent", actor_label: ctx.caller.name },
              { provenance_status: req.provenance.default_status, review_status: confirmed ? "confirmed" : "pending" });
            return made.id;
          });
          ids.push(id);
        }
        return ctx.db.tx(async (sql) => {
          return ok({ schema_version: writebackAnswerVersion(req.schema_version), memories: await asMemories(sql, await memoriesOf(sql, ids)) });
        });
      },
    }),
    record_usage: operation({
      title: "Record which recalled memories were used",
      description: "Marks the memories a traced recall returned (request_id, from recall under a write key) as used, or ignored with a reason, and audits each. A memory id the recall did not return changes nothing; recorded counts the memories marked. Refused: a request_id no recall has (NO_SUCH_RECALL).",
      scope: "write",
      annotations: CHANGES,
      method: "POST",
      path: "/recalls/{request_id}/usage",
      input: {
        request_id: RequestId,
        used_memory_ids: z.array(z.string().uuid()).max(LIMITS.items).default([]).describe("The memories the runtime used"),
        ignored: z.array(z.object({ memory_id: z.string().uuid(), reason: text(LIMITS.uri).optional() })).max(LIMITS.items).default([]).describe("The memories it left, each with why"),
      },
      output: { recorded: z.object({ used: z.number().int(), ignored: z.number().int() }) },
      async handler(ctx, { request_id, used_memory_ids, ignored }) {
        return ctx.db.tx(async (sql) => {
          const [trace] = await sql<{ id: string; workspace_id: string; project_id: string | null; runtime_name: string | null; task_id: string | null }>`
            SELECT id::text AS id, workspace_id, project_id, runtime_name, task_id FROM recall_traces WHERE request_id = ${request_id}::uuid`;
          if (!trace) return noSuchRecall(request_id);
          const at = { workspace_id: trace.workspace_id, project_id: trace.project_id, trace_id: trace.id, runtime_name: trace.runtime_name, task_id: trace.task_id, actor_kind: "agent", actor_label: ctx.caller.name };
          let used = 0;
          for (const memory_id of used_memory_ids) {
            const marked = await sql`UPDATE recall_items SET used = true, ignored_reason = NULL WHERE trace_id = ${trace.id}::uuid AND memory_id = ${memory_id}::uuid RETURNING 1`;
            if (marked.length === 0) continue;
            used++;
            await audit(sql, "memory_used", { ...at, memory_id }, {});
          }
          let left = 0;
          for (const i of ignored) {
            const marked = await sql`UPDATE recall_items SET used = false, ignored_reason = ${i.reason ?? null} WHERE trace_id = ${trace.id}::uuid AND memory_id = ${i.memory_id}::uuid RETURNING 1`;
            if (marked.length === 0) continue;
            left++;
            await audit(sql, "memory_ignored", { ...at, memory_id: i.memory_id }, { reason: i.reason ?? null });
          }
          return ok({ recorded: { used, ignored: left } });
        });
      },
    }),
    review_queue: operation({
      title: "Agent memories waiting for review",
      description: "A workspace's memories still pending review, newest first, at most 100 (project_id narrows to one project). Review each with review_memory.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/review-queue",
      input: { workspace_id: text(LIMITS.id, 1).describe("The workspace"), project_id: Id.optional().describe("One project's alone") },
      output: { memories: z.array(Memory) },
      async handler(ctx, { workspace_id, project_id }) {
        return ctx.db.tx(async (sql) => {
          const rows = await chosen(sql, await sql<{ id: string }>`
            SELECT id FROM memories
             WHERE workspace_id = ${workspace_id} AND review_status = 'pending' AND (${project_id ?? null}::text IS NULL OR project_id = ${project_id ?? null})
             ORDER BY created_at DESC, id LIMIT 100`);
          return ok({ memories: await asMemories(sql, rows) });
        });
      },
    }),
    list_memories: operation({
      title: "List agent memories",
      description: "A workspace's memories, newest first, narrowed by project, review status, lifecycle status, runtime, memory type and task id prefix; count is how many are answered (limit 1 to 200, default 50).",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/memories",
      input: {
        workspace_id: text(LIMITS.id, 1).describe("The workspace"),
        project_id: Id.optional().describe("One project's"),
        review_status: z.enum(REVIEW).optional().describe("One review status's"),
        lifecycle_status: z.enum(LIFECYCLE).optional().describe("One lifecycle status's"),
        runtime_name: Id.optional().describe("One runtime's"),
        memory_type: z.enum(MEMORY_TYPES).optional().describe("One kind's"),
        task_id_prefix: Id.optional().describe("Those whose task id starts with this"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many, 1 to 200"),
      },
      output: { memories: z.array(Memory), count: z.number().int() },
      async handler(ctx, f) {
        return ctx.db.tx(async (sql) => {
          const rows = await chosen(sql, await sql<{ id: string }>`
            SELECT id FROM memories
             WHERE workspace_id = ${f.workspace_id}
               AND (${f.project_id ?? null}::text IS NULL OR project_id = ${f.project_id ?? null})
               AND (${f.review_status ?? null}::text IS NULL OR review_status = ${f.review_status ?? null})
               AND (${f.lifecycle_status ?? null}::text IS NULL OR lifecycle_status = ${f.lifecycle_status ?? null})
               AND (${f.runtime_name ?? null}::text IS NULL OR runtime_name = ${f.runtime_name ?? null})
               AND (${f.memory_type ?? null}::text IS NULL OR memory_type = ${f.memory_type ?? null})
               AND (${f.task_id_prefix ?? null}::text IS NULL OR starts_with(task_id, ${f.task_id_prefix ?? null}))
             ORDER BY created_at DESC, id LIMIT ${f.limit}`);
          return ok({ memories: await asMemories(sql, rows), count: rows.length });
        });
      },
    }),
    get_memory: operation({
      title: "One agent memory",
      description: "A memory with where it came from (source_refs), the models that made it, and the memories a review merged or superseded it with or into. Refused: an id no memory has (NO_SUCH_MEMORY).",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/memories/{memory_id}",
      input: { memory_id: MemoryId },
      output: {
        memory: Memory,
        source_refs: z.array(z.object({ kind: z.string(), uri: z.string().nullable(), title: z.string().nullable(), timestamp: z.string().nullable() })),
        models_used: z.array(z.object({ provider: z.string(), model: z.string(), role: z.string() })),
        relations: z.array(z.object({ from_memory_id: z.string(), to_memory_id: z.string(), relation: z.string() })),
      },
      async handler(ctx, { memory_id }) {
        return ctx.db.tx(async (sql) => {
          const m = await memoryById(sql, memory_id);
          if (!m) return noSuchMemory(memory_id);
          const refs = await sql<{ kind: string; uri: string | null; title: string | null; timestamp: Date | null }>`
            SELECT source_kind AS kind, uri, title, source_timestamp AS timestamp FROM source_refs WHERE memory_id = ${memory_id}::uuid ORDER BY created_at, id`;
          const relations = await sql<{ from_memory_id: string; to_memory_id: string; relation: string }>`
            SELECT from_memory_id::text AS from_memory_id, to_memory_id::text AS to_memory_id, relation FROM relations
             WHERE from_memory_id = ${memory_id}::uuid OR to_memory_id = ${memory_id}::uuid ORDER BY created_at, id`;
          const models = Array.isArray(m.metadata?.models_used) ? (m.metadata.models_used as { provider?: unknown; model?: unknown; role?: unknown }[]) : [];
          return ok({
            memory: (await asMemories(sql, [m]))[0],
            source_refs: refs.map((r) => ({ ...r, timestamp: iso(r.timestamp) })),
            models_used: models.filter((x) => typeof x?.provider === "string" && typeof x.model === "string" && typeof x.role === "string") as { provider: string; model: string; role: string }[],
            relations,
          });
        });
      },
    }),
    review_memory: operation({
      title: "Review an agent memory",
      description: "A person's verdict on a memory: confirm (user_confirmed, usable as an instruction), evidence_only (usable as evidence, never as an instruction), restrict_scope (to visibility, personal by default), mark_stale, reject (used for neither), dispute, edit (content and summary; new content is captured as a thought of its own, which the memory then names, and its old thought is left), merge or supersede (with related_memory_id, recorded as a relation). Each review is kept with the memory before and after it, under your key's name. Refused: an id no memory has (NO_SUCH_MEMORY), an edit with nothing to change (NOTHING_TO_CHANGE), related_memory_id naming the memory itself (SAME_MEMORY) or none (NO_SUCH_MEMORY), and the core refusing the new text's capture (CORE_REFUSED).",
      scope: "write",
      annotations: CHANGES,
      method: "PATCH",
      path: "/memories/{memory_id}/review",
      input: {
        memory_id: MemoryId,
        action: z.enum(ACTIONS).describe("The verdict"),
        actor_label: Id.nullish().describe("Who reviewed, as a person reads it; the key's name is recorded beside it"),
        notes: text(LIMITS.uri).nullish().describe("Why"),
        content: text(LIMITS.memory, 1).optional().describe("edit: the new text"),
        summary: text(LIMITS.uri, 1).optional().describe("edit: the new summary"),
        visibility: z.enum(VISIBILITIES).optional().describe("restrict_scope: to whom (personal by default)"),
        related_memory_id: z.string().uuid().optional().describe("merge or supersede: the other memory"),
      },
      output: { memory: Memory },
      async handler(ctx, r) {
        if (r.action === "edit" && r.content === undefined && r.summary === undefined) return refuse(400, "NOTHING_TO_CHANGE", { message: "an edit gives content, summary or both" });
        const related = ["merge", "supersede"].includes(r.action) ? r.related_memory_id : undefined;
        if (related && related.toLowerCase() === r.memory_id.toLowerCase()) return refuse(400, "SAME_MEMORY", { memory_id: r.memory_id });
        const first = await ctx.db.tx((sql) => memoryById(sql, r.memory_id));
        if (!first) return noSuchMemory(r.memory_id);
        // The new text's thought first, so a refused capture changes nothing here. Captured, not edited in place: the old
        // thought may be another memory's too. It stays, as any captured thought does.
        let thoughtId: string | null = null;
        if (r.action === "edit" && r.content !== undefined) {
          const captured = await ctx.call("capture_thought", { content: r.content, source: "agent-memory", metadata: thoughtMetadata(first) });
          if (!captured.ok) return coreRefused(captured.refusal);
          thoughtId = captured.value.id;
        }
        return ctx.db.tx(async (sql) => {
          const [before] = await sql<{ row: unknown }>`SELECT to_jsonb(m) AS row FROM memories m WHERE id = ${r.memory_id}::uuid FOR UPDATE`;
          if (!before) return noSuchMemory(r.memory_id);
          if (related && !(await memoryById(sql, related))) return noSuchMemory(related);
          const a = r.action;
          const contentHash = a === "edit" && r.content !== undefined ? await sha256Hex(`${first.memory_type}:${r.content}`) : null;
          await sql`
            UPDATE memories SET
              review_status = CASE ${a} WHEN 'confirm' THEN 'confirmed' WHEN 'evidence_only' THEN 'evidence_only' WHEN 'reject' THEN 'rejected'
                                        WHEN 'mark_stale' THEN 'stale' WHEN 'restrict_scope' THEN 'restricted' ELSE review_status END,
              lifecycle_status = CASE ${a} WHEN 'reject' THEN 'rejected' WHEN 'mark_stale' THEN 'stale' WHEN 'dispute' THEN 'disputed' ELSE lifecycle_status END,
              provenance_status = CASE ${a} WHEN 'confirm' THEN 'user_confirmed' WHEN 'dispute' THEN 'disputed' ELSE provenance_status END,
              can_use_as_instruction = CASE WHEN ${a} = 'confirm' THEN true WHEN ${a} IN ('evidence_only', 'reject', 'mark_stale', 'dispute') THEN false ELSE can_use_as_instruction END,
              can_use_as_evidence = CASE ${a} WHEN 'evidence_only' THEN true WHEN 'reject' THEN false ELSE can_use_as_evidence END,
              requires_user_confirmation = CASE WHEN ${a} IN ('confirm', 'evidence_only') THEN false ELSE requires_user_confirmation END,
              last_confirmed_at = CASE ${a} WHEN 'confirm' THEN now() ELSE last_confirmed_at END,
              visibility = CASE ${a} WHEN 'restrict_scope' THEN ${r.visibility ?? "personal"} ELSE visibility END,
              content = coalesce(${a === "edit" ? r.content ?? null : null}::text, content),
              content_hash = coalesce(${contentHash}::text, content_hash),
              thought_id = coalesce(${thoughtId}::uuid, thought_id),
              summary = coalesce(${a === "edit" ? r.summary ?? null : null}::text, summary),
              updated_at = now()
            WHERE id = ${r.memory_id}::uuid`;
          const [after] = await sql<{ row: unknown }>`SELECT to_jsonb(m) AS row FROM memories m WHERE id = ${r.memory_id}::uuid`;
          await sql`
            INSERT INTO review_actions (memory_id, action, actor_id, actor_label, notes, before, after)
            VALUES (${r.memory_id}::uuid, ${a}, ${ctx.caller.name}, ${r.actor_label ?? null}, ${r.notes ?? null}, (${json(before.row)}::text)::jsonb, (${json(after.row)}::text)::jsonb)`;
          if (related) {
            await sql`
              INSERT INTO relations (from_memory_id, to_memory_id, relation, confidence)
              VALUES (${r.memory_id}::uuid, ${related}::uuid, ${a === "merge" ? "merged_into" : "supersedes"}, 1)
              ON CONFLICT (from_memory_id, to_memory_id, relation) DO NOTHING`;
          }
          const event = ({ confirm: "memory_confirmed", reject: "memory_rejected", supersede: "memory_superseded", dispute: "memory_disputed" } as Record<string, string>)[a] ?? "memory_edited";
          await audit(sql, event, { workspace_id: first.workspace_id, project_id: first.project_id, memory_id: r.memory_id, actor_kind: "user", actor_label: r.actor_label ?? ctx.caller.name }, { action: a, key: ctx.caller.name });
          return ok({ memory: (await asMemories(sql, [(await memoryById(sql, r.memory_id))!]))[0] });
        });
      },
    }),
    get_recall: operation({
      title: "One traced recall",
      description: "A recall made under a write key, by its request_id: what was asked, and each memory it returned in rank order with its similarity, its score, the use policy it had then, and whether the runtime said it used it (null: not said). Refused: a request_id no recall has (NO_SUCH_RECALL).",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/recalls/{request_id}",
      input: { request_id: RequestId },
      output: {
        trace: z.object({
          request_id: z.string(), workspace_id: z.string(), project_id: z.string().nullable(), runtime_name: z.string().nullable(), runtime_version: z.string().nullable(),
          task_id: z.string().nullable(), flow_id: z.string().nullable(), channel_kind: z.string().nullable(), channel_id: z.string().nullable(), query: z.string(),
          schema_version: z.string(), request_payload: z.record(z.string(), z.unknown()), response_policy: z.record(z.string(), z.unknown()), created_at: z.string(),
        }),
        items: z.array(z.object({
          rank: z.number().int(), similarity: z.number().nullable(), ranking_score: z.number().nullable(), returned: z.boolean(), used: z.boolean().nullable(),
          ignored_reason: z.string().nullable(), use_policy_snapshot: z.record(z.string(), z.unknown()), memory: Memory,
        })),
      },
      async handler(ctx, { request_id }) {
        return ctx.db.tx(async (sql) => {
          const [trace] = await sql<{ id: string; request_id: string; workspace_id: string; project_id: string | null; runtime_name: string | null; runtime_version: string | null; task_id: string | null; flow_id: string | null; channel_kind: string | null; channel_id: string | null; query: string; schema_version: string; request_payload: Record<string, unknown>; response_policy: Record<string, unknown>; created_at: Date }>`
            SELECT id::text AS id, request_id::text AS request_id, workspace_id, project_id, runtime_name, runtime_version, task_id, flow_id, channel_kind, channel_id,
                   query, schema_version, request_payload, response_policy, created_at
              FROM recall_traces WHERE request_id = ${request_id}::uuid`;
          if (!trace) return noSuchRecall(request_id);
          const items = await sql<{ memory_id: string; rank: number; similarity: number | null; ranking_score: number | null; returned: boolean; used: boolean | null; ignored_reason: string | null; use_policy_snapshot: Record<string, unknown> }>`
            SELECT memory_id::text AS memory_id, rank, similarity::float8 AS similarity, ranking_score::float8 AS ranking_score, returned, used, ignored_reason, use_policy_snapshot
              FROM recall_items WHERE trace_id = ${trace.id}::uuid ORDER BY rank, id`;
          const rows = await memoriesOf(sql, items.map((i) => i.memory_id));
          const memories = new Map((await asMemories(sql, rows)).map((m) => [m.memory_id, m]));
          const { id: _id, ...shown } = trace;
          return ok({
            trace: { ...shown, created_at: iso(trace.created_at)! },
            items: items.flatMap(({ memory_id, ...i }) => (memories.has(memory_id) ? [{ ...i, memory: memories.get(memory_id)! }] : [])),
          });
        });
      },
    }),
  },
});
