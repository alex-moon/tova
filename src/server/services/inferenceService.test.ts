import { inferenceService } from './inferenceService';

/*
 * Tests the provider dispatch in the delegating service. The connectors now
 * live in `mastraService` (the single `@mastra/*` boundary, whose mapping is
 * pins that options dispatch to the right connector and that un-tagged
 * callers default to `deepinfra` (#109: Groq does no completion work).
 */

const mockGroqCompletion = jest.fn();
const mockGroqStream = jest.fn();
const mockDeepinfraCompletion = jest.fn();
const mockDeepinfraStream = jest.fn();

jest.mock('./mastraService', () => ({
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

  it('defaults un-tagged calls to the deepinfra connector', async () => {
    mockDeepinfraCompletion.mockResolvedValueOnce({ choices: [] });
    await inferenceService.createCompletion({ model: 'x', messages: [] });
    expect(mockDeepinfraCompletion).toHaveBeenCalledWith({ model: 'x', messages: [] });
    expect(mockGroqCompletion).not.toHaveBeenCalled();
  });

  it('dispatches streaming defaults to deepinfra as well', async () => {
    mockDeepinfraStream.mockResolvedValueOnce((async function* () {})());
    await inferenceService.createStreamingCompletion({ model: 'x', messages: [] });
    expect(mockDeepinfraStream).toHaveBeenCalledWith({ model: 'x', messages: [] });
    expect(mockGroqStream).not.toHaveBeenCalled();
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
    mockDeepinfraCompletion.mockResolvedValueOnce(neutral);
    await expect(inferenceService.createCompletion({ model: 'x', messages: [] })).resolves.toBe(
      neutral,
    );
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
  });
});
