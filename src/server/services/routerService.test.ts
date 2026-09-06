import { routeQuery } from './routerService';

const mockCreate = jest.fn();

jest.mock('groq-sdk', () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: (...args: unknown[]) => mockCreate(...args),
      },
    },
  }));
});

type Routing = Awaited<ReturnType<typeof routeQuery>>;

const classifyAs = (content: string, error = false) => {
  mockCreate.mockReset();
  if (error) {
    mockCreate.mockRejectedValueOnce(new Error('classifier down'));
  } else {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content } }],
    });
  }
};

describe('Router Service', () => {
  describe('Deterministic Routing', () => {
    it('should route short greetings to the smaller model', async () => {
      const result = await routeQuery('Hello');
      expect(result.model).toBe('llama3-8b-8192');
      expect(result.reason).toBe('deterministic-short');
    });

    it('should recognize other greeting/confirmation variants', async () => {
      for (const query of ['Hey', 'thanks', 'OK', 'Yes, do it', 'thank you']) {
        const result = await routeQuery(query);
        expect(result.reason).toBe('deterministic-short');
      }
    });

    it('should route requests for code to the larger model', async () => {
      const result = await routeQuery('Write a Python function to sort a list');
      expect(result.model).toBe('llama3-70b-8192');
      expect(result.reason).toBe('deterministic-code');
    });

    it('should match code keywords case-insensitively', async () => {
      const result = await routeQuery('Help me write a SCRIPT');
      expect(result.reason).toBe('deterministic-code');
    });

    it('should route fenced code blocks to the larger model', async () => {
      const result = await routeQuery('What does this do?\n```js\nconsole.log(1);\n```');
      expect(result.reason).toBe('deterministic-code');
    });

    it('should not treat a long greeting as a deterministic rule', async () => {
      classifyAs('simple');
      const result = await routeQuery('Hello there, how are you doing today?');
      // Longer than 20 chars: falls through to the classifier.
      expect(result.reason).toBe('classifier-simple');
    });

    it('should send a short non-greeting query to the classifier', async () => {
      classifyAs('simple');
      const result = await routeQuery('2 + 2');
      expect(result.reason).toBe('classifier-simple');
    });
  });

  describe('Classifier Routing', () => {
    it('should route queries classified as complex to the larger model', async () => {
      classifyAs('complex');
      const result = await routeQuery(
        'Explain the tradeoffs of event sourcing in distributed systems',
      );
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ model: 'llama3-70b-8192', reason: 'classifier-complex' });
    });

    it('should route queries classified as simple to the smaller model', async () => {
      classifyAs('simple');
      const result = await routeQuery('Give me a one-line haiku about rain');
      expect(result).toEqual({ model: 'llama3-8b-8192', reason: 'classifier-simple' });
    });

    it('should normalize classifier output when deciding', async () => {
      classifyAs('  COMPLEX\n  ');
      const result = await routeQuery('Advise a go-to-market plan for a new SaaS product');
      expect(result.reason).toBe('classifier-complex');
    });

    it('should fall back to the larger model when the classifier errors', async () => {
      classifyAs('', true);
      const result = await routeQuery('Should I buy this car or that car?');
      expect(result).toEqual({ model: 'llama3-70b-8192', reason: 'classifier-error' });
    });

    it('should fall back to the smaller model on an unrecognized classification', async () => {
      classifyAs('unsure');
      const result = await routeQuery('Tell me about classic cars');
      expect(result).toEqual({ model: 'llama3-8b-8192', reason: 'classifier-simple' });
    });

    it('sends the query to the classifier with a strict system prompt', async () => {
      classifyAs('simple');
      await routeQuery('Give me investment advice');
      const [call] = mockCreate.mock.calls[0] as unknown as [
        { model: string; temperature: number; messages: { role: string; content: string }[] },
      ];
      expect(call.model).toBe('llama3-8b-8192');
      expect(call.temperature).toBe(0);
      expect(call.messages[0].role).toBe('system');
      expect(call.messages[0].content).toMatch(/simple|complex/i);
    });
  });

  describe('Routing metadata contract', () => {
    it('always returns a model and a human-readable reason', async () => {
      const cases: Promise<Routing>[] = [
        routeQuery('Hello'),
        routeQuery('write code'),
        (async () => {
          classifyAs('complex');
          return routeQuery('Design a caching strategy');
        })(),
        (async () => {
          classifyAs('', true);
          return routeQuery('Pick a color for me out of two options');
        })(),
      ];
      const results = await Promise.all(cases);
      for (const { model, reason } of results) {
        expect(model).toMatch(/^llama3-(8b|70b)-8192$/);
        expect(typeof reason).toBe('string');
        expect(reason.length).toBeGreaterThan(0);
      }
    });
  });
});
