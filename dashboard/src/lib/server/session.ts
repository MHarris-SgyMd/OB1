// The signed-in state, held on the server (SMD-2280). The browser holds one
// httpOnly cookie carrying a random session id and nothing else: the access key
// the visitor typed at /signin, or the tokens the authorization server issued
// at a sign-in through it (SMD-3307), and what the REST core said they may do,
// stay in this process's memory, so no credential nor anything sealed from one
// reaches the browser (the ADR's "tokens live in the sealed server-side session and
// never reach the browser", docs/operator-surface-tiers.md, Identity). The
// SvelteKit dashboard before it sealed the key into the cookie under a
// SESSION_SECRET; here there is no secret to provision, and sign-out ends the
// session on the server, not only in the browser.
//
// The cost: a restart of the service signs every visitor out. One process
// serves the GUI, so one map is the whole store.

import { base } from '$app/paths';
import { withOriginPort } from './listener';
import type { Tokens } from './oauth';

// The cookie's name is its listener's: listener.ts sessionCookieName (SMD-3307).
/** A day, as the SvelteKit dashboard's cookie. */
export const SESSION_MAX_AGE = 60 * 60 * 24;
/** The most sessions held at once: the oldest goes when a sign-in would pass it, so a flood of sign-ins holds at most this many keys in memory. */
export const MAX_SESSIONS = 1000;
/**
 * The most one key holds — or one principal the authorization server signed in,
 * `oauth:<sub>+<client>` — a sign-in past it ends that holder's oldest session, not
 * another's, so one key signed in over and over cannot push every other
 * visitor out of MAX_SESSIONS (review pass 1). Only sessions under fifty or more
 * keys reach the global cap. Two sign-ins posted at once over one cookie each
 * open a session, and the browser keeps one: the other is bounded by this cap
 * and the day, not by sign-out (review pass 2, accepted).
 */
export const MAX_PER_KEY = 20;

/** What the session calls the REST core with: an access key (sent as x-brain-key), or the AS's tokens (the access token sent as a bearer, renewed by the refresh token). */
export type Credential = { key: string } | { tokens: Tokens };

export type Session = {
	/** The session's id, the cookie's value: what a renewal writes the new tokens back under. */
	id: string;
	credential: Credential;
	/** The holder's name and scope, as the REST core's whoami said at sign-in (`oauth:operator+gui` for a token, SMD-3064). */
	name: string;
	scope: string;
	/** Whether whoami named capture_thought among the holder's operations — false for a read key. */
	canCapture: boolean;
	/** The operations whoami named at sign-in: a page offers a write only where they list it (SMD-3322); the REST core still decides each call. */
	operations: readonly string[];
	/** Whether it was signed in on the break-glass listener (SMD-3307): it opens pages there alone (hooks.server.ts). */
	breakglass: boolean;
};

type Held = Omit<Session, 'id'> & { exp: number };

/** Who a session counts against for MAX_PER_KEY: its key, or the subject its tokens name. */
const holderOf = (s: Omit<Session, 'id'>) => ('key' in s.credential ? `key ${s.credential.key}` : `token ${s.name}`);

/** Session id → session, in insertion order, which is sign-in order: the first entry is the oldest. */
const sessions = new Map<string, Held>();

/**
 * The one set of attributes for the session cookie, for the set at sign-in and
 * every delete: scoped to the GUI's path, so it rides no other route on the
 * shared origin (/mcp, /auth, /grafana); httpOnly; Secure where the origin is
 * https — a browser refuses a Secure cookie from a plain-HTTP origin, and a
 * delete with the wrong attributes never lands (the SvelteKit dashboard's
 * first review pass). Never Secure on the break-glass listener, plain HTTP on
 * 127.0.0.1 whatever origin the GUI is configured with (SMD-3307).
 */
export function cookieOptions(url: URL, breakglass = false) {
	return { path: base || '/', httpOnly: true, sameSite: 'lax' as const, secure: !breakglass && url.protocol === 'https:' };
}

function newId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The AS's tokens a session held, if it held any. */
const tokensOf = (held: Held | undefined) => (held && 'tokens' in held.credential ? held.credential.tokens : null);

let tokensEnded: (t: Tokens) => void = () => {};
/**
 * What is done with tokens no session holds any more: revoked at the AS
 * (hooks.server.ts hands in oauth.ts createRevoker's add). Every way a token
 * session leaves the store goes through `drop` — signed out, evicted, found
 * expired, ended by a refusal — and a renewal stored after its session ended
 * comes here too, so no ending is a call site's to remember (review pass 3,
 * after passes 1 and 2 each found endings that left a grant live).
 */
