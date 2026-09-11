import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import AdminView, { type AdminUser } from './AdminView';

const axiosGet = vi.fn();
const axiosPut = vi.fn();

vi.mock('axios', () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    put: (...args: unknown[]) => axiosPut(...args),
    isAxiosError: vi.fn(() => false),
  },
}));

const admin = (): AdminUser => ({
  id: 'u1',
  email: 'someone@example.com',
  role: 'admin',
  permissions: ['routing'],
  hasGoogle: false,
  createdAt: '2026-09-11T00:00:00.000Z',
  updatedAt: '2026-09-11T00:00:00.000Z',
});

describe('AdminView', () => {
  afterEach(cleanup);

  beforeEach(() => {
    axiosGet.mockReset().mockResolvedValue({ data: [admin()] });
    axiosPut.mockReset();
  });

  it('renders user rows from the admin API', async () => {
    render(<AdminView />);
    expect(await screen.findByText('someone@example.com')).toBeInTheDocument();
    expect(screen.getByTestId('role-someone@example.com')).toHaveTextContent('admin');
  });

  it('toggles a permission via the API and updates the row', async () => {
    axiosPut.mockResolvedValue({
      data: { ...admin(), permissions: [] },
    });
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('toggle-routing-someone@example.com'));
    await waitFor(() =>
      expect(axiosPut).toHaveBeenCalledWith('/api/admin/users/u1/permissions', {
        permissions: [],
      }),
    );
    expect(await screen.findByText('no routing')).toBeInTheDocument();
  });

  it('toggles role via the API', async () => {
    axiosPut.mockResolvedValue({ data: { ...admin(), role: 'user' } });
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('toggle-role-someone@example.com'));
    await waitFor(() =>
      expect(axiosPut).toHaveBeenCalledWith('/api/admin/users/u1/role', { role: 'user' }),
    );
  });

  it('shows the API error message inline when an update fails', async () => {
    axiosPut.mockRejectedValue(new Error('boom'));
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('toggle-role-someone@example.com'));
    expect(await screen.findByTestId('admin-error')).toHaveTextContent('Failed to update role.');
  });
});
