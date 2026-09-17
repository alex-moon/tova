import request from 'supertest';
import { Types } from 'mongoose';
import { Readable } from 'stream';
import AdmZip from 'adm-zip';
import { createApp } from '../index';
import { User } from '../models/User';
import { Asset } from '../models/Asset';
import { isStorageConfigured } from '../services/storageService';

const mockPresignPut = jest.fn();
const mockPresignGet = jest.fn();
const mockHead = jest.fn();
const mockGetObjectBuffer = jest.fn();
const mockGetObjectStream = jest.fn();
const mockDeleteObject = jest.fn();

jest.mock('../services/storageService', () => ({
  isStorageConfigured: jest.fn().mockReturnValue(true),
  presignPutUrl: (...args: unknown[]) => mockPresignPut(...args),
  presignGetUrl: (...args: unknown[]) => mockPresignGet(...args),
  headObject: (...args: unknown[]) => mockHead(...args),
  getObjectBuffer: (...args: unknown[]) => mockGetObjectBuffer(...args),
  getObjectStream: (...args: unknown[]) => mockGetObjectStream(...args),
  deleteObject: (...args: unknown[]) => mockDeleteObject(...args),
}));

jest.mock('../services/titleService', () => ({
  generateChatTitle: jest.fn().mockResolvedValue('Hello'),
}));

const app = createApp();

const registerUser = async (email: string): Promise<string> => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  const cookie = response.headers['set-cookie'];
  return Array.isArray(cookie) ? cookie[0] : cookie;
};

const presignFor = (cookie: string, body: Record<string, unknown>) =>
  request(app).post('/api/assets/presign').set('Cookie', [cookie]).send(body);

const USER_A = 'assets-user-a@example.com';

const presignOk = async (
  cookie: string,
  filename: string,
  contentType = 'text/plain',
  size = 10,
): Promise<string> => {
  mockPresignPut.mockResolvedValue('https://signed.example.com/put');
  const response = await presignFor(cookie, { filename, contentType, size });
  expect(response.status).toBe(201);
  return response.body.asset.id as string;
};

const headerForObject = (size: number, contentType?: string) => ({
  size,
  ...(contentType ? { contentType } : {}),
});

const confirmFor = (cookie: string, assetId: string) =>
  request(app).post(`/api/assets/${assetId}/confirm`).set('Cookie', [cookie]).send({});

// expect(...).toBe(XXX) lines below depend on storage being "configured";
// resetAllMocks wipes module mock defaults, so re-seat the gate per test.
beforeEach(() => {
  (isStorageConfigured as jest.Mock).mockReturnValue(true);
});

