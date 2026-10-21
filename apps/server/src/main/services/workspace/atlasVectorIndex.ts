/* Atlas-only vector index over `workspace_embeddings`; script-based. */
// @see #294

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
      // `cosine` matches the unit-normalised BGE vectors; no rescaling.
      { type: 'vector', path: 'vector', numDimensions: dim, similarity: 'cosine' },
      // Filters keep stale model rows and other users out of the candidates.
      { type: 'filter', path: 'model' },
      { type: 'filter', path: 'userId' },
    ],
  },
});

/* Atlas-only; fail early with the UI fallback, not a driver error. */
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

// Minimal structural view of the driver methods, testable with a fake.
export interface SearchIndexManager {
  listSearchIndexes(): { toArray(): Promise<{ name?: string }[]> };
  createSearchIndex(description: VectorIndexDescription): Promise<string>;
}

/* Create the vector index if absent; existence-checked, re-runnable. */
export const ensureVectorIndex = async (
  collection: SearchIndexManager,
  dim: number,
): Promise<'created' | 'exists'> => {
  const existing = await collection.listSearchIndexes().toArray();
  if (existing.some((index) => index.name === VECTOR_INDEX_NAME)) return 'exists';
  await collection.createSearchIndex(vectorIndexDefinition(dim));
  return 'created';
};
