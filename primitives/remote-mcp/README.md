# Remote MCP Connection

A guide to connecting your Open Brain extensions to any AI client. Run the server once behind an HTTPS URL ([Run a Remote MCP Server](../deploy-remote-mcp/)), connect from anywhere.

**Jump to your client:**
[Claude Desktop](#claude-desktop) | [ChatGPT](#chatgpt) | [Claude Code](#claude-code) | [Cursor](#cursor) | [Other Clients](#other-clients-windsurf-vs-code-zed) | [Troubleshooting](#troubleshooting)

## Prerequisites

- Your **MCP Connection URL** — the server's URL with the access key on it. Behind the TLS proxy it looks like `https://your-host/mcp?key=your-access-key`; for a client on the same machine as the server, `http://127.0.0.1:8787/mcp?key=your-access-key` (the port is the one the server's `PORT` names; the core server's is `http://127.0.0.1:8000/?key=…`)
- The AI client you want to connect

> A hosted client — Claude Desktop's connector, claude.ai, ChatGPT — dials your server from the vendor's side, so it needs the HTTPS form. Claude Code, Cursor and the other clients that run on your machine take the `127.0.0.1` form directly.

## Step-by-step Instructions

## Claude Desktop

1. Open Claude Desktop → **Settings** → **Connectors**
2. Click **Add custom connector**
3. Name: the extension name (e.g., `Household Knowledge`, `Family Calendar`)
4. Remote MCP server URL: paste your **MCP Connection URL** (the HTTPS form)
5. Click **Add**

Start a new conversation and enable the connector via the "+" button at the bottom of the chat → Connectors.

> You can add multiple extensions as separate connectors and toggle them per conversation.

## ChatGPT

Requires a paid ChatGPT plan (Plus, Pro, Business, Enterprise, or Edu). Works on the web at chatgpt.com — not available on mobile.

> ChatGPT custom MCP support is still beta, plan-sensitive, and sometimes model-sensitive. As of May 2026, OpenAI's docs list Developer Mode for Plus, Pro, Business, Enterprise, and Edu, while workspace app publishing and action controls are documented mainly for Business, Enterprise, and Edu. Mark read-only tools with the MCP `readOnlyHint` annotation, and expose exact `search`/`fetch` read tools when you want compatibility with restricted ChatGPT or company-knowledge style surfaces.

**Enable Developer Mode (one-time setup):**

1. Go to chatgpt.com → click your profile icon → **Settings**
2. Navigate to **Apps & Connectors** → **Advanced settings**
3. Toggle **Developer mode** ON

> Enabling Developer Mode disables ChatGPT's built-in Memory feature. Your Open Brain replaces that functionality — and it works across every AI, not just ChatGPT.

**Add the connector:**

1. In Settings → **Apps & Connectors**, click **Create**
2. Name: the extension name
3. Description: brief description of what it does (for your reference only)
4. MCP endpoint URL: paste your **MCP Connection URL** (the HTTPS form)
5. Authentication: select **No Authentication** (your access key is embedded in the URL)
6. Click **Create**

**Using it:** Start a new conversation and make sure the connector is enabled in the tools/apps panel. ChatGPT sometimes needs explicit tool references: "Use the search_household_items tool to find my paint colors."

If ChatGPT says a tool is unavailable and your server's output shows no request arriving, the request never reached your MCP server. Refresh or recreate the ChatGPT app so it pulls the latest tool metadata, start a fresh chat, select the app in Developer Mode, and try a thinking model. On restricted Pro sessions, exact `search`/`fetch` read tools are more likely to appear than write tools.

## Claude Code

```bash
claude mcp add --transport http extension-name \
  http://127.0.0.1:8787/mcp \
  --header "x-access-key: your-access-key"
```

Replace `extension-name` with a short name (e.g., `household-knowledge`, `family-calendar`), the URL with your MCP Server URL (without the `?key=` part — the HTTPS form when the server is on another machine), and `your-access-key` with your MCP Access Key. Add `--scope user` so every project sees it.

## Cursor

Cursor supports remote MCP servers natively. Add this to your `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "extension-name": {
      "url": "http://127.0.0.1:8787/mcp?key=your-access-key"
    }
  }
}
```

Restart Cursor and the extension's tools should appear in Settings → Features → MCP.

> Do **not** use `mcp-remote` for Cursor. Newer versions of `mcp-remote` attempt OAuth client registration, which fails against Open Brain's simple key-based auth. Cursor's native `url` field works directly.

## Other Clients (Windsurf, VS Code, Zed)

Every MCP client handles remote servers slightly differently. Your extension accepts the access key two ways — pick whichever your client supports:

**Option A: URL with key (easiest).** If your client has a field for a remote MCP server URL, paste the full MCP Connection URL including `?key=your-access-key`. This works for any client that supports remote MCP without requiring headers.

**Option B: mcp-remote bridge (if your client only supports stdio).** Use `mcp-remote` to bridge to the remote server. This requires Node.js installed. Pass the access key via the URL query parameter (not a header) to avoid OAuth discovery issues with newer versions of `mcp-remote`:

```json
{
  "mcpServers": {
    "extension-name": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:8787/mcp?key=your-access-key"
      ]
    }
  }
}
```

> Older examples pass the access key via `--header`. This breaks with `mcp-remote@latest` because it now attempts OAuth client registration before sending custom headers. Pass the key via the `?key=` query parameter instead. The bridge is a stdio process on your machine, but it is a bridge: the server it reaches is still the one HTTP process — the rule is that the *server* is never a stdio process.

## Troubleshooting

**Claude Desktop tools don't appear**
- The connector dials from Anthropic's side: the URL must be the HTTPS form, reachable from the internet — a `127.0.0.1` URL works only for a client on this machine
- Make sure the connector is enabled for your conversation — click "+" → Connectors and check the toggle
- Verify the MCP Connection URL is correct (it should end with `?key=your-access-key`)
- Try removing and re-adding the connector in Settings → Connectors

**ChatGPT doesn't use the tools**
- Confirm Developer Mode is enabled (Settings → Apps & Connectors → Advanced settings)
- Check that the connector is active for your current conversation in the tools/apps panel
- Be explicit: "Use the [tool_name] tool to [do thing]." ChatGPT often needs direct tool references the first few times.
- If the server's output shows no request, refresh or recreate the ChatGPT app and try a thinking model; the tool may not be exposed to that chat session.

**Getting 401 errors**
- The access key doesn't match an entry in the server's `MCP_ACCESS_KEYS` — the URL carries the key, the environment its hash
- Double-check that the `?key=` value in your URL matches your MCP Access Key exactly
- If using the header approach (Claude Code): the extension servers and the core server (`server-portable/`) accept `x-brain-key`, `x-access-key` or `Authorization: Bearer <key>`
- A key that lists tools but not the ones that write is read-scoped — that is the scope to give a key that travels in a URL; mint a write-scoped one for a client that captures (Step 3 of [Run a Remote MCP Server](../deploy-remote-mcp/))

**Tools work but responses are slow**
- The first capture or search after the stack starts loads the local models into memory — seconds once, then fast
- A hosted model provider adds a network round trip per embedding
- Read the server's output for a slow query of its own

## Expected Outcome

After following the steps for your client, your Open Brain extension should appear as a connected MCP server and its tools should be available inside that AI client without needing a local MCP bridge.

## Extensions That Use This

- [Household Knowledge Base](../../extensions/household-knowledge/) (Extension 1)
- [Home Maintenance Tracker](../../extensions/home-maintenance/) (Extension 2)
- [Family Calendar](../../extensions/family-calendar/) (Extension 3)
- [Meal Planning](../../extensions/meal-planning/) (Extension 4)
- [Professional CRM](../../extensions/professional-crm/) (Extension 5)
- [Job Hunt Pipeline](../../extensions/job-hunt/) (Extension 6)

Every extension that runs a remote MCP server uses this connection pattern.
