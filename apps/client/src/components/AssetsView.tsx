import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, FileText, History, ImageOff, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import AssetLibrary from './AssetLibrary';
import MarkdownContent from './MarkdownContent';
import BackToChatLink from './BackToChatLink';
import AssetService, {
  type AssetContent,
  type AssetSummary,
  type AssetVersionContent,
  type AssetVersionInfo,
} from '@/services/assets';

// Issue #197: the files view moves out of the chat modal to its own URL
// (/files), mirroring /profile and /admin. It is a master/detail: the
// existing library list on the left, a rendered preview of the selected file
// on the right. Text/markdown renders via MarkdownContent; images render a
// derived thumbnail (#208) so the original is never pulled into the pane;
// everything else falls back to its extracted text or the empty state.
// Issue #325: an assistant-generated file with edit history (version > 1)
// gains a History toggle — a version list, a read-only preview of any past
// version, and a restore action.
const isImageAsset = (asset: AssetSummary | null): boolean =>
  Boolean(asset?.contentType?.startsWith('image/'));

// How long between re-reads while the selected asset's worker job is in
// flight (#208 thumbnails, #67 conversions).
const PENDING_POLL_MS = 3000;

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

type ImagePreview =
  { state: 'loading' } | { state: 'pending' } | { state: 'ready'; url: string } | { state: 'none' };

