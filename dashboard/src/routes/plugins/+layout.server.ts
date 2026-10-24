import type { LayoutServerLoad } from './$types';
import { pluginPageAt } from '$lib/server/plugins';

// Every plugin page's gate (SMD-2280 PR 3, review pass 1): the page the route
// names, as the registry lists it to this key, or a 404 — a plugin off, a page
// it does not declare, or a key that may call none of it. Here once for every
// page under /plugins, so no page can leave it out; check 31 holds that this
// file stands and each page beside it is one a manifest declares.
export const load: LayoutServerLoad = async (event) => {
	await pluginPageAt(event);
	return {};
};
