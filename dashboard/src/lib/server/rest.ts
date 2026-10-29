// The one place the GUI calls the brain: the REST core, through the typed
// client the MCP server uses (../rest-client, SMD-2287), with the signed-in
// visitor's own credential — their key, or the authorization server's token for
// them (SMD-3307) — never one of this server's, so what a page shows is what
// that credential may read. Server-only ($lib/server): SvelteKit refuses to
// bundle it into the browser.
//
// The GUI is a direct caller, so it sends no forwarder key: the audit row
// names the visitor's key alone.

import { env } from '$env/dynamic/private';
import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { base } from '$app/paths';
import { createRestClient, DEFAULT_REST_URL, type Answer, type CallableOperation, type InputOf, type Method, type RestClient } from '../../../../rest-client/index.ts';
import { createRenewer, createRevoker, oauthSettings, refreshTokens, RenewalFailed, revokeRefresh } from './oauth';
import { closeSession, cookieOptions, liveTokens, storeTokens, type Session } from './session';
import { authReachability } from '../../../../server-portable/oauth-edge.ts';

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
	const credential = await credentialOf(event, session);
	return bodyOf(name, await answered(event, name, () => rest().call(name, input, { ...credential, signal: event.request.signal })));
}

/**
 * The longest one write may take: a capture embeds its text and extracts its metadata, and an edit re-embeds, each
 * call to the provider bounded by OB1_LLM_TIMEOUT (120 s by default), so a page's 30 s would end most of them while
 * the core went on to save (SMD-3322 PR 2 review pass 1).
 */
export const WRITE_TIMEOUT_MS = 300_000;

let writer: RestClient | undefined;
/** The client for writes, as `rest()` but with WRITE_TIMEOUT_MS. */
function restForWrites(): RestClient {
	writer ??= createRestClient({ baseUrl: restUrl(env), timeoutMs: WRITE_TIMEOUT_MS });
	return writer;
}

/**
 * One write under the signed-in visitor's credential (SMD-3322): its answer for
 * the form action to read, so a refusal is said beside the form, not as the
 * page's error. A credential the REST core no longer takes ends the session, as
 * a read's does. A core that did not answer in time, or at all, is an answer
 * too — 504 `GUI_TIMEOUT`, which may still have been saved, or 502
 * `GUI_UNREACHABLE` — so the form keeps what the visitor typed (review pass 1).
 */
export async function write<K extends CallableOperation>(event: RequestEvent, session: Session, name: K, input: InputOf<K>): Promise<Answer> {
	const credential = await credentialOf(event, session);
	let answer: Answer;
	try {
		answer = await restForWrites().call(name, input, { ...credential, signal: event.request.signal });
	} catch (err) {
		// A visitor who left aborted the call: nobody reads the answer.
		if (event.request.signal.aborted) throw err;
		const timedOut = err instanceof Error && err.name === 'TimeoutError';
		console.error(`[dashboard] ${name}: the REST core did not answer${timedOut ? ` within ${WRITE_TIMEOUT_MS / 1000} s` : ''}: ${err instanceof Error ? err.message : String(err)}`);
		return { status: timedOut ? 504 : 502, ok: false, headers: new Headers(), body: { code: timedOut ? 'GUI_TIMEOUT' : 'GUI_UNREACHABLE' }, sent: timedOut };
	}
	if (answer.status === 401) signOutHere(event);
	return answer;
}

/** Whether the session's whoami named this operation at sign-in: what a page offers a write by (SMD-3322). The REST core still decides the call. */
export const may = (session: Session | null, name: CallableOperation): boolean => session?.operations.includes(name) === true;

/**
 * A plugin operation's read (SMD-2280 PR 3), by its tool and its route as its
 * manifest names them (`GET /v1/plugins/<name>/…`), under the visitor's key:
 * read's answer, read's refusals.
 */
export async function readPlugin(event: RequestEvent, session: Session, tool: string, method: Method, path: string, input: Record<string, unknown>): Promise<unknown> {
	return bodyOf(tool, await callPlugin(event, session, tool, method, path, input));
}

