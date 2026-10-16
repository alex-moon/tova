import { config } from '../config';
import { assertSafeUrl } from './safeLinkService';
import { assertPublicHost, type FetchedPage } from './webFetchService';

// #340: Firecrawl fallback for the `fetch_url` tool. A plain fetch (issue
// #113) cannot run JavaScript or present a full browser fingerprint, so
// JS-rendered pages and WAF/anti-bot challenges (Cloudflare, HTTP 419) reject
// it. Firecrawl's hosted scraper handles both and returns clean markdown.
// Key-gated like web_search: with no key the tool stays native-only.
//
// Trust boundary: Firecrawl fetches server-side and resolves DNS itself, so
// Tova's SSRF guard cannot bind it the way it binds the native fetch. We still
// run the same scheme check, `assertPublicHost` (DNS/private-IP refusal) and
// `assertSafeUrl` (Safe Browsing) before handing the URL over — that screens
// the obvious cases but is weaker than the native guard (documented, not
// silently accepted).

const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v2/scrape';
const FIRECRAWL_TIMEOUT_MS = 30_000;

interface FirecrawlResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    metadata?: { title?: string; sourceURL?: string; statusCode?: number };
  };
}

// Scrape a URL to full markdown. Throws on bad scheme, SSRF/safe-link refusal,
// provider/network error, non-2xx, or empty markdown, so the tool wrapper owns
// graceful degradation (#82). Returns null when no key is configured.
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
