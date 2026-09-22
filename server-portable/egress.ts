/**
 * egress.ts — what content may leave the box for a model call (SMD-1903).
 *
 * Every embedding and chat call carries a thought's full text to whatever
 * `OB1_LLM_BASE_URL` (and, since SMD-1902, `OB1_CHAT_BASE_URL`) names. With a
 * hosted provider that is every capture, every consolidation pair, every
 * entity pass, and the only policy was which URL the operator typed. For a
 * brain holding protected health information that is a compliance boundary,
 * not a preference. This module is the one rule that decides, BEFORE a call
 * is made, whether the text may go.
 *
 * Three things about its shape are decisions, not accidents:
 *
 * 1. The gate is deterministic first. It reads what is already known about
 *    the text — who is sending it (the access key), the row's own `source`,
 *    `type` and `topics`, a literal marker in the text — against terms the
 *    operator wrote down. A classifier may be attached as a SECOND opinion and
 *    can only make the answer stricter: a detector that is right 98% of the
 *    time is a compliance failure two times in a hundred, so it never gets to
 *    say yes. (`mayLeaveBox` consults it only on an answer that is already
 *    "allowed", and a hook that throws refuses.)
 *
 * 2. "Local" is declared, never guessed. `OB1_LLM_LOCAL=1` / `OB1_CHAT_LOCAL=1`
 *    say an endpoint is on this machine or its private network; a loopback
 *    address, the container-to-host alias and the compose service name are
 *    all treated as remote until the flag says otherwise. Preflight already
 *    guesses "local" from the hostname to decide whether a CREDENTIAL is
 *    needed (db/config.mjs isLocalHostname), and that guess is fine for that
 *    question — an unneeded key is a warning. It is the wrong basis for
 *    "may this text leave": a hostname is whatever DNS says it is today.
 *
 * 3. Deny by default. Unset, `OB1_EGRESS_POLICY` is `deny`: nothing reaches an
 *    endpoint not declared local unless an `OB1_EGRESS_ALLOW` term matches.
 *    A deployment that upgrades without reading the notes loses no text — a
 *    refused capture still lands, without a vector, and says so — and
 *    preflight names the one line that fixes it. `allow` (everything leaves
 *    unless an `OB1_EGRESS_DENY` term matches) and `off` (no gate) are the
 *    operator's to choose, in words. A knob that does not parse fails
 *    CLOSED: the effective mode is deny and preflight fails the row.
 *
 * Nothing here dials a provider or reads a database. embed.ts's providerCall,
 * consolidate.ts's judgePair and entities.ts's extractEntities each call
 * `mayLeaveBox` with the subject they are about to send and refuse on a
 * denial, so no call the fork makes is ungated; the server's capture and
 * search paths ask first and skip the call, so a refused capture costs no
 * request and the reply says why.
 */

import type { ProviderEndpoint } from "./embed.ts";

/** The three modes, as `OB1_EGRESS_POLICY` names them. */
export const EGRESS_MODES = ["deny", "allow", "off"] as const;
export type EgressMode = (typeof EGRESS_MODES)[number];

/** Unset means deny: the gate refuses what the operator has not allowed in words. */
export const DEFAULT_EGRESS_MODE: EgressMode = "deny";

/**
 * The units a term may name. `actor` is the access key's name (auth.ts);
 * `source`, `type` and `topic` read the row's metadata, so they decide for the
 * passes and the re-embed over rows already tagged and are unknown at a first
 * capture (the tags come FROM the call being gated); `marker` is a literal the
 * text contains — `#public`, `[phi]` — the one unit a writer controls per
 * thought.
 */
export const EGRESS_UNITS = ["actor", "source", "type", "topic", "marker"] as const;
export type EgressUnit = (typeof EGRESS_UNITS)[number];

/**
 * The units a row carries on its own — its metadata and its text — which is
 * what a pass sends when no worker key names an actor. The three workers pass
 * this to refusesEverything; one definition, so a fourth unit lands in all of
 * them (boyscout: each had its own copy).
 */
export const ROW_UNITS = ["source", "type", "topic", "marker"] as const satisfies readonly EgressUnit[];

export type EgressTerm = { unit: EgressUnit; value: string };

/** The environment keys this module reads. A subset of embed.ts's EmbedEnv. */
export type EgressEnv = {
  OB1_EGRESS_POLICY?: string;
  OB1_EGRESS_ALLOW?: string;
  OB1_EGRESS_DENY?: string;
};

