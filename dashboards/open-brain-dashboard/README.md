# Open Brain Dashboard

<div align="center">

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@headcrest](https://github.com/headcrest) | Auth fixes by [@matthallett1](https://github.com/matthallett1)**

*Reviewed and merged by the Open Brain maintainer team — thank you for building the future of AI memory!*

</div>

> Search, filter, and capture your thoughts from a production-ready SvelteKit UI.

## What it does

This dashboard talks to your Open Brain server over MCP — the same six tools
every AI client uses — and gives you an interface to:

- capture new thoughts from a web form,
- search and filter existing thoughts by type, topic, and people,
- inspect stats, action items, and recent capture activity in a clean, focused layout.

You sign in with one of the server's own **access keys** (`server-portable/keygen.ts`
mints them; `SETUP.md` explains scopes). The dashboard checks the key against the
server, seals it into an httpOnly cookie, and forwards it on every call, so:

- a **read** key gets a read-only dashboard — the capture button is not shown,
  and a capture sent anyway is refused before the server is asked;
- a **write** key can capture too;
- revoking the key in the server's `MCP_ACCESS_KEYS` ends the session.

No Supabase project, no user table, no key in the dashboard's environment. (On
this fork — SMD-1801 — the Supabase email/password sign-in this dashboard used
to require is gone; the two Next dashboards beside it work the same way, against
the REST gateway.)

## Prerequisites

- A running Open Brain server ([SETUP.md](../../SETUP.md) — the compose stack
  publishes it on `http://127.0.0.1:8000/`), or any URL that speaks MCP
- An access key for it — read-scoped is enough to browse and search
- Bun 1.4+ (or Node.js 18+ with npm)

## Credential Tracker

Copy this block into a text editor and fill it as you go.

```text
OPEN BRAIN DASHBOARD -- CREDENTIAL TRACKER
------------------------------------------

FROM OPEN BRAIN
  MCP URL:                   ____________   (MCP_URL, in .env.local)
  Access key:                ____________   (typed at /signin, stored nowhere)

THIS DASHBOARD
  SESSION_SECRET:            ____________   (openssl rand -hex 32)

HOSTING
  Deploy URL:                ____________

------------------------------------------
```

## Quick Start

1. Install dependencies:

   ```bash
   cd dashboards/open-brain-dashboard
   bun install --frozen-lockfile
   ```

2. Create `.env.local` in the dashboard folder:

   ```bash
   cp .env.example .env.local
   ```

3. Fill in the two values:

   | Variable | Where to get it |
   |----------|----------------|
   | `MCP_URL` | Where your server answers MCP — `http://127.0.0.1:8000/` for the compose stack (`SERVER_PORT` in `deploy/.env` if you changed it), or your deployed URL |
   | `SESSION_SECRET` | `openssl rand -hex 32` — 32+ characters; the dashboard refuses to serve without it |

4. Mint an access key for the dashboard if you have none to spare:

   ```bash
   cd ../../server-portable && bun keygen.ts --name dashboard --scope read
   ```

   Add the printed `dashboard:read:<hash>` line to the server's `MCP_ACCESS_KEYS`
   (`deploy/.env` for the compose stack, then `docker compose up -d`) and keep
   the raw key for step 6. `--scope write` if you want to capture from the dashboard.

5. Start the app:

   ```bash
   bun run dev
   ```

6. Open `http://localhost:5173` and paste the key at `/signin`.

## Deploy to Production

- **Vercel:** Import this folder, set `MCP_URL` and `SESSION_SECRET`.
- **Netlify:** Deploy as a SvelteKit site, set the same two variables.

The session cookie is marked `Secure` when the request arrived over HTTPS —
every hosted deploy — and not on a plain-HTTP preview (`bun run preview` on
`127.0.0.1`, which CI drives). Put TLS in front of any deploy others can reach.

## Expected outcome

After setup, you should be able to:

- see your total captured-thoughts count in the header,
- search thoughts and get results sorted by recency,
- filter by type (Observation/Task/Idea/Reference/Person Note), topic, and people,
- open a thought for full text review,
- capture a new thought and immediately persist it through MCP (write key).

`smoke.ts` drives all of that against a running server, the way CI does:

```bash
MCP_URL=http://127.0.0.1:8000/ bun smoke.ts --key <write-key> --read-key <read-key>
```

It builds nothing — run `bun run build` first — and starts `vite preview` on a
free port, signs in with a wrong key (refused, 401), with the write key (the
stats JSON the first page loads comes back), and with the read key (browsing
works, capture is refused with 403 before the server is asked).

## Troubleshooting

**Issue: `SESSION_SECRET must be set and at least 32 characters`**
Solution: Ensure `.env.local` exists with a value from `openssl rand -hex 32`, and restart the dev server after editing env.

**Issue: `MCP_URL is not set`**
Solution: Set it to where your server answers MCP. The compose stack's default is `http://127.0.0.1:8000/`; `deploy/README.md` says what is reachable from where.

**Issue: sign-in says `The server refused that access key`**
Solution: The server answered, and the key is not one it knows. Check that the key's hash is a line in the server's `MCP_ACCESS_KEYS` (the older single `MCP_ACCESS_KEY` also works) and that the container was restarted after editing `deploy/.env`.

**Issue: sign-in says `Could not reach the MCP server`**
Solution: `MCP_URL` is wrong, or the server is not up. `curl -sS $MCP_URL/health` should print `ok`. From a container, `127.0.0.1` is the container, not your machine.

**Issue: no capture button**
Solution: You signed in with a read key. Mint a write key (`--scope write`) and sign in again.

**Issue: Search returns "No thoughts found" but stats show thoughts exist**
Solution: Search is semantic (vector similarity), so it needs the server's embedding provider. If the server's preflight reports the provider unreachable, or thoughts were captured before embeddings were configured, search finds nothing. The server's own log (`docker compose logs server`) names the provider and the failure.
