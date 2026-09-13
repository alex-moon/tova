import express from 'express';
import { User } from '../models/User';
import { toAuthUser } from '../services/userService';
import { authenticate, AuthRequest } from '../middleware/auth';
import { profilePatchSchema } from '../validation';

const router = express.Router();

// PATCH /api/profile — user-owned profile edits (issue #35).
//
// Body semantics: a key absent from the body leaves its field untouched; a
// key present sets the field, and a trimmed-empty string clears it
// (preferredName → null, systemPrompt removed). Unknown keys are rejected
// with 400 by the strict zod schema exactly as in validation.ts.
router.patch('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const parsed = profilePatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: parsed.error.issues[0]?.message ?? 'Invalid payload' });
    }

    const user = await User.findById(req.user?.id);
    if (!user) {
      res.clearCookie('token');
      return res.status(401).json({ message: 'User no longer exists' });
    }

    if ('preferredName' in parsed.data) {
      const trimmed = parsed.data.preferredName?.trim();
      user.preferredName = trimmed ? trimmed : null;
    }
    if ('systemPrompt' in parsed.data) {
      if (!user.settings) user.settings = { systemPrompt: null };
      const trimmedPrompt = parsed.data.systemPrompt?.trim();
      if (trimmedPrompt) {
        user.settings.systemPrompt = trimmedPrompt;
      } else {
        // Cleared prompts round-trip as null (the schema default) rather than
        // '' — '' would block per-user prompt resolution downstream. The
        // resolver treats null/undefined exactly like absence.
        user.settings.systemPrompt = null;
      }
    }

    await user.save();
    res.json({ user: toAuthUser(user) });
  } catch (_err) {
    res.status(500).json({ message: 'Error updating profile' });
  }
});

export default router;