export type EgressPolicy = {
  /** The mode in force. `deny` whenever `problems` is non-empty, whatever the knob said. */
  mode: EgressMode;
  /** What `OB1_EGRESS_POLICY` said when it parsed; undefined when unset (the default applied). */
  configured: EgressMode | undefined;
  /** Terms read under `deny`: a match lets the text leave. */
  allow: EgressTerm[];
  /** Terms read under `allow`: a match keeps the text in. */
  deny: EgressTerm[];
  /**
   * Every value that did not parse — a mode outside the three, a term that is
   * not `unit:value`. Each one fails closed: the mode is deny, and preflight
   * prints them as failures with the fix.
   */
  problems: string[];
};

/** An on/off flag as the fork's other on/off knobs read it: 1, on, true, yes; trimmed; anything else is off. */
export function flagOn(raw: string | undefined): boolean {
  return /^(1|on|true|yes)$/i.test((raw ?? "").trim());
}

/**
 * Comma-separated `unit:value` terms. The value is trimmed and kept as written
 * (matching is case-insensitive); a colon inside it is the value's own, so a
 * marker may be `marker:phi:yes`. An entry that is not a term is a problem
 * named with its knob, and the whole policy fails closed on it.
 */
export function parseEgressTerms(raw: string | undefined, knob: string): { terms: EgressTerm[]; problems: string[] } {
  const terms: EgressTerm[] = [];
  const problems: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const t = entry.trim();
    if (!t) continue;
    const at = t.indexOf(":");
    const unit = at < 0 ? "" : t.slice(0, at).trim().toLowerCase();
    const value = at < 0 ? "" : t.slice(at + 1).trim();
    if (!(EGRESS_UNITS as readonly string[]).includes(unit) || !value) {
      problems.push(`${knob}: \`${t}\` is not unit:value (units: ${EGRESS_UNITS.join(", ")})`);
      continue;
    }
    terms.push({ unit: unit as EgressUnit, value });
  }
  return { terms, problems };
}

/**
 * The policy from the environment. Empty and whitespace mean unset, as for
 * every knob embed.ts reads (SMD-1843).
 */
export function resolveEgressPolicy(env: EgressEnv): EgressPolicy {
  const rawMode = (env.OB1_EGRESS_POLICY ?? "").trim().toLowerCase();
  const problems: string[] = [];
  let configured: EgressMode | undefined;
  if (rawMode) {
    if ((EGRESS_MODES as readonly string[]).includes(rawMode)) configured = rawMode as EgressMode;
    else problems.push(`OB1_EGRESS_POLICY: \`${env.OB1_EGRESS_POLICY?.trim()}\` is not one of ${EGRESS_MODES.join(", ")}`);
  }
  const allow = parseEgressTerms(env.OB1_EGRESS_ALLOW, "OB1_EGRESS_ALLOW");
  const deny = parseEgressTerms(env.OB1_EGRESS_DENY, "OB1_EGRESS_DENY");
  problems.push(...allow.problems, ...deny.problems);
  // Fail closed: a policy that could not be read is not a policy that allows.
  const mode: EgressMode = problems.length ? "deny" : (configured ?? DEFAULT_EGRESS_MODE);
  return { mode, configured, allow: allow.terms, deny: deny.terms, problems };
}

/**
 * What is about to be sent, in the terms the policy reads. `kind` names the
 * call for the reason text; the rest is whatever the caller knows — a capture
 * knows its actor and text, a pass knows the row's metadata, a query knows
 * the actor and the query text.
 */
export type EgressSubject = {
  kind: "capture" | "edit" | "query" | "re-embed" | "judge" | "extraction";
  /** The access key's name — the `actor` unit. Absent for a pass with no worker key. */
  actor?: string;
  /** The row's metadata — the `source`, `type` and `topic` units. */
  metadata?: Record<string, unknown>;
  /** The text — the `marker` unit. */
  content?: string;
};

export type EgressDecision = {
  allowed: boolean;
  /**
   * Which rule decided, as a short token for a record: `local`, `off`,
   * `allow-term`, `no-allow-term`, `deny-term`, `no-deny-term`,
   * `second-opinion`.
   */
  rule: string;
  /** One sentence naming the rule and the knob, for a reply or a claim row. */
  reason: string;
};

/**
 * A second opinion on a subject the deterministic rules ALLOWED: `sensitive`
 * refuses it. It is never asked about a refused subject, so it cannot allow;
 * a hook that throws refuses. The Jev-class detector SMD-1897 spikes would
 * attach here, at most.
 */
export type SecondOpinion = (subject: EgressSubject) => { sensitive: boolean; reason?: string };

