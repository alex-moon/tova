import { RequestContext } from '@mastra/core/request-context';
import { fetchUrlTool } from '../../main/services/mastraService';
import { muteConsoleError } from '../muteConsole';

// #340: fetch_url falls back to Firecrawl when the native fetch fails, and a
// long scraped page is saved to the library so read_file can read it in full.
jest.mock('../../main/services/webFetchService', () => ({
  fetchPage: jest.fn(),
  safeSlice: (text: string, max: number) => text.slice(0, max),
  MAX_FETCH_CHARS: 8000,
}));
jest.mock('../../main/services/firecrawlService', () => ({ firecrawlScrape: jest.fn() }));
jest.mock('../../main/services/systemAssetService', () => ({ createSystemAsset: jest.fn() }));

import { fetchPage } from '../../main/services/webFetchService';
import { firecrawlScrape } from '../../main/services/firecrawlService';
import { createSystemAsset } from '../../main/services/systemAssetService';
import { spacesWorkspaceStorage } from '../../main/services/workspaceStorage';

const mockedFetch = fetchPage as unknown as jest.Mock;
const mockedScrape = firecrawlScrape as unknown as jest.Mock;
const mockedCreate = createSystemAsset as unknown as jest.Mock;
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

const asCtx = (userId?: string, sessionId?: string) => {
  const requestContext = new RequestContext();
  if (userId) requestContext.set('userId', userId);
  if (sessionId) requestContext.set('sessionId', sessionId);
  return { requestContext };
};

const page = (content: string) => ({ url: 'https://example.com', title: 'Ex', content });

beforeEach(() => {
  jest.restoreAllMocks();
  mockedFetch.mockReset();
  mockedScrape.mockReset();
  mockedCreate.mockReset();
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
    mockedScrape.mockResolvedValue(page('short body'));
    const out = await fetchExecute({ url: 'https://example.com' }, asCtx('u1'));
    expect(out.content).toBe('short body');
    expect(out.fileId).toBeUndefined();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('saves a long scraped page and returns its fileId + a read_file note', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    jest.spyOn(spacesWorkspaceStorage, 'isConfigured').mockReturnValue(true);
    mockedFetch.mockRejectedValue(new Error('HTTP 419 fetching example.com'));
    mockedScrape.mockResolvedValue(page('x'.repeat(9000)));
    mockedCreate.mockResolvedValue({
      ok: true,
      fileId: 'file-1',
      filename: 'web-example.com-ex.md',
      size: 9000,
      createdAt: new Date(),
    });

    const out = await fetchExecute({ url: 'https://example.com' }, asCtx('u1', 's1'));

    expect(out.fileId).toBe('file-1');
    expect(out.content).toHaveLength(8000);
    expect(out.note).toContain('read_file');
    expect(mockedCreate).toHaveBeenCalledWith(
      'u1',
      expect.stringContaining('web-'),
      expect.any(Buffer),
      'text/markdown',
      { kind: 'chat', sessionId: 's1' },
    );
  });

  it('returns the head without a file when storage is unconfigured', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    jest.spyOn(spacesWorkspaceStorage, 'isConfigured').mockReturnValue(false);
    mockedFetch.mockRejectedValue(new Error('HTTP 419'));
    mockedScrape.mockResolvedValue(page('x'.repeat(9000)));
    const out = await fetchExecute({ url: 'https://example.com' }, asCtx('u1'));
    expect(out.fileId).toBeUndefined();
    expect(out.content).toHaveLength(8000);
  });

  it('does not fall back when the native fetch succeeds', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    mockedFetch.mockResolvedValue(page('native body'));
    const out = await fetchExecute({ url: 'https://example.com' }, asCtx('u1'));
    expect(out.content).toBe('native body');
    expect(mockedScrape).not.toHaveBeenCalled();
  });
});
