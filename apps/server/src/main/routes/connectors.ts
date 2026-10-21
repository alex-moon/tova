import express from 'express';
import { Types } from 'mongoose';
import type { ConnectorInfo } from '@tova/shared';
import { Connector } from '../models/Connector';
import type { ConnectorDocument } from '../models/Connector';
import {
  connectorCreateSchema,
  connectorOAuthCallbackSchema,
  connectorOAuthStartSchema,
  zodMessage,
} from '../validation';
import { authenticate, AuthRequest } from '../middleware/auth';
import { encryptEnvelope } from '../services/connectors/crypto';
import { redactForLog } from '../services/logRedaction';
import { listMcpTools } from '../services/connectors/connectorService';
import {
  ConnectorOAuthError,
  completeConnectorOAuth,
  hasVaultedAuth,
  probeConnectorOAuth,
  readConnectorVault,
  redirectOriginFrom,
  startConnectorOAuth,
} from '../services/connectors/oauthConnectors';

const router = express.Router();

// Discovery probe for add-time copy; a failed probe answers false.
// @see #333
const connectorAdvertisesOAuth = async (url: string): Promise<boolean> => {
  try {
    return (await probeConnectorOAuth(url)) !== null;
  } catch {
    return false;
  }
};

/* Personal connector registry; platform rows are read-only in GET. */
// @see #36 #329 #80

// Wire projection: storage fields map onto the generic contract.
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

// Validate, handshake, then persist; a failed `listTools` is rejected.
router.post('/', authenticate, async (req: AuthRequest, res) => {
  const parsed = connectorCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: zodMessage(parsed, 'Invalid payload') });
  }
  const { name, url } = parsed.data;
  const rawToken = parsed.data.authToken?.trim();
  // A pasted value may include the scheme or the whole header; wrap exactly one Bearer.
  // @see #403
  const authToken = rawToken
    ?.replace(/^authorization:\s*/i, '')
    .replace(/^bearer(?=\s|$)/i, '')
    .trim();
  // A scheme-only paste strips to nothing; say so instead of probing with a bad header.
  // @see #403
  if (rawToken && !authToken) {
    return res
      .status(400)
      .json({ message: 'Paste the key only — the Bearer scheme alone is not a key.' });
  }
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
  try {
    let tools;
    try {
      // One handshake total: the first call's result is reused below.
      // @see #77
      tools = await listMcpTools(url, headers);
    } catch (err) {
      // OAuth-only + bearer probe: point at the Connect flow instead.
      // @see #333
      if (await connectorAdvertisesOAuth(url)) {
        return res.status(422).json({
          message:
            'This endpoint requires OAuth sign-in — use Connect on the connector card instead of a token.',
        });
      }
      // Upstream error text can name internal hosts; keep it in the log.
      // @see #397
      console.warn('MCP handshake failed:', redactForLog(err));
      return res
        .status(422)
        .json({ message: 'Connector is not reachable — verify the URL and token.' });
    }
    const doc = new Connector({
      // Only mcp.pat parses here; mcp.oauth comes from consent.
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

// Personal connectors only; others' rows are 404s, never 403s.
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

// Begin consent for mcp.oauth; non-OAuth is 422, duplicate URL 409.
// @see #327
router.post('/oauth/start', authenticate, async (req: AuthRequest, res) => {
  const parsed = connectorOAuthStartSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: zodMessage(parsed, 'Invalid payload') });
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

// Restart consent for a dead grant; the callback updates the row.
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

// Complete consent: exchange code, store tokens, upsert connector.
// @see #327
router.post('/oauth/callback', authenticate, async (req: AuthRequest, res) => {
  const parsed = connectorOAuthCallbackSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: zodMessage(parsed, 'Invalid payload') });
  }
  try {
    const doc = await completeConnectorOAuth({
      ...parsed.data,
      userId: req.user?.id as string,
    });
    // Post-consent handshake; failure keeps the row, marked unreachable.
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
