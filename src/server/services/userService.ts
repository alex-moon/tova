import crypto from 'crypto';
import { User, UserDocument } from '../models/User';
import { AuthUser } from '../../shared/contracts';

// Single projection from a user document to the GET /api/auth/me wire shape.
// Shared with PATCH /api/profile so the two endpoints cannot drift (issue #35).
export const toAuthUser = (user: UserDocument): AuthUser => {
  const payload: AuthUser = {
    id: user._id.toString(),
    email: user.email,
    role: user.role,
    permissions: user.permissions,
  };
  if (user.name) payload.name = user.name;
  if (user.avatarUrl) payload.avatarUrl = user.avatarUrl;
  if (user.preferredName) payload.preferredName = user.preferredName;
  if (user.settings?.systemPrompt) payload.systemPrompt = user.settings.systemPrompt;
  return payload;
};

export const ROUTING_PERMISSION = 'routing';

export const hasPermission = async (userId: string, permission: string): Promise<boolean> => {
  const user = await User.findById(userId, 'permissions');
  return Boolean(user?.permissions?.includes(permission));
};

// Resolve a user by email: existing emails resolve to that user (linking the
// Google identity if provided); otherwise a new user is created. New users do
// not get any permissions, so they cannot use the model router until granted.
// `profile` (Google-owned name/avatar) is stored on create and overwritten on
// refresh; user-owned fields (preferredName, settings) are never touched here.
export const resolveOrCreateUser = async (
  email: string,
  googleId?: string,
  profile?: { name?: string; avatarUrl?: string },
): Promise<UserDocument> => {
  const user = await User.findOne({ email });
  if (user) {
    if (googleId && !user.googleId) {
      user.googleId = googleId;
    }
    if (profile) {
      if (profile.name !== undefined) user.name = profile.name;
      if (profile.avatarUrl !== undefined) user.avatarUrl = profile.avatarUrl;
    }
    if (user.isModified()) {
      await user.save();
    }
    return user;
  }

  const passwordHash = crypto.randomBytes(32).toString('hex');
  const created = await User.create({
    email,
    passwordHash,
    role: 'user',
    ...(googleId ? { googleId } : {}),
    ...(profile?.name ? { name: profile.name } : {}),
    ...(profile?.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
    permissions: [],
  });
  return created;
};
