# Extensions

https://github.com/user-attachments/assets/cc477f00-bb6b-4f96-9f7d-a6bcd0cf8b60

Extensions are the curated learning path of Open Brain. Build them in order — each one teaches new concepts through something you'll actually use. By the end, your agent manages your household, your schedule, your meals, your professional network, and your career — all interconnected.

| # | Extension | What You Build | Difficulty |
| --- | --------- | -------------- | ---------- |
| 1 | [Household Knowledge Base](household-knowledge/) | Home facts your agent can recall instantly | Beginner |
| 2 | [Home Maintenance Tracker](home-maintenance/) | Scheduling and history for home upkeep | Beginner |
| 3 | [Family Calendar](family-calendar/) | Multi-person schedule coordination | Intermediate |
| 4 | [Meal Planning](meal-planning/) | Recipes, meal plans, shared grocery lists | Intermediate |
| 5 | [Professional CRM](professional-crm/) | Contact tracking wired into your thoughts | Intermediate |
| 6 | [Job Hunt Pipeline](job-hunt/) | Application tracking and interview pipeline | Advanced |

Extensions compound. Your CRM knows about thoughts you've captured. Your meal planner checks who's home this week. Your job hunt contacts automatically become professional network contacts.

## Prerequisites

Every extension requires a working Open Brain setup. If you haven't built one yet, start with the [Setup Guide](../docs/01-getting-started.md).

## Access Keys

Every extension server authenticates the way the core server does, through `_shared/auth.ts` — a copy of `server-portable/auth.ts` that Supabase bundles with each function, held byte-for-byte identical by the test: keys are named, scoped `read` or `write`, and stored as SHA-256 hashes in the `MCP_ACCESS_KEYS` secret, each revocable on its own. A read-scoped key is never given the tools that write, so it does not see them in `tools/list` — that is the key to put in a connector URL. The older single `MCP_ACCESS_KEY` still works, with write scope. Step 3 of [Deploy an Edge Function](../primitives/deploy-edge-function/) mints one; `test-auth.ts` here asserts all seven servers behave this way — and, since FORK.md change 67, every vendored recipe and integration server too (`bun install && bun test-auth.ts`).

## Contributing

Extensions are **curated** — discuss with maintainers before submitting. [Propose a new extension](https://github.com/NateBJones-Projects/OB1/issues/new?template=extension-submission.yml).
