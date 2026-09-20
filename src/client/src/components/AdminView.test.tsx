import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import AdminView from './AdminView';
import { AdminError } from '../services/admin';
import type { AdminLogEntry, AdminUser } from '../types/admin';

const listUsers = vi.fn();
const updatePermissions = vi.fn();
const updateRole = vi.fn();
const listModels = vi.fn();
const createModel = vi.fn();
const updateModel = vi.fn();
const deleteModel = vi.fn();
const listLogs = vi.fn();
const compareModels = vi.fn();

vi.mock('../services/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/admin')>();
  return {
    ...actual,
    default: {
      listUsers: (...args: unknown[]) => listUsers(...args),
      updatePermissions: (...args: unknown[]) => updatePermissions(...args),
      updateRole: (...args: unknown[]) => updateRole(...args),
    },
    AdminModelsService: {
      listModels: (...args: unknown[]) => listModels(...args),
      createModel: (...args: unknown[]) => createModel(...args),
      updateModel: (...args: unknown[]) => updateModel(...args),
      deleteModel: (...args: unknown[]) => deleteModel(...args),
      compareModels: (...args: unknown[]) => compareModels(...args),
    },
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

describe('AdminView models table (issue #33/#104)', () => {
  afterEach(cleanup);

  const sampleRow = () => ({
    id: 'r1',
    provider: 'groq',
    model: 'test-large',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 131072,
    stats: [{ band: 'short|prose', up: 3, down: 1 }],
  });

  beforeEach(() => {
    listUsers.mockReset().mockResolvedValue([admin()]);
    updatePermissions.mockReset().mockResolvedValue(admin());
    updateRole.mockReset().mockResolvedValue(admin());
    updateModel.mockReset().mockResolvedValue({ id: 'r1' });
    createModel.mockReset().mockResolvedValue({ id: 'r2' });
    deleteModel.mockReset().mockResolvedValue(undefined);
  });

  const setup = () => {
    listModels.mockReset().mockResolvedValueOnce([sampleRow()]);
    return render(<AdminView />);
  };

  it('renders configured models rows with tiers, context and feedback tallies', async () => {
    setup();
    await screen.findByTestId('admin-view');
    fireEvent.click(screen.getByTestId('admin-tab-models'));
    expect(await screen.findByTestId('admin-models')).toBeInTheDocument();
    expect(screen.getByTestId('admin-model-r1')).toHaveTextContent('test-large');
    expect(screen.getByTestId('admin-models')).toHaveTextContent('131,072');
    expect(screen.getByTestId('admin-models')).toHaveTextContent('short|prose: 3↑ 1↓');
    expect(screen.queryByText('Loading users...')).not.toBeInTheDocument();
  });

  it('shows an empty state when no models are configured', async () => {
    listModels.mockReset().mockResolvedValue([]);
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    expect(await screen.findByText('No models configured.')).toBeInTheDocument();
  });

  // #115: capabilities are surfaced as read-only badges per row.
  it('renders vision/tools capability badges with the context length', async () => {
    listModels.mockResolvedValue([
      {
        id: 'r1',
        provider: 'groq',
        model: 'test-large',
        tier: 'large',
        eligible: true,
        tools: true,
        vision: false,
        contextLength: 131072,
        stats: [],
      },
      {
        id: 'r2',
        provider: 'deepinfra',
        model: 'Qwen/Qwen3-VL-8B-Instruct',
        tier: 'small',
        eligible: true,
        tools: true,
        vision: true,
        contextLength: 262144,
        stats: [],
      },
    ]);
    render(<AdminView />);
    expect(await screen.findByTestId('admin-view')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-tab-models'));
    const plain = await screen.findByTestId('admin-model-caps-r1');
    expect(plain.querySelector('[data-testid="admin-model-vision-r1"]')).toHaveTextContent(
      'vision ✗',
    );
    expect(plain).toHaveTextContent('tools ✓');
    expect(plain).toHaveTextContent('131,072 tok');
    const vl = screen.getByTestId('admin-model-caps-r2');
    expect(vl.querySelector('[data-testid="admin-model-vision-r2"]')).toHaveTextContent('vision ✓');
  });

  it('disables a model via the eligibility checkbox and refetches', async () => {
    setup();
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    const checkbox = await screen.findByTestId('model-eligible-r1');
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    await waitFor(() => expect(updateModel).toHaveBeenCalledWith('r1', { eligible: false }));
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
  });

  it('deletes a model and refetches', async () => {
    setup();
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    fireEvent.click(await screen.findByTestId('model-delete-r1'));
    await waitFor(() => expect(deleteModel).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
  });

  it('edits an existing model through the inline form', async () => {
    setup();
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    fireEvent.click(await screen.findByTestId('model-edit-r1'));
    fireEvent.change(screen.getByTestId('model-form-model'), {
      target: { value: 'renamed-model' },
    });
    fireEvent.click(screen.getByTestId('model-form-submit'));
    await waitFor(() =>
      expect(updateModel).toHaveBeenCalledWith(
        'r1',
        expect.objectContaining({ model: 'renamed-model', tier: 'large' }),
      ),
    );
    expect(createModel).not.toHaveBeenCalled();
  });

  it('adds a new model through the inline form', async () => {
    setup();
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    fireEvent.change(screen.getByTestId('model-form-model'), {
      target: { value: 'org/new-model' },
    });
    fireEvent.change(screen.getByTestId('model-form-tier'), { target: { value: 'guard' } });
    fireEvent.change(screen.getByTestId('model-form-context'), { target: { value: '131072' } });
    fireEvent.click(screen.getByTestId('model-form-submit'));
    await waitFor(() =>
      expect(createModel).toHaveBeenCalledWith({
        provider: 'deepinfra',
        model: 'org/new-model',
        tier: 'guard',
        contextLength: 131072,
        tools: true,
        vision: false,
      }),
    );
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
    expect(updateModel).not.toHaveBeenCalled();
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

  it('does not mount the logs section or poll logs while it is not active', async () => {
    vi.useFakeTimers();
    render(<AdminView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000); // two poll intervals
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
    const pollCalls = listLogs.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6500); // two poll intervals while active
    });
    expect(listLogs.mock.calls.length).toBeGreaterThan(pollCalls);
    vi.useRealTimers();
  });

  it('renders log entries returned by the logs API', async () => {
    listLogs.mockResolvedValue({ logs: [log()], nextCursor: 1 });
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-logs'));
    expect(await screen.findByTestId('admin-logs')).toBeInTheDocument();
    expect(screen.getByTestId('admin-logs')).toHaveTextContent('GET /api/chat -> 404 (12ms)');
    expect(listLogs).toHaveBeenCalledWith({ level: undefined, q: '', cursor: 0 });
  });

  it('shows an empty state when the buffer has no matching entries', async () => {
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-logs'));
    expect(await screen.findByText('No log entries.')).toBeInTheDocument();
  });

  it('re-fetches with the selected level filter and resets the cursor', async () => {
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-logs'));
    await screen.findByTestId('admin-logs');
    listLogs.mockClear();
    fireEvent.click(screen.getByTestId('log-level-error'));
    await waitFor(() =>
      expect(listLogs).toHaveBeenCalledWith({ level: 'error', q: '', cursor: 0 }),
    );
  });

  it('re-fetches with the text filter', async () => {
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-logs'));
    await screen.findByTestId('admin-logs');
    listLogs.mockClear();
    fireEvent.change(screen.getByTestId('log-search'), { target: { value: '/api/chat' } });
    await waitFor(() =>
      expect(listLogs).toHaveBeenCalledWith({ level: undefined, q: '/api/chat', cursor: 0 }),
    );
  });
});

describe('AdminView model comparison (issue #129)', () => {
  afterEach(cleanup);

  const sampleRow = (overrides = {}) => ({
    id: 'r1',
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-14B',
    tier: 'small',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 131072,
    stats: [],
    ...overrides,
  });

  beforeEach(() => {
    listUsers.mockReset().mockResolvedValue([admin()]);
    updatePermissions.mockReset();
    updateRole.mockReset();
    updateModel.mockReset();
    createModel.mockReset();
    deleteModel.mockReset();
    compareModels.mockReset();
  });

  const setup = (rows = [sampleRow()]) => {
    listModels.mockResolvedValue(rows);
    render(<AdminView />);
    return screen.findByTestId('admin-view');
  };

  const switchToCompare = async () => {
    await setup();
    fireEvent.click(screen.getByTestId('admin-tab-compare'));
    await screen.findByTestId('compare-run');
  };

  it('lists eligible non-guard models with checkboxes', async () => {
    await switchToCompare();
    expect(screen.getByTestId('compare-model-Qwen/Qwen3-14B')).not.toBeChecked();
  });

  it('disables the run button until a prompt and at least one model are set', async () => {
    await switchToCompare();
    expect(screen.getByTestId('compare-run')).toBeDisabled();
    fireEvent.click(screen.getByTestId('compare-model-Qwen/Qwen3-14B'));
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
          provider: 'groq',
          model: 'openai/gpt-oss-20b',
          answer: null,
          latencyMs: 300,
          error: 'boom',
        },
      ],
    });
    await setup([
      sampleRow(),
      sampleRow({ id: 'r2', provider: 'groq', model: 'openai/gpt-oss-20b', tier: 'large' }),
    ]);
    fireEvent.click(screen.getByTestId('admin-tab-compare'));
    fireEvent.click(screen.getByTestId('compare-model-Qwen/Qwen3-14B'));
    fireEvent.click(screen.getByTestId('compare-model-openai/gpt-oss-20b'));
    fireEvent.change(screen.getByTestId('compare-prompt'), { target: { value: 'Hello there' } });
    fireEvent.click(screen.getByTestId('compare-run'));
    await screen.findByTestId('compare-results');
    expect(compareModels).toHaveBeenCalledWith('Hello there', [
      { provider: 'deepinfra', model: 'Qwen/Qwen3-14B', contextLength: 131072 },
      { provider: 'groq', model: 'openai/gpt-oss-20b', contextLength: 131072 },
    ]);
    expect(screen.getByTestId('compare-answer-Qwen/Qwen3-14B')).toBeInTheDocument();
    expect(screen.getByText('conversational answer')).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  it('shows the API error message when the comparison run fails', async () => {
    compareModels.mockRejectedValue(new AdminError('Models unavailable.'));
    await switchToCompare();
    fireEvent.click(screen.getByTestId('compare-model-Qwen/Qwen3-14B'));
    fireEvent.change(screen.getByTestId('compare-prompt'), { target: { value: 'Hello there' } });
    fireEvent.click(screen.getByTestId('compare-run'));
    expect(await screen.findByTestId('compare-error')).toHaveTextContent('Models unavailable.');
  });
});
