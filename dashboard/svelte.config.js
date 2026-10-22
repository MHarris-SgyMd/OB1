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
		// Everything the page loads is this server's: SvelteKit hashes its own
		// inline script, so no other script runs, and no page may frame it.
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
