# Extensions

https://github.com/user-attachments/assets/cc477f00-bb6b-4f96-9f7d-a6bcd0cf8b60

Extensions are the curated learning path of Daemonic Brain. Build them in order — each one teaches new concepts through something you'll actually use. By the end, your agent manages your household, your schedule, your meals, your professional network, and your career — all interconnected.

| # | Extension | What You Build | Difficulty |
| --- | --------- | -------------- | ---------- |
| 1 | [Household Knowledge Base](household-knowledge/) | Home facts your agent can recall instantly | Beginner |
| 2 | [Home Maintenance Tracker](home-maintenance/) | Scheduling and history for home upkeep | Beginner |
| 3 | [Family Calendar](family-calendar/) | Multi-person schedule coordination | Intermediate |
| 4 | [Meal Planning](meal-planning/) | Recipes, meal plans, grocery lists | Intermediate |
| 5 | [Professional CRM](professional-crm/) | Contact tracking wired into your thoughts | Intermediate |
| 6 | [Job Hunt Pipeline](job-hunt/) | Application tracking and interview pipeline | Advanced |

Extensions compound. Your CRM knows about thoughts you've captured. Your meal planner checks who's home this week. Your job hunt contacts become professional network contacts.

## Prerequisites

Every extension requires a working Daemonic Brain setup. If you haven't built one yet, start with the [Setup Guide](../docs/01-getting-started.md).

## Access Keys

Every extension is a plugin since SMD-2311: its tools are on the brain's own connector, behind the brain's own keys, with no server or key list of its own to set up, and each extension's README says how to turn it on. The extension servers authenticated the way the core server does, through `_shared/auth.ts` — a copy of `server-portable/auth.ts` beside the extensions, held byte-for-byte identical by the test, until SMD-3747 retired it, the servers having gone with SMD-2311 — and `integrations/test-auth.ts` still asserts the vendored recipe and integration servers' keys work that way (FORK.md change 67; `bun install && bun test-auth.ts` in `integrations/`): keys are named, scoped `read` or `write`, and stored as SHA-256 hashes in the server's `MCP_ACCESS_KEYS` environment variable, each revocable on its own. A read-scoped key may only dry-run a worker (the last HTTP APIs, whose routes refused it with a 403, became plugins with SMD-2690). The older single `MCP_ACCESS_KEY` still works, with write scope. Step 3 of [Run a Vendored Server](../primitives/deploy-remote-mcp/) mints one. The suites and their install moved to `integrations/` with SMD-3747, which retired `_shared/` and test-auth's MCP checks (change 78's overlapping requests among them), since no vendored MCP server is left on the shared install (the Vercel recipe's route runs on its own).

## Contributing

Extensions are **curated** — discuss with maintainers before submitting. [Propose a new extension](https://github.com/NateBJones-Projects/OB1/issues/new?template=extension-submission.yml).
