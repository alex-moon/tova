import express from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { authenticateBearerOrSession, requireRole, AuthRequest } from '../middleware/auth';
import { Pat } from '../models/Pat';
import { User } from '../models/User';
import { createPatSchema } from '../validation';
import type { AdminPatsPayload } from '../../shared/contracts';

const router = express.Router();

// Same guard as admin.ts, but the first leg also accepts PAT bearer auth
// (#184) so the agent/CLI path and the admin-view cookie path share these
// routes.
const adminGuard = [authenticateBearerOrSession, requireRole('admin')];

router.get('/pats', ...adminGuard, async (_req, res) => {
  try {
    const pats = await Pat.find().sort({ createdAt: -1 }).lean();
    // A handful of creators at most: resolve emails in one query rather
    // than per-row.
    const users = await User.find({ _id: { $in: pats.map((p) => p.userId) } }).lean();
    const emailOf = new Map(users.map((u) => [u._id.toString(), u.email]));
    const payload: AdminPatsPayload = {
      pats: pats.map((p) => ({
        id: p._id.toString(),
        name: p.name,
        createdAt: p.createdAt.toISOString(),
        lastUsedAt: p.lastUsedAt ? p.lastUsedAt.toISOString() : null,
        expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null,
        // Null only for a deleted creator — the middleware already refuses
        // to authenticate such tokens, so this is a display edge case.
        creatorEmail: emailOf.get(p.userId.toString()) ?? null,
      })),
    };
    res.json(payload);
  } catch (_err) {
    res.status(500).json({ message: 'Error loading tokens' });
  }
});

router.post('/pats', ...adminGuard, async (req: AuthRequest, res) => {
  const parsed = createPatSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid payload' });
  }

  try {
    // 32 random bytes: the plaintext is shown exactly once in this response,
    // never persisted (only the sha256 digest is) and never logged.
    const token = `tova_pat_${crypto.randomBytes(32).toString('base64url')}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const pat = await Pat.create({
      name: parsed.data.name,
      tokenHash,
      userId: req.user?.id,
    });
    res.status(201).json({
      pat: {
        id: pat._id.toString(),
        name: pat.name,
        token,
        createdAt: pat.createdAt.toISOString(),
      },
    });
  } catch (_err) {
    res.status(500).json({ message: 'Error creating token' });
  }
});

// Revocation (#184): deleting the row makes the very next request with the
// token 401 — the middleware looks the hash up per request.
router.delete('/pats/:id', ...adminGuard, async (req, res) => {
  const id = String(req.params.id);
  if (!mongoose.isValidObjectId(id)) {
    return res.status(404).json({ message: 'Token not found' });
  }
  try {
    const result = await Pat.deleteOne({ _id: id });
    if (result.deletedCount === 0) return res.status(404).json({ message: 'Token not found' });
    res.json({ message: 'Token revoked' });
  } catch (_err) {
    res.status(500).json({ message: 'Error revoking token' });
  }
});

export default router;
