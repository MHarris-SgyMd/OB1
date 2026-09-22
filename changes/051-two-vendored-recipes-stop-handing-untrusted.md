# 51. Two vendored recipes stop handing untrusted content a shell — `gmail-smart-pull`'s Codex branch is deleted as upstream deleted `atomizer`'s, `life-engine`'s allowlist is scoped, and a standing check holds the line (SMD-1251)

Both lived in this tree at the pin; both would have carried our name the first
time anyone ran them.

**`recipes/gmail-smart-pull/scripts/lib/atomize-text.mjs`** spawned the Codex
CLI over Gmail message bodies — attacker-supplied text by definition. Two
problems stacked. Both CLI spawns used `shell: true` with the binary path taken
from an environment variable, an injection surface independent of anything the
model does. And `GMAIL_ATOMIZE_CODEX_BYPASS=1` appended Codex's
sandbox-bypass flag: one environment variable turned email-body-driven model
output into unsandboxed local execution. The comment above it was careful — the
flag was "deliberately not passed by default" — and the result was a
prompt-injection → local-code-execution primitive one `export` away. The
decisive fact: **upstream had already removed this exact path from the sibling
recipe.** `recipes/atomizer`'s README and module header both document that the
identical `codex` provider was deleted "because the LLM is fed arbitrary
user-controlled memory/email text". Upstream fixed one copy and missed the
other; we inherited the one they missed.

The fix follows the precedent: the `codex` provider is **deleted** — the
function, its nested-session guard, its dispatch branch and its entry in the
known-provider set — so `--atomize-provider=codex` is now "unknown provider",
and the recipe's own header and README say why in the words the atomizer used.
The remaining `claude-cli` spawn drops `shell: true`: it was already an argv
array with the prompt on stdin, so nothing on the command line is interpreted
now, and the path from `CLAUDE_CLI_PATH` is executed as given. The cost is said
rather than hidden: the variable must now be a bare executable path (nothing
expands `~`, `$VAR` or a trailing flag), and on Windows it must name the native
`claude.exe` — without a shell the bare name resolves only to `.com`/`.exe`, so
the npm `claude.cmd` shim is not found (`ENOENT`), and a `.cmd`/`.bat` the
variable points at is refused (`EINVAL`, which Node **throws synchronously**
from `spawn()` rather than emitting — the review pass caught a first version
whose hint lived only in the `error` handler and could never fire). Both roads
now lead to one `describeSpawnError`, keyed on `win32` and either code, which
also tells a user who never set the variable that `claude` is not on PATH
rather than that their variable is malformed, hedges the set-but-missing case
("names a file that does not exist"), covers `EACCES`/`ENOTDIR` (a directory,
no exec bit), and — since the npm install ships **no** `.exe` — names
Anthropic's native Windows installer as the route to a `claude.exe`; the
README's troubleshooting has the entry, and the `ATOMIZE_DEBUG=1` switch that
reveals a withheld `Not logged in`. `pull-gmail.mjs` itself refuses a
misconfigured atomizer **once at startup** — an unknown provider (a stale
`GMAIL_ATOMIZE_PROVIDER=codex`), a missing key for an HTTP provider, or the CLI
inside a Claude Code session, through one `assertProviderReady` the atomizer
also calls per call — rather than degrading every long email to a whole-email
record with exit 0; `--list-labels`, the documented first step, is not gated.
Its Windows browser opener was `cmd /c start "" <url>`, a cmd.exe spawn that
read the OAuth URL's `&` as a command separator; it is `rundll32`'s URL handler
now, with the `error` listener a missing opener on a headless box needs. Its
per-email log logs a spawn failure whole (paths and errno text, marked
`safeToLog`) and cuts everything else at 160 characters, since an HTTP
provider's error can echo the response body and a parse failure quotes the
model's output. `recipes/atomizer/lib/claude-cli.mjs`
had the same `shell: true` on the same shape of spawn and gets the same fix, so
the ticket's verify grep is clean rather than carrying an exception for the
sibling.

