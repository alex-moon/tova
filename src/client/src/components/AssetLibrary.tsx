import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Loader2,
  Paperclip,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import AssetService, { type AssetSummary } from '@/services/assets';
import { useConfirmDelete } from '../hooks/useConfirmDelete';

const MAX_ASSET_SIZE = 15 * 1024 * 1024;

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// Type icon only (owner constraint on issue #34): file contents are never
// rendered or previewed in the browser — the grid shows icons, not thumbs.
const IconFor: React.FC<{ contentType: string; filename: string }> = ({
  contentType,
  filename,
}) => {
  let icon = <FileText className="size-5" />;
  if (contentType.startsWith('image/')) icon = <FileImage className="size-5" />;
  else if (contentType === 'application/pdf') icon = <FileText className="size-5" />;
  else if (filename.endsWith('.csv')) icon = <FileSpreadsheet className="size-5" />;
  else if (filename.endsWith('.json')) icon = <FileCode className="size-5" />;
  return (
    <span aria-hidden className="shrink-0 text-muted-foreground">
      {icon}
    </span>
  );
};

interface AssetLibraryProps {
  onClose: () => void;
  // Issue #51: hands a library asset back to the composer without re-uploading
  // bytes. Optional so the library works standalone (Sidebar render).
  onPickAsset?: (asset: AssetSummary) => void;
}

const AssetLibrary: React.FC<AssetLibraryProps> = ({ onClose, onPickAsset }) => {
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const page = await AssetService.list();
      setAssets(page.assets);
      setNextCursor(page.nextCursor);
    } catch (err) {
      console.error('Error listing assets:', err);
      toast.error('Could not load your files');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      if (file.size > MAX_ASSET_SIZE) {
        toast.error(`"${file.name}" is too large (max 15 MB)`);
        continue;
      }
      setUploadingName(file.name);
      try {
        const asset = await AssetService.upload(file);
        setAssets((prev) => [asset, ...prev]);
        toast.success(`Uploaded "${file.name}"`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Upload failed');
      } finally {
        setUploadingName(null);
      }
    }
  }, []);

  const handleDelete = async (assetId: string) => {
    setDeletingId(assetId);
    try {
      await AssetService.delete(assetId);
      setAssets((prev) => prev.filter((a) => a.id !== assetId));
      const deleted = assets.find((a) => a.id === assetId);
      toast.success(`Deleted "${deleted?.filename ?? 'file'}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  };

  const { armedId, arm, onYes, onAlways, onNo } = useConfirmDelete('file', (id) => {
    void handleDelete(id);
  });

  const handleDownload = async (asset: AssetSummary) => {
    try {
      const url = await AssetService.downloadUrl(asset.id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    void handleFiles(e.dataTransfer.files);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85dvh] w-full max-w-2xl flex-col rounded-xl border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Asset library"
        data-testid="asset-library"
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <h2 className="font-heading text-lg font-semibold">Files</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close files"
            onClick={onClose}
            className="text-muted-foreground"
          >
            <X />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div
              className="flex items-center justify-center gap-2 py-10 text-muted-foreground"
              data-testid="asset-loading"
            >
              <Loader2 className="size-5 animate-spin" /> Loading…
            </div>
          ) : assets.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No files yet. Upload one below or attach it to a message in the chat.
            </p>
          ) : (
            <>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {assets.map((asset) =>
                  armedId === asset.id ? (
                    <li
                      key={asset.id}
                      data-testid={`confirm-delete-file-${asset.id}`}
                      className="flex items-center gap-1 rounded-lg border border-destructive bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
                    >
                      <span className="min-w-0 flex-1 truncate">Sure? Irreversible.</span>
                      <button
                        type="button"
                        data-testid="confirm-yes"
                        aria-label="Yes, delete file"
                        autoFocus
                        disabled={deletingId === asset.id}
                        onClick={onYes}
                        className="shrink-0 rounded-md px-2 py-1 text-xs font-medium hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        data-testid="confirm-always"
                        aria-label="Always delete files without asking"
                        disabled={deletingId === asset.id}
                        onClick={() => void onAlways()}
                        className="shrink-0 rounded-md px-2 py-1 text-xs font-medium hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
                      >
                        Always
                      </button>
                      <button
                        type="button"
                        data-testid="confirm-no"
                        aria-label="No, keep the file"
                        disabled={deletingId === asset.id}
                        onClick={onNo}
                        className="shrink-0 rounded-md px-2 py-1 text-xs font-medium hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
                      >
                        No
                      </button>
                    </li>
                  ) : (
                    <li
                      key={asset.id}
                      className="flex items-center gap-3 rounded-lg border border-border bg-msg-assistant px-3 py-2.5"
                    >
                      <IconFor contentType={asset.contentType} filename={asset.filename} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{asset.filename}</span>
                        <span className="block text-xs text-muted-foreground">
                          {formatSize(asset.size)} ·{' '}
                          {new Date(asset.createdAt).toLocaleDateString()}
                        </span>
                      </span>
                      {onPickAsset && (
                        <button
                          type="button"
                          title={
                            asset.status === 'ready'
                              ? 'Attach to chat'
                              : 'This file is not ready to attach'
                          }
                          aria-label={`Attach ${asset.filename} to chat`}
                          disabled={asset.status !== 'ready' || deletingId === asset.id}
                          data-testid="asset-attach"
                          onClick={() => onPickAsset(asset)}
                          className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Paperclip className="size-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        title="Download"
                        aria-label={`Download ${asset.filename}`}
                        onClick={() => void handleDownload(asset)}
                        className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <span className="text-xs underline">Get</span>
                      </button>
                      <button
                        type="button"
                        title="Delete"
                        aria-label={`Delete ${asset.filename}`}
                        disabled={deletingId === asset.id}
                        onClick={() => arm(asset.id)}
                        className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive disabled:opacity-50"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </li>
                  ),
                )}
              </ul>
              {nextCursor && (
                <button
                  type="button"
                  onClick={() =>
                    void AssetService.list(nextCursor)
                      .then((page) => {
                        setAssets((prev) => [...prev, ...page.assets]);
                        setNextCursor(page.nextCursor);
                      })
                      .catch(() => toast.error('Could not load more files'))
                  }
                  className="mt-3 w-full rounded-lg border border-border py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  Show more
                </button>
              )}
            </>
          )}
        </div>
        <div className="shrink-0 border-t border-border p-4">
          <div
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
            className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground transition-colors hover:border-primary hover:text-accent-foreground"
          >
            <Upload className="size-4" />
            {uploadingName ? (
              <p data-testid="asset-uploading">Uploading “{uploadingName}”…</p>
            ) : (
              <p>
                Drag a file here, or{' '}
                <button
                  type="button"
                  className="text-primary underline underline-offset-2 hover:text-primary-hover"
                  onClick={() => inputRef.current?.click()}
                >
                  choose a file
                </button>
              </p>
            )}
            <span className="text-xs">Up to 15 MB · txt, md, csv, json, pdf, images</span>
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              aria-hidden
              onChange={(e) => {
                void handleFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default AssetLibrary;
