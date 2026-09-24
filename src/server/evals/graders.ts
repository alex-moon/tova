import type { Assertion, EvalRun, AssertionResult, Score } from './types';

/**
 * #158 hallucination guard patterns: phrases where the model claims it
 * performed a search (or cites "my search results") without an actual
 * `web_search` tool call in the run. Deliberately narrow — it must match
 * *first-person claims of having searched*, not any mention of the word
 * "search" (e.g. quoting the user's prompt back is not a violation).
 */
export const SEARCH_CLAIMS = [
  /\b(?:i|we)\s+(?:did|performed|ran|conducted|carried\s+out|executed)\b[^.!?;]{0,40}\bsearch(?:es|ed)?\b/i,
  /\b(?:after|from|via|using)\s+(?:a\s+|my\s+|the\s+)*(?:web|brave[a-z ]*)\s*search(?:es|ing)?\b/i,
  /\bmy\s+(?:web\s+)?search(?:es)?\b/i,
  /\baccording\s+to\s+(?:my|the)\s+(?:web\s+)?search(?:es)?\b/i,
  /\bsearch(?:es|ed|ing)?\s+(?:the\s+web|online|for\s+(?:recent|latest|current))\b/i,
] as const;

/**
 * #158 no-sources refusal patterns (deterministic slice of rule 2): the
 * agent must *explicitly* signal that no sources are available rather than
 * filling the gap from model weights. This regex set is intentionally
 * brittle — a courteous or indirect refusal ("I'm afraid I can't answer
 * that from your files") is not caught — see the open LLM-judge question
 * on #158.
 */
