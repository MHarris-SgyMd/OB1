/**
 * pages.ts — the authorization server's sign-in and consent pages (SMD-2285).
 *
 * oidc-provider ships no pages; it hands the server an interaction to show.
 * The proof of concept's runner-up (evals/auth/better-auth.ts) renders the
 * same HTML from here, so the verifier's Browser (evals/auth/flows.ts) drives
 * either candidate with the same forms, and a check on what the operator is
 * shown means the same thing for both.
 *
 * The page names what the server checked, not what the client calls itself:
 * the `client_id` (for a metadata document, its host), where the code goes (an
 * http(s) redirect's origin, or for any other scheme the app that owns it),
 * and the scopes and resources the request names, which bound what the token
 * can carry. Every interpolated value is escaped.
 */
/**
 * Headers every interaction page carries: no other page may frame it. Without
 * them, a same-site page could frame the consent page and have one disguised
 * click post it from the brain's own origin, past the Origin check.
 */
export const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
};

export const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A whole page, marked with the prompt it asks for (`login`, `consent`, or `none` for an error). */
export function pageHtml(prompt: string, body: string): string {
  return `<!doctype html><title>Open Brain sign-in</title><main data-prompt="${esc(prompt)}">${body}</main>`;
}

export type Asking = {
  clientId: string;
  /** The client's own name for itself, shown only as its claim. */
  clientName?: string;
  redirectUri: string;
  scope: string;
  resources: string[];
};

/** Who is asking, and where the code goes. */
export function who(a: Asking): string {
  const checked = /^https:\/\//i.test(a.clientId) ? `the client published at ${new URL(a.clientId).host}` : `client ${a.clientId}`;
  // An http(s) redirect's origin; any other scheme is an app on the device,
  // whichever owns that scheme, so its host means nothing.
  const destination = (() => {
    try {
      const u = new URL(a.redirectUri);
      return u.protocol === "http:" || u.protocol === "https:" ? `returning to ${u.origin}` : `returning to the app registered for ${u.protocol} (${u.href})`;
    } catch {
      return `returning to ${a.redirectUri}`;
    }
  })();
  const said = a.clientName ? ` (it calls itself &ldquo;${esc(a.clientName)}&rdquo;)` : "";
  return `<strong>${esc(checked)}</strong>${said}, <strong>${esc(destination)}</strong>`;
}

/** The sign-in page. `action` is where its one form posts the password; a spent sign-in has no form. */
export function loginPage(a: Asking, action: string, { wrong = false, note = "", form = true }: { wrong?: boolean; note?: string; form?: boolean } = {}): string {
  const fields = form ? `<form method="post" action="${esc(action)}"><input type="password" name="password" autocomplete="current-password"><button>Sign in</button></form>` : "";
  return pageHtml("login", `${wrong ? "<p>Wrong password.</p>" : ""}${note ? `<p>${esc(note)}</p>` : ""}<p>Sign in to let ${who(a)} reach your brain.</p>${fields}`);
}

/** The consent page, with an Allow form posting to `confirm` and a Deny form posting to `abort`. */
export function consentPage(a: Asking, confirm: string, abort: string): string {
  const asked = a.scope.split(" ").filter(Boolean);
  const offline = asked.includes("offline_access") ? " It may keep access after you close it (<code>offline_access</code>)." : "";
  return pageHtml(
    "consent",
    `<p>${who(a)}, asks for <code>${esc(asked.join(" "))}</code> on <code>${esc(a.resources.join(" "))}</code>.${offline}</p><form method="post" action="${esc(confirm)}"><button>Allow</button></form><form method="post" action="${esc(abort)}"><button>Deny</button></form>`,
  );
}
