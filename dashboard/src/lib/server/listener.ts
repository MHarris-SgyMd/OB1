// Which listener a request came in by (SMD-3307; ADR decision 15): the origin's, or the break-glass port the
// `breakglass` service publishes on 127.0.0.1 alone. The proxy's `breakglass` entrypoint sets X-OB1-Listener:
// breakglass on its one router, and its `web` entrypoint deletes that header from every request on the origin
// (deploy/compose.yaml), so off the mesh the header's presence is the proxy's word, not a client's; on the mesh,
// the stack's own servers can reach the GUI or the proxy's break-glass entrypoint directly, and each holds or
// can call the REST core with a key already. While the stack is configured with the authorization server, key
// sign-in is offered on the break-glass listener alone (signin.ts keySignInOffered).
//
// The origin a form is posted from: SvelteKit's own check compares it with the configured public origin, which
// a browser at http://127.0.0.1:<port> never sends, so the GUI checks it here instead (hooks.server.ts) — on the
// origin, the origin alone; on the break-glass listener, that port's own http://127.0.0.1 origin alone (review
// pass 1: a page on the public origin posted a key there, and `localhost` could be another process on ::1, the
// port being published on 127.0.0.1 alone). Each listener's session rides a cookie of its own name. Pure: the
// caller reads BREAKGLASS_PORT and passes it.

/** The header the proxy's break-glass router sets, and its `web` entrypoint deletes. */
export const LISTENER_HEADER = 'x-ob1-listener';

/** Whether the proxy says this request came in by the break-glass port. */
export const onBreakGlass = (request: Request) => request.headers.get(LISTENER_HEADER) === 'breakglass';

/**
 * The break-glass port on the host (compose's BREAKGLASS_PORT, 8001 unless set), read as compose reads one published
 * port — leading zeros and a `+` taken (review passes 2 and 3: refused here, `08317` and `+8317` offered the key and
 * took no post) — or null for anything else: a value compose refuses, and the two it publishes that name no one port
 * (`0`, any free one; a range), which leave the GUI no origin to take a form from.
 */
export function breakGlassPort(value: string | undefined): number | null {
	const v = value?.trim() || '8001';
	if (!/^\+?\d+$/.test(v)) return null;
	const n = Number(v.replace(/^\+/, ''));
	return n >= 1 && n <= 65535 ? n : null;
}

/** The methods a browser's form or script can send that change something: each is checked for its origin. */
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Whether a request may be taken from where the browser says it was posted. A safe method always; an unsafe one
 * — whatever its body, so one with none (a bare POST to start a sign-in or sign out) is checked too, which
 * SvelteKit's check passes — only from its own listener's origin: the configured one on the origin, and
 * `http://127.0.0.1:<port>` on the break-glass listener, exactly: not another port on 127.0.0.1, where another
 * local page would be same-site, its cookies the same host's.
 */
export function originAllowed(request: Request, url: URL, port: number | null): boolean {
	if (!UNSAFE.has(request.method)) return true;
	const origin = request.headers.get('origin');
	if (origin === null) return false;
	if (onBreakGlass(request)) return port !== null && origin === `http://127.0.0.1:${port}`;
	return origin === url.origin;
}

/**
 * The origin check's refusal, on the break-glass port naming the one address it takes a form from, since
 * `localhost` is the likeliest wrong one (review pass 2). To a form under `use:enhance` (SvelteKit's action post,
 * `x-sveltekit-action`), the failure SvelteKit's own `fail(403, { error })` makes — HTTP 200, the result's status
 * 403, its data devalue's encoding of `{ error }` — so the sign-in page says it under the key field, where a text
 * answer was a parse error and a bare JSON one nothing at all; to another that asks for JSON, `{ message }`, as
 * SvelteKit's origin check answered; text otherwise.
 */
export function originRefusal(request: Request, url: URL, port: number | null): Response {
	const message = !onBreakGlass(request)
		? `This request must come from the dashboard at ${url.origin}/dashboard/: open it at that address, or behind TLS set OB1_PUBLIC_ORIGIN to the address you use and recreate app.`
		: port === null
			? "This break-glass port cannot take a sign-in: the dashboard's BREAKGLASS_PORT is not a port. Set it in deploy/.env and recreate app and breakglass."
			: `The break-glass port takes a sign-in from http://127.0.0.1:${port}/dashboard/ alone (not localhost): open the dashboard at that address.`;
	const json = request.headers.get('accept') === 'application/json';
	if (json && request.headers.get('x-sveltekit-action') === 'true') return Response.json({ type: 'failure', status: 403, data: JSON.stringify([{ error: 1 }, message]) });
	if (json) return Response.json({ message }, { status: 403 });
	return new Response(message, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/**
 * The session cookie's name on a listener: on the origin `ob1_dashboard_session`, with the origin's port in it when
 * the origin names one (`ob1_dashboard_session_8010`), and on the break-glass listener one of its own with that
 * port in it. A browser keeps one cookie per host and name whatever the port (RFC 6265 §8.5), so a name without
 * the port is one cookie for every brain on the host: two unconfigured stacks reached at http://127.0.0.1:8010 and
 * :8011 overwrote each other's, and each visit to one signed the browser out of the other (SMD-3352). So the
 * origin's and the break-glass port's never overwrite each other where they share a host (an origin of
 * http://127.0.0.1:…), nor two brains' origins or break-glass ports on one machine (review pass 1). An origin on
 * its scheme's default port (a configured https one) keeps the bare name: the URL names no port, and no other
 * brain shares its host. `url` is the request's as SvelteKit reads it — OB1_PUBLIC_ORIGIN's when set, else the
 * Host it was reached at (serve.ts) — whose port is digits or none.
 */
export function sessionCookieName(breakglass: boolean, port: number | null, url: URL): string {
	if (breakglass) return `ob1_dashboard_breakglass_${port ?? 'unset'}`;
	return url.port ? `ob1_dashboard_session_${url.port}` : 'ob1_dashboard_session';
}
