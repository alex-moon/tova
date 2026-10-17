import { reviewAssistantTurn } from '../../main/services/honestyGuardService';
import { Message } from '../../main/models/Message';
import { muteConsoleError } from '../muteConsole';

const mockCreateToolFree = jest.fn();

jest.mock('../../main/services/inferenceService', () => ({
  inferenceService: {
    createToolFreeCompletion: (...args: unknown[]) => mockCreateToolFree(...args),
    createStructuredCompletion: (...args: unknown[]) => mockCreateToolFree(...args),
  },
}));

// The service sanity-checks the raw reply before trusting the structured object, so mocks carry both.
const completion = (object: unknown, raw?: string, finishReason?: string) => ({
  choices: [
    {
      message: { content: raw ?? JSON.stringify(object) },
      ...(finishReason ? { finishReason } : { finishReason: 'stop' }),
    },
  ],
  object,
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
    mockCreateToolFree.mockResolvedValueOnce(
      completion({ claimsToolUse: true, reason: 'no tools ran' }),
    );
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
    mockCreateToolFree.mockResolvedValueOnce(completion({ claimsToolUse: false, reason: '' }));
    await reviewAssistantTurn(String(message._id), message.content as string, []);
    const persisted = await Message.findById(message._id);
    expect(persisted?.honesty?.flagged).toBe(false);
  });

  it('#378: budgets generous tokens for the reasoning aux model (128k window; the cap is a safety bound, not a cost driver)', async () => {
    const message = await Message.create({
      sessionId: '0'.repeat(24),
      role: 'assistant',
      content: 'Hello!',
    });
    mockCreateToolFree.mockResolvedValueOnce(completion({ claimsToolUse: false, reason: '' }));
    await reviewAssistantTurn(String(message._id), message.content as string, []);
    const options = mockCreateToolFree.mock.calls[0][0];
    expect(options.max_tokens).toBe(1024);
  });

  it('#368: passes the verdict schema with fallback and auto injection', async () => {
    const message = await Message.create({
      sessionId: '0'.repeat(24),
      role: 'assistant',
      content: 'Hello!',
    });
    mockCreateToolFree.mockResolvedValueOnce(completion({ claimsToolUse: false, reason: '' }));
    await reviewAssistantTurn(String(message._id), message.content as string, []);
    const options = mockCreateToolFree.mock.calls[0][0] as {
      structuredOutput?: { errorStrategy?: string; jsonPromptInjection?: unknown };
    };
    expect(options.structuredOutput?.errorStrategy).toBe('fallback');
    expect(options.structuredOutput?.jsonPromptInjection).toBe('auto');
  });

  it('names the executed tools in the audit prompt and threads the session into the trace', async () => {
    const message = await Message.create({
      sessionId: '0'.repeat(24),
      role: 'assistant',
      content: 'Done.',
    });
    mockCreateToolFree.mockResolvedValueOnce(completion({ claimsToolUse: false, reason: '' }));
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

  it('#378: an empty reply (starved reasoning model) is left unassessed with a warning, not scored clean', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const message = await Message.create({
        sessionId: '0'.repeat(24),
        role: 'assistant',
        content: 'Read it.',
      });
      // The live 15:00:53/15:02:55 shape: the model returns nothing at all.
      mockCreateToolFree.mockResolvedValueOnce({
        choices: [{ message: { content: '' }, finishReason: 'stop' }],
        object: { claimsToolUse: false, reason: '' },
      });
      expect(
        await reviewAssistantTurn(String(message._id), message.content as string, []),
      ).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unclassifiable verdict'));
      const persisted = await Message.findById(message._id);
      expect(persisted?.honesty).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('#378: a truncated verdict (length stop) is left unassessed, never a false clean', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const message = await Message.create({
        sessionId: '0'.repeat(24),
        role: 'assistant',
        content: 'Read it.',
      });
      // The live 15:02:34 shape: `{"claimsToolUse": true,` cut off mid-JSON.
      mockCreateToolFree.mockResolvedValueOnce(
        completion({ claimsToolUse: false, reason: '' }, '{"claimsToolUse": true,', 'length'),
      );
      expect(
        await reviewAssistantTurn(String(message._id), message.content as string, []),
      ).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('finishReason=length'));
      const persisted = await Message.findById(message._id);
      expect(persisted?.honesty).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
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
