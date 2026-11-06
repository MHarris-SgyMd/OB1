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

A complete job search management system — companies, postings, applications, interviews, and contacts. The most complex extension in the learning path, with 5 tables and a link into your Professional CRM (Extension 5).

In Daemonic Brain the job hunt is a **plugin**: [`plugins/job-hunt`](../../plugins/job-hunt/) (SMD-2311). It runs inside the brain's own servers, behind the brain's own keys, and its tools appear on the MCP connector you already have. There is no separate server, key list, connector or `DEFAULT_USER_ID` to set up. Its tables live in a schema of its own, `plugin_job_hunt`, which the brain's migrator makes when the plugin is turned on.

**Tables:**
- `companies` — The organizations in your search
- `job_postings` — Specific roles at them
- `applications` — What you applied to, and where each stands
- `interviews` — Each interview, before and after
- `job_contacts` — Recruiters, hiring managers, referrals and interviewers

**Tools** (each also a REST route under `/v1/plugins/job-hunt/`):
- `job_hunt_add_company` — Add a company to track
- `job_hunt_list_companies` — Find companies, and their ids
- `job_hunt_update_company` — Rename a company, or fix its details
- `job_hunt_add_job_posting` — Add a role at a company, with its salary range and requirements
- `job_hunt_list_job_postings` — Find postings, by company, words, still open, or closing soon
- `job_hunt_update_job_posting` — Change a posting's salary, dates or requirements
- `job_hunt_add_job_contact` — Add a recruiter, hiring manager, referral or interviewer
- `job_hunt_search_job_contacts` — Find job contacts, or those not yet in your CRM
- `job_hunt_update_job_contact` — Change a contact's details, or when you last spoke
- `job_hunt_link_contact_to_professional_crm` — **The bridge:** record which CRM contact a job contact is
- `job_hunt_submit_application` — Record an application
- `job_hunt_list_applications` — Find applications by status, company or posting
- `job_hunt_update_application` — Move an application on, from screening to an offer
- `job_hunt_schedule_interview` — Schedule an interview for an application
- `job_hunt_list_interviews` — Find interviews, past, cancelled or with no time yet
- `job_hunt_update_interview` — Reschedule an interview, change its prep notes, or cancel it
- `job_hunt_log_interview_notes` — Record how an interview went
- `job_hunt_get_pipeline_overview` — **Your "how's it going?" tool:** every status counted, interviews coming up, and those still waiting for notes
- `job_hunt_get_upcoming_interviews` — The interviews in the next N days, with their company and role

The old server's ten tools keep their names under the plugin's prefix; the four lists and the five changes are new. The plugin's [README](../../plugins/job-hunt/README.md) gives each one's input, output and refusals.

## What You'll Learn

- Multi-table schema design (5 tables, each child naming its parent)
- Pipeline/funnel tracking with status transitions
- Cross-extension integration with Extension 5 (Professional CRM), with no plugin reaching into another's tables
- Pipeline queries (status counts, upcoming interviews, interviews waiting for notes)
- Handling nullable foreign keys and optional relationships

## Prerequisites

- Working Daemonic Brain setup: the compose stack ([`SETUP.md`](../../SETUP.md)) and an MCP client connected to it ([Getting Started](../../docs/01-getting-started.md), Steps 6 and 7)
- Extension 5 (Professional CRM) recommended — the link into it needs the CRM plugin on

## Steps

### 1. Turn on the Plugin

Add the plugin to `deploy/.env`, with the secret the plugins' database logins are derived from (skip the second line if another plugin already set it):

```
OB1_PLUGINS=professional-crm,job-hunt
OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
```

Then recreate the migrator and the servers from `deploy/`, naming the stack's other `-f` files as you brought it up:

```bash
docker compose up -d migrate api mcp
docker compose up -d --force-recreate --no-deps app   # the operator GUI, so it reaches the recreated REST core; it signs everyone out
```

The migrator makes the plugin's tables, and the servers start with its nineteen tools.

### 2. Check Your AI Sees It

Your MCP client lists the `job_hunt_*` tools on the brain's own connector, once it refreshes its tool list. A read key sees the seven that read. A write key sees all nineteen.

### 3. Test It

