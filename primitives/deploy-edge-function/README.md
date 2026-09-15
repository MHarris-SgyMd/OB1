# Deploy an Edge Function

A guide to deploying any Open Brain extension as a Supabase Edge Function. This is the same pattern used by the core Open Brain MCP server — one deployment, accessible from any AI client.

## Prerequisites

- Completed the [Getting Started Guide](../../docs/01-getting-started.md) — you should already have:
  - Supabase CLI installed
  - A project folder with `supabase init` and `supabase link` already done
  - Your credential tracker with Supabase project ref and secrets

## Before You Start

Navigate to your Open Brain project folder — the one you created during the Getting Started guide.

🟩 **Mac/Linux:**

```bash
cd /paste/your/path/here
```

🟦 **Windows (PowerShell):**

```powershell
cd "C:\paste\your\path\here"
```

> Not sure where it is? It's the folder you created in Step 6 of the Getting Started guide — the one with the `supabase/` directory inside it.

## What You Need From the Extension

Every extension README includes a deployment table like this:

| Setting | Value |
|---------|-------|
| Function name | `extension-name-mcp` |
| Download path | `extensions/extension-name` |

You'll use these values in the steps below. Replace `FUNCTION_NAME` and `DOWNLOAD_PATH` with the values from the extension you're deploying.

---

## Step 1: Create the Function Folder

```bash
supabase functions new FUNCTION_NAME
```

Example: `supabase functions new household-knowledge-mcp`

## Step 2: Download the Server Files

🟩 **Mac/Linux:**

```bash
curl -o supabase/functions/FUNCTION_NAME/index.ts https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/DOWNLOAD_PATH/index.ts
```

```bash
curl -o supabase/functions/FUNCTION_NAME/deno.json https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/DOWNLOAD_PATH/deno.json
```

The server imports the access-key module from `../_shared/auth.ts` — Supabase bundles `supabase/functions/_shared/` with every function. Download it once; every extension shares it:

```bash
mkdir -p supabase/functions/_shared
curl -o supabase/functions/_shared/auth.ts https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/extensions/_shared/auth.ts
```

> **Two extensions deploy this way today: Family Calendar and Job Hunt.** The other four import this repository's SQL shim (`compat/supabase-sql`, which imports `bun`) while still reading `Deno.env`, so as they stand they neither bundle as an Edge Function nor run under Bun — SMD-1480 holds the fix; `extensions/test-auth.ts` exercises their access-key behaviour under a stand-in for Deno. Their READMEs say the same above their deployment tables.

🟦 **Windows (PowerShell):**

```powershell
Invoke-WebRequest -Uri https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/DOWNLOAD_PATH/index.ts -OutFile supabase\functions\FUNCTION_NAME\index.ts
```

```powershell
Invoke-WebRequest -Uri https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/DOWNLOAD_PATH/deno.json -OutFile supabase\functions\FUNCTION_NAME\deno.json
```

```powershell
New-Item -ItemType Directory -Force supabase\functions\_shared | Out-Null
Invoke-WebRequest -Uri https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/extensions/_shared/auth.ts -OutFile supabase\functions\_shared\auth.ts
```

> Replace `FUNCTION_NAME` and `DOWNLOAD_PATH` with the values from the extension's deployment table.

## Step 3: Mint an Access Key

The extensions authenticate the way the core Open Brain server does: a key is **named**, has a **scope** (`read` or `write`), and only its **SHA-256 hash** is stored — the server never holds the key itself, and a key is revoked on its own by removing its line. A read-scoped key is never given the tools that write, so it does not even see them; that is the key to put in a connector URL.

> **Already have keys from a previous extension?** Reuse them — skip to Step 4. All functions in the project share the same secrets.

Mint one from a checkout of this repository — not your Supabase project folder — with Bun installed (it prints the key once, and the line to store):

```bash
(cd /path/to/your/OB1/checkout/server-portable && bun keygen.ts --name laptop --scope write)
```

Or by hand — generate a key, then hash it:

🟩 **Mac/Linux:**

```bash
KEY=$(openssl rand -hex 32)
echo "key:  $KEY"
echo "hash: $(printf %s "$KEY" | shasum -a 256 | cut -d' ' -f1)"   # sha256sum on a Linux box without shasum
```

