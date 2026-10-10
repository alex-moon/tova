"use strict";
// Issue #145 audit: LangSmith trace payloads are a leak surface. The
// exporter (node_modules/@mastra/langsmith/dist/index.js) posts
// `span.input` / `span.output` / `span.errorInfo` verbatim — prompt content
// and retrieved chat text land in the LangSmith project. redactForLog()
// covers console emission only, so this module redacts the same policy at
// the trace transport: a subclass hook rewrites every exported span payload
// before it reaches RunTree.
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
exports.RedactedLangSmithExporter = exports.redactSpanPayload = exports.redactDeep = void 0;
const langsmith_1 = require("@mastra/langsmith");
const logRedaction_1 = require("./logRedaction");
const MAX_DEPTH = 6;
const MAX_STRING = 2000;
const redactDeep = (value, depth = 0) => {
    if (depth >= MAX_DEPTH)
        return '[depth-limit]';
    if (typeof value === 'string')
        return (0, logRedaction_1.redactString)(value.slice(0, MAX_STRING));
    if (Array.isArray(value))
        return value.slice(0, 50).map((item) => (0, exports.redactDeep)(item, depth + 1));
    if (typeof value === 'object' && value !== null) {
        for (const key of Object.keys(value)) {
            const source = value;
            source[key] = (0, exports.redactDeep)(source[key], depth + 1);
        }
        return value;
    }
    return value;
};
exports.redactDeep = redactDeep;
const redactSpanPayload = (span) => {
    const target = span;
    if (target.input !== undefined)
        target.input = (0, exports.redactDeep)(target.input);
    if (target.output !== undefined)
        target.output = (0, exports.redactDeep)(target.output);
    if (target.errorInfo) {
        if (typeof target.errorInfo.message === 'string') {
            target.errorInfo.message = (0, logRedaction_1.redactString)(target.errorInfo.message);
        }
        if (target.errorInfo.details)
            target.errorInfo.details = (0, exports.redactDeep)(target.errorInfo.details);
    }
    return span;
};
exports.redactSpanPayload = redactSpanPayload;
class RedactedLangSmithExporter extends langsmith_1.LangSmithExporter {
    _preExportTracingEvent(event) {
        const _super = Object.create(null, {
            _preExportTracingEvent: { get: () => super._preExportTracingEvent }
        });
        return __awaiter(this, void 0, void 0, function* () {
            const processed = yield _super._preExportTracingEvent.call(this, event);
            (0, exports.redactSpanPayload)(processed.exportedSpan);
            return processed;
        });
    }
}
exports.RedactedLangSmithExporter = RedactedLangSmithExporter;
