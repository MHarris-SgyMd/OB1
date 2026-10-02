/**
 * registration.ts — the bound on dynamic client registration (SMD-2285):
 * which requests are registrations, and how many may be under way at once.
 * server.ts answers a registration past the bound with 503
 * `temporarily_unavailable`; store.ts's hourly purge frees room.
 *
 * Dependency-free, so provision.ts --self-check probes it with no install.
 */

/**
 * A registration's path as the library routes it: its router folds case and
 * tries a path again without a trailing slash (oidc-provider
 * lib/helpers/router.js), so `/auth/REG` and `/auth/reg/` register as
 * `/auth/reg` does, and the bound must catch them too. The query is not part
 * of the path.
 */
export const REGISTRATION_PATH = /^\/auth\/reg\/?$/i;

/**
 * Admits a registration while the stored clients and the registrations under
 * way stay under `max`. A registration is counted from its admission to its
 * response's close: the library saves the client only after reading the body,
 * so counting the store alone let slow senders past the bound (20 admitted
 * against a bound of 3, measured). Between a client's save and its response's
 * close it is counted twice, which can refuse one registration early, never
 * admit one late.
 */
/** How long an admitted registration may take to send its body before its connection is closed and its place freed: Bun's own request timeout is 300 s (measured: 325 s). */
export const REGISTRATION_TIMEOUT_MS = 30_000;

export class RegistrationGate {
  #underWay = 0;

  constructor(
    private readonly max: number,
    private readonly stored: () => number,
  ) {}

  /** True, and a place held until release(), when one more registration fits. */
  admit(): boolean {
    if (this.stored() + this.#underWay >= this.max) return false;
    this.#underWay++;
    return true;
  }

  /** The place an admitted registration held, given back when its response closes. */
  release(): void {
    if (this.#underWay > 0) this.#underWay--;
  }

  get underWay(): number {
    return this.#underWay;
  }
}
