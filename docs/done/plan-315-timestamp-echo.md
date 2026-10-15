# Plan: #315 — Models respond with datetimes

Status: implemented; ready for review (archived per the workflow's ready-for-review trigger).

## Motivation

Models reproduce the per-message timestamp headers in their replies (e.g. a reply
opens with `[2026-10-15 12:20 GMT+1]`). Since #261 every persisted turn — user *and*
assistant — is prefixed at prompt-assembly time with a `[stamp]` header
(`messagesFromPersistedHistory`, apps/server/src/routes/chat.ts). The transcript
therefore shows the model N examples of assistant messages that start with a stamp
and zero without, so pattern completion imitates its own role's examples and the
stamps leak into visible replies.

## Decisions

- **Stamp user turns only, don't switch to JSON.** The ticket floated sending/parsing
  messages as JSON. Rejected for now: JSON does not stop echo (the model can emit
  stamps inside the JSON content just as happily) and it moves complexity into the
  stream — buffered wrapper-stripping, brace/repair handling, every provider call and
  downstream consumer (tasks, compare, streaming) touched. Removing the stamp from
  assistant turns removes the imitation source outright: a plain assistant reply
  following a stamped user message is a normal chat shape with no echo pressure.
- **The #261 timing signal survives.** The relative-gap line (`— 2 days since the last
  message`) renders on the *following* message's stamp, so user stamps alone still
  show elapsed time, overnight sleeps, workday gaps. Owner confirmed the assistant
  reply time is irrelevant (it is effectively the user turn's time). The only loss is
  the model not seeing the time-of-day of its own past replies.
- **No system-prompt change.** The echo is structural, not instructional; a prompt line
  about timestamps adds noise and invites the model to *talk* about timestamps. The
  model has handled stamped user messages fine since #261. Evidence trigger: if
  LangSmith traces show residual echo after this change, add a single belt line then.
- **`timestampHeader` itself is untouched** — pure function, gap arithmetic and
  rendering unchanged. Only the *application* of the header narrows to user turns.
- **ZDR path untouched** — `buildZdrMessages` never carried timestamps.

## Changes

- `apps/server/src/routes/chat.ts` — `messagesFromPersistedHistory`: emit the
  timestamp header for `role: 'user'` turns only; assistant turns pass through as
  plain content. Gap visibility still walks the full history (the previous-turn
  timestamp chain includes assistant turns so a user stamp's gap line measures from
  the last turn regardless of role).
- Tests: update `chat.stream.test.ts` assertions that expect a stamped assistant
  turn; add coverage that assistant content is unstamped.

## Done

- [x] `messagesFromPersistedHistory` stamps user turns only
- [x] Tests updated + new assistant-unstamped coverage
- [x] `npm run ci` green

## Also in this PR

Workflow change requested by the owner alongside the fix: plan docs are now archived
to `docs/done/` when the work is ready for review (rides the PR) instead of after
merge — see the updated `docs/workflow.md` step 6 and `AGENTS.md`. This doc follows
the new rule, hence it is already in `docs/done/`.

## Follow-ups

- Watch `tova-dev` LangSmith traces for residual echo; if present, add a one-line
  system note that bracketed stamps on user messages are metadata.
