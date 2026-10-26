#!/usr/bin/env bun
/**
 * test-oauth.ts — the GUI's sign-in through the authorization server, offline
 * (SMD-3307): src/lib/server/oauth.ts against a fake token endpoint. What
 * settings it reads, the authorization request it builds, the PKCE pair, the
 * code's exchange (and when its password was typed, from the ID token), a
 * refresh and a revocation as the `gui` client, every way the AS can answer,
 * the renewal of a session's tokens (one refresh per session at a time, a
 * refused one ending the session, an unanswered one leaving it), the revoker
 * (one at a time, an unanswered one tried again, its bounds), and the session
 * store's one door for tokens no session holds (session.ts onTokensEnded).
 * CI's portable-server job runs it; the real AS is driven end to end by
 * deploy-stack-auth's GUI step.
 *
 *   bun test-oauth.ts
 */

import { createHash } from 'node:crypto';
import { authorizeUrl, createRenewer, createRevoker, exchangeCode, MAX_REVOKE_PENDING, needsRenewal, newSignIn, oauthSettings, refreshTokens, RenewalFailed, REVOKE_KEEP_MS, REVOKE_RETRY_MS, revokeRefresh, type Revoked, signedInSince, SIGNIN_MS, signInFrom, type TokenAnswer, type Tokens } from './src/lib/server/oauth.ts';

