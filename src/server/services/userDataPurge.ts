import type { Types } from 'mongoose';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { Asset } from '../models/Asset';
import { AssetJob } from '../models/AssetJob';
import { Entity } from '../models/Entity';
import { EntityEdge } from '../models/EntityEdge';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { purgeUserTraces } from './tracePurge';

/*
 * Factory reset (issue #143): a full wipe of everything a user's account
 * holds, replacing the older chat-only `purgeUserChats` (which lives on in
 * routes/profile.ts until its caller is re-pointed here).
 *
 * Every user-owned, PII-bearing collection is enumerated explicitly below —
 * the sweep is deliberately flat rather than derived from a lookup table so
 * a future collection cannot silently escape it (a code review sees the list
 * next to the data model). Bulk `deleteMany` ops only; no per-doc loop.
 *
 * Under factory reset NOTHING survives: sessions are HARD-deleted (including
 * already-soft-deleted ones), asset docs and their Spaces bytes, chat-scoped
 * workspace files, asset-derived job rows and the entity graph all go.
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
  // messages, the entity graph (free-text names/summaries/edges pointing back
  // into messages), asset docs, and the job rows keyed by assetId (AssetJob
  // has no userId, so it is swept via the pre-fetched asset ids).
  await Promise.all([
    Message.deleteMany({ sessionId: { $in: sessionIds } }),
    Entity.deleteMany({ userId }),
    EntityEdge.deleteMany({ userId }),
    Asset.deleteMany({ userId }),
    AssetJob.deleteMany({ assetId: { $in: assetIds } }),
    // Hard delete of ALL owned sessions — soft-deleted ones included; nothing
    // survives a factory reset.
    Session.deleteMany({ userId }),
  ]);

  // Spaces sweep: the asset bytes (deleted docs left the bucket keys behind)
  // and the chat-scoped workspace files, which have no Asset row and are
  // therefore swept by session prefix.
  for (const key of assetKeys) {
    try {
      if (!(await spacesWorkspaceStorage.deleteByKey(key))) failedObjects.push(key);
    } catch (err) {
      console.error('factory reset: object delete failed:', String(err));
      failedObjects.push(key);
    }
  }
  try {
    failedObjects.push(
      ...(await spacesWorkspaceStorage.deleteChatFiles(uid, sessionIds.map(String))),
    );
  } catch (err) {
    console.error('factory reset: workspace file sweep failed:', String(err));
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
