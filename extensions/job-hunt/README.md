# Extension 6: Job Hunt Pipeline

## Why This Matters

Job hunting is an emotional grinder. You think you're failing because you got 3 rejections this week. But your agent can show you that your actual interview conversion rate is 40% — well above average. It can catch that you haven't followed up with the hiring manager at Company X in 8 days. It can normalize compensation across 4 different offer structures so you're comparing apples to apples. The data doesn't lie, and having an agent that can reason across your entire pipeline turns an emotional process into a manageable one.

## Learning Path: Extension 6 of 6

| Extension | Name | Status |
|-----------|------|--------|
| 1 | Household Knowledge Base | Completed |
| 2 | Home Maintenance Tracker | Completed |
| 3 | Family Calendar | Completed |
| 4 | Meal Planning & Recipes | Completed |
| 5 | Professional CRM | Completed |
| **6** | **Job Hunt Pipeline** | **<-- You are here** |

## What It Does

A complete job search management system — companies, postings, applications, interviews, and contacts. The most complex extension in the learning path, with 5 tables and sophisticated cross-extension integration to your Professional CRM (Extension 5). This extension demonstrates advanced multi-table relationships, pipeline tracking, and data analysis patterns.

## What You'll Learn

- Most complex multi-table schema design (5 tables with cascading relationships)
- Pipeline/funnel tracking with status transitions
- Cross-extension integration with Extension 5 (Professional CRM)
- Advanced queries (conversion rates, timeline analysis, upcoming events)
- Bridge tables for linking separate data domains
- Handling nullable foreign keys and optional relationships

## Prerequisites

- Working Open Brain setup
- Extension 5 (Professional CRM) strongly recommended — cross-extension linking depends on it
- [Bun](https://bun.sh) 1.4+ and a Postgres carrying the Open Brain schema ([`SETUP.md`](../../SETUP.md)) — this server runs under Bun ([Run a Remote MCP Server](../../primitives/deploy-remote-mcp/); FORK.md change 74)
- **Background reading:** [Row Level Security](../../primitives/rls/) primitive — the per-user policies upstream's `schema.sql` carried; this fork's carries none (SMD-1810), the server scopes rows by `DEFAULT_USER_ID`

## Credential Tracker

You'll reference these values during setup. Copy this block into a text editor and fill it in as you go.

> **Your brain's connection string** is the one value this server needs from your setup — with the compose stack, [Run a Remote MCP Server, Step 1](../../primitives/deploy-remote-mcp/README.md#step-1-apply-the-extensions-schema) says how the database reaches the host and what the URL looks like, plus an access key — reuse one from your core setup or mint one for this server.

```text
JOB HUNT PIPELINE -- CREDENTIAL TRACKER
--------------------------------------

DATABASE (from your Open Brain setup)
  Postgres URL:          ____________  (SUPABASE_URL — the shim's name for it)

MCP SERVER (new for this extension)
  Default User ID:       ____________
  MCP Access Key:        ____________  (same key for all extensions)
  MCP Server URL:        ____________
  MCP Connection URL:    ____________

--------------------------------------
```

## Steps

### 1. Set Up the Database Schema

Run the SQL in `schema.sql` against your Open Brain database, as the role the server will connect with — `psql "$DATABASE_URL" -f extensions/job-hunt/schema.sql`, or paste it into the SQL client you use. This creates five tables with foreign keys and cascading deletes (`companies`, `job_postings`, `applications`, `interviews`, `job_contacts`), each with a `user_id` column the server fills from `DEFAULT_USER_ID`. `link_contact_to_professional_crm` writes into Extension 5's `professional_contacts`, so apply [professional-crm's schema](../professional-crm/README.md) too before using that tool.

Nothing is needed first. Upstream's file enabled row-level security on Supabase's `auth.uid()`, and this README used to give two stub functions to create before it; this fork removed the policies (SMD-1810) — one operator's brain on plain Postgres, the server scoping rows itself (SMD-1716). The role that applies the file owns the tables and needs no grant; any other role is granted them by `bun db/migrate.ts --grant <role>` (`db/README.md`, "Grants for a capturing role", the **extensions** group).

### 2. Generate Your User ID

The extension needs a user ID to scope your data. Generate a UUID and save it in your credential tracker:

```bash
# macOS / Linux
uuidgen | tr '[:upper:]' '[:lower:]'

# Or use any UUID generator — the value just needs to be unique to you
```

Set it in the server's environment (Step 3):

```bash
export DEFAULT_USER_ID=your-generated-uuid-here   # or on the command line in Step 3
```

> If you already set `DEFAULT_USER_ID` for a previous extension, you can skip this step — all extensions share the same user ID.

### 3. Run the MCP Server

