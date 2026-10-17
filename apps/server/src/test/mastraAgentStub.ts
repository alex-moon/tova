/* Jest-only stub for `@mastra/core/agent` in suites that do not mock it: the real package's ESM-only transitive deps cannot be required by ts-jest in CJS mode; suites exercising agent machinery mock this module wholesale, and an unmocked reach fails loudly rather than making network calls. */
export class Agent {
  constructor(config: { id?: string; name?: string; model?: string | { url: string } }) {
    throw new Error(
      `jest stub: Agent('${config?.model}') constructed without a jest.mock for '@mastra/core/agent'`,
    );
  }
}
