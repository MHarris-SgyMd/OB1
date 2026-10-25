#!/usr/bin/env bun
/**
 * test-oauth.ts — the GUI's sign-in through the authorization server, offline
 * (SMD-3307): src/lib/server/oauth.ts against a fake token endpoint. What
 * settings it reads, the authorization request it builds, the PKCE pair, the
 * code's exchange, a refresh and a revocation as the `gui` client, every way
 * the AS can answer, and the renewal of a session's tokens (one refresh per
 * session at a time, a refused one ending the session, an unanswered one
 * leaving it). CI's portable-server job runs it; the real AS is driven end to
 * end by deploy-stack-auth's GUI step.
 *
 *   bun test-oauth.ts
 */

import { createHash } from 'node:crypto';
import { authorizeUrl, createRenewer, exchangeCode, needsRenewal, newSignIn, oauthSettings, RENEW_BEFORE_MS, refreshTokens, RenewalFailed, revokeRefresh, type TokenAnswer, type Tokens } from './src/lib/server/oauth.ts';

let pass = 0;
let fail = 0;
const assert = (cond: boolean, msg: string) => {
	console.log(`  ${cond ? '✓' : '✗'}  ${msg}`);
	if (cond) pass++;
	else fail++;
};

const ORIGIN = 'https://brain.example.test';
const SECRET = 'a gui secret: with + and %';
const env = { COMPOSE_PROFILES: 'auth', OB1_PUBLIC_ORIGIN: ORIGIN, OB1_AUTH_SECRET_GUI: SECRET };

console.log('▸ settings');
{
	const s = oauthSettings(env)!;
	assert(s !== null && s.authorize === `${ORIGIN}/auth/authorize` && s.redirect === `${ORIGIN}/dashboard/auth/callback` && s.resource === `${ORIGIN}/api`, 'a configured stack with a sound origin and the secret: the public authorize URL, the registered redirect, the REST core as the resource');
	assert(s.token === 'http://auth.ob1.internal.:3000/auth/token' && s.revocation === 'http://auth.ob1.internal.:3000/auth/token/revocation', '…and the token and revocation endpoints on the mesh');
	assert(oauthSettings({ ...env, COMPOSE_PROFILES: '' }) === null, 'not configured: none');
	assert(oauthSettings({ ...env, OB1_PUBLIC_ORIGIN: 'http://brain.example.test' }) === null && oauthSettings({ ...env, OB1_PUBLIC_ORIGIN: undefined }) === null, 'an unsound or missing origin: none');
	assert(oauthSettings({ ...env, OB1_AUTH_SECRET_GUI: '  ' }) === null, 'no secret: none');
}

console.log('▸ the authorization request');
{
	const s = oauthSettings(env)!;
	const { state, verifier, challenge } = newSignIn();
	const again = newSignIn();
	assert(challenge === createHash('sha256').update(verifier).digest('base64url') && verifier.length >= 43 && state !== again.state && verifier !== again.verifier, 'a fresh S256 pair and state each sign-in');
	const u = new URL(authorizeUrl(s, state, challenge));
	const q = u.searchParams;
	assert(u.origin + u.pathname === `${ORIGIN}/auth/authorize`, 'sent to the public authorize endpoint');
	assert(q.get('client_id') === 'gui' && q.get('response_type') === 'code' && q.get('redirect_uri') === s.redirect && q.get('state') === state, '…as the gui client, for a code, to the registered redirect, with the state');
	assert(q.get('code_challenge') === challenge && q.get('code_challenge_method') === 'S256' && !q.has('code_verifier'), '…with the S256 challenge, never the verifier');
	assert(q.get('resource') === s.resource && q.get('scope')!.split(' ').includes('offline_access') && q.get('scope')!.split(' ').includes('brain:write') && q.get('prompt') === 'consent', '…for the REST core, write scope and offline_access, with prompt=consent (the AS grants offline_access only with it)');
}

/** A fake token endpoint: each call recorded, answered by `reply`. */
function fakeAs(reply: (form: URLSearchParams) => Response | Promise<Response>) {
	const calls: { url: string; auth: string; form: URLSearchParams }[] = [];
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		const form = new URLSearchParams(String(init?.body ?? ''));
		calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') ?? '', form });
		return reply(form);
	}) as typeof fetch;
	return { calls, fetchFn };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const NOW = 1_800_000_000_000;

