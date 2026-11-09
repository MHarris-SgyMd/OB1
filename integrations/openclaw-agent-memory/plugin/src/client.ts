export type AgentMemoryConfig = {
  endpoint: string;
  accessKey: string;
  workspaceId: string;
  projectId?: string;
  requireReviewByDefault?: boolean;
  includeUnconfirmedRecall?: boolean;
};

type RequestOptions = {
  method?: string;
  body?: unknown;
  /** A GET's input: each value given, in the query string. */
  query?: Record<string, string | undefined>;
};

/**
 * The fields each plugin route takes, top level, as plugins/agent-memory/index.ts declares them. The REST input is
 * strict: a field it does not take is refused (REFUSED_INPUT), so a field a model adds to a tool's arguments is
 * dropped here, not sent. test-plugin-ports.ts holds these to the plugin's own.
 */
export const FIELDS = {
  recall: ["schema_version", "workspace_id", "project_id", "task_id", "flow_id", "task_type", "channel", "runtime", "model_intent", "query", "entities", "scope", "limits", "sensitivity"],
  writeback: ["schema_version", "workspace_id", "project_id", "task_id", "flow_id", "step_id", "idempotency_key", "content_hash", "trust", "channel", "runtime", "models_used", "source_refs", "memory_payload", "provenance", "retention", "visibility"],
  record_usage: ["used_memory_ids", "ignored"],
  review_memory: ["action", "actor_label", "notes", "content", "summary", "visibility", "related_memory_id"],
} as const;

/** The input's fields the route takes; anything else left out. */
function only(input: unknown, fields: readonly string[]): Record<string, unknown> {
  const given = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return Object.fromEntries(fields.filter((f) => given[f] !== undefined).map((f) => [f, given[f]]));
}

function projectIdFrom(input: Record<string, unknown>, configuredProjectId?: string) {
  if (configuredProjectId) return configuredProjectId;
  if (typeof input.project_id === "string" || input.project_id === null) return input.project_id;
  return null;
}

/**
 * A route that answered other than 2xx, or a 2xx that is no JSON object: its HTTP status, and the plugin's refusal
 * code when the body names one (`NO_SUCH_MEMORY`, `UNSAFE_WRITEBACK`, `PROVIDER_UNAVAILABLE`, ...). `retryAfter` is
 * the Retry-After a 503 the caller may retry carries, in seconds; `body` the refusal as answered.
 */
export class AgentMemoryError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfter: string | null;
  readonly body: unknown;

  constructor(method: string, path: string, status: number, text: string, retryAfter: string | null) {
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON (a proxy's page): kept as text.
    }
    const named = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const code = typeof named.code === "string" ? named.code : null;
    const message = typeof named.message === "string" && named.message ? `: ${named.message}` : "";
    super(`OB1 agent-memory ${method} ${path} ${status} ${code ?? text.slice(0, 300)}${message}`.trimEnd());
    this.name = "AgentMemoryError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

/** A path segment: an id with a slash or a ? in it must not become another route. */
const segment = (id: string) => encodeURIComponent(id);

export class AgentMemoryClient {
  private endpoint: string;
  private accessKey: string;

  constructor(private config: AgentMemoryConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.accessKey = config.accessKey;
    if (!this.accessKey) {
      throw new Error("OB1 Agent Memory access key missing. Configure plugins.entries.nbj-ob1-agent-memory.config.accessKey.");
    }
  }

  /**
   * One call on the plugin's routes, under `endpoint`
   * (`https://<host>/api/v1/plugins/agent-memory`), the key as x-brain-key,
   * which the REST core reads (it reads no `?key=`). A GET's input goes in
   * the query string and it sends no body; a refusal, or a 2xx that is no JSON
   * object, throws AgentMemoryError.
   */
  async request(path: string, options: RequestOptions = {}) {
    const method = options.method || "GET";
    const query = options.query
      ? new URLSearchParams(Object.entries(options.query).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "")).toString()
      : "";
    const headers: Record<string, string> = { "x-brain-key": this.accessKey };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${this.endpoint}${path}${query ? `?${query}` : ""}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    if (!response.ok) throw new AgentMemoryError(method, path, response.status, text, response.headers.get("retry-after"));
    let answer: unknown = null;
    try {
      answer = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: told below.
    }
    // A 2xx that is not a JSON object, an empty one among them, is no answer of the plugin's: an endpoint pointing at some other page.
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
      throw new AgentMemoryError(method, path, response.status, `not the plugin's answer (not a JSON object): ${text}`, null);
    }
    return answer as any;
  }

  recall(input: Record<string, unknown>) {
    const request = only(input, FIELDS.recall);
    const projectId = projectIdFrom(request, this.config.projectId);
    return this.request("/recall", {
      method: "POST",
      body: {
        ...request,
        schema_version: "openbrain.openclaw.recall.v1",
        workspace_id: this.config.workspaceId,
        project_id: projectId,
        scope: {
          include_unconfirmed: this.config.includeUnconfirmedRecall ?? false,
          ...(typeof request.scope === "object" && request.scope ? request.scope : {}),
        },
      },
    });
  }

  /** Answered {schema_version, memories}: each memory whole under a write key, its memory_id and thought_id alone under a capture-only key. */
  writeback(input: Record<string, unknown>) {
    const request = only(input, FIELDS.writeback);
    const projectId = projectIdFrom(request, this.config.projectId);
    return this.request("/writeback", {
      method: "POST",
      body: {
        ...request,
        schema_version: "openbrain.openclaw.writeback.v1",
        workspace_id: this.config.workspaceId,
        project_id: projectId,
        provenance: {
          default_status: "generated",
          confidence: 0.5,
          requires_review: this.config.requireReviewByDefault ?? true,
          ...(typeof request.provenance === "object" && request.provenance ? request.provenance : {}),
        },
      },
    });
  }

  /** Answered {recorded: {used, ignored}}, the memories it marked. */
  reportUsage(requestId: string, input: Record<string, unknown>) {
    return this.request(`/recalls/${segment(requestId)}/usage`, { method: "POST", body: only(input, FIELDS.record_usage) });
  }

  /** Answered {memory, source_refs, models_used, relations}. */
  inspectMemory(memoryId: string) {
    return this.request(`/memories/${segment(memoryId)}`);
  }

  /** Answered {memories}: those still waiting for a person's confirmation. */
  listReviewQueue(input: { workspace_id?: string; project_id?: string } = {}) {
    return this.request("/review-queue", {
      query: { workspace_id: input.workspace_id || this.config.workspaceId, project_id: input.project_id || this.config.projectId },
    });
  }

  /** Answered {memory}, as the review left it. */
  reviewMemory(memoryId: string, input: Record<string, unknown>) {
    return this.request(`/memories/${segment(memoryId)}/review`, { method: "PATCH", body: only(input, FIELDS.review_memory) });
  }

  /** Answered {trace, items}: a recall made under a write key. */
  getRecallTrace(requestId: string) {
    return this.request(`/recalls/${segment(requestId)}`);
  }
}

