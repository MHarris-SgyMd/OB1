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

Every brain records who holds which work, so two agents never build one change (SMD-3596). This repo's board syncs into the maintainer's **stable** brain, the one sessions capture on. Claim only through a connector named `open-brain` whose `brain_info` says the stable tier: on the maintainer's machine, or reaching its stable brain through a tunnel. Don't print the connector's config to check, since it holds the key. Any other brain is not this repo's claim domain, whatever its `search` finds: a canary, which syncs the same board, and a contributor's own brain included. With one of those, skip the claim steps and say so.

If `open-brain` has no `claim_work` tool, say why:
- the brain's release predates SMD-3598, so neither `list_claims` nor `claim_work` is there;
- the key lacks write scope, so `list_claims` is there but `claim_work` isn't;
- the key is capture-scoped, so only `capture_thought` is there;
- the connector is down, so none of its tools answer; claim (step 2) once it answers again.

1. **Before recommending or starting work,** check the ticket's work, whatever tools you have:
   - **Find its work.** Run `git fetch`, then look at `git worktree list`, the branches carrying the ticket's id, and its open PRs (`gh pr list --search <ticket id> --state open`). If you can't read Linear or GitHub, say so and ask the user before starting. Without `list_claims`, an In Progress ticket with no branch or PR you can see is held all the same, perhaps on another machine: ask.
   - **Check its claims.** Call `list_claims` with `ticket` and `include_ended: true` for each ticket you consider. Without `include_ended` a lapsed claim isn't listed at all. If the reply says `truncated`, call it again with a larger `limit`, up to 1000.
   - **A claim whose id is in your worktree's `.work-claims/`** is yours, or your caller's: carry on (step 4).
   - **A live claim's work is held.** Leave it alone, and name the claim's label, holder and lease end.
   - **A released claim is history.** Pass it over.
   - **A lapsed claim is free only once its work is.** Under this rule a holder lapses after a day without renewing, or a week with its PR open.
     - A lapsed claim that was never released, whose PR hasn't merged or closed, may be work paused on another machine, unpushed. Tell the user before starting.
     - So is an unmerged worktree, branch or open PR for the ticket, with a claim or without one.
     - A lapsed claim whose PR merged or closed is free, even if its branch is still there.
     - Once the user says such work is dead, they release the claim with the operator key and a reason. Or you claim exactly its ticket and piece, which takes the lapsed claim over.
   - **A live claim can be stale.** Find its PR from the branch in its label (`gh pr list --head <branch> --state all`). If that PR merged or closed, or the ticket is Done or Canceled, the claim is stale: tell the user, naming its worktree if one is local. Its holder's next session there releases it, or an operator does.
2. **Before you create the branch,** call `claim_work` with:
   - `ticket`;
   - `piece` for one PR of several, spelled as the ticket's plan names it (`PR 1b-2`) or as `list_claims` already shows it;
   - `lease_seconds: 86400` (a day), so the claim outlasts a night waiting on the user;
   - a `label` naming your tool, machine and branch, such as `codex@laptop codex/smd-1234-short-name`.

   Then create the worktree and branch, keep the token (step 3), and move the ticket to In Progress for people reading Linear. On `WORK_CLAIMED`, read whose claim is in the way:
   - **its id is in your `.work-claims/`:** it is yours. Work under it, or release it and claim the piece. The reply's advice about a lost token is not for you.
   - **your key's, but not in your files:** another session of yours. Stop, and give the user its label from `list_claims`.
   - **another key's:** stop, and tell the user who holds it.

   **When a ticket's work splits into several PRs,** release the whole-ticket claim and delete its token file and any marker beside it, with `rm -f`: the hook may have just made an `.ended.json` of it. Claim the open PR's piece with `lease_seconds: 604800`, and each later piece when you create its worktree.

   **When you hand work to a subagent in another worktree,** name the claim id in the task: `.work-claims/` is not copied to a new worktree. A subagent works under a claim its caller names, or one in its worktree's files. It doesn't renew or release that claim, and it reports a marker (step 4) to its caller rather than deleting it.
3. **Keep the token** `claim_work` returns in `.work-claims/<claim id>.json` at the new worktree's root, as soon as the worktree exists, and nowhere else. Make the directory first (POSIX shell):

   ```sh
   mkdir -p .work-claims && chmod 700 .work-claims && printf '*\n' > .work-claims/.gitignore
   ```

   Then write the file and `chmod 600` it. `lease_seconds` is the lease you claimed with. `server` is the MCP server you claimed through, and the hook renews only on the brain whose connector it names:

   ```json
   {"id": "<claim id>", "token": "wc_…", "ticket": "SMD-1234", "piece": "PR 2", "lease_seconds": 86400, "server": "open-brain"}
   ```

   The directory's own `.gitignore` keeps it out of git on any branch. Never write the token anywhere else: not a commit, PR, ticket, comment, thought or log. Under your key, it proves the claim to anyone. While it is there, don't run anything that copies or deletes it:
   - `git stash -a`;
   - `git clean -x` or `-X`;
   - `git worktree remove`, with or without `--force`. Git counts an ignored file as clean.
