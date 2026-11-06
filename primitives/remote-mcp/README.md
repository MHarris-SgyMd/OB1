# Remote MCP Connection

A guide to connecting any AI client to your brain's own MCP connector: the server at `/mcp` on the compose stack's proxy ([`SETUP.md`](../../SETUP.md)). One connector carries every tool the brain serves: the core's, and those of each plugin the operator turns on, the six learning-path extensions among them (SMD-2311). There is no other MCP server to run. [Getting Started](../../docs/01-getting-started.md), Steps 6 and 7, walks the first connection; this guide is the reference for each client.

**Jump to your client:**
[Claude Desktop](#claude-desktop) | [ChatGPT](#chatgpt) | [Claude Code](#claude-code) | [Codex](#codex) | [Cursor](#cursor) | [Other Clients](#other-clients-windsurf-vs-code-zed) | [Troubleshooting](#troubleshooting)

## Prerequisites

- A running brain: the compose stack in [`SETUP.md`](../../SETUP.md)
- An access key, minted as Getting Started's Step 3 says (`bun server-portable/keygen.ts --name laptop --scope write`), its hash in `MCP_ACCESS_KEYS` in `deploy/.env`
- Your **MCP Connection URL**: the server's URL with the key on it. On the machine that runs the stack, `http://127.0.0.1:8000/mcp?key=your-access-key`; from anywhere else, the HTTPS name a tunnel or TLS proxy gives the stack, `https://your-host/mcp?key=your-access-key` (Getting Started, Step 6.1)
- The AI client you want to connect

> A hosted client (Claude Desktop's connector, claude.ai, ChatGPT) dials your brain from the vendor's side, so it needs the HTTPS form. Claude Code, Codex, Cursor and the other clients that run on your machine take the `127.0.0.1` form directly.

## Keys and Scope

The connector authenticates each request by its key: in an `x-brain-key` or `x-access-key` header, as `Authorization: Bearer <key>`, or as `?key=` on the URL. The key's scope decides which tools the client is shown, not only which it may call:

- **`read`** sees the tools that read. It is the key to put in a URL a hosted connector holds, since anyone with that URL has the key.
- **`write`** sees every tool, writes included.
- **`capture`** is the session capture hook's: it is shown `capture_thought` and the few writes on what it captured or opened, nothing that reads.

A plugin's tools follow the same rule: a read key sees its reads. Mint a key per client, so one is revoked on its own by removing its line from `MCP_ACCESS_KEYS` in `deploy/.env` and running Getting Started's Step 4 command again with `-d`, which recreates the servers that read the keys (a `restart` keeps the old ones).

## Step-by-step Instructions

## Claude Desktop

1. Open Claude Desktop → **Settings** → **Connectors**
2. Click **Add custom connector**
3. Name: `Open Brain`
4. Remote MCP server URL: paste your **MCP Connection URL** (the HTTPS form)
5. Click **Add**

Start a new conversation and enable the connector via the "+" button at the bottom of the chat → Connectors. The same connector works at claude.ai.

## ChatGPT

Requires a paid ChatGPT plan (Plus, Pro, Business, Enterprise, or Edu). Works on the web at chatgpt.com, not on mobile.

> ChatGPT custom MCP support is still beta, plan-sensitive, and sometimes model-sensitive. As of May 2026, OpenAI's docs list Developer Mode for Plus, Pro, Business, Enterprise, and Edu, while workspace app publishing and action controls are documented mainly for Business, Enterprise, and Edu. Read tools, the brain's `search` and `fetch` among them, appear more reliably than write tools on restricted surfaces.

**Enable Developer Mode (one-time setup):**

1. Go to chatgpt.com → click your profile icon → **Settings**
2. Navigate to **Apps & Connectors** → **Advanced settings**
3. Toggle **Developer mode** ON

> Enabling Developer Mode disables ChatGPT's built-in Memory feature. Your brain replaces that functionality, and it works across every AI, not just ChatGPT.

**Add the connector:**

1. In Settings → **Apps & Connectors**, click **Create**
2. Name: `Open Brain`
3. Description: brief description of what it does (for your reference only)
4. MCP endpoint URL: paste your **MCP Connection URL** (the HTTPS form)
5. Authentication: select **No Authentication** (your access key is embedded in the URL)
6. Click **Create**

**Using it:** Start a new conversation and make sure the connector is enabled in the tools/apps panel. ChatGPT sometimes needs explicit tool references: "Use the Open Brain search_thoughts tool to find my notes about project planning."

## Claude Code

One command, at user scope so every project sees it:

```bash
claude mcp add --transport http --scope user open-brain \
  http://127.0.0.1:8000/mcp \
  --header "x-brain-key: your-access-key"
```

Use the HTTPS form of the URL, without `?key=`, when the brain runs on another machine.

## Codex

Codex reaches a remote MCP server through `mcp-remote`. Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.open-brain]
command = "npx"
args = [
  "-y",
  "mcp-remote",
  "http://127.0.0.1:8000/mcp?key=your-access-key"
]
startup_timeout_sec = 30
```

The `startup_timeout_sec = 30` line is required: without it, Codex times out after 10 seconds while `npx` fetches `mcp-remote` on first use.

## Cursor

Cursor supports remote MCP servers natively. Add this to your `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "open-brain": {
      "url": "http://127.0.0.1:8000/mcp?key=your-access-key"
    }
  }
}
```

Restart Cursor and the brain's tools should appear in Settings → Features → MCP. Do **not** use `mcp-remote` for Cursor: its native `url` field needs no bridge.

## Other Clients (Windsurf, VS Code, Zed)

Every MCP client handles remote servers slightly differently. Pick whichever your client supports:

**Option A: URL with key (easiest).** If your client has a field for a remote MCP server URL, paste the full MCP Connection URL including `?key=your-access-key`.

**Option B: a stdio bridge (if your client only supports stdio).** `supergateway` or `mcp-remote` runs on your machine and forwards to the brain's URL. This requires Node.js. Pass the key in the URL: every version of either bridge sends it on each request.

```json
{
  "mcpServers": {
    "open-brain": {
      "command": "npx",
      "args": [
        "-y",
        "supergateway",
        "--streamableHttp",
        "http://127.0.0.1:8000/mcp?key=your-access-key"
      ]
    }
  }
}
```

For `mcp-remote`, the args are `["-y", "mcp-remote", "http://127.0.0.1:8000/mcp?key=your-access-key"]`; set a startup timeout of 30 seconds or more where the client has one.

> Older examples pass the key with `--header`, which some `mcp-remote` versions did not send before attempting OAuth client registration. A request that carries a key is never answered with the OAuth challenge. At the public origin of a stack with the `auth` profile on, the brain advertises OAuth (a preview; [`deploy/README.md`](../../deploy/README.md), "Authorization server"), and a keyless request to its `/mcp` there gets the challenge that starts a sign-in. A bridge is a stdio process on your machine, but it is a bridge: the server it reaches is still one reached by URL. The rule is that the *server* is never a stdio process.

## Troubleshooting

**Claude Desktop tools don't appear**
- The connector dials from Anthropic's side: the URL must be the HTTPS form, reachable from the internet. A `127.0.0.1` URL works only for a client on this machine. claude.ai refuses a name that resolves to a private or CGNAT address (Getting Started, Step 6.1).
- Make sure the connector is enabled for your conversation: click "+" → Connectors and check the toggle
- Verify the MCP Connection URL ends in `/mcp?key=your-access-key`
- Try removing and re-adding the connector in Settings → Connectors

**ChatGPT doesn't use the tools**
- Confirm Developer Mode is enabled (Settings → Apps & Connectors → Advanced settings)
- Check that the connector is active for your current conversation in the tools/apps panel
- Be explicit: "Use the [tool_name] tool to [do thing]." ChatGPT often needs direct tool references the first few times.
- If the servers' log (`podman compose -f deploy/compose.yaml logs mcp api`) shows no request, refresh or recreate the ChatGPT app and try a thinking model; the tool may not be exposed to that chat session.

**Getting 401 errors**
- The key doesn't match an entry in `MCP_ACCESS_KEYS`: the URL carries the key, `deploy/.env` its hash. A key added to `deploy/.env` reaches the servers only once they are recreated.
- Double-check that the `?key=` value in your URL matches your key exactly, or the header's
- A URL at `/` rather than `/mcp` is a client set up before the proxy: [`deploy/README.md`](../../deploy/README.md), "Moving a client to /mcp"

**A tool is missing**
- A key that lists tools but not the ones that write is read-scoped: give a client that captures a `write` key
- A plugin's tools appear only once `OB1_PLUGINS` in `deploy/.env` names it and the servers were recreated; refresh the client's tool list

**Tools work but responses are slow**
- The first capture or search after the stack starts loads the local models into memory: seconds once, then fast
- A hosted model provider adds a network round trip per embedding

## Expected Outcome

After following the steps for your client, your brain appears as a connected MCP server, and its tools, the core's and each enabled plugin's, are available inside that AI client.

## Extensions That Use This

All six: each is a plugin since SMD-2311, its tools on this one connector, with no connector of its own. The vendored recipe and integration servers are not MCP servers; [Run a Vendored Server](../deploy-remote-mcp/) runs them.
