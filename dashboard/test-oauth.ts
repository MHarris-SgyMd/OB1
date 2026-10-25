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
import { authorizeUrl, createRenewer, exchangeCode, needsRenewal, newSignIn, oauthSettings, refreshTokens, RenewalFailed, revokeEnded, revokeRefresh, SIGNIN_MS, signInFrom, type TokenAnswer, type Tokens } from './src/lib/server/oauth.ts';

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
	const { binding, state, challenge } = newSignIn();
	const again = newSignIn();
	const derived = signInFrom(binding)!;
	assert(challenge === createHash('sha256').update(derived.verifier).digest('base64url') && derived.verifier.length >= 43 && derived.state === state && state !== again.state && binding !== again.binding, 'a fresh binding each sign-in, its state and S256 challenge derived from it');
	assert(!state.includes(binding.split('.')[1]) && signInFrom(state) === null, '…the state carries nothing of the binding, and is no binding itself: a callback URL alone yields no verifier');
	const t0 = 1_800_000_000_000;
	const st = newSignIn(t0);
	assert(signInFrom(st.binding, t0 + 1)?.state === st.state && signInFrom(st.binding, t0 + SIGNIN_MS)?.state === st.state, 'the state and verifier come back from the binding alone, within the sign-in window: a start holds nothing on the server');
	assert(signInFrom(st.binding, t0 + SIGNIN_MS + 1) === null && signInFrom(st.binding, t0 - 1) === null, '…and not past the window, nor before its start');
	const tampered = st.binding.slice(0, -1) + (st.binding.endsWith('A') ? 'B' : 'A');
	assert(signInFrom(tampered, t0 + 1)?.state !== st.state && signInFrom('no-dot', t0) === null && signInFrom(undefined, t0) === null, '…another binding another state, and a malformed or missing one none');
	const u = new URL(authorizeUrl(s, state, challenge));
	const q = u.searchParams;
	assert(u.origin + u.pathname === `${ORIGIN}/auth/authorize`, 'sent to the public authorize endpoint');
	assert(q.get('client_id') === 'gui' && q.get('response_type') === 'code' && q.get('redirect_uri') === s.redirect && q.get('state') === state, '…as the gui client, for a code, to the registered redirect, with the state');
	assert(q.get('code_challenge') === challenge && q.get('code_challenge_method') === 'S256' && !q.has('code_verifier'), '…with the S256 challenge, never the verifier');
	assert(q.get('resource') === s.resource && q.get('scope')!.split(' ').includes('offline_access') && q.get('scope')!.split(' ').includes('brain:write') && q.get('prompt') === 'login consent', '…for the REST core, write scope and offline_access, with prompt=login consent (the password every time, and the consent the AS grants offline_access with)');
}

/** A fake token endpoint: each call recorded, answered by `reply`. */
function fakeAs(reply: (form: URLSearchParams) => Response | Promise<Response>) {
	const calls: { url: string; auth: string; form: URLSearchParams; bounded: boolean }[] = [];
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		const form = new URLSearchParams(String(init?.body ?? ''));
		calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') ?? '', form, bounded: init?.signal instanceof AbortSignal });
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
	assert(c.bounded, '…under a timeout of its own: an AS that never answers is no answer, not a page held forever');
	const ref = fakeAs(() => json(200, { access_token: 'acc-2', refresh_token: 'ref-2', expires_in: 600 }));
	const r = await refreshTokens(s, 'ref-1', ref.fetchFn, () => NOW);
	assert(ref.calls[0].form.get('grant_type') === 'refresh_token' && ref.calls[0].form.get('refresh_token') === 'ref-1' && ref.calls[0].form.get('resource') === s.resource && r.ok && r.tokens.refresh === 'ref-2', 'a refresh spends the old token for a new pair, for the same resource');
	const refusals: [string, Response | (() => never), (a: TokenAnswer) => boolean][] = [
		['a 400 invalid_grant', json(400, { error: 'invalid_grant' }), (a) => !a.ok && 'refused' in a && a.refused === 'invalid_grant'],
		['a 401 with no body it reads', new Response('nope', { status: 401 }), (a) => !a.ok && 'unreachable' in a],
		['a 503', json(503, { error: 'temporarily_unavailable' }), (a) => !a.ok && 'unreachable' in a],
		['a 429 (the AS: too many, later)', json(429, { error: 'temporarily_unavailable' }), (a) => !a.ok && 'unreachable' in a],
		['no refresh token in a 200', json(200, { access_token: 'a', expires_in: 600 }), (a) => !a.ok && 'refused' in a && a.refused === 'incomplete_token_answer'],
		['no lifetime in a 200', json(200, { access_token: 'a', refresh_token: 'r' }), (a) => !a.ok && 'refused' in a],
		['a fetch that throws', () => { throw new TypeError('connection refused'); }, (a) => !a.ok && 'unreachable' in a],
	];
	for (const [what, reply, holds] of refusals) {
		const f = fakeAs(() => (typeof reply === 'function' ? reply() : reply));
		assert(holds(await refreshTokens(s, 'r', f.fetchFn)), `${what}: ${what.includes('throws') || what.includes('503') || what.includes('429') || what.includes('reads') ? 'no answer, never a refusal that ends a session' : 'refused'}`);
	}
	const rev = fakeAs(() => new Response(null, { status: 200 }));
	const revoked = await revokeRefresh(s, 'ref-2', rev.fetchFn);
	assert(revoked && rev.calls[0].url === s.revocation && rev.calls[0].form.get('token') === 'ref-2' && rev.calls[0].form.get('token_type_hint') === 'refresh_token' && rev.calls[0].auth.startsWith('Basic '), "sign-out revokes the refresh token at the mesh revocation endpoint, as gui");
	const down = fakeAs(() => { throw new TypeError('down'); });
	assert((await revokeRefresh(s, 'x', down.fetchFn)) === false, '…and says false, never throws, when the AS does not answer');
	let open = 0;
	let most = 0;
	const ended = fakeAs(async () => { open++; most = Math.max(most, open); await Bun.sleep(5); open--; return new Response(null, { status: 200 }); });
	await revokeEnded(s, [{ access: 'a', refresh: 'gone-1', expiresAt: 0 }, null, { access: 'b', refresh: 'gone-2', expiresAt: 0 }, { access: 'c', refresh: 'gone-3', expiresAt: 0 }], ended.fetchFn);
	assert(ended.calls.map((c) => c.form.get('token')).join() === 'gone-1,gone-2,gone-3' && most === 1, `sessions ended without a sign-out have their refresh tokens revoked, each, one at a time (${most} at once)`);
}

