import express from 'express';
import { Types } from 'mongoose';
import type { ConnectorInfo } from '@tova/shared';
import { Connector } from '../models/Connector';
import type { ConnectorDocument } from '../models/Connector';
import { connectorCreateSchema } from '../validation';
import { authenticate, AuthRequest } from '../middleware/auth';
import { encryptEnvelope } from '../services/crypto';
import { listMcpTools } from '../services/connectorService';

const router = express.Router();

/*
 * Personal connector registry (issues #36, #329). Only user-scope documents
 * exist for the caller here; platform connectors are surfaced read-only in
 * GET so the UI can render one list. Auth is submitted as a raw token (issue
 * #80) and stored as a single encrypted `Authorization: Bearer <token>`
 * header, never echoed: toJSON on the model strips `headers`, and the
 * list/handshake paths never put them in a response.
 */

// Explicit wire projection (#329): per-type storage fields map onto the
// generic ConnectorInfo contract (authConfigured), and the envelope fields
// are excluded by construction — not merely stripped after toJSON.
const serialize = (doc: ConnectorDocument): ConnectorInfo => ({
  id: String(doc._id),
  scope: doc.scope,
  type: doc.type,
  name: doc.name,
  url: doc.url,
  status: doc.status,
  authConfigured: doc.headersConfigured,
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

// POST /api/connectors — validate, live-handshake, then persist. A connector
// whose endpoint does not complete `listTools` is rejected with its error so
// a bad URL can never be saved successfully.
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
      // One handshake total (#77): the first call's result is reused below
      // instead of triggering a second connection round-trip.
      tools = await listMcpTools(url, headers);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'MCP handshake failed';
      return res.status(422).json({ message: `Connector is not reachable: ${message}` });
    }
    const doc = new Connector({
      // Only mcp.pat parses today (#329); #327 adds the mcp.oauth path.
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

// DELETE /api/connectors/:id — personal connectors only; platform and other
// users' rows are invisible by construction (404, not 403).
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

export default router;
