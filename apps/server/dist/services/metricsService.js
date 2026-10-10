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
exports.isTriviallyNeutral = exports.classifyAndPersistPromptDimensions = exports.classifyPromptDimensions = exports.parseLlmFlags = void 0;
const logRedaction_1 = require("./logRedaction");
const Message_1 = require("../models/Message");
const inferenceService_1 = require("./inferenceService");
const promptMetrics_1 = require("./promptMetrics");
const config_1 = require("../config");
// #238: aux model source (was `ROUTER_GUARD_MODEL`), read lazily.
const llmModel = () => config_1.config.aux.model;
const LLM_PROMPT = 'Classify the user prompt below. Reply with ONLY one JSON object and nothing else, ' +
    'with exactly these keys: {"emotional": true|false, "technical": true|false, ' +
    '"abstract": true|false, "sentiment": "positive"|"negative"|"neutral", "openEnded": true|false}. ' +
    '"emotional": the prompt is about feelings or personal life rather than a task. ' +
    '"technical": the prompt uses engineering or domain jargon. ' +
    '"abstract": the prompt is strategic/high-level rather than a concrete step-by-step task. ' +
    '"sentiment": the overall tone of the prompt. ' +
    '"openEnded": true if it invites an open discussion, false if it is a one-shot task.';
