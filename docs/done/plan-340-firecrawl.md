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
- **Scraped pages are persisted as `system-side` assets and read with
  `read_file`.** This is the read solution: a new `origin: 'system-side'`
  audience (owner's call) — Tova-made material for the **agent's own reading**,
  as opposed to `system-generated` (asked-for artifacts for the user). It is
  saved via a dedicated `createSystemSideAsset` and the tool returns the head
  plus the new `fileId` and a note pointing at `read_file` (line ranges /
  unit TOC, #350) — no new reader, no in-memory scrape cache, no second
  truncation path.
- **`system-side` rows are honest-but-background**: excluded from the library
  listing and `list_files` by default (so the attach picker — which calls the
  same `GET /api/assets` endpoint with no params — never offers them), but
  inspectable and deletable behind an opt-in filter: `GET
  /api/assets?origin=system-side` lists only those rows, intended as a
  separate tab on the assets view. `safeAsset`/`previewAsset` now carry
  `origin` so the viewer can hide object-backed actions (these rows have no
  Spaces object at all — `read_file` reads the stored text, so storage is not
  needed and the create path works with storage unconfigured).
- **Expiry is native MongoDB TTL, not an app sweep.** Each system-side row
  carries `expiresAt` (createdAt + `AGENT_ASSET_TTL_DAYS`, default **30**) and
  the schema declares `{ expiresAt: 1 }, { expireAfterSeconds: 0 }` — the
  per-document-expiry pattern, so only rows that carry the field are ever
  eligible and no other asset can be touched. The TTL is the **staleness
  policy**: within the horizon a follow-up reuses the saved copy; past it the
  page is expired *and* stale ("something might well have changed"), so the
  next fetch re-downloads. 0 disables expiry. `agentAssetSweep` (an interval
  sweep) was considered and replaced by this.
- **Fresh copies are reused, not re-scraped.** Each row stores its
  `sourceUrl`; when the native fetch fails, the tool first looks for a
  system-side row for that exact URL inside the TTL and serves it (`fileId`
  and all) instead of paying for a re-scrape. Exact-URL match: trailing-slash
  and query variants are distinct cache keys.
- **Trust boundary preserved as far as possible.** Firecrawl fetches
  server-side and resolves DNS itself, so the native SSRF guard cannot bind
  it. `firecrawlScrape` still runs the same scheme check, `assertPublicHost`
  (DNS/private-IP refusal) and `assertSafeUrl` (Safe Browsing) before handing
  the URL over — screening the obvious cases, but weaker than native.
  Documented in the service header, not silently accepted.
- **Honesty is baked into the tool contract.** When a page is saved, the tool
  note instructs the agent to *tell the user* it saved the page so it could
  read it in full — disclosure rides the same result the agent reads.
- **ZDR turns never persist.** A ZDR turn is exactly the turn with no session
  and no task on the request context (#116/#144), so `saveScrapedPage` skips
  the save there — head-only, like every other ZDR artifact. Task-origin
  scrapes are attributed to the task (`kind: 'task'`), chat-origin to the chat.
- **Key-gated like Brave.** `config.firecrawl.apiKey` (`FIRECRAWL_API_KEY`,
  optional); unset → `fetch_url` behaves exactly as today. The API call is
  `POST https://api.firecrawl.dev/v2/scrape` with `{ url, formats: ['markdown'],
  onlyMainContent: true }`.

## Done

- [x] `config.firecrawl.apiKey` + `config.agentAssets.ttlDays` + `.env.example` (`FIRECRAWL_API_KEY`, `AGENT_ASSET_TTL_DAYS`) + `config/index.test.ts` keys
- [x] `firecrawlService.ts`: guarded `/v2/scrape` call → `FetchedPage` (full markdown)
- [x] `webFetchService`: export `assertPublicHost`/`safeSlice` for reuse
- [x] `origin: 'system-side'` on the Asset model + native TTL index (`expiresAt`, `expireAfterSeconds: 0`)
- [x] `createSystemSideAsset` (text-only row: no Spaces object, no embedding, TTL stamp) + `findFreshScrape` (cache hit)
- [x] Library listing + `list_files` exclude agent-side rows by default; `?origin=system-side` opts in (the assets-view tab's data source); `origin` on `safeAsset`/`previewAsset`
- [x] `fetch_url`: native → Firecrawl fallback; cache reuse; persist over-cap scrapes; head + `fileId` + honest note; ZDR skip; description updated
- [x] Tests: `firecrawlService.test.ts` (6); `fetchUrlTool.test.ts` (7: fallback, cache hit, ZDR, task attribution); `systemAssetService.test.ts` (+9); listing-filter tests (route + tool)
- [x] `npm run ci` green

## Follow-ups

- **Client tab** (deliberately its own slice): the opt-in filter ships API-only;
  the assets view needs its second tab ("Agent files"), the agent-side detail
  pane hiding attach/download affordances (no Spaces object), and delete wired
  in that tab (the DELETE route is doc-only, so it already works). Verify with
  Playwright at phone width per the client rules.
- Live verification needs a `FIRECRAWL_API_KEY` in `.env`: fetch a page that
  419s natively (e.g. a Cloudflare-fronted site) and confirm the fallback reads
  it, saves the over-cap result, and reuses the cache on a second ask.
- Cache keys are exact URLs: trivial variants (trailing slash, utm params) are
  distinct rows. Normalize harder only if the duplicates ever matter.

