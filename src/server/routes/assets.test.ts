import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../index';
import { User } from '../models/User';
import { Asset } from '../models/Asset';
import { isStorageConfigured } from '../services/storageService';
import { AssetJob } from '../models/AssetJob';

const mockPresignPut = jest.fn();
const mockPresignGet = jest.fn();
const mockHead = jest.fn();
const mockGetObjectBuffer = jest.fn();
const mockDeleteObject = jest.fn();
const mockEnqueueAssetJob = jest.fn();

jest.mock('../services/storageService', () => ({
  isStorageConfigured: jest.fn().mockReturnValue(true),
  presignPutUrl: (...args: unknown[]) => mockPresignPut(...args),
  presignGetUrl: (...args: unknown[]) => mockPresignGet(...args),
  headObject: (...args: unknown[]) => mockHead(...args),
  getObjectBuffer: (...args: unknown[]) => mockGetObjectBuffer(...args),
  deleteObject: (...args: unknown[]) => mockDeleteObject(...args),
}));

// Route the enqueue through a mock so the confirm tests can simulate an
// enqueue failure; by default it forwards to the real implementation.
jest.mock('../services/assetJobService', () => {
  const actual = jest.requireActual('../services/assetJobService');
  return {
    ...actual,
    enqueueAssetJob: (assetId: unknown) => mockEnqueueAssetJob(assetId),
  };
});
const actualAssetJobService = jest.requireActual('../services/assetJobService');

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

  it('non-convertible binaries stay markdownStatus none with no job', async () => {
    const cookie = await registerUser('assets-image@example.com');
    const assetId = await presignOk(cookie, 'picture.png', 'image/png', 100);

    mockHead.mockResolvedValue(headerForObject(100, 'image/png'));
    const confirm = await confirmFor(cookie, assetId);

    expect(confirm.status).toBe(200);
    const stored = await Asset.findById(assetId);
    expect(stored?.markdownStatus).toBe('none');
    expect(await AssetJob.countDocuments({ assetId })).toBe(0);
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
