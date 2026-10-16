import {
  embeddingKey,
  existingEmbeddingHashes,
  planEmbeddingWrites,
  type EmbeddableSlice,
} from '../../main/services/workspaceEmbeddingBackfill';
import {
  EMBEDDING_MAX_CHARS,
  embeddingTextHash,
  workspaceSliceText,
} from '../../main/services/workspaceEmbeddingText';

/*
 * #294: the backfill's idempotency rule. The plan is pure, so the skip/embed
 * decision is pinned without a database or a provider call.
 */

const MODEL = 'BAAI/bge-base-en-v1.5';

const slice = (overrides: Partial<EmbeddableSlice> = {}): EmbeddableSlice => ({
  kind: 'chat',
  id: 'm1',
  text: 'hello world',
  ...overrides,
});

describe('planEmbeddingWrites (#294)', () => {
  it('embeds every slice on a first run', () => {
    const plan = planEmbeddingWrites([slice(), slice({ id: 'm2' })], new Map(), MODEL);
    expect(plan.toEmbed.map((item) => item.sourceId)).toEqual(['m1', 'm2']);
    expect(plan.skipped).toBe(0);
    expect(plan.total).toBe(2);
  });

  it('skips a slice whose stored hash already matches', () => {
    const text = 'hello world';
    const existing = new Map([[embeddingKey('chat', 'm1', MODEL), embeddingTextHash(text, MODEL)]]);
    const plan = planEmbeddingWrites([slice()], existing, MODEL);
    expect(plan.toEmbed).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  it('re-embeds when the text changed', () => {
    const existing = new Map([
      [embeddingKey('chat', 'm1', MODEL), embeddingTextHash('old text', MODEL)],
    ]);
    const plan = planEmbeddingWrites([slice({ text: 'new text' })], existing, MODEL);
    expect(plan.toEmbed.map((item) => item.sourceId)).toEqual(['m1']);
    expect(plan.skipped).toBe(0);
  });

  it('re-embeds when the model changed (the stored hash is model-bound)', () => {
    const existing = new Map([
      [embeddingKey('chat', 'm1', MODEL), embeddingTextHash('hello world', MODEL)],
    ]);
    const plan = planEmbeddingWrites([slice()], existing, 'BAAI/bge-m3');
    expect(plan.toEmbed).toHaveLength(1);
  });

  it('separates kinds by key so a chat and file sharing an id do not collide', () => {
    const text = 'same text';
    const existing = new Map([
      [embeddingKey('chat', 'shared', MODEL), embeddingTextHash(text, MODEL)],
    ]);
    const plan = planEmbeddingWrites(
      [slice({ kind: 'file', id: 'shared', text })],
      existing,
      MODEL,
    );
    expect(plan.toEmbed).toHaveLength(1);
  });

  it('counts empty slices separately and never embeds them', () => {
    const plan = planEmbeddingWrites([slice({ text: '   ' })], new Map(), MODEL);
    expect(plan.toEmbed).toEqual([]);
    expect(plan.empty).toBe(1);
  });

  it('reports truncation for a slice longer than the cap', () => {
    const plan = planEmbeddingWrites(
      [slice({ text: 'x'.repeat(EMBEDDING_MAX_CHARS + 5) })],
      new Map(),
      MODEL,
    );
    expect(plan.truncated).toBe(1);
    expect(plan.toEmbed[0].truncated).toBe(true);
    expect(plan.toEmbed[0].text).toHaveLength(EMBEDDING_MAX_CHARS);
  });

  it('normalises whitespace so the backfill hashes exactly what ingest writes (#294)', () => {
    // collectWorkspaceSlices returns chat/task text untrimmed; workspaceSliceText
    // (the ingest helper) trims. If the backfill did not normalise, the two
    // paths would hash different text and never agree on "already embedded".
    const cases: { slice: EmbeddableSlice; source: Parameters<typeof workspaceSliceText>[0] }[] = [
      {
        slice: slice({ kind: 'chat', id: 'c1', text: '  hello world  ' }),
        source: { kind: 'chat', content: '  hello world  ' },
      },
      {
        // collectWorkspaceSlices joins non-blank events verbatim, so a trailing
        // whitespace content survives into the collected text.
        slice: slice({ kind: 'task', id: 't1', text: 'do it\nworking  ' }),
        source: {
          kind: 'task',
          events: [
            { role: 'user', content: 'do it' },
            { role: 'assistant', content: 'working  ' },
          ],
        },
      },
    ];
    for (const { slice: input, source } of cases) {
      const plan = planEmbeddingWrites([input], new Map(), MODEL);
      const ingestText = workspaceSliceText(source);
      expect(plan.toEmbed[0].text).toBe(ingestText);
      expect(plan.toEmbed[0].textHash).toBe(embeddingTextHash(ingestText, MODEL));
    }
  });

  it('folds the file title into the planned text, byte-identical with ingest (#309)', () => {
    const planned = slice({
      kind: 'file',
      id: 'f1',
      title: 'agi-final.md',
      text: 'The rollout completes in three phases.',
    });
    const source = {
      kind: 'file' as const,
      filename: 'agi-final.md',
      textExtracted: 'The rollout completes in three phases.',
    };
    const plan = planEmbeddingWrites([planned], new Map(), MODEL);
    const ingestText = workspaceSliceText(source);
    expect(plan.toEmbed[0].text).toBe('agi-final.md\nThe rollout completes in three phases.');
    expect(plan.toEmbed[0].textHash).toBe(embeddingTextHash(ingestText, MODEL));
  });

  it('re-embeds a file when its title changes (#309)', () => {
    const text = 'The rollout completes in three phases.';
    const existing = new Map([
      [embeddingKey('file', 'f1', MODEL), embeddingTextHash(`agi-final.md\n${text}`, MODEL)],
    ]);
    const plan = planEmbeddingWrites(
      [slice({ kind: 'file', id: 'f1', title: 'agi-final-v2.md', text })],
      existing,
      MODEL,
    );
    expect(plan.skipped).toBe(0);
    expect(plan.toEmbed).toHaveLength(1);
  });

  it('keys an existing row by the run model even when the projection omits `model` (#294)', () => {
    // Regression: the backfill projected `kind sourceId textHash` only, so
    // `row.model` was `undefined` and the key became `chat|m1|undefined` while
    // the plan looked up `chat|m1|<model>`. The skip never matched and every
    // run re-embedded the whole corpus. The row here has no `model`, as a
    // projection that omits it would return.
    const text = 'hello world';
    const hashes = existingEmbeddingHashes(
      [{ kind: 'chat', sourceId: 'm1', textHash: embeddingTextHash(text, MODEL) }],
      MODEL,
    );
    expect(hashes.get(embeddingKey('chat', 'm1', MODEL))).toBe(embeddingTextHash(text, MODEL));
    const plan = planEmbeddingWrites([slice({ text })], hashes, MODEL);
    expect(plan.toEmbed).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  it('keys a row by its own model, so a foreign-model row never satisfies the run model', () => {
    // Multi-model rows coexist (the bge-m3/gte probe), and each stores its own
    // `model`. The skip lookup uses the run model, so a bge-m3 row must not be
    // mistaken for a bge-base row for the same slice.
    const text = 'hello world';
    const hashes = existingEmbeddingHashes(
      [
        {
          kind: 'chat',
          sourceId: 'm1',
          model: 'BAAI/bge-m3',
          textHash: embeddingTextHash(text, MODEL),
        },
      ],
      MODEL,
    );
    const plan = planEmbeddingWrites([slice({ text })], hashes, MODEL);
    expect(plan.toEmbed).toHaveLength(1);
    expect(plan.skipped).toBe(0);
  });

  it('is a no-op on a second run over the planned output', () => {
    const first = planEmbeddingWrites([slice()], new Map(), MODEL);
    const existing = new Map(
      first.toEmbed.map((item) => [embeddingKey(item.kind, item.sourceId, MODEL), item.textHash]),
    );
    const second = planEmbeddingWrites([slice()], existing, MODEL);
    expect(second.toEmbed).toEqual([]);
    expect(second.skipped).toBe(1);
  });
});
