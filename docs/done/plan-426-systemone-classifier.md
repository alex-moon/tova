# Plan 426 — switch the classifiers to System One

## Motivation

[#426](https://github.com/alex-moon/tova/issues/426): DeepInfra (and Fireworks, behind an
account approval gate) now serves System One decision-model endpoints. Proposal posted on
the ticket: [comment](https://github.com/alex-moon/tova/issues/426#issuecomment-6819212236).
Initial verdict: migrate the prompt-dimension classifier only.

## Decisions

- **Scope widened to the honesty guard after owner steer.** The initial "skip #2" verdict
  rested on the guard's `reason` field being load-bearing; the owner challenged that —
  verified the client renders a static generic badge off `flagged` alone and never displays
  `reason`. With the surfacing question dissolved, `claimsToolUse` maps to a single `noul`
  question carrying the guard's instructions (the "reciting remembered results still counts"
  subtlety lives in the instruction text), and the returned probability replaces the
  confabulation-prone generated explanation as the audit trail — per the Clef docs' own
  advice. Malapropism judge (#424) stays deferred corpus work; Fireworks is behind an
  approval gate — client stays provider-agnostic so it is a config change later.
- **Prompt-classifier mapping.** `emotional`/`technical`/`abstract`/`openEnded` → `noul`
  questions, boolean from `noul >= 0.5`; `sentiment` → `choice` with criteria
  `{positive, negative, neutral}`. One request, five questions.
- **Guard mapping.** One `noul` question, threshold `0.5`; verdict shape becomes
  `{ flagged, confidence }` — `confidence` is the `noul` probability, persisted on the
  Message subdoc (`reason` column kept for pre-#426 docs, no longer written) and passed on
  the `honesty` SSE events. Badge/retry UX untouched: they key off `flagged`.
- **Resilience.** Decision call failure (missing key, non-2xx, malformed answers) falls back
  to the existing aux-LLM paths, so `skipReason` semantics survive unchanged and the guard
  keeps running when the decision endpoint is down. Warns use constant format strings.
- **Config.** New `decision` block in `config/index.ts`: `DECISION_MODEL`
  (default `Cloudflare/clef`), `DECISION_CLASSIFIER_ENABLED` (default on, `0`/`false` to
  disable) — same lazy-getter style as the rest of the config. The flag gates the prompt
  classifier; the guard follows the same pins.
- **Tests.** Jest maps `systemOneClient` to an inert stub globally
  (`apps/server/src/test/systemOneStub.ts`) — no suite reaches the live endpoint by
  accident; suites testing the decision seam override with `jest.mock`. Route suites that
  don't stub the seam would otherwise make live API calls once `DEEPINFRA_API_KEY` is in
  env (observed: 5s timeouts that masquerade as flake).
- **Live evidence.** Prompt classifier smoke test: an emotional prompt read
  `emotional 0.97`, `sentiment negative` (0.92 confidence); a technical prompt read
  `technical 0.87`, `sentiment neutral` (0.96). Guard live check through the wired path: a
  fabricated claim flagged at 0.9836, an honest inability clean at 0.0123.

## Done

- [x] `systemOneClient.ts` — minimal fetch client for `/v1/systemone`
- [x] `config.decision` block with model + enabled pins
- [x] `classifyPromptDimensions` rides the decision path with LLM fallback
- [x] Honesty guard rides the decision path with LLM fallback; verdict `{flagged, confidence}`
- [x] Message schema + chat.ts + client types carry confidence instead of reason
- [x] Tests updated: decision mapping, threshold, fallback behaviour (both classifiers)
- [x] `npm run ci` green; Semgrep clean on touched files

## Follow-ups

- Malapropism judge migration when #424's corpus work resumes.
- Fireworks System One access when the account approval gate clears — config change only.
