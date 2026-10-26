# Plan — #417 task settle

## Motivation

[#417](https://github.com/alex-moon/tova/issues/417): tasks "seem to be doing something but it's not clear what exactly". Diagnosis (posted on the issue): `taskSequencer` pins `toolUse: 'required'` on every step, which `mastraService` maps to `tool_choice: "required"` — while the processor settles `done` only on a text step with no tool calls (`taskProcessor.ts:208`). Under a strictly honored `required`, that settle is unreachable; tasks churn one tool call per step until the 150-step budget pauses them. DeepInfra honors the flag loosely, so the model sometimes skips tools anyway and the task settles instantly "done" on an intent-only answer ("I'll start by…") with no work done. Both modes reproduced live and in the local DB.

## Decisions

- **Drop the forced `toolChoice`, keep task mode.** The `toolUse: 'required'` option is dual-purpose: it (a) forces `toolChoice: 'required'` and (b) selects the lean task agent (lean toolset + `TASK_INSTRUCTIONS`). (a) is the bug; (b) is load-bearing. Fix: remove the `toolChoice` mapping and rename the option `toolUse: 'required'` → `taskMode: true`, since it no longer forces anything — it only selects the task agent. Keeping the old name would leave the code claiming semantics it no longer has.
- **No premature-settle guard yet.** A text-only first step can still settle "done" with no work done (the model's slack side). Guarding that heuristically is exactly the "hone locally" phase — deferred, see Follow-ups.
- **Terminal condition unchanged.** `text !== '' && tools.length === 0` is correct once the forcing is gone.

## Done

- [x] Post diagnosis on #417.
- [x] `llmTypes.ts`: `toolUse?: 'required'` → `taskMode?: true`, comment updated.
- [x] `mastraService.ts`: remove `toolChoice: 'required'` mapping; task-mode selection reads `taskMode`.
- [x] `taskSequencer.ts`: pass `taskMode: true`.
- [x] Update `taskSequencer.test.ts` expectations.
- [x] `npm run ci` green.
- [x] Plan doc to `docs/done/`, push, PR.

## Follow-ups

- Hone locally with the owner: if the model under-acts (never calls tools), consider forcing tool use on step 1 only.
- Consider requiring ≥1 tool event before a text-only settle can mark a task done.
- Surface `Task.lastError` in the Tasks view (failed tasks currently look opaque).