4. **Renew** with `renew_claim`: the id, the token, and `lease_seconds` from the token file, every time. A renewal without it shortens the lease to four hours. Any `claim_work` with your token renews too, so pass the file's lease there as well. Renew at each commit, before each push, after each long test run, and on each resume. Claude Code's session hook also renews from the token file once it has the key (`recipes/session-capture-hook/`, "Renewing work claims"). It is a backstop, and only for a session whose working directory is inside the worktree.
   - **Before any renewal,** look beside the token file. A `<claim id>.ended.json` or `<claim id>.blocked.json` there means don't renew: handle it as below.
   - **On resume, or after a compaction,** read `.work-claims/`. Release a claim whose PR has merged (step 6), and renew the others; then look beside each token file again, since a renewal can leave a marker. To tell: `gh pr view <branch> --json state`; without `gh`, after `git fetch`, the branch has commits and its head is on `origin/main`.
   - **If your claim may have lapsed** (`list_claims` shows it `lapsed`, or you were away longer than its lease), list the ticket's claims with `include_ended: true` before renewing. Another claim made on its work since your lease ran out means tell the user first. Claude Code's hook makes this check before it revives a claim it knows lapsed, but your own renewals are yours to check.
   - **Read every renewal's reply for a lapse,** expected or not. Since SMD-3654 a renewal that revived a lapsed claim says when it had lapsed, and names any claim made or renewed on its work meanwhile. Your claim is renewed by then.
     - **It names a claim made or renewed meanwhile:** another agent may have built part of the work. Handle it as `WORK_CLAIMED`, below. One under your own key may be another session of yours: give the user its label from `list_claims`.
     - **It couldn't read them, or couldn't tell whether the claim had lapsed:** make the check it gives. List the ticket's claims with `include_ended: true`; one on its work claimed or renewed after the time it names is handled as above, and with none, delete any marker beside the token file and carry on.
     - **It says no other claim was made or renewed:** carry on.
     - **A claim the user already decided on,** by its claim id, is no new stop. Renewing after their "carry on" revives your claim, so the reply, or the hook's next marker, names the claim that was in the way again: delete the marker and carry on.
     - **After any lapse, or time away longer than the lease,** run step 1's "Find its work" again before you push: a branch or PR for the ticket may have appeared meanwhile. The hook's log line says when its own renewal found a lapse.
   - **A refusal saying the claim was released, or lapsed and was taken over,** means stop work on it and tell the user. So does an `.ended.json`, which the hook leaves when it finds the claim ended. Don't claim the work again without asking, whatever a reply suggests.
   - **`WORK_CLAIMED` on a renewal,** yours or the hook's, means your claim lapsed and another claim now covers its work. It shows as a `<claim id>.blocked.json`: the hook writes one for its own renewal, for yours when its claims hook is pasted, and with the code `CLAIMED_WHILE_LAPSED` when a renewal's reply names claims made or renewed while the claim had lapsed (or couldn't read them, or whether it had lapsed), or instead of reviving a claim it finds lapsed with another claim made or renewed on its work since. A `CLAIMED_WHILE_LAPSED` marker saying something couldn't be read gets the check above first; stop only if the check finds a claim. With no marker, treat your own refusal the same. Another agent may have built part of the work since. Stop: finish a local commit in progress, but don't push, open a PR or ask for a merge. Tell the user, and renew again only on their decision:
     - **carry on:** the other claim must end first, if it is still live (a `CLAIMED_WHILE_LAPSED` marker's may have ended already). Its holder releases it, or the user releases it with the operator key and a reason. Then delete the marker and renew with the file's lease.
     - **drop it:** call `release_claim` on your claim (a lapsed claim can be released), then delete the token file and the marker.
     - **split around it:** follow "When a ticket's work splits" in step 2.

     If the claim in the way has its id in your `.work-claims/`, it is your own piece: release the older claim and delete its files.
5. **When you open the PR, or hand over the command that opens it,** set `"lease_seconds": 604800` (a week) in the token file, then renew with it. The claim then holds while the PR waits for review.
6. **Release** at merge or abandon, before removing the worktree:
   - **Before you ask for the merge,** renew. A refusal saying the claim was taken over means someone else may have built the work: tell the user instead of merging.
   - **After the merge, or the abandon,** call `release_claim` with the id, the token and a `reason` (the merged PR, or why the work was dropped). Then delete the token file and any marker beside it, with `rm -f`.
   - **If the merge happened after your session ended,** the next session in the worktree releases first (step 4).
7. **If you lose the token,** wait for the lease to lapse and claim the work again: your key takes over its own lapsed claim with a new token. A re-claim of work whose PR is open takes `lease_seconds: 604800`. Or ask the user to release it with an operator key, with a reason.

**Keys.** A claim belongs to its key's agent id: the key that claimed it renews it, and no other. The operator key can force-release any claim, and it belongs to the person, so sessions should hold an agent-kind key.

A default install hands its one key to the coding client, and SETUP.md classifies that key `operator`. A claim's reply shows it as `holderKind: "operator"`. `null` means a key never classified. The kind is stamped when the claim is made, so an older claim keeps the kind it was made with. **Don't change keys yourself:** tell the user, and point them here. These are their steps, on the machine that runs the brain, from its main checkout:
1. `bun server-portable/keygen.ts --name <a name no key has had> --scope write`. Add the printed line to `MCP_ACCESS_KEYS`, replacing no other line: a name twice keeps the REST core from starting.
2. Restart the stack, so the server reads the new key.
3. `SELECT set_agent_kind('<that name>', 'agent');`
4. Point the connector at the new key, and copy it into the session hook's `claim_key_file`.

Do this only while the key holds no live claims.

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

