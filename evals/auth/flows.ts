/**
 * flows.ts — the verifier's browser and token client (SMD-2285).
 *
 * `Browser` follows an authorization request the way a user agent does:
 * redirects one at a time, cookies kept by path, and at each sign-in or consent
 * page it submits the page's own form (the password, or Allow). It stops at the
 * redirect to the client's redirect URI and returns that URL's parameters. It
 * knows nothing candidate-specific beyond `data-prompt` on the page, so a
 * second candidate need only render the same two forms.
 *
 * The rest are plain RFC 6749 / 8693 / 7636 requests and a JWT payload reader.
 * No signature is checked here: the stand-ins verify signatures, and the
 * verifier reads claims only to compare them.
 */
import { createHash, randomBytes } from "node:crypto";

type Cookie = { value: string; path: string };

export class Browser {
  private cookies = new Map<string, Cookie>();
  /** The Origin its consent form is posted with, when a check plays a page of another origin (a CSRF): the page's own otherwise. */
  consentOrigin?: string;
  /** Every page it answered (`login`, `consent`), in order: a check that a user signed in reads this. */
  readonly prompts: string[] = [];
  /** The text of each page it answered, in the same order, so a check can read what the operator was shown. */
  readonly pages: string[] = [];
  /** The headers of each page it answered, in the same order. */
  readonly pageHeaders: Headers[] = [];

  constructor(private password: string) {}

  private cookieHeader(url: URL): string {
    return [...this.cookies].filter(([, c]) => url.pathname === c.path || url.pathname.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`)).map(([n, c]) => `${n}=${c.value}`).join("; ");
  }

  private keep(url: URL, res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";").map((s) => s.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const path = attrs.find((a) => /^path=/i.test(a))?.slice(5) || url.pathname.replace(/\/[^/]*$/, "") || "/";
      const expired = attrs.some((a) => /^max-age=0$/i.test(a) || (/^expires=/i.test(a) && Date.parse(a.slice(8)) < Date.now()));
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, { value, path });
    }
  }

  async request(url: URL, init: { method?: string; body?: URLSearchParams; origin?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = { cookie: this.cookieHeader(url) };
    // A browser sends Origin on every POST.
    if ((init.method ?? "GET") === "POST") headers.origin = init.origin ?? url.origin;
    if (init.body) headers["content-type"] = "application/x-www-form-urlencoded";
    const res = await fetch(url, { method: init.method ?? "GET", headers, body: init.body, redirect: "manual" });
    this.keep(url, res);
    return res;
  }

  /**
   * Drive an authorization URL to the redirect back to `redirectUri`, and
   * return that redirect's query. `consent` false presses Deny instead. A page
   * that is neither sign-in nor consent, or a non-redirect error, throws with
   * the body's start.
   */
  async authorize(start: string | URL, redirectUri: string, consent = true): Promise<URLSearchParams> {
    let url = new URL(start);
    let res = await this.request(url);
    for (let step = 0; step < 20; step++) {
      if (res.status >= 300 && res.status < 400) {
        const next = new URL(res.headers.get("location") ?? "", url);
        if (next.href.startsWith(redirectUri)) return next.searchParams;
        url = next;
        res = await this.request(url);
        continue;
      }
      const body = await res.text();
      const prompt = /data-prompt="([^"]+)"/.exec(body)?.[1];
      if (res.status !== 200 || (prompt !== "login" && prompt !== "consent")) {
        throw new Error(`authorization stopped at ${url.pathname}: HTTP ${res.status} ${body.slice(0, 200).replace(/\s+/g, " ")}`);
      }
      this.prompts.push(prompt);
      this.pageHeaders.push(res.headers);
      this.pages.push(body.replace(/<[^>]+>/g, " ").replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ").trim());
      const forms = [...body.matchAll(/<form method="post" action="([^"]+)"/g)].map((m) => m[1].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))));
      // By path: a form's action may carry the interaction's own query (Better Auth's signed one).
      const action = prompt === "login" ? forms[0] : forms.find((f) => new URL(f, url).pathname.endsWith(consent ? "/confirm" : "/abort"));
      if (!action) throw new Error(`no ${prompt} form at ${url.pathname}`);
      url = new URL(action, url);
      res = await this.request(url, { method: "POST", body: new URLSearchParams(prompt === "login" ? { password: this.password } : {}), origin: prompt === "consent" ? this.consentOrigin : undefined });
    }
    throw new Error("authorization did not finish in 20 steps");
  }
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export type TokenReply = { status: number; body: Record<string, unknown> };

/** POST to a token endpoint, with HTTP Basic client authentication when a secret is given. */
export async function tokenRequest(endpoint: string, params: Record<string, string | string[]>, client?: { id: string; secret?: string }): Promise<TokenReply> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const one of [v].flat()) body.append(k, one);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (client?.secret !== undefined) headers.authorization = `Basic ${btoa(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`)}`;
  else if (client) body.set("client_id", client.id);
  const r = await fetch(endpoint, { method: "POST", headers, body });
  return { status: r.status, body: ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown> };
}

export type Claims = { iss?: string; sub?: string; iat?: number; aud?: string | string[]; exp?: number; scope?: string; client_id?: string; act?: { sub?: string } };

/** A JWT's payload, unverified. */
export function claimsOf(jwt: unknown): Claims {
  const part = String(jwt).split(".")[1] ?? "";
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString()) as Claims;
  } catch {
    return {};
  }
}

/** A token whose signature no longer matches: one character of the signature changed. */
export function tampered(jwt: string): string {
  const last = jwt.at(-2) === "A" ? "B" : "A";
  return `${jwt.slice(0, -2)}${last}${jwt.slice(-1)}`;
}
