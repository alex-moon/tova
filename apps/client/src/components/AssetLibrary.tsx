import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import AssetService, { type AssetSummary } from '@/services/assets';
import { cn } from '@/lib/utils';
import { useConfirmDelete } from '../hooks/useConfirmDelete';

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// Issue #252: short, human label for a file's provenance. Unknown (null/absent)
// renders nothing — absence means unknown, never faked as "Uploaded".
const provenanceLabel = (kind: string | undefined): string | null => {
  if (kind === 'upload') return 'Uploaded';
  if (kind === 'chat') return 'From chat';
  if (kind === 'task') return 'From task';
  return null;
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
  // Issue #197: the library is always the embedded pane now — the separate
  // `/files` view hosts it beside a preview. `onSelect` reports a clicked
  // asset; `selectedId` highlights the current one.
  onSelect?: (asset: AssetSummary) => void;
  selectedId?: string | null;
}

const AssetLibrary: React.FC<AssetLibraryProps> = ({ onSelect, selectedId = null }) => {
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploadRows, setUploadRows] = useState<
    Array<{
      name: string;
      status: 'uploading' | 'done' | 'error';
      progress: number;
      message?: string;
    }>
  >([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    try {
      if (!opts.silent) setLoading(true);
      const page = await AssetService.list();
      setAssets(page.assets);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (!opts.silent) {
        console.error('Error listing assets:', err);
        toast.error('Could not load your files');
      }
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Issue #83: while any listed asset is still converting, poll the list
  // silently (no loading flash) so pending cards turn ready/failed in place.
  // Issue #208: an image's thumbnail is a second async lifecycle, so poll
  // while either is pending.
  const anyPending = assets.some(
    (a) => a.markdownStatus === 'pending' || a.thumbnailStatus === 'pending',
  );
  useEffect(() => {
    if (!anyPending) return;
    const timer = setInterval(() => void load({ silent: true }), 3000);
    return () => clearInterval(timer);
  }, [anyPending, load]);

  // Issue #68 bulk upload: feed every selected file through uploadMany and
  // expose per-file rows (progress on upload, message on error) plus an
  // aggregate outcome. Partial failure keeps the successes; per-file errors
  // resolve from the service rather than throwing, so this reports either way.
  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    setUploadRows(list.map((file) => ({ name: file.name, status: 'uploading', progress: 0 })));
    const results = await AssetService.uploadMany(list, (index, pct) => {
      setUploadRows((prev) =>
        prev.map((row, i) => (i === index ? { ...row, progress: pct } : row)),
      );
    });
    const uploaded: AssetSummary[] = [];
    const rows = results.map((result, i) => {
      const name = list[i].name;
      if (result.asset) {
        uploaded.push(result.asset);
        return { name, status: 'done' as const, progress: 100 };
      }
      return {
        name,
        status: 'error' as const,
        progress: 100,
        message: result.error ?? 'Upload failed',
      };
    });
    setUploadRows(rows);
    if (uploaded.length) setAssets((prev) => [...uploaded, ...prev]);
    const summary = `Uploaded ${uploaded.length} of ${rows.length} files`;
    if (uploaded.length === rows.length) toast.success(summary);
    else toast.error(summary);
  }, []);

  const handleDelete = async (assetId: string) => {
    setDeletingId(assetId);
    try {
      await AssetService.delete(assetId);
      setAssets((prev) => prev.filter((a) => a.id !== assetId));
      setSelectedIds((prev) => {
        if (!prev.has(assetId)) return prev;
        const next = new Set(prev);
        next.delete(assetId);
        return next;
      });
      const deleted = assets.find((a) => a.id === assetId);
      toast.success(`Deleted "${deleted?.filename ?? 'file'}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkDeleting(true);
    try {
      await AssetService.bulkDelete(ids);
      setAssets((prev) => prev.filter((a) => !selectedIds.has(a.id)));
      setSelectedIds(new Set());
      toast.success(`Deleted ${ids.length} file${ids.length === 1 ? '' : 's'}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBulkDeleting(false);
    }
  };

  const { armedId, arm, onYes, onAlways, onNo } = useConfirmDelete('file', (id) => {
    if (id === 'bulk') void handleBulkDelete();
    else void handleDelete(id);
  });

  const handleDownload = async (asset: AssetSummary) => {
    try {
      const url = await AssetService.downloadUrl(asset.id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    }
  };

  const handleBulkDownload = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkDownloading(true);
    try {
      const url = AssetService.bulkDownloadUrl(ids);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.setAttribute('download', '');
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      setBulkDownloading(false);
    }
  };

  const toggleSelected = (asset: AssetSummary) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(asset.id)) next.delete(asset.id);
      else next.add(asset.id);
      return next;
    });
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    void handleFiles(e.dataTransfer.files);
  };

  const body = (
    <>
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="font-heading text-lg font-semibold">Files</h2>
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
            {selectedIds.size > 0 &&
              (armedId === 'bulk' ? (
                <div
                  data-testid="confirm-delete-file-bulk"
                  className="mb-2 flex items-center gap-1 rounded-lg border border-destructive bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
                >
                  <span className="min-w-0 flex-1 truncate">
                    Delete {selectedIds.size} selected? Irreversible.
                  </span>
                  <button
                    type="button"
                    data-testid="confirm-yes"
                    aria-label="Yes, delete selected files"
                    autoFocus
                    disabled={bulkDeleting}
                    onClick={onYes}
                    className="shrink-0 rounded-md px-2 py-1 text-xs font-medium hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    data-testid="confirm-always"
                    aria-label="Always delete files without asking"
                    disabled={bulkDeleting}
                    onClick={() => void onAlways()}
                    className="shrink-0 rounded-md px-2 py-1 text-xs font-medium hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
                  >
                    Always
                  </button>
                  <button
                    type="button"
                    data-testid="confirm-no"
                    aria-label="No, keep the files"
                    disabled={bulkDeleting}
                    onClick={onNo}
                    className="shrink-0 rounded-md px-2 py-1 text-xs font-medium hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
                  >
                    No
                  </button>
                </div>
              ) : (
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{selectedIds.size} selected</span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={bulkDownloading}
                      data-testid="asset-bulk-download"
                      onClick={() => void handleBulkDownload()}
                    >
                      {bulkDownloading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        'Download selected'
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={bulkDeleting}
                      data-testid="asset-bulk-delete"
                      aria-label="Delete selected files"
                      onClick={() => arm('bulk')}
                      className="text-destructive hover:bg-destructive hover:text-destructive-foreground"
                    >
                      {bulkDeleting ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        'Delete selected'
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            <ul className="grid grid-cols-1 gap-2">
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
                    className={cn(
                      'flex items-center gap-3 rounded-lg border border-border bg-msg-assistant px-3 py-2.5',
                      selectedId === asset.id && 'border-primary bg-accent',
                    )}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select ${asset.filename}`}
                      disabled={asset.status !== 'ready'}
                      checked={selectedIds.has(asset.id)}
                      data-testid="asset-select"
                      onChange={() => toggleSelected(asset)}
                      className="size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <IconFor contentType={asset.contentType} filename={asset.filename} />
                    <button
                      type="button"
                      aria-label={`Preview ${asset.filename}`}
                      data-testid={`asset-preview-${asset.id}`}
                      onClick={() => onSelect?.(asset)}
                      className="min-w-0 flex-1 cursor-pointer text-left"
                    >
                      <span className="block truncate text-sm">{asset.filename}</span>
                      <span className="block text-xs text-muted-foreground">
                        {formatSize(asset.size)} · {new Date(asset.createdAt).toLocaleDateString()}
                        {provenanceLabel(asset.provenance?.kind) && (
                          <span data-testid="asset-provenance">
                            {' '}
                            · {provenanceLabel(asset.provenance?.kind)}
                          </span>
                        )}
                        {asset.markdownStatus === 'pending' && (
                          <span data-testid="asset-extracting">
                            {' '}
                            · <Loader2 className="inline size-3 animate-spin align-[-2px]" />{' '}
                            Extracting text…
                          </span>
                        )}
                        {asset.markdownStatus === 'ready' && (
                          <span data-testid="asset-extract-ready"> · Text extracted</span>
                        )}
                        {asset.markdownStatus === 'failed' && (
                          <span
                            data-testid="asset-extract-failed"
                            className="text-destructive"
                            title={asset.markdownFailureReason ?? 'Text extraction failed'}
                          >
                            {' '}
                            · Extraction failed
                          </span>
                        )}
                      </span>
                    </button>
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
        <button
          type="button"
          data-testid="asset-dropzone"
          aria-label="Upload files: drop them here or tap to choose"
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
          className="flex w-full cursor-pointer flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground transition-colors hover:border-primary hover:text-accent-foreground"
        >
          <Upload className="size-4" />
          <span>
            Drag files here, or{' '}
            <span className="text-primary underline underline-offset-2">choose files</span>
          </span>
          <span className="text-xs">Up to 15 MB each · txt, md, csv, json, pdf, images</span>
        </button>
        {uploadRows.length > 0 && (
          <ul className="mt-2 space-y-1" data-testid="upload-rows">
            {uploadRows.map((row, i) => (
              <li key={`${row.name}-${i}`} className="flex flex-col gap-0.5 text-left">
                <span
                  className="flex items-center justify-between gap-2 truncate text-xs"
                  data-testid={`upload-row-${i}`}
                >
                  <span className="truncate">{row.name}</span>
                  <span
                    className={
                      row.status === 'error' ? 'text-destructive' : 'text-muted-foreground'
                    }
                  >
                    {row.status === 'uploading' && `Uploading ${row.progress}%`}
                    {row.status === 'done' && 'Uploaded'}
                    {row.status === 'error' && (row.message ?? 'Upload failed')}
                  </span>
                </span>
                {row.status === 'uploading' && (
                  <progress max={100} value={row.progress} className="h-1 w-full" />
                )}
              </li>
            ))}
          </ul>
        )}
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          aria-hidden
          multiple
          data-testid="asset-input"
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
    </>
  );

  // Issue #197: the `/files` view hosts this list as a plain pane (no modal
  // overlay) beside the preview.
  return (
    <div
      className="flex h-full min-h-0 flex-col border-r border-border panel-surface"
      data-testid="asset-library"
    >
      {body}
    </div>
  );
};

export default AssetLibrary;
