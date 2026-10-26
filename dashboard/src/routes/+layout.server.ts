import { env } from '$env/dynamic/private';
import type { LayoutServerLoad } from './$types';
import { grafanaUrl } from '$lib/server/grafana';
import { pluginNav } from '$lib/server/plugins';

// The key itself stays in locals: the page learns whose it is and what it may do.
export const load: LayoutServerLoad = async (event) => {
	const { session } = event.locals;
	// Read on every navigation, not once per full load: a plugin turned on or off shows in the nav at the next page, and
	// no stale entry leads to a 404 (review pass 2). Reading the address is what makes SvelteKit run this again.
	void event.url.pathname;
	return {
		signedIn: session !== null,
		name: session?.name ?? null,
		scope: session?.scope ?? null,
		canCapture: session?.canCapture ?? false,
		// A path on this origin is the public origin's route (compose.grafana-public.yaml): the break-glass port routes the GUI alone, so none there (review pass 2).
		grafana: session ? grafanaUrl(env, event.locals.breakglass) : null,
		// The enabled plugins' pages this key may use (SMD-2280 PR 3), each its href and label alone.
		pluginPages: session ? await pluginNav(event) : [],
	};
};