/** How a memory reads to an agent: an instruction it may follow, evidence alone, or neither. */
function provenanceLabel(m: any): "instruction" | "evidence" | undefined {
  const policy = m?.use_policy ?? {};
  return policy?.can_use_as_instruction ? "instruction" : policy?.can_use_as_evidence ? "evidence" : undefined;
}

/** When a person last confirmed a memory, else when it was written: the plugin's memory carries its times under freshness. */
function updatedAtOf(m: any): string | undefined {
  const f = m?.freshness;
  const at = f?.last_confirmed_at ?? f?.created_at;
  return typeof at === "string" ? at : undefined;
}

/**
 * A recall's memories as OpenClaw's memory corpus lists them. The plugin answers them in rank order with no score,
 * so the rank stands in for one; a memory's id is its memory_id.
 */
export function corpusHits(recall: any) {
  const memories: any[] = Array.isArray(recall?.memories) ? recall.memories : [];
  return memories.map((m, i) => {
    const id = typeof m?.memory_id === "string" ? m.memory_id : undefined;
    return {
      corpus: "openbrain",
      path: `openbrain://memory/${id ?? i}`,
      title: typeof m?.summary === "string" ? m.summary.slice(0, 80) : undefined,
      kind: "memory",
      score: Math.max(0, 1 - i / Math.max(memories.length, 1)),
      snippet: String(m?.summary ?? m?.content ?? "").slice(0, 600),
      id,
      provenanceLabel: provenanceLabel(m),
      source: "openbrain.agent_memory",
      sourceType: "openbrain.agent_memory",
      updatedAt: updatedAtOf(m),
    };
  });
}

/** A memory as OpenClaw's memory corpus reads it, from get_memory's answer ({memory, source_refs, ...}); null for none. */
export function corpusDocument(answer: any, lookup: string, id: string) {
  const memory = answer?.memory;
  if (!memory || typeof memory !== "object") return null;
  const content = String(memory.content ?? memory.summary ?? "");
  return {
    corpus: "openbrain",
    path: lookup,
    title: typeof memory.summary === "string" ? memory.summary.slice(0, 80) : undefined,
    kind: "memory",
    content,
    fromLine: 1,
    lineCount: content.split("\n").length,
    id: typeof memory.memory_id === "string" ? memory.memory_id : id,
    provenanceLabel: provenanceLabel(memory),
    sourceType: "openbrain.agent_memory",
    updatedAt: updatedAtOf(memory),
  };
}
