import axios from 'axios';
import type { AuthUser } from '@shared/contracts';

// Normalised auth failure: server message when one arrived, else the fallback; views read .message without importing axios.
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

// Connector separating views/context from axios; all auth API traffic goes through this module.
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

  // PATCHes the user-owned profile; sends only the keys present — an empty string clears the field.
  // @see #35
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

  // Factory reset: the typed confirmation string must match the server-side literal exactly.
  // @see #143
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
