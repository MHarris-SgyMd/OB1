# OB1 Agent Instructions

## Parallel Agent Worktrees

When multiple AI agents or assistant chats work on this repo, do not put them in the same checkout.

### Setup pattern

- Treat the main repo checkout as the canonical repo for pulling, inspection, and creating worktrees.
- Create one Git worktree per active agent, task, or PR-sized workstream.
- Give each worktree a descriptive folder name and a matching branch name.
- Start every agent task by naming the exact absolute worktree path it owns.
- The assigned worktree path is the boundary. The chat is not the boundary.

### Agent assignment template

Start each parallel-agent task with:

```text
Repository worktree:
/ABSOLUTE/PATH/TO/PROJECT-WORKTREE

Branch:
codex/SHORT-TASK-NAME

Task:
DESCRIBE THE EXACT WORK.
```

### Rules

- Do not switch branches in the canonical repo while another agent may be working.
- Do not edit sibling worktrees unless explicitly asked.
- Before staging or committing, run `git status --short` and stage only files that belong to the current task.
- If `main` or another branch changed underneath the worktree, pause before merging or rebasing unless the task explicitly says to finish the PR end to end.
- After a branch is merged and the worktree is clean, release its claims ("Claim your work", step 6), then remove the finished worktree with `git worktree remove /ABSOLUTE/PATH/TO/PROJECT-WORKTREE`.

### Claim your work

Every brain records who holds which work, so two agents never build one change (SMD-3596). This repo's board syncs into the maintainer's **stable** brain, the one sessions capture on. Claim there, through the MCP server that reaches it: `open-brain`, at `http://127.0.0.1:8010/mcp`, on the maintainer's machine. A canary is a separate claim domain, so a claim there protects nothing. If your brain isn't that one (its `search` finds no SMD tickets), this repo has no claim domain for you: skip the claim steps and say so.

If the brain has no `claim_work` tool, say which cause it is:
- its release predates SMD-3598;
- your key lacks write scope;
- the connector is down.

Then, in place of step 1, check `git worktree list`, the branches carrying the ticket's id, and its Linear status before recommending or starting it.

1. **Before recommending or starting work,** call `list_claims` with `include_ended: true`: with `ticket` for one ticket, or without it for every claim when choosing among several.
   - Leave a live claim's work alone, and name its label, holder and lease end.
   - A `lapsed` claim that was never released, whose branch or PR still exists, is paused work, not free work. Name it, and ask the user before claiming.
   - `list_claims` stays the check until this line names another, such as SMD-3599's `claimed` label.
2. **Before you create the branch,** call `claim_work` with:
   - `ticket`;
   - `piece` for one PR of several, spelled as the ticket's plan names it (`PR 1b-2`) or as `list_claims` already shows it;
   - a `label` naming your tool, machine and branch, such as `codex@laptop codex/smd-1234-short-name`.

   Then create the branch, and move the ticket to In Progress for people reading Linear. On `WORK_CLAIMED`, read whose claim is in the way:
   - **its id is in your `.work-claims/`:** it is yours. Work under it, or release it and claim the piece.
   - **your key's, but not in your files:** another session of yours. Stop, and give the user its label from `list_claims`.
   - **another key's:** stop, and tell the user who holds it.
3. **Keep the token** `claim_work` returns in `.work-claims/<claim id>.json` at the worktree's root, and nowhere else. Make the directory first:

   ```sh
   mkdir -p .work-claims && chmod 700 .work-claims && printf '*\n' > .work-claims/.gitignore
   ```

   Then write the file and `chmod 600` it. `server` is the MCP server you claimed through:

   ```json
   {"id": "<claim id>", "token": "wc_…", "ticket": "SMD-1234", "piece": "PR 2", "server": "open-brain"}
   ```

   The directory's own `.gitignore` keeps it out of git on any branch. This git-ignored file is the one place the token may be written: never a commit, PR, ticket, comment, thought or log. Under your key, it proves the claim to anyone. Don't run `git stash -a` or `git clean -X` while it is there.
4. **Renew** with `renew_claim` (the id and the token) at each commit, before each push, after each long test run, and on each resume. If two of those are more than about three hours apart, renew in between: the lease is four hours. Claude Code's session hook also renews from the token file once it has the key (`recipes/session-capture-hook/`, "Renewing work claims"), but it is a backstop, so renew yourself.
   - On resume, or after a compaction, read `.work-claims/` and renew each claim in it.
   - A refusal saying the claim was released, or lapsed and was taken over, means stop work on it and tell the user. So does a `<claim id>.ended.json` in `.work-claims/`, which the hook leaves when it finds the claim ended; read its `ended.message`. Don't claim the work again without asking.
   - `WORK_CLAIMED` on a renewal means your claim lapsed and another claim now covers its work: stop while that one holds.
