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

  it('prevents user B from deleting user A asset and the object survives', async () => {
    const response = await request(app).delete(`/api/assets/${assetId}`).set('Cookie', [cookieB]);
    expect(response.status).toBe(404);
    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(await Asset.findById(assetId)).not.toBeNull();
  });

  it('propagates a storage error as a 502 and keeps the doc', async () => {
    mockDeleteObject.mockRejectedValue({ name: 'InternalError' });
    const response = await request(app).delete(`/api/assets/${assetId}`).set('Cookie', [cookieA]);
    expect(response.status).toBe(502);
    expect(await Asset.findById(assetId)).not.toBeNull();
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