**`recipes/life-engine/README.md`** recommended a `.claude/settings.json` that
allowed `Bash(*)`, offered `--dangerously-skip-permissions` as a testing option
in a table and a shell line, and defended the wildcard with: scoped patterns
"are fragile because the LLM may vary its exact command syntax", and "Rule 11
(prompt injection guard) prevents dangerous Bash execution from external
triggers". That defends a shell allowlist with a prompt rule addressed to the
model being injected — and Life Engine ingests Telegram or Discord messages, a
weather API response and calendar events on every cycle. The section is
rewritten: the skill now runs exactly **one** shell command, the `date` anchor,
and the allowlist carries that command as one **exact-match** rule plus
`WebFetch(domain:api.open-meteo.com)` — the weather check goes through Claude
Code's own fetch tool, not `curl`, so the coordinates can live in
`life_engine_state` and never touch the allowlist. Two review passes got here.
The first version used prefix rules, and the first pass pointed out that a
prefix rule approves whatever follows the prefix — `curl` takes several URLs and
`-d @file` in one command, so
`Bash(curl -s "https://api.open-meteo.com/v1/forecast:*)` was an exfiltration
path one injected message wide (which is also what Claude Code's own
permissions documentation says about argument-constraining `curl` patterns).
The second version made both rules exact-match, and the second pass pointed out
that the skill, three lines below its new "run exactly as written", still told
the model to substitute the operator's coordinates into the URL — a string an
exact rule can never approve, so every morning briefing would have paused on a
prompt, the exact failure Step 6 exists to prevent — and that the three
byte-identical `curl` strings (two in the README, one in the skill) were
hand-synchronised with nothing checking them. Taking `curl` out of the picture
resolves both. The skill tells the model to run the `date` anchor exactly as
written; the callout says **what actually breaks** (a rephrased `date` pauses
the loop on a prompt — tighten the skill or add the exact variant; never a
prefix rule on a network client or interpreter, which the consistency check
refuses; never a wildcard); and the skip-permissions option is gone from the
table, the shell line and the later pointer. The `--allowedTools` form passes
each rule as its own single-quoted argument.

