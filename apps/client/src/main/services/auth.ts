import axios from 'axios';
import type { AuthUser } from '@shared/contracts';

// Normalised auth failure: message comes from the server response when one
// arrived, otherwise the fallback. Views catch AuthError and read .message
// without importing axios (PR #27 review).
export class AuthError extends Error {
  constructor(message = 'Authentication failed', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthError';
  }
}

const toAuthError = (err: unknown): AuthError => {
  if (axios.isAxiosError(err)) {
    const message = (err.response?.data as { message?: string } | undefined)?.message;
    if (message) return new AuthError(message, { cause: err });
  }
  return new AuthError('Authentication failed', { cause: err });
};

// Connector separating views/context from axios. All auth API traffic goes
// through this module; views should not import axios directly (PR #27 review).
const AuthService = {
  async me(): Promise<AuthUser | null> {
    const res = await axios.get<{ user?: AuthUser }>('/api/auth/me');
    return res.data.user ?? null;
  },

  async login(email: string, password: string): Promise<AuthUser> {
    try {
      const res = await axios.post<{ user: AuthUser }>('/api/auth/login', { email, password });
      return res.data.user;
    } catch (err) {
      throw toAuthError(err);
    }
  },

  async register(email: string, password: string): Promise<AuthUser> {
    try {
      const res = await axios.post<{ user: AuthUser }>('/api/auth/register', { email, password });
      return res.data.user;
    } catch (err) {
      throw toAuthError(err);
    }
  },

  async logout(): Promise<void> {
    await axios.post('/api/auth/logout');
  },

  // PATCHes the user-owned profile (issue #35). Sends only the keys present
  // in the patch — an empty string clears the field server-side.
  async updateProfile(patch: {
    preferredName?: string;
    customInstructions?: string;
    theme?: string;
    startupChat?: 'recent' | 'new';
    zdr?: boolean;
    incognitoByDefault?: boolean;
    confirmDeletes?: { chat?: boolean; file?: boolean };
    timezone?: string;
  }): Promise<AuthUser> {
    try {
      const res = await axios.patch<{ user: AuthUser }>('/api/profile', patch);
      return res.data.user;
    } catch (err) {
      throw toAuthError(err);
    }
  },

  // Factory reset (issue #143): the typed confirmation string must match the
  // server-side literal exactly or the wipe is refused with 400.
  async factoryReset(confirm: string): Promise<{ reset: boolean; failedObjects: string[] }> {
    try {
      const res = await axios.post<{
        reset: boolean;
        failedObjects: string[];
      }>('/api/profile/factory-reset', { confirm });
      return res.data;
    } catch (err) {
      throw toAuthError(err);
    }
  },
};

export default AuthService;
