import crypto from 'crypto';
import { User, UserDocument } from '../models/User';

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
