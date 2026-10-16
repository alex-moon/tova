# Plan — Firecrawl fallback + reading scraped pages (#340)

## Motivation

`fetch_url` (issue #113) does a plain undici `fetch` with a browser User-Agent,
Turndown for HTML→markdown, and no JS execution, cookies, or proxy. Sites behind a
WAF/anti-bot layer (Cloudflare; Laravel-style 419 "page expired") reject it — the
tool degrades with `HTTP 419 fetching <host>`. Firecrawl is a hosted web-data API
that handles exactly that (headless browser + proxies + anti-bot) and returns clean
markdown.

Ticket: https://github.com/alex-moon/tova/issues/340

## The reading problem (the important part)

Firecrawl returns the **whole** page, which is usually far larger than the 8k
`MAX_FETCH_CHARS` the model sees. A fetched page is not an asset, so `read_file`
(line ranges / units, #350) cannot touch it — the agent would only ever get the head.

## Decisions

- **Firecrawl is an automatic fallback inside `fetch_url`, not a second tool.** The
  agent should not have to know which fetcher works; native `fetch` is tried first
  (fast, free), and Firecrawl runs only when it fails and `FIRECRAWL_API_KEY` is set.
  A separate `scrape_url` tool would force the model to choose and needs prompt
  scaffolding — the ticket's "another tool alongside normal fetch" is satisfied by
  the fallback.
- **Scraped pages are persisted as system-generated assets, and read with
  `read_file`.** This is the read solution: `createSystemAsset` already stores the
  **full** text (`systemAssetService.ts`, OQ4) and embeds it; `read_file` already
  reads any asset by line range / unit TOC (#350). So a long scraped page becomes a
  file the agent walks with `offset`/`limit`/`unitsOnly` — no new reader, no
  in-memory scrape cache, no second truncation path. The tool returns the head plus
  the new `fileId` and a note pointing at `read_file`.
- **Only over-cap scrapes are saved.** When the Firecrawl markdown fits under
  `MAX_FETCH_CHARS`, it is returned inline and no file is created (no clutter for
  short pages). The tool result carries `fileId` only when a file was written.
- **Trust boundary is preserved as far as possible.** Firecrawl fetches
  server-side, so it bypasses Tova's SSRF resolution. `firecrawlScrape` still runs
  the same scheme check, `assertPublicHost` (DNS/private-IP refusal) and
  `assertSafeUrl` (Safe Browsing) before handing the URL over. Firecrawl resolves
  its own DNS, so this is weaker than the native guard — documented, not silently
  accepted.
- **Key-gated like Brave.** `config.firecrawl.apiKey` (`FIRECRAWL_API_KEY`,
  optional); unset → `fetch_url` behaves exactly as today. The API call is
  `POST https://api.firecrawl.dev/v2/scrape` with `{ url, formats: ['markdown'],
  onlyMainContent: true }`.

## Done

- [x] `config.firecrawl.apiKey` + `.env.example` + `config/index.test.ts` key
- [x] `firecrawlService.ts`: guarded `/v2/scrape` call → `FetchedPage` (full markdown)
- [x] `webFetchService`: export `assertPublicHost`/`safeSlice` for reuse
- [x] `fetch_url`: native → Firecrawl fallback; persist over-cap scrapes as a system asset; return head + `fileId` + note; description updated
- [x] Tests: `firecrawlService.test.ts` (6); `fetchUrlTool.test.ts` (5) fallback + persistence
- [x] `npm run ci` green (116 suites, 1503 tests)

## Follow-ups

- Scraped pages currently land in the library as system-generated files (like
  `generate_file`). If noisy, tag them (e.g. a `web` provenance kind) and filter
  them out of `list_files`.
- Native `fetch_url` still truncates long pages at 8k with no file; the same
  "persist over-cap" rule could be applied to it for uniformity.
- Live verification needs a `FIRECRAWL_API_KEY` in `.env`: fetch a page that
  419s natively (e.g. a Cloudflare-fronted site) and confirm the fallback reads
  it and saves the over-cap result as a file.

