import { env } from '$env/dynamic/private';
import type { LayoutServerLoad } from './$types';
import { grafanaUrl } from '$lib/server/grafana';
import { pluginNav } from '$lib/server/plugins';

// The key itself stays in locals: the page learns whose it is and what it may do.
export const load: LayoutServerLoad = async (event) => {
	const { session } = event.locals;
	return {
		signedIn: session !== null,
		name: session?.name ?? null,
		scope: session?.scope ?? null,
		canCapture: session?.canCapture ?? false,
		grafana: session ? grafanaUrl(env) : null,
		// The enabled plugins' pages this key may use (SMD-2280 PR 3), each its href and label alone.
		pluginPages: session ? await pluginNav(event) : [],
	};
};
