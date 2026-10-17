import express from 'express';
import { Types } from 'mongoose';
import type { ConnectorInfo } from '@tova/shared';
import { Connector } from '../models/Connector';
import type { ConnectorDocument } from '../models/Connector';
import {
  connectorCreateSchema,
  connectorOAuthCallbackSchema,
  connectorOAuthStartSchema,
} from '../validation';
import { authenticate, AuthRequest } from '../middleware/auth';
import { encryptEnvelope } from '../services/crypto';
import { listMcpTools } from '../services/connectorService';
import {
  ConnectorOAuthError,
  completeConnectorOAuth,
  hasVaultedAuth,
  probeConnectorOAuth,
  readConnectorVault,
  redirectOriginFrom,
  startConnectorOAuth,
} from '../services/oauthConnectors';

const router = express.Router();

// Discovery probe for the add-time copy: true when the endpoint advertises OAuth; a failed probe answers false (honest unreachable copy).
// @see #333
const connectorAdvertisesOAuth = async (url: string): Promise<boolean> => {
  try {
    return (await probeConnectorOAuth(url)) !== null;
  } catch {
    return false;
  }
};

/* Personal connector registry; platform connectors surfaced read-only in GET; auth stored as one encrypted bearer header, never echoed. */
// @see #36 #329 #80

// Explicit wire projection: per-type storage fields map onto the generic contract; envelope fields excluded by construction.
// @see #329
const serialize = (doc: ConnectorDocument): ConnectorInfo => ({
  id: String(doc._id),
  scope: doc.scope,
  type: doc.type,
  name: doc.name,
  url: doc.url,
  status: doc.status,
  authConfigured: hasVaultedAuth(doc),
  authState: doc.authState === 'needs-reauth' ? 'needs-reauth' : 'ok',
  tools: doc.tools.map((t) => ({ name: t.name, description: t.description })),
});

// GET /api/connectors — platform (read-only) + caller's personal connectors.
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = new Types.ObjectId(req.user?.id);
    const docs = await Connector.find({
      $or: [{ scope: 'platform' }, { scope: 'user', userId }],
    }).sort({ scope: 1, name: 1 });
    res.json({ connectors: docs.map(serialize) });
  } catch {
    res.status(500).json({ message: 'Error listing connectors' });
  }
});

// Validate, live-handshake, then persist; a connector whose endpoint fails `listTools` is rejected so a bad URL can never be saved.
router.post('/', authenticate, async (req: AuthRequest, res) => {
  const parsed = connectorCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid payload' });
  }
  const { name, url } = parsed.data;
  const authToken = parsed.data.authToken?.trim();
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
  try {
    let tools;
    try {
      // One handshake total: the first call's result is reused below.
      // @see #77
      tools = await listMcpTools(url, headers);
    } catch (err) {
      // An OAuth-only endpoint probed with a bearer fails the handshake as "bad token"; when OAuth is advertised, point at the Connect flow instead.
      // @see #333
      if (await connectorAdvertisesOAuth(url)) {
        return res.status(422).json({
          message:
            'This endpoint requires OAuth sign-in — use Connect on the connector card instead of a token.',
        });
      }
      const message = err instanceof Error ? err.message : 'MCP handshake failed';
      return res.status(422).json({ message: `Connector is not reachable: ${message}` });
    }
    const doc = new Connector({
      // Only mcp.pat parses here; mcp.oauth rows come from the OAuth consent flow.
      // @see #329 #327
      type: parsed.data.type,
      scope: 'user',
      userId: req.user?.id,
      name,
      url,
      status: 'connected',
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
    });
    if (headers) {
      doc.headers = encryptEnvelope(JSON.stringify(headers));
      doc.headersConfigured = true;
    }
    await doc.save();
    return res.status(201).json({ connector: serialize(doc) });
  } catch (err) {
    if (err instanceof Error && err.name === 'ValidationError') {
      return res.status(400).json({ message: err.message });
    }
    if (err instanceof Error && 'code' in err && (err as { code?: unknown }).code === 11000) {
      return res.status(409).json({ message: 'This URL is already connected for your account' });
    }
    return res.status(500).json({ message: 'Error adding connector' });
  }
});

