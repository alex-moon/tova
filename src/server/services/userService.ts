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
export const resolveOrCreateUser = async (
  email: string,
  googleId?: string,
): Promise<UserDocument> => {
  const user = await User.findOne({ email });
  if (user) {
    if (googleId && !user.googleId) {
      user.googleId = googleId;
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
    permissions: [],
  });
  return created;
};
