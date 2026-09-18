import { RequestContext } from '@mastra/core/request-context';
import { webSearchTool } from './mastraService';
import {
  degradedToolError,
  markToolFailed,
  reasonFrom,
  toolDegradeReason,
  toolIsFailed,
} from './toolDegrade';
import { muteConsoleError } from '../test/muteConsole';

jest.mock('./webSearchService', () => ({
  webSearch: jest.fn(),
}));

import { webSearch } from './webSearchService';

const mockedSearch = webSearch as unknown as jest.Mock;
const consoleErrorSpy = muteConsoleError();

const asCtx = (userId?: string) => {
  const requestContext = new RequestContext();
  if (userId) requestContext.set('userId', userId);
  return { requestContext };
};

const searchExecute = (
  webSearchTool as unknown as {
    execute: (args: { query: string }, ctx: unknown) => Promise<unknown>;
  }
).execute;

afterAll(() => {
  consoleErrorSpy.mockRestore();
});

describe('toolDegrade helpers (#82)', () => {
  it('marks a tool failed scoped to one context, not another', () => {
    const ctxA = asCtx();
    markToolFailed(ctxA, 'mcp_set/tool');
    expect(toolIsFailed(ctxA, 'mcp_set/tool')).toBe(true);
    // A fresh RequestContext (fresh completion) has not seen the failure: no
    // session-long leakage, which mirrors the per-completion scope.
    expect(toolIsFailed(asCtx(), 'mcp_set/tool')).toBe(false);
  });

  it('tolerates a null or contextless call-site', () => {
    expect(() => markToolFailed(null, 'x')).not.toThrow();
    expect(toolIsFailed(null, 'x')).toBe(false);
    expect(toolIsFailed({}, 'x')).toBe(false);
    expect(toolIsFailed({ requestContext: new RequestContext() }, 'x')).toBe(false);
  });

  it('marks twice idempotently via the lazily-created shared map', () => {
    const ctx = asCtx();
    markToolFailed(ctx, 'a', 'boom');
    markToolFailed(ctx, 'a'); // re-marking keeps the earliest (first) reason
    const map = ctx.requestContext.get('toolFailures') as Map<string, string>;
    expect([...map.entries()]).toEqual([['a', 'boom']]);
  });

  it('reports the remembered reason on a short-circuited retry', () => {
    const ctx = asCtx();
    markToolFailed(ctx, 'web_search', 'offline');
    expect(toolIsFailed(ctx, 'web_search')).toBe(true);
    expect(toolDegradeReason(ctx, 'web_search')).toBe('offline');
    expect(toolDegradeReason(ctx, 'other')).toBe('reason unknown');
  });

  it('builds the model-facing degraded text with reason and instruction', () => {
    expect(degradedToolError('web_search', 'Brave search HTTP 429')).toBe(
      'Tool web_search failed to run: Brave search HTTP 429. It is unavailable ' +
        'for the rest of this completion — tell the user you tried to use it ' +
        'but it could not be used.',
    );
    expect(degradedToolError('x')).toContain('(reason unknown)');
  });

  it('collapses whitespace, truncates long reasons, and handles empty ones', () => {
    expect(reasonFrom(new Error('a\n\t b   c'))).toBe('a b c');
    expect(reasonFrom(new Error('   '))).toBe('reason unknown');
    expect(reasonFrom(undefined)).toBe('reason unknown');
    expect(reasonFrom(new Error(`${'y'.repeat(300)} tail HTTP 500`)).length).toBe(255);
    expect(reasonFrom(new Error(`${'y'.repeat(300)} tail HTTP 500`))).not.toMatch(/HTTP 500/);
  });
});

describe('web_search tool degradation (#82)', () => {
  beforeEach(() => {
    mockedSearch.mockReset();
  });

  it('degrades a failing search with a descriptive error and marks the tool failed', async () => {
    mockedSearch.mockRejectedValue(new Error('offline'));
    const ctx = asCtx();
    const first = (await searchExecute({ query: 'q' }, ctx)) as {
      results: unknown[];
      error?: string;
    };
    expect(first.results).toEqual([]);
    expect(first.error).toContain('web_search');
    expect(first.error).toContain('offline');
    expect(first.error).toContain('tell the user');
    expect(toolIsFailed(ctx, 'web_search')).toBe(true);
  });

  it('short-circuits the rest of the completion once marked failed', async () => {
    mockedSearch.mockRejectedValue(new Error('offline'));
    const ctx = asCtx();
    await searchExecute({ query: 'q' }, ctx);
    expect(mockedSearch).toHaveBeenCalledTimes(1);
    const second = (await searchExecute({ query: 'again' }, ctx)) as { error?: string };
    expect(mockedSearch).toHaveBeenCalledTimes(1); // no second Brave call
    expect(second.error).toContain('web_search');
  });

  it('does not mark or add an error to a successful or genuinely-empty search', async () => {
    mockedSearch.mockResolvedValue([{ title: 't', snippet: 's', url: 'u' }]);
    const ctx = asCtx();
    expect(await searchExecute({ query: 'q' }, ctx)).toEqual({
      results: [{ title: 't', snippet: 's', url: 'u' }],
    });
    expect(toolIsFailed(ctx, 'web_search')).toBe(false);
    mockedSearch.mockResolvedValue([]);
    expect(await searchExecute({ query: 'q2' }, ctx)).toEqual({ results: [] });
    expect(toolIsFailed(ctx, 'web_search')).toBe(false);
  });
});