describe('Assets presign', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (isStorageConfigured as jest.Mock).mockReturnValue(true);
  });

  it('mints a presigned PUT scoped to the caller and creates a pending asset', async () => {
    const cookie = await registerUser(USER_A);
    const assetId = await presignOk(cookie, 'menu.csv', 'text/csv', 123);

    const [key, expiresIn, contentType] = mockPresignPut.mock.calls[0] as [string, number, string];
    expect(expiresIn).toBe(60);
    expect(contentType).toBe('text/csv');
    const stored = await Asset.findById(assetId);
    const owner = await User.findOne({ email: USER_A });
    expect(String(stored?.userId)).toBe(String(owner?._id));
    expect(key.startsWith(`${String(owner?._id)}/`)).toBe(true);
    expect(key).toContain(`/${assetId}/menu.csv`);
    expect(stored?.status).toBe('pending');
  });

  // Pinned per #68's hard rule: zip is never an accepted upload format at
  // any layer, and ALLOWED_CONTENT_TYPES in routes/assets.ts deliberately
  // excludes it (see the comment there). If this test ever fails, an upload
  // path has started accepting archives.
  it('rejects zip uploads outright and creates nothing', async () => {
    const cookie = await registerUser('assets-zip-user@example.com');
    for (const contentType of [
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream-with-zip-name',
    ]) {
      const response = await presignFor(cookie, {
        filename: 'archive.zip',
        contentType,
        size: 100,
      });
      expect(response.status).toBe(400);
    }
    expect(await Asset.findOne({ filename: 'archive.zip' })).toBeNull();
    expect(mockPresignPut).not.toHaveBeenCalled();
  });

  it('rejects non-allowlisted content types and creates nothing', async () => {
    const cookie = await registerUser('assets-type-user@example.com');
    const response = await presignFor(cookie, {
      filename: 'evil.exe',
      contentType: 'application/x-msdownload',
      size: 10,
    });
    expect(response.status).toBe(400);
    expect(await Asset.findOne({ filename: 'evil.exe' })).toBeNull();
  });

  it('rejects oversized uploads at presign time', async () => {
    const cookie = await registerUser('assets-size-user@example.com');
    const response = await presignFor(cookie, {
      filename: 'big.bin',
      contentType: 'text/plain',
      size: 15 * 1024 * 1024 + 1,
    });
    expect(response.status).toBe(413);
  });

  it('rejects invalid filenames, sizes, and missing fields', async () => {
    const cookie = await registerUser('assets-invalid-user@example.com');
    for (const body of [
      { filename: 'x.txt', contentType: 'text/plain', size: -1 },
      { filename: 'x.txt', contentType: 'text/plain', size: 1.5 },
      { filename: '', contentType: 'text/plain', size: 10 },
      { filename: 'x.txt', contentType: 'text/plain' },
      { filename: 'x.txt', size: 10 },
    ]) {
      const response = await presignFor(cookie, body);
      expect(response.status).toBe(400);
    }
  });

  it('sanitizes path separators out of the object key', async () => {
    const cookie = await registerUser('assets-sanitize-user@example.com');
    const assetId = await presignOk(cookie, '../../etc/passwd.txt');
    const stored = await Asset.findById(assetId);
    expect(stored?.filename).not.toContain('/');
    expect(stored?.key).not.toMatch(/(^|\/)\.\.($|\/)/);
    expect(mockPresignPut.mock.calls[0]?.[0]).not.toMatch(/(^|\/)\.\.($|\/)/);
  });
});

beforeEach(() => {
  (isStorageConfigured as jest.Mock).mockReturnValue(true);
});

describe('Assets confirm', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (isStorageConfigured as jest.Mock).mockReturnValue(true);
  });

  it('marks the asset ready, stores extracted text, and reconciles size from HEAD', async () => {
    const cookie = await registerUser('assets-confirm-user@example.com');
    const assetId = await presignOk(cookie, 'notes.txt', 'text/plain', 999);

    mockHead.mockResolvedValue(headerForObject(11, 'text/plain'));
    mockGetObjectBuffer.mockResolvedValue(Buffer.from('hello world'));

    const confirm = await confirmFor(cookie, assetId);
    expect(confirm.status).toBe(200);
    expect(confirm.body.asset.status).toBe('ready');
    const stored = await Asset.findById(assetId);
    expect(stored?.textExtracted).toBe('hello world');
    expect(stored?.size).toBe(11);
  });

  it('skips extraction for non-text filenames and marks ready with null text', async () => {
    const cookie = await registerUser('assets-binary-user@example.com');
    const assetId = await presignOk(cookie, 'picture.png', 'image/png', 100);

    mockHead.mockResolvedValue(headerForObject(100, 'image/png'));
    const confirm = await confirmFor(cookie, assetId);

    expect(confirm.status).toBe(200);
    expect(mockGetObjectBuffer).not.toHaveBeenCalled();
    expect((await Asset.findById(assetId))?.textExtracted).toBeNull();
  });

  it('rejects confirm when the upload is not in storage', async () => {
    const cookie = await registerUser('assets-miss-user@example.com');
    const assetId = await presignOk(cookie, 'notes.txt');

    mockHead.mockRejectedValue({ name: 'NotFound' });
    const confirm = await confirmFor(cookie, assetId);

    expect(confirm.status).toBe(409);
    const stored = await Asset.findById(assetId);
    expect(stored?.status).toBe('failed');
    expect(stored?.failureReason).toBe('upload-not-found');
  });

  it('rejects confirm when the stored object is oversized', async () => {
    const cookie = await registerUser('assets-oversize-user@example.com');
    const assetId = await presignOk(cookie, 'notes.txt');

    mockHead.mockResolvedValue(headerForObject(15 * 1024 * 1024 + 1));
    const confirm = await confirmFor(cookie, assetId);

    expect(confirm.status).toBe(413);
    expect((await Asset.findById(assetId))?.status).toBe('failed');
  });

  it('rejects stale pending assets past the confirm window', async () => {
    const cookie = await registerUser('assets-stale-user@example.com');
    const user = await User.findOne({ email: 'assets-stale-user@example.com' });
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    // Raw update bypasses mongoose timestamps (which would rewrite createdAt).
    const created = await Asset.collection.findOneAndUpdate(
      {
        filename: 'probe-stale',
      },
      {
        $set: {
          userId: user?._id,
          filename: 'probe-stale',
          key: 'stale/probe-stale',
          contentType: 'text/plain',
          size: 10,
          status: 'pending',
          createdAt: stale,
        },
      },
      {
        upsert: true,
        returnDocument: 'after',
      },
    );
    const assetId = created ? String(created._id) : '';

    const confirm = await confirmFor(cookie, assetId);

    expect(confirm.status).toBe(409);
    expect((await Asset.findById(assetId))?.status).toBe('failed');
    expect(mockHead).not.toHaveBeenCalled();
  });

  it('rejects double confirmation', async () => {
    const cookie = await registerUser('assets-double-user@example.com');
    const assetId = await presignOk(cookie, 'notes.txt');
    await Asset.updateOne({ _id: assetId }, { status: 'ready' });

    mockHead.mockResolvedValue(headerForObject(11));
    const confirm = await confirmFor(cookie, assetId);

    expect(confirm.status).toBe(409);
  });
});

