import {
  VECTOR_INDEX_NAME,
  assertAtlasUrl,
  ensureVectorIndex,
  vectorIndexDefinition,
  type SearchIndexManager,
} from '../../main/services/atlasVectorIndex';

/* Atlas index definition + URL guard + existence check; ANN is live-only. */
// @see #294
describe('vectorIndexDefinition (#294)', () => {
  it('declares a cosine vector field at the configured dimension plus model/userId filters', () => {
    expect(vectorIndexDefinition(768)).toEqual({
      name: VECTOR_INDEX_NAME,
      type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'vector', path: 'vector', numDimensions: 768, similarity: 'cosine' },
          { type: 'filter', path: 'model' },
          { type: 'filter', path: 'userId' },
        ],
      },
    });
  });

  it('tracks the dimension passed in', () => {
    const fields = vectorIndexDefinition(1024).definition.fields;
    expect(fields[0]).toEqual({
      type: 'vector',
      path: 'vector',
      numDimensions: 1024,
      similarity: 'cosine',
    });
  });
});

describe('assertAtlasUrl (#294)', () => {
  it('accepts a mongodb+srv Atlas URL', () => {
    expect(assertAtlasUrl('mongodb+srv://user:pw@cluster.mongodb.net/tova')).toContain('srv');
  });

  it('refuses a plain local mongodb URL with the UI fallback in the message', () => {
    expect(() => assertAtlasUrl('mongodb://localhost:27017/tova')).toThrow(/Atlas UI/);
  });

  it('refuses an absent URL', () => {
    expect(() => assertAtlasUrl(undefined)).toThrow(/mongodb\+srv/);
  });
});

describe('ensureVectorIndex (#294)', () => {
  const fakeCollection = (existingNames: string[], created: unknown[]): SearchIndexManager => ({
    listSearchIndexes: () => ({
      toArray: async () => existingNames.map((name) => ({ name })),
    }),
    createSearchIndex: async (description) => {
      created.push(description);
      return description.name;
    },
  });

  it('creates the index when absent', async () => {
    const created: unknown[] = [];
    const result = await ensureVectorIndex(fakeCollection(['other_index'], created), 768);
    expect(result).toBe('created');
    expect(created).toEqual([vectorIndexDefinition(768)]);
  });

  it('is a no-op when the index already exists', async () => {
    const created: unknown[] = [];
    const result = await ensureVectorIndex(fakeCollection([VECTOR_INDEX_NAME], created), 768);
    expect(result).toBe('exists');
    expect(created).toEqual([]);
  });
});
