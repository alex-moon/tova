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
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCase = void 0;
const graders_1 = require("./graders");
/**
 * Streams the agent's answer for the case prompt; records tool calls in
 * order and accumulates `chunk.delta` into `finalText` so graders can run
 * the #158 text assertions (no-citation-without-search, explicit
 * no-sources refusal). `generate_file` content rides in the call's scalar
 * args, which is what `generatedContent` extracts for the `content_equals`
 * case; the assembled prompt is simply the caller's own message list.
 */
const runCase = (createStreamingCompletion, options, testCase) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, e_1, _b, _c;
    var _d, _e;
    const stream = yield createStreamingCompletion(options);
    if (!stream)
        throw new Error(`no connector for provider ${(_d = options.provider) !== null && _d !== void 0 ? _d : 'groq'}`);
    const toolCalls = [];
    let deltas = [];
    try {
        for (var _f = true, stream_1 = __asyncValues(stream), stream_1_1; stream_1_1 = yield stream_1.next(), _a = stream_1_1.done, !_a; _f = true) {
            _c = stream_1_1.value;
            _f = false;
            const chunk = _c;
            if (chunk.delta)
                deltas = [...deltas, chunk.delta];
            if (chunk.toolCall)
                toolCalls.push(Object.assign({ name: chunk.toolCall.name }, (chunk.toolCall.args ? { args: (0, graders_1.normalizeArgs)(chunk.toolCall.args) } : {})));
        }
    }
    catch (e_1_1) { e_1 = { error: e_1_1 }; }
    finally {
        try {
            if (!_f && !_a && (_b = stream_1.return)) yield _b.call(stream_1);
        }
        finally { if (e_1) throw e_1.error; }
    }
    const generateCall = toolCalls.find((call) => call.name === 'generate_file');
    const generatedContent = typeof ((_e = generateCall === null || generateCall === void 0 ? void 0 : generateCall.args) === null || _e === void 0 ? void 0 : _e.content) === 'string' ? generateCall.args.content : undefined;
    // #159 cases grade the assistant's final answer and possibly several
    // generated files, so both are captured alongside the tool calls.
    const generatedFiles = toolCalls
        .filter((call) => { var _a; return call.name === 'generate_file' && typeof ((_a = call.args) === null || _a === void 0 ? void 0 : _a.content) === 'string'; })
        .map((call) => {
        var _a, _b, _c, _d;
        return ({
            filename: String((_b = (_a = call.args) === null || _a === void 0 ? void 0 : _a.filename) !== null && _b !== void 0 ? _b : ''),
            content: String((_d = (_c = call.args) === null || _c === void 0 ? void 0 : _c.content) !== null && _d !== void 0 ? _d : ''),
        });
    });
    const finalText = deltas.join('');
    const run = Object.assign(Object.assign(Object.assign({ toolCalls, prompt: testCase.prompt }, (!finalText.trim() ? {} : { finalText, answer: finalText })), (!generatedFiles.length ? {} : { generatedFiles })), (generatedContent !== undefined ? { generatedContent } : {}));
    const evidence = toolCalls
        .map((call) => `${call.name}${call.args ? ` ${JSON.stringify(call.args).slice(0, 120)}` : ''}`)
        .join(' | ');
    return { run, evidence };
});
exports.runCase = runCase;
