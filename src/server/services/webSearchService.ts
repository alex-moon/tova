const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const SEARCH_TIMEOUT_MS = 10_000;

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

// Returns [] when the tool is unavailable or the search fails: callers treat
// an empty list as "tool unavailable" and the chat turn must never fail
// because of the search provider.
export const webSearch = async (query: string): Promise<SearchResult[]> => {
  // Canonical name per owner decision on issue #16 is BRAVE_SEARCH_API_KEY;
  // BRAVE_API_KEY is still accepted (read first) for forward compatibility
  // with pre-rename environments, pinned by a unit test.
  const apiKey = process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return [];
  // An empty query (malformed tool arguments fall back to '') would hit the
  // API pointlessly; treat it as "no results" without spending quota.
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
    console.error('Web search error:', err);
    return [];
  }
};
