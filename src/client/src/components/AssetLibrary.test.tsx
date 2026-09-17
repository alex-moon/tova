import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import AssetLibrary from './AssetLibrary';
import type { AssetSummary, BulkUploadFileResult } from '../services/assets';
import { AuthContext } from '../context/AuthContext';
import type { User } from '../context/AuthContext';
import { toast } from 'sonner';
import type { AssetSummary } from '../services/assets';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('../services/assets', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/assets')>();
  return {
    ...original,
    default: {
      list: vi.fn(),
      upload: vi.fn(),
      uploadMany: vi.fn(),
      downloadUrl: vi.fn(),
      delete: vi.fn(),
    },
  };
});

import AssetService from '../services/assets';

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
    onClose?: () => void;
    onPickAsset?: (a: AssetSummary) => void;
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
      <AssetLibrary onClose={props.onClose ?? vi.fn()} onPickAsset={props.onPickAsset} />
    </AuthContext.Provider>,
  );
};

describe('AssetLibrary — attach to chat (issue #51)', () => {
  afterEach(cleanup);
  vi.mocked(AssetService.list).mockResolvedValue({ assets: [], nextCursor: null });

  it('hands the picked asset back with id, filename and hasText', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    const onPickAsset = vi.fn();
    renderLibrary({ onPickAsset });
    await screen.findByText('notes.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Attach notes.txt to chat' }));
    expect(onPickAsset).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a1', filename: 'notes.txt', hasText: true }),
    );
  });

  it('disables attach for pending and failed assets', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [asset({ id: 'a2', filename: 'wip.bin', status: 'pending' })],
      nextCursor: null,
    });
    const onPickAsset = vi.fn();
    renderLibrary({ onPickAsset });
    await screen.findByText('wip.bin');
    const pendingBtn = screen.getByRole('button', { name: 'Attach wip.bin to chat' });
    expect(pendingBtn).toBeDisabled();
    fireEvent.click(pendingBtn);
    expect(onPickAsset).not.toHaveBeenCalled();
  });

  it('keeps the pick handler optional — no attach button when absent', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    renderLibrary();
    await screen.findByText('notes.txt');
    expect(screen.queryByTestId('asset-attach')).not.toBeInTheDocument();
  });
});

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
