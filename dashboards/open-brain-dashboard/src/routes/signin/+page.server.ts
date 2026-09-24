import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';
import { listTools, mcpUrl, McpUnauthorized, McpUnreachable } from '$lib/server/mcp';
import { cookieOptions, seal, SESSION_COOKIE, SESSION_MAX_AGE, sessionSecret } from '$lib/server/session';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.session) {
		throw redirect(302, '/');
	}
	return {};
};

export const actions: Actions = {
	// The access key is checked against the server before anything is stored:
	// tools/list under that key. A refusal is the server's (401 here, with its
	// reason); what the list names decides whether the capture form is shown.
	default: async ({ request, cookies, url }) => {
		const form = await request.formData();
		const key = String(form.get('key') ?? '').trim();
		if (!key) return fail(400, { error: 'Paste an access key.' });

		let tools: string[];
		try {
			tools = await listTools(mcpUrl(env), key);
		} catch (err) {
			if (err instanceof McpUnauthorized) return fail(401, { error: 'The server refused that access key.' });
			// This page answers strangers: the detail (a host name the resolver could
			// not find, an upstream body) is the operator's, in the log, not the visitor's.
			console.error('[signin] tools/list failed:', err instanceof Error ? err.message : err);
			if (err instanceof McpUnreachable) return fail(502, { error: 'Could not reach the MCP server. Check MCP_URL and the server log.' });
			return fail(500, { error: 'Sign-in failed; the server log has the reason.' });
		}

		// The page reads before anything else: a key whose list has no thought_stats
		// — a capture-only key (SMD-1298), which may add a thought and nothing more —
		// would sign in to a page that cannot load (third review pass).
		if (!tools.includes('thought_stats')) {
			return fail(403, { error: 'This key cannot read: the dashboard needs a read- or write-scoped key. A capture-only key may add thoughts and nothing else.' });
		}
		const token = await seal({ key, canCapture: tools.includes('capture_thought') }, sessionSecret(env));
		// The one attribute set (session.ts): Secure follows the scheme, here and on every delete.
		cookies.set(SESSION_COOKIE, token, { ...cookieOptions(url), maxAge: SESSION_MAX_AGE });
		throw redirect(303, '/');
	},
};
