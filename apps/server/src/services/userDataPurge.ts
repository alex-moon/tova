import type { Types } from 'mongoose';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { Asset } from '../models/Asset';
import { AssetJob } from '../models/AssetJob';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { purgeUserTraces } from './tracePurge';
import { Connector } from '../models/Connector';
import type { ConnectorDocument } from '../models/Connector';
import { readConnectorVault } from './oauthConnectors';

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

/*
 * RFC 7009 best-effort grant revocation (#333): deleting the row kills the
 * tokens at rest, but the grant stays live at the provider. When the vault's
 * stored AS metadata advertises a revocation endpoint, POST the refresh
 * token (revoking it revokes the grant's access tokens too); no advertised
 * endpoint, or any failure, never blocks the sweep — it is a nicety, and the
 * row (and tokens) are deleted regardless.
 */
const revokeOAuthGrants = async (connectors: ConnectorDocument[]): Promise<void> => {
  await Promise.allSettled(
    connectors.map(async (connector) => {
      if (connector.type !== 'mcp.oauth' || !connector.oauth) return;
      let token: string | undefined;
      let revocationEndpoint: string | undefined;
      try {
        const vault = readConnectorVault(connector);
        token = vault?.refreshToken ?? vault?.accessToken;
        // The SDK's zod schema carries revocation_endpoint but its TS type
        // omits it — read it through the wire shape.
        revocationEndpoint = (vault?.metadata as { revocation_endpoint?: string } | undefined)
          ?.revocation_endpoint;
      } catch {
        return; // undecryptable or key missing: the row delete below still wipes the material
      }
      if (!token || !revocationEndpoint) return;
      await fetch(revocationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
    }),
  );
};

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
  // OAuth grants are revoked at their providers first (best-effort, #333):
  // the vault must be read before the docs are gone.
  const oauthConnectors = await Connector.find({ scope: 'user', userId, type: 'mcp.oauth' });
  await revokeOAuthGrants(oauthConnectors);
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
