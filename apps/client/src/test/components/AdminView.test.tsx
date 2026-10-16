import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import AdminView from '../../main/components/AdminView';
import { AdminError } from '../../main/services/admin';
import type { AdminLogEntry, AdminUser } from '../../main/types/admin';

const listUsers = vi.fn();
const updatePermissions = vi.fn();
const updateRole = vi.fn();
const listModels = vi.fn();
const createModel = vi.fn();
const updateModel = vi.fn();
const deleteModel = vi.fn();
const lookupModel = vi.fn();
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
      createModel: (...args: unknown[]) => createModel(...args),
      updateModel: (...args: unknown[]) => updateModel(...args),
      deleteModel: (...args: unknown[]) => deleteModel(...args),
      compareModels: (...args: unknown[]) => compareModels(...args),
      lookupModel: (...args: unknown[]) => lookupModel(...args),
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

// #168: GET /api/admin/models returns { models, errors } — every mock uses
// this helper so the payload shape stays consistent with the contract.
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

describe('AdminView models table (issue #33/#104)', () => {
  afterEach(cleanup);

  const sampleRow = () => ({
    id: 'r1',
    modelId: 'test-large',
    label: 'Test Large',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 131072,
    providers: [
      {
        provider: 'deepinfra',
        modelId: 'test-large',
        enabled: true,
        ttftMs: 420,
        ttftSamples: 12,
        disabledUntil: null,
      },
      {
        provider: 'fireworks',
        modelId: 'accounts/fireworks/models/test-large',
        enabled: true,
        disabledUntil: null,
      },
    ],
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
    listModels.mockReset().mockResolvedValueOnce(modelsPayload([sampleRow()]));
    return render(<AdminView />);
  };

  it('renders one roster row per model with its providers and live TTFT', async () => {
    setup();
    await screen.findByTestId('admin-view');
    fireEvent.click(screen.getByTestId('admin-tab-models'));
    expect(await screen.findByTestId('admin-models')).toBeInTheDocument();
    expect(screen.getByTestId('admin-model-r1')).toHaveTextContent('Test Large');
    expect(screen.getByTestId('admin-models')).toHaveTextContent('131,072');
    const providers = screen.getByTestId('admin-model-providers-r1');
    expect(providers).toHaveTextContent('deepinfra');
    expect(providers).toHaveTextContent('fireworks');
    expect(screen.getByTestId('provider-ttft-r1-deepinfra')).toHaveTextContent('TTFT 420 ms (12)');
    // A provider with no observation reads as unknown, not 0.
    expect(screen.getByTestId('provider-ttft-r1-fireworks')).toHaveTextContent('TTFT —');
    expect(screen.queryByText('Loading users...')).not.toBeInTheDocument();
  });

  // #234 OQ5: providers are edited independently.
  it('disables a single provider and preserves the other via the API', async () => {
    setup();
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    fireEvent.click(await screen.findByTestId('provider-enabled-r1-deepinfra'));
    await waitFor(() =>
      expect(updateModel).toHaveBeenCalledWith('r1', {
        providers: [
          { provider: 'deepinfra', modelId: 'test-large', enabled: false },
          {
            provider: 'fireworks',
            modelId: 'accounts/fireworks/models/test-large',
            enabled: true,
          },
        ],
      }),
    );
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
  });

  it('shows an empty state when no models are configured', async () => {
    listModels.mockReset().mockResolvedValue(modelsPayload());
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    expect(await screen.findByText('No models configured.')).toBeInTheDocument();
  });

  // #115: capabilities are surfaced as read-only badges per row.
  it('renders vision/tools capability badges with the context length', async () => {
    listModels.mockResolvedValue(
      modelsPayload([
        sampleRow(),
        {
          id: 'r2',
          modelId: 'Qwen/Qwen3-VL-8B-Instruct',
          label: 'Qwen3 VL 8B',
          eligible: true,
          tools: true,
          vision: true,
          contextLength: 262144,
          providers: [
            {
              provider: 'deepinfra',
              modelId: 'Qwen/Qwen3-VL-8B-Instruct',
              enabled: true,
              disabledUntil: null,
            },
          ],
        },
      ]),
    );
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

  // #217/#234: the manual form is gone. Add = search BOTH provider catalogs,
  // review the summary and post a roster model with the resolved providers.
  it('searches both provider catalogs and adds a model with the resolved providers', async () => {
    setup();
    lookupModel.mockImplementation((provider: string) =>
      Promise.resolve(
        provider === 'deepinfra'
          ? {
              found: true,
              provider: 'deepinfra',
              model: 'XiaomiMiMo/MiMo-V2.6-Flash',
              contextLength: 1048576,
              inputPrice: 0.14,
              outputPrice: 0.28,
              vision: true,
            }
          : {
              found: true,
              provider: 'fireworks',
              model: 'accounts/fireworks/models/mimo-v2p6-flash',
              contextLength: 1048576,
              vision: true,
            },
      ),
    );
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    fireEvent.change(screen.getByTestId('model-form-model'), {
      target: { value: 'XiaomiMiMo/MiMo-V2.6-Flash' },
    });
    fireEvent.click(screen.getByTestId('model-form-search'));
    await waitFor(() =>
      expect(lookupModel).toHaveBeenCalledWith('deepinfra', 'XiaomiMiMo/MiMo-V2.6-Flash'),
    );
    expect(lookupModel).toHaveBeenCalledWith('fireworks', 'XiaomiMiMo/MiMo-V2.6-Flash');

    const summary = await screen.findByTestId('model-form-result');
    expect(summary).toHaveTextContent('XiaomiMiMo/MiMo-V2.6-Flash');
    expect(screen.getByTestId('model-form-result-context')).toHaveTextContent('1,048,576');
    expect(screen.getByTestId('model-form-result-input-price')).toHaveTextContent('$0.140');
    expect(screen.getByTestId('model-form-result-output-price')).toHaveTextContent('$0.280');
    expect(screen.getByTestId('model-form-result-caps')).toHaveTextContent('vision');
    expect(screen.getByTestId('model-form-result-providers')).toHaveTextContent(
      'deepinfra, fireworks',
    );

    fireEvent.click(screen.getByTestId('model-form-submit'));
    await waitFor(() =>
      expect(createModel).toHaveBeenCalledWith({
        modelId: 'XiaomiMiMo/MiMo-V2.6-Flash',
        label: 'XiaomiMiMo/MiMo-V2.6-Flash',
        providers: [
          { provider: 'deepinfra', modelId: 'XiaomiMiMo/MiMo-V2.6-Flash' },
          {
            provider: 'fireworks',
            modelId: 'accounts/fireworks/models/mimo-v2p6-flash',
          },
        ],
        contextLength: 1048576,
        inputPrice: 0.14,
        outputPrice: 0.28,
        vision: true,
      }),
    );
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
  });

  it('adds a model resolved on only one provider', async () => {
    setup();
    lookupModel.mockImplementation((provider: string) =>
      Promise.resolve(
        provider === 'deepinfra'
          ? {
              found: true,
              provider: 'deepinfra',
              model: 'XiaomiMiMo/MiMo-V2.6-Flash',
              contextLength: 1048576,
              inputPrice: 0.14,
              outputPrice: 0.28,
            }
          : { found: false },
      ),
    );
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    fireEvent.change(screen.getByTestId('model-form-model'), {
      target: { value: 'XiaomiMiMo/MiMo-V2.6-Flash' },
    });
    fireEvent.click(screen.getByTestId('model-form-search'));
    fireEvent.click(await screen.findByTestId('model-form-submit'));
    await waitFor(() =>
      expect(createModel).toHaveBeenCalledWith({
        modelId: 'XiaomiMiMo/MiMo-V2.6-Flash',
        label: 'XiaomiMiMo/MiMo-V2.6-Flash',
        providers: [{ provider: 'deepinfra', modelId: 'XiaomiMiMo/MiMo-V2.6-Flash' }],
        contextLength: 1048576,
        inputPrice: 0.14,
        outputPrice: 0.28,
      }),
    );
  });

  it('shows "Model not found" and does not offer Add on a miss', async () => {
    setup();
    lookupModel.mockResolvedValue({ found: false });
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    fireEvent.change(screen.getByTestId('model-form-model'), { target: { value: 'org/absent' } });
    fireEvent.click(screen.getByTestId('model-form-search'));
    expect(await screen.findByTestId('model-form-not-found')).toHaveTextContent('Model not found');
    expect(screen.queryByTestId('model-form-submit')).not.toBeInTheDocument();
    expect(createModel).not.toHaveBeenCalled();
  });

  it('shows a lookup error inline when both provider calls fail', async () => {
    setup();
    lookupModel.mockRejectedValue(new AdminError('Failed to look up model.'));
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    fireEvent.change(screen.getByTestId('model-form-model'), { target: { value: 'org/x' } });
    fireEvent.click(screen.getByTestId('model-form-search'));
    expect(await screen.findByTestId('model-form-error')).toHaveTextContent(
      'Failed to look up model.',
    );
    expect(screen.queryByTestId('model-form-not-found')).not.toBeInTheDocument();
    expect(screen.queryByTestId('model-form-submit')).not.toBeInTheDocument();
  });

  // #217: Refresh replaces the old Edit button — re-pull provider-owned values
  // and update the row in place (tier/provider/model/eligible untouched).
  it('refreshes a row from the provider catalog', async () => {
    setup();
    lookupModel.mockResolvedValue({
      found: true,
      provider: 'deepinfra',
      model: 'test-large',
      contextLength: 262144,
      inputPrice: 0.2,
      outputPrice: 0.6,
      vision: true,
    });
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    fireEvent.click(screen.getByTestId('model-refresh-r1'));
    await waitFor(() => expect(lookupModel).toHaveBeenCalledWith('deepinfra', 'test-large'));
    await waitFor(() =>
      expect(updateModel).toHaveBeenCalledWith('r1', {
        contextLength: 262144,
        inputPrice: 0.2,
        outputPrice: 0.6,
        vision: true,
      }),
    );
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
  });

  it('does not clobber a row when Refresh finds no catalog entry', async () => {
    setup();
    lookupModel.mockResolvedValue({ found: false });
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    fireEvent.click(screen.getByTestId('model-refresh-r1'));
    expect(await screen.findByTestId('admin-error')).toHaveTextContent(
      /not found in the \w+ catalog/,
    );
    expect(updateModel).not.toHaveBeenCalled();
  });

  // #234 OQ4: price is a soft score input now — no hard cap/over-cap badge.
  it('renders the in/out price pair and a dash when unpriced, with no over-cap badge', async () => {
    listModels.mockResolvedValue(
      modelsPayload([
        {
          ...sampleRow(),
          id: 'cheap',
          modelId: 'cheap-model',
          label: 'Cheap',
          inputPrice: 0.2,
          outputPrice: 0.6,
        },
        {
          ...sampleRow(),
          id: 'pricey',
          modelId: 'pricey-model',
          label: 'Pricey',
          inputPrice: 2.85,
          outputPrice: 14.25,
        },
        { ...sampleRow(), id: 'unpriced', modelId: 'unpriced-model', label: 'Unpriced' },
      ]),
    );
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    expect(await screen.findByTestId('admin-model-price-cheap')).toHaveTextContent(
      '$0.200 / $0.600',
    );
    expect(screen.getByTestId('admin-model-price-pricey')).toHaveTextContent('$2.850 / $14.250');
    // Unpriced rows show a dash, not $0.000.
    expect(screen.getByTestId('admin-model-price-unpriced')).toHaveTextContent('—');
    expect(screen.queryByTestId('admin-model-overcap-cheap')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-model-overcap-pricey')).not.toBeInTheDocument();
  });
});

/*
 * #168: cool-off badge on the inventory rows and the per-model error
 * diagnostics table (errors tallied per provider route by #175).
 */
describe('AdminView cool-off badge and error diagnostics (#168)', () => {
  afterEach(cleanup);

  const coolingRow = (disabledUntil: string | null, overrides: Record<string, unknown> = {}) => ({
    id: 'r1',
    modelId: 'test-cooling',
    label: 'Test Cooling',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 131072,
    providers: [{ provider: 'deepinfra', modelId: 'test-cooling', enabled: true, disabledUntil }],
    ...overrides,
  });

  beforeEach(() => {
    listUsers.mockReset().mockResolvedValue([admin()]);
    updatePermissions.mockReset();
    updateRole.mockReset();
    updateModel.mockReset().mockResolvedValue({ id: 'r1' });
    createModel.mockReset().mockResolvedValue({ id: 'r2' });
    deleteModel.mockReset().mockResolvedValue(undefined);
  });

  it('shows a cooling-off badge with approximate hours left for a future disabledUntil', async () => {
    listModels.mockResolvedValue(
      modelsPayload([coolingRow(new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString())]),
    );
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    const badge = await screen.findByTestId('admin-model-cooloff-r1-deepinfra');
    expect(badge).toHaveTextContent(/Cooling off · ~\d+h left/);
  });

  it('renders no badge when the provider is not cooling off (null or expired)', async () => {
    listModels.mockResolvedValue(
      modelsPayload([
        coolingRow(null),
        coolingRow(new Date(Date.now() - 60_000).toISOString(), {
          id: 'r2',
          modelId: 'test-expired',
          label: 'Test Expired',
          providers: [
            {
              provider: 'deepinfra',
              modelId: 'test-expired',
              enabled: true,
              disabledUntil: new Date(Date.now() - 60_000).toISOString(),
            },
          ],
        }),
      ]),
    );
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    await screen.findByTestId('admin-model-r1');
    expect(screen.queryByTestId('admin-model-cooloff-r1-deepinfra')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-model-cooloff-r2-deepinfra')).not.toBeInTheDocument();
  });

  it('renders the per-model error diagnostics table with statuses, categories and counts', async () => {
    listModels.mockResolvedValue(
      modelsPayload(
        [coolingRow(null)],
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
    // #219: the long error message is collapsed by default and only revealed
    // in its own row when the toggle is clicked.
    expect(table).not.toHaveTextContent('connection reset');
    fireEvent.click(
      await screen.findByTestId('admin-model-error-toggle-deepinfra-other-model-none'),
    );
    expect(table).toHaveTextContent('connection reset');
  });

  it('hides the errors table when no diagnostics are recorded', async () => {
    listModels.mockResolvedValue(modelsPayload([coolingRow(null)], []));
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    await screen.findByTestId('admin-models');
    expect(screen.queryByTestId('admin-model-errors')).not.toBeInTheDocument();
  });

  it('highlights error rows whose endpoint is currently cooling off', async () => {
    listModels.mockResolvedValue(
      modelsPayload(
        [coolingRow(new Date(Date.now() + 60 * 60 * 1000).toISOString())],
        [
          {
            provider: 'deepinfra',
            model: 'test-cooling',
            status: 502,
            category: 'server_error',
            count: 2,
            lastMessage: 'Error: bad gateway',
            lastSeenAt: '2026-09-26T08:00:00.000Z',
          },
        ],
      ),
    );
    render(<AdminView />);
    fireEvent.click(await screen.findByTestId('admin-tab-models'));
    const row = await screen.findByTestId('admin-model-error-deepinfra-test-cooling-502');
    expect(row.querySelector('td')!.className).toContain('text-warning');
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

  const sampleRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'r1',
    modelId: 'Qwen/Qwen3-14B',
    label: 'Qwen3 14B',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 131072,
    providers: [
      { provider: 'deepinfra', modelId: 'Qwen/Qwen3-14B', enabled: true, disabledUntil: null },
    ],
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
    listModels.mockResolvedValue(modelsPayload(rows));
    render(<AdminView />);
    return screen.findByTestId('admin-view');
  };

  const switchToCompare = async () => {
    await setup();
    fireEvent.click(screen.getByTestId('admin-tab-compare'));
    await screen.findByTestId('compare-run');
  };

  it('lists roster provider entries with checkboxes', async () => {
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
      sampleRow({
        providers: [
          { provider: 'deepinfra', modelId: 'Qwen/Qwen3-14B', enabled: true, disabledUntil: null },
          {
            provider: 'fireworks',
            modelId: 'accounts/fireworks/models/qwen3-14b',
            enabled: true,
            disabledUntil: null,
          },
        ],
      }),
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
