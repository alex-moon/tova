/* Jest-only stub: an unmocked Agent reach fails loudly, no network calls. */
export class Agent {
  constructor(config: { id?: string; name?: string; model?: string | { url: string } }) {
    throw new Error(
      `jest stub: Agent('${config?.model}') constructed without a jest.mock for '@mastra/core/agent'`,
    );
  }
}
