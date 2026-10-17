import { groqConnector } from '../../main/services/mastraService';
import { RequestContext } from '@mastra/core/request-context';

/* The caller's userId must reach a built-in tool's `execute` through Mastra's request context, never baked into the memoised agent instance; the agent module is mocked (CJS/ESM constraint) and records the exact call options mastraService passes. */
// @see #58

const mockGenerate = jest.fn();
const mockStream = jest.fn();

jest.mock('@mastra/core/agent', () => ({
  Agent: jest.fn().mockImplementation(() => ({
    generate: (...args: unknown[]) => mockGenerate(...args),
    stream: (...args: unknown[]) => mockStream(...args),
  })),
}));

const asOptions = (call: unknown): { requestContext: RequestContext } =>
  (call as unknown[])[1] as unknown as { requestContext: RequestContext };

describe('mastraService request-context plumbing (#58)', () => {
  beforeEach(() => {
    mockGenerate.mockReset().mockResolvedValue({ text: 'ok' });
    mockStream.mockReset().mockResolvedValue({ fullStream: (async function* () {})() });
  });

  it('builds a request context carrying the caller userId on generate', async () => {
    await groqConnector.createCompletion({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      userId: 'user-42',
    });
    const options = asOptions(mockGenerate.mock.calls[0]);
    expect(options.requestContext).toBeInstanceOf(RequestContext);
    expect(options.requestContext.get('userId')).toBe('user-42');
  });

  it('builds the same plumbing on the streaming path', async () => {
    await groqConnector.createStreamingCompletion({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      userId: 'user-42',
    });
    const options = asOptions(mockStream.mock.calls[0]);
    expect(options.requestContext).toBeInstanceOf(RequestContext);
    expect(options.requestContext.get('userId')).toBe('user-42');
  });

  it('uses a fresh context per call — user ids never cross turns', async () => {
    await groqConnector.createCompletion({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      userId: 'user-a',
    });
    await groqConnector.createCompletion({
      model: 'm',
      messages: [{ role: 'user', content: 'hi again' }],
      userId: 'user-b',
    });
    const first = asOptions(mockGenerate.mock.calls[0]);
    const second = asOptions(mockGenerate.mock.calls[1]);
    expect(first.requestContext).not.toBe(second.requestContext);
    expect(first.requestContext.get('userId')).toBe('user-a');
    expect(second.requestContext.get('userId')).toBe('user-b');
  });

  it('still builds an empty context when no userId is supplied (aux callers)', async () => {
    await groqConnector.createToolFreeCompletion({
      model: 'm',
      messages: [{ role: 'user', content: 'summarise' }],
    });
    const options = asOptions(mockGenerate.mock.calls[0]);
    expect(options.requestContext).toBeInstanceOf(RequestContext);
    expect(options.requestContext.get('userId')).toBeUndefined();
  });
});
