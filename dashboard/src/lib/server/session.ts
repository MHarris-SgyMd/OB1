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
import type { Tokens } from './oauth';

export const SESSION_COOKIE = 'ob1_dashboard_session';
/** A day, as the SvelteKit dashboard's cookie. */
export const SESSION_MAX_AGE = 60 * 60 * 24;
/** The most sessions held at once: the oldest goes when a sign-in would pass it, so a flood of sign-ins holds at most this many keys in memory. */
export const MAX_SESSIONS = 1000;
/**
 * The most one key holds — or one subject the authorization server signed in,
 * `oauth:<sub>` — a sign-in past it ends that holder's oldest session, not
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
	/** The holder's name and scope, as the REST core's whoami said at sign-in (`oauth:<sub>` for a token). */
	name: string;
	scope: string;
	/** Whether whoami named capture_thought among the holder's operations — false for a read key. */
	canCapture: boolean;
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
 * first review pass).
 */
export function cookieOptions(url: URL) {
	return { path: base || '/', httpOnly: true, sameSite: 'lax' as const, secure: url.protocol === 'https:' };
}

function newId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A new session, its id the cookie's value. */
export function openSession(session: Omit<Session, 'id'>): string {
	const now = Date.now();
	const own: string[] = [];
	const holder = holderOf(session);
	for (const [id, held] of sessions) {
		if (held.exp <= now) sessions.delete(id);
		else if (holderOf(held) === holder) own.push(id);
	}
	while (own.length >= MAX_PER_KEY) sessions.delete(own.shift()!);
	while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
	const id = newId();
	sessions.set(id, { ...session, exp: now + SESSION_MAX_AGE * 1000 });
	return id;
}

/** The session an id names, or null for one it does not: unknown, ended or expired. */
export function readSession(id: string | undefined): Session | null {
	if (!id) return null;
	const held = sessions.get(id);
	if (!held) return null;
	if (held.exp <= Date.now()) {
		sessions.delete(id);
		return null;
	}
	return { id, credential: held.credential, name: held.name, scope: held.scope, canCapture: held.canCapture };
}

/** A renewal's new tokens, written back to the session that holds them; false when the session has ended meanwhile. */
export function storeTokens(id: string, tokens: Tokens): boolean {
	const held = sessions.get(id);
	if (!held || !('tokens' in held.credential)) return false;
	held.credential = { tokens };
	return true;
}

/** Ends a session — sign-out, or a credential the REST core or the AS no longer takes — and hands back what it held, for sign-out to revoke. */
export function closeSession(id: string | undefined): Credential | null {
	if (!id) return null;
	const held = sessions.get(id);
	sessions.delete(id);
	return held?.credential ?? null;
}

// --- sign-ins through the authorization server, between the redirect and the callback ---

/** The cookie binding a sign-in in flight to the browser that started it: the callback takes the AS's answer only with it (no login CSRF). */
export const SIGNIN_COOKIE = 'ob1_dashboard_signin';
/** As long as the AS keeps a sign-in open (deploy/auth/server.ts, ttl.Interaction). */
export const SIGNIN_MAX_AGE = 600;
/** Sign-ins in flight held at once: the oldest goes past it, so a flood of starts holds this many verifiers at most. */
export const MAX_SIGNINS = 1000;

const signins = new Map<string, { verifier: string; exp: number }>();

/** A sign-in started: its state and the PKCE verifier its challenge came from. */
export function holdSignIn(state: string, verifier: string): void {
	const now = Date.now();
	for (const [s, held] of signins) if (held.exp <= now) signins.delete(s);
	while (signins.size >= MAX_SIGNINS) signins.delete(signins.keys().next().value!);
	signins.set(state, { verifier, exp: now + SIGNIN_MAX_AGE * 1000 });
}

/** The verifier for a state, once: a second answer with the same state finds nothing. */
export function takeSignIn(state: string | null | undefined): string | null {
	if (!state) return null;
	const held = signins.get(state);
	signins.delete(state);
	return held && held.exp > Date.now() ? held.verifier : null;
}

/** The sign-in cookie's attributes: the GUI's auth paths alone, so it rides nothing else. */
export function signInCookieOptions(url: URL) {
	return { ...cookieOptions(url), path: `${base}/auth` };
}
