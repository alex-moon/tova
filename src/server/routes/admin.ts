import express from 'express';
import mongoose from 'mongoose';
import { User, UserDocument } from '../models/User';
import { authenticate, requireRole, AuthRequest } from '../middleware/auth';
import { AdminUser } from '../../shared/contracts';
import { ProviderRouting } from '../models/ProviderRouting';
import { ModelMetricStat } from '../models/ModelMetricStat';

const router = express.Router();

const adminGuard = [authenticate, requireRole('admin')];

const KNOWN_PERMISSIONS = ['routing'] as const;

// Owner-protected account: cannot be demoted at all (issue #15, owner
// decision 2026-09-11). Module-level constant so a future env/config
// move is a one-line change.
export const PROTECTED_OWNER_EMAIL = 'formsatz@gmail.com';

const toPublicUser = (user: UserDocument): AdminUser => ({
  id: user._id.toString(),
  email: user.email,
  role: user.role,
  permissions: user.permissions,
  hasGoogle: user.googleId != null,
  createdAt: user.createdAt.toISOString(),
  updatedAt: user.updatedAt.toISOString(),
});

const findUserOr404 = async (id: string, res: express.Response) => {
  if (!mongoose.isValidObjectId(id)) {
    res.status(404).json({ message: 'User not found' });
    return null;
  }
  const user = await User.findById(id);
  if (!user) {
    res.status(404).json({ message: 'User not found' });
    return null;
  }
  return user;
};

router.get('/users', ...adminGuard, async (_req, res) => {
  try {
    const users = await User.find({});
    res.json(users.map(toPublicUser));
  } catch (_err) {
    res.status(500).json({ message: 'Error listing users' });
  }
});

// Read-only model inventory (issue #33): every configured routing model with
// the tiers it serves and its captured feedback tallies per band. Read
// errors degrade to empty lists; the view shows a 'no data' state instead of
// failing admin.
router.get('/models', ...adminGuard, async (_req, res) => {
  try {
    const [routes, stats] = await Promise.all([
      ProviderRouting.find({}).lean(),
      ModelMetricStat.find({}).lean(),
    ]);
    const byKey = new Map<
      string,
      {
        id: string;
        provider: string;
        model: string;
        tiers: string[];
        stats: { band: string; up: number; down: number }[];
      }
    >();
    for (const route of routes as { provider: string; model: string; tier: string }[]) {
      const key = `${route.provider}/${route.model}`;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.tiers.includes(route.tier)) existing.tiers.push(route.tier);
      } else {
        byKey.set(key, {
          id: key,
          provider: route.provider,
          model: route.model,
          tiers: [route.tier],
          stats: [],
        });
      }
    }
    for (const stat of stats as { band: string; modelName: string; up: number; down: number }[]) {
      const entry = [...byKey.values()].find((m) => m.model === stat.modelName);
      if (entry) {
        entry.stats.push({ band: stat.band, up: stat.up ?? 0, down: stat.down ?? 0 });
      }
    }
    res.json([...byKey.values()]);
  } catch (_err) {
    res.status(500).json({ message: 'Error listing models' });
  }
});

router.put('/users/:id/permissions', ...adminGuard, async (req, res) => {
  const permissions = req.body?.permissions;
  if (
    !Array.isArray(permissions) ||
    permissions.some((p) => typeof p !== 'string' || !KNOWN_PERMISSIONS.includes(p as 'routing'))
  ) {
    return res.status(400).json({ message: 'permissions must be an array of known permissions' });
  }

  try {
    const user = await findUserOr404(String(req.params.id), res);
    if (!user) return;

    user.permissions = permissions;
    await user.save();
    res.json(toPublicUser(user));
  } catch (_err) {
    res.status(500).json({ message: 'Error updating permissions' });
  }
});

router.put('/users/:id/role', ...adminGuard, async (req: AuthRequest, res) => {
  const role = req.body?.role;
  if (role !== 'user' && role !== 'admin') {
    return res.status(400).json({ message: "role must be 'user' or 'admin'" });
  }

  try {
    const user = await findUserOr404(String(req.params.id), res);
    if (!user) return;

    if (user.role === 'admin' && role === 'user' && user.email === PROTECTED_OWNER_EMAIL) {
      return res.status(400).json({ message: 'This account cannot be demoted' });
    }

    user.role = role;
    await user.save();
    res.json(toPublicUser(user));
  } catch (_err) {
    res.status(500).json({ message: 'Error updating role' });
  }
});

export default router;