/** A plugin operation under the visitor's key, its answer for the caller to read: a form action says a refusal beside the form, not as the page's error. */
export async function callPlugin(event: RequestEvent, session: Session, tool: string, method: Method, path: string, input: Record<string, unknown>): Promise<Answer> {
	const credential = await credentialOf(event, session);
	return answered(event, tool, () => rest().callPath(method, path, input, { ...credential, signal: event.request.signal }));
}

/**
 * The sessions' token renewals (oauth.ts createRenewer): refreshed on the mesh
 * as the `gui` client, read from and written back to the session itself. An
 * AS its health probe found down (cached 30 s, 2 s at most) is no answer at
 * once, not a wait of the token call's 10 s on every page (review pass 1).
 */
const accessFor = createRenewer({
	refresh: async (refreshToken) => {
		const s = oauthSettings(env);
		if (!s) return { ok: false, refused: 'not_configured' };
		if (!(await authReachability().reachable())) return { ok: false, unreachable: true };
		return refreshTokens(s, refreshToken);
	},
	current: liveTokens,
	store: (id, tokens) => void storeTokens(id, tokens),
	close: (id) => void closeSession(id),
});

/** The revocations of tokens no session holds (oauth.ts createRevoker), on the mesh as the `gui` client; hooks.server.ts hands its `add` to the session store. */
export const revocations = createRevoker({
	revoke: (refresh) => {
		const s = oauthSettings(env);
		return s ? revokeRefresh(s, refresh) : Promise.resolve('refused');
	},
});

/**
 * What a call carries for the session: its key, or a token good for the next
 * minute at least — renewed with the refresh token first when it is not. A
 * renewal the AS refuses (the grant revoked, the chain past its 30 days) ends
 * the session, to /signin; one the AS does not answer is the page's 503.
 */
export async function credentialOf(event: RequestEvent, session: Session): Promise<{ key: string } | { token: string }> {
	if ('key' in session.credential) return { key: session.credential.key };
	try {
		return { token: await accessFor(session.id) };
	} catch (err) {
		if (!(err instanceof RenewalFailed)) throw err;
		console.error(`[dashboard] a session's renewal ${err.refused ? `was refused (${err.message}); it is ended` : 'got no answer from the authorization server'}`);
		if (err.refused) signOutHere(event);
		throw error(503, 'The authorization server did not answer, so this session could not be renewed. Try again in a moment.');
	}
}

/** Ends this request's session and sends the visitor to /signin. */
function signOutHere(event: RequestEvent): never {
	// Its tokens are revoked as it ends (session.ts onTokensEnded): a 401 from the REST core leaves a refresh token no session holds (review pass 2).
	closeSession(event.locals.session?.id);
	event.cookies.delete(event.locals.sessionCookie, cookieOptions(event.url, event.locals.breakglass));
	throw redirect(303, `${base}/signin`);
}

/** A call's answer: the page's 502 (or a slow search's 504) when the core did not answer, and /signin when it no longer takes the key. */
async function answered(event: RequestEvent, name: string, call: () => Promise<Answer>): Promise<Answer> {
	let answer: Answer;
	try {
		answer = await call();
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
	if (answer.status === 401) signOutHere(event);
	return answer;
}

/** A success's body, or the page's error for a refusal: in words where they are known, the core's code otherwise. */
function bodyOf(name: string, answer: Answer): unknown {
	if (answer.ok) return answer.body;
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
	// A start the change feed or the query log cannot read (SMD-2280 PR 2b).
	REFUSED_SINCE: 'That start is not a time the brain reads: give a time with its zone (2026-10-23T08:00:00Z), a date (2026-10-23), or for changes the cursor a page ended with.',
	// The egress rules keep this key's query from the embedding provider (SMD-1903).
	REFUSED_EGRESS: "The brain's egress rules keep this query from the embedding provider. Search by exact text instead.",
};
