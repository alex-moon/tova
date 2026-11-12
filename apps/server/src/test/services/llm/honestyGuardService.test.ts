import { reviewAssistantTurn } from '../../../main/services/llm/honestyGuardService';
import { Message } from '../../../main/models/Message';
import { muteConsoleError } from '../../muteConsole';

const mockDecide = jest.fn();
const mockCreateToolFree = jest.fn();

jest.mock('../../../main/services/llm/systemOneClient', () => ({
  ...jest.requireActual('../../../main/services/llm/systemOneClient'),
  systemOneDecide: (...args: unknown[]) => mockDecide(...args),
}));

jest.mock('../../../main/services/llm/inferenceService', () => ({
  inferenceService: {
    createToolFreeCompletion: (...args: unknown[]) => mockCreateToolFree(...args),
    createStructuredCompletion: (...args: unknown[]) => mockCreateToolFree(...args),
  },
}));

// The service checks the raw reply first; mocks carry both.
const completion = (object: unknown, raw?: string, finishReason?: string) => ({
  choices: [
    {
      message: { content: raw ?? JSON.stringify(object) },
      ...(finishReason ? { finishReason } : { finishReason: 'stop' }),
    },
  ],
  object,
});

const message = async (content: string) =>
  Message.create({ sessionId: '0'.repeat(24), role: 'assistant', content });

describe('reviewAssistantTurn', () => {
  beforeEach(() => {
    mockDecide.mockReset().mockResolvedValue(null);
    mockCreateToolFree.mockReset();
  });

  it('#426: flags via the decision path and persists confidence', async () => {
    const doc = await message('Read it — 87 lines.');
    mockDecide.mockResolvedValueOnce({ claimsToolUse: { type: 'noul', noul: 0.93 } });
    const verdict = await reviewAssistantTurn(String(doc._id), doc.content as string, []);
    expect(verdict).toEqual({ flagged: true, confidence: 0.93 });
    expect(mockCreateToolFree).not.toHaveBeenCalled();
    const persisted = await Message.findById(doc._id);
    expect(persisted?.honesty?.flagged).toBe(true);
    expect(persisted?.honesty?.confidence).toBe(0.93);
    expect(persisted?.honesty?.checkedAt).toBeInstanceOf(Date);
  });

  it('#426: a confident clean reply passes unflagged', async () => {
    const doc = await message('Hello!');
    mockDecide.mockResolvedValueOnce({ claimsToolUse: { type: 'noul', noul: 0.02 } });
    const verdict = await reviewAssistantTurn(String(doc._id), doc.content as string, []);
    expect(verdict).toEqual({ flagged: false, confidence: 0.02 });
  });

  it('#426: the noul threshold is 0.5', async () => {
    const doc = await message('Read it.');
    mockDecide.mockResolvedValueOnce({ claimsToolUse: { type: 'noul', noul: 0.5 } });
    expect((await reviewAssistantTurn(String(doc._id), doc.content as string, []))?.flagged).toBe(
      true,
    );
  });

  it('#426: names the executed tools in the decision state', async () => {
    const doc = await message('Done.');
    mockDecide.mockResolvedValueOnce({ claimsToolUse: { type: 'noul', noul: 0.1 } });
    await reviewAssistantTurn(String(doc._id), doc.content as string, ['read_file'], 'session-1');
    const state = mockDecide.mock.calls[0][1] as string;
    expect(state).toContain('read_file');
    expect(state).toContain('Done.');
  });

  it('#426: a malformed decision answer falls back to the aux LLM path', async () => {
    const doc = await message('Read it — 87 lines.');
    mockDecide.mockResolvedValueOnce({ claimsToolUse: { type: 'choice', choice: 'yes' } });
    mockCreateToolFree.mockResolvedValueOnce(
      completion({ claimsToolUse: true, reason: 'no tools ran' }),
    );
    const verdict = await reviewAssistantTurn(String(doc._id), doc.content as string, []);
    expect(verdict).toEqual({ flagged: true, confidence: null });
    const persisted = await Message.findById(doc._id);
    expect(persisted?.honesty?.flagged).toBe(true);
    expect(persisted?.honesty?.confidence).toBeNull();
  });

  it('#378: budgets generous tokens for the reasoning aux model (128k window; the cap is a safety bound, not a cost driver)', async () => {
    const doc = await message('Hello!');
    mockCreateToolFree.mockResolvedValueOnce(completion({ claimsToolUse: false, reason: '' }));
    await reviewAssistantTurn(String(doc._id), doc.content as string, []);
    const options = mockCreateToolFree.mock.calls[0][0];
    expect(options.max_tokens).toBe(1024);
  });

  it('#368: passes the verdict schema with fallback and auto injection', async () => {
    const doc = await message('Hello!');
    mockCreateToolFree.mockResolvedValueOnce(completion({ claimsToolUse: false, reason: '' }));
    await reviewAssistantTurn(String(doc._id), doc.content as string, []);
    const options = mockCreateToolFree.mock.calls[0][0] as {
      structuredOutput?: { errorStrategy?: string; jsonPromptInjection?: unknown };
    };
    expect(options.structuredOutput?.errorStrategy).toBe('fallback');
    expect(options.structuredOutput?.jsonPromptInjection).toBe('auto');
  });

  it('names the executed tools in the audit prompt and threads the session into the trace', async () => {
    const doc = await message('Done.');
    mockCreateToolFree.mockResolvedValueOnce(completion({ claimsToolUse: false, reason: '' }));
    await reviewAssistantTurn(String(doc._id), doc.content as string, ['read_file'], 'session-1');
    const options = mockCreateToolFree.mock.calls[0][0];
    expect(options.provider).toBe('groq');
    expect(options.model).toBe(process.env.AUX_MODEL || 'openai/gpt-oss-20b');
    expect(JSON.stringify(options.messages)).toContain('read_file');
    expect(options.trace).toEqual({ sessionId: 'session-1' });
  });

  it('#378: an empty reply (starved reasoning model) is left unassessed with a warning, not scored clean', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const doc = await message('Read it.');
      // The live 15:00:53/15:02:55 shape: the model returns nothing at all.
      mockCreateToolFree.mockResolvedValueOnce({
        choices: [{ message: { content: '' }, finishReason: 'stop' }],
        object: { claimsToolUse: false, reason: '' },
      });
      expect(await reviewAssistantTurn(String(doc._id), doc.content as string, [])).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unclassifiable verdict'));
      const persisted = await Message.findById(doc._id);
      expect(persisted?.honesty).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('#378: a truncated verdict (length stop) is left unassessed, never a false clean', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const doc = await message('Read it.');
      // The live 15:02:34 shape: `{"claimsToolUse": true,` cut off mid-JSON.
      mockCreateToolFree.mockResolvedValueOnce(
        completion({ claimsToolUse: false, reason: '' }, '{"claimsToolUse": true,', 'length'),
      );
      expect(await reviewAssistantTurn(String(doc._id), doc.content as string, [])).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('finishReason=length'));
      const persisted = await Message.findById(doc._id);
      expect(persisted?.honesty).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves the message unassessed and swallows a failed aux call', async () => {
    const mute = muteConsoleError();
    try {
      const doc = await message('Read it.');
      mockCreateToolFree.mockRejectedValueOnce(new Error('429 TPM'));
      expect(await reviewAssistantTurn(String(doc._id), doc.content as string, [])).toBeNull();
      const persisted = await Message.findById(doc._id);
      expect(persisted?.honesty).toBeUndefined();
    } finally {
      mute.mockRestore();
    }
  });
});
