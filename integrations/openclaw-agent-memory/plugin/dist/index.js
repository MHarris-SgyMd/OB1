// src/index.ts
import { Type as Type2 } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";

// src/client.ts
var FIELDS = {
  recall: ["schema_version", "workspace_id", "project_id", "task_id", "flow_id", "task_type", "channel", "runtime", "model_intent", "query", "entities", "scope", "limits", "sensitivity"],
  writeback: ["schema_version", "workspace_id", "project_id", "task_id", "flow_id", "step_id", "idempotency_key", "content_hash", "trust", "channel", "runtime", "models_used", "source_refs", "memory_payload", "provenance", "retention", "visibility"],
  record_usage: ["used_memory_ids", "ignored"],
  review_memory: ["action", "actor_label", "notes", "content", "summary", "visibility", "related_memory_id"]
};
function only(input, fields) {
  const given = input && typeof input === "object" ? input : {};
  return Object.fromEntries(fields.filter((f) => given[f] !== void 0).map((f) => [f, given[f]]));
}
function projectIdFrom(input, configuredProjectId) {
  if (configuredProjectId) return configuredProjectId;
  if (typeof input.project_id === "string" || input.project_id === null) return input.project_id;
  return null;
}
var AgentMemoryError = class extends Error {
  status;
  code;
  retryAfter;
  body;
  constructor(method, path, status, text, retryAfter) {
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
    }
    const named = body && typeof body === "object" ? body : {};
    const code = typeof named.code === "string" ? named.code : null;
    const message = typeof named.message === "string" && named.message ? `: ${named.message}` : "";
    super(`OB1 agent-memory ${method} ${path} ${status} ${code ?? text.slice(0, 300)}${message}`.trimEnd());
    this.name = "AgentMemoryError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.body = body;
  }
};
var segment = (id) => encodeURIComponent(id);
var AgentMemoryClient = class {
  constructor(config) {
    this.config = config;
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.accessKey = config.accessKey;
    if (!this.accessKey) {
      throw new Error("OB1 Agent Memory access key missing. Configure plugins.entries.nbj-ob1-agent-memory.config.accessKey.");
    }
  }
  endpoint;
  accessKey;
  /**
   * One call on the plugin's routes, under `endpoint`
   * (`https://<host>/api/v1/plugins/agent-memory`), the key as x-brain-key,
   * which the REST core reads (it reads no `?key=`). A GET's input goes in
   * the query string and it sends no body; a refusal throws AgentMemoryError.
   */
  async request(path, options = {}) {
    const method = options.method || "GET";
    const query = options.query ? new URLSearchParams(Object.entries(options.query).filter((e) => typeof e[1] === "string" && e[1] !== "")).toString() : "";
    const headers = { "x-brain-key": this.accessKey };
    if (options.body !== void 0) headers["content-type"] = "application/json";
    const response = await fetch(`${this.endpoint}${path}${query ? `?${query}` : ""}`, {
      method,
      headers,
      body: options.body === void 0 ? void 0 : JSON.stringify(options.body)
    });
    const text = await response.text();
    if (!response.ok) throw new AgentMemoryError(method, path, response.status, text, response.headers.get("retry-after"));
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new AgentMemoryError(method, path, response.status, `not the plugin's answer (not JSON): ${text}`, null);
    }
  }
  recall(input) {
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
          ...typeof request.scope === "object" && request.scope ? request.scope : {}
        }
      }
    });
  }
  /** Answered {schema_version, memories}: each memory whole under a write key, its memory_id and thought_id alone under a capture-only key. */
  writeback(input) {
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
          ...typeof request.provenance === "object" && request.provenance ? request.provenance : {}
        }
      }
    });
  }
  /** Answered {recorded: {used, ignored}}, the memories it marked. */
  reportUsage(requestId, input) {
    return this.request(`/recalls/${segment(requestId)}/usage`, { method: "POST", body: only(input, FIELDS.record_usage) });
  }
  /** Answered {memory, source_refs, models_used, relations}. */
  inspectMemory(memoryId) {
    return this.request(`/memories/${segment(memoryId)}`);
  }
  /** Answered {memories}: those still waiting for a person's confirmation. */
  listReviewQueue(input = {}) {
    return this.request("/review-queue", {
      query: { workspace_id: input.workspace_id || this.config.workspaceId, project_id: input.project_id || this.config.projectId }
    });
  }
  /** Answered {memory}, as the review left it. */
  reviewMemory(memoryId, input) {
    return this.request(`/memories/${segment(memoryId)}/review`, { method: "PATCH", body: only(input, FIELDS.review_memory) });
  }
  /** Answered {trace, items}: a recall made under a write key. */
  getRecallTrace(requestId) {
    return this.request(`/recalls/${segment(requestId)}`);
  }
};
function provenanceLabel(m) {
  const policy = m?.use_policy ?? {};
  return policy?.can_use_as_instruction ? "instruction" : policy?.can_use_as_evidence ? "evidence" : void 0;
}
function updatedAtOf(m) {
  const f = m?.freshness;
  const at = f?.last_confirmed_at ?? f?.created_at;
  return typeof at === "string" ? at : void 0;
}
function corpusHits(recall) {
  const memories = Array.isArray(recall?.memories) ? recall.memories : [];
  return memories.map((m, i) => {
    const id = typeof m?.memory_id === "string" ? m.memory_id : void 0;
    return {
      corpus: "openbrain",
      path: `openbrain://memory/${id ?? i}`,
      title: typeof m?.summary === "string" ? m.summary.slice(0, 80) : void 0,
      kind: "memory",
      score: Math.max(0, 1 - i / Math.max(memories.length, 1)),
      snippet: String(m?.summary ?? m?.content ?? "").slice(0, 600),
      id,
      provenanceLabel: provenanceLabel(m),
      source: "openbrain.agent_memory",
      sourceType: "openbrain.agent_memory",
      updatedAt: updatedAtOf(m)
    };
  });
}
function corpusDocument(answer, lookup, id) {
  const memory = answer?.memory;
  if (!memory || typeof memory !== "object") return null;
  const content = String(memory.content ?? memory.summary ?? "");
  return {
    corpus: "openbrain",
    path: lookup,
    title: typeof memory.summary === "string" ? memory.summary.slice(0, 80) : void 0,
    kind: "memory",
    content,
    fromLine: 1,
    lineCount: content.split("\n").length,
    id: typeof memory.memory_id === "string" ? memory.memory_id : id,
    provenanceLabel: provenanceLabel(memory),
    sourceType: "openbrain.agent_memory",
    updatedAt: updatedAtOf(memory)
  };
}

