// Key sign-in (SMD-2280 PR 1): the visitor pastes an access key, the REST
// core's whoami says whose it is and what it may call, and a read or write
// key opens a session.

import { env } from '$env/dynamic/private';
import { configuredIn } from '../../../../server-portable/oauth-edge.ts';

/**
 * Whether this origin offers key sign-in. Not while the stack is configured
 * with the authorization server (COMPOSE_PROFILES names auth, ADR decision
 * 16): then the public port never offers it, whether or not the authorization
 * server answers, since knocking it over must not open a weaker door. Sign-in
 * there is by code and PKCE, and break-glass key sign-in is a loopback-only
 * listener; both are SMD-2280's PR 4, so until then a configured stack's GUI
 * signs no one in.
 */
export function keySignInOffered(e: Record<string, string | undefined> = env): boolean {
	return !configuredIn(e.COMPOSE_PROFILES);
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