describe('Assets bulk upload', () => {
  beforeEach(async () => {
    jest.resetAllMocks();
    (isStorageConfigured as jest.Mock).mockReturnValue(true);
    mockPresignPut.mockResolvedValue('https://signed.example.com/put');
    cookieBulkUser = await registerUser('assets-bulk-user@example.com');
  });

  let cookieBulkUser = '';
  const bulkPresignFor = (cookie: string, body: unknown) =>
    request(app)
      .post('/api/assets/bulk-presign')
      .set('Cookie', [cookie])
      .send(body as object);

  const bulkConfirmFor = (cookie: string, body: unknown) =>
    request(app)
      .post('/api/assets/bulk-confirm')
      .set('Cookie', [cookie])
      .send(body as object);

  const item = (filename: string, contentType = 'text/plain', size = 10) => ({
    filename,
    contentType,
    size,
  });

  const bulkUserAssets = async () =>
    Asset.find({ userId: (await User.findOne({ email: 'assets-bulk-user@example.com' }))?._id });

  it('presigns a batch in one round-trip with per-item ok results', async () => {
    const response = await bulkPresignFor(cookieBulkUser, [
      item('a.txt'),
      item('b.csv', 'text/csv', 20),
    ]);

    expect(response.status).toBe(201);
    expect(response.body.results).toHaveLength(2);
    for (const row of response.body.results) {
      expect(row.status).toBe('ok');
      expect(row.uploadUrl).toBe('https://signed.example.com/put');
    }
    expect(mockPresignPut).toHaveBeenCalledTimes(2);
    expect(await bulkUserAssets()).toHaveLength(2);
  });

  it('returns per-item rejected rows while siblings stay ok', async () => {
    const response = await bulkPresignFor(cookieBulkUser, [
      item('good.txt'),
      item('evil.exe', 'application/x-msdownload'),
      item('toolarge.bin', 'text/plain', 15 * 1024 * 1024 + 1),
    ]);

    expect(response.status).toBe(201);
    const results = response.body.results;
    expect(results.map((r: { status: string }) => r.status)).toEqual([
      'ok',
      'rejected',
      'rejected',
    ]);
    expect(results[1].message).toBe('File type is not allowed');
    expect(results[2].message).toBe('File is too large (max 15 MB)');
    expect(await Asset.findOne({ filename: 'evil.exe' })).toBeNull();
    expect(await Asset.findOne({ filename: 'toolarge.bin' })).toBeNull();
  });

  // Pinned per #68's hard rule: zip is never an accepted upload format, even
  // as one item inside a bulk batch. Nothing is created for it, and its
  // siblings' presigns are unaffected.
  it('rejects a zip item per-item in bulk and creates nothing for it', async () => {
    const response = await bulkPresignFor(cookieBulkUser, [
      item('ok.txt'),
      item('archive.zip', 'application/zip'),
      item('archive2.zip', 'application/x-zip-compressed'),
    ]);

    expect(response.status).toBe(201);
    const results = response.body.results;
    expect(results[0].status).toBe('ok');
    expect(results[1]).toMatchObject({ status: 'rejected', message: 'File type is not allowed' });
    expect(results[2].status).toBe('rejected');
    expect(await Asset.countDocuments({ filename: { $in: ['archive.zip', 'archive2.zip'] } })).toBe(
      0,
    );
  });

  it('rejects batches over the 20-file cap with 400', async () => {
    const body = Array.from({ length: 21 }, (_, i) => item(`f${i}.txt`));
    const response = await bulkPresignFor(cookieBulkUser, body);

    expect(response.status).toBe(400);
    expect(mockPresignPut).not.toHaveBeenCalled();
    expect(await bulkUserAssets()).toHaveLength(0);
  });

  it('rejects batches whose declared total exceeds 300 MB with 413', async () => {
    const response = await bulkPresignFor(cookieBulkUser, [
      item('a.txt', 'text/plain', 299 * 1024 * 1024),
      item('b.txt', 'text/plain', 2 * 1024 * 1024),
    ]);

    expect(response.status).toBe(413);
    expect(mockPresignPut).not.toHaveBeenCalled();
  });

  it('rejects empty and malformed batches with 400', async () => {
    for (const body of [[], 'nope', [{}], [{ filename: 'x.txt', size: 5 }]]) {
      const response = await bulkPresignFor(cookieBulkUser, body);
      expect(response.status).toBe(400);
    }
    expect(await bulkUserAssets()).toHaveLength(0);
  });

  it('converts an unexpected per-item helper error into a rejected row', async () => {
    mockPresignPut.mockRejectedValueOnce({ name: 'InternalError' });
    const response = await bulkPresignFor(cookieBulkUser, [item('boom.txt'), item('fine.txt')]);

    expect(response.status).toBe(201);
    expect(response.body.results[0].status).toBe('rejected');
    expect(response.body.results[1].status).toBe('ok');
  });

  it('confirms a batch with per-item results and marks all ready', async () => {
    const assetIds = [];
    for (const filename of ['one.txt', 'two.txt']) {
      const presigned = (await presignFor(cookieBulkUser, item(filename))) as {
        status: number;
        body: { asset: { id: string } };
      };
      expect(presigned.status).toBe(201);
      assetIds.push(presigned.body.asset.id);
    }

    mockHead.mockResolvedValue(headerForObject(11, 'text/plain'));
    const response = await bulkConfirmFor(
      cookieBulkUser,
      assetIds.map((id) => ({ assetId: id })),
    );

    expect(response.status).toBe(200);
    expect(response.body.results.map((r: { status: string }) => r.status)).toEqual(['ok', 'ok']);
    for (const id of assetIds) {
      expect((await Asset.findById(id))?.status).toBe('ready');
    }
  });

  it('reports per-item confirm outcomes without blocking siblings', async () => {
    const okId = (
      (await presignFor(cookieBulkUser, item('good.txt'))) as {
        body: { asset: { id: string } };
      }
    ).body.asset.id;
    const missingId = new Types.ObjectId().toString();

    mockHead
      .mockResolvedValueOnce(headerForObject(11, 'text/plain'))
      .mockRejectedValueOnce({ name: 'NotFound' });
    const brokenId = (
      (await presignFor(cookieBulkUser, item('broken.txt'))) as {
        body: { asset: { id: string } };
      }
    ).body.asset.id;

    const response = await bulkConfirmFor(cookieBulkUser, [
      { assetId: okId },
      { assetId: missingId },
      { assetId: brokenId },
    ]);

    expect(response.status).toBe(200);
    const results = response.body.results;
    expect(results[0].status).toBe('ok');
    expect(results[0].asset.status).toBe('ready');
    expect(results[1]).toMatchObject({
      status: 'rejected',
      assetId: missingId,
      message: 'Asset not found',
    });
    expect(results[2]).toMatchObject({
      status: 'rejected',
      assetId: brokenId,
      message: 'Upload was not found in storage',
    });
    expect((await Asset.findById(brokenId))?.status).toBe('failed');
  });

  it('marks in-batch expired assets failed and reports them rejected per item', async () => {
    const okId = (
      (await presignFor(cookieBulkUser, item('fresh.txt'))) as {
        body: { asset: { id: string } };
      }
    ).body.asset.id;
    const user = await User.findOne({ email: 'assets-bulk-user@example.com' });
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const created = await Asset.collection.findOneAndUpdate(
      { filename: 'stale-bulk' },
      {
        $set: {
          userId: user?._id,
          filename: 'stale-bulk',
          key: 'stale/stale-bulk',
          contentType: 'text/plain',
          size: 10,
          status: 'pending',
          createdAt: stale,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    const staleId = created ? String(created._id) : '';

    mockHead.mockResolvedValue(headerForObject(11, 'text/plain'));
    const response = await bulkConfirmFor(cookieBulkUser, [
      { assetId: staleId },
      { assetId: okId },
    ]);

    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({
      status: 'rejected',
      message: 'Upload window has expired',
    });
    expect((await Asset.findById(staleId))?.status).toBe('failed');
    expect(response.body.results[1].status).toBe('ok');
    expect(mockHead).toHaveBeenCalledTimes(1);
  });

  it('maps already-confirmed and size-invalid confirms into per-item rows', async () => {
    const doubleId = (
      (await presignFor(cookieBulkUser, item('double.txt'))) as {
        body: { asset: { id: string } };
      }
    ).body.asset.id;
    const sizeId = (
      (await presignFor(cookieBulkUser, item('size.txt'))) as {
        body: { asset: { id: string } };
      }
    ).body.asset.id;
    await Asset.updateOne({ _id: doubleId }, { status: 'ready' });

    mockHead.mockResolvedValue(headerForObject(15 * 1024 * 1024 + 1));
    const response = await bulkConfirmFor(cookieBulkUser, [
      { assetId: doubleId },
      { assetId: sizeId },
    ]);

    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({
      status: 'rejected',
      message: 'Asset was already confirmed',
    });
    expect(response.body.results[1]).toMatchObject({
      status: 'rejected',
      message: 'Stored file size is invalid',
    });
    expect((await Asset.findById(sizeId))?.status).toBe('failed');
  });

  it('keeps ownership isolation per item: a foreign assetId is a rejected row, not 404', async () => {
    const cookieOther = await registerUser('assets-bulk-other@example.com');
    const foreignId = await presignOk(cookieOther, 'secret.txt');
    const ownId = (
      (await presignFor(cookieBulkUser, item('mine.txt'))) as {
        body: { asset: { id: string } };
      }
    ).body.asset.id;

    mockHead.mockResolvedValue(headerForObject(11));
    const response = await bulkConfirmFor(cookieBulkUser, [
      { assetId: foreignId },
      { assetId: ownId },
    ]);

    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({
      status: 'rejected',
      message: 'Asset not found',
    });
    expect(response.body.results[1].status).toBe('ok');
    expect((await Asset.findById(foreignId))?.status).toBe('pending');
  });

  it('rejects bulk confirm with malformed or oversized id arrays with 400', async () => {
    for (const body of [
      [],
      'nope',
      [{ assetId: '' }],
      Array.from({ length: 21 }, () => ({ assetId: 'x' })),
    ]) {
      const response = await bulkConfirmFor(cookieBulkUser, body);
      expect(response.status).toBe(400);
    }
  });

  it('rejects guest bulk requests entirely', async () => {
    expect(
      (
        await request(app)
          .post('/api/assets/bulk-presign')
          .send([item('x.txt')])
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/assets/bulk-confirm')
          .send([{ assetId: 'x' }])
      ).status,
    ).toBe(401);
  });
});

describe('Assets ownership isolation', () => {
  let cookieA: string;
  let cookieB: string;
  let assetId: string;

  beforeEach(async () => {
    jest.resetAllMocks();
    (isStorageConfigured as jest.Mock).mockReturnValue(true);
    cookieA = await registerUser('assets-iso-a@example.com');
    cookieB = await registerUser('assets-user-b-isolated@example.com');

    const userA = await User.findOne({ email: 'assets-iso-a@example.com' });
    const id = new Types.ObjectId();
    await Asset.create({
      _id: id,
      userId: userA?._id,
      filename: 'secret.txt',
      key: `${String(userA?._id)}/${String(id)}/secret.txt`,
      contentType: 'text/plain',
      size: 10,
      status: 'ready',
      textExtracted: 'top secret',
    });
    assetId = String(id);

    mockPresignGet.mockResolvedValue('https://signed.example.com/get');
    mockDeleteObject.mockResolvedValue(true);
  });

  it('lists only the caller assets', async () => {
    const listA = await request(app).get('/api/assets').set('Cookie', [cookieA]);
    expect(listA.status).toBe(200);
    expect(listA.body.assets).toHaveLength(1);
    expect(listA.body.assets[0].id).toBe(assetId);

    const listB = await request(app).get('/api/assets').set('Cookie', [cookieB]);
    expect(listB.body.assets).toHaveLength(0);
  });

  it('prevents user B from downloading user A asset', async () => {
    const response = await request(app).get(`/api/assets/${assetId}/url`).set('Cookie', [cookieB]);
    expect(response.status).toBe(404);
    expect(mockPresignGet).not.toHaveBeenCalled();

    const own = await request(app).get(`/api/assets/${assetId}/url`).set('Cookie', [cookieA]);
    expect(own.status).toBe(200);
    expect(own.body.url).toBe('https://signed.example.com/get');
  });

  it('prevents user B from confirming user A pending asset', async () => {
    await Asset.updateOne({ _id: assetId }, { status: 'pending' });
    mockHead.mockResolvedValue(headerForObject(10));
    const response = await confirmFor(cookieB, assetId);
    expect(response.status).toBe(404);
    expect((await Asset.findById(assetId))?.status).toBe('pending');
  });

  it('prevents user B from deleting user A asset', async () => {
    const response = await request(app).delete(`/api/assets/${assetId}`).set('Cookie', [cookieB]);
    expect(response.status).toBe(404);
    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(await Asset.findById(assetId)).not.toBeNull();
  });

  it('deletes the doc without touching storage', async () => {
    const response = await request(app).delete(`/api/assets/${assetId}`).set('Cookie', [cookieA]);
    expect(response.status).toBe(200);
    expect(await Asset.findById(assetId)).toBeNull();
    // Decided #69 review: Spaces objects stay resident, so nothing deletes.
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it('rejects guest requests entirely', async () => {
    expect((await request(app).get('/api/assets')).status).toBe(401);
  });
});

describe('Assets bulk download', () => {
  let cookieA: string;

  const createReadyAsset = async (
    ownerEmail: string,
    filename: string,
    content: string,
    size = content.length,
  ): Promise<string> => {
    const user = await User.findOne({ email: ownerEmail });
    const id = new Types.ObjectId();
    await Asset.create({
      _id: id,
      userId: user?._id,
      filename,
      key: `${String(user?._id)}/${String(id)}/${filename}`,
      contentType: 'text/plain',
      size,
      status: 'ready',
    });
    return String(id);
  };

  const bulkRequest = (cookie: string, ids: string[]) =>
    request(app)
      .get(`/api/assets/bulk-download?${ids.map((id) => `id=${id}`).join('&')}`)
      .set('Cookie', [cookie]);

  const requestZip = async (cookie: string, ids: string[]) => {
    const response = await request(app)
      .get(`/api/assets/bulk-download?${ids.map((id) => `id=${id}`).join('&')}`)
      .set('Cookie', [cookie])
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    return response;
  };

  beforeEach(async () => {
    // The suite-wide beforeEach wipes collections between tests, so users
    // (and their assets) must be created per test, not in beforeAll.
    cookieA = await registerUser('assets-bulk-a@example.com');
    await registerUser('assets-bulk-b@example.com');
  });

  beforeEach(() => {
    jest.resetAllMocks();
    (isStorageConfigured as jest.Mock).mockReturnValue(true);
    mockDeleteObject.mockResolvedValue(true);
    mockPresignGet.mockResolvedValue('https://signed.example.com/get');
  });

  it('rejects a missing id parameter', async () => {
    const response = await request(app).get('/api/assets/bulk-download').set('Cookie', [cookieA]);
    expect(response.status).toBe(400);
  });

  it('rejects more than 50 ids', async () => {
    const ids = Array.from({ length: 51 }, () => String(new Types.ObjectId()));
    const response = await bulkRequest(cookieA, ids);
    expect(response.status).toBe(400);
    expect(response.body.message).toContain('50');
  });

  it('ignores malformed ids instead of falling back to the whole library', async () => {
    // Regression: filtering ids by isValidObjectId used to leave an empty
    // $in set, turning the find into {userId, status:'ready'} — i.e. a
    // download of the caller's entire library from `?id=garbage`.
    await createReadyAsset('assets-bulk-a@example.com', 'owned.txt', 'x');
    const response = await bulkRequest(cookieA, [
      new Types.ObjectId().toHexString().slice(0, -1) + 'z',
      'not-an-object-id',
    ]);
    expect(response.status).toBe(400);
    expect(mockGetObjectStream).not.toHaveBeenCalled();
  });

  it('returns 400 when no owned assets survive selection', async () => {
    const foreignId = await createReadyAsset('assets-bulk-b@example.com', 'secret.txt', 'x');
    // Owned-by-nobody + foreign id: nothing belongs to the caller.
    const response = await bulkRequest(cookieA, [String(new Types.ObjectId()), foreignId]);
    expect(response.status).toBe(400);
    expect(mockGetObjectStream).not.toHaveBeenCalled();
  });

  it('skips assets that are not ready', async () => {
    const pendingId = await createReadyAsset('assets-bulk-a@example.com', 'later.txt', 'x');
    await Asset.updateOne({ _id: pendingId }, { status: 'pending' });
    const response = await bulkRequest(cookieA, [pendingId]);
    expect(response.status).toBe(400);
  });

  it('rejects selections whose stored sizes exceed the 500 MB cap', async () => {
    const hugeId = await createReadyAsset(
      'assets-bulk-a@example.com',
      'huge.bin',
      'x',
      500 * 1024 * 1024 + 1,
    );
    const response = await bulkRequest(cookieA, [hugeId]);
    expect(response.status).toBe(413);
    expect(mockGetObjectStream).not.toHaveBeenCalled();
  });

  it('streams only owned assets into a valid zip with content matching storage', async () => {
    const assetA = await createReadyAsset('assets-bulk-a@example.com', 'first.txt', 'alpha');
    const assetB = await createReadyAsset('assets-bulk-b@example.com', 'second.txt', 'bravo');
    mockGetObjectStream.mockImplementation(async () => Readable.from(Buffer.from('alpha')));

    const response = await requestZip(cookieA, [assetA, assetB]);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/zip');
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="assets-.*\.zip"$/,
    );

    const zip = new AdmZip(response.body);
    const entries = zip.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]?.entryName).toBe('first.txt');
    expect(entries[0]?.getData().toString()).toBe('alpha');

    // Only the owned stream was read.
    const keys = mockGetObjectStream.mock.calls.map((call) => call[0] as string);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(`${assetA}/first.txt`);
  });

  it('disambiguates duplicate filenames as name (2).ext', async () => {
    const asset1 = await createReadyAsset('assets-bulk-a@example.com', 'dup.txt', 'one');
    const asset2 = await createReadyAsset('assets-bulk-a@example.com', 'dup.txt', 'two');
    const asset3 = await createReadyAsset('assets-bulk-a@example.com', 'dup.txt', 'three');
    const contentById = new Map([
      [asset1, 'one'],
      [asset2, 'two'],
      [asset3, 'three'],
    ]);
    mockGetObjectStream.mockImplementation(async (key: string) => {
      const assetId = key.split('/')[1] ?? '';
      return Readable.from(Buffer.from(contentById.get(assetId) ?? ''));
    });

    const response = await requestZip(cookieA, [asset1, asset2, asset3]);
    expect(response.status).toBe(200);
    const names = new AdmZip(response.body)
      .getEntries()
      .map((entry) => entry.entryName)
      .sort();
    expect(names).toEqual(['dup (2).txt', 'dup (3).txt', 'dup.txt']);
  });

  it('propagates a storage stream failure as a 502 before headers are sent', async () => {
    const assetId = await createReadyAsset('assets-bulk-a@example.com', 'broken.txt', 'x');
    mockGetObjectStream.mockRejectedValue({ name: 'InternalError' });
    const response = await bulkRequest(cookieA, [assetId]);
    expect(response.status).toBe(502);
  });
});
