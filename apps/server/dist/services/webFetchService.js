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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchPage = exports.MAX_FETCH_CHARS = void 0;
const dns_1 = __importDefault(require("dns"));
const net_1 = __importDefault(require("net"));
const geoLocationService_1 = require("./geoLocationService");
const markdownConversion_1 = require("./markdownConversion");
const safeLinkService_1 = require("./safeLinkService");
const FETCH_TIMEOUT_MS = 12000;
// Cap on the raw response body we are willing to buffer before conversion
// (~2MB): stops giant pages from blowing memory just to get a truncated head.
const MAX_BODY_CHARS = 2000000;
// How much fetched page text the model actually sees: fixed character budget
// applied at service level; tuning this later is cost-free.
exports.MAX_FETCH_CHARS = 8000;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
// isPrivateIp handles ::ffff:1.2.3.4 but URL normalizes IPv6 literals to
// hex form (::ffff:1:2), which its checks miss. Expand to 8 groups and
// evaluate the private ranges directly. Unparsable input is refused
// (treated as private) — conservative is the right default for SSRF.
const expandIpv6 = (addr) => {
    const [left, right, ...extra] = addr.split('::');
    if (extra.length > 0)
        return null;
    const heads = left ? left.split(':').filter(Boolean) : [];
    const tails = right ? right.split(':').filter(Boolean) : [];
    const missing = addr.includes('::') ? 8 - heads.length - tails.length : 0;
    const groups = addr.includes('::') && missing > 0
        ? [...heads, ...Array(missing).fill('0'), ...tails]
        : [...heads, ...tails];
    if (groups.length !== 8)
        return null;
    const nums = groups.map((g) => parseInt(g, 16));
    if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff))
        return null;
    return nums;
};
const privateIpv6 = (addr) => {
    const nums = expandIpv6(addr);
    if (!nums)
        return true;
    const v4 = `${(nums[6] >> 8) & 0xff}.${nums[6] & 0xff}.${(nums[7] >> 8) & 0xff}.${nums[7] & 0xff}`;
    if (nums.every((n) => n === 0))
        return true; // '::'
    if (nums.slice(0, 7).every((n) => n === 0) && nums[7] === 1)
        return true; // '::1'
    if ((nums[0] & 0xffc0) === 0xfe80 || (nums[0] & 0xfe00) === 0xfc00)
        return true; // fe80::/10, fc00::/7
    if (nums.slice(0, 5).every((n) => n === 0) && nums[5] === 0xffff)
        return (0, geoLocationService_1.isPrivateIp)(v4); // IPv4-mapped
    if (nums.slice(0, 6).every((n) => n === 0) && nums[6] + nums[7] !== 1)
        return (0, geoLocationService_1.isPrivateIp)(v4); // v4-compatible
    if (nums[0] === 0x64 && nums[1] === 0xff9b)
        return true; // NAT64 ::64:ff9b:w.x.y.z
    if (nums[0] === 0x2002)
        return true; // 6to4 ::2002:0.0.0.0 relay capsules
    return false;
};
// literals and any resolved private address are refused. DNS rebinding and
// redirects to private hosts are consciously deferred and flagged in the PR.
const assertPublicHost = (rawHostname) => __awaiter(void 0, void 0, void 0, function* () {
    // WHATWG URL hostnames keep brackets around IPv6 literals; net.isIP and
    // isPrivateIp both expect the bare address.
    const hostname = rawHostname.replace(/^\[|\]$/g, '');
    if (net_1.default.isIP(hostname) === 6) {
        if (privateIpv6(hostname)) {
            throw new Error(`refusing to fetch private address: ${hostname}`);
        }
        return;
    }
    if (net_1.default.isIP(hostname) === 4) {
        if ((0, geoLocationService_1.isPrivateIp)(hostname)) {
            throw new Error(`refusing to fetch private address: ${hostname}`);
        }
        return;
    }
    let records;
    try {
        records = yield dns_1.default.promises.lookup(hostname, { all: true });
    }
    catch (err) {
        throw new Error(`refusing to fetch unresolvable host: ${hostname}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (records.length === 0)
        throw new Error(`refusing to fetch unresolvable host: ${hostname}`);
    for (const { address, family } of records) {
        const priv = family === 6 ? privateIpv6(address) : (0, geoLocationService_1.isPrivateIp)(address);
        if (priv) {
            throw new Error(`refusing to fetch host resolving to a private address: ${hostname}`);
        }
    }
});
// Truncate without splitting a surrogate pair (emoji, CJK), which would
// corrupt the tail of the prompt text.
const safeSlice = (text, max) => /[\uD800-\uDBFF]/.test(text.slice(max - 1, max)) ? text.slice(0, max - 1) : text.slice(0, max);
// Stream the body to a real cap: response.text() would buffer an
// arbitrarily large page before we could slice it, so read the stream and
// stop as soon as the budget is exceeded.
const readBodyCapped = (response) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const declared = Number((_a = response.headers.get('content-length')) !== null && _a !== void 0 ? _a : 0);
    if (declared > MAX_BODY_CHARS) {
        throw new Error(`page too large: content-length ${declared} exceeds cap`);
    }
    const body = response.body;
    if (!body || typeof body.getReader !== 'function') {
        return safeSlice(yield response.text(), MAX_BODY_CHARS);
    }
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let text = '';
    try {
        while (true) {
            const { done, value } = yield reader.read();
            if (done)
                break;
            text += decoder.decode(value, { stream: true });
            if (text.length > MAX_BODY_CHARS) {
                void reader.cancel().catch(() => undefined);
                return safeSlice(text, MAX_BODY_CHARS);
            }
        }
    }
    finally {
        text += decoder.decode();
    }
    return text;
});
// Each hop is re-checked against the SSRF guard (the plan's fallback rule),
// so a redirect to a private host is refused instead of followed.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const titleOf = (html, fallback) => {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!match)
        return fallback;
    const title = match[1].replace(/\s+/g, ' ').trim();
    return title ? title.slice(0, 300) : fallback;
};
// Fetch a page and return its title + truncated text content. Throws on
// bad scheme, SSRF refusal, network/timeout, non-2xx, and unsupported
// content types; returns null when the body is fetchable but has no
// readable text representation. The tool wrapper degrades on both.
const fetchPage = (url) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch (_b) {
        throw new Error(`invalid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`unsupported URL scheme: ${parsed.protocol}`);
    }
    yield assertPublicHost(parsed.hostname);
    yield (0, safeLinkService_1.assertSafeUrl)(parsed.toString());
    const requestOnce = (target) => fetch(target.toString(), {
        headers: {
            Accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.5',
            'User-Agent': BROWSER_UA,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`fetch failed: ${message}`);
    });
    let target = parsed;
    let response;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        yield assertPublicHost(target.hostname);
        yield (0, safeLinkService_1.assertSafeUrl)(target.toString());
        response = yield requestOnce(target);
        if (REDIRECT_STATUSES.has(response.status)) {
            const location = response.headers.get('location');
            if (!location)
                throw new Error(`redirect from ${target.hostname} has no location header`);
            target = new URL(location, target);
            if (target.protocol !== 'http:' && target.protocol !== 'https:') {
                throw new Error(`unsupported redirect scheme: ${target.protocol}`);
            }
            if (hop === MAX_REDIRECTS) {
                throw new Error(`too many redirects fetching ${parsed.hostname} (limit ${MAX_REDIRECTS})`);
            }
        }
        else {
            break;
        }
    }
    if (!response)
        throw new Error(`fetch did not run for ${parsed.hostname}`);
    if (!response.ok)
        throw new Error(`HTTP ${response.status} fetching ${target.hostname}`);
    if (!response.body)
        throw new Error(`no response body from ${target.hostname}`);
    const contentType = ((_a = response.headers.get('content-type')) !== null && _a !== void 0 ? _a : '').toLowerCase();
    const body = yield readBodyCapped(response);
    if (!body.trim())
        throw new Error(`empty response body from ${parsed.hostname}`);
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        const markdown = (0, markdownConversion_1.htmlToMarkdown)(body).replace(/\r\n/g, '\n').trim();
        if (!markdown)
            throw new Error(`conversion produced empty markdown for ${parsed.hostname}`);
        return {
            url: target.toString(),
            title: titleOf(body, target.toString()),
            content: safeSlice(markdown, exports.MAX_FETCH_CHARS),
        };
    }
    if (contentType.includes('text/plain') || contentType.includes('application/json')) {
        return {
            url: target.toString(),
            title: target.toString(),
            content: safeSlice(body.trim(), exports.MAX_FETCH_CHARS),
        };
    }
    return null;
});
exports.fetchPage = fetchPage;
