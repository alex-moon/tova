import express from 'express';
import { User } from '../models/User';
import type { UserSettings } from '../models/User';
import { toAuthUser } from '../services/userService';
import { authenticate, AuthRequest } from '../middleware/auth';
import { profilePatchSchema } from '../validation';

const router = express.Router();

// PATCH /api/profile — user-owned profile edits (issue #35).
//
// Body semantics: a key absent from the body leaves its field untouched; a
// key present sets the field, and a trimmed-empty string clears it
// (preferredName → null, customInstructions removed). Unknown keys are rejected
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
    if (
      'customInstructions' in parsed.data ||
      parsed.data.theme !== undefined ||
      parsed.data.confirmDeletes !== undefined
    ) {
      if (!user.settings) {
        // Mongoose applies the schema default (null) for any field omitted
        // from the literal, so a fresh settings doc needs no explicit theme.
        user.settings = { customInstructions: null } as UserSettings;
      }
      // The guard above creates the subdocument, but TypeScript cannot
      // narrow `user.settings` (a mongoose property) across it — both patch
      // blocks operate on a locally narrowed variable instead.
      const settings = user.settings;
      if (!settings) throw new Error('unreachable: settings were just ensured');
      if ('customInstructions' in parsed.data) {
        const trimmedPrompt = parsed.data.customInstructions?.trim();
        if (trimmedPrompt) {
          settings.customInstructions = trimmedPrompt;
        } else {
          // Cleared prompts round-trip as null (the schema default) rather
          // than '' — '' would block per-user prompt resolution downstream.
          settings.customInstructions = null;
        }
      }
      const themePatch = parsed.data.theme;
      if (themePatch !== undefined) {
        // Enum-validated in profilePatchSchema; no clearing endpoint — the
        // UI offers Light/Dark, absence (undefined/null) means "no explicit
        // choice" and the client follows system preference then light.
        settings.theme = themePatch;
      }
      const confirmDeletesPatch = parsed.data.confirmDeletes;
      if (confirmDeletesPatch !== undefined) {
        // Merge per key: a single-key PATCH ({ chat: false }) must leave the
        // other key's *persisted* value intact — forcing it to the schema
        // default (true) would silently re-enable confirmations the user
        // already turned off with "Always" (issue #59). Only when the key has
        // never been written do we fall back to the default (true), which
        // needs no backfill.
        const existing = settings.confirmDeletes;
        settings.confirmDeletes = {
          chat: confirmDeletesPatch.chat ?? existing?.chat ?? true,
          file: confirmDeletesPatch.file ?? existing?.file ?? true,
        };
      }
    }

    await user.save();
    res.json({ user: toAuthUser(user) });
  } catch (_err) {
    res.status(500).json({ message: 'Error updating profile' });
  }
});

export default router;