// src/tool-schemas.js
import { Type } from "typebox";
var schemaVersion = (value) => Type.Optional(Type.Literal(value));
var nullableString = () => Type.Union([Type.String(), Type.Null()]);
var optionalNullableString = () => Type.Optional(nullableString());
var optionalStringArray = () => Type.Optional(Type.Array(Type.String()));
var optionalNullableInteger = () => Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]));
var channelSchema = Type.Object({
  kind: Type.Optional(Type.String()),
  id: optionalNullableString(),
  thread_id: optionalNullableString()
});
var runtimeSchema = Type.Object({
  name: Type.Optional(Type.String()),
  version: optionalNullableString()
});
var entitiesSchema = Type.Object({
  people: optionalStringArray(),
  orgs: optionalStringArray(),
  repos: optionalStringArray(),
  files: optionalStringArray(),
  customers: optionalStringArray(),
  topics: optionalStringArray()
});
var recallParameters = Type.Object({
  schema_version: schemaVersion("openbrain.openclaw.recall.v1"),
  project_id: optionalNullableString(),
  task_id: optionalNullableString(),
  flow_id: optionalNullableString(),
  task_type: optionalNullableString(),
  channel: Type.Optional(channelSchema),
  runtime: Type.Optional(runtimeSchema),
  model_intent: Type.Optional(Type.Object({
    provider: optionalNullableString(),
    model: optionalNullableString()
  })),
  query: Type.String(),
  entities: Type.Optional(entitiesSchema),
  scope: Type.Optional(Type.Object({
    visibility: optionalNullableString(),
    project_only: Type.Optional(Type.Boolean()),
    include_unconfirmed: Type.Optional(Type.Boolean()),
    include_stale: Type.Optional(Type.Boolean())
  })),
  limits: Type.Optional(Type.Object({
    max_items: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    max_tokens: Type.Optional(Type.Integer({ minimum: 256, maximum: 2e4 })),
    recency_days: optionalNullableInteger()
  })),
  sensitivity: Type.Optional(Type.Object({
    contains_code: Type.Optional(Type.Boolean()),
    contains_customer_data: Type.Optional(Type.Boolean()),
    contains_private_meeting_data: Type.Optional(Type.Boolean())
  }))
});
var memoryPayloadSchema = Type.Object({
  decisions: optionalStringArray(),
  outputs: optionalStringArray(),
  lessons: optionalStringArray(),
  constraints: optionalStringArray(),
  unresolved_questions: optionalStringArray(),
  next_steps: optionalStringArray(),
  failures: optionalStringArray(),
  artifacts: Type.Optional(Type.Array(Type.Object({
    kind: Type.String(),
    uri: Type.String(),
    description: optionalNullableString()
  }))),
  entities: Type.Optional(entitiesSchema)
});
var writebackParameters = Type.Object({
  schema_version: schemaVersion("openbrain.openclaw.writeback.v1"),
  project_id: optionalNullableString(),
  task_id: optionalNullableString(),
  flow_id: optionalNullableString(),
  step_id: optionalNullableString(),
  idempotency_key: optionalNullableString(),
  content_hash: optionalNullableString(),
  channel: Type.Optional(channelSchema),
  runtime: Type.Optional(runtimeSchema),
  models_used: Type.Optional(Type.Array(Type.Object({
    provider: Type.String(),
    model: Type.String(),
    role: Type.String()
  }))),
  source_refs: Type.Optional(Type.Array(Type.Object({
    kind: Type.String(),
    uri: optionalNullableString(),
    title: optionalNullableString(),
    timestamp: optionalNullableString()
  }))),
  memory_payload: memoryPayloadSchema,
  provenance: Type.Optional(Type.Object({
    default_status: Type.Optional(Type.Union([
      Type.Literal("observed"),
      Type.Literal("inferred"),
      Type.Literal("user_confirmed"),
      Type.Literal("imported"),
      Type.Literal("generated")
    ])),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    requires_review: Type.Optional(Type.Boolean())
  })),
  retention: Type.Optional(Type.Object({
    ttl_days: optionalNullableInteger(),
    stale_after_days: optionalNullableInteger()
  })),
  visibility: Type.Optional(Type.Object({
    workspace: optionalNullableString(),
    project: optionalNullableString(),
    channel: optionalNullableString()
  }))
});

