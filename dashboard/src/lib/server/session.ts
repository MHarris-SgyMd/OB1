// The signed-in state, held on the server (SMD-2280). The browser holds one
// httpOnly cookie carrying a random session id and nothing else: the access key
// the visitor typed at /signin, and what the REST core said it may do, stay in
// this process's memory, so neither the key nor anything sealed from it reaches
// the browser (the ADR's "tokens live in the sealed server-side session and
// never reach the browser", docs/operator-surface-tiers.md, Identity). The
// SvelteKit dashboard before it sealed the key into the cookie under a
// SESSION_SECRET; here there is no secret to provision, and sign-out ends the
// session on the server, not only in the browser.
//
// The cost: a restart of the service signs every visitor out. One process
// serves the GUI, so one map is the whole store.

import { base } from '$app/paths';

export const SESSION_COOKIE = 'ob1_dashboard_session';
/** A day, as the SvelteKit dashboard's cookie. */
export const SESSION_MAX_AGE = 60 * 60 * 24;
/** The most sessions held at once: the oldest goes when a sign-in would pass it, so a flood of sign-ins holds at most this many keys in memory. */
export const MAX_SESSIONS = 1000;

export type Session = {
	/** The access key, sent as x-brain-key on every call to the REST core. */
	key: string;
	/** The key's name and scope, as the REST core's whoami said at sign-in. */
	name: string;
	scope: string;
	/** Whether whoami named capture_thought among the key's operations — false for a read key. */
	canCapture: boolean;
};

type Held = Session & { exp: number };

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

/** A new session, its id the cookie's value; `now` (ms) for a test to place it. */
export function openSession(session: Session, now = Date.now()): string {
	for (const [id, held] of sessions) if (held.exp <= now) sessions.delete(id);
	while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
	const id = newId();
	sessions.set(id, { ...session, exp: now + SESSION_MAX_AGE * 1000 });
	return id;
}

/** The session an id names, or null for one it does not: unknown, ended or expired. */
export function readSession(id: string | undefined, now = Date.now()): Session | null {
	if (!id) return null;
	const held = sessions.get(id);
	if (!held) return null;
	if (held.exp <= now) {
		sessions.delete(id);
		return null;
	}
	return { key: held.key, name: held.name, scope: held.scope, canCapture: held.canCapture };
}

/** Ends a session: sign-out, or a key the REST core no longer takes. */
export function closeSession(id: string | undefined): void {
	if (id) sessions.delete(id);
}

/** How many sessions are held, for the suite. */
export function sessionCount(): number {
	return sessions.size;
}
