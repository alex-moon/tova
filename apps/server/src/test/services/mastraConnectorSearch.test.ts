import { ToolSearchProcessor } from '@mastra/core/processors';
import { connectorSearchOptionsFrom } from '../../main/services/mastraService';
import type { CompletionOptions } from '../../main/services/llmTypes';

/* Pins the deferred-connector option shape the connector builder emits. */
// @see #360

const mockToolsetsFor = jest.fn();
jest.mock('../../main/services/connectorService', () => ({
  connectorToolsetsForUser: (...args: unknown[]) => mockToolsetsFor(...args),
}));

const fakeTool = (name: string) =>
  ({
    id: `set/${name}`,
    description: `does ${name}`,
    inputSchema: {},
    execute: async () => ({}),
  }) as unknown as Record<string, unknown>;

const optionsWith = (overrides: Partial<CompletionOptions> = {}): CompletionOptions =>
  ({ userId: 'u1', ...overrides }) as CompletionOptions;

// `options` is private on the processor; tests reach in via this seam.
const processorOptions = (
  processor: ToolSearchProcessor,
): { tools: Record<string, unknown>; search: unknown } =>
  (
    processor as unknown as {
      options: { tools: Record<string, unknown>; search: unknown };
    }
  ).options;

beforeEach(() => {
  mockToolsetsFor.mockReset();
});

describe('connectorSearchOptionsFrom (#360 deferred connector tools)', () => {
  it('forwards no options for an anonymous call', async () => {
    mockToolsetsFor.mockResolvedValue({});
    const opts = await connectorSearchOptionsFrom({} as CompletionOptions);
    expect(opts).toEqual({});
    expect(mockToolsetsFor).not.toHaveBeenCalled();
  });

  it('forwards no options when the user has no connector tools', async () => {
    mockToolsetsFor.mockResolvedValue({});
    const opts = await connectorSearchOptionsFrom(optionsWith());
    expect(opts).toEqual({});
  });

  it('attaches one per-call ToolSearchProcessor with the user’s tools as an auto-loading catalog', async () => {
    mockToolsetsFor.mockResolvedValue({
      mcp_github: { create_pull_request: fakeTool('create_pull_request') },
    });
    const opts = await connectorSearchOptionsFrom(optionsWith());
    expect(opts.inputProcessors).toHaveLength(1);
    const processor = opts.inputProcessors?.[0] as ToolSearchProcessor;
    expect(processor).toBeInstanceOf(ToolSearchProcessor);
    const options = processorOptions(processor);
    expect(Object.keys(options.tools)).toEqual(['create_pull_request']);
    expect(options.search).toMatchObject({ topK: 5, autoLoad: true });
  });

  it('re-wraps catalog tools with provider-safe ids, preserving the executor', async () => {
    const original = fakeTool('pull_request.review');
    mockToolsetsFor.mockResolvedValue({
      mcp_github: { 'pull_request.review': original },
    });
    const opts = await connectorSearchOptionsFrom(optionsWith());
    const processor = opts.inputProcessors?.[0] as ToolSearchProcessor;
    const tool = processorOptions(processor).tools['pull_request.review'] as {
      id: string;
      execute: unknown;
    };
    expect(tool.id).toBe('pull_request_review');
    expect(tool.execute).toBe(original.execute);
  });

  it('first connector wins on tool-name collisions', async () => {
    mockToolsetsFor.mockResolvedValue({
      mcp_one: { shared: fakeTool('one-shared') },
      mcp_two: { shared: fakeTool('two-shared') },
    });
    const opts = await connectorSearchOptionsFrom(optionsWith());
    const processor = opts.inputProcessors?.[0] as ToolSearchProcessor;
    const options = processorOptions(processor);
    expect(Object.keys(options.tools)).toEqual(['shared']);
    expect((options.tools.shared as { description: string }).description).toBe('does one-shared');
  });
});