console.log('▸ the code exchange, a refresh and a revocation');
{
	const s = oauthSettings(env)!;
	const as = fakeAs(() => json(200, { access_token: 'acc-1', refresh_token: 'ref-1', expires_in: 600, token_type: 'Bearer' }));
	const got = await exchangeCode(s, 'the-code', 'the-verifier', as.fetchFn, () => NOW);
	const c = as.calls[0];
	const [id, secret] = Buffer.from(c.auth.replace(/^Basic /, ''), 'base64').toString().split(':').map((v) => decodeURIComponent(v.replace(/\+/g, ' ')));
	assert(c.url === s.token && id === 'gui' && secret === SECRET, 'the exchange posts to the mesh token endpoint as gui, its secret in Basic form-encoded (a + and a % survive)');
	assert(c.form.get('grant_type') === 'authorization_code' && c.form.get('code') === 'the-code' && c.form.get('code_verifier') === 'the-verifier' && c.form.get('redirect_uri') === s.redirect && c.form.get('resource') === s.resource, '…with the code, the verifier, the redirect and the resource');
	assert(got.ok && got.tokens.access === 'acc-1' && got.tokens.refresh === 'ref-1' && got.tokens.expiresAt === NOW + 600_000, '…and reads the pair and its expiry');
	const ref = fakeAs(() => json(200, { access_token: 'acc-2', refresh_token: 'ref-2', expires_in: 600 }));
	const r = await refreshTokens(s, 'ref-1', ref.fetchFn, () => NOW);
	assert(ref.calls[0].form.get('grant_type') === 'refresh_token' && ref.calls[0].form.get('refresh_token') === 'ref-1' && ref.calls[0].form.get('resource') === s.resource && r.ok && r.tokens.refresh === 'ref-2', 'a refresh spends the old token for a new pair, for the same resource');
	const refusals: [string, Response | (() => never), (a: TokenAnswer) => boolean][] = [
		['a 400 invalid_grant', json(400, { error: 'invalid_grant' }), (a) => !a.ok && 'refused' in a && a.refused === 'invalid_grant'],
		['a 401 with no body it reads', new Response('nope', { status: 401 }), (a) => !a.ok && 'unreachable' in a],
		['a 503', json(503, { error: 'temporarily_unavailable' }), (a) => !a.ok && 'unreachable' in a],
		['no refresh token in a 200', json(200, { access_token: 'a', expires_in: 600 }), (a) => !a.ok && 'refused' in a && a.refused === 'incomplete_token_answer'],
		['no lifetime in a 200', json(200, { access_token: 'a', refresh_token: 'r' }), (a) => !a.ok && 'refused' in a],
		['a fetch that throws', () => { throw new TypeError('connection refused'); }, (a) => !a.ok && 'unreachable' in a],
	];
	for (const [what, reply, holds] of refusals) {
		const f = fakeAs(() => (typeof reply === 'function' ? reply() : reply));
		assert(holds(await refreshTokens(s, 'r', f.fetchFn)), `${what}: ${what.includes('throws') || what.includes('503') || what.includes('reads') ? 'no answer' : 'refused'}`);
	}
	const rev = fakeAs(() => new Response(null, { status: 200 }));
	const revoked = await revokeRefresh(s, 'ref-2', rev.fetchFn);
	assert(revoked && rev.calls[0].url === s.revocation && rev.calls[0].form.get('token') === 'ref-2' && rev.calls[0].form.get('token_type_hint') === 'refresh_token' && rev.calls[0].auth.startsWith('Basic '), "sign-out revokes the refresh token at the mesh revocation endpoint, as gui");
	const down = fakeAs(() => { throw new TypeError('down'); });
	assert((await revokeRefresh(s, 'x', down.fetchFn)) === false, '…and says false, never throws, when the AS does not answer');
}

console.log('▸ renewal');
{
	const fresh: Tokens = { access: 'a-old', refresh: 'r-old', expiresAt: NOW + RENEW_BEFORE_MS + 1 };
	const due: Tokens = { ...fresh, expiresAt: NOW + RENEW_BEFORE_MS };
	assert(!needsRenewal(fresh, NOW) && needsRenewal(due, NOW), `renewed at ${RENEW_BEFORE_MS / 1000} s before expiry, not sooner`);
	let refreshes = 0;
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const stored = new Map<string, Tokens>();
	const closed: string[] = [];
	const accessFor = createRenewer({
		refresh: async (t) => {
			refreshes++;
			await gate;
			return { ok: true, tokens: { access: `a-new(${t})`, refresh: 'r-new', expiresAt: NOW + 600_000 } };
		},
		store: (id, t) => void stored.set(id, t),
		close: (id) => void closed.push(id),
		now: () => NOW,
	});
	assert((await accessFor('s1', fresh)) === 'a-old' && refreshes === 0, 'a token good for longer is sent as it is, no refresh');
	const both = Promise.all([accessFor('s1', due), accessFor('s1', due)]);
	release();
	const [x, y] = await both;
	assert(refreshes === 1 && x === 'a-new(r-old)' && y === x && stored.get('s1')?.refresh === 'r-new', 'two calls at once on a due session refresh once, both get the new token, and the pair is written back');
	const other = createRenewer({ refresh: async () => ({ ok: false, refused: 'invalid_grant' }), store: () => {}, close: (id) => void closed.push(id), now: () => NOW });
	let thrown: unknown;
	try { await other('s2', due); } catch (e) { thrown = e; }
	assert(thrown instanceof RenewalFailed && thrown.refused && closed.includes('s2'), 'a refused refresh ends the session and says refused');
	const silent = createRenewer({ refresh: async () => ({ ok: false, unreachable: true }), store: () => {}, close: (id) => void closed.push(id), now: () => NOW });
	thrown = undefined;
	try { await silent('s3', due); } catch (e) { thrown = e; }
	assert(thrown instanceof RenewalFailed && !thrown.refused && !closed.includes('s3'), 'an unanswered refresh leaves the session and says so');
	let after = 0;
	const retry = createRenewer({ refresh: async () => (after++ === 0 ? { ok: false, unreachable: true } : { ok: true, tokens: { access: 'a2', refresh: 'r2', expiresAt: NOW + 600_000 } }), store: () => {}, close: () => {}, now: () => NOW });
	try { await retry('s4', due); } catch { /* the first fails */ }
	assert((await retry('s4', due)) === 'a2', '…and the next call tries again: a failed renewal is not held');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
