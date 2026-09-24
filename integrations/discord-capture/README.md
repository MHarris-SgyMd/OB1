# Discord Capture

> Capture messages from Discord channels into Open Brain — the same pattern as Slack capture, but for Discord.

## What It Does

A Discord bot that monitors designated channels and captures messages into Open Brain as thoughts. Messages are embedded and stored with Discord-specific metadata (server, channel, author, timestamp). Works just like the built-in Slack capture but for Discord communities.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- A Discord account with permission to add bots to your server
- Discord Developer Portal access (free)
- [Bun](https://bun.sh) 1.4+ and a checkout of this repository — the bot runs as one HTTP server under Bun ([Run a Remote MCP Server](../../primitives/deploy-remote-mcp/) walks the same steps)
- OpenRouter API key (for generating embeddings)

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
DISCORD CAPTURE -- CREDENTIAL TRACKER
--------------------------------------

FROM YOUR OPEN BRAIN SETUP
  OpenRouter API key:    ____________

DISCORD INFO
  Server name:           ____________

GENERATED DURING SETUP
  Discord Bot Token:     ____________
  Channel IDs to monitor:
    - ____________
    - ____________
    - ____________

--------------------------------------
```

## Steps

<!-- TODO: Fill in step-by-step instructions -->

1. Create a Discord application in the Developer Portal
2. Create a bot and copy the bot token
3. Invite the bot to your server with message read permissions
4. Write the bot as one HTTP server under Bun in this folder, on the Slack capture's shape ([Slack Capture](../slack-capture/) has the sample)
5. Configure environment variables (bot token, channel IDs to monitor, `SUPABASE_URL` — your brain's Postgres connection string — and the OpenRouter key)
6. Run it — `PORT=8790 … bun integrations/discord-capture/index.ts` — behind HTTPS where Discord must reach it
7. Send a test message in a monitored channel
8. Verify the thought was captured in your database

## Expected Outcome

When you send a message in a monitored Discord channel, it appears as a new thought in your `thoughts` table within a few seconds. The `metadata` jsonb field includes:
- `source`: `"discord"`
- `server`: Discord server name
- `channel`: channel name
- `author`: message author's Discord username
- `timestamp`: original message timestamp

You can search for anything you've captured from Discord using your Open Brain MCP server's `search_thoughts` tool.

## Troubleshooting

**Issue: Bot is online but not capturing messages**
Solution: Check that the bot has "Message Content Intent" enabled in the Developer Portal (Bot → Privileged Gateway Intents). Also verify the channel IDs in your config match the channels you're posting in.

**Issue: Bot captures messages but they don't appear in the database**
Solution: Read the server's output. Most likely a wrong `SUPABASE_URL`.

**Issue: Duplicate thoughts from edited messages**
Solution: By default, message edits create a new thought. To update the existing thought instead, set `UPDATE_ON_EDIT=true` in your environment variables.
