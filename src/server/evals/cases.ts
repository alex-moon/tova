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
      { type: 'content_equals', expected: '@repo:README.md' },
    ],
    expectedContent: '@repo:README.md',
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
];
