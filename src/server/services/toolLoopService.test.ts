import { runSearchStage } from './toolLoopService';

const mockCreateCompletion = jest.fn();

jest.mock('./inferenceService', () => ({
  inferenceService: {
    createCompletion: (...args: unknown[]) => mockCreateCompletion(...args),
  },
}));

const mockWebSearch = jest.fn();

jest.mock('./webSearchService', () => ({
  webSearch: (...args: unknown[]) => mockWebSearch(...args),
}));

const toolCallAnswer = (toolCalls: unknown[]) => ({
  choices: [{ message: { content: null, tool_calls: toolCalls } }],
});

const MODEL = 'mock-model';

describe('runSearchStage', () => {
  beforeEach(() => {
    mockCreateCompletion.mockReset();
    mockWebSearch.mockReset().mockResolvedValue([]);
  });

  it('returns the answer directly when the model does not call tools', async () => {
    mockCreateCompletion.mockResolvedValue({
      choices: [{ message: { content: 'Plain answer' } }],
    });
    const stage = await runSearchStage([{ role: 'user', content: 'Hello' }], MODEL);
    expect(stage).toEqual({ kind: 'answer', content: 'Plain answer', sources: [] });
    expect(mockWebSearch).not.toHaveBeenCalled();
  });

  it('handles a model shape with no choices without crashing', async () => {
    mockCreateCompletion.mockResolvedValue({});
    const stage = await runSearchStage([{ role: 'user', content: 'Hello' }], MODEL);
    expect(stage).toEqual({ kind: 'answer', content: '', sources: [] });
  });

  it('drops tool calls without an id so Groq cannot 400 on tool_call_id', async () => {
    mockCreateCompletion.mockResolvedValue(
      toolCallAnswer([
        { type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } },
      ]),
    );
    const stage = await runSearchStage([{ role: 'user', content: 'Hello' }], MODEL);
    // All calls were dropped → treated as a plain answer round
    expect(stage.kind).toBe('answer');
    expect(mockWebSearch).not.toHaveBeenCalled();
  });

  it('falls back to the raw string when arguments are malformed JSON', async () => {
    mockCreateCompletion
      .mockResolvedValueOnce(
        toolCallAnswer([
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'web_search', arguments: 'groq speed' },
          },
        ]),
      )
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Grounded' } }] });

    const stage = await runSearchStage([{ role: 'user', content: 'Q' }], MODEL);
    expect(stage.kind).toBe('tool-results');
    if (stage.kind !== 'tool-results') return;
    const toolMessage = stage.messages.find((m) => m.role === 'tool');
    expect(toolMessage).toMatchObject({ tool_call_id: 'call-1' });
    expect(mockWebSearch).toHaveBeenCalledWith('groq speed');
  });

  it('treats an empty resolvable query as a degraded round without enriching sources', async () => {
    mockCreateCompletion
      .mockResolvedValueOnce(
        toolCallAnswer([
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"   "}' },
          },
        ]),
      )
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Answer' } }] });

    const stage = await runSearchStage([{ role: 'user', content: 'Q' }], MODEL);
    expect(stage.kind).toBe('tool-results');
    if (stage.kind !== 'tool-results') return;
    expect(stage.sources).toEqual([]);
    expect(stage.messages.find((m) => m.role === 'tool')?.content).toContain('no usable results');
  });

  it('answers unknown tool calls instead of crashing or retrying them', async () => {
    mockCreateCompletion
      .mockResolvedValueOnce(
        toolCallAnswer([
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'send_email', arguments: '{"to":"x"}' },
          },
        ]),
      )
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Answer' } }] });

    const stage = await runSearchStage([{ role: 'user', content: 'Q' }], MODEL);
    expect(stage.kind).toBe('tool-results');
    if (stage.kind !== 'tool-results') return;
    expect(mockWebSearch).not.toHaveBeenCalled();
    expect(stage.messages.find((m) => m.role === 'tool')?.content).toBe('Unknown tool: send_email');
  });

  it('deduplicates repeated URLs across tool calls', async () => {
    mockWebSearch.mockResolvedValue([
      { title: 'A', snippet: 'a', url: 'https://dup.example.com' },
      { title: 'B', snippet: 'b', url: 'https://dup.example.com' },
    ]);
    const webCall = (id: string) => ({
      id,
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"q"}' },
    });
    mockCreateCompletion
      .mockResolvedValueOnce(toolCallAnswer([webCall('call-1'), webCall('call-2')]))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Answer' } }] });

    const stage = await runSearchStage([{ role: 'user', content: 'Q' }], MODEL);
    expect(stage.kind).toBe('tool-results');
    if (stage.kind !== 'tool-results') return;
    expect(stage.sources).toEqual(['https://dup.example.com']);
  });
});
