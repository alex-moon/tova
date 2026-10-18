import request from 'supertest';
import { Types } from 'mongoose';
import { Readable } from 'stream';
import AdmZip from 'adm-zip';
import { createApp } from '../../main/index';
import { User } from '../../main/models/User';
import { Asset } from '../../main/models/Asset';
import { AssetVersion } from '../../main/models/AssetVersion';
import { isStorageConfigured } from '../../main/services/storageService';
import { AssetJob } from '../../main/models/AssetJob';

const mockPresignPut = jest.fn();
const mockPresignGet = jest.fn();
const mockHead = jest.fn();
const mockGetObjectBuffer = jest.fn();
const mockGetObjectStream = jest.fn();
const mockDeleteObject = jest.fn();
const mockEnqueueAssetJob = jest.fn();
const mockPutObject = jest.fn();

jest.mock('../../main/services/storageService', () => ({
  isStorageConfigured: jest.fn().mockReturnValue(true),
  presignPutUrl: (...args: unknown[]) => mockPresignPut(...args),
  presignGetUrl: (...args: unknown[]) => mockPresignGet(...args),
  headObject: (...args: unknown[]) => mockHead(...args),
  getObjectBuffer: (...args: unknown[]) => mockGetObjectBuffer(...args),
  getObjectStream: (...args: unknown[]) => mockGetObjectStream(...args),
  deleteObject: (...args: unknown[]) => mockDeleteObject(...args),
  putObject: (...args: unknown[]) => mockPutObject(...args),
}));

// Enqueue mocked so confirm tests can simulate failure; defaults to real.
jest.mock('../../main/services/assetJobService', () => {
  const actual = jest.requireActual('../../main/services/assetJobService');
  return {
    ...actual,
    enqueueAssetJob: (assetId: unknown) => mockEnqueueAssetJob(assetId),
  };
});
const actualAssetJobService = jest.requireActual('../../main/services/assetJobService');

