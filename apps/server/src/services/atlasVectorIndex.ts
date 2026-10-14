/*
 * #294: the Atlas Vector Search index over `workspace_embeddings`.
 *
 * `$vectorSearch` and `createSearchIndex` exist only on Atlas — not on local
 * `mongod` or `mongodb-memory-server` — so this is a script, not a migration.
 * The definition is a pure function so its shape is unit-testable; the driver
 * call itself is exercised only against a live cluster.
 *
 * If the live tier does not allow programmatic index creation (some docs say
 * shared M0 requires the Atlas UI), create the same definition in the UI:
 *   { type: 'vector', path: 'vector', numDimensions: <EMBEDDING_DIM>, similarity: 'cosine' }
 *   { type: 'filter', path: 'model' }
 *   { type: 'filter', path: 'userId' }
 */

export const VECTOR_INDEX_NAME = 'workspace_embeddings_vector';

export type VectorSimilarity = 'cosine' | 'euclidean' | 'dotProduct';

export type VectorIndexField =
  | { type: 'vector'; path: string; numDimensions: number; similarity: VectorSimilarity }
  | { type: 'filter'; path: string };

export interface VectorIndexDescription {
  name: string;
  type: 'vectorSearch';
  definition: { fields: VectorIndexField[] };
}

export const vectorIndexDefinition = (dim: number): VectorIndexDescription => ({
  name: VECTOR_INDEX_NAME,
  type: 'vectorSearch',
  definition: {
    fields: [
      // `cosine` matches the unit-normalised BGE vectors and needs no score
      // normalisation before RRF (which is rank-based anyway).
      { type: 'vector', path: 'vector', numDimensions: dim, similarity: 'cosine' },
      // The query filters on the configured model and the owner, so stale
      // model rows and other users' vectors never enter the candidate set.
      { type: 'filter', path: 'model' },
      { type: 'filter', path: 'userId' },
    ],
  },
});

/*
 * Index creation is Atlas-only; a non-`mongodb+srv` URL is a local stack where
 * the driver call would fail with a confusing error. Fail early with the UI
 * fallback instead.
 */
export const assertAtlasUrl = (url: string | undefined): string => {
  if (!url || !url.startsWith('mongodb+srv://')) {
    throw new Error(
      'Atlas Vector Search index creation needs an Atlas connection string ' +
        '(mongodb+srv://...); local MongoDB has no $vectorSearch. ' +
        'Create the index in the Atlas UI instead (see the script header).',
    );
  }
  return url;
};

// Minimal structural view of the driver collection methods used here, so the
// existence-check is testable with a fake and the script can pass the real
// collection without depending on the driver's Atlas-only typings.
export interface SearchIndexManager {
  listSearchIndexes(): { toArray(): Promise<{ name?: string }[]> };
  createSearchIndex(description: VectorIndexDescription): Promise<string>;
}

/*
 * Create the vector index if it does not already exist. Existence-checked so
 * re-running the script is safe.
 */
export const ensureVectorIndex = async (
  collection: SearchIndexManager,
  dim: number,
): Promise<'created' | 'exists'> => {
  const existing = await collection.listSearchIndexes().toArray();
  if (existing.some((index) => index.name === VECTOR_INDEX_NAME)) return 'exists';
  await collection.createSearchIndex(vectorIndexDefinition(dim));
  return 'created';
};
