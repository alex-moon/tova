import { runModelComparison } from '../../main/services/modelCompare';

jest.mock('../../main/services/mastraService', () => {
  const connectorFor = (tag: string) => ({
    createCompletion: jest.fn(async (options: { model: string }) =>
      options.model.includes('fail')
        ? Promise.reject(new Error(`${tag} exploded`))
        : Promise.resolve({ choices: [{ message: { content: `${tag}:${options.model}` } }] }),
    ),
  });
  return {
    groqConnector: connectorFor('groq'),
    deepinfraConnector: connectorFor('deepinfra'),
  };
});

jest.mock('../../main/services/promptAssembly', () => ({
  buildSystemContent: jest.fn(() => 'SYSTEM'),
}));

const mockCreate = (connector: unknown): jest.Mock => {
  const c = connector as { createCompletion: unknown };
  return c.createCompletion as unknown as jest.Mock;
};

const { groqConnector, deepinfraConnector } = jest.requireMock('../../main/services/mastraService');

beforeEach(() => {
  mockCreate(groqConnector).mockClear();
  mockCreate(deepinfraConnector).mockClear();
});

describe('runModelComparison (issue #129)', () => {
  const prompt = 'A conversational, multi-part question near Ad Gefrin?';

  it('runs the prompt on each model sequentially and reports latency + answers', async () => {
    const run = await runModelComparison(prompt, [
      { provider: 'deepinfra', model: 'Qwen/Qwen3-14B' },
      { provider: 'groq', model: 'openai/gpt-oss-20b' },
    ]);
    expect(run.prompt).toBe(prompt);
    expect(run.results.map((r) => r.model)).toEqual(['Qwen/Qwen3-14B', 'openai/gpt-oss-20b']);
    expect(run.results.map((r) => r.answer)).toEqual([
      'deepinfra:Qwen/Qwen3-14B',
      'groq:openai/gpt-oss-20b',
    ]);
    expect(run.results.every((r) => r.error === undefined)).toBe(true);
    expect(run.results.every((r) => r.latencyMs >= 0)).toBe(true);
  });

  it('assembles messages exactly like the chat routes (system first, then user)', async () => {
    await runModelComparison('hello', [{ provider: 'groq', model: 'x' }]);
    const options = mockCreate(groqConnector).mock.calls[0][0];
    expect(options.messages).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('forces provider/model per row, bypassing routing', async () => {
    await runModelComparison('hi', [
      { provider: 'groq', model: 'm1' },
      { provider: 'deepinfra', model: 'm2' },
    ]);
    expect(mockCreate(groqConnector).mock.calls[0][0].provider).toBe('groq');
    expect(mockCreate(groqConnector).mock.calls[0][0].model).toBe('m1');
    expect(mockCreate(deepinfraConnector).mock.calls[0][0].provider).toBe('deepinfra');
    expect(mockCreate(deepinfraConnector).mock.calls[0][0].model).toBe('m2');
  });

  it('captures per-model errors without failing the whole run', async () => {
    const run = await runModelComparison('hi', [{ provider: 'groq', model: 'x-fails' }]);
    expect(run.results[0]).toMatchObject({
      model: 'x-fails',
      answer: null,
      error: 'groq exploded',
    });
  });

  it('skips unknown providers per row without failing the run', async () => {
    const run = await runModelComparison('hi', [{ provider: 'bogus' as 'groq', model: 'm' }]);
    expect(run.results[0]).toEqual(
      expect.objectContaining({ answer: null, error: 'Unknown provider: bogus' }),
    );
    expect(mockCreate(groqConnector)).not.toHaveBeenCalled();
  });

  it('emits an error row for a retired provider id rather than crashing', async () => {
    const run = await runModelComparison('hi', [{ provider: 'typesafe' as 'groq', model: 'jev' }]);
    expect(run.results[0]).toEqual(
      expect.objectContaining({
        provider: 'typesafe',
        answer: null,
        error: 'Unknown provider: typesafe',
      }),
    );
    expect(mockCreate(groqConnector)).not.toHaveBeenCalled();
  });
});
