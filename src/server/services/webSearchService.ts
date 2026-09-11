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
  // The canonical name is BRAVE_API_KEY (.env.example), but this environment
  // exposes the key as BRAVE_SEARCH_API_KEY; accept both so the tool is not
  // silently disabled by a naming mismatch (issue #16, open question 2).
  const apiKey = process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return [];
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
