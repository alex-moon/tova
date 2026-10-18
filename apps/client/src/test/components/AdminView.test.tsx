import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import AdminView from '../../main/components/AdminView';
import { AdminError } from '../../main/services/admin';
import type { AdminLogEntry, AdminUser } from '../../main/types/admin';

const listUsers = vi.fn();
const updatePermissions = vi.fn();
const updateRole = vi.fn();
const listModels = vi.fn();
const listLogs = vi.fn();
const compareModels = vi.fn();
const listPats = vi.fn();
const createPat = vi.fn();
const revokePat = vi.fn();

vi.mock('../../main/services/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/services/admin')>();
  return {
    ...actual,
    default: {
      listUsers: (...args: unknown[]) => listUsers(...args),
      updatePermissions: (...args: unknown[]) => updatePermissions(...args),
      updateRole: (...args: unknown[]) => updateRole(...args),
    },
    AdminModelsService: {
      listModels: (...args: unknown[]) => listModels(...args),
      compareModels: (...args: unknown[]) => compareModels(...args),
    },
    AdminLogsService: { listLogs: (...args: unknown[]) => listLogs(...args) },
    AdminPatsService: {
      listPats: (...args: unknown[]) => listPats(...args),
      createPat: (...args: unknown[]) => createPat(...args),
      revokePat: (...args: unknown[]) => revokePat(...args),
    },
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

// Shared mock helper keeping every mock on the { models, errors } contract.
// @see #168
const modelsPayload = (models: Record<string, unknown>[] = [], errors: unknown[] = []) => ({
  models,
  errors,
});

describe('AdminView', () => {
  afterEach(cleanup);

  beforeEach(() => {
    listUsers.mockReset().mockResolvedValue([admin()]);
    listModels.mockReset().mockResolvedValue(modelsPayload());
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

describe('AdminView models table (#387)', () => {
  afterEach(cleanup);

  const fixedRow = (overrides: Record<string, unknown> = {}) => ({
    model: 'zai-org/GLM-5.3-Flash',
    provider: 'deepinfra',
    contextLength: 1048576,
    ...overrides,
  });

  beforeEach(() => {
    listUsers.mockReset().mockResolvedValue([admin()]);
    updatePermissions.mockReset().mockResolvedValue(admin());
    updateRole.mockReset().mockResolvedValue(admin());
  });

  const setup = () => {
    listModels.mockReset().mockResolvedValueOnce(modelsPayload([fixedRow()]));
    return render(<AdminView />);
  };

  it('renders one read-only row per fixed serving model', async () => {
    setup();
    await screen.findByTestId('admin-view');
    fireEvent.click(screen.getByTestId('admin-tab-models'));
    expect(await screen.findByTestId('admin-models')).toBeInTheDocument();
    expect(screen.getByTestId('admin-model-zai-org/GLM-5.3-Flash')).toHaveTextContent(
      'zai-org/GLM-5.3-Flash',
    );
    expect(screen.getByTestId('admin-models')).toHaveTextContent('deepinfra');
    expect(screen.getByTestId('admin-models')).toHaveTextContent('1,048,576');
    expect(screen.queryByText('Loading users...')).not.toBeInTheDocument();
  });

  it('shows an empty state when no models are configured', async () => {
    listModels.mockReset().mockResolvedValue(modelsPayload());
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    expect(await screen.findByText('No models configured.')).toBeInTheDocument();
  });

  it('exposes no routing controls — the table is read-only', async () => {
    setup();
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    await screen.findByTestId('admin-models');
    expect(screen.queryByTestId('model-form-model')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('names CHAT_MODEL / TASK_MODEL env as the routing surface', async () => {
    setup();
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    expect(await screen.findByTestId('admin-models-section')).toHaveTextContent('CHAT_MODEL');
    expect(screen.getByTestId('admin-models-section')).toHaveTextContent('TASK_MODEL');
  });
});

// Per-model error diagnostics remain on the read-only models tab.
// @see #168 #387
describe('AdminView error diagnostics (#168)', () => {
  afterEach(cleanup);

  const fixedRow = (overrides: Record<string, unknown> = {}) => ({
    model: 'test-model',
    provider: 'deepinfra',
    contextLength: 131072,
    ...overrides,
  });

  beforeEach(() => {
    listUsers.mockReset().mockResolvedValue([admin()]);
    updatePermissions.mockReset();
    updateRole.mockReset();
  });

  it('renders the per-model error diagnostics table with statuses, categories and counts', async () => {
    listModels.mockResolvedValue(
      modelsPayload(
        [fixedRow()],
        [
          {
            provider: 'deepinfra',
            model: 'Qwen/Qwen3-14B',
            status: 429,
            category: 'rate_limit',
            count: 7,
            lastMessage: 'Error: rate limit exceeded',
            lastSeenAt: '2026-09-26T08:00:00.000Z',
          },
          {
            provider: 'deepinfra',
            model: 'other-model',
            status: null,
            category: 'network',
            count: 1,
            lastMessage: 'Error: connection reset',
            lastSeenAt: '2026-09-26T07:00:00.000Z',
          },
        ],
      ),
    );
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    const table = await screen.findByTestId('admin-model-errors');
    expect(table).toHaveTextContent('deepinfra/Qwen/Qwen3-14B');
    expect(table).toHaveTextContent('429 · rate_limit');
    expect(table).toHaveTextContent('network');
    expect(table).toHaveTextContent('7');
    // The long error is collapsed by default, revealed in its row on toggle.
    // @see #219
    expect(table).not.toHaveTextContent('connection reset');
    fireEvent.click(
      await screen.findByTestId('admin-model-error-toggle-deepinfra-other-model-none'),
    );
    expect(table).toHaveTextContent('connection reset');
  });

  it('hides the errors table when no diagnostics are recorded', async () => {
    listModels.mockResolvedValue(modelsPayload([fixedRow()], []));
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    await screen.findByTestId('admin-models');
    expect(screen.queryByTestId('admin-model-errors')).not.toBeInTheDocument();
  });
});

describe('AdminView layout (issue #91)', () => {
  afterEach(cleanup);

  beforeEach(() => {
    listUsers.mockReset().mockResolvedValue([admin()]);
    listModels.mockReset().mockResolvedValue(modelsPayload());
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

  it('scrolls in the body element only, and turns horizontal scroll over to the table cards', async () => {
    render(<AdminView />);
    const view = await screen.findByTestId('admin-view');
    expect(view.className).not.toContain('overflow-y-auto');
    const scroller = screen.getByTestId('admin-scroller');
    expect(scroller.className).toContain('overflow-y-auto');
    expect(scroller.className).toContain('min-h-0');
    const card = scroller.querySelector('.overflow-x-auto');
    expect(card).not.toBeNull();
    expect(card!.className).not.toContain('min-w-fit');
    expect(scroller.contains(card as Element)).toBe(true);
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

describe('AdminView logs section (#179)', () => {
  afterEach(cleanup);

  beforeEach(() => {
    listUsers.mockReset().mockResolvedValue([admin()]);
    listModels.mockReset().mockResolvedValue(modelsPayload());
    updatePermissions.mockReset().mockResolvedValue(admin());
    updateRole.mockReset().mockResolvedValue(admin());
    listLogs.mockReset().mockResolvedValue({ logs: [], configured: true });
  });

  const log = (): AdminLogEntry => ({
    id: '1759449600000000000',
    ts: '2026-09-18T12:00:00.000Z',
    level: 'warn',
    msg: 'GET /api/chat -> 404 (12ms)',
  });

  it('does not mount the logs section or fetch logs while it is not active', async () => {
    vi.useFakeTimers();
    render(<AdminView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70000); // more than one refresh interval
      await vi.runAllTimersAsync();
    });
    expect(screen.queryByTestId('admin-logs-section')).not.toBeInTheDocument();
    expect(listLogs).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('admin-tab-logs'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('admin-logs-section')).toBeInTheDocument();
    expect(listLogs).toHaveBeenCalledTimes(1);
    const refreshCalls = listLogs.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(65000); // two refresh intervals while active
    });
    expect(listLogs.mock.calls.length).toBeGreaterThan(refreshCalls);
    vi.useRealTimers();
  });

  it('renders log entries returned by the logs API', async () => {
    listLogs.mockResolvedValue({ logs: [log()], configured: true });
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-logs'));
    expect(await screen.findByTestId('admin-logs')).toBeInTheDocument();
    expect(screen.getByTestId('admin-logs')).toHaveTextContent('GET /api/chat -> 404 (12ms)');
    expect(listLogs).toHaveBeenCalledWith({ level: undefined, q: '' });
  });

  it('shows an empty state when the window has no matching entries', async () => {
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-logs'));
    expect(await screen.findByText('No log entries.')).toBeInTheDocument();
  });

  it('shows a not-configured state when Loki env is absent', async () => {
    listLogs.mockResolvedValue({ logs: [], configured: false });
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-logs'));
    expect(
      await screen.findByText('Retained logs are not configured (Loki env absent).'),
    ).toBeInTheDocument();
  });

  it('surfaces a Loki query error instead of an empty state', async () => {
    listLogs.mockResolvedValue({ logs: [], configured: true, error: 'Loki unreachable' });
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-logs'));
    expect(await screen.findByText('Loki unreachable')).toBeInTheDocument();
    expect(screen.queryByText('No log entries.')).not.toBeInTheDocument();
  });

  it('re-fetches with the selected level filter', async () => {
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-logs'));
    await screen.findByTestId('admin-logs');
    listLogs.mockClear();
    fireEvent.click(screen.getByTestId('log-level-error'));
    await waitFor(() => expect(listLogs).toHaveBeenCalledWith({ level: 'error', q: '' }));
  });

  it('re-fetches with the text filter', async () => {
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-logs'));
    await screen.findByTestId('admin-logs');
    listLogs.mockClear();
    fireEvent.change(screen.getByTestId('log-search'), { target: { value: '/api/chat' } });
    await waitFor(() =>
      expect(listLogs).toHaveBeenCalledWith({ level: undefined, q: '/api/chat' }),
    );
  });
});

describe('AdminView model comparison (issue #129)', () => {
  afterEach(cleanup);

  const fixedRow = (overrides: Record<string, unknown> = {}) => ({
    model: 'Qwen/Qwen3-14B',
    provider: 'deepinfra',
    contextLength: 131072,
    ...overrides,
  });

  beforeEach(() => {
    listUsers.mockReset().mockResolvedValue([admin()]);
    updatePermissions.mockReset();
    updateRole.mockReset();
    compareModels.mockReset();
  });

  const setup = (rows = [fixedRow()]) => {
    listModels.mockResolvedValue(modelsPayload(rows));
    render(<AdminView />);
    return screen.findByTestId('admin-view');
  };

  const switchToCompare = async () => {
    await setup();
    fireEvent.click(screen.getByTestId('admin-tab-compare'));
    await screen.findByTestId('compare-run');
  };

  it('lists the fixed serving models with checkboxes', async () => {
    await switchToCompare();
    expect(screen.getByTestId('compare-model-deepinfra-Qwen/Qwen3-14B')).not.toBeChecked();
  });

  it('disables the run button until a prompt and at least one model are set', async () => {
    await switchToCompare();
    expect(screen.getByTestId('compare-run')).toBeDisabled();
    fireEvent.click(screen.getByTestId('compare-model-deepinfra-Qwen/Qwen3-14B'));
    expect(screen.getByTestId('compare-run')).toBeDisabled();
    fireEvent.change(screen.getByTestId('compare-prompt'), { target: { value: 'Hello there' } });
    expect(screen.getByTestId('compare-run')).toBeEnabled();
  });

  it('runs the selection through the admin API and renders answers side by side', async () => {
    compareModels.mockResolvedValue({
      prompt: 'Hello there',
      results: [
        {
          provider: 'deepinfra',
          model: 'Qwen/Qwen3-14B',
          answer: 'conversational answer',
          latencyMs: 1200,
        },
        {
          provider: 'fireworks',
          model: 'accounts/fireworks/models/qwen3-14b',
          answer: null,
          latencyMs: 300,
          error: 'boom',
        },
      ],
    });
    await setup([
      fixedRow(),
      fixedRow({ provider: 'fireworks', model: 'accounts/fireworks/models/qwen3-14b' }),
    ]);
    fireEvent.click(screen.getByTestId('admin-tab-compare'));
    fireEvent.click(screen.getByTestId('compare-model-deepinfra-Qwen/Qwen3-14B'));
    fireEvent.click(
      screen.getByTestId('compare-model-fireworks-accounts/fireworks/models/qwen3-14b'),
    );
    fireEvent.change(screen.getByTestId('compare-prompt'), { target: { value: 'Hello there' } });
    fireEvent.click(screen.getByTestId('compare-run'));
    await screen.findByTestId('compare-results');
    expect(compareModels).toHaveBeenCalledWith('Hello there', [
      { provider: 'deepinfra', model: 'Qwen/Qwen3-14B', contextLength: 131072 },
      {
        provider: 'fireworks',
        model: 'accounts/fireworks/models/qwen3-14b',
        contextLength: 131072,
      },
    ]);
    expect(screen.getByTestId('compare-answer-Qwen/Qwen3-14B')).toBeInTheDocument();
    expect(screen.getByText('conversational answer')).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  it('shows the API error message when the comparison run fails', async () => {
    compareModels.mockRejectedValue(new AdminError('Models unavailable.'));
    await switchToCompare();
    fireEvent.click(screen.getByTestId('compare-model-deepinfra-Qwen/Qwen3-14B'));
    fireEvent.change(screen.getByTestId('compare-prompt'), { target: { value: 'Hello there' } });
    fireEvent.click(screen.getByTestId('compare-run'));
    expect(await screen.findByTestId('compare-error')).toHaveTextContent('Models unavailable.');
  });
});

describe('AdminView access section (#184)', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  afterEach(cleanup);

  beforeEach(() => {
    listUsers.mockReset().mockResolvedValue([admin()]);
    listModels.mockReset().mockResolvedValue(modelsPayload());
    listPats.mockReset().mockResolvedValue({ pats: [] });
    createPat.mockReset();
    revokePat.mockReset();
    writeText.mockClear();
    Object.assign(navigator, { clipboard: { writeText } });
  });

  it('loads tokens on opening the tab and shows the empty state', async () => {
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-access'));
    await waitFor(() => expect(listPats).toHaveBeenCalled());
    expect(await screen.findByText('No tokens yet.')).toBeInTheDocument();
  });

  it('lists tokens with their metadata', async () => {
    listPats.mockResolvedValue({
      pats: [
        {
          id: 'p1',
          name: 'agent laptop',
          createdAt: '2026-09-27T10:00:00.000Z',
          lastUsedAt: null,
          expiresAt: null,
          creatorEmail: 'someone@example.com',
        },
      ],
    });
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-access'));
    expect(await screen.findByText('agent laptop')).toBeInTheDocument();
    expect(screen.getByText('someone@example.com')).toBeInTheDocument();
    // 'never' for both last-used and expiry — one row has no dates yet.
    expect(screen.getAllByText('never')).toHaveLength(2);
  });

  it('generates a token and shows the plaintext exactly once with a copy button', async () => {
    createPat.mockResolvedValue({
      id: 'p2',
      name: 'agent laptop',
      token: 'tova_pat_newtoken',
      createdAt: '2026-09-27T10:00:00.000Z',
    });
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-access'));
    const input = await screen.findByTestId('pat-name-input');
    fireEvent.change(input, { target: { value: 'agent laptop' } });
    fireEvent.click(screen.getByTestId('pat-create-button'));
    expect(await screen.findByTestId('pat-one-time-token')).toHaveTextContent('tova_pat_newtoken');
    expect(createPat).toHaveBeenCalledWith('agent laptop');
    fireEvent.click(screen.getByTestId('pat-copy-button'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('tova_pat_newtoken'));
    expect(await screen.findByText('Copied!')).toBeInTheDocument();
  });

  it('revokes a token via the API and refreshes the list', async () => {
    listPats
      .mockResolvedValueOnce({
        pats: [
          {
            id: 'p1',
            name: 'old token',
            createdAt: '2026-09-27T10:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
            creatorEmail: 'someone@example.com',
          },
        ],
      })
      .mockResolvedValueOnce({ pats: [] });
    revokePat.mockResolvedValue(undefined);
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-access'));
    fireEvent.click(await screen.findByTestId('pat-revoke-old token'));
    await waitFor(() => expect(revokePat).toHaveBeenCalledWith('p1'));
    expect(await screen.findByText('No tokens yet.')).toBeInTheDocument();
  });
});
