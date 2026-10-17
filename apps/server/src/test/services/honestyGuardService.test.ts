import { parseHonestyVerdict, reviewAssistantTurn } from '../../main/services/honestyGuardService';
import { Message } from '../../main/models/Message';
import { muteConsoleError } from '../muteConsole';

const mockCreateToolFree = jest.fn();

jest.mock('../../main/services/inferenceService', () => ({
  inferenceService: {
    createToolFreeCompletion: (...args: unknown[]) => mockCreateToolFree(...args),
  },
}));

describe('parseHonestyVerdict', () => {
  it('parses a clean verdict object', () => {
    expect(parseHonestyVerdict('{"claimsToolUse": true, "reason": "quoted file lines"}')).toEqual({
      flagged: true,
      reason: 'quoted file lines',
    });
    expect(parseHonestyVerdict('{"claimsToolUse": false, "reason": ""}')).toEqual({
      flagged: false,
      reason: null,
    });
  });

  it('tolerates fences and prose around the object', () => {
    expect(
      parseHonestyVerdict('Verdict:\n```json\n{"claimsToolUse": true, "reason": "no tools"}\n```'),
    ).toEqual({ flagged: true, reason: 'no tools' });
  });

  it('skips a decoy object before the real verdict', () => {
    expect(
      parseHonestyVerdict('{"note": "hi"} then {"claimsToolUse": false, "reason": "ok"}'),
    ).toEqual({ flagged: false, reason: 'ok' });
  });

  it('returns null for missing or non-boolean claimsToolUse, and for empty input', () => {
    expect(parseHonestyVerdict('{"reason": "no flag"}')).toBeNull();
    expect(parseHonestyVerdict('{"claimsToolUse": "yes", "reason": "x"}')).toBeNull();
    expect(parseHonestyVerdict('plain prose only')).toBeNull();
    expect(parseHonestyVerdict('')).toBeNull();
    expect(parseHonestyVerdict(null)).toBeNull();
    expect(parseHonestyVerdict(undefined)).toBeNull();
  });
});

describe('reviewAssistantTurn', () => {
  beforeEach(() => {
    mockCreateToolFree.mockReset();
  });

  it('persists a flagged verdict on the message', async () => {
    const message = await Message.create({
      sessionId: '0'.repeat(24),
      role: 'assistant',
      content: 'Read it — 87 lines.',
    });
    mockCreateToolFree.mockResolvedValueOnce({
      choices: [{ message: { content: '{"claimsToolUse": true, "reason": "no tools ran"}' } }],
    });
    const verdict = await reviewAssistantTurn(String(message._id), message.content as string, []);
    expect(verdict).toEqual({ flagged: true, reason: 'no tools ran' });
    const persisted = await Message.findById(message._id);
    expect(persisted?.honesty?.flagged).toBe(true);
    expect(persisted?.honesty?.reason).toBe('no tools ran');
    expect(persisted?.honesty?.checkedAt).toBeInstanceOf(Date);
  });

  it('persists a clean verdict as flagged false', async () => {
    const message = await Message.create({
      sessionId: '0'.repeat(24),
      role: 'assistant',
      content: 'Hello!',
    });
    mockCreateToolFree.mockResolvedValueOnce({
      choices: [{ message: { content: '{"claimsToolUse": false, "reason": ""}' } }],
    });
    await reviewAssistantTurn(String(message._id), message.content as string, []);
    const persisted = await Message.findById(message._id);
    expect(persisted?.honesty?.flagged).toBe(false);
  });

  it('names the executed tools in the audit prompt and threads the session into the trace', async () => {
    const message = await Message.create({
      sessionId: '0'.repeat(24),
      role: 'assistant',
      content: 'Done.',
    });
    mockCreateToolFree.mockResolvedValueOnce({
      choices: [{ message: { content: '{"claimsToolUse": false, "reason": ""}' } }],
    });
    await reviewAssistantTurn(
      String(message._id),
      message.content as string,
      ['read_file'],
      'session-1',
    );
    const options = mockCreateToolFree.mock.calls[0][0];
    expect(options.provider).toBe('groq');
    expect(options.model).toBe(process.env.AUX_MODEL || 'openai/gpt-oss-20b');
    expect(JSON.stringify(options.messages)).toContain('read_file');
    expect(options.trace).toEqual({ sessionId: 'session-1' });
  });

  it('leaves the message unassessed when the verdict is unparseable', async () => {
    const message = await Message.create({
      sessionId: '0'.repeat(24),
      role: 'assistant',
      content: 'Read it.',
    });
    mockCreateToolFree.mockResolvedValueOnce({
      choices: [{ message: { content: 'no json here' } }],
    });
    expect(
      await reviewAssistantTurn(String(message._id), message.content as string, []),
    ).toBeNull();
    const persisted = await Message.findById(message._id);
    expect(persisted?.honesty).toBeUndefined();
  });

  it('leaves the message unassessed and swallows a failed aux call', async () => {
    const mute = muteConsoleError();
    try {
      const message = await Message.create({
        sessionId: '0'.repeat(24),
        role: 'assistant',
        content: 'Read it.',
      });
      mockCreateToolFree.mockRejectedValueOnce(new Error('429 TPM'));
      expect(
        await reviewAssistantTurn(String(message._id), message.content as string, []),
      ).toBeNull();
      const persisted = await Message.findById(message._id);
      expect(persisted?.honesty).toBeUndefined();
    } finally {
      mute.mockRestore();
    }
  });
});
