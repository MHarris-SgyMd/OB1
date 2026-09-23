# 131. enhanced-mcp's read tools address a thought by its UUID — `get_thought` and `related_thoughts` can reach a row on this fork, and the entity tools carry an id as the schema declares it (SMD-1525)

**What changed.** `integrations/enhanced-mcp/index.ts`: `ThoughtRow.id` is a
string; `get_thought` takes `id: z.string().uuid()` and `related_thoughts`
`thought_id: z.string().uuid()`, each read through `asString` where `asInteger`
clamped it to a positive integer; `entity_detail` takes `entity_id` as a string
or an integer (`z.union`) and passes it to the query as it arrived;
`graph_search` and `entity_detail` key their maps — thought counts per entity,
mention roles per thought, names per connected entity — by `String(id)` and
carry the raw ids into `.in()` lists, where every `as number` cast was. The
README's tool table says which id each of the three takes, and the fork
callout no longer says the read tools cannot address a row.

**Why.** Upstream's enhanced schema had `thoughts.id BIGINT`; this fork's is a
UUID (`db/migrations/001`). SMD-1228 (change 69) moved `update_thought` to the
UUID and left the reads, since that ticket was about writes: `get_thought` took
`z.number().int().min(1)`, so a client could pass only an id the schema refused
or an integer that matched no row, and `related_thoughts` bound an integer to
`get_thought_connections(p_thought_id UUID)` — the enhanced-thoughts sidecar's
own signature — and failed at the call. The entity tools read
`schemas/knowledge-graph`, which this tree does not carry (the fork's entity
tables are `db/migrations/016`'s `ob1_entities`, with UUID ids); they degrade
to "install the schema" here, and on a brain that has the schema they now take
whichever id type it declares rather than a number only. SMD-1798 moves this
server onto the SQL shim and names this ticket as its prerequisite, so its
reads can reach a row at all once driven.

**Held.** `extensions/test-writes.ts`, in the enhanced-mcp block after the
edit: `get_thought` with the planted row's UUID answers the row (the id and
the edited text in `structuredContent.thought`); an integer id is refused by
the schema, not looked up; an unknown UUID is "not found"; `related_thoughts`
with the UUID reaches `get_thought_connections` and answers a result list for
that id rather than an rpc error. test-writes 285/285 on the changed file.

**Not taken.** Accepting an integer as well, as `rest-api`'s `validateId`
does, so the file still works against upstream's schema: this fork's
`thoughts.id` is a UUID everywhere, `update_thought` in the same file already
takes only that, and a second accepted shape on a read tool is a second thing
to explain for a row that cannot exist here. Rewriting the entity tools for
the fork's own `ob1_entities` tables: a different schema with different
columns (`canonical_name` and `entity_type` against 016's names), which is a
port, not an id fix — the tools keep degrading honestly when
`schemas/knowledge-graph` is absent.

**Upstream status:** not sent — upstream's `thoughts.id` is the integer these
tools were written for.
