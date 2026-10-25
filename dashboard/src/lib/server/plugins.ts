// The plugins' pages (SMD-2280 PR 3, SMD-2310's GUI half). The REST core
// lists, at GET /v1/plugins, each enabled plugin the visitor's key may call an
// operation of: its title, its description, its pages and those operations.
// The pages are the GUI's to render, each a route of this tree at
// src/routes/plugins/<name><path>/ — a plugin's directory holds no Svelte
// (check 31) — so the nav names a page only where the registry lists it and
// this build has its route. A page reaches its plugin through pluginAccess
// alone, which answers 404 unless the registry lists the page to this key — a
// disabled plugin's page is no page at all — and only then hands back the
// plugin's operations, so a load or an action cannot call one ungated. The
// gate is each page's own, not a layout's: a layout's load is skipped on a
// __data.json request that does not ask for it, and loads run side by side.
// Check 31 holds a plugin page's server file to awaiting it and to nothing
// else that reaches the brain.

import { error, isHttpError, isRedirect, type RequestEvent } from '@sveltejs/kit';
import { base } from '$app/paths';
import { callPlugin, codeOf, read, readPlugin } from './rest';
import type { Method } from '../../../../rest-client/index.ts';

/** An enabled plugin as the registry lists it to this key. */
export type ListedPlugin = { name: string; title: string; description: string; pages: { path: string; label: string }[]; operations: string[] };

/** The plugin pages this build renders, `<name><path>`: every route under src/routes/plugins/ (check 31 holds each to a manifest's page). */
const BUILT = new Set(
	Object.keys(import.meta.glob('/src/routes/plugins/*/**/+page.svelte')).flatMap((file) => {
		const m = /^\/src\/routes\/plugins\/([a-z0-9-]+)(\/.+)\/\+page\.svelte$/.exec(file);
		return m ? [`${m[1]}${m[2]}`] : [];
	}),
);

/** The registry, read once per request under the visitor's key: the layout's nav and a plugin page's load share it. */
export function pluginsFor(event: RequestEvent): Promise<ListedPlugin[]> {
	event.locals.plugins ??= read(event, event.locals.session!, 'plugins', {}).then(listed);
	return event.locals.plugins;
}

/** The registry's answer, each plugin held to the shape the core lists (the client types a success only as an object). */
function listed(body: unknown): ListedPlugin[] {
	const plugins = (body as { plugins?: unknown } | null)?.plugins;
	if (!Array.isArray(plugins)) return [];
	const text = (v: unknown) => typeof v === 'string';
	return plugins.filter(
		(p): p is ListedPlugin =>
			typeof p === 'object' && p !== null && text(p.name) && text(p.title) && text(p.description) &&
			Array.isArray(p.operations) && p.operations.every(text) &&
			Array.isArray(p.pages) && p.pages.every((g: { path?: unknown; label?: unknown } | null) => g !== null && typeof g === 'object' && text(g.path) && text(g.label)),
	);
}

/** How long the nav waits for the registry before it renders without the plugins' pages: a page's own reads have the full deadline. */
const NAV_WAIT_MS = 2000;

/**
 * The nav's plugin entries: each page the registry lists that this build
 * renders. The nav is no page's to fail or to hold up — a 404 included, which
 * reads nothing else — so a registry the core will not read, or has not read
 * within NAV_WAIT_MS, leaves it without them; a key the core no longer takes
 * still goes to /signin.
 */
export async function pluginNav(event: RequestEvent): Promise<{ href: string; label: string }[]> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// The read itself runs on, shared through locals with a plugin page's own access.
		const listed = await Promise.race([pluginsFor(event), new Promise<null>((done) => (timer = setTimeout(() => done(null), NAV_WAIT_MS)))]);
		if (listed === null) return [];
		return listed.flatMap((p) => p.pages.filter((g) => BUILT.has(`${p.name}${g.path}`)).map((g) => ({ href: `${base}/plugins/${p.name}${g.path}`, label: g.label })));
	} catch (err) {
		if (isRedirect(err)) throw err;
		// A refusal or fault the read already logged; anything else is the GUI's own bug, said here (review pass 1).
		if (!isHttpError(err)) console.error(`[dashboard] the plugin nav: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	} finally {
		clearTimeout(timer);
	}
}

/** A plugin operation's answer, as an action reads it: its status, and the core's code on a refusal. */
export type PluginAnswer = { ok: boolean; status: number; code: string | undefined };

/** What a plugin page may do: the plugin as the registry lists it to this key, and its operations under the visitor's key, each by its key in the manifest and its route under the plugin's. */
export type PluginAccess = {
	plugin: ListedPlugin;
	/** Whether this key may call the operation. */
	may(op: string): boolean;
	/** A read: its body, or the page's error, as any read of the GUI's. */
	read(op: string, method: Method, route: string, input: Record<string, unknown>): Promise<unknown>;
	/** A write: its answer, for the action to say a refusal beside its form. */
	call(op: string, method: Method, route: string, input: Record<string, unknown>): Promise<PluginAnswer>;
};

/**
 * Every plugin page's load and action starts here: the page's 404 unless the
 * registry lists it to this key — the plugin not enabled, a page it does not
 * declare, or a key that may call none of it — and then the plugin's
 * operations, bound to the plugin, under the visitor's key. The plugin and the
 * page are the route's own, `/plugins/<name><path>`, so a page copied into
 * another plugin's directory gates on that plugin, never the one it was
 * copied from (review pass 4).
 */
export async function pluginAccess(event: RequestEvent): Promise<PluginAccess> {
	const route = /^\/plugins\/([a-z0-9-]+)(\/.+)$/.exec(event.route.id ?? '');
	if (!route) throw error(404, 'Not Found');
	const [, name, path] = route;
	const plugin = (await pluginsFor(event)).find((p) => p.name === name);
	if (!plugin || !plugin.pages.some((g) => g.path === path)) throw error(404, 'Not Found');
	const session = event.locals.session!;
	// The tool's name as the core names it: a hyphen in the plugin's name read as `_` (core/plugins.ts's toolNameOf).
	const tool = (op: string) => `${name.replaceAll('-', '_')}_${op}`;
	const at = (route: string) => `/v1/plugins/${name}${route}`;
	return {
		plugin,
		may: (op) => plugin.operations.includes(tool(op)),
		read: (op, method, route, input) => readPlugin(event, session, tool(op), method, at(route), input),
		call: async (op, method, route, input) => {
			const answer = await callPlugin(event, session, tool(op), method, at(route), input);
			return { ok: answer.ok, status: answer.status, code: codeOf(answer.body) };
		},
	};
}