const AssetsView: React.FC = () => {
  const [selected, setSelected] = useState<AssetSummary | null>(null);
  const [content, setContent] = useState<AssetContent | null>(null);
  const [image, setImage] = useState<ImagePreview>({ state: 'loading' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Issue #325: content history state. `versions === null` means not fetched;
  // `viewingVersion` non-null shows that version read-only instead of current.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<AssetVersionInfo[] | null>(null);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [versionContent, setVersionContent] = useState<AssetVersionContent | null>(null);
  const [restoring, setRestoring] = useState(false);
  // Interval handle for re-reading while a worker job is still in flight.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadContent = useCallback(async (asset: AssetSummary) => {
    setLoading(true);
    setError(null);
    setContent(null);
    try {
      if (isImageAsset(asset)) {
        // Images have no extracted body to preview; the derived thumbnail is
        // the preview. The endpoint reports the lifecycle so a pending
        // thumbnail can be polled rather than read as a failure.
        const thumb = await AssetService.thumbnailUrl(asset.id);
        setImage(
          thumb.url
            ? { state: 'ready', url: thumb.url }
            : thumb.status === 'pending'
              ? { state: 'pending' }
              : { state: 'none' },
        );
      } else {
        setImage({ state: 'none' });
        setContent(await AssetService.content(asset.id));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this file');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setImage({ state: 'loading' });
    // A new selection resets any history/version view (#325).
    setHistoryOpen(false);
    setVersions(null);
    setViewingVersion(null);
    setVersionContent(null);

    void loadContent(selected);
  }, [selected, loadContent]);

  // Re-read while the selected asset is still settling: an image thumbnail
  // (#208) or converted markdown (#67) appears in place without the user
  // re-selecting. Suspended while a past version is being previewed (#325).
  useEffect(() => {
    const pending =
      image.state === 'pending' ||
      (content?.content == null &&
        (content?.markdownStatus === 'pending' || selected?.markdownStatus === 'pending'));
    if (!pending || !selected || viewingVersion !== null) return;
    pollTimer.current = setInterval(() => void loadContent(selected), PENDING_POLL_MS);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
    };
  }, [image.state, content, selected, viewingVersion, loadContent]);

  const hasHistory = (selected?.version ?? 1) > 1;

  const toggleHistory = useCallback(async () => {
    if (!selected) return;
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setViewingVersion(null);
    setVersionContent(null);
    setHistoryOpen(true);
    if (versions === null) {
      try {
        setVersions(await AssetService.versions(selected.id));
      } catch {
        toast.error('Could not load version history');
        setVersions([]);
      }
    }
  }, [selected, historyOpen, versions]);

  const openVersion = useCallback(
    async (version: number) => {
      if (!selected) return;
      setHistoryOpen(false);
      setViewingVersion(version);
      setVersionContent(null);
      try {
        setVersionContent(await AssetService.versionContent(selected.id, version));
      } catch {
        toast.error('Could not load that version');
        setViewingVersion(null);
      }
    },
    [selected],
  );

  const backToVersions = useCallback(() => {
    setViewingVersion(null);
    setVersionContent(null);
    setHistoryOpen(true);
  }, []);

  const restoreVersion = useCallback(async () => {
    if (!selected || viewingVersion === null) return;
    setRestoring(true);
    try {
      const restored = await AssetService.restore(selected.id, viewingVersion);
      // Selecting the restored asset re-runs the selection effect, which
      // reloads the content and closes the history view.
      setSelected(restored);
      toast.success('Version restored');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not restore that version');
    } finally {
      setRestoring(false);
    }
  }, [selected, viewingVersion]);

  const imagePlaceholder =
    image.state === 'pending' ? (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Preparing preview…
      </p>
    ) : (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <ImageOff className="size-4" /> (no preview available)
      </p>
    );

  const placeholder = isImageAsset(selected) ? (
    imagePlaceholder
  ) : content?.content != null ? null : content?.markdownStatus === 'failed' ? (
    <p className="text-sm text-destructive">
      Extraction failed
      {content.markdownFailureReason ? `: ${content.markdownFailureReason}` : '.'}
    </p>
  ) : content?.markdownStatus === 'pending' ? (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Extracting text…
    </p>
  ) : (
    <p className="text-sm text-muted-foreground">(no extracted text)</p>
  );

  // Issue #325: the body has three modes — the version list, a read-only past
  // version, or the current content (the pre-#325 behaviour).
  const body = historyOpen ? (
    <div data-testid="assets-history-list">
      <p className="mb-2 text-xs text-muted-foreground">Version history</p>
      {versions === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : (
        <ul className="space-y-1">
          {versions.map((v) => {
            const current = v.version === (selected?.version ?? 1);
            return (
              <li key={v.version}>
                <button
                  type="button"
                  data-testid={`assets-history-item-${v.version}`}
                  onClick={() => void openVersion(v.version)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-accent"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">
                    Version {v.version}
                    {current && <span className="text-muted-foreground"> · Current</span>}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatSize(v.size)} · {new Date(v.createdAt).toLocaleDateString()}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  ) : viewingVersion !== null ? (
    <div data-testid="assets-version-preview">
      <div
        data-testid="assets-version-banner"
        className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-border bg-accent px-3 py-2 text-sm"
      >
        <span className="min-w-0 flex-1 truncate">
          Version {viewingVersion}
          {viewingVersion === (selected?.version ?? 1) ? ' · Current' : ''}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            data-testid="assets-version-back"
            onClick={backToVersions}
            className="rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Back
          </button>
          {viewingVersion !== (selected?.version ?? 1) && (
            <button
              type="button"
              data-testid="assets-version-restore"
              disabled={restoring}
              onClick={() => void restoreVersion()}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {restoring ? 'Restoring…' : 'Restore'}
            </button>
          )}
        </div>
      </div>
      {versionContent === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : versionContent.content == null ? (
        <p className="text-sm text-muted-foreground">(no text in this version)</p>
      ) : (
        <MarkdownContent
          content={versionContent.content}
          markdown={versionContent.format === 'markdown'}
        />
      )}
    </div>
  ) : loading && !(isImageAsset(selected) && image.state === 'ready') ? (
    <p
      className="flex items-center gap-2 text-sm text-muted-foreground"
      data-testid="assets-preview-loading"
    >
      <Loader2 className="size-4 animate-spin" /> Loading…
    </p>
  ) : error ? (
    <p className="text-sm text-destructive" data-testid="assets-preview-error">
      {error}
    </p>
  ) : isImageAsset(selected) && image.state === 'ready' ? (
    <div data-testid="assets-preview-image">
      <img
        src={image.url}
        alt={selected?.filename ?? ''}
        className="mx-auto max-h-full max-w-full rounded-lg border border-border"
      />
    </div>
  ) : placeholder ? (
    <div data-testid="assets-preview-empty">{placeholder}</div>
  ) : (
    <div data-testid="assets-preview-body">
      <MarkdownContent content={content!.content!} markdown={content!.format === 'markdown'} />
    </div>
  );

  return (
    <div
      data-testid="assets-view"
      className="flex h-full w-full flex-col bg-background text-foreground"
    >
      <div className="shrink-0 px-6">
        <div className="flex h-14 items-center">
          <h2 className="font-heading text-xl font-semibold">Files</h2>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
        <div
          className={`min-w-0 shrink-0 overflow-hidden rounded-xl border border-border md:w-96 ${
            selected ? 'hidden md:block' : 'w-full'
          }`}
        >
          <AssetLibrary
            selectedId={selected?.id ?? null}
            onSelect={(asset) => setSelected(asset)}
          />
        </div>
        <div
          className={`min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border panel-surface ${
            selected ? 'flex' : 'hidden md:flex'
          }`}
        >
          {!selected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
              <FileText className="size-6" />
              <p className="text-sm">Select a file to preview it.</p>
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
                <button
                  type="button"
                  data-testid="assets-preview-back"
                  aria-label="Back to file list"
                  onClick={() => setSelected(null)}
                  className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground md:hidden"
                >
                  <ChevronLeft className="size-4" />
                  Back
                </button>
                <span
                  className="min-w-0 flex-1 truncate text-sm font-medium"
                  data-testid="assets-preview-title"
                >
                  {selected.filename}
                </span>
                {hasHistory && (
                  <button
                    type="button"
                    data-testid="assets-history-toggle"
                    aria-pressed={historyOpen}
                    onClick={() => void toggleHistory()}
                    className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                      historyOpen
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <History className="size-3.5" />
                    History
                  </button>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">{body}</div>
            </>
          )}
        </div>
      </div>
      <BackToChatLink />
    </div>
  );
};

export default AssetsView;
