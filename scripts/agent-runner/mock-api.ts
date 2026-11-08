/**
 * mock-api.ts — a scripted stand-in for the Messages API on loopback (SMD-4088), for the probes. Claude Code reaches it
 * through ANTHROPIC_BASE_URL, and each turn of the session's main loop it answers with the next step of a script: a
 * tool call, or text that ends the turn. So a probe makes exactly the call it tests, on the pinned Claude Code, with no
 * model and no spend: the profile's layers are Claude Code's, and what a model would ask for is the script.
 *
 * It records each request's system prompt and messages, so a probe can check what the session loaded (a CLAUDE.md,
 * a skill) and what each call returned. A request without the probe's stand-in key is counted and refused, never
 * answered, and no header is ever recorded.
 */

/** One step of a script: a tool call with its input, or text that ends the turn. */
export type Step = { tool: string; input: Record<string, unknown> } | { text: string };

/** A request the mock answered: whether it was the main loop (it carried tools), its system prompt as text, and its messages. */
export type Recorded = { main: boolean; system: string; messages: unknown[]; model: unknown };

export type Mock = { url: string; requests: Recorded[]; wrongKey: () => number; stop: () => void };

/** The id the mock gives the call it makes as step `n` of its script. */
export const callId = (n: number): string => `toolu_probe_${n}`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A system prompt, as the API takes it (a string or text blocks), as text. */
export function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((b) => (isObject(b) && typeof b.text === "string" ? b.text : "")).join("\n");
  return "";
}

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

/** One assistant message, as the API sends it: a stream of server-sent events, or one JSON body. */
export function reply(blocks: Block[], stop: "end_turn" | "tool_use", model: unknown, stream: boolean): Response {
  const id = `msg_probe_${crypto.randomUUID().replaceAll("-", "")}`;
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!stream) return Response.json({ id, type: "message", role: "assistant", model, content: blocks, stop_reason: stop, stop_sequence: null, usage });
  const events: [string, unknown][] = [["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }]];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream", "request-id": "req_probe" } });
}

/**
 * Starts the mock. The main loop's step is the number of assistant messages the request already carries, so a retried
 * request gets the same step; past the script's end it says "done" and ends the turn. A request with no tools (one of
 * Claude Code's side calls) gets "ok".
 */
export function startMock(script: Step[], key: string): Mock {
  const requests: Recorded[] = [];
  let wrong = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.headers.get("x-api-key") !== key) {
        wrong++;
        return Response.json({ type: "error", error: { type: "authentication_error", message: "the probe's mock takes the probe's stand-in key alone" } }, { status: 401 });
      }
      const url = new URL(req.url);
      if (req.method !== "POST") return new Response("not found", { status: 404 });
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = await req.json();
        if (!isObject(parsed)) throw new Error("not an object");
        body = parsed;
      } catch {
        return new Response("not JSON", { status: 400 });
      }
      if (url.pathname === "/v1/messages/count_tokens") return Response.json({ input_tokens: 10 });
      if (url.pathname !== "/v1/messages") return new Response("not found", { status: 404 });
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const main = Array.isArray(body.tools) && body.tools.length > 0;
      requests.push({ main, system: systemText(body.system), messages, model: body.model });
      const stream = body.stream === true;
      if (!main) return reply([{ type: "text", text: "ok" }], "end_turn", body.model, stream);
      const taken = messages.filter((m) => isObject(m) && m.role === "assistant").length;
      const step = script[taken];
      if (step === undefined) return reply([{ type: "text", text: "done" }], "end_turn", body.model, stream);
      if ("text" in step) return reply([{ type: "text", text: step.text }], "end_turn", body.model, stream);
      return reply([{ type: "tool_use", id: callId(taken), name: step.tool, input: step.input }], "tool_use", body.model, stream);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, wrongKey: () => wrong, stop: () => server.stop(true) };
}

/** Every text a request carried, its system prompt and messages, as one string to search for a marker. */
export function requestText(r: Recorded): string {
  return `${r.system}\n${JSON.stringify(r.messages)}`;
}
