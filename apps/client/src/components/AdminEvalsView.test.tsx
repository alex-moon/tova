import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import AdminEvalsView from './AdminEvalsView';
import { AdminError } from '../services/admin';
import type { AdminEvalRunSummary, AdminEvalRunsPayload, AdminEvalRunDetail } from '../types/admin';

/*
 * #225: the Evals tab renders the stored run rollups, drills into a run's
 * per-case breakdown, and triggers a manual run. The service connector is
 * mocked like in AdminLangsmithView.test.tsx (no axios on the floor).
 */

const listEvalRuns = vi.fn();
const getEvalRun = vi.fn();
const runEvalsNow = vi.fn();

vi.mock('../services/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/admin')>();
  return {
    ...actual,
    AdminEvalsService: {
      listEvalRuns: (...args: unknown[]) => listEvalRuns(...args),
      getEvalRun: (...args: unknown[]) => getEvalRun(...args),
      runEvalsNow: (...args: unknown[]) => runEvalsNow(...args),
    },
  };
});

const runSummary = (over: Partial<AdminEvalRunSummary> = {}): AdminEvalRunSummary => ({
  id: '64b7f9f2a1c3d4e5f6a7b8c9',
  startedAt: '2026-10-06T00:00:00.000Z',
  finishedAt: '2026-10-06T00:05:00.000Z',
  status: 'done',
  models: ['deepinfra:openai/gpt-oss-20b'],
  kind: 'tool-use',
  counts: { pass: 8, partial: 1, fail: 1, error: 0 },
  total: 10,
  error: null,
  ...over,
});

const runsPayload = (runs = [runSummary()]): AdminEvalRunsPayload => ({ runs });

const runDetail = (): AdminEvalRunDetail => ({
  ...runSummary(),
  results: [
    {
      caseId: 'bupa-fertility-files',
      model: 'openai/gpt-oss-20b',
      provider: 'deepinfra',
      score: 'pass',
      report: '"content_equals"=y',
    },
    {
      caseId: 'no-sources-unanswerable',
      model: 'openai/gpt-oss-20b',
      provider: 'deepinfra',
      score: 'fail',
      report: '"answer_contains"=n\nungraded',
    },
  ],
});

describe('AdminEvalsView (#225)', () => {
  afterEach(cleanup);

  beforeEach(() => {
    listEvalRuns.mockReset().mockResolvedValue(runsPayload());
    getEvalRun.mockReset().mockResolvedValue(runDetail());
    runEvalsNow.mockReset().mockResolvedValue({ id: '64b7f9f2a1c3d4e5f6a7b8c9' });
  });

  it('loads runs on mount and renders a row with counts', async () => {
    render(<AdminEvalsView />);
    await screen.findByTestId('evals-runs');
    expect(listEvalRuns).toHaveBeenCalled();

    const row = await screen.findByTestId('evals-run-64b7f9f2a1c3d4e5f6a7b8c9');
    expect(row).toHaveTextContent('deepinfra:openai/gpt-oss-20b');
    expect(row).toHaveTextContent('8p');
    expect(row).toHaveTextContent('1~');
    expect(row).toHaveTextContent('1f');
    expect(row).toHaveTextContent('done');
  });

  it('shows an empty state when no runs exist', async () => {
    listEvalRuns.mockResolvedValue(runsPayload([]));
    render(<AdminEvalsView />);
    expect(await screen.findByText(/No eval runs yet/)).toBeInTheDocument();
  });

  it('shows the API error inline when the list fails', async () => {
    listEvalRuns.mockRejectedValue(new AdminError('Failed to load eval runs.'));
    render(<AdminEvalsView />);
    expect(await screen.findByTestId('evals-error')).toHaveTextContent('Failed to load eval runs.');
  });

  it('drills into a run and renders its per-case breakdown', async () => {
    render(<AdminEvalsView />);
    fireEvent.click(await screen.findByTestId('evals-run-64b7f9f2a1c3d4e5f6a7b8c9'));

    expect(await screen.findByTestId('evals-run-detail')).toBeInTheDocument();
    expect(getEvalRun).toHaveBeenCalledWith('64b7f9f2a1c3d4e5f6a7b8c9');
    expect(screen.getByTestId('evals-case-bupa-fertility-files')).toHaveTextContent('pass');
    expect(screen.getByTestId('evals-case-no-sources-unanswerable')).toHaveTextContent('fail');
  });

  it('surfaces a drill-down failure', async () => {
    getEvalRun.mockRejectedValue(new AdminError('Run not found'));
    render(<AdminEvalsView />);
    fireEvent.click(await screen.findByTestId('evals-run-64b7f9f2a1c3d4e5f6a7b8c9'));
    expect(await screen.findByTestId('evals-detail-error')).toHaveTextContent('Run not found');
  });

  it('runs now and refreshes the list', async () => {
    render(<AdminEvalsView />);
    await screen.findByTestId('evals-runs');
    listEvalRuns.mockClear();

    fireEvent.click(screen.getByTestId('evals-run-now'));
    await waitFor(() => expect(runEvalsNow).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listEvalRuns).toHaveBeenCalledTimes(1));
  });
});
