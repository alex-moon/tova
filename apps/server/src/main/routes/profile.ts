import express from 'express';
import { User } from '../models/User';
import type { UserSettings } from '../models/User';
import { toAuthUser } from '../services/userService';
import { authenticate, AuthRequest } from '../middleware/auth';
import { profilePatchSchema, factoryResetSchema } from '../validation';
import { purgeAllUserData } from '../services/userDataPurge';

const router = express.Router();

// The first-enable auto-purge is removed: the toggle is forward-looking only; the escape hatch for existing data is the explicit factory reset below.
// @see #116 #143 #144

// PATCH /api/profile — user-owned profile edits; absent keys leave fields untouched, trimmed-empty clears, unknown keys rejected by the strict zod schema.
// @see #35
// Only alphanumerics, spaces and name-typical punctuation survive so a preferred name cannot forge structured delimiters in the system prompt.
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
      parsed.data.startupChat !== undefined ||
      parsed.data.confirmDeletes !== undefined ||
      parsed.data.zdr !== undefined ||
      parsed.data.incognitoByDefault !== undefined ||
      parsed.data.timezone !== undefined
    ) {
      if (!user.settings) {
        // Mongoose applies the schema default for any field omitted from the literal, so a fresh settings doc needs no explicit theme.
        user.settings = { customInstructions: null } as UserSettings;
      }
      // TypeScript cannot narrow `user.settings` across the creation guard; both patch blocks use a locally narrowed variable.
      const settings = user.settings;
      if (!settings) throw new Error('unreachable: settings were just ensured');
      if ('customInstructions' in parsed.data) {
        const trimmedPrompt = parsed.data.customInstructions?.trim();
        if (trimmedPrompt) {
          settings.customInstructions = trimmedPrompt;
        } else {
          // Cleared prompts round-trip as null rather than '' — '' would block per-user prompt resolution downstream.
          settings.customInstructions = null;
        }
      }
      const themePatch = parsed.data.theme;
      if (themePatch !== undefined) {
        // Enum-validated in profilePatchSchema; absence means "no explicit choice" and the client follows system preference then light.
        settings.theme = themePatch;
      }
      const startupChatPatch = parsed.data.startupChat;
      if (startupChatPatch !== undefined) {
        // Enum-validated in profilePatchSchema; absent means "no explicit choice", resolved client-side to the product default.
        // @see #96
        settings.startupChat = startupChatPatch;
      }
      const confirmDeletesPatch = parsed.data.confirmDeletes;
      if (confirmDeletesPatch !== undefined) {
        // Merge per key: a single-key PATCH must leave the other key's persisted value intact (a schema default would re-enable confirmations the user turned off); never-written keys fall back to the default.
        // @see #59
        const existing = settings.confirmDeletes;
        settings.confirmDeletes = {
          chat: confirmDeletesPatch.chat ?? existing?.chat ?? true,
          file: confirmDeletesPatch.file ?? existing?.file ?? true,
        };
      }
      // `incognitoByDefault` shares the settings.zdr slot (`zdr` is the legacy alias); both present with different values is a conflict; the alias never re-triggers purges.
      // @see #144 #116 #143
      if (
        parsed.data.zdr !== undefined &&
        parsed.data.incognitoByDefault !== undefined &&
        parsed.data.zdr !== parsed.data.incognitoByDefault
      ) {
        return res
          .status(400)
          .json({ message: 'zdr and incognitoByDefault must match when both are set' });
      }
      const zdrPatch = parsed.data.zdr ?? parsed.data.incognitoByDefault;
      if (zdrPatch !== undefined) {
        // Boolean-validated; written only when the key is present; forward-looking only — nothing is ever deleted as a side effect.
        // @see #143
        settings.zdr = zdrPatch;
      }
      const timezonePatch = parsed.data.timezone;
      if (timezonePatch !== undefined) {
        // IANA-validated; the client reports it once per session and the prompt renders local times in it; written only when present.
        // @see #261
        settings.timezone = timezonePatch;
      }
    }

    await user.save();
    res.json({ user: toAuthUser(user) });
  } catch (_err) {
    res.status(500).json({ message: 'Error updating profile' });
  }
});

// The user-deliberate escape hatch: a session-wide wipe of everything the account holds; requires the typed confirmation; `failedObjects` names keys the Spaces sweep could not delete.
// @see #143
router.post('/factory-reset', authenticate, async (req: AuthRequest, res) => {
  try {
    const parsed = factoryResetSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: parsed.error.issues[0]?.message ?? 'Invalid payload' });
    }
    const { failedObjects } = await purgeAllUserData(req.user?.id ?? '');
    res.json({ reset: true, failedObjects });
  } catch (_err) {
    res.status(500).json({ message: 'Error performing factory reset' });
  }
});

export default router;
