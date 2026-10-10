"use strict";
/*
 * #213: provider error classification shared by the racing runtime
 * (`racingService.ts`, via `modelFailover.ts`) and the diagnostics tally
 * (`modelErrorTally.ts`).
 *
 * Kept in a leaf module (no service imports) so both callers can use it
 * without an import cycle: `modelErrorTally` → `inferenceService` is already
 * reached from `racingService` via `inferenceService`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isOverloadError = void 0;
/*
 * Endpoint overload is a *per-endpoint transient* failure, distinct from an
 * account rate limit even though both can arrive as HTTP 429. DeepInfra
 * reports it as `code: "engine_overloaded"` / "Model busy, retry later" in the
 * response body.
 *
 * Detection is body-first (AI-SDK `APICallError` exposes the parsed body as
 * `data` and/or `responseBody`), then a narrow message fallback for the
 * Mastra-wrapped error shape observed in the ticket. The message set is
 * deliberately small: "rate limit" / TPM / RPM wording must never match here.
 */
const providerErrorCode = (err) => {
    var _a, _b, _c;
    const carrier = err;
    const fromData = (_b = (_a = carrier === null || carrier === void 0 ? void 0 : carrier.data) === null || _a === void 0 ? void 0 : _a.error) === null || _b === void 0 ? void 0 : _b.code;
    if (typeof fromData === 'string')
        return fromData;
    const body = carrier === null || carrier === void 0 ? void 0 : carrier.responseBody;
    const raw = typeof body === 'string' ? body : body ? JSON.stringify(body) : '';
    const match = /"code"\s*:\s*"([^"]+)"/.exec(raw);
    return (_c = match === null || match === void 0 ? void 0 : match[1]) !== null && _c !== void 0 ? _c : '';
};
const isOverloadError = (err) => {
    if (providerErrorCode(err).toLowerCase() === 'engine_overloaded')
        return true;
    const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    return /engine[ _-]?overloaded|model busy,? retry later|\boverloaded\b/i.test(message);
};
exports.isOverloadError = isOverloadError;
