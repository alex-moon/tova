import axios from 'axios';
import type { AuthUser } from '@shared/contracts';

// Connector separating views/context from axios. All auth API traffic goes
// through this module; views should not import axios directly (PR #27 review).
const AuthService = {
  async me(): Promise<AuthUser | null> {
    const res = await axios.get<{ user?: AuthUser }>('/api/auth/me');
    return res.data.user ?? null;
  },

  async login(email: string, password: string): Promise<AuthUser> {
    const res = await axios.post<{ user: AuthUser }>('/api/auth/login', { email, password });
    return res.data.user;
  },

  async register(email: string, password: string): Promise<AuthUser> {
    const res = await axios.post<{ user: AuthUser }>('/api/auth/register', { email, password });
    return res.data.user;
  },

  async logout(): Promise<void> {
    await axios.post('/api/auth/logout');
  },
};

export default AuthService;
