import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import AssetsView from '../../main/components/AssetsView';
import type { AssetContent, AssetSummary } from '../../main/services/assets';
import { AuthContext } from '../../main/context/AuthContext';
import type { User } from '../../main/context/AuthContext';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('../../main/services/assets', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../main/services/assets')>();
  return {
    ...original,
    default: {
      list: vi.fn(),
      content: vi.fn(),
      downloadUrl: vi.fn(),
      thumbnailUrl: vi.fn(),
      versions: vi.fn(),
      versionContent: vi.fn(),
      restore: vi.fn(),
      delete: vi.fn(),
      bulkDownloadUrl: vi.fn(() => '/api/assets/bulk-download'),
      bulkDelete: vi.fn(),
      uploadMany: vi.fn(),
    },
  };
});

import AssetService from '../../main/services/assets';

const renderView = () => {
  const user: User = { id: '1', email: 'a@b.c', role: 'user', permissions: [] };
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
      <AssetsView />
    </AuthContext.Provider>,
  );
};

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

const content = (over: Partial<AssetContent> = {}): AssetContent => ({
  id: 'a1',
  filename: 'notes.txt',
  contentType: 'text/plain',
  size: 12,
  status: 'ready',
  content: '# Hello',
  format: 'markdown',
  markdownStatus: 'ready',
  markdownFailureReason: null,
  createdAt: new Date().toISOString(),
  ...over,
});

describe('AssetsView (issue #197)', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.mocked(AssetService.list).mockReset();
    vi.mocked(AssetService.content).mockReset();
    vi.mocked(AssetService.thumbnailUrl).mockReset();
  });

  it('shows the select-a-file prompt before anything is chosen', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    renderView();
    expect(await screen.findByTestId('assets-view')).toBeInTheDocument();
    expect(screen.getByText(/select a file to preview/i)).toBeInTheDocument();
  });

  it('loads and renders markdown when a file is selected', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    vi.mocked(AssetService.content).mockResolvedValue(content({ content: '# Hello' }));
    renderView();
    fireEvent.click(await screen.findByTestId('asset-preview-a1'));
    await waitFor(() => expect(screen.getByTestId('assets-preview-body')).toBeInTheDocument());
    expect(AssetService.content).toHaveBeenCalledWith('a1');
    expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument();
  });

  it('renders plain text without markdown conversion for a text format', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    vi.mocked(AssetService.content).mockResolvedValue(
      content({ content: '# not a heading', format: 'text' }),
    );
    renderView();
    fireEvent.click(await screen.findByTestId('asset-preview-a1'));
    await screen.findByTestId('assets-preview-body');
    expect(screen.getByText('# not a heading')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'not a heading' })).not.toBeInTheDocument();
  });

  it('shows "(no extracted text)" when content is null and not pending/failed', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    vi.mocked(AssetService.content).mockResolvedValue(
      content({ content: null, format: 'text', markdownStatus: 'none' }),
    );
    renderView();
    fireEvent.click(await screen.findByTestId('asset-preview-a1'));
    expect(await screen.findByText('(no extracted text)')).toBeInTheDocument();
  });

  it('shows the failure reason when extraction failed', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    vi.mocked(AssetService.content).mockResolvedValue(
      content({
        content: null,
        format: 'text',
        markdownStatus: 'failed',
        markdownFailureReason: 'converter exploded',
      }),
    );
    renderView();
    fireEvent.click(await screen.findByTestId('asset-preview-a1'));
    expect(await screen.findByText(/converter exploded/)).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    vi.mocked(AssetService.content).mockRejectedValue(new Error('Could not load this file'));
    renderView();
    fireEvent.click(await screen.findByTestId('asset-preview-a1'));
    expect(await screen.findByTestId('assets-preview-error')).toHaveTextContent(
      'Could not load this file',
    );
  });

  it('exposes a back control that clears the selection (#219)', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    vi.mocked(AssetService.content).mockResolvedValue(content({ content: '# Hello' }));
    renderView();
    fireEvent.click(await screen.findByTestId('asset-preview-a1'));
    await screen.findByTestId('assets-preview-title');
    fireEvent.click(screen.getByTestId('assets-preview-back'));
    expect(screen.queryByTestId('assets-preview-title')).not.toBeInTheDocument();
    expect(screen.getByText(/select a file to preview/i)).toBeInTheDocument();
  });

  it('renders the thumbnail for a ready image asset (#208)', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [
        asset({
          id: 'img1',
          filename: 'photo.png',
          contentType: 'image/png',
          thumbnailStatus: 'ready',
        }),
      ],
      nextCursor: null,
    });
    vi.mocked(AssetService.thumbnailUrl).mockResolvedValue({
      url: 'https://spaces.example/thumb',
      status: 'ready',
    });
    renderView();
    fireEvent.click(await screen.findByTestId('asset-preview-img1'));
    const img = await screen.findByRole('img', { name: 'photo.png' });
    expect(img).toHaveAttribute('src', 'https://spaces.example/thumb');
    expect(AssetService.thumbnailUrl).toHaveBeenCalledWith('img1');
    expect(AssetService.content).not.toHaveBeenCalled();
  });

  it('shows a preparing state while an image thumbnail is pending (#208)', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [
        asset({
          id: 'img2',
          filename: 'photo.png',
          contentType: 'image/png',
          thumbnailStatus: 'pending',
        }),
      ],
      nextCursor: null,
    });
    vi.mocked(AssetService.thumbnailUrl).mockResolvedValue({ url: null, status: 'pending' });
    renderView();
    fireEvent.click(await screen.findByTestId('asset-preview-img2'));
    expect(await screen.findByText(/preparing preview/i)).toBeInTheDocument();
    expect(AssetService.thumbnailUrl).toHaveBeenCalledWith('img2');
  });

  it('falls back to a no-preview state when the image thumbnail is unavailable (#208)', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [
        asset({
          id: 'img3',
          filename: 'photo.png',
          contentType: 'image/png',
          thumbnailStatus: 'none',
        }),
      ],
      nextCursor: null,
    });
    vi.mocked(AssetService.thumbnailUrl).mockResolvedValue({ url: null, status: 'none' });
    renderView();
    fireEvent.click(await screen.findByTestId('asset-preview-img3'));
    expect(await screen.findByText('(no preview available)')).toBeInTheDocument();
  });
});

