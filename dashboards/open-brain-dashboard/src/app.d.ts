/// <reference types="@sveltejs/kit" />

import type { DashboardSession } from '$lib/server/session';

declare global {
	namespace App {
		interface Locals {
			/** The visitor's sealed access key and scope, or null before sign-in (hooks.server.ts). */
			session: DashboardSession | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
