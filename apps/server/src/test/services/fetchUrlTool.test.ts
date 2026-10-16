import { RequestContext } from '@mastra/core/request-context';
import { fetchUrlTool } from '../../main/services/mastraService';
import { muteConsoleError } from '../muteConsole';

// #340: fetch_url falls back to Firecrawl when the native fetch fails, a long
// scraped page is saved agent-side so read_file can read it in full, and a
// fresh cached copy of a URL is reused instead of paying for a re-scrape.
jest.mock('../../main/services/webFetchService', () => ({
  fetchPage: jest.fn(),
  safeSlice: (text: string, max: number) => text.slice(0, max),
  MAX_FETCH_CHARS: 8000,
}));
jest.mock('../../main/services/firecrawlService', () => ({ firecrawlScrape: jest.fn() }));
jest.mock('../../main/services/systemAssetService', () => ({
  createSystemAsset: jest.fn(),
  createSystemSideAsset: jest.fn(),
  findFreshScrape: jest.fn(),
}));

import { fetchPage } from '../../main/services/webFetchService';
import { firecrawlScrape } from '../../main/services/firecrawlService';
import { createSystemSideAsset, findFreshScrape } from '../../main/services/systemAssetService';

const mockedFetch = fetchPage as unknown as jest.Mock;
const mockedScrape = firecrawlScrape as unknown as jest.Mock;
const mockedCreate = createSystemSideAsset as unknown as jest.Mock;
const mockedFind = findFreshScrape as unknown as jest.Mock;
const consoleErrorSpy = muteConsoleError();

const fetchExecute = (
  fetchUrlTool as unknown as {
    execute: (
      args: { url: string },
      ctx: unknown,
    ) => Promise<{
      content?: string;
      fileId?: string;
      note?: string;
      error?: string;
    }>;
  }
).execute;

const asCtx = (userId?: string, ids?: { sessionId?: string; taskId?: string }) => {
  const requestContext = new RequestContext();
  if (userId) requestContext.set('userId', userId);
  if (ids?.sessionId) requestContext.set('sessionId', ids.sessionId);
  if (ids?.taskId) requestContext.set('taskId', ids.taskId);
  return { requestContext };
};

const page = (content: string) => ({ url: 'https://example.com', title: 'Ex', content });

beforeEach(() => {
  jest.restoreAllMocks();
  mockedFetch.mockReset();
  mockedScrape.mockReset();
  mockedCreate.mockReset();
  mockedFind.mockReset();
  delete process.env.FIRECRAWL_API_KEY;
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
});

describe('fetch_url Firecrawl fallback (#340)', () => {
  it('stays native-only and degrades when no Firecrawl key is set', async () => {
    mockedFetch.mockRejectedValue(new Error('HTTP 419 fetching example.com'));
    const out = await fetchExecute({ url: 'https://example.com' }, asCtx('u1'));
    expect(out.error).toContain('419');
    expect(mockedScrape).not.toHaveBeenCalled();
  });

  it('falls back to Firecrawl and returns a short page inline (no file)', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    mockedFetch.mockRejectedValue(new Error('HTTP 419 fetching example.com'));
    mockedFind.mockResolvedValue(null);
    mockedScrape.mockResolvedValue(page('short body'));
    const out = await fetchExecute(
      { url: 'https://example.com' },
      asCtx('u1', { sessionId: 's1' }),
    );
    expect(out.content).toBe('short body');
    expect(out.fileId).toBeUndefined();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('saves a long scraped page agent-side and returns its fileId + honest note', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    const long = 'x'.repeat(9000);
    mockedFetch.mockRejectedValue(new Error('HTTP 419 fetching example.com'));
    mockedFind.mockResolvedValue(null);
    mockedScrape.mockResolvedValue(page(long));
    mockedCreate.mockResolvedValue({ fileId: 'file-1', filename: 'web-example.com-ex.md' });

    const out = await fetchExecute(
      { url: 'https://example.com' },
      asCtx('u1', { sessionId: 's1' }),
    );

    expect(out.fileId).toBe('file-1');
    expect(out.content).toHaveLength(8000);
    expect(out.note).toContain('tell the user');
    expect(out.note).toContain('read_file');
    expect(mockedCreate).toHaveBeenCalledWith(
      'u1',
      expect.stringContaining('web-'),
      long,
      { kind: 'chat', sessionId: 's1' },
      'https://example.com/',
    );
  });

  it('a ZDR turn (no session, no task) never persists a scrape', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    mockedFetch.mockRejectedValue(new Error('HTTP 419'));
    mockedFind.mockResolvedValue(null);
    mockedScrape.mockResolvedValue(page('x'.repeat(9000)));
    const out = await fetchExecute({ url: 'https://example.com' }, asCtx('u1'));
    expect(out.fileId).toBeUndefined();
    expect(out.content).toHaveLength(8000);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('attributes a task-origin scrape to the task (#298 provenance)', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    mockedFetch.mockRejectedValue(new Error('HTTP 419'));
    mockedFind.mockResolvedValue(null);
    mockedScrape.mockResolvedValue(page('x'.repeat(9000)));
    mockedCreate.mockResolvedValue({ fileId: 'file-2', filename: 'web-x.md' });
    await fetchExecute({ url: 'https://example.com' }, asCtx('u1', { taskId: 't1' }));
    expect(mockedCreate).toHaveBeenCalledWith(
      'u1',
      expect.any(String),
      expect.any(String),
      { kind: 'task', taskId: 't1' },
      'https://example.com/',
    );
  });

  it('reuses a fresh cached copy instead of re-scraping', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    mockedFetch.mockRejectedValue(new Error('HTTP 419 fetching example.com'));
    mockedFind.mockResolvedValue({
      fileId: 'cached-1',
      filename: 'web-example.com-ex.md',
      content: 'x'.repeat(9000),
    });
    const out = await fetchExecute(
      { url: 'https://example.com' },
      asCtx('u1', { sessionId: 's1' }),
    );
    expect(mockedScrape).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(out.fileId).toBe('cached-1');
    expect(out.note).toContain('read_file');
  });

  it('does not fall back when the native fetch succeeds', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    mockedFetch.mockResolvedValue(page('native body'));
    const out = await fetchExecute({ url: 'https://example.com' }, asCtx('u1'));
    expect(out.content).toBe('native body');
    expect(mockedScrape).not.toHaveBeenCalled();
    expect(mockedFind).not.toHaveBeenCalled();
  });
});
