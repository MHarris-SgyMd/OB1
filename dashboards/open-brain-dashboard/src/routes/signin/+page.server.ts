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
			if (err instanceof McpUnreachable) return fail(502, { error: `${err.message}. Check MCP_URL.` });
			return fail(500, { error: err instanceof Error ? err.message : 'Sign-in failed.' });
		}

		const token = await seal({ key, canCapture: tools.includes('capture_thought') }, sessionSecret(env));
		// The one attribute set (session.ts): Secure follows the scheme, here and on every delete.
		cookies.set(SESSION_COOKIE, token, { ...cookieOptions(url), maxAge: SESSION_MAX_AGE });
		throw redirect(303, '/');
	},
};
