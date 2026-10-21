import type { Readable } from 'stream';
import type { HeadObjectInfo } from '../storageService';
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
} from '../storageService';

/* Raw-key subset: the asset domain speaks in keys, not chat ids. */
export interface RawKeyStorage {
  putByKey(key: string, body: Buffer, contentType?: string): Promise<void>;
  getByKey(key: string, opts?: { maxBytes?: number }): Promise<Buffer | null>;
  getStreamByKey(key: string): Promise<Readable | null>;
  headByKey(key: string): Promise<HeadObjectInfo>;
  deleteByKey(key: string): Promise<boolean>;
}

// Spaces-only capabilities (presigns), plus isConfigured for readiness.
export interface SpacesCapabilities {
  isConfigured(): boolean;
  presignPutByKey(key: string, expiresIn?: number, contentType?: string): Promise<string>;
  presignGetByKey(key: string, expiresIn?: number): Promise<string>;
}

/* Storage-agnostic boundary: keys plus the chat-file sweep. */
// @see #149 #398
export interface WorkspaceStorage extends RawKeyStorage, SpacesCapabilities {
  // Bulk chat-scoped sweep; returns the keys whose deletion failed.
  // @see #143
  deleteChatFiles(userId: string, chatIds: string[]): Promise<string[]>;
}

// The chats/ segment keeps this disjoint from the asset key layout.
// @see #149
export const chatScopedKey = (userId: string, chatId: string, filename: string): string =>
  `${userId}/chats/${chatId}/${filename}`;

// The single Spaces-backed implementation; import this, not the driver.
export const spacesWorkspaceStorage: WorkspaceStorage = {
  isConfigured: isStorageConfigured,

  // Bulk chat-scoped sweep; returns the keys whose deletion failed.
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
