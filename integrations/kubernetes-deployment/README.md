# Kubernetes Self-Hosted Deployment

<div align="center">

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@velo](https://github.com/velo)**

*Reviewed and merged by the Open Brain maintainer team — thank you for building the future of AI memory!*

</div>

> Deploy Open Brain on Kubernetes with self-hosted PostgreSQL + pgvector, replacing Supabase with fully self-managed infrastructure.

## What It Does

This integration provides Kubernetes manifests and a modified MCP server that connects directly to PostgreSQL instead of Supabase. Your thoughts database, embeddings, and MCP endpoint all run on your own cluster. The MCP HTTP endpoint is served via Kubernetes Ingress, making it a remote endpoint accessible by URL from any MCP client.

> **On this fork (FORK.md change 71, SMD-1524):** the database this deployment runs is its own, built by `k8s/init.sql` from the guide's shape — none of this fork's migrations or functions are in it. `capture_thought` therefore writes `thoughts` with a raw INSERT, and its rows have no content fingerprint (no dedup by text), no model label and no audit actor. To run a fork-shaped brain in the cluster instead, apply [`db/migrations/`](../../db/README.md) to the Postgres pod in place of `init.sql` and route the capture through `upsert_thought`; until then the file is a counted exception in `scripts/check-fork-consistency.ts` check 10.

## Prerequisites

- Working Kubernetes cluster (tested on K3s v1.31, works with any K8s distribution)
- `kubectl` configured for your cluster
- Docker installed (for building the MCP server image)
- An embedding/chat API provider (OpenRouter, OpenAI, or a local model with OpenAI-compatible API)
- An ingress controller (Traefik, nginx-ingress, etc.) if you want external access

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
KUBERNETES DEPLOYMENT -- CREDENTIAL TRACKER
--------------------------------------------

POSTGRESQL
  Password:              ____________

MCP SERVER
  Access key:            ____________

EMBEDDING/CHAT API
  API base URL:          ____________
  API key:               ____________
  Embedding model:       ____________
  Chat model:            ____________

--------------------------------------------
```

## Steps

1. Build the MCP server Docker image
2. Configure secrets
3. Deploy to Kubernetes
4. Verify the deployment
5. Connect your MCP client

### 1. Build the MCP Server Docker Image

From this directory, build and import the image. The context is the parent `integrations/` directory, because `index.ts` imports the shared access-key module from `../_shared/auth.ts` and Docker cannot copy from outside its context. The image is Bun's (`oven/bun`, the core server's base — SMD-1800; it was Deno's until then): `package.json` and `bun.lock` pin what it installs, and the server runs as `bun index.ts`, the same command that runs it from a checkout (`PORT=8000 DB_HOST=… bun integrations/kubernetes-deployment/index.ts`; Bun's own Postgres client, no driver to install).

```bash
docker build -t openbrain-mcp-server:latest -f Dockerfile ..

# For K3s:
docker save openbrain-mcp-server:latest | sudo k3s ctr images import -

# For minikube:
minikube image load openbrain-mcp-server:latest

# For other clusters, push to your registry:
docker tag openbrain-mcp-server:latest your-registry/openbrain-mcp-server:latest
docker push your-registry/openbrain-mcp-server:latest
```

### 2. Configure Secrets

```bash
cp k8s/secrets.yml.example k8s/secrets.yml
```

Edit `k8s/secrets.yml` with your actual credentials. **Never commit this file.**

`mcp-access-keys` holds the MCP access keys as `name:scope:sha256` entries, comma-separated — the SHA-256 hash of each key, never the key itself; mint one as [Deploy an Edge Function, Step 3](../../primitives/deploy-edge-function/README.md#step-3-mint-an-access-key) shows. Clients present the key (`x-brain-key`, `x-access-key`, `?key=` or a bearer token). A `read`-scoped key gets the search and listing tools; `capture_thought` is registered only for a `write` key. The older single plaintext key still works if you set `MCP_ACCESS_KEY` on the container instead.

### 3. Deploy to Kubernetes

```bash
kubectl apply -f k8s/secrets.yml
kubectl apply -f k8s/openbrain.yml
```

### 4. Verify Deployment

```bash
# Check pod status
kubectl get pods -n openbrain

# Check database is initialized
kubectl exec -n openbrain openbrain-0 -c db -- \
  psql -U postgres -d openbrain -c '\dt'

# Test MCP endpoint (via port-forward)
kubectl port-forward -n openbrain svc/openbrain 8000:8000 &
curl -X POST http://localhost:8000 \
  -H "x-brain-key: YOUR_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

### 5. Connect Your MCP Client

For Claude Desktop or any MCP-compatible client, configure the remote MCP endpoint:

```json
{
  "mcpServers": {
    "openbrain": {
      "url": "http://openbrain.openbrain.svc.cluster.local:8000",
      "transport": "http",
      "headers": {
        "x-brain-key": "YOUR_ACCESS_KEY"
      }
    }
  }
}
```

If you've configured an Ingress, use your external URL instead:

```json
{
  "mcpServers": {
    "openbrain": {
      "url": "https://brain.yourdomain.com",
      "transport": "http",
      "headers": {
        "x-brain-key": "YOUR_ACCESS_KEY"
      }
    }
  }
}
```

## Using a Local LLM Instead of OpenRouter

To use a local model (e.g., Ollama, BitNet, llama.cpp) for embeddings and chat, update the environment variables in `k8s/openbrain.yml`:

```yaml
- name: EMBEDDING_API_BASE
  value: "http://your-local-model:8080/v1"
- name: EMBEDDING_API_KEY
  value: "not-needed"
- name: EMBEDDING_MODEL
  value: "your-model-name"
- name: CHAT_API_BASE
  value: "http://your-local-model:8080/v1"
- name: CHAT_API_KEY
  value: "not-needed"
- name: CHAT_MODEL
  value: "your-model-name"
```

If your embedding model produces a different vector dimension than 1536, update the `vector(1536)` in the init SQL to match.

## Expected Outcome

After deployment you should see:

- `openbrain-0` pod running with 2 containers (db + mcp-server)
- PostgreSQL with `thoughts` table and `match_thoughts` function
- MCP endpoint responding to `tools/list` with 4 tools: `search_thoughts`, `list_thoughts`, `thought_stats`, `capture_thought` (3 for a `read` key — `capture_thought` is registered only for `write`)
- Thoughts captured via any MCP client are stored in your self-hosted database

> **Tool hygiene:** This integration adds MCP tools to your AI's context window. As your deployment grows, the total tool count grows — and with it, the context cost and risk of your AI picking the wrong tool. See the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) for strategies on auditing, merging, and scoping your tools.

## Troubleshooting

**Pod stuck in CrashLoopBackOff (mcp-server)**
- Check logs: `kubectl logs -n openbrain openbrain-0 -c mcp-server`
- Most common cause: invalid API key or unreachable embedding API base URL
- For local models, ensure the model service is running and accessible from the cluster

**Database not initialized / tables missing**
- The init SQL runs only on first startup. If the data volume already exists with an old database, the init script is skipped.
- To re-initialize: delete the data volume directory and restart the pod
- `kubectl delete pod openbrain-0 -n openbrain` (StatefulSet will recreate it)

**Embedding dimension mismatch**
- If you see errors about vector dimensions, your embedding model produces vectors of a different size than expected
- Check your model's output dimension and update `vector(1536)` in the init SQL ConfigMap
- Drop and recreate the `thoughts` table if changing dimensions on an existing database

**Connection refused to database**
- Containers in the same pod communicate via `127.0.0.1` — this is normal Kubernetes multi-container pod behavior
- Check that the `db` container is ready: `kubectl logs -n openbrain openbrain-0 -c db`
