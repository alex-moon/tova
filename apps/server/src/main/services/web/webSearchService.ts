import { redactForLog } from '../logRedaction';
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const SEARCH_TIMEOUT_MS = 10_000;

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

// Throws on search failure so the wrapper degrades; no key/blank = [].
// @see #82
export const webSearch = async (query: string): Promise<SearchResult[]> => {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return [];
  // An empty query would hit the API pointlessly; treat as none.
  if (!query.trim()) return [];
  try {
    const response = await fetch(`${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}`, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Brave search HTTP ${response.status}`);
    const data = await response.json();
    const results = data?.web?.results;
    if (!Array.isArray(results)) return [];
    return results.flatMap((r) => {
      if (typeof r !== 'object' || r === null) return [];
      const { title, description, url } = r;
      if (typeof url !== 'string' || !url) return [];
      return [
        {
          title: typeof title === 'string' ? title : '',
          snippet: typeof description === 'string' ? description : '',
          url,
        },
      ];
    });
  } catch (err) {
    // Rethrow: the wrapper degrades; the failure stays distinguishable.
    // @see #82
    console.error('Web search error:', redactForLog(err));
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message || 'Brave search failed');
  }
};
