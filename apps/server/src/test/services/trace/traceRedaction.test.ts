import {
  redactDeep,
  redactSpanPayload,
  RedactedLangSmithExporter,
} from '../../../main/services/trace/traceRedaction';

// The package fails under jest's node env; only the hook around the base call.
jest.mock('@mastra/langsmith', () => {
  class LangSmithExporter {
    protected async _preExportTracingEvent(event: {
      exportedSpan: unknown;
      type: unknown;
    }): Promise<{ exportedSpan: unknown; type: unknown }> {
      return event;
    }
  }
  class Client {}
  class RunTree {}
  return { LangSmithExporter, Client, RunTree };
});

describe('traceRedaction', () => {
  describe('redactDeep', () => {
    it('redacts payload-like strings inside objects', () => {
      const payload = {
        messages: [{ role: 'user', content: 'please summarize: ' + 'x'.repeat(100) }],
        metadata: { userId: 'u1' },
      };
      const out = redactDeep(payload) as typeof payload;
      expect(out.messages[0].content).toContain('[redacted]');
      expect(out.metadata.userId).toBe('u1');
    });

    it('keeps head/tail words of long prose for context', () => {
      const prose = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
      const out = redactDeep({ content: prose }) as { content: string };
      expect(out.content).toBe('word0 word1 word2 [redacted] word27 word28 word29');
    });

    it('keeps head/tail inside long quoted payloads', () => {
      const inner = Array.from({ length: 20 }, (_, i) => `frag${i}`).join(' ');
      const out = redactDeep({ content: `Provider said: "${inner}" upstream` }) as {
        content: string;
      };
      expect(out.content).toContain('"frag0 frag1 frag2 [redacted] frag17 frag18 frag19"');
    });

    it('still blanks JSON blocks and secret assignments wholesale', () => {
      const out = redactDeep({
        body: `{"payload":"${'q'.repeat(80)}"}`,
        auth: 'auth failure: apikey=sk-abc123def456ghi789jkl',
      }) as { body: string; auth: string };
      expect(out.body).toBe('[redacted]');
      expect(out.auth).not.toContain('sk-abc123def456ghi789jkl');
      expect(out.auth).toContain('[redacted]');
    });

    it('keeps short structural strings intact', () => {
      const out = redactDeep({ role: 'user', name: 'groq' }) as { role: string; name: string };
      expect(out.role).toBe('user');
      expect(out.name).toBe('groq');
    });

    it('enforces the depth limit', () => {
      const deep = { a: { b: { c: { d: { e: { f: { g: 'secret value here !!!!!!!' } } } } } } };
      const out = redactDeep(deep) as typeof deep;
      expect(out.a.b.c.d.e.f as unknown as string).toBe('[depth-limit]');
    });

    it('leaves primitives other than strings alone', () => {
      expect(redactDeep(42)).toBe(42);
      expect(redactDeep(null)).toBe(null);
      expect(redactDeep(true)).toBe(true);
    });
  });

  describe('redactSpanPayload', () => {
    it('redacts input and output but leaves errorInfo verbatim', () => {
      const message = 'provider echo: ' + 'q'.repeat(120);
      const details = { upstream: 'the model said: ' + 'q'.repeat(120) };
      const span = {
        input: { text: 'tell me about ' + 'y'.repeat(120) },
        output: { text: 'the answer is ' + 'z'.repeat(120) },
        errorInfo: { message, stack: 'at fn', details },
      };
      redactSpanPayload(span as never);
      expect(span.input.text).toContain('[redacted]');
      expect(span.output.text).toContain('[redacted]');
      expect(span.errorInfo.message).toBe(message);
      expect(span.errorInfo.stack).toBe('at fn');
      expect(span.errorInfo.details).toEqual(details);
    });

    it('bounds errorInfo.details structurally without redacting content', () => {
      const details: Record<string, unknown> = {
        note: 'upstream said: ' + 'q'.repeat(2200),
      };
      details.self = details;
      const span = { errorInfo: { message: 'boom', details } };
      expect(() => redactSpanPayload(span as never)).not.toThrow();
      const capped = (span as never as { errorInfo: { details: typeof details } }).errorInfo
        .details;
      const note = capped.note as string;
      expect(note).toContain('upstream said: qqqq');
      expect(note.length).toBe(2000);
      let node: unknown = capped.self;
      for (let i = 0; i < 5; i += 1) node = (node as { self: unknown }).self;
      expect(node).toBe('[depth-limit]');
      expect((JSON.stringify(capped) as string).length).toBeLessThan(20000);
    });
  });

  describe('RedactedLangSmithExporter', () => {
    it('redacts exported spans before posting', async () => {
      const exporter = new RedactedLangSmithExporter({});
      const event = {
        type: 'span_ended',
        exportedSpan: {
          id: 's1',
          traceId: 't1',
          type: 'agent_run',
          name: 'agent run',
          output: { text: 'chat content '.repeat(20) },
        },
      } as never;
      const processed = (await exporter['_preExportTracingEvent'](event as never)) as {
        exportedSpan: { output?: { text?: string } };
      };
      expect(processed.exportedSpan.output?.text ?? '').toContain('[redacted]');
    });
  });
});
