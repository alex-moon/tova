"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.webSearch = void 0;
const logRedaction_1 = require("./logRedaction");
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const SEARCH_TIMEOUT_MS = 10000;
// Throws when the search call itself fails (HTTP error, network, bad JSON)
// so the caller — the `web_search` tool wrapper — can perform the graceful
// degradation (#82). A missing key or blank query is not a failure: those
// return [] as "no results". The chat turn must never fail because of the
// search provider; that guarantee now lives in the tool wrapper.
const webSearch = (query) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey)
        return [];
    // An empty query (malformed tool arguments fall back to '') would hit the
    // API pointlessly; treat it as "no results" without spending quota.
    if (!query.trim())
        return [];
    try {
        const response = yield fetch(`${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}`, {
            headers: {
                Accept: 'application/json',
                'X-Subscription-Token': apiKey,
            },
            signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        });
        if (!response.ok)
            throw new Error(`Brave search HTTP ${response.status}`);
        const data = yield response.json();
        const results = (_a = data === null || data === void 0 ? void 0 : data.web) === null || _a === void 0 ? void 0 : _a.results;
        if (!Array.isArray(results))
            return [];
        return results.flatMap((r) => {
            if (typeof r !== 'object' || r === null)
                return [];
            const { title, description, url } = r;
            if (typeof url !== 'string' || !url)
                return [];
            return [
                {
                    title: typeof title === 'string' ? title : '',
                    snippet: typeof description === 'string' ? description : '',
                    url,
                },
            ];
        });
    }
    catch (err) {
        // Rethrow (#82): the tool wrapper (not this service) performs the
        // graceful degradation — marking the tool failed and degrading to an
        // empty result with a descriptive error — so the turn still never
        // fails, but distinguishable from a genuinely-empty search.
        console.error('Web search error:', (0, logRedaction_1.redactForLog)(err));
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(message || 'Brave search failed');
    }
});
exports.webSearch = webSearch;
