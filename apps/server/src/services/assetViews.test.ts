import mongoose from 'mongoose';
import { Asset } from '../models/Asset';
import { safeAsset, previewAsset } from './assetViews';

const createAsset = (provenance?: Record<string, unknown>) =>
  Asset.create({
    userId: new mongoose.Types.ObjectId(),
    filename: 'notes.md',
    key: 'u/000000000000000000000000/notes.md',
    contentType: 'text/markdown',
    size: 1,
    status: 'ready',
    textExtracted: '# hello',
    ...(provenance ? { provenance } : {}),
  });

describe('assetViews provenance (#252)', () => {
  it('safeAsset serialises absent provenance as explicit null', async () => {
    const doc = await createAsset();
    expect((safeAsset(doc) as { provenance: unknown }).provenance).toBeNull();
  });

  it('safeAsset serialises a stamped provenance object', async () => {
    const sessionId = new mongoose.Types.ObjectId().toString();
    const doc = await createAsset({ kind: 'chat', sessionId });
    expect(
      JSON.parse(JSON.stringify((safeAsset(doc) as { provenance: unknown }).provenance)),
    ).toEqual({ kind: 'chat', sessionId });
  });

  it('previewAsset serialises absent provenance as explicit null', async () => {
    const doc = await createAsset();
    expect((previewAsset(doc) as { provenance: unknown }).provenance).toBeNull();
  });

  it('previewAsset serialises an upload provenance object', async () => {
    const doc = await createAsset({ kind: 'upload' });
    expect(
      JSON.parse(JSON.stringify((previewAsset(doc) as { provenance: unknown }).provenance)),
    ).toEqual({ kind: 'upload' });
  });
});

describe('assetViews version (#325)', () => {
  it('defaults to 1 for a legacy asset with no version field', async () => {
    const doc = await createAsset();
    expect((safeAsset(doc) as { version: number }).version).toBe(1);
    expect((previewAsset(doc) as { version: number }).version).toBe(1);
  });

  it('surfaces the stored version', async () => {
    const doc = await createAsset();
    doc.version = 3;
    expect((safeAsset(doc) as { version: number }).version).toBe(3);
    expect((previewAsset(doc) as { version: number }).version).toBe(3);
  });
});
