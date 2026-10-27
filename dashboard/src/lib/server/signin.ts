// Sign-in. By key (SMD-2280 PR 1): the visitor pastes an access key, the REST
// core's whoami says whose it is and what it may call, and a read or write key
// opens a session. Through the authorization server (SMD-3307): code with PKCE,
// the tokens held in the session (oauth.ts, routes/auth/).

import { env } from '$env/dynamic/private';
import { configuredIn } from '../../../../server-portable/oauth-edge.ts';
import { onBreakGlass } from './listener';

/**
 * Whether a request's listener offers key sign-in. Always while the stack is
 * not configured with the authorization server. While it is (COMPOSE_PROFILES
 * names auth, ADR decision 16), the origin never offers it, whether or not the
 * authorization server answers, since knocking it over must not open a weaker
 * door — sign-in there is by code and PKCE through the authorization server —
 * and only the break-glass port does, published on 127.0.0.1 alone, which no
 * tunnel points at (ADR decision 15; listener.ts, SMD-3307).
 */
export function keySignInOffered(request: Request, e: Record<string, string | undefined> = env): boolean {
	return !configuredIn(e.COMPOSE_PROFILES) || onBreakGlass(request);
}

/** What whoami answers: the key's name, its scope and the operations it may call. */
export type WhoAmI = { name: string; scope: string; operations: string[] };

export function whoAmI(body: unknown): WhoAmI | null {
	if (typeof body !== 'object' || body === null) return null;
	const b = body as Record<string, unknown>;
	if (typeof b.name !== 'string' || typeof b.scope !== 'string' || !Array.isArray(b.operations)) return null;
	if (!b.operations.every((o) => typeof o === 'string')) return null;
	return { name: b.name, scope: b.scope, operations: b.operations as string[] };
}

/** The operation every page reads first; a key without it — a capture-only key (SMD-1298) — could open no page. */
export const FIRST_READ = 'thought_stats';

/**
 * The words for a sign-in through the authorization server that came back
 * without a session (routes/auth/callback's `?refused=`), by the callback's own
 * word for why: never the AS's text, and nothing the address carries is echoed.
 */
export const REFUSED_WORDS: Record<string, string> = {
	denied: 'The sign-in was cancelled at the authorization server.',
	stale: 'That sign-in had expired, or was not started in this browser. Start again.',
	login: 'The authorization server did not ask the password for that sign-in. Start again.',
	refused: 'The authorization server refused the sign-in. The dashboard log has its reason.',
	unreachable: 'The authorization server or the brain did not answer the sign-in. Try again in a moment.',
	token: 'The brain refused the token the sign-in gave. The dashboard log has its answer.',
	cannot_read: 'The sign-in gave a token that cannot read, so it opens no dashboard.',
	not_configured: 'Sign-in through the authorization server is not set up for this dashboard.',
};
