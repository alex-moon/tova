import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import AdminView from './AdminView';
import { AdminError } from '../services/admin';
import type { AdminUser } from '../types/admin';

const listUsers = vi.fn();
const updatePermissions = vi.fn();
const updateRole = vi.fn();
const listModels = vi.fn();

vi.mock('../services/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/admin')>();
  return {
    ...actual,
    default: {
      listUsers: (...args: unknown[]) => listUsers(...args),
      updatePermissions: (...args: unknown[]) => updatePermissions(...args),
      updateRole: (...args: unknown[]) => updateRole(...args),
    },
    AdminModelsService: { listModels: (...args: unknown[]) => listModels(...args) },
  };
});

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
    listUsers.mockReset().mockResolvedValue([admin()]);
    listModels.mockReset().mockResolvedValue([]);
    updatePermissions.mockReset();
    updateRole.mockReset();
  });

  it('renders user rows from the admin API', async () => {
    render(<AdminView />);
    expect(screen.getByText('Loading users...')).toBeInTheDocument();
    expect(await screen.findByText('someone@example.com')).toBeInTheDocument();
    expect(screen.getByTestId('role-someone@example.com')).toHaveTextContent('admin');
    expect(screen.queryByText('Loading users...')).not.toBeInTheDocument();
  });

  it('toggles a permission checkbox off via the API and updates the row', async () => {
    updatePermissions.mockResolvedValue({ ...admin(), permissions: [] });
    render(<AdminView />);
    const checkbox = await screen.findByTestId('perm-routing-someone@example.com');
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    await waitFor(() => expect(updatePermissions).toHaveBeenCalledWith('u1', []));
  });

  it('toggles a permission checkbox on when the user lacks it', async () => {
    listUsers.mockResolvedValue([{ ...admin(), permissions: [] }]);
    updatePermissions.mockResolvedValue(admin());
    render(<AdminView />);
    const checkbox = await screen.findByTestId('perm-routing-someone@example.com');
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    await waitFor(() => expect(updatePermissions).toHaveBeenCalledWith('u1', ['routing']));
    expect(await screen.findByTestId('perm-routing-someone@example.com')).toBeChecked();
  });

  it('toggles role via the API', async () => {
    updateRole.mockResolvedValue({ ...admin(), role: 'user' });
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('toggle-role-someone@example.com'));
    await waitFor(() => expect(updateRole).toHaveBeenCalledWith('u1', 'user'));
  });

  it('shows the API error message inline when an update fails', async () => {
    updateRole.mockRejectedValue(new AdminError('Failed to update role.'));
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('toggle-role-someone@example.com'));
    expect(await screen.findByTestId('admin-error')).toHaveTextContent('Failed to update role.');
  });
});

describe('AdminView models table (issue #33)', () => {
  afterEach(cleanup);

  beforeEach(() => {
    listUsers.mockReset().mockResolvedValue([admin()]);
    updatePermissions.mockReset().mockResolvedValue(admin());
    updateRole.mockReset().mockResolvedValue(admin());
  });

  it('renders configured models as a read-only table', async () => {
    listModels.mockResolvedValue([
      {
        id: 'groq/test-large',
        provider: 'groq',
        model: 'test-large',
        tiers: ['large', 'guard'],
        stats: [{ band: 'short|prose', up: 3, down: 1 }],
      },
    ]);
    render(<AdminView />);
    expect(await screen.findByTestId('admin-view')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-tab-models'));
    expect(await screen.findByTestId('admin-models')).toBeInTheDocument();
    expect(screen.getByTestId('admin-model-groq/test-large')).toHaveTextContent('test-large');
    expect(screen.getByTestId('admin-models')).toHaveTextContent('large, guard');
    expect(screen.getByTestId('admin-models')).toHaveTextContent('short|prose: 3↑ 1↓');
    expect(screen.queryByText('Loading users...')).not.toBeInTheDocument();
  });

  it('shows an empty state when no models are configured', async () => {
    listModels.mockResolvedValue([]);
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    expect(await screen.findByText('No models configured.')).toBeInTheDocument();
  });
});

describe('AdminView layout (issue #91)', () => {
  afterEach(cleanup);

  beforeEach(() => {
    listUsers.mockReset().mockResolvedValue([admin()]);
    listModels.mockReset().mockResolvedValue([]);
    updatePermissions.mockReset();
    updateRole.mockReset();
  });

  it('keeps the header and nav outside the scroller, with the users table inside it', async () => {
    render(<AdminView />);
    const view = await screen.findByTestId('admin-view');
    const scroller = screen.getByTestId('admin-scroller');
    const usersSection = await screen.findByTestId('admin-users-section');
    expect(view.contains(usersSection)).toBe(true);
    expect(scroller.contains(usersSection)).toBe(true);
    expect(screen.getByTestId('admin-nav').isSameNode(scroller)).toBe(false);
    expect(screen.getByText('Admin').isSameNode(scroller)).toBe(false);
  });

  it('shows only the Users section by default and switches to Models on tab click', async () => {
    render(<AdminView />);
    await screen.findByTestId('admin-users-section');
    expect(screen.queryByTestId('admin-models-section')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-tab-models'));
    expect(await screen.findByTestId('admin-models-section')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-users-section')).not.toBeInTheDocument();
  });

  it('marks the active tab with aria-current', async () => {
    render(<AdminView />);
    await screen.findByTestId('admin-users-section');
    expect(screen.getByTestId('admin-tab-users')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('admin-tab-models')).not.toHaveAttribute('aria-current');
    fireEvent.click(screen.getByTestId('admin-tab-models'));
    expect(screen.getByTestId('admin-tab-models')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('admin-tab-users')).not.toHaveAttribute('aria-current');
  });
});
