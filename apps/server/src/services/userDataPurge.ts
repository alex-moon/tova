import type { Types } from 'mongoose';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { Asset } from '../models/Asset';
import { AssetJob } from '../models/AssetJob';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { purgeUserTraces } from './tracePurge';
import { Connector } from '../models/Connector';

/*
 * Factory reset (issue #143): a full wipe of everything a user's account
 * holds, superseding the older chat-only auto-purge (removed with issue #143).
 *
 * Every user-owned, PII-bearing collection is enumerated explicitly below —
 * the sweep is deliberately flat rather than derived from a lookup table so
 * a future collection cannot silently escape it (a code review sees the list
 * next to the data model). Bulk `deleteMany` ops only; no per-doc loop.
 *
 * Under factory reset NOTHING survives: sessions are HARD-deleted (including
 * already-soft-deleted ones), asset docs and their Spaces bytes, chat-scoped
 * workspace files, asset-derived job rows, and user-scoped connector configs
 * (their urls plus AES-256-GCM-encrypted auth material — headers today,
 * OAuth token vaults with #327 — is secret material at rest, critic pass
 * 2026-09-23) all go. The auth vault lives inside the swept connector
 * document, so no separate token collection can escape this list (#327).
 * Exceptions: user *settings* (customInstructions, theme, startupChat,
 * confirmDeletes, zdr) are preferences, not data — intentionally NOT wiped
 * here; and the account itself stays (the user is still logged in and can
 * keep using Tova from a clean state).
 */

export interface UserDataPurgeResult {
  // Spaces object keys whose deletion failed (or surfaced an error). The
  // reset still counts as complete — Mongo is authoritative — and callers
  // surface the count so the UI can warn the user.
  failedObjects: string[];
}

export const purgeAllUserData = async (
  userId: string | Types.ObjectId,
): Promise<UserDataPurgeResult> => {
  const failedObjects: string[] = [];
  const uid = String(userId);

  // Pre-reads: session ids and asset keys must be fetched before their
  // documents are erased below.
  const [sessions, assets] = await Promise.all([
    Session.find({ userId }).select('_id').lean(),
    Asset.find({ userId }).select('_id key').lean(),
  ]);
  const sessionIds = sessions.map((s) => s._id);
  const assetIds = assets.map((a) => a._id);
  const assetKeys = assets.map((a) => a.key);

  // Mongo sweep — every collection enumerated explicitly (issue #143):
  // messages, asset docs, the job rows keyed by assetId (AssetJob has no
  // userId, so it is swept via the pre-fetched asset ids), and the
  // user-scoped connector configs — platform connectors are left alone.
  await Promise.all([
    Message.deleteMany({ sessionId: { $in: sessionIds } }),
    Asset.deleteMany({ userId }),
    AssetJob.deleteMany({ assetId: { $in: assetIds } }),
    Connector.deleteMany({ scope: 'user', userId }),
    // Hard delete of ALL owned sessions — soft-deleted ones included; nothing
    // survives a factory reset.
    Session.deleteMany({ userId }),
  ]);

  // Spaces sweep: the asset bytes (deleted docs left the bucket keys behind)
  // and the chat-scoped workspace files, which have no Asset row and are
  // therefore swept by session prefix. Both halves gate on isConfigured for
  // the same reason: with no Spaces credentials nothing was ever written to a
  // bucket, so reporting the keys as failed would spuriously warn the user
  // that data remains.
  if (spacesWorkspaceStorage.isConfigured()) {
    for (const key of assetKeys) {
      try {
        if (!(await spacesWorkspaceStorage.deleteByKey(key))) failedObjects.push(key);
      } catch (err) {
        console.error('factory reset: object delete failed:', String(err));
        failedObjects.push(key);
      }
    }
  }
  try {
    failedObjects.push(
      ...(await spacesWorkspaceStorage.deleteChatFiles(uid, sessionIds.map(String))),
    );
  } catch (err) {
    console.error('factory reset: workspace file sweep failed:', String(err));
    // A wholesale sweep failure (listing error, transport down) cannot name
    // individual keys, but reporting zero failures here would tell the user
    // "everything erased" when chat files may still be on the bucket — so a
    // sentinel key is surfaced instead.
    failedObjects.push(`${uid}/chats/*`);
  }

  // Traces: best-effort LangSmith deletion into the configured project;
  // failure-tolerant inside the service, and guarded once more here so any
  // unexpected rethrow cannot abort the reset the user already waited for.
  try {
    await purgeUserTraces(sessionIds.map(String));
  } catch (err) {
    console.error('factory reset: trace purge failed:', String(err));
  }

  return { failedObjects };
};
