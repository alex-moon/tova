import { lookupProviderModel, ProviderModelDetails } from '../../main/services/providerModelLookup';

/*
 * #217: the lookup resolves provider-owned model details from DeepInfra's
 * catalog. `fetch` is mocked throughout — the suite must never pay for or
 * depend on a live provider call. The endpoint is pinned by the live probe
 * recorded in docs/done/plan-217-provider-model-lookup.md.
 */

const originalKey = process.env.DEEPINFRA_API_KEY;

const catalogResponse = (data: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ object: 'list', data }),
});

const mockFetch = jest.fn();

const chatEntry = (overrides: Record<string, unknown> = {}) => ({
  id: 'XiaomiMiMo/MiMo-V2.6-Flash',
  object: 'model',
  metadata: {
    description: 'MiMo-V2.6-Flash is an efficiency-balanced model.',
    context_length: 1048576,
    max_tokens: 1048576,
    pricing: { input_tokens: 0.14, output_tokens: 0.28, cache_read_tokens: 0.0028 },
    tags: ['chat', 'vlm', 'vision', 'prompt_cache', 'reasoning'],
    ...overrides,
  },
});

describe('lookupProviderModel (#217)', () => {
  beforeEach(() => {
    process.env.DEEPINFRA_API_KEY = 'test-key';
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.DEEPINFRA_API_KEY;
    else process.env.DEEPINFRA_API_KEY = originalKey;
  });

  it('resolves a found model with context, per-1M prices, vision and description', async () => {
    mockFetch.mockResolvedValueOnce(catalogResponse([chatEntry()]));
    const details = await lookupProviderModel('deepinfra', 'XiaomiMiMo/MiMo-V2.6-Flash');
    expect(details).toEqual<ProviderModelDetails>({
      provider: 'deepinfra',
      model: 'XiaomiMiMo/MiMo-V2.6-Flash',
      contextLength: 1048576,
      inputPrice: 0.14,
      outputPrice: 0.28,
      vision: true,
      description: 'MiMo-V2.6-Flash is an efficiency-balanced model.',
    });
  });

  it('sends the key as a bearer token to the models endpoint', async () => {
    mockFetch.mockResolvedValueOnce(catalogResponse([]));
    await lookupProviderModel('deepinfra', 'x');
    const [url, init] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain('api.deepinfra.com/v1/openai/models');
    expect(url).toContain('filter=with_meta');
    expect(init.headers.Authorization).toBe('Bearer test-key');
  });

  it('returns null when the provider does not host the model', async () => {
    mockFetch.mockResolvedValueOnce(catalogResponse([chatEntry()]));
    expect(await lookupProviderModel('deepinfra', 'org/absent')).toBeNull();
  });

  it('does not resolve a non-chat entry (null context, character pricing)', async () => {
    mockFetch.mockResolvedValueOnce(
      catalogResponse([
        {
          id: 'XiaomiMiMo/MiMo-V2.5-tts',
          metadata: {
            context_length: null,
            pricing: { input_characters: 0 },
            tags: ['tts'],
          },
        },
      ]),
    );
    expect(await lookupProviderModel('deepinfra', 'XiaomiMiMo/MiMo-V2.5-tts')).toBeNull();
  });

  it('omits vision when the tags do not claim it', async () => {
    mockFetch.mockResolvedValueOnce(
      catalogResponse([chatEntry({ tags: ['chat', 'reasoning'], description: 'text only' })]),
    );
    const details = await lookupProviderModel('deepinfra', 'XiaomiMiMo/MiMo-V2.6-Flash');
    expect(details).toMatchObject({ model: 'XiaomiMiMo/MiMo-V2.6-Flash' });
    expect(details).not.toHaveProperty('vision');
  });

  it('throws a clear error when the key is not configured', async () => {
    delete process.env.DEEPINFRA_API_KEY;
    await expect(lookupProviderModel('deepinfra', 'x')).rejects.toThrow(/DEEPINFRA_API_KEY/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx provider response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await expect(lookupProviderModel('deepinfra', 'x')).rejects.toThrow(/HTTP 503/);
  });

  it('throws on a transport failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(lookupProviderModel('deepinfra', 'x')).rejects.toThrow(/catalog request failed/);
  });
});
