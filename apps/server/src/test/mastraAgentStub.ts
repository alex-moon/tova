/*
 * Jest-only stub standing in for `@mastra/core/agent` in test suites that do
 * not explicitly mock it. The real package's transitive deps include
 * ESM-only modules (e.g. `@sindresorhus/slugify`) that ts-jest in CJS mode
 * cannot `require`; the suites that exercise the agent machinery
 * (the route/service tests) replace this module wholesale via
 * `jest.mock('@mastra/core/agent', ...)`, so the stub never
 * participates in those suites. Any suite that reaches the `Agent` here
 * without a mock fails loudly instead of making real network calls.
 */
export class Agent {
  constructor(config: { id?: string; name?: string; model?: string | { url: string } }) {
    throw new Error(
      `jest stub: Agent('${config?.model}') constructed without a jest.mock for '@mastra/core/agent'`,
    );
  }
}
