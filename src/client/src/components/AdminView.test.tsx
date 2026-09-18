import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import AdminView from './AdminView';
import { AdminError } from '../services/admin';
import type { AdminLogEntry, AdminUser } from '../types/admin';

const listUsers = vi.fn();
const updatePermissions = vi.fn();
const updateRole = vi.fn();
const listModels = vi.fn();
const listLogs = vi.fn();

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
    AdminLogsService: { listLogs: (...args: unknown[]) => listLogs(...args) },
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
    expect(screen.getByTestId('admin-models')).toBeInTheDocument();
    expect(screen.getByTestId('admin-model-groq/test-large')).toHaveTextContent('test-large');
    expect(screen.getByTestId('admin-models')).toHaveTextContent('large, guard');
    expect(screen.getByTestId('admin-models')).toHaveTextContent('short|prose: 3↑ 1↓');
    expect(screen.queryByText('Loading users...')).not.toBeInTheDocument();
  });

  it('shows an empty state when no models are configured', async () => {
    listModels.mockResolvedValue([]);
    render(<AdminView />);
    expect(await screen.findByText('No models configured.')).toBeInTheDocument();
  });
});

describe('AdminView logs section (issue #76)', () => {
  afterEach(cleanup);

  beforeEach(() => {
    listUsers.mockReset().mockResolvedValue([admin()]);
    listModels.mockReset().mockResolvedValue([]);
    updatePermissions.mockReset().mockResolvedValue(admin());
    updateRole.mockReset().mockResolvedValue(admin());
    listLogs.mockReset().mockResolvedValue({ logs: [], nextCursor: 0 });
  });

  const log = (): AdminLogEntry => ({
    id: 1,
    ts: '2026-09-18T12:00:00.000Z',
    level: 'warn',
    msg: 'GET /api/chat -> 404 (12ms)',
  });

  it('renders log entries returned by the logs API', async () => {
    listLogs.mockResolvedValue({ logs: [log()], nextCursor: 1 });
    render(<AdminView />);
    expect(await screen.findByTestId('admin-logs')).toBeInTheDocument();
    expect(screen.getByTestId('admin-logs')).toHaveTextContent('GET /api/chat -> 404 (12ms)');
    expect(listLogs).toHaveBeenCalledWith({ level: undefined, q: '', cursor: 0 });
  });

  it('shows an empty state when the buffer has no matching entries', async () => {
    render(<AdminView />);
    expect(await screen.findByText('No log entries.')).toBeInTheDocument();
  });

  it('re-fetches with the selected level filter and resets the cursor', async () => {
    render(<AdminView />);
    await screen.findByTestId('admin-logs');
    listLogs.mockClear();
    fireEvent.click(screen.getByTestId('log-level-error'));
    await waitFor(() =>
      expect(listLogs).toHaveBeenCalledWith({ level: 'error', q: '', cursor: 0 }),
    );
  });

  it('re-fetches with the text filter', async () => {
    render(<AdminView />);
    await screen.findByTestId('admin-logs');
    listLogs.mockClear();
    fireEvent.change(screen.getByTestId('log-search'), { target: { value: '/api/chat' } });
    await waitFor(() =>
      expect(listLogs).toHaveBeenCalledWith({ level: undefined, q: '/api/chat', cursor: 0 }),
    );
  });
});