console.log('▸ renewal');
{
	const fresh: Tokens = { access: 'a-old', refresh: 'r-old', expiresAt: NOW + 60_001 };
	const due: Tokens = { ...fresh, expiresAt: NOW + 60_000 };
	assert(!needsRenewal(fresh, NOW) && needsRenewal(due, NOW), 'renewed from a minute before expiry, not sooner');
	/** A renewer over a store of sessions, as rest.ts wires it to session.ts: current reads the store, store writes it. */
	const over = (refresh: (t: string) => Promise<TokenAnswer>, held: Record<string, Tokens>) => {
		const sessions = new Map(Object.entries(held));
		const closed: string[] = [];
		const accessFor = createRenewer({ refresh, current: (id) => sessions.get(id) ?? null, store: (id, t) => void sessions.set(id, t), close: (id) => { closed.push(id); sessions.delete(id); }, now: () => NOW });
		return { accessFor, sessions, closed };
	};
	let refreshes = 0;
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const newPair = (t: string): TokenAnswer => ({ ok: true, tokens: { access: `a-new(${t})`, refresh: `r-new(${t})`, expiresAt: NOW + 600_000 } });
	const a = over(async (t) => { refreshes++; await gate; return newPair(t); }, { s1: fresh, s2: due });
	assert((await a.accessFor('s1')) === 'a-old' && refreshes === 0, 'a token good for longer is sent as it is, no refresh');
	const both = Promise.all([a.accessFor('s2'), a.accessFor('s2')]);
	release();
	const [x, y] = await both;
	assert(refreshes === 1 && x === 'a-new(r-old)' && y === x && a.sessions.get('s2')?.refresh === 'r-new(r-old)', 'two calls at once on a due session refresh once, both get the new token, and the pair is written back');
	assert((await a.accessFor('s2')) === x && refreshes === 1, '…and a call after, in the same request, reads the session as it is now: no second refresh with the spent token (review pass 1)');
	const b = over(async () => ({ ok: false, refused: 'invalid_grant' }), { s3: due });
	let thrown: unknown;
	try { await b.accessFor('s3'); } catch (e) { thrown = e; }
	assert(thrown instanceof RenewalFailed && thrown.refused && b.closed.includes('s3'), 'a refused refresh ends the session and says refused');
	thrown = undefined;
	try { await b.accessFor('s3'); } catch (e) { thrown = e; }
	assert(thrown instanceof RenewalFailed && thrown.refused, '…and a session that is gone is refused, never renewed');
	const c = over(async () => ({ ok: false, unreachable: true }), { s4: due });
	thrown = undefined;
	try { await c.accessFor('s4'); } catch (e) { thrown = e; }
	assert(thrown instanceof RenewalFailed && !thrown.refused && c.closed.length === 0 && c.sessions.has('s4'), 'an unanswered refresh leaves the session and says so');
	let after = 0;
	const d = over(async (t) => (after++ === 0 ? { ok: false, unreachable: true } : newPair(t)), { s5: due });
	try { await d.accessFor('s5'); } catch { /* the first fails */ }
	assert((await d.accessFor('s5')) === 'a-new(r-old)', '…and the next call tries again: a failed renewal is not held');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
