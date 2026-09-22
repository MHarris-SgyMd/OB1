# OB-Graph: Knowledge Graph Layer for Open Brain

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@alanshurafa](https://github.com/alanshurafa)**

A knowledge graph you can build and query through your AI — powered by PostgreSQL, served under Bun against your Postgres, and accessed via MCP.

## Why This Matters

Your Open Brain stores thoughts, but thoughts don't exist in isolation. Projects depend on tools. People work at companies. Concepts connect to other concepts. Without explicit relationships, your AI has to re-derive connections every time you ask "how is X related to Y?" OB-Graph gives your thoughts a relationship layer — nodes for entities, edges for connections, and graph traversal to surface paths you didn't know existed.

## What It Does

Adds two tables (`graph_nodes`, `graph_edges`) and an MCP server with 10 tools for:

- **Building** a knowledge graph — create nodes (people, projects, concepts, tools) and connect them with typed edges (works_on, depends_on, related_to)
- **Querying** relationships — get direct neighbors, multi-hop traversal, and shortest-path between any two nodes
- **Linking** to existing thoughts — nodes can optionally reference a thought via `thought_id`

All graph traversal runs in PostgreSQL — `traverse_graph` uses a recursive CTE (enumerating acyclic paths) and `find_shortest_path` uses an iterative BFS with a seen-set. No external graph database needed.

## Prerequisites

- Working Open Brain setup ([Getting Started guide](../../docs/01-getting-started.md))
- Supabase project configured
- Supabase CLI installed and linked to your project

## Credential Tracker

```text
OB-GRAPH -- CREDENTIAL TRACKER
--------------------------------------

SUPABASE (from your Open Brain setup)
  Project URL:           ____________
  Secret key:            ____________
  Project ref:           ____________

GENERATED DURING SETUP
  Default User ID:       ____________
  MCP Access Key:        ____________
  MCP Server URL:        ____________
  MCP Connection URL:    ____________

--------------------------------------
```

## Setup Instructions

![Step 1](https://img.shields.io/badge/Step_1-Create_Database_Schema-2E86AB?style=for-the-badge)

<details>
<summary><strong>SQL: Create tables, indexes, RLS, and graph functions</strong> (click to expand)</summary>

Run the contents of `schema.sql` in your Supabase SQL Editor (Dashboard → SQL Editor → New Query → paste → Run).

The schema creates:

| Object | Purpose |
|--------|---------|
| `graph_nodes` | Entities in your knowledge graph |
| `graph_edges` | Directed relationships between nodes |
| `traverse_graph()` | Recursive CTE for multi-hop traversal (one row per acyclic path) |
| `find_shortest_path()` | Iterative BFS shortest path between two nodes |
| `reconstruct_bfs_path()` | Internal helper that walks the BFS parent map (service_role only) |
| RLS policies | User-scoped data isolation on both tables |
| Indexes | Fast lookups by user, type, label, source/target |

</details>

> [!IMPORTANT]
> The schema includes `GRANT` statements for `service_role` and row-level-security policies on `auth.uid()`. On a Supabase project both exist — don't skip the grants. On a plain Postgres, give the schema the three roles and the two functions first (the server connects as one role and scopes rows by `DEFAULT_USER_ID` itself; the table owner is not subject to the policies):
>
> ```bash
> psql "$DATABASE_URL" -c "DO \$r\$ BEGIN
>     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
>     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
>     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
>   END \$r\$;
>   CREATE SCHEMA IF NOT EXISTS auth;
>   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
>   CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS 'SELECT ''{}''::jsonb';"
> psql "$DATABASE_URL" -f recipes/ob-graph/schema.sql
> ```

Done when: `graph_nodes` and `graph_edges` exist and `traverse_graph` and `find_shortest_path` are functions in your database (`\dt graph_*` and `\df traverse_graph` in psql; the Supabase Table Editor and Database → Functions, there).

---

![Step 2](https://img.shields.io/badge/Step_2-Run_the_MCP_Server-2E86AB?style=for-the-badge)

This server runs under [Bun](https://bun.sh) against your Postgres: it imports the repository's SQL shim (`compat/supabase-sql`, Bun's Postgres client in supabase-js's shape) and `compat/deno-on-bun.ts` (the two Deno globals it uses, on Bun), so it is not a Supabase Edge Function and `supabase functions deploy` does not apply (FORK.md change 74; SMD-1798 moved this server, whose `graph_nodes!graph_edges_target_node_id_fkey(…)` embeds — the key named because two join the tables — the shim did not read until then). It imports the access-key module from `../_shared/auth.ts` (the copy in `recipes/_shared/`, the core server's). Mint an access key as [Deploy an Edge Function, Step 3](../../primitives/deploy-edge-function/README.md#step-3-mint-an-access-key) shows, decide which Open Brain user this graph belongs to, and from a checkout of this repository:

```bash
(cd extensions && bun install)   # once: the pinned hono, zod and MCP SDK the server imports
NODE_PATH=extensions/node_modules \
SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
MCP_ACCESS_KEYS='laptop:write:<sha256-of-your-key>' \
DEFAULT_USER_ID='your-user-uuid' \
PORT=8787 bun recipes/ob-graph/index.ts
```

`SUPABASE_URL` carries the Postgres connection string — the shim keeps the variable names, so the code does not change — and `SUPABASE_SERVICE_ROLE_KEY` may be left unset; `NODE_PATH` points a recipe at the pinned install, since it has no `node_modules` of its own ([Run a migrated server under Bun](../../compat/supabase-sql/README.md#3-run-a-migrated-server-under-bun)). `MCP_ACCESS_KEYS` holds one `name:scope:sha256` entry per client — the hash, never the key; the older single `MCP_ACCESS_KEY` still works, compared by digest. A `read` key sees the query tools only; the five tools that write (`create_node`, `create_edge`, `update_node`, `delete_node`, `delete_edge`) are registered only for a `write` key. The server prints `Listening on http://localhost:8787/` (`PORT` unset, it listens on 8000, Deno's default — which podman's `gvproxy` also holds on macOS, hence 8787 here); your **MCP Server URL** is `http://your-host:8787/mcp`. To reach it from a hosted client, put it behind the same TLS proxy as the core server ([`SETUP.md`](../../SETUP.md)). `extensions/test-auth.ts` starts the server this way in CI, and `extensions/test-tools.ts` drives all ten tools against a real Postgres carrying this `schema.sql` — the neighbours through the named keys, a traversal's `path` as a list of ids, the shortest path (SMD-1798).

Done when: the server prints its `Listening on` line and `curl http://localhost:8787/health` answers.

---

![Step 3](https://img.shields.io/badge/Step_3-Connect_to_Your_AI-2E86AB?style=for-the-badge)

Follow the [Remote MCP Connection](../../primitives/remote-mcp/) guide to connect this recipe to Claude Desktop, ChatGPT, Claude Code, or any other MCP client.

| Setting | Value |
|---------|-------|
| Connector name | `OB-Graph` |
| URL | Your **MCP Connection URL** from the credential tracker |

Done when: Your AI client can connect to the OB-Graph MCP server without authentication errors and the tools appear in its MCP tool list.

---

![Step 4](https://img.shields.io/badge/Step_4-Test_the_Graph-2E86AB?style=for-the-badge)

Try these commands with your AI:

**Build a small graph:**

```
Create these graph nodes:
- "Supabase" (type: tool)
- "Open Brain" (type: project)
- "PostgreSQL" (type: tool)

Then connect them:
- Open Brain --depends_on--> Supabase
- Open Brain --depends_on--> PostgreSQL
- Supabase --built_with--> PostgreSQL
```

**Query relationships:**

```
What are all the neighbors of "Open Brain" in my graph?
```

```
Traverse my graph starting from "Supabase" up to 3 hops deep
```

```
Find the shortest path between "PostgreSQL" and "Open Brain"
```

Done when: Your AI can create nodes, connect them with edges, and traverse the graph to answer relationship questions.

## MCP Tools Reference

| Tool | Description |
|------|-------------|
| `create_node` | Add an entity node (person, project, concept, tool, place) |
| `create_edge` | Create a directed relationship between two nodes |
| `search_nodes` | Find nodes by label or type |
| `get_neighbors` | Get direct connections (incoming, outgoing, or both) |
| `traverse_graph` | Multi-hop walk from a starting node (recursive CTE) |
| `find_path` | Shortest path between two nodes (bidirectional BFS) |
| `update_node` | Update label, type, or merge new properties |
| `delete_node` | Remove a node and all its edges (CASCADE) |
| `delete_edge` | Remove a specific relationship |
| `list_edge_types` | List all relationship types in use with counts |

> [!TIP]
> As your graph grows, see the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) for strategies on managing tool context.

## How the Graph Traversal Works

OB-Graph uses two different traversal strategies, each matched to what the operation actually needs:

**`traverse_graph` — recursive CTE (one row per acyclic path).** The recursive CTE enumerates every acyclic path from the start node up to `p_max_depth` hops. Parallel edges and alternate routes are preserved as separate rows — if `A → B` exists with two different `relationship_type`s, you get two rows for B. A per-path cycle check (`NOT n.id = ANY(gw.path)`) prevents infinite recursion; `p_max_depth` bounds the search on dense graphs.

**`find_shortest_path` — iterative plpgsql BFS with a seen-set.** Shortest path has a "one result per reachable node" semantics by definition, so a BFS with a global seen-set is the right fit. Each call maintains a frontier (the current BFS layer), a seen-set of every node visited so far, and a JSONB parent-pointer map used to reconstruct the path. Each node is visited at most once, which keeps pathfinding bounded even on graphs with cycles or hub nodes.

```sql
-- Pseudocode for the BFS used by find_shortest_path
v_frontier := ARRAY[start];
v_seen     := ARRAY[start];
v_parent_map := '{}'::jsonb;

WHILE depth < max_depth AND frontier is non-empty LOOP
    -- Collect unseen neighbours of the current frontier, remembering the
    -- (parent, relation) that first reached each. DISTINCT ON enforces
    -- BFS's "first discovery wins" rule.
    next_ids, next_map := SELECT ... FROM graph_edges
                          WHERE source_node_id = ANY(v_frontier)
                            AND NOT target_node_id = ANY(v_seen);

    v_parent_map := v_parent_map || next_map;
    v_seen       := v_seen || next_ids;
    v_frontier   := next_ids;
    depth        := depth + 1;
END LOOP;

-- Walk parent pointers back from target to start for path reconstruction.
```

This split works well for knowledge graphs with thousands of nodes. It stays within Supabase's free tier limits (no extra services or extensions required) and gives you traversal, pathfinding, and neighbor queries — the core operations you need for relationship exploration.

> [!NOTE]
> `traverse_graph` can be expensive on dense graphs because it enumerates every acyclic path. Keep `p_max_depth` modest (2–3 is usually enough for exploration), or narrow with `p_relationship_type`. `find_shortest_path` is bounded by the seen-set; for very large graphs (100k+ edges), consider adding a `weight` threshold filter to prune low-confidence edges before calling the functions.

## Expected Outcome

After setup, your AI can:

1. Build a knowledge graph of entities and relationships as you talk about them
2. Answer "how is X related to Y?" with concrete graph paths
3. Explore multi-hop connections ("what's 3 degrees from this project?")
4. List all relationship types to understand your graph's structure
5. Link graph nodes back to existing thoughts for full context

## Troubleshooting

### "relation 'graph_nodes' does not exist"

You haven't run the SQL from Step 1 yet. Copy `schema.sql` into your Supabase SQL Editor and run it.

### "function traverse_graph does not exist"

The SQL functions at the bottom of `schema.sql` didn't run. Make sure you execute the **entire** file, not just the `CREATE TABLE` statements. The functions (`traverse_graph`, `find_shortest_path`) are defined after the tables.

> [!WARNING]
> If you ran only part of the SQL, run the full file again — all statements use `IF NOT EXISTS` or `CREATE OR REPLACE`, so re-running is safe.

### "duplicate key value violates constraint unique_edge"

You're trying to create an edge that already exists (same source, target, and relationship type). This is by design — the `unique_edge` constraint prevents duplicate relationships. If you want to update an existing edge's weight or properties, delete the old edge first and create a new one.
