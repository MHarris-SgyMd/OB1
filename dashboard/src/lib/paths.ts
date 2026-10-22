import { base } from '$app/paths';

/** The GUI's own root, `/dashboard/` (svelte.config.js's paths.base): SvelteKit serves the root route under a base with its slash, and answers `/dashboard` with a 308 to it. */
export const HOME = `${base}/`;
