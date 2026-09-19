import dns from 'dns';
import net from 'net';
import { isPrivateIp } from './geoLocationService';
import { htmlToMarkdown } from './markdownConversion';

// Direct URL fetching for the `fetch_url` tool (issue #113): a parseable URL
// the user pasted is a direct link, not a search query, so the agent should
// read the actual page. Like webSearchService, failures throw so the tool
// wrapper owns graceful degradation (#82 pattern).

export interface FetchedPage {
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

const readBodyCapped = async (response: Response): Promise<string> => {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_CHARS) {
    throw new Error(`page too large: content-length ${declared} exceeds cap`);
  }
  const text = await response.text();
  if (text.length > MAX_BODY_CHARS) return text.slice(0, MAX_BODY_CHARS);
  return text;
};

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

  const response = await fetch(parsed.toString(), {
    headers: {
      Accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.5',
      'User-Agent': BROWSER_UA,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`fetch failed: ${message}`);
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${parsed.hostname}`);
  if (!response.body) throw new Error(`no response body from ${parsed.hostname}`);

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const body = await readBodyCapped(response);
  if (!body.trim()) throw new Error(`empty response body from ${parsed.hostname}`);

  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    const markdown = htmlToMarkdown(body).replace(/\r\n/g, '\n').trim();
    if (!markdown) throw new Error(`conversion produced empty markdown for ${parsed.hostname}`);
    return { title: titleOf(body, parsed.toString()), content: markdown.slice(0, MAX_FETCH_CHARS) };
  }
  if (contentType.includes('text/plain') || contentType.includes('application/json')) {
    return { title: parsed.toString(), content: body.trim().slice(0, MAX_FETCH_CHARS) };
  }
  return null;
};
