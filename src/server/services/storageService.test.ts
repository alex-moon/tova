const keys = ['DO_SPACES_KEY', 'DO_SPACES_SECRET', 'DO_SPACES_BUCKET'] as const;

const backup: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of keys) {
    backup[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of keys) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

describe('storageService', () => {
  it('is unconfigured without the DO_SPACES_* vars', () => {
    expect(isStorageConfigured()).toBe(false);
  });

  it('is configured with key, secret and bucket present', () => {
    process.env.DO_SPACES_KEY = 'k';
    process.env.DO_SPACES_SECRET = 's';
    process.env.DO_SPACES_BUCKET = 'tova';
    expect(isStorageConfigured()).toBe(true);
  });

  it('rejects operations when unconfigured instead of crashing', async () => {
    await expect(deleteObject('x')).rejects.toThrow(/not configured/);
  });

  describe('deleteObject convergence', () => {
    beforeEach(() => {
      mockSend.mockReset();
    });

    it('resolves true when the object existed and was deleted', async () => {
      process.env.DO_SPACES_KEY = 'k';
      process.env.DO_SPACES_SECRET = 's';
      process.env.DO_SPACES_BUCKET = 'tova';
      mockSend.mockResolvedValue({});
      await expect(deleteObject('u/a/f.txt')).resolves.toBe(true);
    });

    it('resolves true when the object was already gone (NoSuchKey/NotFound)', async () => {
      process.env.DO_SPACES_KEY = 'k';
      process.env.DO_SPACES_SECRET = 's';
      process.env.DO_SPACES_BUCKET = 'tova';
      mockSend.mockRejectedValue({ name: 'NoSuchKey' });
      await expect(deleteObject('u/a/gone.txt')).resolves.toBe(true);
      mockSend.mockRejectedValue({ name: 'NotFound' });
      await expect(deleteObject('u/a/gone2.txt')).resolves.toBe(true);
    });

    it('propagates unrelated errors', async () => {
      process.env.DO_SPACES_KEY = 'k';
      process.env.DO_SPACES_SECRET = 's';
      process.env.DO_SPACES_BUCKET = 'tova';
      mockSend.mockRejectedValue({ name: 'InternalError' });
      await expect(deleteObject('u/a/bad.txt')).rejects.toMatchObject({ name: 'InternalError' });
    });
  });
});

import { deleteObject, isStorageConfigured } from './storageService';

// The DeleteObjectCommand shape is swappable at this boundary: the mocked
// client routes every send() through a single shared mock.
jest.mock('@aws-sdk/client-s3', () => ({
  DeleteObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
  PutObjectCommand: jest.fn(),
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const mockSend = jest.fn();
