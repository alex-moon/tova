import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import AssetLibrary from '../../main/components/AssetLibrary';
import type { AssetSummary, BulkUploadFileResult } from '../../main/services/assets';
import { AuthContext } from '../../main/context/AuthContext';
import type { User } from '../../main/context/AuthContext';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('../../main/services/assets', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../main/services/assets')>();
  return {
    ...original,
    default: {
      list: vi.fn(),
      upload: vi.fn(),
      uploadMany: vi.fn(),
      downloadUrl: vi.fn(),
      delete: vi.fn(),
      bulkDownloadUrl: vi.fn(() => '/api/assets/bulk-download'),
      bulkDelete: vi.fn(),
    },
  };
});

import AssetService from '../../main/services/assets';

const asset = (over: Partial<AssetSummary> = {}): AssetSummary => ({
  id: 'a1',
  filename: 'notes.txt',
  contentType: 'text/plain',
  size: 12,
  status: 'ready',
  hasText: true,
  createdAt: new Date().toISOString(),
  ...over,
});

const renderLibrary = (
  props: {
    onSelect?: (a: AssetSummary) => void;
    user?: Partial<User>;
  } = {},
) => {
  const user: User = { id: '1', email: 'a@b.c', role: 'user', permissions: [], ...props.user };
  return render(
    <AuthContext.Provider
      value={{
        user,
        loading: false,
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
        updateUser: vi.fn(),
      }}
    >
      <AssetLibrary onSelect={props.onSelect} />
    </AuthContext.Provider>,
  );
};

describe('AssetLibrary — regression cover (issue #34)', () => {
  afterEach(cleanup);
  vi.mocked(AssetService.list).mockResolvedValue({ assets: [], nextCursor: null });

  it('still lists and deletes assets', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    renderLibrary();
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());
    expect(screen.queryByTestId('asset-loading')).not.toBeInTheDocument();
  });
});

describe('AssetLibrary — bulk download (issue #69)', () => {
  afterEach(cleanup);
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => undefined);

  it('shows "Download selected" only for ready assets and builds the id query', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [asset(), asset({ id: 'a2', filename: 'wip.bin', status: 'pending' })],
      nextCursor: null,
    });
    renderLibrary();
    await screen.findByText('wip.bin');

    expect(screen.queryByTestId('asset-bulk-download')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select notes.txt' }));
    expect(screen.getByTestId('asset-bulk-download')).toBeInTheDocument();

    const pending = screen.getByRole('checkbox', { name: 'Select wip.bin' });
    expect(pending).toBeDisabled();

    fireEvent.click(screen.getByTestId('asset-bulk-download'));
    await waitFor(() =>
      expect(vi.mocked(AssetService.bulkDownloadUrl)).toHaveBeenCalledWith(['a1']),
    );
    expect(clickSpy).toHaveBeenCalled();
  });

  it('toggles selection off and hides the action at zero selected', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [asset()],
      nextCursor: null,
    });
    renderLibrary();
    await screen.findByText('notes.txt');

    const checkbox = screen.getByRole('checkbox', { name: 'Select notes.txt' });
    fireEvent.click(checkbox);
    expect(screen.getByTestId('asset-bulk-download')).toBeInTheDocument();
    fireEvent.click(checkbox);
    expect(screen.queryByTestId('asset-bulk-download')).not.toBeInTheDocument();
  });
});

