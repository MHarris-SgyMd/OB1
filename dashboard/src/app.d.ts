/// <reference types="@sveltejs/kit" />

import type { Session } from '$lib/server/session';

declare global {
	namespace App {
		interface Locals {
			/** The visitor's session — their key and its scope — or null before sign-in (hooks.server.ts). */
			session: Session | null;
		}
	}
}

export {};
