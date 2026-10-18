const keys = ['DO_SPACES_KEY', 'DO_SPACES_SECRET', 'DO_SPACES_BUCKET'] as const;

import { Readable } from 'stream';

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
    await expect(putObject('x', Buffer.alloc(1))).rejects.toThrow(/not configured/);
  });

  describe('putObject (#66)', () => {
    beforeEach(() => {
      mockSend.mockReset();
    });

    it('sends Bucket/Key/ContentType/Body to the configured client', async () => {
      process.env.DO_SPACES_KEY = 'k';
      process.env.DO_SPACES_SECRET = 's';
      process.env.DO_SPACES_BUCKET = 'tova';
      mockSend.mockResolvedValue({});
      const body = Buffer.from('# hello');
      await putObject('u/1/notes.md', body, 'text/markdown');
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: 'tova',
        Key: 'u/1/notes.md',
        ContentType: 'text/markdown',
        Body: body,
      });
    });

    it('propagates client failures to the caller (#66)', async () => {
      process.env.DO_SPACES_KEY = 'k';
      process.env.DO_SPACES_SECRET = 's';
      process.env.DO_SPACES_BUCKET = 'tova';
      mockSend.mockRejectedValue(new Error('Spaces down'));
      await expect(putObject('u/1/notes.md', Buffer.alloc(1))).rejects.toThrow('Spaces down');
    });
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

  describe('getObjectBuffer cap (#396)', () => {
    beforeEach(() => {
      mockSend.mockReset();
      process.env.DO_SPACES_KEY = 'k';
      process.env.DO_SPACES_SECRET = 's';
      process.env.DO_SPACES_BUCKET = 'tova';
    });

    it('accumulates by counter and returns null when a headerless body exceeds the cap', async () => {
      mockSend.mockResolvedValue({
        // ContentLength absent: the header check is powerless here.
        ContentLength: undefined,
        Body: Readable.from([Buffer.alloc(600), Buffer.alloc(600)]),
      });
      await expect(getObjectBuffer('u/a/big.bin', 1000)).resolves.toBeNull();
    });

    it('returns the buffer when a headerless body fits the cap', async () => {
      mockSend.mockResolvedValue({
        ContentLength: undefined,
        Body: Readable.from([Buffer.from('hello '), Buffer.from('world')]),
      });
      await expect(getObjectBuffer('u/a/ok.txt', 1000)).resolves.toEqual(
        Buffer.from('hello world'),
      );
    });
  });
});

import {
  deleteObject,
  getObjectBuffer,
  isStorageConfigured,
  putObject,
} from '../../main/services/storageService';

// Commands are jest.fn()s, so inputs are asserted via the constructor mocks.
import { PutObjectCommand } from '@aws-sdk/client-s3';

// The DeleteObjectCommand shape is swappable: every send() hits one mock.
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
