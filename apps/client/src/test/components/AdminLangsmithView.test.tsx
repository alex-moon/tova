import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import AdminLangsmithView from '../../main/components/AdminLangsmithView';
import { AdminError } from '../../main/services/admin';
import type {
  AdminTracesPayload,
  AdminLangsmithStatsPayload,
  AdminSessionsCostPayload,
  AdminTraceDetail,
} from '../../main/types/admin';

// The Traces tab renders trace rows and the stats strip, refetches on filters.
// @see #186

const listTraces = vi.fn();
const getTrace = vi.fn();
const listStats = vi.fn();
const listSessionCosts = vi.fn();

vi.mock('../../main/services/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/services/admin')>();
  return {
    ...actual,
    AdminLangsmithService: {
      listTraces: (...args: unknown[]) => listTraces(...args),
      getTrace: (...args: unknown[]) => getTrace(...args),
      listStats: (...args: unknown[]) => listStats(...args),
      listSessionCosts: (...args: unknown[]) => listSessionCosts(...args),
    },
  };
});

const traceRow = (overrides: Partial<AdminTracesPayload['traces'][number]> = {}) => ({
  id: 'run-1',
  traceId: 'trace-1',
  name: "agent run: 'tova-groq'",
  status: 'success',
  model: 'openai/gpt-oss-20b',
  provider: 'groq',
  startedAt: '2026-09-27T10:00:00.000Z',
  durationMs: 2000,
  totalTokens: 585,
  error: null,
  appPath: '/o/org/projects/p/proj-1/r/run-1',
  ...overrides,
});

const tracesPayload = (traces = [traceRow()]): AdminTracesPayload => ({
  project: { id: 'proj-1', name: 'tova-dev' },
  traces,
});

const statsPayload = (): AdminLangsmithStatsPayload => ({
  since: '2026-09-20T00:00:00.000Z',
  models: [
    {
      model: 'openai/gpt-oss-20b',
      provider: 'groq',
      calls: 10,
      errors: 2,
      avgDurationMs: 1500,
      avgTtftMs: 400,
      totalTokens: 4000,
      inputTokens: 3000,
      outputTokens: 1000,
      estimatedCostUsd: 0.0042,
    },
    {
      model: 'qwen/qwen3-14b',
      provider: null,
      calls: 4,
      errors: 0,
      avgDurationMs: 3000,
      avgTtftMs: null,
      totalTokens: 900,
      inputTokens: 700,
      outputTokens: 200,
      estimatedCostUsd: null,
    },
  ],
  totals: {
    calls: 14,
    errors: 2,
    totalTokens: 4900,
    inputTokens: 3700,
    outputTokens: 1200,
    estimatedCostUsd: 0.0042,
  },
  computedAt: '2026-09-27T10:00:00.000Z',
  stale: false,
});

const sessionCostsPayload = (): AdminSessionsCostPayload => ({
  since: '2026-09-20T00:00:00.000Z',
  sessions: [
    {
      sessionId: 'sess-1',
      title: 'Chat A',
      messagesIn: 3,
      messagesOut: 3,
      inputTokens: 1200,
      outputTokens: 400,
      estimatedCostUsd: 0.0032,
      lastActivityAt: '2026-09-27T10:00:00.000Z',
    },
    {
      sessionId: 'sess-2',
      title: 'Chat B',
      messagesIn: 1,
      messagesOut: 1,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: null,
      lastActivityAt: '2026-09-26T10:00:00.000Z',
    },
  ],
  totals: {
    sessions: 2,
    messagesIn: 4,
    messagesOut: 4,
    inputTokens: 1200,
    outputTokens: 400,
    estimatedCostUsd: 0.0032,
  },
});

const traceDetail = (): AdminTraceDetail => ({
  traceId: 'trace-1',
  runs: [
    {
      id: 'run-1',
      parentId: null,
      name: "agent run: 'tova-groq'",
      runType: 'chain',
      status: 'success',
      model: null,
      provider: null,
      startedAt: '2026-09-27T10:00:00.000Z',
      endedAt: '2026-09-27T10:00:02.000Z',
      durationMs: 2000,
      ttftMs: null,
      totalTokens: 0,
      error: null,
      inputs: { input: 'user turn text' },
      outputs: null,
    },
    {
      id: 'llm-1',
      parentId: 'run-1',
      name: "llm: 'openai/gpt-oss-20b'",
      runType: 'llm',
      status: 'success',
      model: 'openai/gpt-oss-20b',
      provider: 'groq',
      startedAt: '2026-09-27T10:00:00.100000Z',
      endedAt: '2026-09-27T10:00:01.000000Z',
      durationMs: 900,
      ttftMs: 300,
      totalTokens: 585,
      error: null,
      inputs: { messages: [{ role: 'user', content: 'hello' }] },
      outputs: { text: 'hi there' },
    },
  ],
});