const lower = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** Whether one term names this subject. Exact, case-insensitive; `marker` is a substring of the text. */
export function termMatches(term: EgressTerm, subject: EgressSubject): boolean {
  const want = term.value.toLowerCase();
  switch (term.unit) {
    case "actor":
      return lower(subject.actor) === want;
    case "source":
      return lower(subject.metadata?.source) === want;
    case "type":
      return lower(subject.metadata?.type) === want;
    case "topic": {
      const topics = subject.metadata?.topics;
      return Array.isArray(topics) && topics.some((t) => lower(t) === want);
    }
    case "marker":
      return (subject.content ?? "").toLowerCase().includes(want);
  }
}

const showTerm = (t: EgressTerm): string => `${t.unit}:${t.value}`;

/** The host a base URL names, for a reason; the URL itself when it does not parse. */
export function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/**
 * The gate. One pure function: the subject, the endpoint it would be sent to
 * (only `base` and `local` are read), the policy, and optionally a second
 * opinion that can only tighten the answer.
 */
export function mayLeaveBox(
  subject: EgressSubject,
  endpoint: Pick<ProviderEndpoint, "base" | "local">,
  policy: EgressPolicy,
  secondOpinion?: SecondOpinion,
): EgressDecision {
  const host = hostOf(endpoint.base);
  if (endpoint.local) {
    return { allowed: true, rule: "local", reason: `${host} is declared local — the text stays on the box` };
  }
  let decision: EgressDecision;
  const closed = policy.problems.length ? ` (the policy did not parse — ${policy.problems.join("; ")} — so the gate fails closed)` : "";
  if (policy.mode === "off") {
    decision = { allowed: true, rule: "off", reason: `OB1_EGRESS_POLICY=off — the gate is off; the text leaves to ${host}` };
  } else if (policy.mode === "deny") {
    const hit = policy.allow.find((t) => termMatches(t, subject));
    decision = hit
      ? { allowed: true, rule: "allow-term", reason: `allowed to leave to ${host} by OB1_EGRESS_ALLOW ${showTerm(hit)}` }
      : {
          allowed: false,
          rule: "no-allow-term",
          reason: `OB1_EGRESS_POLICY=deny${policy.configured === undefined && !closed ? " (the default)" : ""}${closed} and no OB1_EGRESS_ALLOW term matches this ${subject.kind}${policy.allow.length ? ` (${policy.allow.map(showTerm).join(", ")})` : " (none set)"} — the text was not sent to ${host}`,
        };
  } else {
    const hit = policy.deny.find((t) => termMatches(t, subject));
    decision = hit
      ? { allowed: false, rule: "deny-term", reason: `OB1_EGRESS_DENY ${showTerm(hit)} matches this ${subject.kind} — the text was not sent to ${host}` }
      : { allowed: true, rule: "no-deny-term", reason: `OB1_EGRESS_POLICY=allow and no OB1_EGRESS_DENY term matches — the text leaves to ${host}` };
  }
  // Only an allowed answer is put to the second opinion, and only "sensitive"
  // changes it. A refused subject is never asked about, so the hook has no way
  // to allow; a hook that fails refuses, since "could not decide" is not "yes".
  if (decision.allowed && secondOpinion) {
    try {
      const o = secondOpinion(subject);
      if (o.sensitive) {
        decision = { allowed: false, rule: "second-opinion", reason: `refused by the second opinion${o.reason ? `: ${o.reason}` : ""} — the text was not sent to ${host}` };
      }
    } catch (e) {
      decision = { allowed: false, rule: "second-opinion", reason: `the second opinion failed (${(e as Error).message}) — refused; the text was not sent to ${host}` };
    }
  }
  return decision;
}

/**
 * What a write records about the decisions made for it, on the audit row
 * (thought_audit.actor_context, through the actor envelope — every key the
 * trigger does not read by name lands there). One entry per endpoint that is
 * NOT declared local, allowed or refused: a fully local deployment records
 * nothing, since nothing was judged. This is the provenance SMD-1729's
 * program will shape into a typed event; until then it is where "which rule
 * fired, which provider was dialled or refused" lives.
 */
export type EgressRecord = {
  policy: EgressMode;
  embeddings?: { to: string; allowed: boolean; rule: string };
  chat?: { to: string; allowed: boolean; rule: string };
};

/**
 * Both decisions for one subject — the embeddings call and the chat call —
 * and the record of them, undefined when both endpoints are declared local.
 * The server's capture and edit paths call this once and make only the calls
 * it allows.
 */