jest.mock('../../main/services/titleService', () => ({
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

// The toBe(XXX) lines need storage "configured"; re-seat the gate per test.
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

  // Zip is never accepted at any layer; this guards an archive-accepting path.
  // @see #68
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

  it('stores the full extracted text, not a 12k prompt-truncated copy (#341)', async () => {
    const cookie = await registerUser('assets-fulltext-user@example.com');
    const body = 'x'.repeat(13_000);
    const assetId = await presignOk(cookie, 'long.txt', 'text/plain', body.length);

    mockHead.mockResolvedValue(headerForObject(body.length, 'text/plain'));
    mockGetObjectBuffer.mockResolvedValue(Buffer.from(body));

    const confirm = await confirmFor(cookie, assetId);
    expect(confirm.status).toBe(200);
    expect((await Asset.findById(assetId))?.textExtracted).toBe(body);
  });

  it('embeds extracted text on confirm but never for an ephemeral upload (#294)', async () => {
    const enqueueEmbed = jest.spyOn(
      jest.requireActual<typeof import('../../main/services/workspaceEmbeddingIngest')>(
        '../../main/services/workspaceEmbeddingIngest',
      ),
      'enqueueWorkspaceEmbedding',
    );
    process.env.WORKSPACE_MEMORY_ENABLED = '1';
    const email = 'assets-embed-user@example.com';
    const cookie = await registerUser(email);
    const user = await User.findOne({ email });

    try {
      const durableId = await presignOk(cookie, 'notes.txt', 'text/plain', 11);
      mockHead.mockResolvedValue(headerForObject(11, 'text/plain'));
      mockGetObjectBuffer.mockResolvedValue(Buffer.from('hello world'));
      await confirmFor(cookie, durableId);
      expect(enqueueEmbed).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'file', sourceId: durableId }),
      );

      enqueueEmbed.mockClear();

      // An ephemeral (ZDR) upload must never produce durable derived data.
      const ephemeral = await Asset.create({
        userId: user?._id,
        filename: 'secret.txt',
        key: 'ephemeral-key',
        contentType: 'text/plain',
        size: 11,
        status: 'pending',
        ephemeral: true,
      });
      mockHead.mockResolvedValue(headerForObject(11, 'text/plain'));
      mockGetObjectBuffer.mockResolvedValue(Buffer.from('hello world'));
      const confirmed = await confirmFor(cookie, String(ephemeral._id));
      expect(confirmed.status).toBe(200);
      expect(enqueueEmbed).not.toHaveBeenCalled();
    } finally {
      delete process.env.WORKSPACE_MEMORY_ENABLED;
      enqueueEmbed.mockRestore();
    }
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

  // Zip is never accepted, even as one bulk item; siblings are unaffected.
  // @see #68
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

describe('Assets confirm markdown conversion queue (#67)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (isStorageConfigured as jest.Mock).mockReturnValue(true);
    // Forward by default; only the enqueue-failure test overrides this.
    mockEnqueueAssetJob.mockImplementation((assetId: unknown) =>
      actualAssetJobService.enqueueAssetJob(assetId),
    );
  });

  it('a convertible upload goes ready immediately and enqueues one conversion job', async () => {
    const cookie = await registerUser('assets-convert-quote@example.com');
    const assetId = await presignOk(cookie, 'contract.pdf', 'application/pdf', 5000);

    mockHead.mockResolvedValue(headerForObject(5000, 'application/pdf'));
    const confirm = await confirmFor(cookie, assetId);

    expect(confirm.status).toBe(200);
    expect(confirm.body.asset.status).toBe('ready');
    expect(confirm.body.asset.markdownStatus).toBe('pending');
    const stored = await Asset.findById(assetId);
    expect(stored?.markdownStatus).toBe('pending');
    expect(mockGetObjectBuffer).not.toHaveBeenCalled();
    const job = await AssetJob.findOne({ assetId });
    expect(job?.status).toBe('pending');
  });

  it('fast-path text assets do not enqueue a job', async () => {
    const cookie = await registerUser('assets-fastpath@example.com');
    const assetId = await presignOk(cookie, 'notes.txt', 'text/plain', 11);

    mockHead.mockResolvedValue(headerForObject(11, 'text/plain'));
    mockGetObjectBuffer.mockResolvedValue(Buffer.from('hello world'));
    const confirm = await confirmFor(cookie, assetId);

    expect(confirm.status).toBe(200);
    expect(confirm.body.asset.markdownStatus).toBe('none');
    expect(await AssetJob.countDocuments({ assetId })).toBe(0);
  });

  it('image uploads queue thumbnail and OCR jobs (#208, #209)', async () => {
    const cookie = await registerUser('assets-image@example.com');
    const assetId = await presignOk(cookie, 'picture.png', 'image/png', 100);

    mockHead.mockResolvedValue(headerForObject(100, 'image/png'));
    const confirm = await confirmFor(cookie, assetId);

    expect(confirm.status).toBe(200);
    const stored = await Asset.findById(assetId);
    // Images drive markdown via OCR plus thumbnail; one job covers both.
    // @see #209 #208
    expect(stored?.markdownStatus).toBe('pending');
    expect(stored?.thumbnailStatus).toBe('pending');
    expect(await AssetJob.countDocuments({ assetId })).toBe(1);
  });

  it('a failed enqueue downgrades the asset to none instead of a stuck pending (#67)', async () => {
    mockEnqueueAssetJob.mockRejectedValueOnce(new Error('enqueue blip'));
    const cookie = await registerUser('assets-enqueue-fail@example.com');
    const assetId = await presignOk(cookie, 'doc.pdf', 'application/pdf', 100);

    mockHead.mockResolvedValue(headerForObject(100, 'application/pdf'));
    const confirm = await confirmFor(cookie, assetId);

    expect(confirm.status).toBe(200);
    const stored = await Asset.findById(assetId);
    expect(stored?.status).toBe('ready');
    expect(stored?.markdownStatus).toBe('none');
    expect(await AssetJob.countDocuments({ assetId })).toBe(0);
  });

  it('a failed enqueue for an image reverts the thumbnail status to none (#208)', async () => {
    mockEnqueueAssetJob.mockRejectedValueOnce(new Error('enqueue blip'));
    const cookie = await registerUser('assets-thumb-enqueue-fail@example.com');
    const assetId = await presignOk(cookie, 'pic.png', 'image/png', 100);

    mockHead.mockResolvedValue(headerForObject(100, 'image/png'));
    const confirm = await confirmFor(cookie, assetId);

    expect(confirm.status).toBe(200);
    const stored = await Asset.findById(assetId);
    expect(stored?.status).toBe('ready');
    expect(stored?.thumbnailStatus).toBe('none');
    expect(stored?.thumbnailKey).toBeNull();
    // The same job carries OCR, so the markdown lifecycle must revert too.
    // @see #209
    expect(stored?.markdownStatus).toBe('none');
    expect(await AssetJob.countDocuments({ assetId })).toBe(0);
  });
});

