import mongoose from 'mongoose';
import { WorkspaceEmbedding } from '../../main/models/WorkspaceEmbedding';

/* Vector store: explicit collection, unique backfill key, `model` field. */
// @see #294

const base = (overrides: Record<string, unknown> = {}) => ({
  userId: new mongoose.Types.ObjectId(),
  kind: 'chat',
  sourceId: String(new mongoose.Types.ObjectId()),
  model: 'BAAI/bge-base-en-v1.5',
  dim: 4,
  vector: [0.1, 0.2, 0.3, 0.4],
  textHash: 'hash-1',
  ...overrides,
});

describe('WorkspaceEmbedding model (#294)', () => {
  it('stores in the explicit `workspace_embeddings` collection', () => {
    expect(WorkspaceEmbedding.collection.name).toBe('workspace_embeddings');
  });

  it('rejects a kind outside the enum', async () => {
    await expect(WorkspaceEmbedding.create(base({ kind: 'alien' }))).rejects.toThrow();
  });

  it('requires userId, sourceId, model, dim, vector and textHash', async () => {
    for (const field of ['userId', 'sourceId', 'model', 'dim', 'vector', 'textHash']) {
      const doc = base();
      delete (doc as Record<string, unknown>)[field];
      await expect(WorkspaceEmbedding.create(doc)).rejects.toThrow();
    }
  });

  it('enforces one row per { kind, sourceId, model }', async () => {
    const userId = new mongoose.Types.ObjectId();
    const sourceId = String(new mongoose.Types.ObjectId());
    await WorkspaceEmbedding.create(base({ userId, sourceId }));
    await expect(WorkspaceEmbedding.create(base({ userId, sourceId }))).rejects.toThrow();
    // A different model (or kind) is a distinct row, so probes coexist.
    await WorkspaceEmbedding.create(
      base({ userId, sourceId, model: 'BAAI/bge-m3', dim: 4, textHash: 'hash-2' }),
    );
    await WorkspaceEmbedding.create(base({ userId, sourceId, kind: 'file', textHash: 'hash-3' }));
  });
});