// Personal connectors only; platform and other users' rows are invisible by construction (404, not 403).
router.delete('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!Types.ObjectId.isValid(idParam)) {
      return res.status(404).json({ message: 'Connector not found' });
    }
    const deleted = await Connector.findOneAndDelete({
      _id: new Types.ObjectId(idParam),
      scope: 'user',
      userId: new Types.ObjectId(req.user?.id),
    });
    if (!deleted) return res.status(404).json({ message: 'Connector not found' });
    return res.status(204).end();
  } catch {
    return res.status(500).json({ message: 'Error removing connector' });
  }
});

// Begin a browser consent for an mcp.oauth connector; a non-OAuth endpoint is a 422, a duplicate URL fails fast with 409.
// @see #327
router.post('/oauth/start', authenticate, async (req: AuthRequest, res) => {
  const parsed = connectorOAuthStartSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid payload' });
  }
  const { name, url } = parsed.data;
  try {
    const userId = req.user?.id as string;
    const existing = await Connector.findOne({ scope: 'user', userId, url });
    if (existing) {
      return res.status(409).json({ message: 'This URL is already connected for your account' });
    }
    const { authorizationUrl } = await startConnectorOAuth({
      url,
      name,
      redirectOrigin: redirectOriginFrom(req.headers),
      userId,
    });
    return res.json({ authorizationUrl });
  } catch (err) {
    if (err instanceof ConnectorOAuthError) {
      return res.status(err.status).json({ message: err.message });
    }
    console.error('connector oauth start failed:', String(err));
    return res.status(500).json({ message: 'Error starting OAuth sign-in' });
  }
});

// Restart consent for an owned mcp.oauth connector with a dead grant; the callback updates the row instead of creating a new one.
// @see #327
router.post('/:id/reauth', authenticate, async (req: AuthRequest, res) => {
  const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!Types.ObjectId.isValid(idParam)) {
    return res.status(404).json({ message: 'Connector not found' });
  }
  try {
    const doc = await Connector.findOne({
      _id: new Types.ObjectId(idParam),
      scope: 'user',
      userId: new Types.ObjectId(req.user?.id),
      type: 'mcp.oauth',
    });
    if (!doc) return res.status(404).json({ message: 'Connector not found' });
    const { authorizationUrl } = await startConnectorOAuth({
      url: doc.url,
      name: doc.name,
      redirectOrigin: redirectOriginFrom(req.headers),
      userId: req.user?.id as string,
      connectorId: String(doc._id),
      existingVault: readConnectorVault(doc),
    });
    return res.json({ authorizationUrl });
  } catch (err) {
    if (err instanceof ConnectorOAuthError) {
      return res.status(err.status).json({ message: err.message });
    }
    console.error('connector oauth re-connect failed:', String(err));
    return res.status(500).json({ message: 'Error starting re-connect' });
  }
});

// Complete a consent: exchange the code, store the tokens encrypted, create or update the connector.
// @see #327
router.post('/oauth/callback', authenticate, async (req: AuthRequest, res) => {
  const parsed = connectorOAuthCallbackSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid payload' });
  }
  try {
    const doc = await completeConnectorOAuth({
      ...parsed.data,
      userId: req.user?.id as string,
    });
    // Post-consent handshake, parity with the PAT path: failure keeps the row (the grant is the expensive part) but honestly marked unreachable; re-auth heals an unreachable row too.
    // @see #330
    const vault = readConnectorVault(doc);
    if (vault) {
      try {
        const tools = await listMcpTools(doc.url, {
          Authorization: `Bearer ${vault.accessToken}`,
        });
        doc.set(
          'tools',
          tools.map((t) => ({ name: t.name, description: t.description })),
        );
        doc.status = 'connected';
      } catch (err) {
        console.error('connector post-consent handshake failed:', String(err));
        doc.status = 'unreachable';
      }
      await doc.save();
    }
    return res.status(201).json({ connector: serialize(doc) });
  } catch (err) {
    if (err instanceof ConnectorOAuthError) {
      return res.status(err.status).json({ message: err.message });
    }
    if (err instanceof Error && err.name === 'ValidationError') {
      return res.status(400).json({ message: err.message });
    }
    if (err instanceof Error && 'code' in err && (err as { code?: unknown }).code === 11000) {
      return res.status(409).json({ message: 'This URL is already connected for your account' });
    }
    return res.status(500).json({ message: 'Error completing OAuth sign-in' });
  }
});

export default router;
