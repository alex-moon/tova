import express from 'express';
import { User } from '../models/User';
import type { UserSettings } from '../models/User';
import { toAuthUser } from '../services/userService';
import { authenticate, AuthRequest } from '../middleware/auth';
import { profilePatchSchema, factoryResetSchema } from '../validation';
import { purgeAllUserData } from '../services/userDataPurge';

const router = express.Router();

// First ZDR enable auto-purge (issue #116, Q5) is REMOVED (issue #143): the
// toggle is forward-looking only now — the escape hatch for existing data is
// the explicitly confirmed factory reset below, not a side effect of a
// settings flag (companion decision on #144: per-user ZDR becomes obsolete).

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
      parsed.data.startupChat !== undefined ||
      parsed.data.confirmDeletes !== undefined ||
      parsed.data.zdr !== undefined ||
      parsed.data.incognitoByDefault !== undefined ||
      parsed.data.timezone !== undefined
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
      const startupChatPatch = parsed.data.startupChat;
      if (startupChatPatch !== undefined) {
        // Enum-validated in profilePatchSchema; no clearing endpoint — null
        // (absent) means "no explicit choice", resolved client-side to the
        // product default ('recent', issue #96).
        settings.startupChat = startupChatPatch;
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
      // (#144) `incognitoByDefault` shares the settings.zdr slot; `zdr` is
      // its legacy alias. Both present with different values is a conflict,
      // not a silently-picked winner. The first-enable purge below still
      // fires only on a legacy `zdr` first-enable (unchanged #116/#143
      // behaviour — the alias intentionally does not re-trigger purges; see
      // the plan note: toggling on a false slot still purges until #143
      // resolves the purge's fate).
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
        // Boolean-validated in profilePatchSchema. Written only when the key
        // is present (absent = untouched), mirroring `theme`/`startupChat`.
        // Forward-looking only (issue #143): the former first-enable auto-purge
        // is gone — nothing is ever deleted as a side effect of this flag;
        // wiping existing data is the explicit factory reset below.
        settings.zdr = zdrPatch;
      }
      const timezonePatch = parsed.data.timezone;
      if (timezonePatch !== undefined) {
        // IANA-validated in profilePatchSchema (#261). The client reports it
        // from the browser once per session; the prompt renders local times in
        // it. Written only when present (absent = untouched).
        settings.timezone = timezonePatch;
      }
    }

    await user.save();
    res.json({ user: toAuthUser(user) });
  } catch (_err) {
    res.status(500).json({ message: 'Error updating profile' });
  }
});

// POST /api/profile/factory-reset (issue #143): the user-deliberate escape
// hatch for a PII-storing app — a session-wide wipe of everything the account
// holds (sessions, messages, assets + their Spaces bytes, chat-scoped
// workspace files, asset-derived job rows, the entity graph, LangSmith
// traces). Requires the typed confirmation string; nothing but the account
// and its (non-data) preferences survives. `failedObjects` names any bucket
// keys the Spaces sweep could not delete so the UI can warn.
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
