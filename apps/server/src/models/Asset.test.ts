import mongoose from 'mongoose';
import { Asset } from './Asset';

const createAsset = (origin?: string) =>
  Asset.create({
    userId: new mongoose.Types.ObjectId(),
    filename: 'notes.md',
    key: 'u/000000000000000000000000/notes.md',
    contentType: 'text/markdown',
    size: 1,
    ...(origin ? { origin } : {}),
  });

describe('Asset model origin (#66)', () => {
  it('defaults origin to user-upload', async () => {
    expect((await createAsset()).origin).toBe('user-upload');
  });

  it('persists system-generated origin', async () => {
    expect((await createAsset('system-generated')).origin).toBe('system-generated');
  });

  it('applies the default to legacy docs without origin at read time', async () => {
    // Legacy shape: an old doc written before the field existed, inserted raw.
    await mongoose.connection.db
      ?.collection('assets')
      .insertOne({ filename: 'legacy.md', key: 'u/x/legacy.md', size: 1 });
    const doc = await Asset.findOne({ filename: 'legacy.md' });
    expect(doc?.origin).toBe('user-upload');
  });

  it('rejects unknown origin values', async () => {
    await expect(createAsset('alien' as unknown as undefined)).rejects.toThrow();
  });
});

describe('Asset model provenance (#252)', () => {
  const createWithProvenance = (provenance: unknown) =>
    Asset.create({
      userId: new mongoose.Types.ObjectId(),
      filename: 'notes.md',
      key: 'u/000000000000000000000000/notes.md',
      contentType: 'text/markdown',
      size: 1,
      provenance,
    });

  it('reads back undefined when provenance is absent (absence preserved)', async () => {
    const doc = await createAsset();
    expect(doc.provenance).toBeUndefined();
  });

  it('round-trips a chat provenance with sessionId', async () => {
    const sessionId = new mongoose.Types.ObjectId().toString();
    const doc = await createWithProvenance({ kind: 'chat', sessionId });
    expect(doc.provenance?.kind).toBe('chat');
    expect(doc.provenance?.sessionId).toBe(sessionId);
  });

  it('round-trips an upload provenance', async () => {
    expect((await createWithProvenance({ kind: 'upload' })).provenance?.kind).toBe('upload');
  });

  it('rejects a kind outside the enum', async () => {
    await expect(createWithProvenance({ kind: 'alien' })).rejects.toThrow();
  });

  it('produces no per-subdoc _id', async () => {
    const doc = await createWithProvenance({ kind: 'upload' });
    expect((doc.provenance as unknown as { _id?: unknown })?._id).toBeUndefined();
  });

  it('strips an unknown key rather than persisting it (stable vocabulary)', async () => {
    const doc = await createWithProvenance({ kind: 'upload', bogus: 'nope' });
    expect(JSON.parse(JSON.stringify(doc.provenance))).toEqual({ kind: 'upload' });
  });

  it('rejects an empty provenance object (kind is required)', async () => {
    await expect(createWithProvenance({})).rejects.toThrow();
  });
});
