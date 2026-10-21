import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../../../main/index';
import { User } from '../../../main/models/User';
import { Asset } from '../../../main/models/Asset';
import { isStorageConfigured } from '../../../main/services/storageService';
import { CONFIRM_MAX_AGE_MS } from '../../../main/services/asset/assetLimits';
import {
  MAX_PENDING_ASSETS,
  presignItemForUser,
  sweepStalePendingAssets,
} from '../../../main/services/asset/assetPresign';

// Presign lifecycle: quota, reserved names, pending TTL, stale sweep.
// @see #396

const mockPresignPut = jest.fn();
const mockDeleteObject = jest.fn();

jest.mock('../../../main/services/storageService', () => ({
  isStorageConfigured: jest.fn().mockReturnValue(true),
  presignPutUrl: (...args: unknown[]) => mockPresignPut(...args),
  deleteObject: (...args: unknown[]) => mockDeleteObject(...args),
}));

jest.mock('../../../main/services/asset/assetJobService', () => ({
  enqueueAssetJob: jest.fn(),
}));

const app = createApp();

const registerUser = async (email: string): Promise<string> => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  const cookie = response.headers['set-cookie'];
  return Array.isArray(cookie) ? cookie[0] : cookie;
};

beforeEach(() => {
  jest.resetAllMocks();
  (isStorageConfigured as jest.Mock).mockReturnValue(true);
  mockPresignPut.mockResolvedValue('https://signed.example.com/put');
  mockDeleteObject.mockResolvedValue(true);
});

describe('presignItemForUser (#396)', () => {
  it('rejects path-relative dot-segment filenames', async () => {
    for (const filename of ['..', '.', '   ']) {
      const result = await presignItemForUser(new Types.ObjectId().toString(), {
        filename,
        contentType: 'text/plain',
        size: 10,
      });
      expect(result).toMatchObject({ status: 'rejected', code: 400 });
    }
  });

  it('caps live pending rows per user', async () => {
    const userId = new Types.ObjectId().toString();
    for (let i = 0; i < MAX_PENDING_ASSETS; i += 1) {
      const result = await presignItemForUser(userId, {
        filename: `f${i}.txt`,
        contentType: 'text/plain',
        size: 10,
      });
      expect(result.status).toBe('ok');
    }
    const over = await presignItemForUser(userId, {
      filename: 'over.txt',
      contentType: 'text/plain',
      size: 10,
    });
    expect(over).toMatchObject({ status: 'rejected', code: 429 });
    expect(await Asset.countDocuments({ userId, status: 'pending' })).toBe(MAX_PENDING_ASSETS);
  });

  it('sets a pending TTL that outlives the confirm window', async () => {
    const result = await presignItemForUser(new Types.ObjectId().toString(), {
      filename: 'ttl.txt',
      contentType: 'text/plain',
      size: 10,
    });
    if (result.status !== 'ok') throw new Error('presign failed');
    const row = await Asset.findById(result.asset.id);
    const ttl = (row?.expiresAt?.getTime() ?? 0) - new Date(row!.createdAt).getTime();
    expect(ttl).toBeGreaterThanOrEqual(CONFIRM_MAX_AGE_MS);
  });

  it('bounds concurrent presigns to the pending quota (#396)', async () => {
    const userId = new Types.ObjectId().toString();
    // All pass a pre-create count check together; the quota must still hold.
    await Promise.all(
      Array.from({ length: MAX_PENDING_ASSETS + 20 }, (_, i) =>
        presignItemForUser(userId, {
          filename: `race-${i}.txt`,
          contentType: 'text/plain',
          size: 10,
        }),
      ),
    );
    expect(await Asset.countDocuments({ userId, status: 'pending' })).toBeLessThanOrEqual(
      MAX_PENDING_ASSETS,
    );
  });
});

describe('sweepStalePendingAssets (#396)', () => {
  it('deletes stale pending rows with their objects, spares fresh rows', async () => {
    const email = 'presign-sweep@example.com';
    await registerUser(email);
    const user = await User.findOne({ email });
    const staleId = new Types.ObjectId();
    const freshId = new Types.ObjectId();
    await Asset.create({
      _id: staleId,
      userId: user?._id,
      filename: 'stale.txt',
      key: `u/${String(staleId)}/stale.txt`,
      contentType: 'text/plain',
      size: 10,
      status: 'pending',
      createdAt: new Date(Date.now() - CONFIRM_MAX_AGE_MS - 1000),
    });
    await Asset.create({
      _id: freshId,
      userId: user?._id,
      filename: 'fresh.txt',
      key: `u/${String(freshId)}/fresh.txt`,
      contentType: 'text/plain',
      size: 10,
      status: 'pending',
    });

    const swept = await sweepStalePendingAssets();
    expect(swept).toBe(1);
    expect(mockDeleteObject).toHaveBeenCalledWith(`u/${String(staleId)}/stale.txt`);
    expect(await Asset.findById(staleId)).toBeNull();
    expect(await Asset.findById(freshId)).not.toBeNull();
  });

  it('never sweeps a row that confirmed concurrently', async () => {
    const email = 'presign-sweep-race@example.com';
    await registerUser(email);
    const user = await User.findOne({ email });
    const id = new Types.ObjectId();
    await Asset.create({
      _id: id,
      userId: user?._id,
      filename: 'raced.txt',
      key: `u/${String(id)}/raced.txt`,
      contentType: 'text/plain',
      size: 10,
      status: 'pending',
      createdAt: new Date(Date.now() - CONFIRM_MAX_AGE_MS - 1000),
    });
    // The confirm wins between the sweep's find and its delete: the row is
    // no longer pending, so the guarded delete matches nothing.
    await Asset.updateOne({ _id: id }, { status: 'ready' });
    expect(await sweepStalePendingAssets()).toBe(0);
    expect(await Asset.findById(id)).not.toBeNull();
  });

  it('keeps the object when a confirm lands mid-sweep (#396)', async () => {
    const email = 'presign-sweep-interleave@example.com';
    await registerUser(email);
    const user = await User.findOne({ email });
    const id = new Types.ObjectId();
    const key = `u/${String(id)}/raced.txt`;
    await Asset.create({
      _id: id,
      userId: user?._id,
      filename: 'raced.txt',
      key,
      contentType: 'text/plain',
      size: 10,
      status: 'pending',
      createdAt: new Date(Date.now() - CONFIRM_MAX_AGE_MS - 1000),
    });
    // The confirm lands after the sweep's find captured the key but before
    // the row delete: the row survives, so its object must survive too.
    const realDeleteOne = Asset.deleteOne.bind(Asset);
    const confirmWinsFirst = async (...args: Parameters<typeof Asset.deleteOne>) => {
      await Asset.updateOne({ _id: id }, { status: 'ready' });
      return realDeleteOne(...args);
    };
    const spy = jest
      .spyOn(Asset, 'deleteOne')
      .mockImplementationOnce(confirmWinsFirst as unknown as typeof Asset.deleteOne);
    try {
      expect(await sweepStalePendingAssets()).toBe(0);
      expect(mockDeleteObject).not.toHaveBeenCalled();
      expect(await Asset.findById(id)).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
