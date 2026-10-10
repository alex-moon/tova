jest.mock('./storageService', () => ({
  isStorageConfigured: jest.fn(),
  putObject: jest.fn(),
  presignPutUrl: jest.fn(),
  presignGetUrl: jest.fn(),
  headObject: jest.fn(),
  getObjectStream: jest.fn(),
  getObjectBuffer: jest.fn(),
  deleteObject: jest.fn(),
}));

import { chatScopedKey, spacesWorkspaceStorage as ws } from './workspaceStorage';
import {
  deleteObject,
  getObjectBuffer,
  getObjectStream,
  headObject,
  isStorageConfigured,
  presignGetUrl,
  presignPutUrl,
  putObject,
} from './storageService';

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
    // A chat ObjectId under u1 can never collide with an asset ObjectId key,
    // because chat keys always carry the literal "chats" segment in position
    // two where asset keys carry an ObjectId.
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

  it('put delegates with the chat-scoped key', async () => {
    const body = Buffer.from('hello');
    mocked.putObject.mockResolvedValue();
    await ws.put('u1', 'c1', 'notes.md', body, 'text/markdown');
    expect(mocked.putObject).toHaveBeenCalledWith('u1/chats/c1/notes.md', body, 'text/markdown');
  });

  it('put without contentType passes undefined through, not an empty string', async () => {
    mocked.putObject.mockResolvedValue();
    await ws.put('u1', 'c1', 'notes.md', Buffer.alloc(0));
    expect(mocked.putObject).toHaveBeenCalledWith(
      'u1/chats/c1/notes.md',
      Buffer.alloc(0),
      undefined,
    );
  });

  it('headByKey propagates driver rejections (missing object throws)', async () => {
    mocked.headObject.mockRejectedValue(new Error('HeadObject 404'));
    await expect(ws.headByKey('u1/a1/missing.txt')).rejects.toThrow('HeadObject 404');
  });

  it('getByKey preserves the null-on-missing contract for asset reads', async () => {
    mocked.getObjectBuffer.mockResolvedValue(null);
    await expect(ws.getByKey('u1/a1/a.txt')).resolves.toBeNull();
  });

  it('get preserves the null-on-missing / null-on-over-cap contract', async () => {
    mocked.getObjectBuffer.mockResolvedValue(null);
    await expect(ws.get('u1', 'c1', 'notes.md')).resolves.toBeNull();
    await expect(ws.get('u1', 'c1', 'notes.md', { maxBytes: 100 })).resolves.toBeNull();
    expect(mocked.getObjectBuffer).toHaveBeenCalledWith('u1/chats/c1/notes.md', 100);
  });

  it('get propagates transport errors like the driver', async () => {
    mocked.getObjectBuffer.mockRejectedValue(new Error('Spaces down'));
    await expect(ws.get('u1', 'c1', 'notes.md')).rejects.toThrow('Spaces down');
  });

  it('getStream delegates without a cap', async () => {
    const stream = Symbol('stream');
    mocked.getObjectStream.mockResolvedValue(stream as never);
    await expect(ws.getStream('u1', 'c1', 'f.txt')).resolves.toBe(stream);
  });

  it('delete is idempotent via the driver and resolves true', async () => {
    mocked.deleteObject.mockResolvedValue(true);
    await expect(ws.delete('u1', 'c1', 'gone.txt')).resolves.toBe(true);
    expect(mocked.deleteObject).toHaveBeenCalledWith('u1/chats/c1/gone.txt');
  });

  it('list throws instead of silently returning empty', async () => {
    await expect(ws.list('u1', 'c1')).rejects.toThrow(/not implemented/);
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