describe('AssetLibrary — batch delete (issue #69 × #59)', () => {
  afterEach(cleanup);

  it('arms an inline confirm strip and deletes the selection with Yes', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [asset(), asset({ id: 'a2', filename: 'wip.bin', status: 'pending' })],
      nextCursor: null,
    });
    vi.mocked(AssetService.bulkDelete).mockResolvedValue(undefined);
    renderLibrary();
    await screen.findByText('notes.txt');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select notes.txt' }));
    fireEvent.click(screen.getByTestId('asset-bulk-delete'));
    await screen.findByText('Delete 1 selected? Irreversible.');
    expect(screen.getByTestId('confirm-yes')).toHaveFocus();
    fireEvent.click(screen.getByTestId('confirm-yes'));
    await waitFor(() => expect(AssetService.bulkDelete).toHaveBeenCalledWith(['a1']));
    await waitFor(() => expect(screen.queryByText(/Delete 1 selected/)).not.toBeInTheDocument());
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
  });

  it('confirm off preference deletes the selection immediately', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    vi.mocked(AssetService.bulkDelete).mockResolvedValue(undefined);
    renderLibrary({ user: { confirmDeletes: { chat: true, file: false } } });
    await screen.findByText('notes.txt');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select notes.txt' }));
    fireEvent.click(screen.getByTestId('asset-bulk-delete'));
    await waitFor(() => expect(AssetService.bulkDelete).toHaveBeenCalledWith(['a1']));
  });

  it('shows the bulk bar only for ready assets and clears selection after delete', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [asset(), asset({ id: 'a2', filename: 'wip.bin', status: 'pending' })],
      nextCursor: null,
    });
    vi.mocked(AssetService.bulkDelete).mockResolvedValue(undefined);
    renderLibrary();
    await screen.findByText('wip.bin');

    expect(screen.getByRole('checkbox', { name: 'Select wip.bin' })).toBeDisabled();
    expect(screen.queryByTestId('asset-bulk-delete')).not.toBeInTheDocument();
  });
});
describe('AssetLibrary — bulk upload (issue #68)', () => {
  afterEach(cleanup);
  vi.mocked(AssetService.list).mockResolvedValue({ assets: [], nextCursor: null });
  vi.mocked(AssetService.uploadMany).mockReset();

  const row = (over: Partial<BulkUploadFileResult> = {}, name = 'x.txt'): BulkUploadFileResult => ({
    file: new File(['x'], name),
    ...over,
  });
  const uploadBy =
    (results: BulkUploadFileResult[]) =>
    (_files: File[] | FileList, onProgress?: (i: number, pct: number) => void) => {
      results.forEach((r, i) => r.asset && onProgress?.(i, 100));
      return Promise.resolve(results);
    };

  const fileByName = (name: string) => Object.assign(new File(['x'], name), {});

  it('renders the hidden input with multiple', () => {
    renderLibrary();
    expect(screen.getByTestId('asset-input')).toHaveAttribute('multiple');
  });

  it('opens the file picker when the whole dropzone is clicked (#219)', async () => {
    renderLibrary();
    const input = screen.getByTestId('asset-input');
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => undefined);
    fireEvent.click(screen.getByTestId('asset-dropzone'));
    expect(clickSpy).toHaveBeenCalled();
  });

  it('keeps the dropzone clickable after an upload completes (#219)', async () => {
    vi.mocked(AssetService.uploadMany).mockImplementation(
      uploadBy([row({ asset: asset({ id: 'a-ok', filename: 'ok.txt' }) }, 'ok.txt')]),
    );
    renderLibrary();
    fireEvent.change(screen.getByTestId('asset-input'), {
      target: { files: [fileByName('ok.txt')] },
    });
    await screen.findByTestId('upload-rows');
    const dropzone = screen.getByTestId('asset-dropzone');
    expect(dropzone).toBeInTheDocument();
    const input = screen.getByTestId('asset-input');
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => undefined);
    fireEvent.click(dropzone);
    expect(clickSpy).toHaveBeenCalled();
  });

  it('shows per-file rows: successes list in the grid, errors keep their message', async () => {
    vi.mocked(AssetService.uploadMany).mockImplementation(
      uploadBy([
        row({ asset: asset({ id: 'a-ok', filename: 'ok.txt' }) }, 'ok.txt'),
        row({ error: 'File type is not allowed' }, 'bad.exe'),
      ]),
    );
    renderLibrary();
    fireEvent.change(screen.getByTestId('asset-input'), {
      target: { files: [fileByName('ok.txt'), fileByName('bad.exe')] },
    });
    await screen.findByTestId('upload-rows');
    expect(screen.getByText('File type is not allowed')).toBeInTheDocument();
    expect(screen.getByTestId('upload-row-0')).toHaveTextContent('Uploaded');
    expect(screen.getByTestId('upload-row-1')).toHaveTextContent('File type is not allowed');
    // 'ok.txt' appears twice once the success lands in the grid: upload row + listing.
    expect(await screen.findAllByText('ok.txt')).toHaveLength(2);
    expect(vi.mocked(AssetService.uploadMany).mock.calls[0][1]).toBeTypeOf('function');
  });

  it('renders progress for in-flight uploads', async () => {
    let settle: (rows: BulkUploadFileResult[]) => void = () => {};
    vi.mocked(AssetService.uploadMany).mockImplementation(
      (_files: File[] | FileList, onProgress?: (i: number, pct: number) => void) =>
        new Promise((res) => {
          onProgress?.(0, 40);
          settle = res;
        }),
    );
    renderLibrary();
    fireEvent.change(screen.getByTestId('asset-input'), {
      target: { files: [fileByName('a.txt')] },
    });
    await screen.findByText('Uploading 40%');
    settle([row({ error: 'Behind upload' }, 'a.txt')]);
    await screen.findByTestId('upload-row-0');
    expect(screen.getByTestId('upload-row-0')).toHaveTextContent('Behind upload');
  });
});