export function decideCalls(
  subject: EgressSubject,
  endpoints: { embeddings: ProviderEndpoint; chat: ProviderEndpoint },
  policy: EgressPolicy,
  secondOpinion?: SecondOpinion,
): { embeddings: EgressDecision; chat: EgressDecision; record: EgressRecord | undefined } {
  const embeddings = mayLeaveBox(subject, endpoints.embeddings, policy, secondOpinion);
  const chat = mayLeaveBox(subject, endpoints.chat, policy, secondOpinion);
  const record: EgressRecord = { policy: policy.mode };
  if (!endpoints.embeddings.local) record.embeddings = { to: hostOf(endpoints.embeddings.base), allowed: embeddings.allowed, rule: embeddings.rule };
  if (!endpoints.chat.local) record.chat = { to: hostOf(endpoints.chat.base), allowed: chat.allowed, rule: chat.rule };
  return { embeddings, chat, record: record.embeddings || record.chat ? record : undefined };
}

/**
 * The refusal that does not depend on the row: an endpoint not declared local
 * under deny with no allow term, or under a policy that did not parse. A
 * worker asks this before claiming anything — every row would fail the same
 * way, and a pass that marks the whole pool failed one row at a time says
 * nothing this one line does not (first review pass). Null when some row
 * might pass: a term might match, or the mode lets text through.
 */
export function refusesEverything(endpoint: Pick<ProviderEndpoint, "base" | "local">, policy: EgressPolicy, units: readonly EgressUnit[] = EGRESS_UNITS): string | null {
  if (endpoint.local) return null;
  const host = hostOf(endpoint.base);
  if (policy.problems.length) return `the egress policy did not parse (${policy.problems.join("; ")}), so the gate fails closed and every call to ${host} is refused`;
  if (policy.mode === "deny") {
    const mode = `OB1_EGRESS_POLICY=deny${policy.configured === undefined ? " (the default)" : ""}`;
    if (!policy.allow.length) return `${mode} with no OB1_EGRESS_ALLOW term, and ${host} is not declared local — every call is refused`;
    // A term over a unit this caller never carries can match nothing it
    // sends: a pass has no actor unless a worker key names one (second
    // review pass — actor: terms alone read as "some row might pass").
    if (!policy.allow.some((t) => units.includes(t.unit))) {
      return `${mode}, and every OB1_EGRESS_ALLOW term (${policy.allow.map(showTerm).join(", ")}) names a unit this caller never carries (it carries ${units.join(", ")}), and ${host} is not declared local — every call is refused`;
    }
  }
  return null;
}

/**
 * The knob that declares an endpoint local, for a banner or a remedy: the one
 * that DID when it is declared (`declaredBy`, so a shared endpoint declared by
 * OB1_CHAT_LOCAL alone is named by it — second review pass); otherwise
 * OB1_LLM_LOCAL for the embeddings endpoint and for a chat endpoint at the
 * same base, OB1_CHAT_LOCAL for a chat endpoint of its own.
 */
export function localKnob(endpoints: { embeddings: ProviderEndpoint; chat: ProviderEndpoint }, which: "embeddings" | "chat"): string {
  const at = endpoints[which];
  if (at.local && at.declaredBy) return at.declaredBy;
  if (which === "embeddings") return "OB1_LLM_LOCAL";
  // The same base: the embeddings knob declares both, and is the one to set
  // when neither is declared. Only a chat endpoint declared by its own knob
  // while the embeddings one is not (first review pass) names OB1_CHAT_LOCAL.
  const sameBase = endpoints.chat.base === endpoints.embeddings.base;
  return sameBase && (endpoints.embeddings.local || !endpoints.chat.local) ? "OB1_LLM_LOCAL" : "OB1_CHAT_LOCAL";
}

/**
 * One line for a worker's banner or a preflight row: what the gate does for
 * calls to this endpoint under this policy, in words.
 */
export function describeEgress(endpoint: ProviderEndpoint, policy: EgressPolicy, knob: string): string {
  const host = hostOf(endpoint.base);
  if (endpoint.local) return `${host} is declared local (${knob}) — the gate does not apply`;
  const closed = policy.problems.length ? `; the policy did not parse (${policy.problems.join("; ")}), so the gate fails closed` : "";
  switch (policy.mode) {
    case "off":
      return `off — every call carries the text to ${host}, which is not declared local`;
    case "allow":
      return `allow — every call carries the text to ${host} except under OB1_EGRESS_DENY (${policy.deny.length ? policy.deny.map(showTerm).join(", ") : "no terms"})`;
    case "deny":
      return `deny${policy.configured === undefined && !closed ? " (the default)" : ""} — the text reaches ${host} only under OB1_EGRESS_ALLOW (${policy.allow.length ? policy.allow.map(showTerm).join(", ") : "no terms: every call is refused"})${closed}`;
  }
}
