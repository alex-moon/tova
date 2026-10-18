import express from 'express';
import { User } from '../models/User';
import type { UserSettings } from '../models/User';
import { toAuthUser } from '../services/userService';
import { authenticate, AuthRequest } from '../middleware/auth';
import { zodMessage, profilePatchSchema, factoryResetSchema } from '../validation';
import { purgeAllUserData } from '../services/userDataPurge';

const router = express.Router();

// The toggle is forward-looking; wiping is the explicit factory reset.
// @see #116 #143 #144

// PATCH /api/profile: absent keys untouched, empty clears, junk 400s.
// @see #35
// Preferred names can't forge structured delimiters in the prompt.
const PREFERRED_NAME_STRIP = /[^a-zA-Z0-9 ,:'-]/g;

export const sanitizePreferredName = (raw: string): string =>
  raw.replace(PREFERRED_NAME_STRIP, '').trim();

router.patch('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const parsed = profilePatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: zodMessage(parsed, 'Invalid payload') });
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
        // Schema defaults cover omitted fields; no explicit theme needed.
        user.settings = { customInstructions: null } as UserSettings;
      }
      // TS cannot narrow `user.settings` here; use the narrowed alias.
      const settings = user.settings;
      if (!settings) throw new Error('unreachable: settings were just ensured');
      if ('customInstructions' in parsed.data) {
        const trimmedPrompt = parsed.data.customInstructions?.trim();
        if (trimmedPrompt) {
          settings.customInstructions = trimmedPrompt;
        } else {
          // Cleared prompts round-trip as null; '' would block resolution.
          settings.customInstructions = null;
        }
      }
      const themePatch = parsed.data.theme;
      if (themePatch !== undefined) {
        // Enum-validated; absent means "no explicit choice".
        settings.theme = themePatch;
      }
      const startupChatPatch = parsed.data.startupChat;
      if (startupChatPatch !== undefined) {
        // Enum-validated; absent resolves client-side to the default.
        // @see #96
        settings.startupChat = startupChatPatch;
      }
      const confirmDeletesPatch = parsed.data.confirmDeletes;
      if (confirmDeletesPatch !== undefined) {
        // Merge per key: a single-key PATCH leaves the other key alone.
        // @see #59
        const existing = settings.confirmDeletes;
        settings.confirmDeletes = {
          chat: confirmDeletesPatch.chat ?? existing?.chat ?? true,
          file: confirmDeletesPatch.file ?? existing?.file ?? true,
        };
      }
      // `incognitoByDefault` shares the settings.zdr slot; alias kept.
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
        // Written only when present; nothing is deleted as a side effect.
        // @see #143
        settings.zdr = zdrPatch;
      }
      const timezonePatch = parsed.data.timezone;
      if (timezonePatch !== undefined) {
        // IANA-validated; written only when the key is present.
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

// User-deliberate wipe of the account's data; needs typed confirmation.
// @see #143
router.post('/factory-reset', authenticate, async (req: AuthRequest, res) => {
  try {
    const parsed = factoryResetSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: zodMessage(parsed, 'Invalid payload') });
    }
    const { failedObjects } = await purgeAllUserData(req.user?.id ?? '');
    res.json({ reset: true, failedObjects });
  } catch (_err) {
    res.status(500).json({ message: 'Error performing factory reset' });
  }
});

export default router;