describe('AdminLangsmithView (#186)', () => {
  afterEach(cleanup);

  beforeEach(() => {
    listTraces.mockReset().mockResolvedValue(tracesPayload());
    getTrace.mockReset().mockResolvedValue(traceDetail());
    listStats.mockReset().mockResolvedValue(statsPayload());
    listSessionCosts.mockReset().mockResolvedValue(sessionCostsPayload());
  });

  it('loads traces and stats on mount and renders both tables', async () => {
    render(<AdminLangsmithView />);
    expect(await screen.findByTestId('langsmith-traces')).toBeInTheDocument();
    expect(listTraces).toHaveBeenCalledWith({});
    expect(listStats).toHaveBeenCalledWith();

    const row = await screen.findByTestId('langsmith-trace-trace-1');
    expect(row).toHaveTextContent('success');
    expect(row).toHaveTextContent('openai/gpt-oss-20b');
    // The row names the serving provider alongside the model.
    // @see #237
    expect(row).toHaveTextContent('openai/gpt-oss-20b · groq');
    expect(row).toHaveTextContent('585');

    const stats = screen.getByTestId('langsmith-stats');
    expect(stats).toHaveTextContent('openai/gpt-oss-20b');
    expect(stats).toHaveTextContent('10');
    expect(stats).toHaveTextContent('2');
  });

  // Memory column: guard outcome (+ hits), em dash for pre-metadata traces.
  // @see #308
  it('renders the workspace memory column per trace (#308)', async () => {
    listTraces.mockResolvedValue(
      tracesPayload([
        traceRow({ traceId: 'trace-1', workspaceGate: 'yes', workspaceHits: 3 }),
        traceRow({ id: 'run-2', traceId: 'trace-2', workspaceGate: 'timeout' }),
        traceRow({ id: 'run-3', traceId: 'trace-3', workspaceGate: 'off' }),
        traceRow({ id: 'run-4', traceId: 'trace-4' }),
      ]),
    );
    render(<AdminLangsmithView />);

    expect(await screen.findByTestId('langsmith-trace-trace-1')).toHaveTextContent('yes · 3');
    const timeoutCell = within(screen.getByTestId('langsmith-trace-trace-2')).getByText('timeout');
    expect(timeoutCell).toHaveClass('text-destructive');
    expect(screen.getByTestId('langsmith-trace-trace-3')).toHaveTextContent('off');
    expect(screen.getByTestId('langsmith-trace-trace-4')).toHaveTextContent('—');
  });

  it('renders the cost-breakdown row per model, with — for unknown price (#224)', async () => {
    render(<AdminLangsmithView />);
    const stats = await screen.findByTestId('langsmith-stats');

    const priced = screen.getByTestId('langsmith-cost-openai/gpt-oss-20b-groq');
    expect(priced).toHaveTextContent('in 3,000');
    expect(priced).toHaveTextContent('out 1,000');
    expect(priced).toHaveTextContent('$0.0042');

    const unpriced = screen.getByTestId('langsmith-cost-qwen/qwen3-14b');
    expect(unpriced).toHaveTextContent('—');

    expect(stats).toHaveTextContent('updated');
    const total = screen.getByTestId('langsmith-cost-total');
    expect(total).toHaveTextContent('$0.0042');
  });

  it('shows the provider on stats rows and average TTFT (#237)', async () => {
    render(<AdminLangsmithView />);
    const stats = await screen.findByTestId('langsmith-stats');

    // A provider row renders model · provider; a legacy row renders the model.
    const row = screen.getByTestId('langsmith-model-openai/gpt-oss-20b-groq');
    expect(row).toHaveTextContent('openai/gpt-oss-20b · groq');
    expect(row).toHaveTextContent('400ms');
    expect(screen.getByTestId('langsmith-model-qwen/qwen3-14b')).toHaveTextContent(
      'qwen/qwen3-14b',
    );
    expect(stats).toHaveTextContent('Avg TTFT');
  });

  it('renders the per-session cost breakdown with — for an unpriced session (#224)', async () => {
    render(<AdminLangsmithView />);
    const section = await screen.findByTestId('langsmith-session-costs');
    expect(listSessionCosts).toHaveBeenCalledWith();

    const priced = screen.getByTestId('langsmith-session-sess-1');
    expect(priced).toHaveTextContent('Chat A');
    expect(priced).toHaveTextContent('1,200');
    expect(priced).toHaveTextContent('$0.0032');

    const unpriced = screen.getByTestId('langsmith-session-sess-2');
    expect(unpriced).toHaveTextContent('—');

    expect(section).toHaveTextContent('usage builds up');
    const total = screen.getByTestId('langsmith-session-total');
    expect(total).toHaveTextContent('2 sessions');
    expect(total).toHaveTextContent('$0.0032');
  });

  it('shows an empty state when the project has no traces', async () => {
    listTraces.mockResolvedValue(tracesPayload([]));
    render(<AdminLangsmithView />);
    expect(await screen.findByText('No traces.')).toBeInTheDocument();
  });

  it('shows the API error inline when the trace list fails', async () => {
    listTraces.mockRejectedValue(new AdminError('LangSmith tracing is not configured'));
    render(<AdminLangsmithView />);
    expect(await screen.findByTestId('langsmith-error')).toHaveTextContent(
      'LangSmith tracing is not configured',
    );
  });

  it('refetches with errorsOnly and the model filter when they change', async () => {
    render(<AdminLangsmithView />);
    await screen.findByTestId('langsmith-traces');
    listTraces.mockClear();

    fireEvent.click(screen.getByTestId('langsmith-errors-only'));
    await waitFor(() => expect(listTraces).toHaveBeenCalledWith({ errorsOnly: true }));

    fireEvent.change(screen.getByTestId('langsmith-model-filter'), {
      target: { value: 'qwen/qwen3-14b' },
    });
    await waitFor(() =>
      expect(listTraces).toHaveBeenCalledWith({ errorsOnly: true, model: 'qwen/qwen3-14b' }),
    );

    // Refresh re-applies the current filters.
    listTraces.mockClear();
    fireEvent.click(screen.getByTestId('langsmith-refresh'));
    await waitFor(() =>
      expect(listTraces).toHaveBeenCalledWith({ errorsOnly: true, model: 'qwen/qwen3-14b' }),
    );
  });

  it('links a trace row to its LangSmith run when the row carries an app path', async () => {
    render(<AdminLangsmithView />);
    const link = await screen.findByTestId('langsmith-open-external-trace-1');
    expect(link).toHaveAttribute(
      'href',
      'https://smith.langchain.com/o/org/projects/p/proj-1/r/run-1',
    );
  });

  it('drills into the run tree and back to the list', async () => {
    render(<AdminLangsmithView />);
    fireEvent.click(await screen.findByTestId('langsmith-open-trace-1'));

    const detail = await screen.findByTestId('langsmith-trace-detail');
    expect(getTrace).toHaveBeenCalledWith('trace-1');
    expect(detail).toHaveTextContent("agent run: 'tova-groq'");
    expect(screen.getByTestId('langsmith-run-llm-1')).toHaveTextContent(
      "llm: 'openai/gpt-oss-20b'",
    );
    // The llm run names its provider and its time-to-first-token.
    // @see #237
    expect(screen.getByTestId('langsmith-run-llm-1')).toHaveTextContent(
      'openai/gpt-oss-20b · groq',
    );
    expect(screen.getByTestId('langsmith-run-llm-1')).toHaveTextContent('first token 300ms');
    // The llm run's outputs render as formatted JSON inside the details block.
    expect(screen.getByTestId('langsmith-run-llm-1')).toHaveTextContent('hi there');

    fireEvent.click(screen.getByTestId('langsmith-detail-close'));
    expect(screen.queryByTestId('langsmith-trace-detail')).not.toBeInTheDocument();
    expect(screen.getByTestId('langsmith-traces')).toBeInTheDocument();
  });

  it('shows the detail error when a trace cannot be loaded', async () => {
    getTrace.mockRejectedValue(new AdminError('Failed to load LangSmith trace.'));
    render(<AdminLangsmithView />);
    fireEvent.click(await screen.findByTestId('langsmith-open-trace-1'));
    expect(await screen.findByText('Failed to load LangSmith trace.')).toBeInTheDocument();
  });
});
