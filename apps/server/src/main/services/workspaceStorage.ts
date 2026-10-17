import type { Readable } from 'stream';
import type { HeadObjectInfo } from './storageService';
import {
  deleteObject,
  getObjectBuffer,
  getObjectStream,
  headObject,
  isStorageConfigured,
  listObjectKeys,
  presignGetUrl,
  presignPutUrl,
  putObject,
} from './storageService';

/* Storage-agnostic boundary: primitives keyed by userId + chatId + filename; semantics inherited verbatim from the Spaces driver. */
// @see #149
export interface WorkspaceStorage {
  put(
    userId: string,
    chatId: string,
    filename: string,
    body: Buffer,
    contentType?: string,
  ): Promise<void>;
  get(
    userId: string,
    chatId: string,
    filename: string,
    opts?: { maxBytes?: number },
  ): Promise<Buffer | null>;
  getStream(userId: string, chatId: string, filename: string): Promise<Readable | null>;
  delete(userId: string, chatId: string, filename: string): Promise<boolean>;
  list(userId: string, chatId: string): Promise<string[]>;
}

// Chat-scoped key layout used ONLY by chat-scoped writes; the `chats/` segment makes it structurally disjoint from the asset layout even when ids look alike, so no migration is ever needed.
// @see #149
export const chatScopedKey = (userId: string, chatId: string, filename: string): string =>
  `${userId}/chats/${chatId}/${filename}`;

/* Raw-key subset: the asset domain owns persisted key strings and speaks in keys, not chat ids; a future local backend is not expected to implement these. */
export interface RawKeyStorage {
  putByKey(key: string, body: Buffer, contentType?: string): Promise<void>;
  getByKey(key: string, opts?: { maxBytes?: number }): Promise<Buffer | null>;
  getStreamByKey(key: string): Promise<Readable | null>;
  headByKey(key: string): Promise<HeadObjectInfo>;
  deleteByKey(key: string): Promise<boolean>;
}

// Spaces-only optional capabilities (presigns need S3 request signing), plus isConfigured so callers check readiness through the boundary.
export interface SpacesCapabilities {
  isConfigured(): boolean;
  presignPutByKey(key: string, expiresIn?: number, contentType?: string): Promise<string>;
  presignGetByKey(key: string, expiresIn?: number): Promise<string>;
}

// Prefix-scoped bulk deletion by enumerating filenames no caller knows; Spaces-only.
// @see #143
export interface ChatFileSweep {
  deleteChatFiles(userId: string, chatIds: string[]): Promise<string[]>;
}

// The single Spaces-backed implementation; call sites import only this object, never the driver.
export const spacesWorkspaceStorage: WorkspaceStorage &
  RawKeyStorage &
  SpacesCapabilities &
  ChatFileSweep = {
  isConfigured: isStorageConfigured,

  put: (userId, chatId, filename, body, contentType) =>
    putObject(chatScopedKey(userId, chatId, filename), body, contentType),
  get: (userId, chatId, filename, opts) =>
    getObjectBuffer(chatScopedKey(userId, chatId, filename), opts?.maxBytes),
  getStream: (userId, chatId, filename) => getObjectStream(chatScopedKey(userId, chatId, filename)),
  delete: (userId, chatId, filename) => deleteObject(chatScopedKey(userId, chatId, filename)),
  // No caller enumerates a chat prefix yet, so list has no inherited behaviour; throw rather than silently return empty.
  list: async () => {
    throw new Error('workspaceStorage.list is not implemented yet (no caller exists)');
  },

  // Bulk chat-scoped sweep: delete every object under each chat's prefix; returns the keys whose deletion failed; resolves empty when unconfigured (nothing to sweep).
  // @see #143
  deleteChatFiles: async (userId, chatIds): Promise<string[]> => {
    const failed: string[] = [];
    if (!isStorageConfigured()) return failed;
    for (const chatId of chatIds) {
      const keys = await listObjectKeys(chatScopedKey(userId, chatId, ''));
      for (const key of keys) {
        try {
          if (!(await deleteObject(key))) failed.push(key);
        } catch {
          failed.push(key);
        }
      }
    }
    return failed;
  },

  putByKey: putObject,
  getByKey: (key, opts) => getObjectBuffer(key, opts?.maxBytes),
  getStreamByKey: getObjectStream,
  headByKey: headObject,
  deleteByKey: deleteObject,
  presignPutByKey: presignPutUrl,
  presignGetByKey: presignGetUrl,
};
