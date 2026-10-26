/// <reference types="@sveltejs/kit" />

import type { ListedPlugin } from '$lib/server/plugins';
import type { Session } from '$lib/server/session';

declare global {
	namespace App {
		interface Locals {
			/** The visitor's session — their key and its scope — or null before sign-in (hooks.server.ts). */
			session: Session | null;
			/** Whether the request came in by the break-glass port (SMD-3307; listener.ts onBreakGlass, hooks.server.ts). */
			breakglass: boolean;
			/** Its listener's session cookie's name (listener.ts sessionCookieName, hooks.server.ts). */
			sessionCookie: string;
			/** The plugin registry this request read, shared by the layout's nav and a plugin page's load ($lib/server/plugins). */
			plugins?: Promise<ListedPlugin[]>;
		}
	}
}

export {};
