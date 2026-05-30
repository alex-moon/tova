import { routeQuery } from './routerService';

describe('Router Service', () => {
  describe('Deterministic Routing', () => {
    it('should route short greetings to the smaller model', async () => {
      const result = await routeQuery('Hello');
      expect(result.model).toBe('llama3-8b-8192');
      expect(result.reason).toBe('deterministic-short');
    });

    it('should route requests for code to the larger model', async () => {
      const result = await routeQuery('Write a Python function to sort a list');
      expect(result.model).toBe('llama3-70b-8192');
      expect(result.reason).toBe('deterministic-code');
    });

    it('should route complex queries to the classifier', async () => {
      // For now, we'll mock the classifier or just check that it falls through
      // In a real test, we might want to mock the Groq API call
    });
  });
});
