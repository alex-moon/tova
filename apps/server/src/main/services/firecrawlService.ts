import { config } from '../config';
import { assertSafeUrl } from './safeLinkService';
import { assertPublicHost, type FetchedPage } from './webFetchService';

/* Firecrawl fallback for `fetch_url`; key-gated, Firecrawl resolves DNS. */
// @see #340 #113

const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v2/scrape';
const FIRECRAWL_TIMEOUT_MS = 30_000;

interface FirecrawlResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    metadata?: { title?: string; sourceURL?: string; statusCode?: number };
  };
}

// Scrape a URL to markdown; throws so the tool wrapper can degrade gracefully.
// @see #82
export const firecrawlScrape = async (url: string): Promise<FetchedPage | null> => {
  const apiKey = config.firecrawl.apiKey;
  if (!apiKey) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported URL scheme: ${parsed.protocol}`);
  }
  await assertPublicHost(parsed.hostname);
  await assertSafeUrl(parsed.toString());

  const response = await fetch(FIRECRAWL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      url: parsed.toString(),
      formats: ['markdown'],
      onlyMainContent: true,
    }),
    signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`firecrawl request failed: ${message}`);
  });
  if (!response.ok) {
    throw new Error(`firecrawl HTTP ${response.status} scraping ${parsed.hostname}`);
  }

  let payload: FirecrawlResponse;
  try {
    payload = (await response.json()) as FirecrawlResponse;
  } catch {
    throw new Error(`firecrawl returned invalid JSON for ${parsed.hostname}`);
  }
  const markdown = payload.data?.markdown?.trim();
  if (!markdown) throw new Error(`firecrawl returned no markdown for ${parsed.hostname}`);

  const metadata = payload.data?.metadata ?? {};
  const title = (metadata.title ?? '').trim() || parsed.hostname;
  return {
    url: metadata.sourceURL || parsed.toString(),
    title: title.slice(0, 300),
    content: markdown,
  };
};
