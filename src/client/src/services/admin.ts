import axios from 'axios';
import type { AdminUser } from '../types/admin';

// Connector separating views from axios. All admin API traffic goes through
// this class; views should not import axios directly (PR #19 review).
const AdminService = {
  async listUsers(): Promise<AdminUser[]> {
    const res = await axios.get<AdminUser[]>('/api/admin/users');
    return res.data;
  },

  async updatePermissions(id: string, permissions: string[]): Promise<AdminUser> {
    const res = await axios.put<AdminUser>(`/api/admin/users/${id}/permissions`, { permissions });
    return res.data;
  },

  async updateRole(id: string, role: 'user' | 'admin'): Promise<AdminUser> {
    const res = await axios.put<AdminUser>(`/api/admin/users/${id}/role`, { role });
    return res.data;
  },
};

export const getErrorMessage = (err: unknown, fallback: string) => {
  if (axios.isAxiosError(err)) {
    const message = (err.response?.data as { message?: string } | undefined)?.message;
    if (message) return message;
  }
  return fallback;
};

export default AdminService;
