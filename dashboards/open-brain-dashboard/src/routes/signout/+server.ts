import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cookieOptions, SESSION_COOKIE } from '$lib/server/session';

// POST, from the header's form: a GET that signs out is a link any page could plant.
export const POST: RequestHandler = async ({ cookies, url }) => {
	cookies.delete(SESSION_COOKIE, cookieOptions(url));
	throw redirect(303, '/signin');
};