🟦 **Windows (PowerShell):**

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$key = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
$hash = ([System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($key)) | ForEach-Object { $_.ToString('x2') }) -join ''
"key:  $key"; "hash: $hash"
```

Save the **key** in your credential tracker — it goes in your Connection URL. Set the **hash** as a Supabase secret, as `name:scope:hash`; several keys are separated by commas:

```bash
supabase secrets set MCP_ACCESS_KEYS=laptop:write:paste-the-hash-here
```

> The older `MCP_ACCESS_KEY=<raw key>` secret still works — one key for every client, with write scope, compared by digest now. Move to `MCP_ACCESS_KEYS` when you next touch the secrets; both may be set at once. Setting a secret again overwrites it for every function in the project, so for a key per extension give each its own line and name in the one `MCP_ACCESS_KEYS` — not a separate secret name.

## Step 4: Deploy

```bash
supabase functions deploy FUNCTION_NAME --no-verify-jwt
```

Your MCP server is now live at:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/FUNCTION_NAME
```

Build your **MCP Connection URL** by adding your access key:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/FUNCTION_NAME?key=your-access-key
```

Save this in your credential tracker, then follow the [Remote MCP Connection](../remote-mcp/) guide to connect it to your AI client.

---

## Updating a Deployed Function

When the extension code is updated in the repo, pull the latest version of all three files — the server, its pins, and the shared access-key module (a server may start using something the module gained) — and redeploy:

🟩 **Mac/Linux:**

```bash
curl -o supabase/functions/FUNCTION_NAME/index.ts https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/DOWNLOAD_PATH/index.ts
curl -o supabase/functions/FUNCTION_NAME/deno.json https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/DOWNLOAD_PATH/deno.json
curl -o supabase/functions/_shared/auth.ts https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/extensions/_shared/auth.ts
```

🟦 **Windows (PowerShell):**

```powershell
Invoke-WebRequest -Uri https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/DOWNLOAD_PATH/index.ts -OutFile supabase\functions\FUNCTION_NAME\index.ts
Invoke-WebRequest -Uri https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/DOWNLOAD_PATH/deno.json -OutFile supabase\functions\FUNCTION_NAME\deno.json
Invoke-WebRequest -Uri https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/extensions/_shared/auth.ts -OutFile supabase\functions\_shared\auth.ts
```

Then deploy:

```bash
supabase functions deploy FUNCTION_NAME --no-verify-jwt
```

The URL and access key stay the same — no need to reconfigure your AI clients.

---

## Troubleshooting

**"Function not found" during deploy**
- Verify you ran `supabase functions new FUNCTION_NAME` first
- Make sure you're in your Open Brain project folder (the one with the `supabase/` directory)

**Import errors or "not in import map"**
- Verify `deno.json` was downloaded into the function directory, not the project root
- Run `ls supabase/functions/FUNCTION_NAME/` — you should see both `index.ts` and `deno.json`
- `Module not found "../_shared/auth.ts"`: Step 2's third download is missing — `ls supabase/functions/_shared/` should show `auth.ts`

**Deploy succeeds but function returns errors**
- Check Edge Function logs: Supabase Dashboard → Edge Functions → your function → Logs
- Verify secrets are set: `supabase secrets list` should show `MCP_ACCESS_KEYS` (or the older `MCP_ACCESS_KEY`)
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected — if they're missing, your Supabase project may need to be restarted

**"Invalid JWT" or authentication errors**
- Make sure you deployed with `--no-verify-jwt` flag

## Extensions That Use This

- [Household Knowledge Base](../../extensions/household-knowledge/) (Extension 1) — not deployable as it stands (SMD-1480)
- [Home Maintenance Tracker](../../extensions/home-maintenance/) (Extension 2) — not deployable as it stands (SMD-1480)
- [Family Calendar](../../extensions/family-calendar/) (Extension 3)
- [Meal Planning](../../extensions/meal-planning/) (Extension 4) — not deployable as it stands (SMD-1480)
- [Professional CRM](../../extensions/professional-crm/) (Extension 5) — not deployable as it stands (SMD-1480)
- [Job Hunt Pipeline](../../extensions/job-hunt/) (Extension 6)
