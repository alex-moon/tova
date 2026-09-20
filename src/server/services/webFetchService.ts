import dns from 'dns';
import net from 'net';
import { isPrivateIp } from './geoLocationService';
import { htmlToMarkdown } from './markdownConversion';

// Direct URL fetching for the `fetch_url` tool (issue #113): a parseable URL
// the user pasted is a direct link, not a search query, so the agent should
// read the actual page. Like webSearchService, failures throw so the tool
// wrapper owns graceful degradation (#82 pattern).

export interface FetchedPage {
  // The URL the page was actually fetched from (after redirects), so tool
  // consumers can attribute the content and surface provenance.
  url: string;
  title: string;
  content: string;
}

const FETCH_TIMEOUT_MS = 12_000;

// Cap on the raw response body we are willing to buffer before conversion
// (~2MB): stops giant pages from blowing memory just to get a truncated head.
const MAX_BODY_CHARS = 2_000_000;

// How much fetched page text the model actually sees: fixed character budget
// applied at service level; tuning this later is cost-free.
export const MAX_FETCH_CHARS = 8_000;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

// isPrivateIp handles ::ffff:1.2.3.4 but URL normalizes IPv6 literals to
// hex form (::ffff:1:2), which its checks miss. Expand to 8 groups and
// evaluate the private ranges directly. Unparsable input is refused
// (treated as private) — conservative is the right default for SSRF.
const expandIpv6 = (addr: string): number[] | null => {
  const [left, right, ...extra] = addr.split('::');
  if (extra.length > 0) return null;
  const heads = left ? left.split(':').filter(Boolean) : [];
  const tails = right ? right.split(':').filter(Boolean) : [];
  const missing = addr.includes('::') ? 8 - heads.length - tails.length : 0;
  const groups =
    addr.includes('::') && missing > 0
      ? [...heads, ...Array(missing).fill('0'), ...tails]
      : [...heads, ...tails];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g, 16));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
};

const privateIpv6 = (addr: string): boolean => {
  const nums = expandIpv6(addr);
  if (!nums) return true;
  const v4 = `${(nums[6] >> 8) & 0xff}.${nums[6] & 0xff}.${(nums[7] >> 8) & 0xff}.${nums[7] & 0xff}`;
  if (nums.every((n) => n === 0)) return true; // '::'
  if (nums.slice(0, 7).every((n) => n === 0) && nums[7] === 1) return true; // '::1'
  if ((nums[0] & 0xffc0) === 0xfe80 || (nums[0] & 0xfe00) === 0xfc00) return true; // fe80::/10, fc00::/7
  if (nums.slice(0, 5).every((n) => n === 0) && nums[5] === 0xffff) return isPrivateIp(v4); // IPv4-mapped
  if (nums.slice(0, 6).every((n) => n === 0) && nums[6] + nums[7] !== 1) return isPrivateIp(v4); // v4-compatible
  if (nums[0] === 0x64 && nums[1] === 0xff9b) return true; // NAT64 ::64:ff9b:w.x.y.z
  if (nums[0] === 0x2002) return true; // 6to4 ::2002:0.0.0.0 relay capsules
  return false;
};
// literals and any resolved private address are refused. DNS rebinding and
// redirects to private hosts are consciously deferred and flagged in the PR.
const assertPublicHost = async (rawHostname: string): Promise<void> => {
  // WHATWG URL hostnames keep brackets around IPv6 literals; net.isIP and
  // isPrivateIp both expect the bare address.
  const hostname = rawHostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname) === 6) {
    if (privateIpv6(hostname)) {
      throw new Error(`refusing to fetch private address: ${hostname}`);
    }
    return;
  }
  if (net.isIP(hostname) === 4) {
    if (isPrivateIp(hostname)) {
      throw new Error(`refusing to fetch private address: ${hostname}`);
    }
    return;
  }
  let records;
  try {
    records = await dns.promises.lookup(hostname, { all: true });
  } catch (err) {
    throw new Error(
      `refusing to fetch unresolvable host: ${hostname}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (records.length === 0) throw new Error(`refusing to fetch unresolvable host: ${hostname}`);
  for (const { address, family } of records) {
    const priv = family === 6 ? privateIpv6(address) : isPrivateIp(address);
    if (priv) {
      throw new Error(`refusing to fetch host resolving to a private address: ${hostname}`);
    }
  }
};

// Truncate without splitting a surrogate pair (emoji, CJK), which would
// corrupt the tail of the prompt text.
const safeSlice = (text: string, max: number): string =>
  /[\uD800-\uDBFF]/.test(text.slice(max - 1, max)) ? text.slice(0, max - 1) : text.slice(0, max);

// Stream the body to a real cap: response.text() would buffer an
// arbitrarily large page before we could slice it, so read the stream and
// stop as soon as the budget is exceeded.
const readBodyCapped = async (response: Response): Promise<string> => {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_CHARS) {
    throw new Error(`page too large: content-length ${declared} exceeds cap`);
  }
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== 'function') {
    return safeSlice(await response.text(), MAX_BODY_CHARS);
  }
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder('utf-8');
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > MAX_BODY_CHARS) {
        void reader.cancel().catch(() => undefined);
        return safeSlice(text, MAX_BODY_CHARS);
      }
    }
  } finally {
    text += decoder.decode();
  }
  return text;
};

// Each hop is re-checked against the SSRF guard (the plan's fallback rule),
// so a redirect to a private host is refused instead of followed.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

const titleOf = (html: string, fallback: string): string => {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return fallback;
  const title = match[1].replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 300) : fallback;
};

// Fetch a page and return its title + truncated text content. Throws on
// bad scheme, SSRF refusal, network/timeout, non-2xx, and unsupported
// content types; returns null when the body is fetchable but has no
// readable text representation. The tool wrapper degrades on both.
export const fetchPage = async (url: string): Promise<FetchedPage | null> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported URL scheme: ${parsed.protocol}`);
  }
  await assertPublicHost(parsed.hostname);

  const requestOnce = (target: URL): Promise<Response> =>
    fetch(target.toString(), {
      headers: {
        Accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.5',
        'User-Agent': BROWSER_UA,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`fetch failed: ${message}`);
    });

  let target = parsed;
  let response: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(target.hostname);
    response = await requestOnce(target);
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`redirect from ${target.hostname} has no location header`);
      target = new URL(location, target);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error(`unsupported redirect scheme: ${target.protocol}`);
      }
      if (hop === MAX_REDIRECTS) {
        throw new Error(`too many redirects fetching ${parsed.hostname} (limit ${MAX_REDIRECTS})`);
      }
    } else {
      break;
    }
  }
  if (!response) throw new Error(`fetch did not run for ${parsed.hostname}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${target.hostname}`);
  if (!response.body) throw new Error(`no response body from ${target.hostname}`);

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const body = await readBodyCapped(response);
  if (!body.trim()) throw new Error(`empty response body from ${parsed.hostname}`);

  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    const markdown = htmlToMarkdown(body).replace(/\r\n/g, '\n').trim();
    if (!markdown) throw new Error(`conversion produced empty markdown for ${parsed.hostname}`);
    return {
      url: target.toString(),
      title: titleOf(body, target.toString()),
      content: safeSlice(markdown, MAX_FETCH_CHARS),
    };
  }
  if (contentType.includes('text/plain') || contentType.includes('application/json')) {
    return {
      url: target.toString(),
      title: target.toString(),
      content: safeSlice(body.trim(), MAX_FETCH_CHARS),
    };
  }
  return null;
};
