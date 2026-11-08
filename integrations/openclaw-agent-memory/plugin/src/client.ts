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

function requestInput(input: Record<string, unknown>) {
  return input && typeof input === "object" ? input : {};
}

function projectIdFrom(input: Record<string, unknown>, configuredProjectId?: string) {
  if (configuredProjectId) return configuredProjectId;
  if (typeof input.project_id === "string" || input.project_id === null) return input.project_id;
  return null;
}

/**
 * A route that answered other than 2xx: its HTTP status, and the plugin's
 * refusal code when the body names one (`NO_SUCH_MEMORY`, `UNSAFE_WRITEBACK`,
 * `PROVIDER_UNAVAILABLE`, ...). `retryAfter` is the Retry-After a 503 the
 * caller may retry carries, in seconds; `body` the refusal as answered.
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
   * the query string and it sends no body; a refusal throws AgentMemoryError.
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
    return text ? JSON.parse(text) : {};
  }

  recall(input: Record<string, unknown>) {
    const request = requestInput(input);
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
    const request = requestInput(input);
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
    return this.request(`/recalls/${segment(requestId)}/usage`, { method: "POST", body: input });
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
    return this.request(`/memories/${segment(memoryId)}/review`, { method: "PATCH", body: input });
  }

  /** Answered {trace, items}: a recall made under a write key. */
  getRecallTrace(requestId: string) {
    return this.request(`/recalls/${segment(requestId)}`);
  }
}
