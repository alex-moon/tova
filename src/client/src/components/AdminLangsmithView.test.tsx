import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import AdminLangsmithView from './AdminLangsmithView';
import { AdminError } from '../services/admin';
import type {
  AdminTracesPayload,
  AdminLangsmithStatsPayload,
  AdminTraceDetail,
} from '../types/admin';

/*
 * #186: the Traces tab renders the joined trace rows and the stats strip,
 * refetches on filter changes, and drills into the run tree. The service
 * connector is mocked like in AdminView.test.tsx (no axios on the floor).
 */

const listTraces = vi.fn();
const getTrace = vi.fn();
const listStats = vi.fn();

vi.mock('../services/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/admin')>();
  return {
    ...actual,
    AdminLangsmithService: {
      listTraces: (...args: unknown[]) => listTraces(...args),
      getTrace: (...args: unknown[]) => getTrace(...args),
      listStats: (...args: unknown[]) => listStats(...args),
    },
  };
});

const traceRow = (overrides: Partial<AdminTracesPayload['traces'][number]> = {}) => ({
  id: 'run-1',
  traceId: 'trace-1',
  name: "agent run: 'tova-groq'",
  status: 'success',
  model: 'openai/gpt-oss-20b',
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
    { model: 'openai/gpt-oss-20b', calls: 10, errors: 2, avgDurationMs: 1500, totalTokens: 4000 },
    { model: 'qwen/qwen3-14b', calls: 4, errors: 0, avgDurationMs: 3000, totalTokens: 900 },
  ],
  totals: { calls: 14, errors: 2, totalTokens: 4900 },
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
      startedAt: '2026-09-27T10:00:00.000Z',
      endedAt: '2026-09-27T10:00:02.000Z',
      durationMs: 2000,
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
      startedAt: '2026-09-27T10:00:00.100000Z',
      endedAt: '2026-09-27T10:00:01.000000Z',
      durationMs: 900,
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
  });

  it('loads traces and stats on mount and renders both tables', async () => {
    render(<AdminLangsmithView />);
    expect(await screen.findByTestId('langsmith-traces')).toBeInTheDocument();
    expect(listTraces).toHaveBeenCalledWith({});
    expect(listStats).toHaveBeenCalledWith();

    const row = await screen.findByTestId('langsmith-trace-trace-1');
    expect(row).toHaveTextContent('success');
    expect(row).toHaveTextContent('openai/gpt-oss-20b');
    expect(row).toHaveTextContent('585');

    const stats = screen.getByTestId('langsmith-stats');
    expect(stats).toHaveTextContent('openai/gpt-oss-20b');
    expect(stats).toHaveTextContent('10');
    expect(stats).toHaveTextContent('2');
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
