# Plan — #420: Stray tokens battery: fp4 quantisation vs context pollution

Branch: `feat/tv/420-stray-glyph-battery`

Investigation ticket. Symptom has **two classes** and they must be scored as independent
outcome columns:

1. **Script strays** — CJK/non-Latin tokens mid-output.
2. **English near-miss substitutions** — "arguably" → "argumentatively", "ight" →
   "igger" (logit near-tie flips; valid ASCII both sides, so not UTF-8 repair).

Class 2 can produce slurs in user-facing output — severity note lives on the ticket;
mitigation may be warranted regardless of cause.

## Hypotheses and the clean discriminator

- **Quantisation (fp4)**: fixed perturbation → flip floor is dirt-independent, present in
  clean contexts at temp 0, DeepInfra-only.
- **Pollution**: damaged context raises entropy → flip rate scales with context dirtiness
  (dose-response slope); at temp 0 flips persist only where context damage moves argmax.
- Discriminator: same context, temp 0, bf16/fp8 host. Persists → context-driven; vanishes
  → quantisation.
- Clip mechanics: `taskSequencer.ts` 2000-char `.slice` splits astral surrogates — real
  for class 1, cannot explain class 2.

## Steps

0. **Fix #418-broken script imports** — `scripts/` has no tsconfig coverage; 7 harness
   scripts still import services by pre-modularisation flat paths. Fix before building.
1. **Mine real incidents** — LangSmith is aggressively redacted; use Mongo instead:
   `npm run db:sync`, then scan persisted `messages` with the battery's detector for both
   classes. Real examples + positions = Block B's fingerprint.
2. **Build `scripts/stray-glyph-battery.ts`** — detector v2 + four context variants, on
   the `eval-tool-history-ab.ts` harness skeleton (real connectors, hand-built wire
   contexts). Every prompt elicits **known expected output** so substitutions are
   diffable. Detector logs per hit: `{ expected, actual, editDistance, cosine, position,
   snippet }`; cosine via our own `embeddingService`.
3. **Pilot n=8** — validate harness and detector (detector must fire on a deliberately
   corrupted sample; must stay quiet on clean output).
4. **Full run (n=128)** — Block A 64 (clean × temp 0.2/0.7, DeepInfra), Block C 48 (4
   variants × 12: tool-required, chip narration, dirty clip, dirty@temp0), Block D 16
   (dirty context × Fireworks + CHAT_MODEL). JSONL rows:
   `{ context_variant, temperature, provider, model, n, stray_rate, substitutions[],
   position_histogram, examples[] }`.
5. **Analysis** — apply the pre-registered decision rule, write findings into the ticket.

## Decision rule (pre-registered)

Per symptom class, first rule that fires wins:

- Strays/flips in **Block A** (clean context) → quantisation floor; pollution cannot
  explain clean-context failures. Check D to confirm host-dependence.
- **Block C** dirty@temp0 strays/flips with tool-required@temp0 clean → **pollution,
  proven**; mitigation = #416 Rec 2 (recite-from-re-read) + surrogate-safe clipping.
- DeepInfra-only across all contexts → fp4. Our context shape failing on bf16 hosts too →
  ours. Everywhere including CHAT_MODEL → model-level.
- Block A spotless AND C spotless → observation trap (ticket's block E): incidents live
  only in the agentic/long-context regime; escalate context length and re-run C before
  concluding anything.

## Done

- [ ] Script imports fixed; harness runs again
- [ ] Incident scan of persisted messages (both classes) — findings noted
- [ ] Battery + detector built, pilot validated
- [ ] Full 128 run, JSONL artifact committed or archived
- [ ] Decision applied and written into #420
