# 489. Check 54 holds the name: "Open Brain" as the product and "fork" as what the project is fail outside the archive, and every line kept on purpose is counted with its reason (SMD-3773)

**What changed.**
- **Check 54** in `scripts/check-consistency.ts` reads every file git lists (tracked, and untracked but not ignored), outside the archive. The archive is `changes/`, `CHANGELOG.md`, `FORK.md` (the fork era's record) and the migrations applied by 119; a newer migration is read.
  - It reads each line for "Open Brain" in any case, also when a line ends "Open" and the next begins "Brain" past its comment leader (the wrap PR 2 missed in `pull-gmail.mjs`). It also reads for "fork", "forks" or "forked" as a word. Each pattern is a plain word boundary, so none can backtrack far (JSC gives up silently at its limit). "OpenBrain" and "open-brain" are identifiers or upstream's, and aren't read.
  - It reads the checker too, with check 54's own section blanked.
  - A line it flags fails with its file and line; the explanation follows once.
- **Shapes that make no claim** are cut from a line first:
  - a URL (link text stays read, so "[Open Brain](upstream) setup" still fails);
  - the origin sentence, "grew out of Open Brain" and "began as a fork of";
  - upstream's maintainer-team badge;
  - identifiers: `FORK.md` as a file, the `ob1-fork` marker, CI's name before SMD-3765, the `[fork]` commit type commitlint keeps for old commits, and `fork` as a quoted code token;
  - other senses: a process `fork()` and GitHub's "fork network".

  Each shape has a probe that must pass it, and one that puts it beside a real hit and must still flag, so a widened cut fails. Further probes must flag:
  - "this fork" in a doc, "the fork's" in a comment, "forks";
  - "Search Open Brain" as a tool's title;
  - a prerequisite, and a credential tracker's heading;
  - a name wrapped onto the next line.

  The archive's parts must stay unread, and live files and migration 120 must be read.
- **What main still says on purpose** is counted per file in `NAME_EXCEPTIONS`: 158 files, each word held to an exact count with one or more of `KEPT`'s seventeen reasons. One more line fails, naming the lines so the new one can be found; one fewer fails as a stale count. Files per reason:
  - upstream's own products, deployments and claims: 44;
  - data: test fixtures, eval inputs, recorded queries and probes: 21;
  - another sense of "fork": 21;
  - credential trackers, whose contents SMD-3877 rewrites: 16;
  - pointers to the fork era's record: 14;
  - the docs' and front-door files' bodies, SMD-3793's: 10;
  - credits and quotes: 9;
  - the Linear board's names, which board-sync matches: 9;
  - NBJ material, SMD-1929's: 8;
  - the ingest pipeline's `fork` source: 8;
  - applied plugin migrations, whose sha migrate.ts checks: 6;
  - the origin, upstream's licence and the naming rule: 3;
  - the variable or property that holds a fragment's record: 3;
  - one each: the connector name the guide gives, a dated decision record, the release artifacts (SMD-4099), and the checker's other checks.

  A file can carry several reasons; `fragments.ts`, for one, has 8 `## FORK` lines and 5 lines of its `fork` variable.
- **Four leftovers the sweeps missed**, fixed here rather than excepted: the PR-review skill's checklist, the schema prerequisites in `server-portable/README.md` and `compat/supabase-sql/README.md`, and `chatgpt-conversation-import/.env.example`'s "on this fork".

**Why.** SMD-3765, SMD-3769 and SMD-3770 replaced the name and the "fork" framing on every live surface. Nothing kept a copied line from bringing them back.

**Review passes.**

| Pass | What | Taken |
| --- | --- | --- |
| 1 | cold read | a wrapped name was unread; the upstream-link cut hid its text; probes held each cut one way only; `[fork]` and a quoted `fork` cut too much; one reason per file was false for mixed files; messages named no new line; new migrations and the checker itself went unread; the record's per-reason counts were per entry |

**Held.**
- The checker passes on this branch.
- **With a scratch line added:** "This fork keeps its own CI." in `README.md`, and "Search Open Brain" as `server-portable/core/schemas.ts`'s tool title. The checker fails each by file and line, and the same words in a file in `changes/` raise nothing from check 54.
- **With check 54's call dropped:** the same lines pass.

**Not done here.**
- **The docs' bodies** are SMD-3793's, and **the release artifacts' title** SMD-4099's (filed here). As each lands, its lines leave `NAME_EXCEPTIONS`; the exact count makes the change say so.
- **The trackers' contents** are SMD-3877's, and the NBJ material SMD-1929's.
- **"fork record" and "fork ticket" in prose** name the ingest pipeline's `fork` source and stay. So do the `fork` variable and property that hold a fragment's record.
