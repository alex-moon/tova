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
// preferredName charset (PR #46 review, 2026-09-13): only alphanumerics,
// spaces and name-typical punctuation survive; anything JSON/XML-ish
// ({, }, <, >, ", $, backticks, etc.) is stripped, then trimmed, so a
// preferred name cannot forge structured delimiters in the system prompt.
const PREFERRED_NAME_STRIP = /[^a-zA-Z0-9 ,:'-]/g;

export const sanitizePreferredName = (raw: string): string =>
  raw.replace(PREFERRED_NAME_STRIP, '').trim();

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
      const cleaned = parsed.data.preferredName
        ? sanitizePreferredName(parsed.data.preferredName)
        : '';
      user.preferredName = cleaned ? cleaned : null;
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
