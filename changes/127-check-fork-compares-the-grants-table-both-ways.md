# 127. check-fork compares the grants table both ways, and the commit grammar reads a thirteenth pass (SMD-1990)

**What changed.** `scripts/check-fork-consistency.ts`'s SMD-1471 comparison
of db/README.md's "Grants for a capturing role" against `ROLE_GRANTS` is
`grantsDrift(section, rows)`: a pure function, the section's text and the
grant rows in, the violation messages out. It compares both ways — a config
row the README does not document, as before, and now a README row no group
grants. It reads an object cell by masking the backticked spans, stripping
every balanced parenthetical, and taking the names before the first em dash,
so a function's signature inside the backticks is read whole and a `thoughts`
inside prose is not a table. `GRANTS_PROBES`, nine probe tables, run at module
load and hold each shape. `scripts/commit-grammar.ts`'s ordinals run to
"twentieth", with a self-check line.

**Why.** A config row deleted with the README still claiming it passed the
gate. Three successive cell parsers each lost a table or read prose as one —
a cut at the first parenthesis saw one of two tables, an optional
parenthetical after each name lost a table behind an em dash inside one, and a
wording edit of README prose tripped the gate. SMD-1298's review ran to
thirteen passes, and the grammar knew twelve: a pass it cannot read is no
review pass to mechanism-yield or commitlint.

**Held.** The nine probes (a clean table; a README row no group grants — the
reverse pass; a function row; a config row with no README row; a privilege the
README claims and the config does not; the second table of a multi-table cell;
a table-shaped name inside a parenthetical; two tables each with an em dash
inside its parenthetical; a function's signature inside backticks). Dropping
the strip fails six, the mask thirteen, the reverse pass one. `bun
scripts/commit-grammar.ts --self-check`; `mechanism-yield --since` counts a
thirteenth pass.

**Not taken.** `noUncheckedIndexedAccess` for scripts/ — the two string
defaults are defensive, and the flag would fire across every script.

**Upstream status.** Not upstream; both scripts are the fork's.
