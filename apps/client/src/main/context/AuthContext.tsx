import React, { createContext, useState, useEffect, useRef } from 'react';
import AuthService from '../services/auth';
import { applyUserTheme } from '../theme';
import type { AuthUser } from '@shared/contracts';

// `Intl` reports the exact zone offline; a browser without the API yields undefined and the server keeps UTC.
// @see #261
const browserTimezone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

// Drift: login/register return a narrower payload without `permissions`; the field is undefined until /me refreshes it.
// @see #20
export type User = AuthUser;

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  // Pushes an already-fetched updated user into context, keeping every consumer in sync.
  updateUser: (user: User) => void;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        setUser(await AuthService.me());
      } catch (_err) {
        setUser(null);
      } finally {
        setLoading(false);
      }
    };
    checkAuth();
  }, []);

  const login = async (email: string, password: string) => {
    setUser(await AuthService.login(email, password));
  };

  const register = async (email: string, password: string) => {
    setUser(await AuthService.register(email, password));
  };

  const logout = async () => {
    await AuthService.logout();
    setUser(null);
  };

  const updateUser = (next: User) => setUser(next);

  // As soon as the account is known, its saved theme wins and mirrors into the cookie/storage fast path.
  // @see #53
  useEffect(() => {
    applyUserTheme(user?.theme);
  }, [user]);

  // Report the browser's zone once per session when it differs from the account's; failure is silent (falls back to UTC).
  // @see #261
  const reportedZoneRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!user) return;
    const zone = browserTimezone();
    if (!zone || zone === user.timezone || zone === reportedZoneRef.current) return;
    reportedZoneRef.current = zone;
    Promise.resolve(AuthService.updateProfile({ timezone: zone }))
      .then((updated) => {
        // Only a real payload replaces the user (a bare mock resolves undefined and must not null the session).
        if (updated) setUser(updated);
      })
      .catch(() => {
        // Un-report so a later remount retries; never block login.
        reportedZoneRef.current = undefined;
      });
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
};
