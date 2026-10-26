import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { base } from '$app/paths';
import type { Actions, PageServerLoad } from './$types';
import { oneLine, when } from '$lib/format';
import { CLIENT_ID, oauthSettings, type OAuthSettings } from '$lib/server/oauth';
import { GRANT_ID, grantsOffered, listGrants, revokeGrant, type Grant } from '$lib/server/grants';

// The page of grants (SMD-3307 PR 3; ADR decision 15's revocation page): the
// clients signed in as the operator, each a grant at the authorization server,
// and a revoke for each, read and written through the AS's admin listener on
// the mesh under the GUI's own client credentials ($lib/server/grants). Only on
// a configured stack, and only for a session that may write (grantsOffered):
// a 404 or a 403 before any call otherwise, the action's too, since an action
// runs before any load.

/** The gate, before anything the request says: the AS's settings, or the page's 404 or 403. */
function gate(event: RequestEvent): OAuthSettings {
	const s = oauthSettings(env);
	if (!s) throw error(404, 'No page of grants here: this stack is not configured with the authorization server.');
	if (!grantsOffered(event.locals.session, s)) throw error(403, 'The page of grants is a write session’s: sign in with the operator’s account, or a write key on the break-glass port.');
	return s;
}

/** An epoch second as the pages write an instant, or a dash. */
const at = (s: number | null) => (s === null ? '—' : when(new Date(s * 1000).toISOString()));

/**
 * Who a grant is for, in the page's words: this dashboard's own sign-ins; a client that names itself by a metadata
 * document's URL, by its host, which the AS fetched it from; a registered one by its id and the name it gave itself,
 * which is its own word and said as such.
 */
function clientOf(g: Grant): { label: string; detail: string | null } {
	if (g.clientId === CLIENT_ID) return { label: 'This dashboard', detail: 'a sign-in to the operator GUI' };
	if (/^https:\/\//.test(g.clientId)) {
		let host = g.clientId;
		try {
			host = new URL(g.clientId).host;
		} catch {
			// shown as the AS listed it
		}
		return { label: oneLine(host, 120), detail: `client metadata document ${oneLine(g.clientId, 200)}` };
	}
	return { label: g.clientName ? `“${oneLine(g.clientName, 80)}”, as it calls itself` : 'a registered client with no name', detail: `registered client ${oneLine(g.clientId, 120)}` };
}

export const load: PageServerLoad = async (event) => {
	const s = gate(event);
	const answer = await listGrants(s);
	const said = event.url.searchParams;
	const notice = said.has('revoked') ? 'revoked' : said.has('gone') ? 'gone' : null;
	if (!answer.ok) return { state: 'unreachable' in answer ? ('unreachable' as const) : ('refused' as const), grants: [], more: false, notice };
	return {
		state: 'ok' as const,
		notice,
		more: answer.more,
		grants: answer.grants.map((g) => ({
			id: g.id,
			...clientOf(g),
			scope: oneLine(g.scope, 200),
			// Each resource as a path on this origin, where it is one: `/mcp`, `/api`, a tier's.
			resources: g.resources.map((r) => oneLine(r.startsWith(s.origin) ? r.slice(s.origin.length) || '/' : r, 200)),
			created: at(g.createdAt),
			renewed: g.renewedAt !== null && g.renewedAt !== g.createdAt ? at(g.renewedAt) : null,
			lapses: at(g.expiresAt),
		})),
	};
};

export const actions: Actions = {
	// One grant revoked, then the page again (a redirect, so a reload revokes nothing twice). A refusal or no answer is
	// said on the page, nothing revoked.
	revoke: async (event) => {
		const s = gate(event);
		const id = String((await event.request.formData()).get('grant') ?? '');
		if (!GRANT_ID.test(id)) return fail(400, { error: 'That is not a grant this page listed.' });
		const done = await revokeGrant(s, id);
		if (done === 'revoked') throw redirect(303, `${base}/grants?revoked=1`);
		if (done === 'gone') throw redirect(303, `${base}/grants?gone=1`);
		if (done === 'refused') {
			console.error('[dashboard] grants revoke: the authorization server refused the GUI’s credentials');
			return fail(502, { error: 'The authorization server refused the dashboard’s credentials: nothing was revoked. OB1_AUTH_SECRET_GUI in deploy/.env may not match the server’s; recreate auth and app.' });
		}
		return fail(503, { error: 'The authorization server did not answer: nothing was revoked. Try again once it is up.' });
	},
};
