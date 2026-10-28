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
const { grantClient, grantsGate, grantsOffered, grantsState, listGrants, revokeGrant } = await import('./src/lib/server/grants.ts');

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
	const tokenSession = (refresh: string, name = 'oauth:operator+gui') => session.openSession({ credential: { tokens: tok(refresh) }, name, scope: 'write', canCapture: true, breakglass: false });
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
	assert(sessionCookieName(false, 8001, ORIGIN_URL) === 'ob1_dashboard_session' && sessionCookieName(true, 8001, ORIGIN_URL) === 'ob1_dashboard_breakglass_8001' && sessionCookieName(true, 8002, ORIGIN_URL) !== sessionCookieName(true, 8001, ORIGIN_URL), "each listener's session cookie a name of its own, the break-glass port's with its port in it: neither overwrites the other on a shared host, nor two brains' on 127.0.0.1 (review pass 1)");
	const loopback = (p: string) => new URL(`http://127.0.0.1${p}/dashboard/`);
	assert(sessionCookieName(false, 8001, loopback(':8010')) === 'ob1_dashboard_session_8010' && sessionCookieName(false, 8001, loopback(':8011')) === 'ob1_dashboard_session_8011' && sessionCookieName(false, 8001, new URL('https://brain.example.test:443/')) === 'ob1_dashboard_session' && sessionCookieName(false, 8001, loopback(':80')) === 'ob1_dashboard_session' && sessionCookieName(false, 8001, new URL('https://brain.example.test:8443/')) === 'ob1_dashboard_session_8443' && sessionCookieName(true, 8001, loopback(':8010')) === 'ob1_dashboard_breakglass_8001', "the origin's cookie carries the origin's port, so two unconfigured brains at http://127.0.0.1:8010 and :8011 keep a cookie each (a browser's one per host whatever the port); an origin on its scheme's default port keeps the bare name, and the break-glass port's is its own whatever the origin (SMD-3352)");
	assert(session.signInCookieName(loopback(':8010')) === 'ob1_dashboard_signin_8010' && session.signInCookieName(loopback(':8011')) === 'ob1_dashboard_signin_8011' && session.signInCookieName(ORIGIN_URL) === 'ob1_dashboard_signin', "…and so does the sign-in binding's: two configured brains with loopback origins (OB1_PUBLIC_ORIGIN=http://127.0.0.1:<port>) no longer overwrite each other's sign-in in flight, and a default-port origin keeps the bare name (SMD-3352 review pass 1)");
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

