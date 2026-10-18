import {
  inferenceService,
  isWiredProvider,
  wiredProviders,
} from '../../main/services/inferenceService';

/* Pins dispatch: options reach the right connector; default is groq. */
const mockGroqCompletion = jest.fn();
const mockGroqStream = jest.fn();
const mockDeepinfraCompletion = jest.fn();
const mockDeepinfraStream = jest.fn();

jest.mock('../../main/services/mastraService', () => ({
  groqConnector: {
    createCompletion: (...args: unknown[]) => mockGroqCompletion(...args),
    createStreamingCompletion: (...args: unknown[]) => mockGroqStream(...args),
  },
  deepinfraConnector: {
    createCompletion: (...args: unknown[]) => mockDeepinfraCompletion(...args),
    createStreamingCompletion: (...args: unknown[]) => mockDeepinfraStream(...args),
  },
}));

describe('Inference Service provider dispatch', () => {
  beforeEach(() => {
    mockGroqCompletion.mockReset();
    mockGroqStream.mockReset();
    mockDeepinfraCompletion.mockReset();
    mockDeepinfraStream.mockReset();
  });

  it('defaults un-tagged calls to the groq connector', async () => {
    mockGroqCompletion.mockResolvedValueOnce({ choices: [] });
    await inferenceService.createCompletion({ model: 'x', messages: [] });
    expect(mockGroqCompletion).toHaveBeenCalledWith({ model: 'x', messages: [] });
    expect(mockDeepinfraCompletion).not.toHaveBeenCalled();
  });

  it('dispatches streaming defaults to groq as well', async () => {
    mockGroqStream.mockResolvedValueOnce((async function* () {})());
    await inferenceService.createStreamingCompletion({ model: 'x', messages: [] });
    expect(mockGroqStream).toHaveBeenCalledWith({ model: 'x', messages: [] });
    expect(mockDeepinfraStream).not.toHaveBeenCalled();
  });

  it('dispatches provider deepinfra to the deepinfra connector', async () => {
    mockDeepinfraCompletion.mockResolvedValueOnce({ choices: [] });
    await inferenceService.createCompletion({
      provider: 'deepinfra',
      model: 'x',
      messages: [],
    });
    expect(mockDeepinfraCompletion).toHaveBeenCalledWith({
      provider: 'deepinfra',
      model: 'x',
      messages: [],
    });
    expect(mockGroqCompletion).not.toHaveBeenCalled();
  });

  it('dispatches streaming provider deepinfra to the deepinfra connector', async () => {
    mockDeepinfraStream.mockResolvedValueOnce((async function* () {})());
    await inferenceService.createStreamingCompletion({
      provider: 'deepinfra',
      model: 'x',
      messages: [],
    });
    expect(mockDeepinfraStream).toHaveBeenCalledWith({
      provider: 'deepinfra',
      model: 'x',
      messages: [],
    });
    expect(mockGroqStream).not.toHaveBeenCalled();
  });

  it('returns the connector result unchanged (no re-shaping of neutral types)', async () => {
    const neutral = {
      choices: [{ message: { content: 'ok' } }],
    };
    mockGroqCompletion.mockResolvedValueOnce(neutral);
    await expect(inferenceService.createCompletion({ model: 'x', messages: [] })).resolves.toBe(
      neutral,
    );
  });

  it('the un-tagged default is still groq (flip is a later, guarded step)', async () => {
    mockGroqCompletion.mockResolvedValueOnce({ choices: [] });
    await inferenceService.createCompletion({ model: 'x', messages: [] });
    expect(mockGroqCompletion).toHaveBeenCalled();
  });

  describe('unknown provider (corrupt/unsupported config data)', () => {
    const corruptCall = () =>
      inferenceService.createCompletion({
        provider: 'ollama' as never,
        model: 'x',
        messages: [],
      });

    it('throws a named error instead of a bare TypeError', async () => {
      await expect(corruptCall()).rejects.toThrow('Unknown LLM provider: ollama');
    });

    it('throws before any connector is invoked', async () => {
      await corruptCall().catch(() => {});
      expect(mockGroqCompletion).not.toHaveBeenCalled();
      expect(mockDeepinfraCompletion).not.toHaveBeenCalled();
    });

    it('prototype-chain names are not wired providers', () => {
      for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
        expect(isWiredProvider(name)).toBe(false);
      }
      expect(isWiredProvider('groq')).toBe(true);
      expect(isWiredProvider('deepinfra')).toBe(true);
      expect(isWiredProvider('fireworks')).toBe(true);
      expect(isWiredProvider(42)).toBe(false);
      expect(isWiredProvider(undefined)).toBe(false);
    });

    it('the registry enumerates exactly the wired providers', () => {
      expect([...wiredProviders].sort()).toEqual(['deepinfra', 'fireworks', 'groq']);
    });

    it('a prototype-chain provider name fails clean, not with a TypeError', async () => {
      await expect(
        inferenceService.createCompletion({
          provider: 'toString' as never,
          model: 'x',
          messages: [],
        }),
      ).rejects.toThrow('Unknown LLM provider: toString');
    });
  });
});
