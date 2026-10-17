import { redactForLog } from './logRedaction';
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const SEARCH_TIMEOUT_MS = 10_000;

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

// Throws when the search call itself fails so the tool wrapper owns graceful degradation; a missing key or blank query returns [] as "no results".
// @see #82
export const webSearch = async (query: string): Promise<SearchResult[]> => {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return [];
  // An empty query would hit the API pointlessly; treat it as "no results" without spending quota.
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
    // Rethrow: the tool wrapper performs the degradation, so the turn never fails but the failure stays distinguishable from a genuinely-empty search.
    // @see #82
    console.error('Web search error:', redactForLog(err));
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message || 'Brave search failed');
  }
};
