import type { Readable } from 'stream';
import type { HeadObjectInfo } from './storageService';
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

// Storage-agnostic boundary for the future workspace feature (issue #149).
// All primitives are keyed by userId + chatId + filename; implementations
// decide their own key layout. A local backend (IndexedDB / fs) need only
// implement the chat-scoped methods below — no byKey, no presigns.
//
// Semantics are inherited verbatim from the Spaces driver (no behavioural
// change in #149): get() returns null for a missing object AND for
// over-cap reads and throws on transport errors; getStream() returns null on
// missing with no size cap; delete() is idempotent and resolves true.
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

// Chat-scoped key layout used ONLY by new writes going through the
// chat-scoped methods (the future workspace feature). Asset writes keep the
// existing `<userId>/<assetId>/<filename>` layout on the Asset row. The
// `chats/` segment in the second position makes the two layouts structurally
// disjoint even when chatId values look like asset ObjectIds, so no
// migration is ever needed.
export const chatScopedKey = (userId: string, chatId: string, filename: string): string =>
  `${userId}/chats/${chatId}/${filename}`;

// Raw-key subset (low-level): the asset domain owns key strings persisted on
// its documents (`<userId>/<assetId>/<filename>`) and resolves them from the
// loaded row, so it speaks in keys, not chat ids. NOT part of the required
// interface — a future local backend is not expected to implement these.
export interface RawKeyStorage {
  putByKey(key: string, body: Buffer, contentType?: string): Promise<void>;
  getByKey(key: string, opts?: { maxBytes?: number }): Promise<Buffer | null>;
  getStreamByKey(key: string): Promise<Readable | null>;
  headByKey(key: string): Promise<HeadObjectInfo>;
  deleteByKey(key: string): Promise<boolean>;
}

// Spaces-only optional capabilities (presigns need S3 request signing),
// deliberately not on the storage-agnostic interface, plus isConfigured so
// callers check readiness through the boundary instead of the driver.
export interface SpacesCapabilities {
  isConfigured(): boolean;
  presignPutByKey(key: string, expiresIn?: number, contentType?: string): Promise<string>;
  presignGetByKey(key: string, expiresIn?: number): Promise<string>;
}

// The single Spaces-backed implementation over the existing storageService
// driver. Call sites (once rewired across checklist items 2-6) import only
// this object, never the driver.
export const spacesWorkspaceStorage: WorkspaceStorage & RawKeyStorage & SpacesCapabilities = {
  isConfigured: isStorageConfigured,

  put: (userId, chatId, filename, body, contentType) =>
    putObject(chatScopedKey(userId, chatId, filename), body, contentType),
  get: (userId, chatId, filename, opts) =>
    getObjectBuffer(chatScopedKey(userId, chatId, filename), opts?.maxBytes),
  getStream: (userId, chatId, filename) => getObjectStream(chatScopedKey(userId, chatId, filename)),
  delete: (userId, chatId, filename) => deleteObject(chatScopedKey(userId, chatId, filename)),
  // No caller enumerates a chat prefix yet (none ever did through the old
  // driver either), so list has no inherited behaviour to preserve; throw
  // rather than silently return empty so the future workspace feature wires
  // it to a real listing when it lands.
  list: async () => {
    throw new Error('workspaceStorage.list is not implemented yet (no caller exists)');
  },

  putByKey: putObject,
  getByKey: (key, opts) => getObjectBuffer(key, opts?.maxBytes),
  getStreamByKey: getObjectStream,
  headByKey: headObject,
  deleteByKey: deleteObject,
  presignPutByKey: presignPutUrl,
  presignGetByKey: presignGetUrl,
};
