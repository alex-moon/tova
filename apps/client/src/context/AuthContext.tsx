import React, { createContext, useState, useEffect } from 'react';
import AuthService from '../services/auth';
import { applyUserTheme } from '../theme';
import type { AuthUser } from '@shared/contracts';

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

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
};