**The general rule, written down.** The community tree is vendored from
upstream wholesale, so we ship its worst advice with its best. The decision
this ticket asked for is taken as: **audit once, hold the delta, and let a
standing check carry the audit** — "Vendored content" above, beside the rebase
procedure it governs. `scripts/check-fork-consistency.mjs` gains check 6: every
**non-binary** file under the seven contribution directories — text by
construction, so an extensionless `Dockerfile` or `Procfile`, a
`settings.json.example` and a Python recipe are all read — is checked for five
**mechanisms**, not the spellings the two fixed files happened to use: Codex's
sandbox-bypass flag and its aliases (`--yolo`, `danger-full-access`,
`--ask-for-approval never`); Claude Code's skip-permissions flag or
`bypassPermissions` mode; every allow-rule shape that grants all of `Bash` (the
wildcard forms, a quoted bare `"Bash"`, a line that is only `Bash`, a YAML
`allowed-tools:` or `--allowedTools` carrying the bare token); a `Bash` prefix
rule on a network client or interpreter (`curl`, `wget`, `sh`, `node`,
`python`… followed by `:*` — everything after the prefix is approved); and a
spawn through a shell in any spelling (the `shell:` option with a non-false
value, including the `process.platform === "win32"` workaround the Windows
prose invites; `exec`/`execSync` called, imported from `child_process` or
wrapped in `promisify`, which always use one; `os.system`/`os.popen`; an
explicit `sh -c`/`-lc`, `cmd /c` or `powershell -Command` argv in a `spawn`,
`Bun.spawn` or `Deno.Command`). Files git ignores are skipped — the gmail
recipe writes its packs and OAuth state under `recipes/gmail-smart-pull/data/`
by default, full email bodies, and `recipes/*/data/` is now in `.gitignore` —
so untrusted text a recipe pulled onto a maintainer's machine cannot decide
whether the tree passes, and cannot be committed by a stray `git add -A`. A hit
fails CI with the file, the line and the rule. Two shapes are read across lines rather
than per line: a quoted bare `"Bash"` counts only inside an `allow` list,
however it is printed — so a pretty-printed `deny` list, a hook `matcher`, a
`metadata.json` `tools` entry or prose naming the tool in quotes is not it, and
a `deny` on the same line as an `allow` does not excuse the allow; and in code
files the `shell` option is flagged with *any* value but `false` (`shell:
isWin,` on its own line included), where in prose and YAML it needs a code
value so a `shell: bash` step key is not it. The prefix rule catches the glob
spelling too — `Bash(curl *)`, `Bash(curl -s *api.open-meteo.com*)` — which
Claude Code 2.1 now labels the current form and `:*` the legacy one; and the
Codex pattern catches `approval_policy = "never"`, the config key behind the
flags. Exceptions are per **file and pattern and counted**: the atomizer's
README warning and module header are exempt from the bypass-flag pattern for
exactly one line each, because they name it to say it was deleted, and are
scanned for everything else — one more line naming the flag (a rebase re-adding
a usage block beside the warning) fails, one fewer (the prose rewritten) fails
too. Probe lists run against the patterns on every invocation through the same
machinery the scan uses: fifty-five strings the five must catch (two of them
code-file-only), and twenty-five ordinary lines they must not — this repo's own
prose, a regex `.exec(`, `shell: false`, "Restart your shell:", a GitHub
Actions `shell: bash` step, a pretty-printed `deny` list, a hook's `tool_name
=== "Bash"`, a `metadata.json` `tools` entry, `Bash(git status:*)`. The first pass's version had a file-wide exception (the
excepted module could regain a real shell spawn unnoticed), four literal
patterns, an extension allowlist that skipped `.py`, `.example` and every
extensionless file, `\` separators in the exception keys on Windows, a
`_template` substring filter that would have hidden a contribution named
`prompt_template`, and a hand-rolled walk; the second pass's version had a
whole-file liveness test that an anchored pattern could never satisfy, and
found the `cmd /c start` browser opener in `pull-gmail.mjs` itself — a cmd.exe
spawn that read the OAuth URL's `&` as a command separator, now `rundll32`'s URL
handler with no shell; the third pass's version had patterns that fired on
ordinary prose ("Restart your shell:", `codex exec (the CLI)`) and on the deny
lists and hook matchers that narrow Bash, missed the kebab `--allowed-tools`, a
YAML `- Bash` list item, `--ask-for-approval=never`, `sh -lc`, an imported
`exec`, and scanned the recipe's own pulled email packs; the fourth pass's
version listed ignored files repo-wide through a 1 MiB buffer and swallowed the
overflow into an empty set (a maintainer with a built dashboard would have had
the skip switch itself off silently — now scoped to the seven directories,
unbounded, and loud on failure), guarded the quoted `"Bash"` with a whole-line
lookahead that was both a false negative and a false positive, matched only
the legacy `:*` prefix spelling, missed `approval_policy`, and kept a
display-time `_template` filter whose only live effect was to hide a check-5
hit in a template SQL file every contributor copies (deleted; the placeholder
link it excused has not been produced since the filter was written). Paths are
normalised to `/`, the scan walks
`contributionDirs()`, and check 5 shares the line scanner. Proven each time:
probe files with the new spellings (seven hits on the last, an extensionless
`Dockerfile` among them), a usage block appended beside the excepted warning
(caught by count), the warning rewritten (caught as stale), then the tree: 118
contributions, no violations. The new prose in this fork names none of the
strings literally — the consistency check caught this change's own callout
spelling a forbidden prefix rule as an example, and it now describes it
instead.

Three `metadata.json` files take a patch version and today's date
(`gmail-smart-pull` 1.0.1, `atomizer` 1.0.1, `life-engine` 1.1.1); authorship
is unchanged, the content is upstream's with a fork delta. Two high-effort
review passes, ten findings each. The first: the prefix rule, the dead `EINVAL`
hint, the PATHEXT/`ENOENT` shape of the common Windows failure, the file-wide
exception, the four-literal narrowness, the unpinned `date` anchor, the
`_template` substring filter, the `\` separator in exception keys, and the
duplicated walk/scan prologue. The second: the skill's coordinate substitution
that an exact rule could never approve (above), the atomizer copy's missing
stdin `error` listener (a failed spawn or an early exit with a long prompt was
an uncaught exception, now the same one-line guard the gmail copy has), the
liveness test that an anchored pattern could never pass, the narrowness of the
spawn and allow patterns and the `cmd /c` opener they missed, the whole-file
exception, `pull-gmail.mjs` storing an unknown `--atomize-provider` (or the
undocumented `GMAIL_ATOMIZE_PROVIDER`) and degrading per email with exit 0 — it
now refuses at startup, and the variable is in the README's table — the
extension allowlist, the 160-character log slice that cut the Windows hint in
half (400 now; the hint carries no email text), and the not-found hint telling
a user who never set `CLAUDE_CLI_PATH` that their variable was malformed (it
now says `claude` is not on PATH). A third pass, ten more, most of them edges
of the second's own fixes — the stop-signal shape — and each real: the browser
opener's missing `error` listener (a headless box without `xdg-open` would have
died before the callback server listened), the check scanning the recipe's own
pulled email packs under `data/` (untrusted text deciding a maintainer's local
result; not gitignored either), the three allow shapes and eight spawn/bypass
spellings the widened patterns still missed, the patterns that fired on
ordinary prose and on deny lists, the 400-character log slice whose premise
("provider errors are redacted at source") was false for the HTTP providers and
the parser, the startup guard closing one of four configuration errors and
blocking `--list-labels`, the Windows prose naming a `claude.exe` the npm
install never provides, and the set-but-missing hint asserting the value was
malformed. A fourth pass, ten more, again edges of the third's own fixes — the
second consecutive stop signal, so the loop ends here: the ignored-file skip's
silent overflow, the `_template` filter, the quoted-`"Bash"` lookahead, the
`shell: isWin` and namespaced `execSync` and `/bin/sh` spellings, the glob
prefix form, `approval_policy`, the `ATOMIZE_DEBUG=1` detail still cut by the
160-character slice (it is the opt-in whose purpose is those snippets; marked
safe to log when on), the errno table giving `EINVAL` the "does not exist"
remedy and `ENOTDIR` the "no exec bit" one (branched on the code first now,
with a trailing-slash hint), the `.gitignore` comment promising cover for an
atomizer data root that resolves from the current directory (`/data/atomic-
memories/` added), and the atomizer's hint table lacking the `safeToLog` mark
its own slicing callers would need (hoisted to an exported
`describeSpawnError` mirroring the gmail copy). All fixed here, except the one
every pass named: the duplication between the two recipes' Claude-CLI spawns
(two `buildCleanEnv`, two `STRIP_KEYS`, two spawn wrappers, two
`describeSpawnError`s, each patched four times this ticket) is SMD-1317. The
gmail copy's error also stops putting stderr and stdout (email text) into the
run's log by default, behind the same `ATOMIZE_DEBUG=1` switch the atomizer
uses. A boyscout commit took the tidy-ups the passes cut for space: the script's
env header names every variable it reads (`GMAIL_ATOMIZE_PROVIDER`,
`CLAUDE_CLI_PATH`, `ATOMIZE_DEBUG`, the two directory overrides), the startup
refusal exits 1 like the file's other refusals, the per-provider key checks
that `assertProviderReady` made unreachable are gone, the README says the
`--dry-run` preview needs the provider's key, and check 5's walk from the
repo root no longer descends `.claude/worktrees`. Upstream status:
**contributable in principle** — these are recipe files, not the core server —
but issue #482 reports the upstream gate failing every fork-originated PR; the
atomizer precedent says upstream would take the deletion. **Unfiled** upstream.
