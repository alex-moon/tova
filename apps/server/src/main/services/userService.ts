import crypto from 'crypto';
import { User, UserDocument } from '../models/User';
import { AuthUser } from '@tova/shared';

// Single projection from a user document to the /me wire shape, shared with PATCH /api/profile so the endpoints cannot drift.
// @see #35
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
  if (user.settings?.customInstructions)
    payload.customInstructions = user.settings.customInstructions;
  if (user.settings?.theme) payload.theme = user.settings.theme;
  if (user.settings?.startupChat) payload.startupChat = user.settings.startupChat;
  if (user.settings?.zdr) {
    payload.zdr = user.settings.zdr;
    // 'Incognito by default' reads the same storage slot; the two wire names are aliases of one flag, exposed in lockstep.
    // @see #144
    payload.incognitoByDefault = user.settings.zdr;
  }
  if (user.settings?.confirmDeletes) payload.confirmDeletes = user.settings.confirmDeletes;
  // IANA timezone rides only once captured from the browser.
  // @see #261
  if (user.settings?.timezone) payload.timezone = user.settings.timezone;
  // Country-level geolocation rides only once resolved; no timestamp exposed.
  // @see #50
  if (user.location?.country && user.location.countryCode)
    payload.location = {
      country: user.location.country,
      countryCode: user.location.countryCode,
    };
  return payload;
};

export const ROUTING_PERMISSION = 'routing';

export const hasPermission = async (userId: string, permission: string): Promise<boolean> => {
  const user = await User.findById(userId, 'permissions');
  return Boolean(user?.permissions?.includes(permission));
};

// Resolve a user by email, linking the Google identity when provided; new users get no permissions; Google-owned fields overwrite on refresh, user-owned fields are never touched here.
// @see #35
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
