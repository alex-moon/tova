import {
  redactDeep,
  redactSpanPayload,
  RedactedLangSmithExporter,
} from '../../main/services/traceRedaction';

// Real @mastra/langsmith does not play well with the jest node environment;
// the subclass behaviour under test is only the hook around the base call.
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
    it('redacts input, output and error message on a span', () => {
      const span = {
        input: { text: 'tell me about ' + 'y'.repeat(120) },
        output: { text: 'the answer is ' + 'z'.repeat(120) },
        errorInfo: { message: 'provider echo: ' + 'q'.repeat(120), stack: 'at fn' },
      };
      redactSpanPayload(span as never);
      expect(span.input.text).toContain('[redacted]');
      expect(span.output.text).toContain('[redacted]');
      expect(span.errorInfo.message).toContain('[redacted]');
      expect(span.errorInfo.stack).toBe('at fn');
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
