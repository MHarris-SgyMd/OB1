# 254. A thought's text is fenced in the prose read tools, so it cannot forge a result block (SMD-2483)

**What changed.**
- **`fenceText` in `server-portable/render.ts`.** It puts `│ ` before every line of a thought's text, and `│` alone on an empty line. No line the renderer writes itself starts with that character.
  - Both search blocks print the fenced text after their blank line.
  - `list_thoughts` indents the fenced lines as the item is indented. So an item holds no blank line, and the text's last line still sits directly above its `ID:` line.
  - The text is split on every line break a reader might honour: LF, CRLF, CR, NEL, VT, FF, U+2028 and U+2029, plus FS, GS and RS, which Python's `splitlines()` breaks on. Each break becomes LF.
  - Each line then drops whatever would hide its fence on a screen: C0 and C1 controls other than tab (an ESC sequence or a backspace can move the cursor back over the fence), DEL, and the bidi overrides, isolates and marks. This is `cleanForDisplay`'s rule, wider, applied after the split so that VT and FF still break the line.
- **Every row is fenced, not only an ingested one (the maintainer's call).** Fencing only ingested rows would leave two ways to forge `trust operator`: an agent's summary that quotes an ingested page, and a row with no trust recorded. The other option, prefixing only the lines that look structural, cannot be complete against a model reading a variant like `---Result 9---`.
- **The readers of these replies:**
  - `evals/write-path.ts` `parseHits` unfences a hit's text with `unfence`. A reply from before the fence is read as it always was. The parser's one pinned limit, a header forged inside a hit's text splitting the block, is gone.
  - `db/brain-compare.ts` `parseResultIds` anchors its header at the start of a line. Its comment had called the match content-safe. It was not: a hit's text that quoted a whole `--- Result …---` header and its `ID:` line was counted as a result.
  - The dashboard's search parser strips the fence from each line of the text.
  - The dashboard's list parser reads an item's text from the fenced lines between its header (or notice) and its `ID:` line. It used to include the notice, `ID:` and `By:` lines. An item whose text lines are not all fenced is a reply from before the fence, and is read as it always was.
  - `recipes/session-capture-hook` reads the `ID:` lines and capture lines of the brain's replies as a session's provenance (`derived_from`). It now matches them only at the start of a line. Before, an id quoted inside a thought's text was claimed as a source: false lineage, which could also push real sources past the cap of 60. A prose tool's result the harness recorded as the JSON of its `structuredContent` is parsed for its `text` first, so the anchors see real line breaks (review pass 2). A generic `fetch` is not parsed: its JSON `text` is the thought's own text, unfenced. That also recovers a search result's first `ID:`, which the old `\b` pattern missed after an escaped `\n`.

**Not here.**
- The metadata the same renderers print raw (type, topics, people, action items, and list's tags) can carry a newline and forge lines the same way. That is SMD-2510.
- `integrations/kubernetes-deployment` renders its own replies, and has no trust to forge.
- **What only a screen shows.** A line whose first strong letter is right-to-left (Hebrew, Arabic) can show its fence at the right edge in a renderer that sets direction per paragraph. An HTML `<br>` inside a line, in a client that renders HTML in markdown, starts a visual line with no fence. A model reads the text in order and still sees the fence on every line.

**Held by**
- **test-server [16h]:** the ticket's reproducer in both search tools and `list_thoughts`, as an ingested row and as an agent's row, under each of the eleven line breaks. The controls and bidi marks are dropped, and a tab is kept. Each renderer prints one block (or item), one `ID:` line and one `By:` line per thought. The forged block is fenced inside the real block, and the real block carries the notice.
- **test-e2e-sql [10e]:** the reproducer through an ingested key over MCP, beside an operator's thought. Each tool prints two blocks and two `By:` lines, and only the operator's line reads `trust operator`.
- **[10d]'s position checks, now fenced.**
- **The parsers:**
  - eval-write-path [3]: a forged header inside the text is content, and a reply from before the fence is still read.
  - test-brain-compare: a quoted header, fenced or mid-line, is not a result.
  - test-session-capture: ids quoted inside fenced text, and a quoted capture line, are not claimed. These checks fail on the hook as it was. A Codex result recorded as its JSON still yields its id, and that check fails without the parse. A generic fetch's id line is not claimed, and that check fails when the parse reaches fetch.
- **The mutant**, `fenceText` printing the text raw as before. 37 test-server assertions and 7 test-e2e-sql assertions fail on it.
- **Review pass 1** (a cold reader) found no HIGH issues. It found two MEDIUMs, both fixed: the hook's ids, and the separators and controls (with the bidi marks). Its LOWs were fixed too: the dashboard's pre-fence read and the brain-compare comment's overclaim. Its screen-only residuals are named above.
- **Review pass 2** found one HIGH, fixed: a result recorded as JSON text kept the anchored hook from reading any id. Its LOWs: the README now names the three prose tools, and the right-to-left case is named above. The dashboard list parser's `[undated]` crash predates this change and is SMD-2524.