5. **When you open the PR,** renew with `lease_seconds: 604800` (a week), and add `"lease_seconds": 604800` to the token file. The claim then holds while the PR waits for review, and the hook renews it at that lease.
6. **Release** at merge or abandon, before removing the worktree. Call `release_claim` with the id, the token and a `reason` (the merged PR, or why the work was dropped), then delete the token file. If the reply says the claim had already ended because it was taken over, someone else may have built the work: tell the user before merging or deleting anything.
7. **If you lose the token,** wait for the lease to lapse and claim the work again: your key takes over its own lapsed claim with a new token. Or ask an operator for a forced release, with a reason.

**Keys.** A claim belongs to its key's agent id: the key that claimed it renews it, and no other. Give sessions an agent-kind key, set with `SELECT set_agent_kind('<key name>', 'agent');`. The operator key, which can force-release any claim, belongs to the person. Switch a session's key only when it holds no live claims.

### Quick checks

- If another chat suddenly changed branches, both chats were probably in the same working directory.
- If `git worktree add` says a branch is already checked out, create a new branch name or remove the old clean worktree.
- If cleanup fails, inspect `git status --short` and preserve uncommitted work.

## Required Step: Update Linear

- For feature work tied to a Linear issue, update Linear at the start of the work, at meaningful checkpoints, and before handing back to the user.
- Use the parent issue as the living implementation log and keep child issues aligned with the files and behavior being changed.
- For the OB1 Agent Memory / OpenClaw launch work, the parent issue is `NAT-833`. Record architecture notes, implementation milestones, blockers, and verification results there.
- Do not wait until the end to document decisions. If a decision changes schema, API contract, trust policy, user-facing workflow, or publishing path, capture it in Linear while it is still fresh.

## Agent Memory Product Guardrails

- Keep `OB1 Agent Memory` runtime-neutral. OpenClaw is the flagship launch runtime, not the product boundary.
- Treat inferred or generated memory as evidence by default. Instruction-grade memory requires human confirmation or trusted import.
- Avoid raw transcript, model reasoning trace, secret, and large-code-block storage by default.
- Avoid profanity in all content. Keep docs, examples, seed data, UI copy, prompts, walkthroughs, and generated assets clean and professional.
- Prefer diagram-first documentation for this work: diagram, short explanation, copy-paste setup, then deeper reference.
- Carry Nate B. Jones / OB1 provenance through product surfaces, docs, diagrams, screenshots, and starter seed data. Keep it subtle and useful: micro-branding, source labels, logo marks, and provenance language instead of loud marketing copy.
- Treat public OB1 assets as helpful-first audience growth for Nate Jones. Every public guide, recipe, tutorial, package page, release note, and walkthrough should point back to Nate's Substack and site in a natural way: https://substack.com/@natesnewsletter and https://natebjones.com.
- Make the case by being genuinely useful. The CTA should feel earned: "Nate gives away practical systems like this" rather than generic marketing copy.
- For ClawHub/OpenClaw publishing, do not fall back to Jonathan's personal handle or any non-Nate namespace. If `@natebjones` / Nate OB1 ownership is not available, stop and record the blocker.

## Tracker and repository hygiene

Standing practice (Jonathan, 2026-08-30): the ticket board and the branch list must describe reality, so nobody starts a work session by cleaning up.

- At the end of every substantial working session — and always before marking a carrier issue `Done` — audit the project's open Linear issues against what actually shipped.
- Close as `Done` any issue whose deliverable now objectively exists, with a one-line evidence comment naming the merged pull request or the artifact.
- Cancel any issue whose subject was cut or superseded by a recorded decision, with a one-line comment naming that decision. When a parent's children split between delivered and superseded, say which went where in one parent comment.
- An issue that is merely old is not stale; an issue that no longer describes work anyone intends is. When ownership of a lane is unclear, leave the lane and flag it to its owner instead of judging it.
- Delete merged branches, local and remote, after every merge (`git push origin --delete BRANCH`, then `git remote prune origin`). Close superseded pull requests with a comment saying what replaced them.
- Keep large binaries out of git history: recordings, exports, and other heavy artifacts go to Agent Drop (or another owned store) with the link committed in their place.