export const NO_SOURCES_PATTERNS = [
  /\bno\s+(?:relevant\s+|matching\s+|from\s+your\s+files[a-z ,]*)?sources?\s+(?:are|is|were|available|found|exist)\b/i,
  /\b(?:i|there)\s+(?:do\s+not|don'?t|doesn'?t)\s+have\s+(?:any\s+|a\s+)?(?:relevant\s+|matching\s+)?(?:sources?|information|documents|materials)\b/i,
  /\bno\s+(?:[a-z'-]+\s+){0,3}(?:relevant\s+|matching\s+)?(?:sources?|information|documents|materials)\s+available\b/i,
  /\b(?:couldn'?t|cannot|can'?t|unable\s+to)\s+find\s+(?:any\s+|a\s+)?(?:relevant\s+|matching\s+)?(?:sources?|information|documents|materials|anything)\b/i,
  /\bno\s+(?:[a-z'-]+\s+){0,3}(?:relevant\s+|matching\s+)?(?:sources?|information|documents)\s+(?:are|is|were|was|found|exist)\b/i,
  /\bno\s+(?:[a-z'-]+\s+){0,3}(?:relevant\s+|matching\s+)?(?:sources?|information|documents|materials)\s+(?:on|about|covering)\b/i,
  /\b(?:nothing|none|not\s+anything)\s+(?:in\s+your\s+files|of\s+yours)\b/i,
  /\b(?:there\s+)?isn'?t\s+(?:any\s+|a\s+)?(?:relevant\s+|matching\s+)?(?:sources?|information|documents|materials|data)\b/i,
  /\bno\s+(?:information|documents|sources)\s+(?:on|about)\s+.{0,40}\b(?:in|from)\s+your\s+files\b/i,
] as const;

/**
 * The #158 no-sources case assertion compiles its `text_matches` pattern from
 * these patterns joined, so the case and the guard stay a single source of
 * truth (each source is wrapped in a non-capturing group to keep alternation
 * precedence intact).
 */
export const noSourcesPattern = NO_SOURCES_PATTERNS.map((p) => `(?:${p.source})`).join('|');

/**
 * #158 rule 1, positive deterministic slice (OQ2 pinned in the issue): a
 * sourced answer must reference its sources inline as literal links. A bare
 * URL or a markdown `[title](https://…)` link both count; the URL in
 * brackets of a markdown link satisfies either reading.
 */
export const INLINE_SOURCE_PATTERN = /(?:\[[^\]]*\]\()?https?:\/\/[^\s)>"']+/i;

const matchesFinalText = (run: EvalRun, pattern: RegExp): boolean =>
  typeof run.finalText === 'string' && pattern.test(run.finalText);

/**
 * #159: `read_file` accepts `unit` as a number or a numeric string (models
 * routinely emit numeric tool args as strings depending on the provider's
 * JSON encoding), and the tool itself coerces digit-only strings. Args are
 * normalised on both sides of an `argsSubset` comparison so the assertion is
 * about what the call meant, not the wire encoding.
 */
export const normalizeArgs = (args: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      if (typeof value !== 'string') return [key, value];
      const trimmed = value.trim();
      return /^[0-9]{1,9}$/.test(trimmed) ? [key, Number(trimmed)] : [key, value];
    }),
  );

const argsMatch = (call: { args?: Record<string, unknown> }, subset?: Record<string, unknown>) => {
  if (!subset) return true;
  const callArgs = call.args ? normalizeArgs(call.args) : call.args;
  return Object.entries(subset).every(
    ([key, value]) =>
      value === callArgs?.[key] || normalizeArgs({ key: value }).key === callArgs?.[key],
  );
};

/**
 * #159 live-run finding: models emit narrow/regular no-break spaces (U+202F,
 * U+00A0) inside numbers and headings, and answer casing varies (e.g.
 * "Page 58" vs "page 58"), so a literal substring check rejects visually
 * identical answers. `answer_contains` compares over a normalised form: all
 * Unicode whitespace mapped to a single ASCII space, case-folding both sides.
 */
const normaliseAnswer = (value: string): string => value.replace(/\s/g, ' ').toLowerCase();

const evaluateAssertion = (run: EvalRun, assertion: Assertion): boolean => {
  switch (assertion.type) {
    case 'tool_called':
      return run.toolCalls.some(
        (call) => call.name === assertion.tool && argsMatch(call, assertion.argsSubset),
      );
    case 'tool_matching':
      return run.toolCalls.some((call) => call.name.includes(assertion.nameContains));
    case 'tool_not_called':
      return run.toolCalls.every((call) => call.name !== assertion.tool);
    case 'tool_sequence': {
      const observed = run.toolCalls.map((call) => call.name);
      let cursor = 0;
      return assertion.tools.every((tool) => {
        const found = observed.indexOf(tool, cursor);
        if (found === -1) return false;
        cursor = found + 1;
        return true;
      });
    }
    case 'content_equals': {
      return (
        typeof run.generatedContent === 'string' && run.generatedContent === assertion.expected
      );
    }
    case 'prompt_contains':
      return run.prompt.includes(assertion.text);
    case 'text_matches':
      // A missing finalText can only fail: an absent answer never matches.
      // A case-declared pattern can be malformed; a throw there must fail the
      // assertion, never crash the whole graded run.
      try {
        return matchesFinalText(run, new RegExp(assertion.pattern, assertion.flags ?? 'i'));
      } catch {
        return false;
      }
    case 'text_not_claiming_search': {
      const webSearched = run.toolCalls.some((call) => call.name === 'web_search');
      return webSearched || !SEARCH_CLAIMS.some((pattern) => matchesFinalText(run, pattern));
    }
    case 'text_inline_sources': {
      // URLs appear in the search result blocks fed to the model, not in
      // streamed deltas; only the final answer text counts. A generated-file
      // run may legitimately put the citation in the document instead.
      return (
        (typeof run.finalText === 'string' && INLINE_SOURCE_PATTERN.test(run.finalText)) ||
        (typeof run.generatedContent === 'string' &&
          INLINE_SOURCE_PATTERN.test(run.generatedContent))
      );
    }
    case 'answer_contains':
      return (
        typeof run.answer === 'string' &&
        normaliseAnswer(run.answer).includes(normaliseAnswer(assertion.text))
      );
    case 'file_content_contains':
      return (
        run.generatedFiles?.some(
          (file) =>
            file.filename === assertion.filename &&
            typeof file.content === 'string' &&
            file.content.includes(assertion.text),
        ) ?? false
      );
  }
};

/** Evaluate each assertion against the run; results are always full-length. */
export const assertRun = (run: EvalRun, assertions: Assertion[]): AssertionResult[] =>
  assertions.map((assertion) => ({ assertion, passed: evaluateAssertion(run, assertion) }));

/**
 * pass = every assertion holds; fail = none; partial = anything in between.
 * Runs that produced no tool calls at all are always at best partial when
 * any tool_called assertion exists (the aggregator sees the failing
 * assertions, so this falls out naturally — an empty run never scores pass).
 */
export const aggregateScore = (results: AssertionResult[]): Score => {
  const passed = results.filter((r) => r.passed).length;
  if (passed === results.length) return 'pass';
  if (passed === 0) return 'fail';
  return 'partial';
};

export const gradeRun = (
  run: EvalRun,
  assertions: Assertion[],
): { score: Score; assertions: AssertionResult[] } => {
  const results = assertRun(run, assertions);
  return { score: aggregateScore(results), assertions: results };
};
