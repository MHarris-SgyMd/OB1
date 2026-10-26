// Which listener a request came in by (SMD-3307; ADR decision 15): the origin's, or the break-glass port the
// `breakglass` service publishes on 127.0.0.1 alone. The proxy's `breakglass` entrypoint sets X-OB1-Listener:
// breakglass on its one router, and its `web` entrypoint deletes that header from every request on the origin
// (deploy/compose.yaml), so the header's presence is the proxy's word, not a client's. While the stack is
// configured with the authorization server, key sign-in is offered there alone (signin.ts keySignInOffered).
//
// The origin a form is posted from: SvelteKit's own check compares it with the configured public origin, which
// a browser at http://127.0.0.1:<port> never sends, so the GUI checks it here instead (hooks.server.ts) — the
// public origin always, and the break-glass port's own origin only on that listener. Pure but for the env.

/** The header the proxy's break-glass router sets, and its `web` entrypoint deletes. */
export const LISTENER_HEADER = 'x-ob1-listener';

/** Whether the proxy says this request came in by the break-glass port. */
export const onBreakGlass = (request: Request) => request.headers.get(LISTENER_HEADER) === 'breakglass';

/** The break-glass port on the host (compose's BREAKGLASS_PORT, 8001 unless set), or null for a value that is no port. */
export function breakGlassPort(value: string | undefined): number | null {
	const v = value?.trim() || '8001';
	if (!/^[1-9]\d{0,4}$/.test(v)) return null;
	const n = Number(v);
	return n <= 65535 ? n : null;
}

/** The methods a browser's form or script can send that change something: each is checked for its origin. */
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Whether a request may be taken from where the browser says it was posted. A safe method always; an unsafe one
 * — whatever its body, so one with none (a bare POST to start a sign-in or sign out) is checked too, which
 * SvelteKit's check passes — only from the origin itself, or, on the break-glass listener alone, from that port's
 * own loopback origin: not any port on 127.0.0.1, where another local page would be same-site, its cookies the
 * same host's.
 */
export function originAllowed(request: Request, url: URL, port: number | null): boolean {
	if (!UNSAFE.has(request.method)) return true;
	const origin = request.headers.get('origin');
	if (origin === null) return false;
	if (origin === url.origin) return true;
	return onBreakGlass(request) && port !== null && (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`);
}