describe('Agent-side asset visibility (#340)', () => {
  const seedRowsFor = async (email: string): Promise<string> => {
    const cookie = await registerUser(email);
    const user = await User.findOne({ email });
    await Asset.create({
      userId: user?._id,
      filename: 'library-file.md',
      key: `k/${String(user?._id)}/library-file.md`,
      contentType: 'text/markdown',
      size: 12,
      status: 'ready',
    });
    await Asset.create({
      userId: user?._id,
      filename: 'web-example.com-page.md',
      key: `agent-side/${String(user?._id)}/web-example.com-page.md`,
      contentType: 'text/markdown',
      size: 12,
      status: 'ready',
      origin: 'system-side',
      textExtracted: '# scraped page',
      sourceUrl: 'https://example.com/',
    });
    return cookie;
  };

  it('the default listing (library view and attach picker) never offers agent-side rows', async () => {
    const cookie = await seedRowsFor('assets-agentside-default@example.com');
    const response = await request(app).get('/api/assets').set('Cookie', [cookie]);
    const names = response.body.assets.map((row: { filename: string }) => row.filename);
    expect(names).toContain('library-file.md');
    expect(names).not.toContain('web-example.com-page.md');
  });

  it('?origin=system-side lists only the agent-side rows (the opt-in tab)', async () => {
    const cookie = await seedRowsFor('assets-agentside-tab@example.com');
    const response = await request(app)
      .get('/api/assets?origin=system-side')
      .set('Cookie', [cookie]);
    const names = response.body.assets.map((row: { filename: string }) => row.filename);
    expect(names).toEqual(['web-example.com-page.md']);
  });

  it('the agent-side payload carries origin so the viewer can hide object actions', async () => {
    const cookie = await seedRowsFor('assets-agentside-origin@example.com');
    const response = await request(app)
      .get('/api/assets?origin=system-side')
      .set('Cookie', [cookie]);
    expect(response.body.assets[0].origin).toBe('system-side');
  });
});

describe('Asset hasText & failureReason serialization (issue #83)', () => {
  const seedAssetFor = async (email: string, extra: Record<string, unknown>): Promise<string> => {
    const cookie = await registerUser(email);
    const user = await User.findOne({ email });
    const id = new Types.ObjectId();
    await Asset.create({
      _id: id,
      userId: user?._id,
      filename: 'report.pdf',
      key: `k/${String(id)}/report.pdf`,
      contentType: 'application/pdf',
      size: 12,
      status: 'ready',
      ...extra,
    });
    return cookie;
  };

  it('a markdown-only converted asset counts as hasText: true', async () => {
    const cookie = await seedAssetFor('assets-hastext-md@example.com', {
      textExtracted: null,
      markdownExtracted: '# converted report',
      markdownStatus: 'ready',
    });
    const response = await request(app).get('/api/assets').set('Cookie', [cookie]);
    expect(response.status).toBe(200);
    const asset = response.body.assets.find(
      (row: { filename: string }) => row.filename === 'report.pdf',
    );
    expect(asset.hasText).toBe(true);
    expect(asset.markdownStatus).toBe('ready');
    expect(asset.markdownFailureReason).toBeNull();
  });

  it('a genuinely textless asset still reports hasText: false', async () => {
    const cookie = await seedAssetFor('assets-hastext-none@example.com', {
      textExtracted: null,
      markdownExtracted: null,
      markdownStatus: 'none',
    });
    const response = await request(app).get('/api/assets').set('Cookie', [cookie]);
    const asset = response.body.assets[0];
    expect(asset.hasText).toBe(false);
  });

  it('fast-path extracted text still reports hasText: true', async () => {
    const cookie = await seedAssetFor('assets-hastext-fast@example.com', {
      textExtracted: 'plain text',
      markdownStatus: 'none',
    });
    const response = await request(app).get('/api/assets').set('Cookie', [cookie]);
    const asset = response.body.assets[0];
    expect(asset.hasText).toBe(true);
  });

  it('a failed conversion surfaces its markdownFailureReason, never the text', async () => {
    const cookie = await seedAssetFor('assets-hastext-fail@example.com', {
      textExtracted: null,
      markdownExtracted: null,
      markdownStatus: 'failed',
      markdownFailureReason: 'converter exploded',
    });
    const response = await request(app).get('/api/assets').set('Cookie', [cookie]);
    const asset = response.body.assets[0];
    expect(asset.markdownStatus).toBe('failed');
    expect(asset.markdownFailureReason).toBe('converter exploded');
    expect(asset.hasText).toBe(false);
    // No markdown text content may reach the client payload.
    expect(JSON.stringify(response.body)).not.toContain('converted report');
  });
});

