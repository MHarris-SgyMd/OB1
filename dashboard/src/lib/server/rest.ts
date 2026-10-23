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

function restUrl(e: Record<string, string | undefined>): string {
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
		// A visitor who left aborted the call: nothing went wrong, and nobody reads the answer (review pass 4).
		if (!event.request.signal.aborted) console.error(`[dashboard] ${name}: the REST core did not answer: ${err instanceof Error ? err.message : String(err)}`);
		// A search by meaning waits on the embedding provider, whose own deadline (OB1_LLM_TIMEOUT, 120 s) outlasts this
		// one: a slow or silent provider is this page's timeout, before the core's exact-match answer (review pass 2;
		// the core's short-circuit is SMD-3205). Said, with the search that needs no provider.
		if (name === 'search_thoughts' && err instanceof Error && err.name === 'TimeoutError')
			throw error(504, `The brain did not answer within ${REST_TIMEOUT_MS / 1000} s. A search by meaning waits on the embedding provider, which may be slow or not answering; search by exact text, which needs none.`);
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
	// In words where they are known; the core's code otherwise, for the operator's log (review pass 6).
	if (answer.status === 404 && name === 'fetch') throw error(404, 'The brain holds no thought with that id.');
	const words = code ? REFUSAL_WORDS[code] : undefined;
	// A fault is not a refusal: a 5xx with a code says the brain could not answer (review pass 1).
	const said = code ? (answer.status >= 500 ? `The brain could not answer the read (${code}).` : `The brain refused the read (${code}).`) : `The brain answered ${answer.status}.`;
	throw error(answer.status, words ?? said);
}

/**
 * The refusals a visitor can act on, in words that say how (SMD-2280 PR 2a).
 * None quotes what was sent: a cursor or a query rides in the address or the
 * form, and the visitor already has it.
 */
const REFUSAL_WORDS: Record<string, string> = {
	// A browse link whose cursor the core does not read: altered, or made under the other order.
	REFUSED_CURSOR: 'That page link is not one the brain reads. Start the list again from its first page.',
	// The egress rules keep this key's query from the embedding provider (SMD-1903).
	REFUSED_EGRESS: "The brain's egress rules keep this query from the embedding provider. Search by exact text instead.",
};
