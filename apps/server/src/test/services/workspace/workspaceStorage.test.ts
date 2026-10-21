jest.mock('../../../main/services/storageService', () => ({
  isStorageConfigured: jest.fn(),
  putObject: jest.fn(),
  presignPutUrl: jest.fn(),
  presignGetUrl: jest.fn(),
  headObject: jest.fn(),
  getObjectStream: jest.fn(),
  getObjectBuffer: jest.fn(),
  deleteObject: jest.fn(),
}));

import {
  chatScopedKey,
  spacesWorkspaceStorage as ws,
} from '../../../main/services/workspace/workspaceStorage';
import {
  deleteObject,
  getObjectBuffer,
  getObjectStream,
  headObject,
  isStorageConfigured,
  presignGetUrl,
  presignPutUrl,
  putObject,
} from '../../../main/services/storageService';

const mocked = {
  isStorageConfigured: jest.mocked(isStorageConfigured),
  putObject: jest.mocked(putObject),
  presignPutUrl: jest.mocked(presignPutUrl),
  presignGetUrl: jest.mocked(presignGetUrl),
  headObject: jest.mocked(headObject),
  getObjectStream: jest.mocked(getObjectStream),
  getObjectBuffer: jest.mocked(getObjectBuffer),
  deleteObject: jest.mocked(deleteObject),
};

beforeEach(() => jest.resetAllMocks());

describe('chatScopedKey layout (#149)', () => {
  it('builds <userId>/chats/<chatId>/<filename>', () => {
    expect(chatScopedKey('u1', 'c1', 'notes.md')).toBe('u1/chats/c1/notes.md');
  });

  it('is structurally disjoint from the asset layout <userId>/<assetId>/<filename>', () => {
    // Chat keys carry the "chats" segment; they can never collide with assets.
    expect(chatScopedKey('6843ae4d2f', '6843bef77c', 'a.txt')).not.toMatch(
      /^6843ae4d2f\/[0-9a-f]{24}\//,
    );
    expect(chatScopedKey('6843ae4d2f', '6843bef77c', 'a.txt').split('/')).toEqual([
      '6843ae4d2f',
      'chats',
      '6843bef77c',
      'a.txt',
    ]);
  });
});

describe('spacesWorkspaceStorage', () => {
  it('isConfigured delegates to the driver (mastraService probe)', () => {
    mocked.isStorageConfigured.mockReturnValue(true);
    expect(ws.isConfigured()).toBe(true);
    expect(mocked.isStorageConfigured).toHaveBeenCalled();
  });

  it('headByKey propagates driver rejections (missing object throws)', async () => {
    mocked.headObject.mockRejectedValue(new Error('HeadObject 404'));
    await expect(ws.headByKey('u1/a1/missing.txt')).rejects.toThrow('HeadObject 404');
  });

  it('getByKey preserves the null-on-missing contract for asset reads', async () => {
    mocked.getObjectBuffer.mockResolvedValue(null);
    await expect(ws.getByKey('u1/a1/a.txt')).resolves.toBeNull();
  });
});

describe('byKey subset', () => {
  it('passes raw keys through untouched', async () => {
    const body = Buffer.alloc(1);
    const stream = Symbol('stream');
    mocked.putObject.mockResolvedValue();
    mocked.getObjectBuffer.mockResolvedValue(body);
    mocked.getObjectStream.mockResolvedValue(stream as never);
    mocked.headObject.mockResolvedValue({ size: 3, contentType: 'text/plain' });
    mocked.deleteObject.mockResolvedValue(true);
    await ws.putByKey('u1/a1/a.txt', body, 'text/plain');
    await expect(ws.getByKey('u1/a1/a.txt', { maxBytes: 50 })).resolves.toBe(body);
    await expect(ws.getStreamByKey('u1/a1/a.txt')).resolves.toBe(stream);
    await expect(ws.headByKey('u1/a1/a.txt')).resolves.toEqual({
      size: 3,
      contentType: 'text/plain',
    });
    await expect(ws.deleteByKey('u1/a1/a.txt')).resolves.toBe(true);
    expect(mocked.putObject).toHaveBeenCalledWith('u1/a1/a.txt', body, 'text/plain');
    expect(mocked.getObjectBuffer).toHaveBeenCalledWith('u1/a1/a.txt', 50);
  });

  it('presign capabilities are Spaces-only and reuse the driver defaults', async () => {
    mocked.presignPutUrl.mockResolvedValue('put-url');
    mocked.presignGetUrl.mockResolvedValue('get-url');
    await expect(ws.presignPutByKey('k')).resolves.toBe('put-url');
    await expect(ws.presignGetByKey('k', 60)).resolves.toBe('get-url');
    expect(mocked.presignPutUrl).toHaveBeenCalledWith('k');
    expect(mocked.presignGetUrl).toHaveBeenCalledWith('k', 60);
  });
});
