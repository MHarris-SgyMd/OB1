# 482. claim_work with the registry away refuses the caller's own claim as renew_claim does — no silent takeover of its own lapsed claim (SMD-3705)

**What changed.** The core's `claimWork` (`server-portable/core/claims.ts`) refuses before 115's writer when four things hold:
- the caller has no agent id;
- the token's claim is the caller's on exactly the work asked: claim_work's lease read, `ownOnThisWork`, with 115's own cleaning;
- the claim is unreleased (an ended one was already refused CLAIM_RELEASED, SMD-3654);
- the claim was made under an agent id: the lease's new `byAgentId`, from `holder_agent_id`.

The refusal is renew_claim's: CLAIM_UNATTRIBUTED, `forced: false`, through the shared helper (SMD-3780). It is retryable with Retry-After while the registry is unreachable, and final while it is set up wrong or refuses. `renderClaimWork` gives it renew_claim's words ("The token given is this claim's: keep it").

**A lapsed claim's refusal says so,** on both doors: `lapsedAt`, the lease's end. The text adds that it had lapsed at T and stays lapsed until a renewal lands, so a claim on exactly its work can take it over meanwhile, then gives the lapse check a revived renewal gives: list the ticket's claims with include_ended, stop and tell the user on another claim made or renewed since, and with none carry on. While the registry waits on an operator it adds: either way, tell the user. Another key may have claimed the work since, which 115 would name once the registry answers. Before this change claim_work named it as WORK_CLAIMED, and renew_claim's refusal never did.

**Why.** Migration 115 matches a claim made under an agent id by that id alone. With the registry away, 115's claim_work read the caller's own claim as another's:
- **a lapsed one** was released "lapsed; taken over", and a new claim and token made for the same caller, answering `claimed` with no lapse report;
- **a live one** was answered WORK_CLAIMED, naming the caller's own key as the claim in the way. The session hook's claims PostToolUse then wrote a `.blocked.json` against the agent's own claim, which holds every renewal until the user decides.

renew_claim refused both as CLAIM_UNATTRIBUTED. Found by SMD-3654's review pass 5.

**Not refused.**
- **A claim made by name alone** (no agent id, as one made while the registry is away). 115's holder test matches it by name, and it renews: `byAgentId` tells the two apart.
- **The same token on other work.** It still makes a new claim, as SMD-3654 left it.
- **Another key's token.** It stays 115's to answer.
- **A lease read that failed** (`unread`). It stays on the old path: without the read, the claim can't be shown to be the caller's.
- **A key renamed since it claimed.** The name no longer matches, so 115 still takes a lapsed claim over. renew_claim's `ownWhileAway` has the same gap.

**Behaviour change.** The ticket's "unreleased" covers a live claim too. test-rest-sql [10]'s reclaim with its live claim's token, the registry set up wrong, now answers 503 CLAIM_UNATTRIBUTED where it answered 409 WORK_CLAIMED. AGENTS.md and CLAUDE.md say so in "Claim your work", step 4.

**Held.** test-rest-sql (383 assertions; the new rows are in [10]), test-server (1455) and test-store-sql pass.
- **[10]'s new rows**, through REST and MCP, with the registry set up wrong and unreachable: claim_work and renew_claim give the same answer for the caller's own lapsed claim, the claim stays unreleased, and no second row is written.
- **[10]'s controls:** the token on another piece makes a new claim; another key's lapsed claim is taken over; a by-name claim renews; with the registry back, claim_work renews the claim, saying it had lapsed.
- **Against main** (review pass 3): 1008 cells per copy, run twice, on real Postgres: 18 operations × 8 claim states × the registry ok, set up wrong and unreachable, through the core and through the MCP server, and with no word from the registry through the core. 25 cells differ, all intended: the live and lapsed own-claim cells now refuse, and renew_claim's lapsed cells gain `lapsedAt`. Every other reply, text and row is byte-identical.
- **Mutants:** fifteen run, fourteen killed, one equivalent.
  - The refusal: dropping it, the agent-id guard or the made-under-an-id test; making the SQL flag false; dropping render's branch.
  - `lapsedAt`: never set, set on a live claim, naming the current time rather than the lease's end, dropped by the field picker, dropped from the text, and not passed on claim_work or on renew_claim (two).
  - The operator case: its "either way, tell the user" dropped, or given to the retry case instead.
  - The equivalent one: a guard on `releasedAt` survived, since the ended case returns above it, so it is not in the code.

The change was prototyped on SMD-3780's helper in that PR's review pass 2, which needed no change to the helper.

**Review passes.**

| Pass | Finding | Caught by | Fix |
|---|---|---|---|
| 1 | A lapsed claim's refusal said "keep the token" while another key's live claim covered its work, which claim_work had named before | walkthrough | a20e6be8 |
| 1 | The rule's "retry as the reply says" gave no step when an operator must act | cold read, walkthrough | a20e6be8 |
| 2 | Nothing said a lapsed claim stays lapsed, open to takeover, until a renewal lands; the lapse sentence was a weaker copy of the renewal's lapse check | walkthrough | 7e6d8dbb |
| 2 | `lapsedAt` was pinned neither to the lease's end nor in MCP's structured reply: a mutant naming the current time survived | cold read | 7e6d8dbb |
| 3 | Waiting on an operator, a lapsed claim's reply ended "with none, carry on", and the rule's "keep retrying" covered every cause | cold read | 114cce47 |
| 4 | The rule's guidance sat in step 4's opening as five sentences about claim_work alone, and its "keep retrying" could revive the claim before the user decided on a claim the check found: now one bullet for all three doors, retrying only when the check finds no other claim | walkthrough | review pass 4 |

**Tidied while the files were open.** ClaimAnswer's docblock, stranded above ClaimLease's, is back above ClaimAnswer; the README's CLAIM_UNATTRIBUTED row says what 115 did with a live claim too; [10]'s unreachable row's message names what it holds.

**Not taken.** Judging the lapse by the database's clock rather than the server's (raised in passes 2 and 4): the brain runs as one compose stack on one host, so the two read one clock, and a miss at the boundary costs one sentence of advice.

**Follow-ups.** SMD-3807: the session hook records a CLAIM_UNATTRIBUTED's `lapsedAt`, so its lapse check marks a covering claim while the registry is still away.
