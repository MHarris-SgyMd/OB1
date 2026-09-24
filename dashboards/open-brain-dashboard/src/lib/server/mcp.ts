// The one place this dashboard speaks MCP: a JSON-RPC POST to MCP_URL with the
// visitor's key as x-brain-key (the header SETUP.md gives every client; the
// query form the proxy used to send lands in access logs). Server-only.
//
// The core server (server-portable) answers a wrong key with HTTP 200 and a
// JSON-RPC error, code -32001, so strict MCP hosts keep the connection; the
// vendored servers answer a bare 401. Both read as `unauthorized` here.

export type McpToolResult = { content: { type: string; text: string }[]; isError?: boolean };

type JsonRpcResponse = {
	result?: unknown;
	error?: { code?: number; message?: string };
};

const UNAUTHORIZED_CODE = -32001;

export class McpUnauthorized extends Error {
	constructor() {
		super('The server refused that access key');
		this.name = 'McpUnauthorized';
	}
}

export class McpUnreachable extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'McpUnreachable';
	}
}

/** MCP_URL, or a clear refusal — the value is the operator's, not the visitor's. */
export function mcpUrl(env: Record<string, string | undefined>): string {
	const url = env.MCP_URL;
	if (!url) throw new Error('MCP_URL is not set: the URL your Open Brain server answers MCP on (SETUP.md; http://127.0.0.1:8000/ for the compose stack)');
	return url;
}

/**
 * Raw JSON, or an SSE frame — the two shapes the transport answers with. In a
 * frame, the `data:` line whose `id` is the request's; a server that streams a
 * notification after the response would otherwise be read by its last line
 * (first review pass). The last parseable line when none carries the id.
 */
function parseBody(body: string, id: number): JsonRpcResponse {
	const trimmed = body.trim();
	if (!trimmed) return {};
	if (trimmed.startsWith('{')) return JSON.parse(trimmed) as JsonRpcResponse;
	const frames: (JsonRpcResponse & { id?: unknown })[] = [];
	for (const line of trimmed.split('\n')) {
		const t = line.trim();
		if (!t.startsWith('data:')) continue;
		const data = t.slice(5).trim();
		if (!data || data === '[DONE]') continue;
		try {
			frames.push(JSON.parse(data) as JsonRpcResponse & { id?: unknown });
		} catch {
			continue;
		}
	}
	const answer = frames.find((f) => f.id === id) ?? frames.at(-1);
	if (!answer) throw new McpUnreachable('Unable to parse the MCP response');
	return answer;
}

export async function rpc(url: string, key: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
	const id = Date.now();
	let upstream: Response;
	try {
		upstream = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				'x-brain-key': key,
			},
			body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
		});
	} catch (err) {
		throw new McpUnreachable(`Could not reach the MCP server: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (upstream.status === 401) throw new McpUnauthorized();
	if (!upstream.ok) {
		const text = await upstream.text().catch(() => '');
		throw new McpUnreachable(`MCP upstream HTTP ${upstream.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
	}
	const parsed = parseBody(await upstream.text(), id);
	if (parsed.error) {
		if (parsed.error.code === UNAUTHORIZED_CODE) throw new McpUnauthorized();
		throw new Error(parsed.error.message || 'MCP error');
	}
	return parsed.result ?? null;
}

/** The tool names this key sees — a read key's list has no capture_thought. */
export async function listTools(url: string, key: string): Promise<string[]> {
	const result = (await rpc(url, key, 'tools/list')) as { tools?: { name: string }[] } | null;
	return (result?.tools ?? []).map((t) => t.name);
}

export async function callTool(url: string, key: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
	return (await rpc(url, key, 'tools/call', { name, arguments: args })) as McpToolResult;
}
