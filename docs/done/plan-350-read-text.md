# Plan — `read_text`: line-range reads for long documents (#350)

## Motivation

`read_file` caps a whole-file read at 12k chars and offers chunking only through
**document units**, which are type-dependent (PDF → pages, md/html → headings,
**txt/docx → a single whole-doc unit**). A long `.txt`/`.docx` therefore cannot be
paged at all, and the bespoke `unit: "58-60"` API needs prompt engineering because
it does not match how agents naturally read files (`head`/`tail`/`sed -n`,
offset/limit).

Ticket: https://github.com/alex-moon/tova/issues/350

## Decisions

- **Line ranges replace the `unit:` reader.** `read_file` gains `offset` (1-based
  start line) and `limit` (max lines); the `unit` parameter is removed, so there is
  one reader (lines), not two.
- **Units become a table of contents.** `unitsOnly: true` stays and now reports a
  `startLine` per unit (plus `index`, `label`, `preview`), so the agent lists the
  page/section index and reads from the line it points at.
- **`startLine` is computed at read time, not stored.** Units are trimmed slices of
  the same text the reader serves, so `startLine = text.slice(0, text.indexOf(unit.text))`
  line count. This avoids a schema change, an extraction change, and churn in
  `documentUnits`/its tests, and it works for rows written before this change. It is
  a TOC hint, so a duplicate section resolving to the first occurrence is acceptable.
- **Character cap still bounds every read.** Lines are a navigation aid; the real
  budget is `truncateForPrompt` (the 12k prompt cap), so a single over-long line
  (minified HTML, a CSV row) cannot blow the context. `truncated` is true when the
  char cap cut the slice or more lines remain.
- **Every read returns paging metadata**: `offset`, `endLine`, `totalLines`,
  `totalChars`, `truncated`, plus a `note` telling the agent the next `offset` when
  truncated. The default (no `offset`/`limit`) is the head, no longer a silent
  truncation.
- **Numeric wire-encoding coercion** (models emit numbers as strings, #159) is
  retained for `offset`/`limit`.

## Done

- [x] `read_file`: `offset`/`limit` schema, line-range execute, paging metadata, `unitsOnly` + `startLine`, `unit` removed
- [x] Tool description + `TOOL_INSTRUCTIONS` rewritten to teach line paging
- [x] `assetTools.test.ts`: #159 block rewritten for line paging + `startLine`; truncation test still passes with the metadata
- [x] `evals/cases.ts`: `manual-page-of-phone` navigation assertion moved to `unitsOnly`
- [x] `graders.ts`/`graders.test.ts` numeric-arg example moved to `offset`; `mongoSource` comments refreshed
- [x] `npm run ci` green (114 suites, 1491 tests)

## Follow-ups

- Consolidating the duplicated 12k constants (`MAX_ATTACHMENT_PROMPT_CHARS` vs
  `MAX_PROMPT_TEXT_CHARS`) into one configurable knob is a companion change, left
  out here to keep the diff to the reader.
- The live #159 eval (`manual-page-of-phone`, `handbook-split-sections`) is not part
  of `npm run ci`; it should be re-run by the owner (`npm run evals`) to confirm the
  agent pages by line rather than the old `unit` argument.

