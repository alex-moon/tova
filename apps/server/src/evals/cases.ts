/**
 * Golden set cases for the #112 deterministic evals. Case data is kept
 * separate from the graders so the runner and the LangSmith exporter both
 * consume the same source. What is evaluated is tool use, not the real
 * third-party service: case 1 does not need GitHub, case 2 does not need
 * an actual Bupa policy — the temp Mongo source (`mongoSource.ts`) materialises
 * stand-ins for the asset-library tools, and case 3 needs at most a Brave key
 * already available to the runner.
 */
import type { Assertion } from './types';
import { noSourcesPattern } from './graders';

export interface EvalCase {
  id: string;
  /** The raw user prompt as sent. */
  prompt: string;
  description: string;
  assertions: Assertion[];
  /**
   * Content the generated file must equal, or a `@repo:<path>` marker
   * resolved against this repository at grading time (e.g. README.md).
   */
  expectedContent?: string;
}

/**
 * Repro: `@repo:README.md` resolves the actual repo file, so the golden
 * expectation moves with the README instead of duplicating it here.
 */
export const resolveExpectedContent = (value: string, read: (path: string) => string): string =>
  value.startsWith('@repo:') ? read(value.slice('@repo:'.length)) : value;

export const CASES: EvalCase[] = [
  {
    id: 'github-readme-to-files',
    prompt: 'Copy the README.md from alex-moon/tova to my files.',
    description:
      'Two-tool chain: fetch README.md from the GitHub repo (MCP), then generate_file ' +
      'with filename README.md and content equal to the real README.',
    assertions: [
      // GitHub rides on the user\u2019s MCP servers, so exact tool names are not
      // fixed; a *github* substring call is the tool-use signal being evaled.
      { type: 'tool_matching', nameContains: 'github' },
      {
        type: 'tool_called',
        tool: 'generate_file',
        argsSubset: { filename: 'README.md' },
      },
      { type: 'content_equals', expected: '@repo:../README.md' },
    ],
    expectedContent: '@repo:../README.md',
  },
  {
    id: 'bupa-fertility-files',
    prompt: 'Does my Bupa policy cover fertility treatment?',
    description:
      'The user asks a personal-documents question: the agent must list_files and then ' +
      'read_file on the seeded Bupa policy before answering from its text, not from web search.',
    assertions: [
      { type: 'tool_called', tool: 'list_files' },
      { type: 'tool_called', tool: 'read_file' },
      { type: 'tool_sequence', tools: ['list_files', 'read_file'] },
      { type: 'tool_not_called', tool: 'web_search' },
    ],
  },
  {
    id: 'pm-announcements-web',
    prompt: 'How worried should I be about the PM\u2019s recent policy announcements?',
    description:
      'Current-events question: web_search is required, and the assembled prompt should ' +
      'carry today\u2019s date (and/or the coarse location) so the search is time-scoped.',
    assertions: [
      { type: 'tool_called', tool: 'web_search' },
      { type: 'tool_called', tool: 'current_datetime' },
      { type: 'tool_not_called', tool: 'list_files' },
      // #158 rule 1 (OQ2, pinned): a sourced answer must reference its
      // sources inline as literal links, not just narrate conclusions.
      { type: 'text_inline_sources' },
    ],
  },
  {
    id: 'what-time-is-it',
    prompt: 'What time is it right now?',
    description:
      'The key-free current_datetime tool answers this; hitting the web for it is a fail: ' +
      'the wrong-tool half of the built-in tool set.',
    assertions: [
      { type: 'tool_called', tool: 'current_datetime' },
      { type: 'tool_not_called', tool: 'web_search' },
      { type: 'tool_not_called', tool: 'list_files' },
      { type: 'tool_not_called', tool: 'read_file' },
    ],
  },
  {
    id: 'save-notes-file',
    prompt: 'Save a short note about my backlog priorities to my files.',
    description:
      'Save-to-library intent: generate_file with a .md filename; no search, no listing, no reads.',
    assertions: [
      { type: 'tool_called', tool: 'generate_file' },
      { type: 'tool_not_called', tool: 'web_search' },
      { type: 'tool_not_called', tool: 'list_files' },
      { type: 'tool_not_called', tool: 'read_file' },
    ],
  },
  /* #158 cases: refusal + hallucination. The `finalText` assertions in the
   * two cases below are the deterministic slice of the ticket's rules 1 and
   * 2; the semantic remainder stays open for an LLM-judge decision. */
  {
    id: 'benchmaxxed-evals-web',
    prompt:
      'The models are increasingly benchmaxxed now and I don\u2019t know what the solution ' +
      'is \u2014 how might we do better frontier evals?',
    description:
      '#158 subtle current-events question: "benchmaxxed" / "frontier evals" are live ' +
      'frontier-eval discourse that no knowledge-weight answer can cover honestly, so the ' +
      'agent must time-scope and search the web instead of generating from weights.',
    assertions: [
      { type: 'tool_called', tool: 'web_search' },
      { type: 'tool_called', tool: 'current_datetime' },
      { type: 'tool_not_called', tool: 'list_files' },
      // Hallucination guard: no answer may narrate searches it never ran.
      { type: 'text_not_claiming_search' },
      // #158 rule 1 (OQ2, pinned): sourced answers cite inline as links.
      { type: 'text_inline_sources' },
    ],
  },
  {
    id: 'no-sources-unanswerable',
    prompt: 'What does my windscreen-cover section say about Gladiator windscreen repairs?',
    description:
      '#158 unanswerable question: the seeded files are a Bupa health policy and utility ' +
      'bills, so nothing documents car windscreen cover. Rule 2 requires the agent to ' +
      'explicitly say that no sources are available instead of inventing coverage terms.',
    assertions: [
      { type: 'tool_called', tool: 'list_files' },
      { type: 'tool_not_called', tool: 'generate_file' },
      // Rule 2, deterministic form: an explicit no-sources signal in the answer.
      // The pattern is compiled from NO_SOURCES_PATTERNS so the case cannot
      // drift from the central refusal regex set.
      { type: 'text_matches', pattern: noSourcesPattern },
    ],
  },
  {
    id: 'arithmetic-uses-calculator',
    prompt: 'If I put away £25 a month, how much will that be after three years?',
    description:
      '#283: a calculation must go through the `calculate` tool (exact arithmetic) rather ' +
      'than being worked out from weights, and must not trigger a web search or a file read.',
    assertions: [
      { type: 'tool_called', tool: 'calculate' },
      { type: 'tool_not_called', tool: 'web_search' },
      { type: 'tool_not_called', tool: 'list_files' },
      { type: 'tool_not_called', tool: 'read_file' },
      { type: 'answer_contains', text: '900' },
    ],
  },
  {
    id: 'manual-page-of-phone',
    prompt: 'Which page of long-manual.md is the support phone number on?',
    description:
      '#159 long-document navigation: the agent must walk units (unitsOnly first), ' +
      'locate the support phone number (only on page 58 of 60), and answer the page.',
    assertions: [
      { type: 'tool_called', tool: 'list_files' },
      // Navigation signal: either a unitsOnly listing or a targeted unit read
      // counts (live runs show both legitimate walks; the literal unitsOnly
      // assert rejected a correct direct unit-58 read as "unwalked").
      { type: 'tool_called', tool: 'read_file', argsSubset: { unit: 58 } },
      // Strict variant: the unitsOnly-first navigation. A range-walk agent
      // fails only this line (partial aggregate), not the whole case.
      { type: 'tool_called', tool: 'read_file', argsSubset: { unitsOnly: true } },
      { type: 'answer_contains', text: 'page 58' },
    ],
  },
  {
    id: 'manual-phone-number',
    prompt: 'What is the support phone number in long-manual.md?',
    description:
      '#159 long-document retrieval: the answer material (the support phone number, ' +
      "page 58 of 60) is graded on the assistant's answer text, not on a generated file.",
    assertions: [
      { type: 'tool_called', tool: 'read_file' },
      { type: 'answer_contains', text: '+44 20 7946 0812' },
      { type: 'tool_not_called', tool: 'web_search' },
    ],
  },
  {
    id: 'handbook-split-sections',
    prompt:
      'Split project-handbook.md into one markdown file per heading-2 section, ' +
      'named <nn>-<slug>.md in section order (zero-padded two-digit number, e.g. ' +
      '01-overview.md), each file starting with the section heading kept exactly ' +
      'as a heading-2 line (## Title) followed by its body.',
    description:
      '#159 long-document structuring: the agent reads the handbook by units and ' +
      'generates one markdown file per heading-2 section under the stated filename ' +
      'convention; content assertions are substring-level since bodies may be rewritten.',
    assertions: [
      { type: 'tool_sequence', tools: ['read_file', 'generate_file'] },
      { type: 'tool_called', tool: 'generate_file', argsSubset: { filename: '01-overview.md' } },
      { type: 'file_content_contains', filename: '01-overview.md', text: '## Overview' },
      {
        type: 'tool_called',
        tool: 'generate_file',
        argsSubset: { filename: '06-glossary.md' },
      },
      { type: 'file_content_contains', filename: '06-glossary.md', text: '## Glossary' },
    ],
  },
];
