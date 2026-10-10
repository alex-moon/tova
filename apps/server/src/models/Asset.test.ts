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
