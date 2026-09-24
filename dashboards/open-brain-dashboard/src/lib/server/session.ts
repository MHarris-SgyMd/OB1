// The signed-in state: the access key the visitor typed at /signin and what the
// server said it may do, sealed into one httpOnly cookie. Server-only ($lib/server):
// SvelteKit refuses to bundle this into the browser.
//
// Why a sealed cookie and not a Supabase user (SMD-1801): the brain's own access
// keys are named, scoped and revocable (server-portable/auth.ts), so the key IS
// the credential — a Supabase project existed here only to check an email and
// password before the proxy used a key from the dashboard's env. Now each
// visitor's key is what the proxy forwards, a read key sees a read-only
// dashboard, and revoking the key in MCP_ACCESS_KEYS ends the session. The
// browser holds AES-GCM ciphertext under SESSION_SECRET, never the key.
//
// WebCrypto and btoa/atob only — no Node module — so the same file runs on
// Node, Bun, Vercel's and Netlify's runtimes and an edge worker.

export const SESSION_COOKIE = 'ob1_dashboard_session';
/** A day, as the two Next dashboards' iron-session cookies. */
export const SESSION_MAX_AGE = 60 * 60 * 24;

export type DashboardSession = {
	/** The access key, forwarded as x-brain-key on every proxied call. */
	key: string;
	/** Whether tools/list under this key named capture_thought — false for a read key. */
	canCapture: boolean;
};

const MIN_SECRET = 32;

/** SESSION_SECRET, refused short: a 16-byte secret guessed by dictionary would hand over every visitor's key. */
export function sessionSecret(env: Record<string, string | undefined>): string {
	const secret = env.SESSION_SECRET;
	if (!secret || secret.length < MIN_SECRET) {
		throw new Error(`SESSION_SECRET must be set and at least ${MIN_SECRET} characters (openssl rand -hex 32)`);
	}
	return secret;
}

async function keyFor(secret: string): Promise<CryptoKey> {
	const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
	return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
	const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
	const binary = atob(padded);
	const out = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/** iv(12) + ciphertext, base64url. */
export async function seal(session: DashboardSession, secret: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plain = new TextEncoder().encode(JSON.stringify(session));
	const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(secret), plain));
	const out = new Uint8Array(iv.length + cipher.length);
	out.set(iv, 0);
	out.set(cipher, iv.length);
	return toBase64Url(out);
}

/** The session a cookie holds, or null for anything that does not decrypt to one — a tampered, truncated or re-keyed cookie is no session, not an error. */
export async function unseal(token: string | undefined, secret: string): Promise<DashboardSession | null> {
	if (!token) return null;
	try {
		const bytes = fromBase64Url(token);
		if (bytes.length <= 12) return null;
		const plain = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: bytes.subarray(0, 12) },
			await keyFor(secret),
			bytes.subarray(12),
		);
		const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
		if (
			typeof parsed === 'object' && parsed !== null &&
			typeof (parsed as DashboardSession).key === 'string' && (parsed as DashboardSession).key.length > 0 &&
			typeof (parsed as DashboardSession).canCapture === 'boolean'
		) {
			return { key: (parsed as DashboardSession).key, canCapture: (parsed as DashboardSession).canCapture };
		}
		return null;
	} catch {
		return null;
	}
}
