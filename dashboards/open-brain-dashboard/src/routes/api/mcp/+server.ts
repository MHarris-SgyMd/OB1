import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { callTool, mcpUrl, McpUnauthorized, McpUnreachable } from '$lib/server/mcp';
import { cookieOptions, SESSION_COOKIE } from '$lib/server/session';

// The browser's one door to the brain: a tool call, forwarded with the
// visitor's own key (from the sealed cookie, never from this server's env), so
// what the dashboard may do is what that key may do. A read key is refused
// capture here, before the server is asked — the server would refuse too (the
// tool is not registered for it), but the visitor should be told why. A tool
// result the server marks isError — a tool this key was not given, an id that
// does not exist — is 422 with the tool's text, not a 200 the page would read
// as data (first review pass: an unknown tool rendered as "Total thoughts: 0").
export const POST: RequestHandler = async ({ request, locals, cookies, url }) => {
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
		const result = await callTool(mcpUrl(env), session.key, name, args);
		if (result?.isError) return json({ error: result.content?.[0]?.text || 'The tool refused the call' }, { status: 422 });
		return json({ result });
	} catch (err) {
		if (err instanceof McpUnauthorized) {
			// Revoked since sign-in: the cookie is no longer a session.
			cookies.delete(SESSION_COOKIE, cookieOptions(url));
			return json({ error: err.message }, { status: 401 });
		}
		if (err instanceof McpUnreachable) return json({ error: err.message }, { status: 502 });
		return json({ error: err instanceof Error ? err.message : 'Unknown proxy error' }, { status: 502 });
	}
};
