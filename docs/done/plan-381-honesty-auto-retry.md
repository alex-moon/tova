# Plan — Honesty guard auto-retry (#381)

## Motivation

The honesty guard (#371) flags tool-free turns that claim tool results which never
executed, but the current UX hands the problem to the user: a flag badge plus a manual
"Retry for real" button that resends the user's message as a duplicate. The guard's
verdicts are reliable, so the retry should happen automatically and the user should not
be shown the dishonest run at all.

## Decisions

- **Server-side restart, not client auto-click.** A client-side auto-retry would reuse
  `retryForReal`, which resends the user message as a new persisted turn — a duplicate
  user bubble live and after refresh, and the flagged assistant message persisted forever.
  Restarting inside the stream request keeps the transcript clean: nothing about the
  dishonest attempt is ever persisted.
- **Guard moves before persist/`done`.** The restart requires that `done` (which finalizes
  the client's message bubble) only fires after the final attempt passes. Latency note:
  the aux guard call (~1s) now sits between stream-end and `done` on tool-free turns;
  deltas are already fully streamed by then, so it is tail latency on a rendered reply.
- **Bounded to one retry (2 attempts max).** If the retry is also flagged, fall back to
  the #371 behaviour: persist the flag, send the post-done `honesty` frame, keep the
  badge + manual button as last resort.
- **New retry note, separate from the next-turn note.** The in-request retry note tells
  the model the discarded attempt was never shown (`HONESTY_RETRY_NOTE`). The existing
  `HONESTY_CORRECTION_NOTE` (next turn, via persisted history) stays for the
  exhausted-retry and non-streaming paths, where the user *has* seen the flagged reply.
- **Service split.** `reviewAssistantTurn` keeps its signature (classify + persist) for
  the non-streaming route; the streaming route uses the extracted `classifyAssistantTurn`
  and persists the verdict inline at message creation.
- **Transient flash accepted.** Attempt 1's dishonest text streams live before the wipe —
  unavoidable without buffering every turn (which would kill live streaming).
- **ZDR and non-streaming routes unchanged.** ZDR turns never run the guard (nothing
  persists); the non-streaming compat route keeps its fire-and-forget post-response flag.
- **Latent bug fixed in passing:** the post-done `honesty` frame targeted the `streamId`
  bubble, but `done` had already renamed it to the persisted id — the live badge was a
  silent no-op (visible only after refresh). The handler now matches the adopted id.

## Done

- [ ] Server: extract `classifyAssistantTurn` from `reviewAssistantTurn`.
- [ ] Server: bounded attempt loop in the stream route; retry note appended to the
      current user turn's prompt; flagged attempt never persisted.
- [ ] Server: exhausted-retry fallback persists the flag + post-done `honesty` frame.
- [ ] Client: `retrying` honesty frame wipes the stream bubble; post-done id matching fixed.
- [ ] Tests: retry flow, exhausted flow, retry-note prompt content; existing #371 tests
      updated to the new event ordering.

## Follow-ups

- None yet.
