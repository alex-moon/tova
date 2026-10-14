import {
  embeddingKey,
  planEmbeddingWrites,
  type EmbeddableSlice,
} from './workspaceEmbeddingBackfill';
import { EMBEDDING_MAX_CHARS, embeddingTextHash } from './workspaceEmbeddingText';

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
