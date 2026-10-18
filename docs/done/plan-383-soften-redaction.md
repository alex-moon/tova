# Plan — #383 Soften redaction service

## Motivation

LangSmith traces are effectively unreadable: the trace redaction path blanks whole
lines and paragraphs down to `[redacted]`, so a trace cannot tell you what a turn
was about. The owner asked for a soft-touch redaction — keep the first and last
2–3 words of a redacted line for context — and for errors not to be redacted at
all. The issue comment separates this into:

- **(a)** deterministic partial redaction — uncontroversial, proceeds now (this work).
- **(b)** guard-model redaction — needs a labeled-trace-set eval before adoption;
  deferred (see Follow-ups). Fail-closed design agreed for when it lands.

## Scope

Traces only (`traceRedaction.ts` → LangSmith). Log redaction (`redactForLog`,
Grafana/Loki) stays conservative; the ticket's pain is trace readability.

## Decisions

- **Opt-in partial mode on `redactString`.** Traces pass `{ partial: true }`;
  logs keep the existing full-redaction default. One rule set, two policies —
  no duplicated heuristics to drift.
- **Partial = first/last 3 words + `[redacted]` middle.** Applied to long prose
  lines (the catch-all ≥64-char rule) and quoted payload text. Falls back to
  full redaction when the match has no spaces (keys/b64 — nothing to keep) or
  fewer than 12 words (reveal would dominate the redaction).
- **Full redaction retained for secret-bearing rules.** Secret-shaped
  assignments, JSON-esque blocks, and whitespace-free runs (b64/keys) still
  blank entirely even in partial mode: JSON can carry embedded keys, and a
  whitespace-free run has no "words" to keep — partial reveal would leak key
  material.
- **Catch-all defers to earlier rules.** In partial mode a ≥64-char run that
  already carries a machine-generated `[redacted]` marker is kept as-is: an
  earlier rule (e.g. quoted-payload partialization) already decided that line's
  exposure, and re-blanking it destroyed the context this ticket exists to
  keep. Runs without a marker still get head/tail treatment.
- **User-typed markers are stashed.** A literal `[redacted]` in user text would
  otherwise trip the catch-all skip and preserve a whole line verbatim — an
  attacker-controlled escape hatch around the backstop. Such literals are
  swapped for placeholders at entry and restored at exit, so only markers the
  rules themselves emitted trigger the skip. Residual accepted exposure: bare,
  unkeyworded secrets in the kept head/tail words — inherent to the head/tail
  reveal the ticket asks for (short lines with bare secrets were never
  redacted, even before this work).
- **Errors unredacted in traces, but bounded.** `errorInfo` (message + details
  + stack) passes through verbatim per the ticket; input/output stay redacted.
  `details` alone goes through a structural cap (depth 6, arrays 50, strings
  2000 — content verbatim, fresh containers so cycles cannot survive into the
  exporter), restoring the envelope `redactDeep` used to apply. Log-path error
  redaction is unchanged.
- **(b) deferred.** Guard-model redaction waits for the eval in the issue
  comment; shipped (a) is purely deterministic so trace content claims for
  #388 follow from what actually ships.

## Done

- [x] `redactString` accepts a partial mode; logs unchanged by default
- [x] Trace redaction opts into partial mode
- [x] Trace `errorInfo` no longer redacted
- [x] Hardened: user-typed `[redacted]` markers stashed out of the catch-all
      skip; `errorInfo.details` structurally bounded (cycles/size)
- [x] Tests: head/tail words survive in traces; secrets/JSON still full;
      errors verbatim; log behavior pinned unchanged; marker-escape and
      details-bounds regressions pinned
- [x] `npm run ci` green

## Follow-ups

- **(b) guard-model redaction eval** (#383): run the guard model over a labeled
  trace set, measure recall vs. the deterministic service; adopt only if close
  to 100%, fail closed on error/timeout. Sequencing note for #388 recorded on
  the issue.