const NULL_LLM = {
    emotional: null,
    technical: null,
    abstract: null,
    sentiment: null,
    openEnded: null,
};
const SENTIMENTS = new Set(['positive', 'negative', 'neutral']);
const asBoolean = (value) => (typeof value === 'boolean' ? value : null);
// Extract the first JSON-looking object from raw model output, tolerating
// markdown fences and surrounding prose. Returns null on any failure.
const parseLlmFlags = (raw) => {
    if (!raw)
        return NULL_LLM;
    const text = raw.replace(/```[a-z]*/gi, '');
    let start = text.indexOf('{');
    while (start !== -1) {
        // Extend from this '{' to successive '}' until a chunk parses; this
        // recovers output where the object sits between prose or trailing text.
        for (let end = text.indexOf('}', start); end !== -1; end = text.indexOf('}', end + 1)) {
            try {
                const obj = JSON.parse(text.slice(start, end + 1));
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    const parsed = {
                        emotional: asBoolean(obj.emotional),
                        technical: asBoolean(obj.technical),
                        abstract: asBoolean(obj.abstract),
                        sentiment: typeof obj.sentiment === 'string' &&
                            SENTIMENTS.has(obj.sentiment.trim().toLowerCase())
                            ? obj.sentiment.trim().toLowerCase()
                            : null,
                        openEnded: asBoolean(obj.openEnded),
                    };
                    // A *different* JSON object (prose example, deduped content) may
                    // parse before the real flags; a decoy carries none of the
                    // expected keys. Restart scanning after it so a decoy followed by
                    // the real flags is not misread as all-nulls.
                    if (parsed.emotional === null &&
                        parsed.technical === null &&
                        parsed.abstract === null &&
                        parsed.sentiment === null &&
                        parsed.openEnded === null) {
                        break;
                    }
                    return parsed;
                }
            }
            catch (_a) {
                // keep extending
            }
        }
        start = text.indexOf('{', start + 1);
    }
    return NULL_LLM;
};
exports.parseLlmFlags = parseLlmFlags;
const isAllNullLlm = (llm) => llm.emotional === null &&
    llm.technical === null &&
    llm.abstract === null &&
    llm.sentiment === null &&
    llm.openEnded === null;
// Classify a prompt and report why flags could be missing when they are:
// 'parse' means the call succeeded but produced unusable output, 'error'
// means the inference call itself failed. Null when flags were parsed.
const classifyPromptDimensions = (content) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    try {
        // #77: tool-free agent — same rationale as the guard classifier
        // (tool-rejecting small models, issue #41).
        const completion = yield inferenceService_1.inferenceService.createToolFreeCompletion({
            provider: config_1.config.aux.provider,
            model: llmModel(),
            messages: [{ role: 'user', content: `${LLM_PROMPT}\n\nPrompt: ${content.trim()}` }],
            temperature: 0,
            max_tokens: 100,
        });
        const llm = (0, exports.parseLlmFlags)((_c = (_b = (_a = completion === null || completion === void 0 ? void 0 : completion.choices) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.message) === null || _c === void 0 ? void 0 : _c.content);
        return { llm, skipReason: isAllNullLlm(llm) ? 'parse' : null };
    }
    catch (err) {
        console.error('Prompt classification error:', (0, logRedaction_1.redactForLog)(err));
        return { llm: NULL_LLM, skipReason: 'error' };
    }
});
exports.classifyPromptDimensions = classifyPromptDimensions;
// Classify a user message and persist the flags into its metrics subdocument.
// Never throws for classification problems; only a failed DB update rejects,
// and callers keep that non-fatal for the chat request. `metrics.llmSkipReason`
// records why the flags are null when they are ('parse' or 'error');
// 'trivial' is set by the chat routes for prompts that skip the call entirely.
// Clearing the reason on success keeps a retried message's audit trail accurate.
const classifyAndPersistPromptDimensions = (messageId, content) => __awaiter(void 0, void 0, void 0, function* () {
    const { llm, skipReason } = yield (0, exports.classifyPromptDimensions)(content);
    yield Message_1.Message.findByIdAndUpdate(messageId, {
        $set: { 'metrics.llm': llm, 'metrics.llmSkipReason': skipReason },
    });
});
exports.classifyAndPersistPromptDimensions = classifyAndPersistPromptDimensions;
/*
 * Trivial-prompt skip gate (plan task 9): prompts that are, with confidence,
 * meaningfully neutral on every LLM dimension — short greetings,
 * confirmations, "please continue"-style continuations — skip the
 * classification call entirely. Not a bare regex/allowlist: a phrase list
 * alone misses "yeah sure" — a neutral-token rule covers those — and both
 * paths are bounded (word count, no question mark, no code) and fail
 * closed: anything the heuristic is unsure about still gets classified.
 */
const TRIVIAL_MAX_WORDS = 6;
const TRIVIAL_TOKEN_ONLY_MAX_WORDS = 3;
// Full-message phrases (after lower-casing and punctuation stripping) that
// are neutral on all five flags with essentially no information content.
const TRIVIAL_PHRASES = new Set([
    'yes',
    'no',
    'ok',
    'okay',
    'ok thanks',
    'ok thank you',
    'thank you',
    'thanks',
    'thank you so much',
    'thanks so much',
    'yeah',
    'yep',
    'nope',
    'sure',
    'sure thing',
    'sounds good',
    'sounds great',
    'great',
    'nice',
    'perfect',
    'awesome',
    'cool',
    'got it',
    'gotcha',
    'understood',
    'continue',
    'please continue',
    'go on',
    'go ahead',
    'keep going',
    'tell me more',
    'do it',
    'do that',
    'do so',
    'that works',
    'that sounds good',
    'sounds great to me',
]);
// Tokens that can only appear in a bare confirmation/continuation. Any word
// outside this set makes the prompt fail closed (i.e. get classified).
const TRIVIAL_TOKENS = new Set([
    'yes',
    'yeah',
    'yep',
    'yup',
    'no',
    'nope',
    'ok',
    'okay',
    'sure',
    'fine',
    'cool',
    'great',
    'good',
    'nice',
    'perfect',
    'awesome',
    'thanks',
    'thank',
    'you',
    'please',
    'continue',
    'go',
    'on',
    'ahead',
    'keep',
    'tell',
    'me',
    'more',
    'got',
    'it',
    'i',
    'see',
    'sounds',
    'that',
    'so',
    'do',
    'and',
    'the',
    'my',
    'a',
    'is',
    'right',
    'roger',
    'will',
    'works',
    'understood',
]);
const normalizeForTrivialMatch = (text) => (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
// True only when the heuristic is confident; unconfident input returns false
// (fail closed) so it still gets classified.
const isTriviallyNeutral = (content) => {
    const metrics = (0, promptMetrics_1.computeDeterministicMetrics)(content);
    if (metrics.hasQuestionMark)
        return false;
    const { codeIndicators } = metrics;
    if (codeIndicators.fences > 0 ||
        codeIndicators.backticks > 0 ||
        codeIndicators.codeTokenCount > 0)
        return false;
    if (metrics.wordCount === 0 || metrics.wordCount > TRIVIAL_MAX_WORDS)
        return false;
    const normalized = normalizeForTrivialMatch(content);
    if (TRIVIAL_PHRASES.has(normalized))
        return true;
    // Generic short-confirmation rule: a very short prompt made entirely of
    // neutral tokens ("yeah sure", "ok thanks", "tell me more").
    if (metrics.wordCount <= TRIVIAL_TOKEN_ONLY_MAX_WORDS) {
        const words = normalized.split(' ');
        if (words.length > 0 && words.every((w) => TRIVIAL_TOKENS.has(w)))
            return true;
    }
    return false;
};
exports.isTriviallyNeutral = isTriviallyNeutral;
