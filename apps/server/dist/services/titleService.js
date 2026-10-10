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
exports.generateChatTitle = void 0;
const logRedaction_1 = require("./logRedaction");
const inferenceService_1 = require("./inferenceService");
const config_1 = require("../config");
// #238: aux model source (was `ROUTER_SMALL_MODEL`). Read lazily so tests that
// mutate the env after import still see it (config's stated contract).
const titleModel = () => config_1.config.aux.model;
const TITLE_PROMPT = 'Generate a short chat title (at most six words) summarising what the user asks about. ' +
    'Reply with only the title, no quotes, punctuation, or prefix.';
const generateChatTitle = (content) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    const trimmed = content.replace(/\s+/g, ' ').trim();
    const fallback = `${trimmed.substring(0, 30)}${trimmed.length > 30 ? '…' : ''}`;
    try {
        const completion = yield inferenceService_1.inferenceService.createToolFreeCompletion({
            provider: config_1.config.aux.provider,
            model: titleModel(),
            messages: [
                { role: 'system', content: TITLE_PROMPT },
                { role: 'user', content: trimmed },
            ],
            temperature: 0.3,
            // Reasoning models (e.g. `openai/gpt-oss-20b`) spend hidden reasoning
            // tokens from this budget before any title text; 30 was exhausted for
            // every call in live smoke (#4 task 6b). The title text itself only
            // needs ~20 tokens; the rest must absorb the reasoning phase.
            max_tokens: 512,
        });
        const title = (_c = (_b = (_a = completion.choices[0]) === null || _a === void 0 ? void 0 : _a.message) === null || _b === void 0 ? void 0 : _b.content) === null || _c === void 0 ? void 0 : _c.trim().replace(/^["'“”]+|["'“”]+$/g, '');
        if (!title)
            return fallback;
        return title.length > 60 ? `${title.substring(0, 60)}…` : title;
    }
    catch (err) {
        console.error('Title generation error:', (0, logRedaction_1.redactForLog)(err));
        return fallback;
    }
});
exports.generateChatTitle = generateChatTitle;
