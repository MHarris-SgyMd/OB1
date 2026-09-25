# Build Your Open Brain

This is the core of Open Brain — the foundation everything else builds on. Once this is running, you'll have a personal knowledge system that any AI can read from and write to. Every extension, recipe, and integration in this repo starts here.

> **Have an AI coding tool?** Copy the [Setup Wizard prompt](04-ai-assisted-setup.md) into Claude Code, Cursor, Codex, or any similar tool. It interviews you, trims this guide down to just your path, runs the terminal steps for you, and verifies each checkpoint as you go.

> **Run servers for a living?** [`SETUP.md`](../SETUP.md) is the same stack as an operator's reference — which models, which vector width, what leaves the box, where to run it for real. This guide is the beginner's walk through it.

About 30 minutes. Zero coding experience. Nothing to sign up for: the whole system runs on your own machine, in containers, and the models that read your thoughts run there too. Three tools to install (four on Windows), one folder to download, one file to fill in.

- **[Podman](https://podman.io) or [Docker](https://www.docker.com/products/docker-desktop/)** — runs the containers (free)
- **[Bun](https://bun.sh)** — makes your access key and runs the checks (free)
- **[Git](https://git-scm.com)** — downloads the code (free)

> [!NOTE]
> **Prefer hosted models?** If your machine is short on memory or disk, or you'd rather not download about 7 GB of models, an [OpenRouter](https://openrouter.ai) key (~$5 in credits, lasts months) replaces the local models. Step 3 has the six lines. Everything else is the same.

---

## 📋 Credential Tracker

You'll generate a password, an access key, and a few URLs, and you'll need them at specific steps later. Don't trust your memory.

> [!CAUTION]
> Open a text file now and keep it open. Every time this guide says **save this**, paste the value there. The access key in particular **cannot be recovered** once it scrolls off your screen — the server keeps only its hash.

```text
OPEN BRAIN -- CREDENTIAL TRACKER
--------------------------------------

Project folder:             ____________  (where you cloned the code, Step 2)
POSTGRES_PASSWORD:          ____________  (Step 3)
MCP Access Key (the KEY):   ____________  (Step 3 — goes in your Connection URL)
MCP_ACCESS_KEYS line:       ____________  (Step 3 — name:scope:hash, goes in deploy/.env)
OpenRouter API key:         ____________  (Step 3, only if you chose hosted models)

MCP Server URL:             http://127.0.0.1:8000/
MCP Connection URL:         http://127.0.0.1:8000/?key=____________
Public HTTPS URL:           ____________  (Step 6, only for Claude Desktop / claude.ai / ChatGPT)

--------------------------------------
```

---

![Step 1](https://img.shields.io/badge/Step_1-Install_the_Tools-E53935?style=for-the-badge)

Three installs — four on Windows. Each is a download-and-click, or one line in a terminal.

> [!TIP]
> **New to the terminal?** The "terminal" is the text-based command line on your computer. On Mac, open the app called **Terminal** (search for it in Spotlight). On Windows, use **Git Bash** (installed in 1.3 below) for every `bash` block — PowerShell is for the one `powershell` block. Everything in a `bash` block gets typed there, not in your browser.

<details>
<summary>🟩 <strong>Step 1 — Mac / Linux</strong> (click to expand)</summary>

**1.1 A container runtime.** Install [Podman Desktop](https://podman-desktop.io) or [Docker Desktop](https://www.docker.com/products/docker-desktop/), open it once, and let it finish starting (Podman Desktop offers to install its Compose provider during setup — say yes; `podman compose` needs it). On Linux, your distribution's `podman` or `docker` package with the compose plugin is enough.

**1.2 Bun.**

```bash
curl -fsSL https://bun.sh/install | bash
```

Close and reopen the terminal, then check:

```bash
bun --version
```

**1.3 Git.** Macs have it already (run `git --version`; if macOS offers to install developer tools, say yes). On Linux, `sudo apt install git` or your distribution's equivalent.

</details>

<details>
<summary>🟦 <strong>Step 1 — Windows</strong> (click to expand)</summary>

**1.1 A container runtime.** Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [Podman Desktop](https://podman-desktop.io), open it once, and let it finish starting (both use WSL 2 under the hood and will offer to set it up).

**1.2 Bun.** In PowerShell:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Close and reopen PowerShell, then check with `bun --version`.

**1.3 Git and Python.** Install [Git for Windows](https://git-scm.com/download/win) with its defaults. It brings **Git Bash**, the terminal every `bash` block below runs in (it has `openssl` and `curl`). The check script in Step 5 calls `python3` by that name. The Microsoft Store build of Python provides it (the python.org installer provides `python` alone): install Python from the Store, then check `python3 --version` in Git Bash before Step 5.

</details>

> [!NOTE]
> The commands below say `podman compose`. If you installed Docker, type `docker compose` instead — everything else is identical.

✅ **Done when:** `podman --version` (or `docker --version`), `bun --version` and `git --version` each print a version.

---

![Step 2](https://img.shields.io/badge/Step_2-Get_the_Code-F4511E?style=for-the-badge)

Pick a folder for your projects and download this repository into it:

```bash
git clone https://github.com/MHarris-SgyMd/OB1.git
cd OB1
```

Save the folder's path in your tracker — every later command runs from inside it.

> [!TIP]
> Not sure where you are? Run `pwd` (Mac/Linux) or `Get-Location` (Windows). It should end in `OB1`.

✅ **Done when:** `ls -a deploy/` lists `compose.yaml`, `.env.example` and `smoke.sh`.

---

![Step 3](https://img.shields.io/badge/Step_3-Configure-FB8C00?style=for-the-badge)

One file holds every setting: `deploy/.env`. Copy the example, then fill in three lines.

![3.1](https://img.shields.io/badge/3.1-Copy_the_Example-555?style=for-the-badge&labelColor=FB8C00)

```bash
cp deploy/.env.example deploy/.env
```

`deploy/.env` is yours and stays out of Git. Open it in any text editor.

![3.2](https://img.shields.io/badge/3.2-Database_Password-555?style=for-the-badge&labelColor=FB8C00)

Generate one and paste it after `POSTGRES_PASSWORD=`:

```bash
openssl rand -hex 24
```

(Without `openssl`, `bun -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"` prints one.) Save it in your tracker.

![3.3](https://img.shields.io/badge/3.3-Mint_Your_Access_Key-555?style=for-the-badge&labelColor=FB8C00)

Your MCP server is an HTTP URL, so every request carries a key it checks. Keys are **named** and **scoped** — `write` can capture, `read` can only search — and the server stores only the key's **hash**, so a leaked `.env` reveals no key. Mint one:

```bash
bun server-portable/keygen.ts --name laptop --scope write
```

It prints two things once:

- the **key** — a 64-character string. Save it in your tracker as **MCP Access Key**. This is what goes in your Connection URL.
- the **line** — `laptop:write:<64 hex characters>`. Paste it after `MCP_ACCESS_KEYS=` in `deploy/.env`.

> [!IMPORTANT]
> The key cannot be recovered from the hash. If you lose it, mint another one and replace the line. Several keys are separated by commas — mint a `read` one later for anything that only searches, or a client whose URL might end up in a log.

![3.4](https://img.shields.io/badge/3.4-Say_the_Models_Are_Local-555?style=for-the-badge&labelColor=FB8C00)

The shipped defaults run the models on your machine: `qwen3-embedding:4b` turns each thought into a vector, `qwen2.5:7b` tags it. Nothing to install — the stack downloads them on first start. One line tells the server so; add it to `deploy/.env` on a line of its own (the example carries it commented, with a note after it):

```text
OB1_LLM_LOCAL=1
```

Why it matters: by default the server refuses to send a thought's text to any endpoint it hasn't been told is local — a thought captured without this line lands with no vector and a reply saying why. The line is the declaration.

> [!NOTE]
> **On a Mac**, the containers run in a small VM with no GPU, so the 7 GB of models load slowly there. [`SETUP.md`](../SETUP.md), "On macOS, install Ollama natively instead", is faster and lighter: install Ollama on the Mac itself, set `OB1_LLM_BASE_URL=http://host.containers.internal:11434/v1` in `deploy/.env` (Option B in the example; with Docker Desktop the host's name is `host.docker.internal`), keep `OB1_LLM_LOCAL=1`, and leave `--profile local-models` off the Step 4 command.

<details>
<summary>☁️ <strong>Prefer hosted models instead? (OpenRouter)</strong></summary>

Skip 3.4's line and set these six in `deploy/.env` instead (the first five sit together under "Option C", the last under "What may leave the box"):

```text
OB1_LLM_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_API_KEY=sk-or-v1-your-key
OB1_EMBEDDING_MODEL=openai/text-embedding-3-small
OB1_EMBEDDING_DIM=1536
OB1_METADATA_MODEL=openai/gpt-4o-mini
OB1_EGRESS_POLICY=allow
```

Get the key at [openrouter.ai/keys](https://openrouter.ai/keys) (create one named `open-brain`, add $5 in credits) and save it in your tracker. Set all of them, not the key alone: the URL says where to send the calls, the models change as a pair with it, and the last line opens the gate — by default the server refuses to send a thought's text anywhere it hasn't been told is local, so without it every capture would land with no vector and a reply saying why. In Step 4, leave off the `--profile local-models` part. With `allow` set, every captured thought's text leaves your machine for OpenRouter — fine for most notes, not for anything you'd call sensitive ([`SETUP.md`](../SETUP.md), "What may leave the box", has the finer-grained terms).

</details>

✅ **Done when:** `deploy/.env` has `POSTGRES_PASSWORD`, `MCP_ACCESS_KEYS` and `OB1_LLM_LOCAL=1` (or the six OpenRouter lines) filled in, and your tracker has the key.

---

![Step 4](https://img.shields.io/badge/Step_4-Bring_It_Up-43A047?style=for-the-badge)

From the `OB1` folder:

```bash
podman compose -f deploy/compose.yaml --profile local-models up --build
```

(Docker: `docker compose …`. The profile adds the two model containers; with hosted models, leave `--profile local-models` off. `--build` builds the server image from your checkout, so a later `git pull` takes effect on the next start with it.)

Five containers start in order (three with hosted models — no Ollama and no pull): Postgres with pgvector, a one-shot job that applies the schema and exits, the models' runtime and a one-shot job that pulls the two models, then the MCP server. The first run downloads the images and about 7 GB of models (SETUP.md has the sizes), so give it a while; every later start is seconds.

The server checks its own configuration before it serves anything. Watch for two lines from `server`:

```text
preflight OK
Started server
```

If instead it prints `preflight FAILED` and stops, read the row it names — it says which setting is wrong and how to fix it. Fix `deploy/.env`, then run the same command again.

Leave this terminal running and open a second one for the next steps. (To run it in the background instead, add `-d`; `podman compose -f deploy/compose.yaml logs -f server` shows the server's log.)

✅ **Done when:** the log shows `preflight OK` and `Started server`, and the `ollama-pull` container has exited — `podman compose -f deploy/compose.yaml ps -a` shows it `Exited (0)`. The server does not wait for the pull, so a capture before that fails on a model that is not there yet.

---

![Step 5](https://img.shields.io/badge/Step_5-Verify-00897B?style=for-the-badge)

In the second terminal, from the `OB1` folder, with your access key:

🟩 **Mac/Linux:**

```bash
OB1_SMOKE_KEY=your-access-key ./deploy/smoke.sh
```

🟦 **Windows** — in **Git Bash**, `cd` to the folder and run the same line (the script needs `python3`, from Step 1.3).

Every check should pass: the server answers, the key is enforced, the database is reachable and the tool list is the full set. The script is read-only — it captures nothing — so the models get their first real test in Step 8. Then look at what you built:

```bash
curl -H "x-brain-key: your-access-key" http://127.0.0.1:8000/health
```

The JSON names the server's version, the migration it is at, the store and the embedding model — `brain_info`, the same record your AI can ask for. A key the server does not know gets a bare `ok` instead, so a plain `ok` here means the key is wrong.

✅ **Done when:** `smoke.sh` reports every check passed.

---

![Step 6](https://img.shields.io/badge/Step_6-Your_URLs-1E88E5?style=for-the-badge)

Your **MCP Server URL** is:

```text
http://127.0.0.1:8000/
```

and your **MCP Connection URL** adds the key — save both in your tracker:

```text
http://127.0.0.1:8000/?key=your-access-key
```

That URL works from this machine and nowhere else, on purpose: the server is the only port the stack publishes by default, and it listens on your machine's loopback address. Clients that run on this machine — Claude Code, Cursor, Codex — take it as is. Skip to Step 7 for those.

<details>
<summary>🌐 <strong>6.1 — Reaching it from Claude Desktop, claude.ai or ChatGPT</strong> (click to expand)</summary>

Those connectors dial your server from the vendor's side, so they need a public **HTTPS** URL. A tunnel gives you one in a minute without opening any port on your router:

```bash
# Cloudflare's quick tunnel (install: brew install cloudflared, or cloudflare.com/…/downloads)
cloudflared tunnel --url http://127.0.0.1:8000
```

It prints a `https://….trycloudflare.com` URL. That plus `?key=your-access-key` is your **Public HTTPS URL** — save it. The quick tunnel changes its name each time it starts, so for something permanent use a named Cloudflare tunnel, [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) (`tailscale funnel 8000`), or a reverse proxy such as caddy on a machine you own; all of them dial `127.0.0.1:8000` themselves, and the server keeps listening on the loopback ([`deploy/README.md`](../deploy/README.md), "What is reachable from where").

> [!WARNING]
> Anyone with that URL and your key can read and write your brain. Give the URL a `read`-scoped key where you can (Step 3.3), keep the tunnel running only while you use it, and rotate the key by replacing its line in `deploy/.env` and restarting the server.

</details>

✅ **Done when:** Your tracker has the **MCP Connection URL** — and the **Public HTTPS URL**, if you'll connect a hosted client.

---

![Step 7](https://img.shields.io/badge/Step_7-Connect_to_Your_AI-5C6BC0?style=for-the-badge)

Every client below is pointed at a URL: no config file that spawns a process, no local bridge unless your client can speak only stdio. Pick yours:

<details>
<summary>🤖 <strong>7.1 — Claude Desktop</strong></summary>

> [!NOTE]
> These steps are for Anthropic's official Claude Desktop app on macOS and Windows. Linux/community ports vary and aren't officially covered by this Connectors UI flow. No JSON config files. No Node.js. No terminal. This is the simplest connection method — and it needs the **Public HTTPS URL** from Step 6.1, since the connector dials from Anthropic's side.

1. Open Claude Desktop → **Settings** → **Connectors**
2. Click **Add custom connector**
3. Name: `Open Brain`
4. Remote MCP server URL: paste your **Public HTTPS URL** (the one ending in `?key=your-access-key`)
5. Click **Add**

That's it. Start a new conversation, and Claude will have access to your Open Brain tools. You can enable or disable it per conversation via the "+" button → Connectors. The same connector works at claude.ai.

</details>

<details>
<summary>🤖 <strong>7.2 — ChatGPT</strong></summary>

> [!WARNING]
> Requires a paid ChatGPT plan (Plus, Pro, Business, Enterprise, or Edu). Works on the web at [chatgpt.com](https://chatgpt.com) only — not available on mobile — and needs the **Public HTTPS URL** from Step 6.1.
>
> ChatGPT's custom MCP support is still beta, plan-sensitive, and sometimes model-sensitive. As of May 2026, OpenAI's docs list Developer Mode for Plus, Pro, Business, Enterprise, and Edu, while workspace app publishing and action controls are documented mainly for Business, Enterprise, and Edu. In practice, some Pro model variants expose fewer custom tools than thinking models.

**Enable Developer Mode (one-time setup):**

1. Go to [chatgpt.com](https://chatgpt.com) → click your profile icon → **Settings**
2. Navigate to **Apps & Connectors** → **Advanced settings**
3. Toggle **Developer mode** ON

> [!CAUTION]
> Enabling Developer Mode disables ChatGPT's built-in Memory feature. Yes, that's ironic for a brain tool. Your Open Brain replaces that functionality anyway — and it works across every AI, not just ChatGPT.

**Add the connector:**

1. In Settings → **Apps & Connectors**, click **Create**
2. Name: `Open Brain`
3. Description: `Personal knowledge base with semantic search` (or whatever you want — this is just for your reference)
4. MCP endpoint URL: paste your **Public HTTPS URL** (the one ending in `?key=your-access-key`)
5. Authentication: select **No Authentication** (your access key is embedded in the URL)
6. Click **Create**

> [!TIP]
> ChatGPT is less intuitive than Claude at picking the right MCP tool automatically. If it doesn't use your brain on its own, be explicit: "Use the Open Brain search_thoughts tool to find my notes about project planning." After it gets the pattern once or twice in a conversation, it usually picks up the habit.
>
> If ChatGPT says an Open Brain tool is unavailable and your server's log shows no request arriving, the connector did not reach your server. Refresh or recreate the ChatGPT app, start a fresh chat, select the Open Brain app in Developer Mode, and try a thinking model. On restricted Pro sessions, expect read tools, especially `search` and `fetch`, to be more reliable than the write tool (`capture_thought`).

</details>

<details>
<summary>🤖 <strong>7.3 — Claude Code</strong></summary>

One command, at user scope so every project sees it:

```bash
claude mcp add --transport http --scope user open-brain \
  http://127.0.0.1:8000/ \
  --header "x-brain-key: your-access-key"
```

</details>

<details>
<summary>🤖 <strong>7.4 — OpenAI Codex</strong></summary>

Codex uses `mcp-remote` to bridge to remote MCP servers. Add the following to your `~/.codex/config.toml`:

```toml
[mcp_servers.open-brain]
command = "npx"
args = [
  "-y",
  "mcp-remote",
  "http://127.0.0.1:8000/?key=your-access-key"
]
startup_timeout_sec = 30
```

> [!CAUTION]
> The `startup_timeout_sec = 30` line is required. Without it, Codex times out after 10 seconds while `npx` fetches `mcp-remote` on first use. If you see `MCP client for open-brain timed out after 10 seconds`, add or increase this value.

Restart Codex and the Open Brain tools should be available immediately.

</details>

<details>
<summary>🤖 <strong>7.5 — Other Clients (Cursor, VS Code Copilot, Windsurf)</strong></summary>

Every MCP client handles remote servers slightly differently. The server accepts your access key two ways — pick whichever your client supports. Cursor takes Option A in its `~/.cursor/mcp.json` `url` field; do not bridge it.

**Option A: URL with key (easiest).** If your client has a field for a remote MCP server URL, paste the full MCP Connection URL including `?key=your-access-key`. This works for any client that supports remote MCP without requiring headers.

**Option B: supergateway bridge (recommended).** If your client only supports local stdio servers (configured via a JSON config file), use `supergateway` to bridge to the remote server. This requires Node.js installed.

```json
{
  "mcpServers": {
    "open-brain": {
      "command": "npx",
      "args": [
        "-y",
        "supergateway",
        "--streamableHttp",
        "http://127.0.0.1:8000/?key=your-access-key"
      ]
    }
  }
}
```

**Option C: mcp-remote bridge (alternative).** `mcp-remote` also works. Set a generous startup timeout (30+ seconds) in clients that support it — `npx` fetches the bridge on first use — and pass the key in the URL — newer `mcp-remote` versions attempt OAuth client registration before sending custom headers, so `--header` fails against the server's key check.

```json
{
  "mcpServers": {
    "open-brain": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:8000/?key=your-access-key"
      ]
    }
  }
}
```

> [!NOTE]
> The bridge is a process on your machine, but it is only a bridge: the server it reaches is still the one HTTP process from Step 4.

</details>

✅ **Done when:** You can start a conversation in your AI client and it has access to Open Brain tools — twelve for a write key (`search_thoughts`, `list_thoughts`, `thought_stats`, `capture_thought`, `update_thought`, `delete_thought` and more), nine for a read key. Two of them, `search` and `fetch`, are ChatGPT-shaped compatibility tools every client sees.

---

![Step 8](https://img.shields.io/badge/Step_8-Use_It-8E24AA?style=for-the-badge)

Ask your AI naturally. It picks the right tool automatically:

| Prompt | Tool Used |
| ------ | --------- |
| "Save this: decided to move the launch to March 15 because of the QA blockers" | 🔖 Capture thought |
| "Remember that Marcus wants to move to the platform team" | 🔖 Capture thought |
| "What did I capture about career changes?" | 🔗 Semantic search |
| "What did I capture this week?" | 🔗 Browse recent |
| "How many thoughts do I have?" | 🔗 Stats overview |
| "Find my notes about the API redesign" | 🔗 Semantic search |
| "Show me my recent ideas" | 🔗 Browse + filter |
| "Who do I mention most?" | 🔗 Stats |

Start by capturing a test thought. In your connected AI, say:

```text
Remember this: Sarah mentioned she's thinking about leaving her job to start a consulting business
```

Wait a few seconds — the first capture after a start loads the models into memory, so it takes longer than the rest. Your AI should confirm the capture and show you the extracted metadata (type, topics, people, action items). Then ask "How many thoughts do I have?" — the stats tool counts the row you just wrote.

Now try searching:

```text
What did I capture about Sarah?
```

Your AI should retrieve the thought you just saved.

> [!TIP]
> The capture tool works from any MCP-connected AI — Claude Desktop, ChatGPT, Claude Code, Cursor. Wherever you're working, you can save a thought without switching apps.

✅ **Done when:** You've captured a test thought and successfully searched for it.

---

<details>
<summary>❓ <strong>Troubleshooting</strong></summary>

> [!TIP]
> The server's log is the first place to look, whatever the symptom: `podman compose -f deploy/compose.yaml logs server`. A refused request, a failed capture and a misconfiguration all say why there.

**❌ `preflight FAILED` and the server stops**

Read the row it names. Each row is one setting — the database, the access keys, the model endpoint, the vector width — and the message says what to change in `deploy/.env`. A `provider endpoint` row saying `ollama` does not resolve means you left off `--profile local-models` without naming another provider; its hint lists the ways out.

**❌ Starting over**

A retry after a half-finished attempt: `podman compose -f deploy/compose.yaml down -v` removes the containers and both volumes — the database (every thought in it) and the pulled models, which download again (about 7 GB). To keep the models, run `podman compose -f deploy/compose.yaml down` and then remove the database volume alone (`podman volume ls` names it, `<project>_pgdata`; `podman volume rm` removes it). Step 4 then builds a fresh brain. Keep `deploy/.env`.

**❌ Port 8000 is already in use**

Something on your machine holds it. Set `SERVER_PORT=8001` (any free port) in `deploy/.env`, restart, and use that port in every URL — `smoke.sh` follows it.

**❌ Claude Desktop or ChatGPT tools don't appear**

Those connectors dial from the vendor's side: they need the Public HTTPS URL from Step 6.1, and the tunnel must be running. With the URL right, make sure the connector is enabled for your conversation — click the "+" button at the bottom of the chat, then Connectors, and check that Open Brain is toggled on. If it was added but tools still don't show, remove and re-add it with the same URL.

**❌ ChatGPT doesn't use the Open Brain tools**

First, confirm Developer Mode is enabled (Settings → Apps & Connectors → Advanced settings). Without it, ChatGPT only exposes limited MCP functionality that won't cover Open Brain's full toolset. Next, check that the connector is active for your current conversation — look for it in the tools/apps panel. If it's connected but ChatGPT ignores it, be direct: "Use the Open Brain search_thoughts tool to search for [topic]."

**❌ ChatGPT says an Open Brain tool is unavailable**

Check the server's log. If no request appears when ChatGPT fails, your server is not the problem — ChatGPT did not expose that tool to the current chat. Refresh or recreate the ChatGPT app so it pulls updated tool metadata, start a fresh chat, and try a thinking model. On Pro, the read-only `search`/`fetch` compatibility tools may work where `capture_thought` is hidden or blocked because full MCP/write access is plan-dependent.

**❌ Getting 401 errors**

The key in your URL or header is not one whose hash is in `MCP_ACCESS_KEYS`. The URL carries the **key**; `deploy/.env` holds the **line** with its hash — check you didn't paste the line into the URL. If you're using the header approach (Claude Code), the header is `x-brain-key` (lowercase, with the dash). A changed `deploy/.env` needs a restart.

**❌ The capture landed but says it has no vector**

`OB1_LLM_LOCAL=1` is missing from `deploy/.env` (Step 3.4) — or, with the OpenRouter lines, `OB1_EGRESS_POLICY=allow` is: the server refused to send the text to a model endpoint it wasn't told is local or allowed. Add the line, restart, and capture the thought again — a re-capture of the same text replaces its vector. (A whole brain of such rows is `db/reembed.ts`'s job, which needs the database published to the host: `db/README.md`, "Re-embedding", and `deploy/README.md`, "What is reachable from where".)

**❌ Search returns no results**

Make sure you've captured at least one thought first (see Step 8). Try asking the AI to "search with threshold 0.3" for a wider net. If that still returns nothing, check the server's log for a model error.

**❌ Tools work but responses are slow**

The first capture or search after a start loads the models into memory — seconds once, then fast. A machine without a GPU embeds slowly under load; hosted models (the OpenRouter option in Step 3) are the way out on a small laptop.

**❌ Capture tool saves but metadata is wrong**

The metadata extraction is best-effort — the LLM is making its best guess with limited context. The embedding is what powers semantic search, and that works regardless of how the metadata gets classified. If you consistently want a specific classification, use the capture templates from the prompt kit to give the LLM clearer signals.

</details>

<details>
<summary>🔍 <strong>How It Works Under the Hood</strong></summary>

**When you capture from any AI via MCP:** your AI client sends the text to the `capture_thought` tool → the MCP server asks the embedding model for a vector of its meaning (1024 numbers, with the local default) AND asks the chat model for metadata, in parallel → both get stored as a single row in Postgres, in one statement → confirmation returned to your AI.

**When you search your brain:** your AI client sends the query to the MCP server → the server embeds your question → Postgres (pgvector) matches it against every stored thought by vector similarity → results come back ranked by meaning, not keywords.

The embedding is what makes retrieval powerful. "Sarah's thinking about leaving" and "What did I note about career changes?" match semantically even though they share zero keywords. The metadata is a bonus layer for structured filtering on top.

**Where it all lives:** one Postgres database in a container volume on your machine. `podman compose -f deploy/compose.yaml exec -T postgres pg_dump -U postgres openbrain > brain.sql` is a full backup; [`deploy/README.md`](../deploy/README.md) has the rest.

### Swapping Models Later

The models are two lines in `deploy/.env` — `OB1_EMBEDDING_MODEL` and `OB1_METADATA_MODEL` — and [`SETUP.md`](../SETUP.md) says how the defaults were chosen and what a change costs. The embedding model and its width (`OB1_EMBEDDING_DIM`) change as a pair, and a brain with thoughts in it needs a re-embed pass (`db/reembed.ts`) afterwards, since a vector from one model means nothing to another.

</details>

<details>
<summary>➕ <strong>Optional: Add Capture Sources</strong></summary>

Your MCP server handles both reading and writing. But if you want a quick-capture channel outside your AI tools:

- **[Slack Capture](../integrations/slack-capture/)** — Type thoughts in a Slack channel, automatically embedded and stored
- **[Telegram Capture](../integrations/telegram-capture/)** — Message a bot, get a thought
- More integrations in [`/integrations`](../integrations/)

Each one is another small server run the same way as this one — [`primitives/deploy-remote-mcp/`](../primitives/deploy-remote-mcp/) is the pattern.

</details>

<details>
<summary>🎉 <strong>What You Just Built — And What You Can Build Next</strong></summary>

You just used three free tools, one command and one settings file to build a personal knowledge system with semantic search, an open write protocol, and an open read protocol — on your own machine, with the models on your own machine. No CS degree. No account with anyone. No monthly SaaS fee.

Here's the thing worth noticing: every piece of it is ordinary infrastructure you can read. The schema is `db/migrations/`. The server is one file, `server-portable/index.ts`. The models are two names in a settings file. Want to add a new capture source? [`primitives/deploy-remote-mcp/`](../primitives/deploy-remote-mcp/) is the shape, and the [integrations](../integrations/) are worked examples. Want to add a field to your thoughts? [`db/README.md`](../db/README.md) explains the migrations. Want to share part of your brain with a teammate? [`primitives/shared-mcp/`](../primitives/shared-mcp/) is a second server with its own keys.

You just built AI infrastructure using AI. That pattern doesn't stop here.

Got stuck or want to share what you've built? Join the [Open Brain Discord](https://discord.gg/Cgh9WJEkeG) — there's a `#help` channel for troubleshooting and a `#show-and-tell` channel for showing off.

</details>

---

## ➡️ Your Next Step

Your Open Brain is live. Now make it work for you. The **[Companion Prompts](02-companion-prompts.md)** cover the full lifecycle from here:

- ✅ **Memory Migration** — Pull everything your AI already knows about you into your brain so every tool starts with context instead of zero
- ✅ **Second Brain Migration** — Bring your existing notes from Notion, Obsidian, or any other system into your Open Brain without starting over
- ✅ **Open Brain Spark** — Personalized use case discovery based on your actual workflow, not generic examples
- ✅ **Quick Capture Templates** — Five patterns optimized for clean metadata extraction so your brain tags and retrieves accurately
- ✅ **The Weekly Review** — A Friday ritual that surfaces themes, forgotten action items, and connections you missed

Start with the Memory Migration. If you have an existing second brain, run the Second Brain Migration next. Then use the Spark to figure out what to capture going forward. The templates build the daily habit. The weekly review closes the loop.

### Then start importing your data

The companion prompts pull out what your AI already knows. **Recipes** go further — they connect directly to your existing services and bulk-import real data.

| Recipe | What It Does | Time |
| ------ | ------------ | ---- |
| [Email History Import](../recipes/email-history-import/) | Pull your Gmail archive into searchable thoughts | 30 min |
| [ChatGPT Conversation Import](../recipes/chatgpt-conversation-import/) | Ingest your full ChatGPT data export | 30 min |

Browse all recipes in [`/recipes`](../recipes/).

---

*Open Brain was created by [Nate B. Jones](https://natesnewsletter.substack.com/); this guide is the fork's, for the stack in [`SETUP.md`](../SETUP.md). Follow the [Substack](https://natesnewsletter.substack.com/) for updates and the companion prompt pack.*