console.log('▸ the page of grants (SMD-3307 PR 3)');
{
	const s = oauthSettings(env)!;
	const calls: { url: string; init: RequestInit }[] = [];
	const answering = (status: number, body?: unknown) => (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response(body === undefined ? null : JSON.stringify(body), { status });
	}) as typeof fetch;
	const failing = (async () => {
		throw new TypeError('fetch failed');
	}) as unknown as typeof fetch;
	const row = { id: 'Gr4nt_id-1', clientId: 'https://client.example/meta.json', clientName: null, accountId: 'operator', scope: 'openid brain:read', resources: [`${ORIGIN}/mcp`], createdAt: 1, renewedAt: 2, expiresAt: 3, refreshTokens: 2 };
	const listed = await listGrants(s, answering(200, { grants: [row, { id: 'bad id/../x' }, { id: 7 }, null], more: true }));
	const sentAuth = new Headers(calls[0]?.init.headers).get('authorization') ?? '';
	const [id, secret] = Buffer.from(sentAuth.replace(/^Basic /, ''), 'base64').toString().split(':').map((h) => decodeURIComponent(h.replace(/\+/g, ' ')));
	assert(calls[0]?.url === 'http://auth.ob1.internal.:3001/grants' && id === 'gui' && secret === SECRET, "the listing is the admin listener's on the mesh, port 3001, under the gui client's own credentials as Basic");
	assert(listed.ok && listed.grants.length === 1 && listed.grants[0].id === row.id && listed.grants[0].resources[0] === `${ORIGIN}/mcp` && listed.grants[0].refreshTokens === 2 && listed.more, "…each row read as a grant, its live refresh tokens counted, one with an id the AS never makes (a path, a number, none) dropped, and `more` kept");
	assert(JSON.stringify(await listGrants(s, answering(401))) === JSON.stringify({ ok: false, refused: 401 }) && JSON.stringify(await listGrants(s, answering(503))) === JSON.stringify({ ok: false, unreachable: true }) && JSON.stringify(await listGrants(s, answering(500))) === JSON.stringify({ ok: false, unreachable: true }) && JSON.stringify(await listGrants(s, failing)) === JSON.stringify({ ok: false, unreachable: true }), '…the GUI\'s credentials refused said as refused; a 500 or 503, or no answer at all, as unreachable');
	assert(JSON.stringify(await listGrants(s, answering(429))) === JSON.stringify({ ok: false, refused: 429 }), '…and a 429, the listener turning the GUI\'s address away after refusing its credentials 20 times, as refused, not as a server down (review pass 1)');
	calls.length = 0;
	assert((await revokeGrant(s, row.id, answering(204))) === 'revoked' && calls[0]?.url === `http://auth.ob1.internal.:3001/grants/${row.id}/revoke` && calls[0]?.init.method === 'POST', 'a revoke is a POST to the grant\'s own revoke path: 204 is revoked');
	assert((await revokeGrant(s, row.id, answering(404))) === 'gone' && (await revokeGrant(s, row.id, answering(401))) === 'refused' && (await revokeGrant(s, row.id, answering(429))) === 'locked' && (await revokeGrant(s, row.id, answering(500))) === 'unreachable' && (await revokeGrant(s, row.id, failing)) === 'unreachable', '…404 is no live grant of that id, 401 refused, 429 turned away for now, a 500 or no answer unreachable');
	calls.length = 0;
	assert((await revokeGrant(s, '../../auth/token', answering(204))) === 'gone' && calls.length === 0, '…and an id the AS never makes is sent nowhere');
	assert(grantsOffered({ canCapture: true }, env) && !grantsOffered({ canCapture: false }, env) && !grantsOffered(null, env) && !grantsOffered({ canCapture: true }, { ...env, COMPOSE_PROFILES: 'observability' }) && grantsOffered({ canCapture: true }, { ...env, OB1_AUTH_SECRET_GUI: undefined }), 'the nav names the page to a session that signed in able to write on a stack whose COMPOSE_PROFILES names auth — as every sign-in rule reads it, secret or none — and to no read session, no visitor, no other stack (review pass 1)');
	let asked = 0;
	const who = (operations: string[] | null) => async () => {
		asked++;
		return operations ? { name: 'oauth:operator+gui', scope: 'write', operations } : null;
	};
	const gate = await grantsGate({ ...env, COMPOSE_PROFILES: '' }, { canCapture: true }, who(['capture_thought']));
	assert(!gate.ok && gate.status === 404 && asked === 0, 'the page\'s gate: no auth profile, a 404, the REST core never asked');
	const readGate = await grantsGate(env, { canCapture: false }, who(['capture_thought']));
	assert(!readGate.ok && readGate.status === 403 && asked === 0 && !(await grantsGate(env, null, who(['capture_thought']))).ok, '…a session that signed in unable to write, or none, a 403, the REST core never asked');
	const noSecret = await grantsGate({ ...env, OB1_AUTH_SECRET_GUI: '' }, { canCapture: true }, who(['capture_thought']));
	assert(!noSecret.ok && noSecret.status === 503 && noSecret.message.includes('OB1_AUTH_SECRET_GUI') && asked === 0, '…configured but holding no secret, a 503 that names it, not a 404 saying the stack has no AS (review pass 1)');
	const stale = await grantsGate(env, { canCapture: true }, who(null));
	const downgraded = await grantsGate(env, { canCapture: true }, who(['thought_stats']));
	assert(!stale.ok && stale.status === 403 && !downgraded.ok && downgraded.status === 403 && asked === 2, '…and every time, the session itself asked at the REST core: one it no longer answers for, or that can no longer write, is a 403, not trusted on its sign-in\'s flag (review pass 1: a revoked session kept the page for its day)');
	const passed = await grantsGate(env, { canCapture: true }, who(['thought_stats', 'capture_thought']));
	assert(passed.ok && passed.settings.secret === SECRET && asked === 3, '…one that still writes passes, with the settings the listener\'s calls need');
	assert(grantsState({ ok: true, grants: [], more: false }) === 'ok' && grantsState({ ok: false, unreachable: true }) === 'unreachable' && grantsState({ ok: false, refused: 429 }) === 'locked' && grantsState({ ok: false, refused: 401 }) === 'refused', 'the page\'s state for each answer: the grants, the AS down, the GUI turned away (429), its credentials refused (review pass 2)');
	const g = (over: Record<string, unknown>) => grantClient({ ...row, refreshTokens: 1, ...over } as Parameters<typeof grantClient>[0]);
	assert(g({ clientId: 'gui' }).label === 'This dashboard' && g({ clientId: 'gui', refreshTokens: 0 }).label === 'This dashboard, no refresh token', 'a GUI grant is this dashboard\'s sign-in; one holding no live refresh token, which renews no session (never finished, or idle past 14 days), says so (review passes 1 and 2)');
	assert(g({}).label === 'client.example' && g({ clientId: 'cid', clientName: 'Claude Code' }).label === '“Claude Code”, as it calls itself' && g({ clientId: 'cid', clientName: '  ' }).label === 'a registered client with no name', '…a metadata-document client by its host, a registered one by the name it gave itself, said as its own');
	assert(g({ clientId: 'cid', clientName: '\u202eedoc edualC' }).label === '“edoc edualC”, as it calls itself' && !/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/.test(JSON.stringify(g({ clientId: 'c\u2067id', clientName: 'a\u2066b\u200fc' }))), '…without the bidirectional controls that could turn the words around it back to front (review pass 1)');
	assert(g({ clientId: 'cid', clientName: 'Claude\u200bCode\u00ad\u3164\u115f\u1160\uffa0\u034f\ufe0f\u2800' }).label === '“ClaudeCode”, as it calls itself' && g({ clientId: 'cid', clientName: 'Z\u0489\u0489\u0489\u0489\u0489\u0489' }).label === '“Z\u0489\u0489\u0489\u0489”, as it calls itself' && g({ clientId: 'cid', clientName: '\u1019\u103c\u102d\u102f\u1037' }).label === '“\u1019\u103c\u102d\u102f\u1037”, as it calls itself' && g({ clientId: 'https://e.example/a\u202eb\u200bc' }).detail === 'client metadata document https://e.example/abc', '…nor what renders as nothing or a blank (format characters, every filler, the joiner, a variation selector, the Braille blank), on a name or a metadata document\'s id; marks stop at four on a character, a Burmese name kept whole (review passes 2 and 3)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
