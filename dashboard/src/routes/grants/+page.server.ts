import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { base } from '$app/paths';
import type { Actions, PageServerLoad } from './$types';
import { oneLine, when } from '$lib/format';
import { GRANT_ID, grantClient, grantsGate, listGrants, revokeGrant } from '$lib/server/grants';
import type { OAuthSettings } from '$lib/server/oauth';
import { read } from '$lib/server/rest';
import { whoAmI } from '$lib/server/signin';
import { authReachability } from '../../../../server-portable/oauth-edge.ts';

// The page of grants (SMD-3307 PR 3; ADR decision 15's revocation page): the
// clients signed in as the operator, each a grant at the authorization server,
// and a revoke for each, read and written through the AS's admin listener on
// the mesh under the GUI's own client credentials ($lib/server/grants). The
// gate is the load's and the action's alike, since an action runs before any
// load: a 404 without the AS, a 403 for a session that cannot write, checked at
// the REST core each time (a session whose grant was revoked ends at its next
// renewal here as on any page, review pass 1). The AS's reachability is the
// sign-in page's 30 s probe: with the AS down the page says so at once, not
// after a call's 10 s timeout.

/** The gate, before anything the request says: the AS's settings, or the page's error. */
async function gate(event: RequestEvent): Promise<OAuthSettings> {
	const g = await grantsGate(env, event.locals.session, async () => whoAmI(await read(event, event.locals.session!, 'whoami', {})));
	if (!g.ok) throw error(g.status, g.message);
	return g.settings;
}

/** An epoch second as the pages write an instant, or a dash. */
const at = (s: number | null) => (s === null ? '—' : when(new Date(s * 1000).toISOString()));

export const load: PageServerLoad = async (event) => {
	const s = await gate(event);
	const said = event.url.searchParams;
	const notice = said.has('revoked') ? 'revoked' : said.has('gone') ? 'gone' : null;
	const answer = (await authReachability().reachable()) ? await listGrants(s) : ({ ok: false, unreachable: true } as const);
	if (!answer.ok) return { state: 'unreachable' in answer ? ('unreachable' as const) : answer.refused === 429 ? ('locked' as const) : ('refused' as const), grants: [], more: false, notice };
	return {
		state: 'ok' as const,
		notice,
		more: answer.more,
		grants: answer.grants.map((g) => ({
			id: g.id,
			...grantClient(g),
			scope: oneLine(g.scope, 200),
			// Each resource as a path on this origin, where it is one: `/mcp`, `/api`, a tier's.
			resources: g.resources.map((r) => oneLine(r.startsWith(s.origin) ? r.slice(s.origin.length) || '/' : r, 200)),
			created: at(g.createdAt),
			// The AS lists a renewal only once a refresh token has been rotated: the sign-in's own is no renewal.
			renewed: g.renewedAt === null ? null : at(g.renewedAt),
			lapses: at(g.expiresAt),
		})),
	};
};

export const actions: Actions = {
	// One grant revoked, then the page again (a redirect, so a reload revokes nothing twice). A refusal or no answer is
	// said on the page, nothing revoked.
	revoke: async (event) => {
		const s = await gate(event);
		let id = '';
		try {
			id = String((await event.request.formData()).get('grant') ?? '');
		} catch {
			// A body that is not a form (review pass 1: a text/plain post was a 500): nothing to revoke.
		}
		if (!GRANT_ID.test(id)) return fail(400, { error: 'That is not a grant this page listed.' });
		const done = (await authReachability().reachable()) ? await revokeGrant(s, id) : 'unreachable';
		if (done === 'revoked') throw redirect(303, `${base}/grants?revoked=1`);
		if (done === 'gone') throw redirect(303, `${base}/grants?gone=1`);
		if (done === 'refused' || done === 'locked') {
			console.error(`[dashboard] grants revoke: the authorization server ${done === 'locked' ? 'turned the GUI away after too many refused credentials' : 'refused the GUI’s credentials'}`);
			return fail(502, { error: `The authorization server ${done === 'locked' ? 'is turning the dashboard away for now, after refusing its credentials too often' : 'refused the dashboard’s credentials'}: nothing was revoked. OB1_AUTH_SECRET_GUI in deploy/.env may not match the server’s; set it and recreate auth and app.` });
		}
		return fail(503, { error: 'The authorization server did not answer: nothing was revoked. Try again once it is up.' });
	},
};
