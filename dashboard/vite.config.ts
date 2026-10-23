import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	// The REST core's client is ../rest-client, and the auth switch's rule
	// ../server-portable/oauth-edge.ts: `vite dev` serves files outside this
	// directory only where told. The build bundles them either way.
	server: { fs: { allow: ['../rest-client', '../server-portable'] } }
});
