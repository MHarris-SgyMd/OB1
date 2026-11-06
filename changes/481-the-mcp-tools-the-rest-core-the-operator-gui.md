# 481. The MCP tools, the REST core, the operator GUI, the sign-in page, Grafana and the operator messages say Daemonic Brain where they said Open Brain (SMD-3769)

**What changed.** Two PRs. "Open Brain" as the product's name becomes Daemonic Brain wherever the running brain shows it to a client, an operator or a model. Where the text named one brain rather than the product, it now says "the brain".
- **The MCP tools** (`server-portable/core/schemas.ts`):
  - The ChatGPT-shaped pair are now "Search Daemonic Brain" and "Fetch Daemonic Brain Thought". Their descriptions and argument descriptions say Daemonic Brain.
  - `thought_changes` lists "what changed in the brain", `brain_info` says "what this brain is", and `capture_thought` saves "a new thought to the brain". Its next sentence already said "their brain", so "your brain" would have mixed the voices.
- **An undated thought's title** starts "Daemonic Brain" (`thoughts.ts`'s fallback). That is how `search` and `fetch` return it, and how the GUI's thought page shows it.
- **The REST core's OpenAPI title** is "Daemonic Brain REST core". `rest-client/openapi.json` and `schema.d.ts` were regenerated (`bun generate.ts`), and they differ from main only in these strings.
- **The operator GUI:**
  - the shell's header (`+layout.svelte`);
  - every page's `<title>`: 16 pages, `+error.svelte` among them;
  - the favicon's `aria-label`.
- **The authorization server's sign-in page** is titled "Daemonic Brain sign-in" (`deploy/auth/pages.ts`).
- **What the brain shows an operator, outside the ticket's list:**
  - `db/tier.ts`'s refusal now says "is not a Daemonic Brain schema". Its doc comment and `deploy/tier.sh`'s comment changed with it.
  - `db/test-support.ts`'s drop-schema warning now says "every table the brain owns". The line keeps its wrap.
  - `db/board-findings.ts`'s comment on a Linear ticket now opens "**Daemonic Brain found something about …**".
- **Grafana (PR 2):**
  - The dashboard's title and tag, and its alert rule group and folder, are Daemonic Brain (`deploy/observability/`). So is compose.yaml's provider folder.
  - `bun scripts/inline-grafana.ts` rewrote compose.yaml's inline copies and `lgtm`'s three sha256 labels, so an `up -d` recreates `lgtm`.
  - The home page moves to `/grafana/d/default-home-dashboard/daemonic-brain`, the title's slug.
  - These follow: checks 37's and 38's identity rules and probes, `brain-checks.yml`'s home and alert-group checks, `deploy/README.md`, and compose.yaml's header.
  - The uid `ob1`, the provider's name, the provisioning paths and the servers' `service.name`s are identifiers, so they stay.
- **An upgraded install keeps the old folder, empty.** Measured on the pinned image (otel-lgtm 0.36.0) on one data volume, started with main's files and then with these:
  - Grafana created a Daemonic Brain folder and moved the dashboard and all five rules into it, under the group Daemonic Brain.
  - The Open Brain folder stayed, with no dashboard and no rule.

  `deploy/README.md` gives a command to run once Grafana opens on Daemonic Brain. It deletes the folder only when no dashboard is left in it, says so when there is no such folder, and fails, deleting nothing, when Grafana does not answer. Measured four ways:
  - while the dashboard was still in the folder, it refused, naming why;
  - with a wrong admin password, it failed (exit 1) and deleted nothing;
  - on the emptied folder, it deleted it, and the new folder's dashboard and rules were as before;
  - run again, it found nothing.
- **The READMEs that use the changed terms:**
  - `server-portable/README.md`'s first line, for the REST core;
  - the tier refusal's "Daemonic Brain schema" in `deploy/README.md` and `db/README.md`.
- **Comments and sample data in the same directories:**
  - `deploy/smoke.sh`'s header;
  - the sample project in `test-thoughts.ts` and `test-local-provider.ts`, case kept. One sorted expectation reorders: the new name sorts before "Dev".
  - `test-local-provider.ts`'s two comments that put each paragraph at ~330 estimated tokens were wrong before this change. `chunk.ts`'s `estimateTokens` measures ~575, with either name.

The bump is a patch: no tool, argument or route changed, only text (MAINTAINING.md's version rules). A client that matches a tool by name still finds it. Grafana's dashboard keeps the address `deploy/README.md` gives, `/grafana/d/ob1`, which is its uid. Only the slug Grafana appends, and so the home page's address, follows the title.

**Why.** On 2026-11-04 the maintainer decided the live text says Daemonic Brain now (SMD-1929, SMD-3765). SMD-3765 rewrote the front door's heads, but a model still read "Search Open Brain" on every session, and an operator still saw "· Open Brain" on every GUI tab.

**Held.**
- The suites that assert the changed strings now hold the new ones:
  - `test-thoughts.ts` (the undated prefix);
  - `test-e2e-sql.ts` (`fetch`'s title for an undated row);
  - `db/test-live.ts` (the tier refusal, two rows);
  - `db/test-board-findings.ts` (the comment's first line).
- `rest-client/test-client.ts` holds the regenerated files to the document.
- `db/ci-parity.sh` passes: every suite, the typechecks, `svelte-check` over the GUI, and the authorization server's rules.
- `bun scripts/inline-grafana.ts --check` passes, and so do checks 37 and 38 with their renamed probes.
- `git grep -n -i "open brain" -- server-portable dashboard deploy mcp-server rest-client ':!*.md' ':!*.env*'` finds only these, each left on purpose:
  - `test-preflight.ts`'s `OB1_LINEAR_INITIATIVE` default;
  - `propose.ts`'s example, a real Linear project's name.

**Not done here.**
- **Real names stay, and identifiers stay for SMD-3771 to decide:**
  - `OB1_LINEAR_INITIATIVE`'s default, the prefix board-sync matches the Linear initiative by;
  - `propose.ts`'s example project;
  - the dashboard `uid`, `SERVER_NAME`, the `open-brain` connector and project, and `OB1_*`, `ob1-*` and `ob1_`;
  - n8n's owner name, `OB1`, in `compose.yaml`.
- **SMD-3770's count:**
  - `db/`'s sample data and comments: `graph-centrality.ts`'s examples, `sync-linear.ts`'s fixtures, `test-cli.ts`'s subject, and `test-schema.ts`'s and `test-live.ts`'s sample project;
  - the orchestration eval fixtures under `evals/orchestration/`.
- **SMD-3765's sweep (not yet listed there):**
  - `scripts/release-artifacts.ts`'s release-notes header and image descriptions, which also say "the OB1 fork";
  - preflight's warning about "the fork's callers" (`preflight.ts`).