describe('AssetLibrary — conversion feedback (issue #83)', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows an extracting spinner for a pending conversion', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [
        asset({
          id: 'a2',
          filename: 'doc.pdf',
          contentType: 'application/pdf',
          markdownStatus: 'pending',
          hasText: false,
        }),
      ],
      nextCursor: null,
    });
    renderLibrary();
    expect(await screen.findByTestId('asset-extracting')).toHaveTextContent('Extracting text…');
  });

  it('shows "Text extracted" for a ready conversion', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [
        asset({
          id: 'a3',
          filename: 'doc.pdf',
          contentType: 'application/pdf',
          markdownStatus: 'ready',
          hasText: true,
        }),
      ],
      nextCursor: null,
    });
    renderLibrary();
    await screen.findByText('doc.pdf');
    expect(screen.getByTestId('asset-extract-ready')).toHaveTextContent('Text extracted');
    expect(screen.queryByTestId('asset-extracting')).not.toBeInTheDocument();
  });

  it('shows a failed badge with the failure reason as tooltip', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [
        asset({
          id: 'a4',
          filename: 'doc.pdf',
          contentType: 'application/pdf',
          markdownStatus: 'failed',
          markdownFailureReason: 'Worker crashed',
          hasText: false,
        }),
      ],
      nextCursor: null,
    });
    renderLibrary();
    const badge = await screen.findByTestId('asset-extract-failed');
    expect(badge).toHaveTextContent('Extraction failed');
    expect(badge).toHaveAttribute('title', 'Worker crashed');
  });

  it('stays silent for markdownStatus none (plain files)', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [asset({ markdownStatus: 'none' })],
      nextCursor: null,
    });
    renderLibrary();
    await screen.findByText('notes.txt');
    expect(screen.queryByTestId('asset-extracting')).not.toBeInTheDocument();
    expect(screen.queryByText('Text extracted')).not.toBeInTheDocument();
  });

  it('refetches silently while a card is pending and clears the spinner on ready', async () => {
    const pending = asset({
      id: 'a5',
      filename: 'doc.pdf',
      contentType: 'application/pdf',
      markdownStatus: 'pending',
      hasText: false,
    });
    vi.useFakeTimers();
    vi.mocked(AssetService.list)
      .mockReset()
      .mockResolvedValue({ assets: [pending], nextCursor: null });
    renderLibrary();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('asset-extracting')).toBeInTheDocument();
    expect(vi.mocked(AssetService.list)).toHaveBeenCalledTimes(1);
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [asset({ ...pending, markdownStatus: 'ready', hasText: true })],
      nextCursor: null,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    vi.useRealTimers();
    expect(screen.getByTestId('asset-extract-ready')).toHaveTextContent('Text extracted');
    expect(screen.queryByTestId('asset-extracting')).not.toBeInTheDocument();
    expect(vi.mocked(AssetService.list)).toHaveBeenCalledTimes(2);
    // Silent poll: the grid never went back to the loading placeholder.
    expect(screen.queryByTestId('asset-loading')).not.toBeInTheDocument();
  });

  it('keeps polling silently and never toasts when a polled refetch fails', async () => {
    const pending = asset({
      id: 'a6',
      filename: 'doc.pdf',
      contentType: 'application/pdf',
      markdownStatus: 'pending',
      hasText: false,
    });
    vi.useFakeTimers();
    vi.mocked(AssetService.list)
      .mockReset()
      .mockResolvedValueOnce({ assets: [pending], nextCursor: null })
      .mockRejectedValue(new Error('network down'));
    renderLibrary();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('asset-extracting')).toBeInTheDocument();
    // Transient list failures during the silent poll must not interrupt the
    // user (no error toast, no loading flash) and must not stop the poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    vi.useRealTimers();
    expect(screen.getByTestId('asset-extracting')).toBeInTheDocument();
    expect(vi.mocked(AssetService.list)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(AssetService.list)).toHaveBeenLastCalledWith();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('AssetLibrary — provenance display (issue #252)', () => {
  afterEach(cleanup);
  vi.mocked(AssetService.list).mockResolvedValue({ assets: [], nextCursor: null });

  it.each([
    ['upload', 'Uploaded'],
    ['chat', 'From chat'],
    ['task', 'From task'],
  ] as const)('renders the label for kind %s', async (kind, label) => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [asset({ provenance: { kind } })],
      nextCursor: null,
    });
    renderLibrary();
    await screen.findByText('notes.txt');
    expect(screen.getByTestId('asset-provenance')).toHaveTextContent(label);
  });

  it('renders nothing for null provenance (unknown)', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [asset({ provenance: null })],
      nextCursor: null,
    });
    renderLibrary();
    await screen.findByText('notes.txt');
    expect(screen.queryByTestId('asset-provenance')).not.toBeInTheDocument();
  });

  it('renders nothing when provenance is absent', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    renderLibrary();
    await screen.findByText('notes.txt');
    expect(screen.queryByTestId('asset-provenance')).not.toBeInTheDocument();
  });
});