describe('Asset content viewer (issue #197)', () => {
  const seedAssetFor = async (
    email: string,
    extra: Record<string, unknown>,
  ): Promise<{ cookie: string; id: string }> => {
    const cookie = await registerUser(email);
    const user = await User.findOne({ email });
    const id = new Types.ObjectId();
    await Asset.create({
      _id: id,
      userId: user?._id,
      filename: 'report.pdf',
      key: `k/${String(id)}/report.pdf`,
      contentType: 'application/pdf',
      size: 12,
      status: 'ready',
      ...extra,
    });
    return { cookie, id: String(id) };
  };

  it('returns the converted markdown body for a converted document', async () => {
    const { cookie, id } = await seedAssetFor('assets-content-md@example.com', {
      textExtracted: null,
      markdownExtracted: '# converted report',
      markdownStatus: 'ready',
    });
    const response = await request(app).get(`/api/assets/${id}/content`).set('Cookie', [cookie]);
    expect(response.status).toBe(200);
    expect(response.body.asset).toMatchObject({
      id,
      filename: 'report.pdf',
      content: '# converted report',
      format: 'markdown',
      markdownStatus: 'ready',
    });
  });

  it('prefers fast-path extracted text and reports format text', async () => {
    const { cookie, id } = await seedAssetFor('assets-content-txt@example.com', {
      textExtracted: 'plain report body',
      markdownStatus: 'none',
    });
    const response = await request(app).get(`/api/assets/${id}/content`).set('Cookie', [cookie]);
    expect(response.status).toBe(200);
    expect(response.body.asset.content).toBe('plain report body');
    expect(response.body.asset.format).toBe('text');
  });

  it('renders a Markdown upload as format markdown even though its body is in textExtracted', async () => {
    const cookie = await registerUser('assets-content-markdown-file@example.com');
    const user = await User.findOne({ email: 'assets-content-markdown-file@example.com' });
    const id = new Types.ObjectId();
    await Asset.create({
      _id: id,
      userId: user?._id,
      filename: 'README.md',
      key: `k/${String(id)}/README.md`,
      contentType: 'text/markdown',
      size: 12,
      status: 'ready',
      textExtracted: '# Title',
      markdownStatus: 'none',
    });
    const response = await request(app)
      .get(`/api/assets/${String(id)}/content`)
      .set('Cookie', [cookie]);
    expect(response.status).toBe(200);
    expect(response.body.asset.format).toBe('markdown');
    expect(response.body.asset.content).toBe('# Title');
  });

  it('returns null content when nothing was extracted', async () => {
    const { cookie, id } = await seedAssetFor('assets-content-none@example.com', {
      textExtracted: null,
      markdownExtracted: null,
      markdownStatus: 'none',
    });
    const response = await request(app).get(`/api/assets/${id}/content`).set('Cookie', [cookie]);
    expect(response.status).toBe(200);
    expect(response.body.asset.content).toBeNull();
    expect(response.body.asset.format).toBe('text');
  });

  it('surfaces the failure reason without content on a failed conversion', async () => {
    const { cookie, id } = await seedAssetFor('assets-content-fail@example.com', {
      textExtracted: null,
      markdownExtracted: null,
      markdownStatus: 'failed',
      markdownFailureReason: 'converter exploded',
    });
    const response = await request(app).get(`/api/assets/${id}/content`).set('Cookie', [cookie]);
    expect(response.status).toBe(200);
    expect(response.body.asset.content).toBeNull();
    expect(response.body.asset.markdownFailureReason).toBe('converter exploded');
  });

  it('404s for another user and 401s for a guest', async () => {
    const { id } = await seedAssetFor('assets-content-owner@example.com', {
      textExtracted: 'owned',
    });
    const otherCookie = await registerUser('assets-content-other@example.com');
    const cross = await request(app).get(`/api/assets/${id}/content`).set('Cookie', [otherCookie]);
    expect(cross.status).toBe(404);

    const guest = await request(app).get(`/api/assets/${id}/content`);
    expect(guest.status).toBe(401);
  });

  it('404s for an unknown id without leaking content', async () => {
    const cookie = await registerUser('assets-content-missing@example.com');
    const response = await request(app)
      .get(`/api/assets/${new Types.ObjectId().toString()}/content`)
      .set('Cookie', [cookie]);
    expect(response.status).toBe(404);
  });
});

