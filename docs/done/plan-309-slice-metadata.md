# Plan — #309 Slice metadata into BM25 text and embed text

"That AGI file, give me a summary of it" / "Give me the markdown file we wrote
yesterday" fail today on both retrieval halves: BM25 tokenises `slice.text`
only, and the embed text carries no filename either (`workspaceSliceText`
embeds content only). The title/filename lives only in the rendered block
label, which is layout, not retrieval. When the library-index injection is
retired (#310), there is no fallback left — metadata becomes load-bearing.

## Decisions

- **BM25** (`pickTopSlices`): title tokens join the doc token stream, counted
  `BM25_TITLE_BOOST` (2) times — visible/diffable like `BM25_K1`/`BM25_B`.
  Applies to all three kinds (every slice already carries a title).
- **Embed text**: file slices gain their filename (`"<filename>\n<content>"`
  before trim/truncate/hash). Chat stays content-only — the ingest hook would
  need an extra session lookup for the title (follow-up if wanted). Task stays
  content-only — its title is `taskTitle(instruction)`, a duplicate of the
  first event's content, so it adds no terms.
- **Hash/backfill parity**: the title fold lives in one helper
  (`withEmbedTitle` in `workspaceEmbeddingText.ts`) used by both the ingest
  path (`workspaceSliceText`, file source gains `filename`) and the backfill
  (`planEmbeddingWrites` via a `title` field on `EmbeddableSlice`, fed from
  `collectWorkspaceSlices`' slice title). A filename change therefore changes
  the hash — re-embed is correct.
- **Re-embed expected**: the rule change invalidates every stored `textHash`;
  the next backfill re-embeds the corpus once. Run `npm run
  db:backfill-embeddings` after deploy.

## Tasks

1. `pickTopSlices`: fold title tokens (× `BM25_TITLE_BOOST`) into tf/length.
2. `workspaceEmbeddingText`: `filename` on the file source + `withEmbedTitle`;
   `workspaceSliceText` applies it for files.
3. `workspaceEmbeddingBackfill`: `EmbeddableSlice.title`; plan derives the
   embed text through the same helper (byte-parity with ingest preserved).
4. Ingest hooks: pass `filename` on file sources (asset extraction paths).
5. `collectWorkspaceSlices` → `embedWorkspaceUser`: thread slice titles.
6. #289 corpus: filename-reference cases (title-only term matches), e.g.
   "That AGI file, give me a summary of it".

## Verification

Unit: title matching + boost in `pickTopSlices`; embed text with/without
filename; ingest/backfill byte-parity (hash equality). Eval corpus cases hit
by slice ID. `npm run ci` green.
