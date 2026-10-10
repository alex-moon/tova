"use strict";
// Issue #145: shared redaction for log emission. Chat-route errors and
// extraction/classification failures can embed prompt content or extracted
// user text (e.g. a provider error echoing the request body). There is no
// central choke point — logService.attachConsoleCapture() mirrors console.*
// verbatim into the admin buffer — so call sites must redact before they
// pass anything risky to console.*.
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactForLog = exports.redactString = exports.REDACTED = void 0;
// Policy note: this is the conservative heuristic (option b, plan-145).
// It targets long/high-entropy segments, quoted request bodies, and JSON
// blocks; short message tokens (status codes, errno classes, file paths)
// survive. Whether it is sufficient for short personal content is an open
// audit question — see docs/plan-145-log-redaction.md.
exports.REDACTED = '[redacted]';
const MAX_STACK = 2000;
const isRecord = (v) => typeof v === 'object' && v !== null;
/**
 * Redact user-shaped content from a single string: quoted strings that are
 * long enough to be payload text, JSON-esque blocks, and long token
 * sequences without spaces (high-entropy fragments, embedded bodies).
 */
const redactString = (text) => {
    if (!text)
        return text;
    let out = text;
    // JSON-ish objects/arrays spanning >= 40 chars (includes quoted request
    // bodies embedded by provider errors via stringify)
    out = out.replace(/[{[][\s\S]{40,}[}\]]/g, exports.REDACTED);
    // Double-quoted payload text (>= 16 chars) — covers embedded prompt
    // fragments in single-line provider messages
    out = out.replace(/"((?:\\.|[^"]){16,})"/g, `"${exports.REDACTED}"`);
    // Single-quoted payload text, but only when the opening quote is not a
    // word-internal apostrophe: contractions/possessives ("doesn't", "user's")
    // would otherwise be matched as pairs and corrupt ordinary prose.
    out = out.replace(/(?<![\w'])'((?:\\.|[^']){16,})'/g, `'${exports.REDACTED}'`);
    // Secret-shaped assignments (apikey=..., bearer token=...) — short values
    // survive the whitespace-free threshold, so they need a dedicated rule.
    out = out.replace(/((?:api[_-]?key|token|secret|password|authorization|bearer)["'\s:=]+\s*)(["']?)[\w./+-]{8,}\2/gi, `$1$2${exports.REDACTED}$2`);
    // Long whitespace-free runs — UUIDs/b64/keys/system dumps
    out = out.replace(/[^\s'"{}[\]]{64,}/g, exports.REDACTED);
    // Catch-all: any remaining single-line run of >= 64 chars is treated as
    // embedded prose (provider echo of prompt text). Deliberately aggressive:
    // the conservative direction is over-redaction (plan-145 open question).
    out = out.replace(/[^\n\r]{64,}/g, exports.REDACTED);
    return out;
};
exports.redactString = redactString;
/** Serialize an unknown value to inspectable text without throwing. */
const serialize = (value) => {
    var _a;
    try {
        return (_a = JSON.stringify(value, (_key, v) => (isRecord(v) ? v : String(v)), 2)) !== null && _a !== void 0 ? _a : String(value);
    }
    catch (_b) {
        return Object.prototype.toString.call(value);
    }
};
const redactErrorBody = (body) => {
    const parts = [];
    if (body.name)
        parts.push(body.name);
    if (typeof body.message === 'string') {
        const msg = (0, exports.redactString)(body.message);
        if (msg)
            parts.push(msg);
    }
    else if (body.message) {
        parts.push((0, exports.redactString)(serialize(body.message)));
    }
    if (typeof body.stack === 'string') {
        // Stack frames are code-controlled (paths + line numbers); keep
        // verbatim except for the mirrored message already redacted above.
        // Clip the whole path anyway: raw stack text can embed message text
        // in the first line, which the message-level pass may have missed.
        const firstNewline = body.stack.indexOf('\n');
        if (firstNewline !== -1) {
            const frames = body.stack
                .slice(firstNewline + 1)
                .slice(0, MAX_STACK)
                .trimEnd();
            if (frames)
                parts.push(`\n${frames}`);
        }
    }
    if (body.code)
        parts.push(`code: ${body.code}`);
    return parts.join(': ');
};
/**
 * Format an unknown argued-to-console value into a string safe for
 * console.error: message text redacted, error shape (name, frames, short
 * status/class tokens) kept.
 */
const redactForLog = (value) => {
    if (value === null || value === undefined)
        return String(value);
    if (typeof value === 'string')
        return (0, exports.redactString)(value);
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    if (isRecord(value)) {
        if (value instanceof Error || (typeof value.stack === 'string' && 'message' in value)) {
            return redactErrorBody(value);
        }
        return (0, exports.redactString)(serialize(value));
    }
    return (0, exports.redactString)(String(value));
};
exports.redactForLog = redactForLog;
