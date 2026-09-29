#!/usr/bin/env bun
/**
 * test-worker-bootstrap.ts — the db/ claim workers' shared bootstrap
 * (db/worker-bootstrap.ts, SMD-2134 cut 3 / SMD-2303), hermetic.
 *
 * No Postgres, no model, no network. Covers the egress slice: the banner line,
 * the bare refusal reason, the blanket-gate sentence (verb and knob as
 * parameters, one remedy tail), and the identity re-gate wording — with the
 * drop-the-gate mutant, that a remote endpoint under the default deny is
 * refused while a local one proceeds.
 */

import { providerEndpoint } from "../server-portable/embed.ts";
import { resolveEgressPolicy, ROW_UNITS } from "../server-portable/egress.ts";
import { hashKey } from "../server-portable/auth.ts";
import { blanketGate, egressDescription, egressRefusal, regateMessage, workerIdentity } from "./worker-bootstrap.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); }
}

// A remote endpoint the gate has a say over, and a local one it does not.
const remote = providerEndpoint("https://api.openai.com", "k", false);
const local = providerEndpoint("http://localhost:11434", undefined, true, "OB1_LLM_LOCAL");
// The default policy: deny, no allow terms — every remote call refused.
const deny = resolveEgressPolicy({});

// ---------------------------------------------------------------------------
// egressRefusal — the bare reason, or null.
// ---------------------------------------------------------------------------
{
  const reason = egressRefusal(remote, deny, ROW_UNITS);
  ok(reason !== null && /deny \(the default\)/.test(reason) && /api\.openai\.com/.test(reason),
    "a remote endpoint under the default deny is refused, and the reason names the policy and the host");
  ok(egressRefusal(local, deny, ROW_UNITS) === null, "a local endpoint is never refused — the gate does not apply");
  // Drop-the-gate mutant: were the gate not consulted, the remote reason would
  // be null like the local one. The two must differ.
  ok(egressRefusal(remote, deny, ROW_UNITS) !== egressRefusal(local, deny, ROW_UNITS),
    "the gate distinguishes the remote endpoint from the local one (drop-the-gate mutant)");
}

// ---------------------------------------------------------------------------
// The units default — the optimistic keyed gate. With a worker key set the
// workers pass units=undefined, which credits the full set (an actor among
// them); the keyless caller passes ROW_UNITS, which carries no actor. Under a
// deny policy whose only allow term is an actor:, the two must differ — the
// keyed gate passes, the keyless one (and the identity re-gate) is refused.
// ---------------------------------------------------------------------------
{
  const actorAllow = resolveEgressPolicy({ OB1_EGRESS_ALLOW: "actor:someone" });
  ok(egressRefusal(remote, actorAllow, undefined) === null,
    "units undefined reaches the default EGRESS_UNITS (an actor among them): an actor: allow term lets the optimistic keyed gate pass");
  const keyless = egressRefusal(remote, actorAllow, ROW_UNITS);
  ok(keyless !== null && /names a unit this caller never carries/.test(keyless),
    "the same policy refuses a ROW_UNITS caller — it carries no actor for the actor: term to match (the re-gate case)");
}

// ---------------------------------------------------------------------------
// blanketGate — the worker's full "Nothing would be <verb>" sentence.
// ---------------------------------------------------------------------------
{
  const refused = blanketGate({ endpoint: remote, policy: deny, units: ROW_UNITS, verb: "extracted", localKnobKey: "OB1_CHAT_LOCAL" });
  ok(refused !== null && refused.startsWith("Nothing would be extracted: "), "the sentence opens with the pass's own verb");
  ok(refused !== null && refused.includes("Declare the endpoint local (OB1_CHAT_LOCAL=1) if it is, name what may leave in OB1_EGRESS_ALLOW, or set OB1_EGRESS_POLICY — in words, before a pass that would fail every row it claims."),
    "the remedy tail is one text, and names the knob it was given");
  // The verb is the only thing that changes between workers.
  const judged = blanketGate({ endpoint: remote, policy: deny, units: ROW_UNITS, verb: "judged", localKnobKey: "OB1_CHAT_LOCAL" });
  ok(judged !== null && judged.startsWith("Nothing would be judged: "), "another worker gets the same sentence with its own verb");
  ok(refused !== null && judged !== null && refused.slice("Nothing would be extracted".length) === judged.slice("Nothing would be judged".length),
    "only the verb differs — the reason and the remedy are identical");
  // A pass that may run gets no refusal (drop-the-gate: a local endpoint proceeds).
  ok(blanketGate({ endpoint: local, policy: deny, units: ROW_UNITS, verb: "re-embedded", localKnobKey: "OB1_LLM_LOCAL" }) === null,
    "a local endpoint returns null — the pass proceeds");
}

// ---------------------------------------------------------------------------
// regateMessage — the identity re-gate wording.
// ---------------------------------------------------------------------------
{
  const reason = egressRefusal(remote, deny, ROW_UNITS)!;
  const msg = regateMessage("extracted", reason);
  ok(msg.startsWith("Nothing would be extracted: ") && msg.endsWith(" — the worker key did not resolve, so the pass carries no actor for an actor: term to name."),
    "the re-gate names the pass's verb and says the key did not resolve to an actor");
  ok(msg.includes(reason), "the re-gate carries the gate's own reason");
}

// ---------------------------------------------------------------------------
// egressDescription — one banner line, delegating to describeEgress.
// ---------------------------------------------------------------------------
{
  const line = egressDescription(remote, deny, "OB1_CHAT_LOCAL");
  ok(/deny/.test(line) && /api\.openai\.com/.test(line), "the banner line says what the gate does for the endpoint");
  ok(/is declared local \(OB1_LLM_LOCAL\)/.test(egressDescription(local, deny, "OB1_LLM_LOCAL")), "a local endpoint's banner says the gate does not apply");
}

// ---------------------------------------------------------------------------
// workerIdentity — the cases that refuse or warn before a store is opened, so no
// database is needed (the URL is never dialled). The resolve cases (a valid key,
// a REVOKED one) need resolve_agent and live in test-live.ts.
// ---------------------------------------------------------------------------
const UNUSED_URL = "postgres://unused@127.0.0.1:1/none";
{
  const warned: string[] = [];
  const noKey = await workerIdentity(UNUSED_URL, {}, { noKeyWarning: "  ⚠  no key here", warn: (l) => warned.push(l) });
  ok(noKey.ok && noKey.identity.agentId === null && noKey.identity.keyName === undefined, "no worker key: the identity is empty — the pass carries no agent");
  ok(warned.length === 1 && warned[0] === "  ⚠  no key here", "no worker key: the caller's own warning is printed");

  const noAccessKeys = await workerIdentity(UNUSED_URL, { OB1_WORKER_KEY: "raw" }, { noKeyWarning: "unused" });
  ok(!noAccessKeys.ok && /OB1_WORKER_KEY is set but MCP_ACCESS_KEYS is not/.test(noAccessKeys.message), "a key set with no MCP_ACCESS_KEYS is refused, and the message says why");

  const notListed = await workerIdentity(UNUSED_URL, { OB1_WORKER_KEY: "raw", MCP_ACCESS_KEYS: `someone:write:${hashKey("a-different-key")}` }, { noKeyWarning: "unused" });
  ok(!notListed.ok && /OB1_WORKER_KEY is not one of the keys in MCP_ACCESS_KEYS/.test(notListed.message), "a key absent from MCP_ACCESS_KEYS is refused — the server would refuse it too");
}

console.log(`\ntest-worker-bootstrap: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
