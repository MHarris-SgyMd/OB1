/// <reference types="@sveltejs/kit" />

import type { ListedPlugin } from '$lib/server/plugins';
import type { Session } from '$lib/server/session';

declare global {
	namespace App {
		interface Locals {
			/** The visitor's session — their key and its scope — or null before sign-in (hooks.server.ts). */
			session: Session | null;
			/** Whether the request came in by the break-glass port (SMD-3307; listener.ts), and its listener's session cookie's name (hooks.server.ts). */
			breakglass: boolean;
			sessionCookie: string;
			/** The plugin registry this request read, shared by the layout's nav and a plugin page's load ($lib/server/plugins). */
			plugins?: Promise<ListedPlugin[]>;
		}
	}
}

export {};
