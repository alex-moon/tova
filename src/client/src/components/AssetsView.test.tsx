import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import AssetsView from './AssetsView';
import type { AssetContent, AssetSummary } from '../services/assets';
import { AuthContext } from '../context/AuthContext';
import type { User } from '../context/AuthContext';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('../services/assets', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/assets')>();
  return {
    ...original,
    default: {
      list: vi.fn(),
      content: vi.fn(),
      downloadUrl: vi.fn(),
      thumbnailUrl: vi.fn(),
      delete: vi.fn(),
      bulkDownloadUrl: vi.fn(() => '/api/assets/bulk-download'),
      bulkDelete: vi.fn(),
      uploadMany: vi.fn(),
    },
  };
});

import AssetService from '../services/assets';

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
    // Images never fetch the text content endpoint.
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