export function onTokensEnded(fn: (t: Tokens) => void) {
	tokensEnded = fn;
}

function drop(id: string): Held | undefined {
	const held = sessions.get(id);
	sessions.delete(id);
	const t = tokensOf(held);
	if (t) tokensEnded(t);
	return held;
}

/** A new session, its id the cookie's value; the sessions it ends to make room, or finds expired, go through `drop`. */
export function openSession(session: Omit<Session, 'id'>): string {
	const now = Date.now();
	const own: string[] = [];
	const holder = holderOf(session);
	for (const [id, held] of sessions) {
		if (held.exp <= now) drop(id);
		else if (holderOf(held) === holder) own.push(id);
	}
	while (own.length >= MAX_PER_KEY) drop(own.shift()!);
	while (sessions.size >= MAX_SESSIONS) drop(sessions.keys().next().value!);
	const id = newId();
	sessions.set(id, { ...session, exp: now + SESSION_MAX_AGE * 1000 });
	return id;
}

/** A session's tokens as they are now — renewed, or the session ended (null) — for the renewer, which must never act on a copy (oauth.ts createRenewer). */
export function liveTokens(id: string): Tokens | null {
	const held = sessions.get(id);
	return held && held.exp > Date.now() ? tokensOf(held) : null;
}

/** The session an id names, or null for one it does not: unknown, ended or expired. */
export function readSession(id: string | undefined): Session | null {
	if (!id) return null;
	const held = sessions.get(id);
	if (!held) return null;
	// An expired session is left for the caller to close (hooks.server.ts), which revokes its tokens (review pass 2).
	if (held.exp <= Date.now()) return null;
	return { id, credential: held.credential, name: held.name, scope: held.scope, canCapture: held.canCapture, operations: held.operations, breakglass: held.breakglass };
}

/** A renewal's new tokens, written back to the session that holds them; false, and the tokens revoked, when the session has ended meanwhile. */
export function storeTokens(id: string, tokens: Tokens): boolean {
	const held = sessions.get(id);
	if (!held || !('tokens' in held.credential)) {
		tokensEnded(tokens);
		return false;
	}
	held.credential = { tokens };
	return true;
}

/** Ends a session — sign-out, or a credential the REST core or the AS no longer takes — and says what it held; its tokens, if any, are revoked (`drop`). */
export function closeSession(id: string | undefined): Credential | null {
	if (!id) return null;
	return drop(id)?.credential ?? null;
}

// --- sign-ins through the authorization server, between the redirect and the callback ---

/**
 * The cookie binding a sign-in in flight to the browser that started it: the callback takes the AS's answer only
 * with it (no login CSRF). Its name carries the origin's port when the origin names one, as the session cookie's
 * does (listener.ts withOriginPort, SMD-3352).
 */
export const signInCookieName = (url: URL) => withOriginPort('ob1_dashboard_signin', url);
/** As long as the AS keeps a sign-in open (deploy/auth/server.ts, ttl.Interaction; oauth.ts SIGNIN_MS). */
export const SIGNIN_MAX_AGE = 600;
/** Answers taken, remembered so each is taken once: the oldest forgotten past it. Only a callback that carries its own browser's state adds one. */
export const MAX_SPENT = 1000;

const spent = new Map<string, number>();

/**
 * Whether a sign-in's answer is taken for the first time: true once per state,
 * false after — a callback replayed from its own browser, its cookie put back,
 * is turned away before the AS is asked, while the state is among the last
 * MAX_SPENT taken. Past that bound the AS's own single-use code refuses it
 * (and revokes what the code granted); only the browser holding the sign-in's
 * binding can present it at all (oauth.ts signInFrom, review pass 2). A start
 * holds nothing here, so a flood of starts crowds nothing out (review pass 1).
 */
export function spendSignIn(state: string): boolean {
	const now = Date.now();
	for (const [st, exp] of spent) if (exp <= now) spent.delete(st);
	if (spent.has(state)) return false;
	while (spent.size >= MAX_SPENT) spent.delete(spent.keys().next().value!);
	spent.set(state, now + SIGNIN_MAX_AGE * 1000);
	return true;
}

/** The sign-in cookie's attributes: the GUI's auth paths alone, so it rides nothing else. */
export function signInCookieOptions(url: URL) {
	return { ...cookieOptions(url), path: `${base}/auth` };
}
