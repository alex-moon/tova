import React, { createContext, useState, useEffect, useRef } from 'react';
import AuthService from '../services/auth';
import { applyUserTheme } from '../theme';
import type { AuthUser } from '@shared/contracts';

// Browser IANA timezone (#261): `Intl` reports the exact zone (e.g.
// 'Europe/London') offline, no dependency. Guarded — a browser without the
// API (or an exotic throw) yields undefined and the server keeps UTC.
const browserTimezone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

// Re-export of the shared /api/auth/me contract. NOTE (drift, issue #20):
// POST /api/auth/login and /register return a narrower payload without
// `permissions` (LoginUserPayload), while this type claims it — the field
// is undefined right after login until /me refreshes it.
export type User = AuthUser;

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  // Pushes an already-fetched updated user (e.g. the PATCH /api/profile
  // response) into context, keeping every consumer in sync.
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

  // Per-user theme (#53): as soon as the account is known, its saved theme
  // wins and mirrors into the cookie/storage fast path.
  useEffect(() => {
    applyUserTheme(user?.theme);
  }, [user]);

  // Timezone report (#261): once per authenticated session, tell the server
  // which zone the user is actually in (travel, DST, a new device — the
  // browser is the only honest source). Sent only when it differs from what
  // the account already stores, so a steady clock costs nothing. Failure is
  // silent: the prompt just falls back to UTC until the next session.
  const reportedZoneRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!user) return;
    const zone = browserTimezone();
    if (!zone || zone === user.timezone || zone === reportedZoneRef.current) return;
    reportedZoneRef.current = zone;
    Promise.resolve(AuthService.updateProfile({ timezone: zone }))
      .then((updated) => {
        // Only a real payload replaces the user (a bare mock resolves
        // undefined and must not null the session).
        if (updated) setUser(updated);
      })
      .catch(() => {
        // Un-report on failure so a later remount retries; never block login.
        reportedZoneRef.current = undefined;
      });
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
};