// session.ts reads SvelteKit's `$app/paths` (its cookies' path): a stand-in, so the store loads here.
// …and signin.ts reads SvelteKit's `$env/dynamic/private`: an empty one, its env handed in by each call here.
Bun.plugin({
	name: 'sveltekit-stand-ins',
	setup: (build) => {
		build.module('$app/paths', () => ({ exports: { base: '/dashboard' }, loader: 'object' }));
		build.module('$env/dynamic/private', () => ({ exports: { env: {} }, loader: 'object' }));
	},
});
const session = await import('./src/lib/server/session.ts');
const { keySignInOffered } = await import('./src/lib/server/signin.ts');
const { breakGlassPort, onBreakGlass, originAllowed, originRefusal, sessionCookieName } = await import('./src/lib/server/listener.ts');
const { grafanaUrl } = await import('./src/lib/server/grafana.ts');

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
	assert(signInFrom(st.binding, t0 + 1)?.began === t0, '…and when it began, which the password must not precede');
	const second = t0 + 750 - (t0 % 1000);
	assert(signedInSince(second - 750 + 1000, second) && signedInSince(second - 750, second) && !signedInSince(second - 750 - 1000, second) && !signedInSince(null, second) && !signedInSince(undefined, second), "a password typed in the sign-in's own second or after is this sign-in's (auth_time is in whole seconds); one a second before, or none said, is not (review pass 3)");
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
	const idToken = (claims: Record<string, unknown>) => `eyJhbGciOiJFUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
	const signedIn = async (claims: Record<string, unknown> | null) => {
		const f = fakeAs(() => json(200, { access_token: 'a', refresh_token: 'r', expires_in: 600, ...(claims ? { id_token: idToken(claims) } : {}) }));
		const got = await exchangeCode(s, 'c', 'v', f.fetchFn);
		return got.ok ? got.signedInAt : 'not ok';
	};
	const claims = { iss: `${ORIGIN}/auth`, aud: 'gui', sub: 'operator', auth_time: 1_800_000_123 };
	assert((await signedIn(claims)) === 1_800_000_123_000 && (await signedIn({ ...claims, aud: ['gui', 'x'] })) === 1_800_000_123_000, "…and when the password was typed: the ID token's auth_time, in ms");
	assert((await signedIn({ ...claims, aud: 'other' })) === null && (await signedIn({ ...claims, iss: 'https://elsewhere/auth' })) === null && (await signedIn({ ...claims, auth_time: undefined })) === null && (await signedIn(null)) === null, "…and none from another client's or issuer's token, one without auth_time, or no ID token");
	const ref = fakeAs(() => json(200, { access_token: 'acc-2', refresh_token: 'ref-2', expires_in: 600 }));
	const r = await refreshTokens(s, 'ref-1', ref.fetchFn, () => NOW);
	assert(ref.calls[0].form.get('grant_type') === 'refresh_token' && ref.calls[0].form.get('refresh_token') === 'ref-1' && ref.calls[0].form.get('resource') === s.resource && r.ok && r.tokens.refresh === 'ref-2', 'a refresh spends the old token for a new pair, for the same resource');
	const refusals: [string, Response | (() => never), (a: TokenAnswer) => boolean][] = [
		['a 400 invalid_grant', json(400, { error: 'invalid_grant' }), (a) => !a.ok && 'refused' in a && a.refused === 'invalid_grant'],
		['a 401 with no body it reads', new Response('nope', { status: 401 }), (a) => !a.ok && 'unreachable' in a],
		['a 503', json(503, { error: 'temporarily_unavailable' }), (a) => !a.ok && 'unreachable' in a],
		['a 500 server_error', json(500, { error: 'server_error' }), (a) => !a.ok && 'unreachable' in a],
		['a 429 (the AS: too many, later)', json(429, { error: 'temporarily_unavailable' }), (a) => !a.ok && 'unreachable' in a],
		['a 429 that names no OAuth error', json(429, { message: 'slow down' }), (a) => !a.ok && 'unreachable' in a],
		['no refresh token in a 200', json(200, { access_token: 'a', expires_in: 600 }), (a) => !a.ok && 'refused' in a && a.refused === 'incomplete_token_answer'],
		['no lifetime in a 200', json(200, { access_token: 'a', refresh_token: 'r' }), (a) => !a.ok && 'refused' in a],
		['a lifetime of 0 in a 200', json(200, { access_token: 'a', refresh_token: 'r', expires_in: 0 }), (a) => !a.ok && 'refused' in a],
		['a fetch that throws', () => { throw new TypeError('connection refused'); }, (a) => !a.ok && 'unreachable' in a],
	];
	for (const [what, reply, holds] of refusals) {
		const f = fakeAs(() => (typeof reply === 'function' ? reply() : reply));
		assert(holds(await refreshTokens(s, 'r', f.fetchFn)), `${what}: ${/throws|50\d|429|reads/.test(what) ? 'no answer, never a refusal that ends a session' : 'refused'}`);
	}
	const rev = fakeAs(() => new Response(null, { status: 200 }));
	const revoked = await revokeRefresh(s, 'ref-2', rev.fetchFn);
	assert(revoked === 'revoked' && rev.calls[0].url === s.revocation && rev.calls[0].form.get('token') === 'ref-2' && rev.calls[0].form.get('token_type_hint') === 'refresh_token' && rev.calls[0].auth.startsWith('Basic ') && rev.calls[0].bounded, 'a revocation posts the refresh token to the mesh revocation endpoint, as gui, under a timeout of its own (a hung AS holds the revoker no longer)');
	const outcome = async (reply: () => Response) => revokeRefresh(s, 'x', fakeAs(reply).fetchFn);
	assert((await outcome(() => { throw new TypeError('down'); })) === 'unreachable' && (await outcome(() => json(503, {}))) === 'unreachable' && (await outcome(() => json(429, {}))) === 'unreachable' && (await outcome(() => json(401, { error: 'invalid_client' }))) === 'refused', '…no answer (a fetch that throws, a 5xx, a 429) to try again, a 4xx a refusal not to');
}

console.log('▸ the revoker');
{
	const tok = (refresh: string): Tokens => ({ access: 'a', refresh, expiresAt: 0 });
	/** A revoker over a fake AS that answers each token with `answer`, its retries run by hand, its clock set by hand. */
	const over = (answer: (refresh: string) => Revoked | Promise<Revoked>) => {
		const tried: string[] = [];
		const retries: (() => void)[] = [];
		const clock = { now: NOW };
		const r = createRevoker({ revoke: async (t) => { tried.push(t); return answer(t); }, now: () => clock.now, schedule: (fn, ms) => void (ms === REVOKE_RETRY_MS && retries.push(fn)) });
		return { r, tried, retries, clock };
	};
	let open = 0;
	let most = 0;
	const seq = over(async () => { open++; most = Math.max(most, open); await Bun.sleep(5); open--; return 'revoked'; });
	await Promise.all([seq.r.add(tok('gone-1')), seq.r.add(tok('gone-2')), seq.r.add(tok('gone-3'))]);
	assert(seq.tried.join() === 'gone-1,gone-2,gone-3' && most === 1 && seq.r.pending() === 0 && seq.retries.length === 0, `every token due is revoked, each once, one at a time (${most} at once), and nothing waits after`);
	let up = false;
	const down = over(() => (up ? 'revoked' : 'unreachable'));
	await down.r.add(tok('t1'));
	assert(down.r.pending() === 1 && down.retries.length === 1, 'one the AS does not answer waits, a retry scheduled (review pass 3: a sign-out with the AS down revoked nothing)');
	up = true;
	down.retries.shift()?.();
	await down.r.flush();
	assert(down.tried.join() === 't1,t1' && down.r.pending() === 0 && down.retries.length === 0, '…and is revoked once the AS answers, nothing left waiting');
	const refused = over(() => 'refused');
	await refused.r.add(tok('t2'));
	assert(refused.r.pending() === 0 && refused.retries.length === 0, 'one the AS refuses is not tried again');
	const lapsed = over(() => 'unreachable');
	await lapsed.r.add(tok('t3'));
	lapsed.clock.now += REVOKE_KEEP_MS;
	lapsed.retries.shift()?.();
	await lapsed.r.flush();
	assert(lapsed.r.pending() === 0 && lapsed.retries.length === 0, "…nor one past the refresh token's idle life, which the AS has let lapse");
	let gate!: () => void;
	const held = new Promise<void>((g) => (gate = g));
	const full = over(async () => { await held; return 'unreachable'; });
	const first = full.r.add(tok('first'));
	for (let i = 0; i < MAX_REVOKE_PENDING + 1; i++) void full.r.add(tok(`t${i}`));
	assert(full.r.pending() === MAX_REVOKE_PENDING, `at most ${MAX_REVOKE_PENDING} wait at once (${full.r.pending()}): the oldest is given up`);
	gate();
	await first;
	let flushed = false;
	const slow = over(async () => { await Bun.sleep(5); return 'revoked'; });
	void slow.r.add(tok('a'));
	void slow.r.add(tok('b'));
	await slow.r.flush().then(() => (flushed = slow.tried.length === 2));
	assert(flushed, '…and a flush waits until every token added before it was tried');
}

console.log('▸ the session store: every ending of a token session revokes');
{
	const ended: string[] = [];
	session.onTokensEnded((t) => void ended.push(t.refresh));
	const tokenSession = (refresh: string, name = 'oauth:operator') => session.openSession({ credential: { tokens: tok(refresh) }, name, scope: 'write', canCapture: true, breakglass: false });
	function tok(refresh: string): Tokens {
		return { access: 'a', refresh, expiresAt: NOW };
	}
	const s1 = tokenSession('closed');
	assert(session.closeSession(s1) !== null && ended.join() === 'closed', 'a token session closed (sign-out, a refusal) has its refresh token revoked');
	const k = session.openSession({ credential: { key: 'k' }, name: 'k', scope: 'read', canCapture: false, breakglass: false });
	session.closeSession(k);
	assert(ended.join() === 'closed', '…a key session nothing');
	ended.length = 0;
	const own = Array.from({ length: session.MAX_PER_KEY }, (_, i) => tokenSession(`own-${i}`, 'oauth:crowded'));
	tokenSession('one-more', 'oauth:crowded');
	assert(ended.join() === 'own-0' && session.readSession(own[0]) === null, 'one evicted past MAX_PER_KEY, its holder\'s oldest: revoked');
	ended.length = 0;
	const s2 = tokenSession('renewed-late');
	session.closeSession(s2);
	ended.length = 0;
	assert(!session.storeTokens(s2, tok('landed-after')) && ended.join() === 'landed-after', 'a renewal landing after its session ended: the new token, which no one holds, revoked');
	ended.length = 0;
	const s3 = tokenSession('expired');
	const realNow = Date.now;
	Date.now = () => realNow() + session.SESSION_MAX_AGE * 1000 + 1;
	try {
		assert(session.readSession(s3) === null && ended.length === 0, 'an expired session reads as none, left for the request to close…');
		tokenSession('later');
		assert(ended.includes('expired'), '…and swept when the next sign-in opens one, revoked');
	} finally {
		Date.now = realNow;
	}
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

console.log('▸ the break-glass listener (SMD-3307)');
{
	const ORIGIN_URL = new URL('https://brain.example.test/dashboard/signin');
	const req = (method: string, headers: Record<string, string>) => new Request('http://app.ob1.internal:8000/dashboard/signin', { method, headers });
	const bg = { 'x-ob1-listener': 'breakglass' };
	assert(onBreakGlass(req('GET', bg)) && !onBreakGlass(req('GET', {})) && !onBreakGlass(req('GET', { 'x-ob1-listener': 'web' })), 'the listener is break-glass only when the proxy marks it so');
	assert(breakGlassPort(undefined) === 8001 && breakGlassPort('') === 8001 && breakGlassPort('18397') === 18397 && breakGlassPort('0') === null && breakGlassPort('70000') === null && breakGlassPort('8001x') === null && breakGlassPort('08317') === 8317 && breakGlassPort('008317') === 8317 && breakGlassPort('+8317') === 8317 && breakGlassPort('8001-8002') === null && breakGlassPort('-1') === null, 'the break-glass port: 8001 unless set, read as compose reads one published port (leading zeros and a + taken), and 0, a range or a value that is no port none');
	assert(originAllowed(req('GET', {}), ORIGIN_URL, 8001) && originAllowed(req('HEAD', { origin: 'https://elsewhere.example' }), ORIGIN_URL, 8001), 'a safe method is taken from anywhere');
	assert(originAllowed(req('POST', { origin: 'https://brain.example.test' }), ORIGIN_URL, 8001), 'a post from the origin is taken on the origin');
	assert(!originAllowed(req('POST', { origin: 'https://brain.example.test', ...bg }), ORIGIN_URL, 8001), '…and not on the break-glass listener: a page on the public origin posts no key there (review pass 1)');
	assert(!originAllowed(req('POST', { origin: 'https://brain.example.test.elsewhere.example' }), ORIGIN_URL, 8001) && !originAllowed(req('PATCH', { origin: 'https://elsewhere.example' }), ORIGIN_URL, 8001) && !originAllowed(req('PUT', { origin: 'https://elsewhere.example' }), ORIGIN_URL, 8001), '…the origin matched whole, not as a prefix, and PATCH and PUT checked as POST is');
	assert(!originAllowed(req('POST', {}), ORIGIN_URL, 8001) && !originAllowed(req('POST', { origin: 'https://elsewhere.example' }), ORIGIN_URL, 8001) && !originAllowed(req('DELETE', { origin: 'null' }), ORIGIN_URL, 8001), '…and none from another origin, from "null", or with no origin at all (a body-less post included)');
	assert(originAllowed(req('POST', { origin: 'http://127.0.0.1:8001', ...bg }), ORIGIN_URL, 8001), 'on the break-glass listener, a post from its own http://127.0.0.1 origin is taken');
	assert(!originAllowed(req('POST', { origin: 'http://localhost:8001', ...bg }), ORIGIN_URL, 8001) && !originAllowed(req('POST', { origin: 'http://[::1]:8001', ...bg }), ORIGIN_URL, 8001), '…and not localhost\'s or [::1]\'s: the port is published on 127.0.0.1 alone, so another process can hold ::1 (review pass 1)');
	assert(!originAllowed(req('POST', { origin: 'http://127.0.0.1:8001' }), ORIGIN_URL, 8001), '…but not on the origin: a page at http://127.0.0.1:8001 signs nothing in there');
	assert(!originAllowed(req('POST', { origin: 'http://127.0.0.1:3000', ...bg }), ORIGIN_URL, 8001) && !originAllowed(req('POST', { origin: 'https://127.0.0.1:8001', ...bg }), ORIGIN_URL, 8001) && !originAllowed(req('POST', { origin: 'http://127.0.0.1:8001', ...bg }), ORIGIN_URL, null), '…nor another loopback port, https, or any when the port is no port: another local page is the same site, its cookies the same host\'s');
	assert(sessionCookieName(false, 8001) === 'ob1_dashboard_session' && sessionCookieName(true, 8001) === 'ob1_dashboard_breakglass_8001' && sessionCookieName(true, 8002) !== sessionCookieName(true, 8001), "each listener's session cookie a name of its own, the break-glass port's with its port in it: neither overwrites the other on a shared host, nor two brains' on 127.0.0.1 (review pass 1)");
	// devalue's encoding of a flat { error: string }, read here without the package (a dependency of SvelteKit's, not this suite's): [{ error: <index> }, …values].
	const devalueParse = (data: string) => { const a = JSON.parse(data) as [Record<string, number>, ...unknown[]]; return Object.fromEntries(Object.entries(a[0]).map(([k, i]) => [k, a[i]])); };
	const asAction = originRefusal(req('POST', { accept: 'application/json', 'x-sveltekit-action': 'true', ...bg }), ORIGIN_URL, 8001);
	const action = (await asAction.json().catch(() => ({}))) as { type?: string; status?: number; data?: string };
	const actionData = (typeof action.data === 'string' ? devalueParse(action.data) : {}) as { error?: string };
	assert(asAction.status === 200 && action.type === 'failure' && action.status === 403 && (actionData.error ?? '').includes('http://127.0.0.1:8001/dashboard/'), "the refusal to a form under use:enhance: SvelteKit's own failure shape, its { error } naming the break-glass port's one address, which the page shows under the key field (review pass 2)");
	const asJson = originRefusal(req('POST', { accept: 'application/json' }), ORIGIN_URL, 8001);
	const asText = originRefusal(req('POST', { accept: 'text/html', 'x-sveltekit-action': 'true' }), ORIGIN_URL, 8001);
	const originSaid = 'https://brain.example.test/dashboard/';
	assert(asJson.status === 403 && ((await asJson.json()) as { message: string }).message.includes(originSaid) && asText.status === 403 && (asText.headers.get('content-type') ?? '').startsWith('text/plain') && (await asText.text()).includes(originSaid), "…to another that asks for JSON, { message } as SvelteKit's check answered, and text otherwise (SvelteKit's header alone included), the origin's naming the address that works (review pass 3)");
	assert(grafanaUrl({ GRAFANA_ROUTE: '/grafana/' }) === '/grafana/' && grafanaUrl({ GRAFANA_ROUTE: '/grafana/' }, true) === null && grafanaUrl({ GRAFANA_LINK: 'http://127.0.0.1:3000/grafana/' }, true) === 'http://127.0.0.1:3000/grafana/', "the nav's Grafana link: a path on the origin not on the break-glass port, which routes the GUI alone; an address of its own there too (review pass 2)");
	const configured = { COMPOSE_PROFILES: 'auth' };
	assert(keySignInOffered(req('GET', {}), {}) && keySignInOffered(req('GET', bg), {}), 'not configured, key sign-in on either listener');
	assert(!keySignInOffered(req('GET', {}), configured) && !keySignInOffered(req('GET', { 'x-ob1-listener': 'web' }), configured), 'configured, none on the origin');
	assert(keySignInOffered(req('GET', bg), configured) && keySignInOffered(req('GET', bg), { COMPOSE_PROFILES: 'observability,auth' }), '…and key sign-in on the break-glass listener, whatever the authorization server\'s state');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
