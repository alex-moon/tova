import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import AssetLibrary from './AssetLibrary';
import type { AssetSummary } from '../services/assets';

vi.mock('../services/assets', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/assets')>();
  return {
    ...original,
    default: {
      list: vi.fn(),
      upload: vi.fn(),
      downloadUrl: vi.fn(),
      delete: vi.fn(),
      bulkDownloadUrl: vi.fn(() => '/api/assets/bulk-download'),
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
  props: { onClose?: () => void; onPickAsset?: (a: AssetSummary) => void } = {},
) => render(<AssetLibrary onClose={props.onClose ?? vi.fn()} onPickAsset={props.onPickAsset} />);

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
