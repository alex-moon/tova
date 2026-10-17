# Plan — #362 Tasks stop after one step: the replay drops tool exchanges

A task settles `done` after two steps having done nothing: step 0 narrates
**and** calls `list_files`; step 1 re-opens the conversation as text-only; the
processor's settle rule (text with no tools = final answer) marks it complete.
Root cause is not the roster race — both step-1 branches saw the same broken
context — it is `assembleTaskHistory`: an assistant event replays
`event.content` **or** its tool replay, never both, so any model that narrates
while calling tools (legal, and DeepSeek-V4.1-Flash's habit) erases its own
tool call and result from the next step's context. The D10 test pinned the
assumption that a tool-calling step returns empty text; #362 is the
counterexample.

## Evidence (from the dump, traces and logs)

- Task `6ad277592ef630af44afd6fa`: `done`, `stepCount: 2`, `spentUsd: 0`;
  seq 1 has content + `list_files` result; seq 2 is
  `@@START@@I'll start by looking at your library…` (provider template
  artifact, cosmetic) with no tools → settled.
- LangSmith step-1 span: exactly three messages — system, instruction,
  assistant opener. No tool exchange.
- Healthy Oct-15 task: tool-only steps replay fine (content empty → D10 path).
- No errors in Loki around the run; the system genuinely believed it finished.

## The fix

`assembleTaskHistory` (taskSequencer.ts) replays content **and** the tool
replay, joined, using the existing `renderToolReplay` convention:

```ts
const replay = [
  event.content,
  ...(event.tools ?? []).map((t) => renderToolReplay(t as TaskToolEvent)),
]
  .filter(Boolean)
  .join('\n');
```

No settle-rule change: with intact history, text-only = final answer is correct.

## Verification

- Regression test in taskSequencer.test.ts: an assistant event with both
  content and tools replays both into the next step's context.
- Local reproduction against the dumped #362 event stream (before/after).
- `npm run ci` green.