describe('AssetLibrary — inline delete confirm (issue #59)', () => {
  afterEach(cleanup);
  vi.mocked(AssetService.list).mockResolvedValue({ assets: [], nextCursor: null });

  it('never opens a blocking browser dialog', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    vi.mocked(AssetService.delete).mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm');
    const alertSpy = vi.spyOn(window, 'alert');
    renderLibrary();
    await screen.findByText('notes.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Delete notes.txt' }));
    await screen.findByText('Sure? Irreversible.');
    // Focus moves to Yes so keyboard/screen-reader users stay oriented when
    // the card swaps in (focus would otherwise drop to <body>).
    expect(screen.getByTestId('confirm-yes')).toHaveFocus();
    fireEvent.click(screen.getByTestId('confirm-yes'));
    await waitFor(() => expect(AssetService.delete).toHaveBeenCalledWith('a1'));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('arm → no keeps the file and closes the strip', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    renderLibrary();
    await screen.findByText('notes.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Delete notes.txt' }));
    await screen.findByText('Sure? Irreversible.');
    fireEvent.click(screen.getByTestId('confirm-no'));
    await waitFor(() => expect(screen.queryByText('Sure? Irreversible.')).not.toBeInTheDocument());
    expect(AssetService.delete).not.toHaveBeenCalled();
  });

  it('arm → yes deletes the file', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    vi.mocked(AssetService.delete).mockResolvedValue(undefined);
    renderLibrary();
    await screen.findByText('notes.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Delete notes.txt' }));
    await screen.findByText('Sure? Irreversible.');
    fireEvent.click(screen.getByTestId('confirm-yes'));
    await waitFor(() => expect(AssetService.delete).toHaveBeenCalledWith('a1'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Deleted "notes.txt"'));
  });

  it('deletes immediately when the chat-level preference is off', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    vi.mocked(AssetService.delete).mockResolvedValue(undefined);
    renderLibrary({ user: { confirmDeletes: { chat: true, file: false } } });
    await screen.findByText('notes.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Delete notes.txt' }));
    await waitFor(() => expect(AssetService.delete).toHaveBeenCalledWith('a1'));
  });
});
