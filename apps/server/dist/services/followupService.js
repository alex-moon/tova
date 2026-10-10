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
exports.parseSuggestions = exports.generateFollowups = void 0;
const logRedaction_1 = require("./logRedaction");
const inferenceService_1 = require("./inferenceService");
const config_1 = require("../config");
// #238: aux model source (was `ROUTER_GUARD_MODEL`), read lazily.
const suggestionModel = () => config_1.config.aux.model;
const SUGGESTION_PROMPT = 'Generate 2-3 very short follow-up questions the user might ask next, as a ' +
    'natural continuation of the conversation below. Reply with ONLY a JSON ' +
    'array of strings (max five words each), nothing else.';
const MAX_SUGGESTIONS = 3;
const generateFollowups = (userContent, assistantContent) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    const trimmed = `${userContent}\n\nAssistant replied:\n${assistantContent}`
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 1000);
    try {
        // Tool-free path (issue #41): with the Brave key set the default
        // completion route attaches web_search to every agent, and the
        // suggestion model rejects tool-carrying requests. Suggestions need no
        // search, so this call goes to a plain agent even when the key is set.
        const completion = yield inferenceService_1.inferenceService.createToolFreeCompletion({
            provider: config_1.config.aux.provider,
            model: suggestionModel(),
            messages: [
                { role: 'system', content: SUGGESTION_PROMPT },
                { role: 'user', content: trimmed },
            ],
            temperature: 0.5,
            max_tokens: 512,
        });
        const raw = (_c = (_b = (_a = completion.choices[0]) === null || _a === void 0 ? void 0 : _a.message) === null || _b === void 0 ? void 0 : _b.content) !== null && _c !== void 0 ? _c : '';
        return (0, exports.parseSuggestions)(raw);
    }
    catch (err) {
        console.error('Followup generation error:', (0, logRedaction_1.redactForLog)(err));
        return [];
    }
});
exports.generateFollowups = generateFollowups;
/*
 * Tolerant parser (issue #41): the suggestion model intermittently wraps a
 * usable list in prose (leading chatter, a Python-style set literal, or a
 * bulleted block). Rather than discarding the whole response on any
 * deviation, the strategies below salvage what they can in order; total
 * failure still degrades to [], as before.
 */
const parseSuggestions = (raw) => {
    // 1. Clean model output: the text itself is a JSON array string.
    // 2. The pre-#41 bracket slice `[`..`]` — cheap and usually sufficient.
    // 3. Any `[`..`]` span anywhere in the text (prose-wrapped arrays).
    for (const candidate of [raw, ...bracketSpans(raw)]) {
        try {
            const parsed = JSON.parse(candidate);
            if (!Array.isArray(parsed))
                continue;
            const items = parseList(parsed);
            if (items.length > 0)
                return items;
        }
        catch (_a) {
            // not this one — try the next candidate
        }
    }
    // 4. No bracketed array survived JSON parsing: fall back to reading the
    // raw response as a plain list (bulleted/numbered lines, a set literal,
    // newline- or semicolon-separated beats). Bullets, numbering and wrapping
    // punctuation are stripped before the shared array-item post-filters.
    // This path intentionally requires at least two survivors: a single line
    // is indistinguishable from unstructured prose, and emitting a random
    // sentence as a follow-up chip would be worse than emitting none.
    const fromLines = parseList(raw
        .split(/['"`\n;,]|\s\d+[.)]\s*|\s-\s/m)
        .map((part) => part
        .trim()
        .replace(/^[*•\-\s]+/, '')
        .replace(/^\d+[.)]\s*/, '')
        .replace(/^["'`[\]{}().]+|["'`[\]{}(),]+$/g, '')
        .trim())
        .filter((part) => part.length > 0));
    return fromLines.length >= 2 ? fromLines : [];
};
exports.parseSuggestions = parseSuggestions;
/*
 * Every `[` to matching-`]` span in the text, longest first. Nested arrays
 * are naturally covered: the outermost span parses, the inner ones don't.
 */
const bracketSpans = (text) => {
    const spans = [];
    for (let start = text.indexOf('['); start !== -1; start = text.indexOf('[', start + 1)) {
        for (let end = text.indexOf(']', start + 1); end !== -1; end = text.indexOf(']', end + 1)) {
            spans.push(text.slice(start, end + 1));
        }
    }
    return spans.sort((a, b) => b.length - a.length);
};
/*
 * Shared normalisation for array items (pre-#41 plus a wider quote class
 * and a duplicate guard — the lenient fallbacks make repeated model output
 * likelier, and duplicated chips are noise): trim, strip symmetric wrapping
 * quotes, keep non-empty phraselike strings, drop duplicates, cap the list.
 */
const parseList = (items) => Array.from(new Set(items
    .filter((s) => typeof s === 'string')
    .map((s) => s
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim())
    .filter((s) => s.length > 0 && s.length <= 60))).slice(0, MAX_SUGGESTIONS);
