/**
 * ingest-structure.ts — the structure beside a row, written as migration 051
 * records it (SMD-1867): the canonical (thought_sources), the links as a set
 * (`link` facets) and the structured mentions (record_thought_entities under
 * `source:<system>`).
 *
 * Its own module, importing bun and the contract alone, because two writers
 * share it: db/ingest-records.ts (which also imports evals/ and scripts/ for
 * its fork, commit and corpus sources) and db/sync-linear.ts, which runs in
 * deploy/compose.yaml's board-sync container with db/ and server-portable/
 * mounted and NOTHING ELSE (SMD-1985 moved env.ts and linear-api.ts under db/
 * for that reason). An import of ingest-records.ts from the sync would have
 * pulled evals/ and scripts/ into the container's module graph and failed at
 * load (third review pass); sync-linear.ts's self-check holds its import
 * closure to the two mounted directories so it cannot happen again.
 */

import type { SQL } from "bun";
import type { Identity, Ingested } from "./ingest-contract.ts";

/** What a record that came through an adapter carries beside its row: the canonical, the links and the structured mentions. */
export type Structure = Pick<Ingested, "identity" | "canonical" | "links" | "mentions">;

/** A run's name for thought_sources.ingest_run — the tool and the moment it started. */
export function runName(tool: string, at: Date = new Date()): string {
  return `${tool}@${at.toISOString()}`;
}

/** The counts one structure write reports. */
export type StructureResult = { canonical: string; links: { added: number; closed: number; kept: number; dropped: number }; mentions: number };

/** record_thought_source refused: another thought holds the (system, identity). */
export class IdentityHeld extends Error {
  constructor(public readonly identity: Identity, public readonly thoughtId: string, public readonly heldBy: string) {
    super(`${identity.system} ${identity.key} is held by thought ${heldBy}; not written on ${thoughtId}`);
    this.name = "IdentityHeld";
  }
}

/**
 * The structure beside a row, as 051 records it: the canonical
 * (record_thought_source — unchanged when it stands), the links as a set
 * (record_source_links — the same set twice writes nothing, a link the source
 * no longer states is closed) and the structured mentions
 * (record_thought_entities under `source:<system>`, confidence 1, replacing
 * only that key's rows — the resolution rule). Runs on the caller's
 * connection or transaction. db/sync-linear.ts calls it on the head row it
 * has just written, with `take`: a ticket's head row moves when an older
 * paste becomes the chain's head, and the identity follows it (the old
 * holder's links closed, its structured mentions removed). Without `take`, an
 * identity another thought holds is thrown as IdentityHeld: two thoughts
 * claiming one source item is the caller's to resolve.
 */
export async function recordStructure(sql: SQL, thoughtId: string, s: Structure, run: string, opts: { take?: boolean } = {}): Promise<StructureResult> {
  const [src] = (await sql`SELECT record_thought_source(${thoughtId}::uuid, ${s.identity.system}, ${s.identity.key}, ${s.canonical.form}, ${s.canonical.mediaType}, ${run}, ${opts.take === true}) AS r`) as { r: { ok: boolean; outcome?: string; error?: string; held_by?: string } }[];
  // IDENTITY_HELD is IdentityHeld whether or not the holder could be named —
  // a race's winner can be gone by the re-read; the refusal is the fact, the
  // name is detail (fourth review pass).
  if (!src.r.ok && src.r.error === "IDENTITY_HELD") throw new IdentityHeld(s.identity, thoughtId, src.r.held_by ?? "unknown");
  if (!src.r.ok) throw new Error(`record_thought_source(${s.identity.system} ${s.identity.key}) on ${thoughtId}: ${src.r.error}`);
  // The JSON goes over as TEXT and is cast in SQL: a JS string bound straight
  // to a `::jsonb` parameter is serialised as a JSON string — the function saw
  // `"[…]"`, a string, not an array (test-live, first review pass; db/README.md
  // "The double-encoding trap"). A JS array bound directly would be a Postgres
  // array literal, not JSON.
  const [lnk] = (await sql`SELECT record_source_links(${thoughtId}::uuid, ${s.identity.system}, ${JSON.stringify(s.links)}::text::jsonb) AS r`) as { r: { ok: boolean; added: number; closed: number; kept: number; dropped: number; error?: string } }[];
  if (!lnk.r.ok) throw new Error(`record_source_links on ${thoughtId}: ${lnk.r.error}`);
  const entities = s.mentions.map((m) => ({ name: m.name, type: m.type, confidence: 1 }));
  const [ent] = (await sql`SELECT record_thought_entities(${thoughtId}::uuid, ${`source:${s.identity.system}`}, ${JSON.stringify(entities)}::text::jsonb, '[]'::jsonb, NULL, NULL) AS r`) as { r: { ok: boolean; mentions?: number; error?: string } }[];
  if (!ent.r.ok) throw new Error(`record_thought_entities(source:${s.identity.system}) on ${thoughtId}: ${ent.r.error}`);
  return { canonical: src.r.outcome ?? "unchanged", links: { added: lnk.r.added, closed: lnk.r.closed, kept: lnk.r.kept, dropped: lnk.r.dropped }, mentions: ent.r.mentions ?? 0 };
}
