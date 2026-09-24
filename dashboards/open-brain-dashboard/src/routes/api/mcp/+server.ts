import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { callTool, mcpUrl, McpUnauthorized, McpUnreachable } from '$lib/server/mcp';
import { SESSION_COOKIE } from '$lib/server/session';

// The browser's one door to the brain: a tool call, forwarded with the
// visitor's own key (from the sealed cookie, never from this server's env), so
// what the dashboard may do is what that key may do. A read key is refused
// capture here, before the server is asked — the server would refuse too (the
// tool is not registered for it), but the visitor should be told why.
export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	const session = locals.session;
	if (!session) return json({ error: 'Unauthorized' }, { status: 401 });

	let payload: { name?: unknown; args?: unknown };
	try {
		payload = (await request.json()) as { name?: unknown; args?: unknown };
	} catch {
		return json({ error: 'Body must be JSON' }, { status: 400 });
	}
	const name = typeof payload.name === 'string' ? payload.name : '';
	if (!name) return json({ error: 'Missing tool name' }, { status: 400 });
	const args = payload.args && typeof payload.args === 'object' ? (payload.args as Record<string, unknown>) : {};

	if (name === 'capture_thought' && !session.canCapture) {
		return json({ error: 'This key is read-scoped: it cannot capture' }, { status: 403 });
	}

	try {
		return json({ result: await callTool(mcpUrl(env), session.key, name, args) });
	} catch (err) {
		if (err instanceof McpUnauthorized) {
			// Revoked since sign-in: the cookie is no longer a session.
			cookies.delete(SESSION_COOKIE, { path: '/' });
			return json({ error: err.message }, { status: 401 });
		}
		if (err instanceof McpUnreachable) return json({ error: err.message }, { status: 502 });
		return json({ error: err instanceof Error ? err.message : 'Unknown proxy error' }, { status: 502 });
	}
};