Try these prompts:

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
Link the TechCorp recruiter to my professional CRM
```

## Cross-Extension Integration

**This is the most sophisticated cross-extension integration in the learning path.**

### `job_hunt_link_contact_to_professional_crm` — The Bridge Tool

A recruiter you're talking to during the job search is also a professional contact worth maintaining. When you land the job (or don't), those contacts don't disappear from your network. They're already in your CRM, ready for the long-term relationship.

**Example workflow:**

1. You add a job contact: "Jessica Lee, TechCorp recruiter, jessica@techcorp.com"
2. You have multiple interactions: phone screen, interview coordination, offer negotiation
3. You ask to link her to your CRM. Your agent finds her `job_contact_id` with `job_hunt_search_job_contacts`
4. It looks for her in the CRM with `professional_crm_search_contacts`, and adds her with `professional_crm_add_contact` only if she is not there (her name, TechCorp, her title and email, "Job search: recruiter" as how you met)
5. It records that contact's id on her job contact with `job_hunt_link_contact_to_professional_crm`
6. After the job search ends, Jessica is already in your CRM

**How it works technically:**

No plugin calls another or reads another's tables, so the link is two steps your agent takes, each through the brain's own tools: the CRM finds the contact, or adds it if it is not there, and the job hunt records its id in `professional_crm_contact_id`. That id is not a database foreign key — the two plugins' tables live in separate schemas, and you might turn on one without the other — so the job hunt cannot check the CRM has that contact. Linking again to the same id changes nothing; a job contact already linked to another is refused until you unlink it. `job_hunt_search_job_contacts` with `only_unlinked` lists who is not in your CRM yet.

### Integration with Extensions 1-4

Your agent has even more context when you're job hunting:

- **Extension 1 (Household Knowledge):** Knows your current location, family situation relevant to relocation decisions
- **Extension 2 (Home Maintenance):** Understands timing constraints (e.g., "I can't start until after the roof replacement in May")
- **Extension 3 (Family Calendar):** Can schedule interviews around existing commitments, factor in family obligations
- **Extension 4 (Meal Planning):** Knows your dietary needs for interview lunches, can plan around busy interview days

This is the power of a fully interconnected brain — context flows across domains.

## Expected Outcome

After completing this extension, you should be able to:

1. Track companies and roles across your entire job search
2. Manage application status through the pipeline (applied → screening → interviewing → offer → accepted/rejected)
3. Schedule and log interviews with detailed notes and ratings
4. Track contacts (recruiters, hiring managers, interviewers) with CRM integration
5. See the pipeline at a glance: every status counted, interviews coming up, interviews waiting for notes
6. Bridge job search contacts into your long-term professional network

Your agent will be able to answer questions like:
- "Show me my pipeline overview"
- "What interviews do I have this week?"
- "Which of my interviews haven't I written up yet?"
- "Which postings close this week?"
- "Which applications are at the offer stage?"
- "Who's the recruiter at TechCorp and when did I last talk to them?"
- "Link all my TechCorp contacts to my professional CRM"

## Troubleshooting

For common issues (connection errors, 401s), see [Common Troubleshooting](../../primitives/troubleshooting/). The plugin's own troubleshooting is in [its README](../../plugins/job-hunt/README.md#troubleshooting).

**Extension-specific issues:**

**No `job_hunt_*` tools**
- Check that `OB1_PLUGINS` in `deploy/.env` names `job-hunt`, and that the migrator and servers were recreated after it was set
- Refresh your client's tool list

**`NO_SUCH_COMPANY`, `NO_SUCH_POSTING` or `NO_SUCH_APPLICATION`**
- Each child names its parent: a company before a posting, a posting before an application, an application before an interview. The list tools give each one's id

**No `professional_crm_*` tools to link with**
- The link's first step is the CRM's: turn on the `professional-crm` plugin too ([Extension 5](../professional-crm/README.md))

## Next Steps

**You've completed all 6 extensions!**

At this point, your agent has a comprehensive, interconnected system:

- **Extension 1:** Household knowledge (paint colors, appliances, vendors)
- **Extension 2:** Home maintenance (recurring tasks, service logs)
- **Extension 3:** Family calendar (events, recurring schedules)
- **Extension 4:** Meal planning (recipes, shopping lists, meal schedules)
- **Extension 5:** Professional CRM (contacts, interactions, opportunities)
- **Extension 6:** Job hunt pipeline (companies, applications, interviews)

All wired together through your brain, with cross-extension tools that let context flow between domains.

### What's Next?

1. **Audit and optimize your tools** — With all six plugins on, your AI holds ~56 tool definitions from them. That's a lot of context weight. Run the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) to identify redundancies and turn on only the plugins a workflow needs. This is the single highest-impact thing you can do to keep your AI performing well.
2. **Build your own** — Use these 6 as models for domains specific to your life: a new one is a plugin ([`plugins/`](../../plugins/), starting from `plugins/example/`)
3. **Explore primitives** — Dive deeper into the [primitives](../../primitives/) and other patterns
4. **Create compound queries** — Build tools that reason across multiple extensions simultaneously
5. **Share your work** — Contribute back to the OB1 community

[Explore Primitives →](../../primitives/)