// src/index.ts
async function clientFromApi(api) {
  const raw = api.pluginConfig || {};
  if (typeof raw.endpoint !== "string" || raw.endpoint.length === 0) {
    throw new Error("OB1 Agent Memory plugin requires config.endpoint");
  }
  if (typeof raw.workspaceId !== "string" || raw.workspaceId.length === 0) {
    throw new Error("OB1 Agent Memory plugin requires config.workspaceId");
  }
  const accessKey = await resolveConfiguredSecretInputString({
    config: api.config || {},
    env: {},
    value: raw.accessKey,
    path: "plugins.entries.nbj-ob1-agent-memory.config.accessKey",
    unresolvedReasonStyle: "detailed"
  });
  if (!accessKey.value) {
    const reason = accessKey.unresolvedRefReason ? ` ${accessKey.unresolvedRefReason}` : "";
    throw new Error(`OB1 Agent Memory plugin requires config.accessKey.${reason}`);
  }
  const config = {
    endpoint: raw.endpoint,
    accessKey: accessKey.value,
    workspaceId: raw.workspaceId,
    projectId: typeof raw.projectId === "string" ? raw.projectId : void 0,
    requireReviewByDefault: typeof raw.requireReviewByDefault === "boolean" ? raw.requireReviewByDefault : true,
    includeUnconfirmedRecall: typeof raw.includeUnconfirmedRecall === "boolean" ? raw.includeUnconfirmedRecall : false
  };
  return new AgentMemoryClient(config);
}
function toolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ],
    details: value
  };
}
function registerTool(api, tool) {
  api.registerTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_id, params) {
      const result = await tool.run(await clientFromApi(api), params);
      return toolResult(result);
    }
  });
}
var index_default = definePluginEntry({
  id: "nbj-ob1-agent-memory",
  name: "NBJ OB1 Agent Memory for OpenClaw",
  description: "Recall and write governed Nate Jones OB1 memory from OpenClaw workflows.",
  kind: "memory",
  register(api) {
    registerTool(api, {
      name: "openbrain_recall",
      label: "NBJ OB1 recall",
      description: "Recall scoped Nate Jones OB1 Agent Memory before meaningful work begins.",
      parameters: recallParameters,
      run: (client, input) => client.recall(input)
    });
    registerTool(api, {
      name: "openbrain_writeback",
      label: "NBJ OB1 write-back",
      description: "Write compact, provenance-labeled Nate Jones OB1 Agent Memory after work finishes.",
      parameters: writebackParameters,
      run: (client, input) => client.writeback(input)
    });
    registerTool(api, {
      name: "openbrain_report_usage",
      label: "NBJ OB1 report usage",
      description: "Report which recalled memories were used or ignored.",
      parameters: Type2.Object({
        request_id: Type2.String(),
        used_memory_ids: Type2.Optional(Type2.Array(Type2.String())),
        ignored: Type2.Optional(Type2.Array(Type2.Object({
          memory_id: Type2.String(),
          reason: Type2.Optional(Type2.String())
        })))
      }),
      run: (client, input) => client.reportUsage(input.request_id, {
        used_memory_ids: input.used_memory_ids || [],
        ignored: input.ignored || []
      })
    });
    registerTool(api, {
      name: "openbrain_inspect_memory",
      label: "NBJ OB1 inspect memory",
      description: "Inspect one Nate Jones OB1 Agent Memory record, including provenance and source references.",
      parameters: Type2.Object({ memory_id: Type2.String() }),
      run: (client, input) => client.inspectMemory(input.memory_id)
    });
    registerTool(api, {
      name: "openbrain_list_review_queue",
      label: "NBJ OB1 review queue",
      description: "List agent-written memories pending human review.",
      parameters: Type2.Object({
        workspace_id: Type2.Optional(Type2.String()),
        project_id: Type2.Optional(Type2.String())
      }),
      run: (client, input) => client.listReviewQueue(input)
    });
    registerTool(api, {
      name: "openbrain_review_memory",
      label: "NBJ OB1 review memory",
      description: "Confirm, edit, evidence-only, restrict, stale, dispute, merge, supersede, or reject a memory. An edit gives content, summary or both; merge and supersede name related_memory_id; restrict_scope narrows to visibility.",
      parameters: Type2.Object({
        memory_id: Type2.String(),
        action: Type2.Union([
          Type2.Literal("confirm"),
          Type2.Literal("edit"),
          Type2.Literal("evidence_only"),
          Type2.Literal("restrict_scope"),
          Type2.Literal("mark_stale"),
          Type2.Literal("merge"),
          Type2.Literal("reject"),
          Type2.Literal("dispute"),
          Type2.Literal("supersede")
        ]),
        actor_label: Type2.Optional(Type2.String()),
        notes: Type2.Optional(Type2.String()),
        content: Type2.Optional(Type2.String()),
        summary: Type2.Optional(Type2.String()),
        visibility: Type2.Optional(Type2.Union([
          Type2.Literal("personal"),
          Type2.Literal("channel"),
          Type2.Literal("project"),
          Type2.Literal("workspace"),
          Type2.Literal("organization")
        ])),
        related_memory_id: Type2.Optional(Type2.String())
      }),
      run: (client, input) => {
        const { memory_id, ...body } = input;
        return client.reviewMemory(memory_id, body);
      }
    });
    registerTool(api, {
      name: "openbrain_get_recall_trace",
      label: "NBJ OB1 recall trace",
      description: "Fetch a recall trace to debug which memories were returned and used.",
      parameters: Type2.Object({ request_id: Type2.String() }),
      run: (client, input) => client.getRecallTrace(input.request_id)
    });
    const OB1_TOOL_NAMES = [
      "openbrain_recall",
      "openbrain_writeback",
      "openbrain_report_usage",
      "openbrain_inspect_memory",
      "openbrain_list_review_queue",
      "openbrain_review_memory",
      "openbrain_get_recall_trace"
    ];
    function isConfigured() {
      const raw = api.pluginConfig || {};
      return typeof raw.endpoint === "string" && raw.endpoint.length > 0 && typeof raw.workspaceId === "string" && raw.workspaceId.length > 0;
    }
    if (typeof api.registerMemoryPromptSupplement === "function") {
      api.registerMemoryPromptSupplement((params) => {
        if (!isConfigured()) return [];
        const present = OB1_TOOL_NAMES.filter((t) => params.availableTools.has(t));
        if (present.length === 0) return [];
        return [
          "## OB1 Agent Memory",
          "Long-term governed memory is available via OB1. Use it as a discipline, not a fallback.",
          "",
          "Workflow:",
          "- Before meaningful work, call `openbrain_recall` with a task-scoped query.",
          "- Treat returned memories tagged `instruction` as binding rules; `evidence`-tagged ones as supporting context only.",
          "- After meaningful work, call `openbrain_writeback` with compact, provenance-labeled findings (decisions, lessons, constraints, outputs, failures).",
          "- After acting on recalled memories, call `openbrain_report_usage` with `request_id` and the IDs you used vs. ignored \u2014 closes the recall-quality loop.",
          "",
          `Available tools: ${present.map((t) => "`" + t + "`").join(", ")}.`
        ];
      });
    }
    if (typeof api.registerMemoryCorpusSupplement === "function") {
      api.registerMemoryCorpusSupplement({
        async search(input) {
          if (!isConfigured()) return [];
          let client;
          try {
            client = await clientFromApi(api);
          } catch {
            return [];
          }
          const limit = Math.min(Math.max(input.maxResults ?? 10, 1), 50);
          let response;
          try {
            response = await client.recall({
              query: input.query.slice(0, 2e3),
              task_type: "general",
              limits: { max_items: limit, max_tokens: 4e3 },
              scope: { project_only: false, include_unconfirmed: false, include_stale: false }
            });
          } catch {
            return [];
          }
          return corpusHits(response);
        },
        async get(input) {
          if (!isConfigured()) return null;
          const id = input.lookup.replace(/^openbrain:\/\/memory\//, "");
          if (!id) return null;
          let client;
          try {
            client = await clientFromApi(api);
          } catch {
            return null;
          }
          let answer;
          try {
            answer = await client.inspectMemory(id);
          } catch {
            return null;
          }
          return corpusDocument(answer, input.lookup, id);
        }
      });
    }
  }
});
export {
  index_default as default
};
