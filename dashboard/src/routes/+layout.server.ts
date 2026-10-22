import { env } from '$env/dynamic/private';
import type { LayoutServerLoad } from './$types';
import { grafanaUrl } from '$lib/server/grafana';

// The key itself stays in locals: the page learns whose it is and what it may do.
export const load: LayoutServerLoad = async ({ locals }) => ({
	signedIn: locals.session !== null,
	name: locals.session?.name ?? null,
	scope: locals.session?.scope ?? null,
	canCapture: locals.session?.canCapture ?? false,
	grafana: locals.session ? grafanaUrl(env) : null,
});
