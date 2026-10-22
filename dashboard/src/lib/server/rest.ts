// The one place the GUI calls the brain: the REST core, through the typed
// client the MCP server uses (../rest-client, SMD-2287), with the signed-in
// visitor's own key — never one of this server's — so what a page shows is
// what that key may read. Server-only ($lib/server): SvelteKit refuses to
// bundle it into the browser.
//
// The GUI is a direct caller, so it sends no forwarder key: the audit row
// names the visitor's key alone.

import { env } from '$env/dynamic/private';
import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { base } from '$app/paths';
import { createRestClient, DEFAULT_REST_URL, type Answer, type CallableOperation, type InputOf, type RestClient } from '../../../../rest-client/index.ts';
import { closeSession, cookieOptions, SESSION_COOKIE, type Session } from './session';

/** The longest one call may take: a page waits on it, so well under a minute. */
export const REST_TIMEOUT_MS = 30_000;

let client: RestClient | undefined;
/** The client, built at the first call from OB1_REST_URL (the mesh's REST core unless set); a base it refuses throws there, and serve.ts checks it at the start. */
export function rest(): RestClient {
	client ??= createRestClient({ baseUrl: restUrl(env), timeoutMs: REST_TIMEOUT_MS });
	return client;
}

export function restUrl(e: Record<string, string | undefined>): string {
	return e.OB1_REST_URL?.trim() || DEFAULT_REST_URL;
}

/** A refusal's code, when the REST core gave one. */
export function codeOf(body: unknown): string | undefined {
	return typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : undefined;
}

/**
 * One read under the signed-in visitor's key: its body on success. A key the
 * REST core no longer takes (revoked since sign-in) ends the session and sends
 * the visitor to /signin; any other refusal is the page's error with the
 * status the core gave and its code, never its words — this page answers
 * whoever holds the cookie, and the words are the operator's, in the log.
 */
export async function read<K extends CallableOperation>(event: RequestEvent, session: Session, name: K, input: InputOf<K>): Promise<unknown> {
	let answer: Answer;
	try {
		answer = await rest().call(name, input, { key: session.key, signal: event.request.signal });
	} catch (err) {
		console.error(`[dashboard] ${name}: the REST core did not answer: ${err instanceof Error ? err.message : String(err)}`);
		throw error(502, 'The brain did not answer. The dashboard log has the reason.');
	}
	if (answer.ok) return answer.body;
	if (answer.status === 401) {
		closeSession(event.cookies.get(SESSION_COOKIE));
		event.cookies.delete(SESSION_COOKIE, cookieOptions(event.url));
		throw redirect(303, `${base}/signin`);
	}
	const code = codeOf(answer.body);
	if (answer.status >= 500) console.error(`[dashboard] ${name}: ${answer.status} ${code ?? ''}`.trimEnd());
	throw error(answer.status, code ? `The brain refused: ${code}` : `The brain answered ${answer.status}`);
}
