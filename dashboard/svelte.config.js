import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// A Node server in build/, which serve.ts starts under Bun in the server
		// image. Every package is bundled into it, none read at runtime.
		adapter: adapter(),
		// The proxy routes /dashboard here with the path kept (deploy/compose.yaml,
		// the `dashboard` router), so every route, asset and redirect lives under
		// it, and the session cookie is scoped to it (session.ts; the ADR's
		// "Path-based public routes carry obligations").
		// Absolute, not relative: every link and asset names /dashboard/…, as the
		// proxy routes it, whatever page it is on.
		paths: { base: '/dashboard', relative: false },
		// SvelteKit's origin check compares a form's post with the configured
		// public origin, which a browser on the break-glass port
		// (http://127.0.0.1:<port>, SMD-3307) never sends: the GUI checks every
		// unsafe request's origin itself instead (hooks.server.ts,
		// lib/server/listener.ts originAllowed), a body-less one too.
		csrf: { trustedOrigins: ['*'] },
		// Everything the page loads is this server's: SvelteKit marks its own
		// inline script with a per-response nonce, so no other script runs, and
		// no page may frame it.
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'data:'],
				'connect-src': ['self'],
				'form-action': ['self'],
				'base-uri': ['self'],
				'frame-ancestors': ['none'],
				'object-src': ['none']
			}
		}
	},
	vitePlugin: {
		dynamicCompileOptions: ({ filename }) =>
			filename.includes('node_modules') ? undefined : { runes: true }
	}
};

export default config;
