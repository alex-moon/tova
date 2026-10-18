import express from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { adminGuard, AuthRequest } from '../middleware/auth';
import { Pat } from '../models/Pat';
import { User } from '../models/User';
import { zodMessage, createPatSchema } from '../validation';
import type { AdminPatsPayload } from '@tova/shared';

const router = express.Router();

// admin.ts's guard, plus a PAT-bearer leg so agents and cookies share it.
// @see #184

router.get('/pats', ...adminGuard, async (_req, res) => {
  try {
    const pats = await Pat.find().sort({ createdAt: -1 }).lean();
    // Resolve creator emails in one query rather than per-row.
    const users = await User.find({ _id: { $in: pats.map((p) => p.userId) } }).lean();
    const emailOf = new Map(users.map((u) => [u._id.toString(), u.email]));
    const payload: AdminPatsPayload = {
      pats: pats.map((p) => ({
        id: p._id.toString(),
        name: p.name,
        createdAt: p.createdAt.toISOString(),
        lastUsedAt: p.lastUsedAt ? p.lastUsedAt.toISOString() : null,
        expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null,
        // Null only for a deleted creator; tokens for one are refused.
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
    return res.status(400).json({ message: zodMessage(parsed, 'Invalid payload') });
  }

  try {
    // Plaintext shown once, never persisted (digest only) nor logged.
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

// Deleting the row 401s the very next request with the token.
// @see #184
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