describe('Asset thumbnail URL (issue #208)', () => {
  const seedImage = async (
    email: string,
    extra: Record<string, unknown>,
  ): Promise<{ cookie: string; id: string }> => {
    const cookie = await registerUser(email);
    const user = await User.findOne({ email });
    const id = new Types.ObjectId();
    await Asset.create({
      _id: id,
      userId: user?._id,
      filename: 'photo.png',
      key: `k/${String(id)}/photo.png`,
      contentType: 'image/png',
      size: 100,
      status: 'ready',
      ...extra,
    });
    return { cookie, id: String(id) };
  };

  it('signs the thumbnail object once it is ready', async () => {
    mockPresignGet.mockResolvedValue('https://spaces.example/thumb');
    const { cookie, id } = await seedImage('assets-thumb-ready@example.com', {
      thumbnailStatus: 'ready',
      thumbnailKey: 'u/a/thumbnail',
    });
    const response = await request(app)
      .get(`/api/assets/${id}/thumbnail-url`)
      .set('Cookie', [cookie]);
    expect(response.status).toBe(200);
    expect(response.body.url).toBe('https://spaces.example/thumb');
    expect(mockPresignGet).toHaveBeenCalledWith('u/a/thumbnail', 300);
  });

  it('reports a null url while the thumbnail is pending and when it failed', async () => {
    const pending = await seedImage('assets-thumb-pending@example.com', {
      thumbnailStatus: 'pending',
      thumbnailKey: null,
    });
    const pendingRes = await request(app)
      .get(`/api/assets/${pending.id}/thumbnail-url`)
      .set('Cookie', [pending.cookie]);
    expect(pendingRes.status).toBe(200);
    expect(pendingRes.body).toEqual({ url: null, status: 'pending' });

    const failed = await seedImage('assets-thumb-failed@example.com', {
      thumbnailStatus: 'failed',
      thumbnailKey: null,
    });
    const failedRes = await request(app)
      .get(`/api/assets/${failed.id}/thumbnail-url`)
      .set('Cookie', [failed.cookie]);
    expect(failedRes.status).toBe(200);
    expect(failedRes.body).toEqual({ url: null, status: 'failed' });
  });

  it('404s for another user and 401s for a guest', async () => {
    const { id } = await seedImage('assets-thumb-owner@example.com', {
      thumbnailStatus: 'ready',
      thumbnailKey: 'u/a/thumbnail',
    });
    const otherCookie = await registerUser('assets-thumb-other@example.com');
    const cross = await request(app)
      .get(`/api/assets/${id}/thumbnail-url`)
      .set('Cookie', [otherCookie]);
    expect(cross.status).toBe(404);

    const guest = await request(app).get(`/api/assets/${id}/thumbnail-url`);
    expect(guest.status).toBe(401);
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
    // Spaces objects stay resident (doc-only delete), so nothing deletes.
    // @see #69
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
    // The suite-wide beforeEach wipes collections; recreate users per test.
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
    // Regression: invalid-id filtering left an empty $in and downloaded all.
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

describe('Asset version history and restore (#325)', () => {
  const seedGenerated = async (
    email: string,
    content = '# draft',
    extra: Record<string, unknown> = {},
  ): Promise<{ cookie: string; id: string; userId: string }> => {
    const cookie = await registerUser(email);
    const user = await User.findOne({ email });
    const id = new Types.ObjectId();
    await Asset.create({
      _id: id,
      userId: user?._id,
      filename: 'notes.md',
      key: `${String(user?._id)}/${String(id)}/notes.md`,
      contentType: 'text/markdown',
      size: Buffer.byteLength(content, 'utf8'),
      status: 'ready',
      origin: 'system-generated',
      textExtracted: content,
      ...extra,
    });
    return { cookie, id: String(id), userId: String(user?._id) };
  };

  const seedVersion = (
    assetId: string,
    userId: string,
    version: number,
    content: string,
  ): Promise<unknown> =>
    AssetVersion.create({
      assetId,
      userId,
      version,
      filename: 'notes.md',
      size: Buffer.byteLength(content, 'utf8'),
      textExtracted: content,
    });

  beforeEach(() => {
    jest.resetAllMocks();
    (isStorageConfigured as jest.Mock).mockReturnValue(true);
    mockPutObject.mockResolvedValue(undefined);
  });

  it('lists versions newest first, scoped to the caller', async () => {
    const { cookie, id, userId } = await seedGenerated('assets-versions@example.com');
    await seedVersion(id, userId, 1, 'v1');
    await seedVersion(id, userId, 2, 'v2');
    await Asset.updateOne({ _id: id }, { version: 2, textExtracted: 'v2' });

    const response = await request(app).get(`/api/assets/${id}/versions`).set('Cookie', [cookie]);
    expect(response.status).toBe(200);
    expect(response.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(response.body.versions[0]).toMatchObject({ version: 2, size: 2 });
  });

  it('returns one version body and 404s an unknown version', async () => {
    const { cookie, id, userId } = await seedGenerated('assets-version-content@example.com');
    await seedVersion(id, userId, 1, 'old body');

    const ok = await request(app)
      .get(`/api/assets/${id}/versions/1/content`)
      .set('Cookie', [cookie]);
    expect(ok.status).toBe(200);
    expect(ok.body.version).toMatchObject({ version: 1, content: 'old body', format: 'markdown' });

    const missing = await request(app)
      .get(`/api/assets/${id}/versions/9/content`)
      .set('Cookie', [cookie]);
    expect(missing.status).toBe(404);

    const invalid = await request(app)
      .get(`/api/assets/${id}/versions/abc/content`)
      .set('Cookie', [cookie]);
    expect(invalid.status).toBe(400);
  });

  it('restores a prior version as a new version', async () => {
    const { cookie, id, userId } = await seedGenerated(
      'assets-restore@example.com',
      'current body',
    );
    await seedVersion(id, userId, 1, 'old body');
    await seedVersion(id, userId, 2, 'current body');
    await Asset.updateOne({ _id: id }, { version: 2 });

    const response = await request(app)
      .post(`/api/assets/${id}/restore`)
      .set('Cookie', [cookie])
      .send({ version: 1 });
    expect(response.status).toBe(200);
    expect(response.body.asset.version).toBe(3);

    const stored = await Asset.findById(id);
    expect(stored?.textExtracted).toBe('old body');
    expect(stored?.version).toBe(3);
    const versions = await AssetVersion.find({ assetId: id }).sort({ version: 1 }).lean();
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it('404s restoring an unknown version', async () => {
    const { cookie, id } = await seedGenerated('assets-restore-missing@example.com');
    const response = await request(app)
      .post(`/api/assets/${id}/restore`)
      .set('Cookie', [cookie])
      .send({ version: 7 });
    expect(response.status).toBe(404);
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it('refuses to restore an edit on a user upload', async () => {
    const cookie = await registerUser('assets-restore-upload@example.com');
    const user = await User.findOne({ email: 'assets-restore-upload@example.com' });
    const id = new Types.ObjectId();
    await Asset.create({
      _id: id,
      userId: user?._id,
      filename: 'upload.txt',
      key: 'k/upload.txt',
      contentType: 'text/plain',
      size: 3,
      status: 'ready',
      origin: 'user-upload',
      textExtracted: 'abc',
    });
    const response = await request(app)
      .post(`/api/assets/${String(id)}/restore`)
      .set('Cookie', [cookie])
      .send({ version: 1 });
    expect(response.status).toBe(400);
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it('rejects a malformed restore body', async () => {
    const { cookie, id } = await seedGenerated('assets-restore-body@example.com');
    for (const body of [{}, { version: 0 }, { version: 1.5 }, { version: 'x' }]) {
      const response = await request(app)
        .post(`/api/assets/${id}/restore`)
        .set('Cookie', [cookie])
        .send(body);
      expect(response.status).toBe(400);
    }
  });

  it('isolates history and restore by ownership and rejects guests', async () => {
    const { id, userId } = await seedGenerated('assets-versions-owner@example.com');
    await seedVersion(id, userId, 1, 'secret');
    const otherCookie = await registerUser('assets-versions-other@example.com');

    const list = await request(app).get(`/api/assets/${id}/versions`).set('Cookie', [otherCookie]);
    expect(list.status).toBe(404);
    const content = await request(app)
      .get(`/api/assets/${id}/versions/1/content`)
      .set('Cookie', [otherCookie]);
    expect(content.status).toBe(404);
    const restore = await request(app)
      .post(`/api/assets/${id}/restore`)
      .set('Cookie', [otherCookie])
      .send({ version: 1 });
    expect(restore.status).toBe(404);

    expect((await request(app).get(`/api/assets/${id}/versions`)).status).toBe(401);
    expect((await request(app).post(`/api/assets/${id}/restore`).send({ version: 1 })).status).toBe(
      401,
    );
  });
});