This server runs under [Bun](https://bun.sh) against your Postgres: it imports the repository's SQL shim (`compat/supabase-sql`, Bun's Postgres client in supabase-js's shape) and is Bun-native — `process.env` for its environment, a default-exported `{ port, fetch }` that `bun` serves (SMD-1799) — one HTTP process, as every server here is ([Run a Remote MCP Server](../../primitives/deploy-remote-mcp/) walks it; FORK.md change 74; SMD-1798 moved this server, whose three-level `applications!inner(…, job_postings!inner(…, companies!inner(*)))` embed and `company_id.in.(…)` search the shim did not read until then). From a checkout of this repository:

```bash
(cd extensions && bun install)   # once: the pinned hono, zod and MCP SDK the server imports
SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
MCP_ACCESS_KEYS='laptop:write:paste-the-hash-here' \
DEFAULT_USER_ID='your-generated-uuid-here' \
PORT=8787 bun extensions/job-hunt/index.ts
```

`SUPABASE_URL` carries the Postgres connection string — the shim keeps the variable names, so the code does not change — and `SUPABASE_SERVICE_ROLE_KEY` may be left unset. Mint the access key as [Run a Remote MCP Server, Step 3](../../primitives/deploy-remote-mcp/README.md#step-3-mint-an-access-key) shows and set its `name:scope:hash` line in `MCP_ACCESS_KEYS` (the older single `MCP_ACCESS_KEY` still works, with write scope). Bun prints its start line, `Started development server: http://localhost:8787` (`Started server:` under `NODE_ENV=production`; `PORT` unset, it listens on 8000 — which podman's `gvproxy` also holds on macOS, hence 8787 here); your **MCP Server URL** is `http://your-host:8787/mcp`, and your **MCP Connection URL** adds the key: `http://your-host:8787/mcp?key=your-access-key` — a read-scoped key is the one to put in a connector URL. To reach it from a hosted client, put it behind the same TLS proxy as the core server ([`SETUP.md`](../../SETUP.md)). `extensions/test-auth.ts` starts the server this way in CI. Each server holds one pool of `OB1_PG_POOL` connections (ten unless set) for its life, shared by every request.

> **Every tool of this server runs on the fork.** `extensions/test-tools.ts` drives all ten against a real Postgres carrying this `schema.sql` and professional-crm's in CI — the pipeline and the upcoming interviews with their application, posting and company nested three deep, the contact search through a matched company, the link into Professional CRM (SMD-1798).

### 4. Connect to Your AI

Follow the [Remote MCP Connection](../../primitives/remote-mcp/) guide to connect this extension to Claude Desktop, ChatGPT, Claude Code, or any other MCP client.

| Setting | Value |
|---------|-------|
| Connector name | `Job Hunt Pipeline` |
| URL | Your **MCP Connection URL** from the credential tracker |

### 5. Test the Extension

Try these commands with Claude:

```
Add a company I'm tracking: TechCorp, enterprise software company, remote-first, San Francisco
```

```
Add a job posting at TechCorp: Senior AI Engineer, $150k-$200k, posted on LinkedIn
```

```
Submit an application for the TechCorp AI Engineer role, used resume v3
```

```
Schedule a phone screen interview for my TechCorp application, tomorrow at 2pm
```

```
Show me my pipeline overview - how many applications, what stages, upcoming interviews
```

```
Add a job contact at TechCorp: Jessica Lee, recruiter, jessica@techcorp.com
```

```
Show me my TechCorp job contacts
```

```
Link the TechCorp recruiter to my professional CRM
```

## Cross-Extension Integration

**This is the most sophisticated cross-extension integration in the learning path.**

### `link_contact_to_professional_crm` — The Bridge Tool

A recruiter you're talking to during the job search is also a professional contact worth maintaining. Your agent can create the CRM record automatically — the recruiter's name, company, and interaction history carry over. When you land the job (or don't), those contacts don't disappear from your network. They're already in your CRM, ready for the long-term relationship.

**Example workflow:**

1. You add a job contact with `add_job_contact`: "Jessica Lee, TechCorp recruiter, jessica@techcorp.com"
2. You have multiple interactions: phone screen, interview coordination, offer negotiation
3. If you need to recover the contact later, your agent uses `search_job_contacts` to find the right `job_contact_id`
4. Your agent uses `link_contact_to_professional_crm` to create a professional_contacts record in Extension 5
5. The `professional_crm_contact_id` field is set, creating a bidirectional link
6. After the job search ends, Jessica is already in your CRM with full context: company, role, all notes from the job search

**How it works technically:**

The bridge tool takes a `job_contact_id` from the `job_contacts` table. In normal use, your agent creates that row with `add_job_contact`, and if it needs to recover the UUID later it can call `search_job_contacts` first. Once it has the ID, it retrieves the contact details and creates a corresponding record in Extension 5's `professional_contacts` table. The `professional_crm_contact_id` field stores the link — this is application-managed rather than a database foreign key, because the two extensions live in separate table domains and you might install one without the other. This means:

- Future interactions in the job hunt also appear in the CRM context
- You can track the relationship long-term in Extension 5
- Your networking doesn't restart from zero after the job search

### Integration with Extensions 1-4

Your agent has even more context when you're job hunting:

- **Extension 1 (Household Knowledge):** Knows your current location, family situation relevant to relocation decisions
- **Extension 2 (Home Maintenance):** Understands timing constraints (e.g., "I can't start until after the roof replacement in May")
- **Extension 3 (Family Calendar):** Can schedule interviews around existing commitments, factor in family obligations
- **Extension 4 (Meal Planning):** Knows your dietary needs for interview lunches, can plan around busy interview days

This is the power of a fully interconnected Open Brain — context flows across domains.

## Available Tools

1. **`add_company`** — Add a company to track (name, industry, website, size, location, remote_policy, notes, glassdoor_rating)
2. **`add_job_posting`** — Add a specific role at a company (company_id, title, url, salary_min, salary_max, requirements, nice_to_haves, source, posted_date)
3. **`add_job_contact`** — Add a recruiter, hiring manager, referral, or interviewer to `job_contacts` (company_id, name, title, email, phone, linkedin_url, role_in_process, notes, last_contacted)
4. **`submit_application`** — Record a submitted application (job_posting_id, status, applied_date, resume_version, cover_letter_notes, referral_contact)
5. **`schedule_interview`** — Schedule an interview for an application (application_id, interview_type, scheduled_at, duration_minutes, interviewer_name, interviewer_title, notes)
6. **`log_interview_notes`** — Add feedback/notes after an interview, update status to completed (interview_id, feedback, rating 1-5)
7. **`get_pipeline_overview`** — Dashboard summary: counts by application status, upcoming interviews in next N days, recent activity. This is your "how's it going?" tool.
8. **`get_upcoming_interviews`** — List interviews in the next N days with full company/role context
9. **`search_job_contacts`** — Search or list job contacts to recover recruiter/interviewer records and IDs before linking or follow-up
10. **`link_contact_to_professional_crm`** — **CROSS-EXTENSION BRIDGE** — Takes a job_contact_id, creates/links to a professional_contacts record in Extension 5, sets professional_crm_contact_id

## Expected Outcome

After completing this extension, you should be able to:

1. Track companies and roles across your entire job search
2. Manage application status through the pipeline (applied → screening → interviewing → offer → accepted/rejected)
3. Schedule and log interviews with detailed notes and ratings
4. Track contacts (recruiters, hiring managers, interviewers) with CRM integration
5. Get pipeline analytics: conversion rates, stage distribution, interview performance
6. Bridge job search contacts into your long-term professional network

Your agent will be able to answer questions like:
- "Show me my pipeline overview"
- "What interviews do I have this week?"
- "What's my conversion rate from phone screen to technical interview?"
- "Which applications are in the proposal stage?"
- "Who's the recruiter at TechCorp and when did I last talk to them?"
- "Link all my TechCorp contacts to my professional CRM"

## Troubleshooting

For common issues (connection errors, 401s, deployment problems), see [Common Troubleshooting](../../primitives/troubleshooting/).

**Extension-specific issues:**

**"Foreign key violation" errors**
- Ensure parent records exist before creating child records (company → job_posting → application → interview)
- Verify UUIDs are correct and belong to the same user_id
- Deleting a company will cascade-delete all related postings, applications, and interviews

**"Extension 5 not found" when linking contacts**
- Verify Extension 5 (Professional CRM) is installed and its tables exist
- Check that the `professional_contacts` table is accessible
- Ensure both servers connect to the same database (the same `SUPABASE_URL`)

## Next Steps

**You've completed all 6 extensions!**

At this point, your agent has a comprehensive, interconnected system:

- **Extension 1:** Household knowledge (paint colors, appliances, vendors)
- **Extension 2:** Home maintenance (recurring tasks, service logs)
- **Extension 3:** Family calendar (events, recurring schedules)
- **Extension 4:** Meal planning (recipes, shopping lists, meal schedules)
- **Extension 5:** Professional CRM (contacts, interactions, opportunities)
- **Extension 6:** Job hunt pipeline (companies, applications, interviews)

All wired together through your Open Brain, with cross-extension tools that let context flow between domains.

### What's Next?

1. **Audit and optimize your tools** — You now have ~40 MCP tool definitions across 6 extensions. That's a lot of context weight. Run the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) to identify redundancies, merge CRUD tools, and scope your servers by workflow. This is the single highest-impact thing you can do to keep your AI performing well.
2. **Build your own extensions** — Use these 6 as templates for domains specific to your life
3. **Explore primitives** — Dive deeper into [Row Level Security](../../primitives/rls/), [Remote MCP](../../primitives/remote-mcp/), and other patterns
4. **Create compound queries** — Build tools that reason across multiple extensions simultaneously
5. **Share your extensions** — Contribute back to the OB1 community

[Explore Primitives →](../../primitives/)