describe('AssetsView version history (#325)', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.mocked(AssetService.list).mockReset();
    vi.mocked(AssetService.content).mockReset();
    vi.mocked(AssetService.thumbnailUrl).mockReset();
    vi.mocked(AssetService.versions).mockReset();
    vi.mocked(AssetService.versionContent).mockReset();
    vi.mocked(AssetService.restore).mockReset();
  });

  const generated = (over: Partial<AssetSummary> = {}) =>
    asset({ id: 'gen1', filename: 'notes.md', contentType: 'text/markdown', version: 2, ...over });

  it('hides the History control when there is no history', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [asset()], nextCursor: null });
    vi.mocked(AssetService.content).mockResolvedValue(content());
    renderView();
    fireEvent.click(await screen.findByTestId('asset-preview-a1'));
    await screen.findByTestId('assets-preview-body');
    expect(screen.queryByTestId('assets-history-toggle')).not.toBeInTheDocument();
  });

  it('lists versions and previews a past version read-only', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [generated()], nextCursor: null });
    vi.mocked(AssetService.content).mockResolvedValue(
      content({ id: 'gen1', filename: 'notes.md', content: 'current body' }),
    );
    vi.mocked(AssetService.versions).mockResolvedValue([
      { version: 2, size: 12, createdAt: new Date().toISOString() },
      { version: 1, size: 8, createdAt: new Date().toISOString() },
    ]);
    vi.mocked(AssetService.versionContent).mockResolvedValue({
      version: 1,
      size: 8,
      content: 'old body',
      format: 'markdown',
      createdAt: new Date().toISOString(),
    });

    renderView();
    fireEvent.click(await screen.findByTestId('asset-preview-gen1'));
    await screen.findByTestId('assets-preview-body');

    fireEvent.click(screen.getByTestId('assets-history-toggle'));
    expect(await screen.findByTestId('assets-history-list')).toBeInTheDocument();
    expect(screen.getByTestId('assets-history-item-2')).toHaveTextContent('Current');

    fireEvent.click(screen.getByTestId('assets-history-item-1'));
    expect(await screen.findByTestId('assets-version-preview')).toBeInTheDocument();
    expect(screen.getByTestId('assets-version-banner')).toHaveTextContent('Version 1');
    expect(await screen.findByText('old body')).toBeInTheDocument();
    expect(AssetService.versionContent).toHaveBeenCalledWith('gen1', 1);
  });

  it('restores a past version and reloads the current content', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [generated()], nextCursor: null });
    vi.mocked(AssetService.content).mockResolvedValue(
      content({ id: 'gen1', filename: 'notes.md', content: 'current body' }),
    );
    vi.mocked(AssetService.versions).mockResolvedValue([
      { version: 2, size: 12, createdAt: new Date().toISOString() },
      { version: 1, size: 8, createdAt: new Date().toISOString() },
    ]);
    vi.mocked(AssetService.versionContent).mockResolvedValue({
      version: 1,
      size: 8,
      content: 'old body',
      format: 'markdown',
      createdAt: new Date().toISOString(),
    });
    vi.mocked(AssetService.restore).mockResolvedValue(generated({ version: 3 }) as AssetSummary);

    renderView();
    fireEvent.click(await screen.findByTestId('asset-preview-gen1'));
    await screen.findByTestId('assets-preview-body');
    fireEvent.click(screen.getByTestId('assets-history-toggle'));
    fireEvent.click(await screen.findByTestId('assets-history-item-1'));

    fireEvent.click(await screen.findByTestId('assets-version-restore'));
    await waitFor(() => expect(AssetService.restore).toHaveBeenCalledWith('gen1', 1));
    await waitFor(() =>
      expect(screen.queryByTestId('assets-version-preview')).not.toBeInTheDocument(),
    );
  });

  it('returns from a version preview back to the version list', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [generated()], nextCursor: null });
    vi.mocked(AssetService.content).mockResolvedValue(content({ id: 'gen1' }));
    vi.mocked(AssetService.versions).mockResolvedValue([
      { version: 2, size: 12, createdAt: new Date().toISOString() },
      { version: 1, size: 8, createdAt: new Date().toISOString() },
    ]);
    vi.mocked(AssetService.versionContent).mockResolvedValue({
      version: 1,
      size: 8,
      content: 'old body',
      format: 'markdown',
      createdAt: new Date().toISOString(),
    });

    renderView();
    fireEvent.click(await screen.findByTestId('asset-preview-gen1'));
    await screen.findByTestId('assets-preview-body');
    fireEvent.click(screen.getByTestId('assets-history-toggle'));
    fireEvent.click(await screen.findByTestId('assets-history-item-1'));
    await screen.findByTestId('assets-version-preview');
    fireEvent.click(screen.getByTestId('assets-version-back'));
    expect(await screen.findByTestId('assets-history-list')).toBeInTheDocument();
  });
});
