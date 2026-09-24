import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (!locals.session && url.pathname !== '/signin') {
		throw redirect(302, '/signin');
	}

	// The key itself stays in locals: the page learns only whether it is signed
	// in and whether its key may capture.
	return {
		signedIn: locals.session !== null,
		canCapture: locals.session?.canCapture ?? false,
	};
};
