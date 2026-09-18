import express from 'express';
import { Types } from 'mongoose';
import { McpServer } from '../models/McpServer';
import { mcpServerCreateSchema } from '../validation';
import { authenticate, AuthRequest } from '../middleware/auth';
import { encryptEnvelope } from '../services/crypto';
import { listMcpServerTools } from '../services/mcpService';

const router = express.Router();

/*
 * Personal MCP server registry (issue #36). Only user-scope documents exist
 * for the caller here; platform servers are surfaced read-only in GET so the
 * UI can render one list. Auth is submitted as a raw token (issue #80) and
 * stored as a single encrypted `Authorization: Bearer <token>` header, never
 * echoed: toJSON on the model strips `headers`, and the list/handshake paths
 * never put them in a response.
 */

const serialize = (doc: { toJSON: () => Record<string, unknown> }) => doc.toJSON();

// GET /api/mcp-servers — platform (read-only) + caller's personal servers.
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = new Types.ObjectId(req.user?.id);
    const docs = await McpServer.find({
      $or: [{ scope: 'platform' }, { scope: 'user', userId }],
    }).sort({ scope: 1, name: 1 });
    res.json({ servers: docs.map(serialize) });
  } catch {
    res.status(500).json({ message: 'Error listing MCP servers' });
  }
});

// POST /api/mcp-servers — validate, live-handshake, then persist. A server
// that does not complete `listTools` is rejected with its error so a bad URL
// can never be saved successfully.
router.post('/', authenticate, async (req: AuthRequest, res) => {
  const parsed = mcpServerCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid payload' });
  }
  const { name, url } = parsed.data;
  const authToken = parsed.data.authToken?.trim();
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
  try {
    try {
      await listMcpServerTools(url, headers);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'MCP handshake failed';
      return res.status(422).json({ message: `MCP server is not reachable: ${message}` });
    }
    const tools = await listMcpServerTools(url, headers);
    const doc = new McpServer({
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
    return res.status(201).json({ server: serialize(doc) });
  } catch (err) {
    if (err instanceof Error && err.name === 'ValidationError') {
      return res.status(400).json({ message: err.message });
    }
    if (err instanceof Error && 'code' in err && (err as { code?: unknown }).code === 11000) {
      return res.status(409).json({ message: 'This URL is already connected for your account' });
    }
    return res.status(500).json({ message: 'Error adding MCP server' });
  }
});

// DELETE /api/mcp-servers/:id — personal servers only; platform and other
// users' rows are invisible by construction (404, not 403).
router.delete('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!Types.ObjectId.isValid(idParam)) {
      return res.status(404).json({ message: 'MCP server not found' });
    }
    const deleted = await McpServer.findOneAndDelete({
      _id: new Types.ObjectId(idParam),
      scope: 'user',
      userId: new Types.ObjectId(req.user?.id),
    });
    if (!deleted) return res.status(404).json({ message: 'MCP server not found' });
    return res.status(204).end();
  } catch {
    return res.status(500).json({ message: 'Error removing MCP server' });
  }
});

export default router;
