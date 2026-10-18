import type { Types } from 'mongoose';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { Asset } from '../models/Asset';
import { AssetJob } from '../models/AssetJob';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { purgeUserTraces } from './tracePurge';
import { Connector } from '../models/Connector';
import type { ConnectorDocument } from '../models/Connector';
import { readConnectorVault, assertPublicHttpsUrl } from './oauthConnectors';

/* Factory reset: full wipe of every user-owned PII-bearing collection. */
// @see #143 #327

export interface UserDataPurgeResult {
  // Spaces keys whose deletion failed; callers surface the count.
  failedObjects: string[];
}

/* RFC 7009 best-effort grant revocation; never blocks the sweep. */
// @see #333
const revokeOAuthGrants = async (connectors: ConnectorDocument[]): Promise<void> => {
  await Promise.allSettled(
    connectors.map(async (connector) => {
      if (connector.type !== 'mcp.oauth' || !connector.oauth) return;
      let token: string | undefined;
      let revocationEndpoint: string | undefined;
      try {
        const vault = readConnectorVault(connector);
        token = vault?.refreshToken ?? vault?.accessToken;
        // revocation_endpoint is in the zod schema but not the TS type.
        revocationEndpoint = (vault?.metadata as { revocation_endpoint?: string } | undefined)
          ?.revocation_endpoint;
      } catch {
        return; // Undecryptable or key missing: the row delete below still wipes the material.
      }
      if (!token || !revocationEndpoint) return;
      // The endpoint is persisted attacker-influenced metadata: re-validate
      // immediately before the POST or it receives the bearer token.
      // @see #397
      try {
        assertPublicHttpsUrl(revocationEndpoint, 'OAuth revocation endpoint');
      } catch {
        return; // Best-effort revocation; the row delete below still wipes the material.
      }
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

  // Pre-reads: ids and keys must be fetched before erasure.
  const [sessions, assets] = await Promise.all([
    Session.find({ userId }).select('_id').lean(),
    Asset.find({ userId }).select('_id key').lean(),
  ]);
  const sessionIds = sessions.map((s) => s._id);
  const assetIds = assets.map((a) => a._id);
  const assetKeys = assets.map((a) => a.key);

  // Mongo sweep — collections enumerated explicitly; grants revoked first.
  // @see #143 #333
  const oauthConnectors = await Connector.find({ scope: 'user', userId, type: 'mcp.oauth' });
  await revokeOAuthGrants(oauthConnectors);
  await Promise.all([
    Message.deleteMany({ sessionId: { $in: sessionIds } }),
    Asset.deleteMany({ userId }),
    AssetJob.deleteMany({ assetId: { $in: assetIds } }),
    Connector.deleteMany({ scope: 'user', userId }),
    // Hard delete of ALL owned sessions — soft-deleted ones included.
    Session.deleteMany({ userId }),
  ]);

  // Spaces sweep: asset bytes and chat-scoped workspace files.
  // @see #143
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
    // A wholesale failure cannot name keys; report a sentinel key.
    failedObjects.push(`${uid}/chats/*`);
  }

  // Traces: best-effort deletion, guarded so a rethrow cannot abort.
  // @see #143
  try {
    await purgeUserTraces(sessionIds.map(String));
  } catch (err) {
    console.error('factory reset: trace purge failed:', String(err));
  }

  return { failedObjects };
};
