import React, { useCallback, useEffect, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import AssetLibrary from './AssetLibrary';
import MarkdownContent from './MarkdownContent';
import BackToChatLink from './BackToChatLink';
import AssetService, { type AssetContent, type AssetSummary } from '@/services/assets';

// Issue #197: the assets view moves out of the chat modal to its own URL
// (/assets), mirroring /profile and /admin. It is a master/detail: the
// existing library list on the left, a rendered Markdown/text preview of the
// selected file on the right. Image preview and OCR are split into separate
// tickets (see docs/plan-197-asset-viewer.md).
const AssetsView: React.FC = () => {
  const [selected, setSelected] = useState<AssetSummary | null>(null);
  const [content, setContent] = useState<AssetContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadContent = useCallback(async (asset: AssetSummary) => {
    setLoading(true);
    setError(null);
    setContent(null);
    try {
      setContent(await AssetService.content(asset.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this file');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadContent(selected);
  }, [selected, loadContent]);

  const placeholder =
    content?.content != null ? null : content?.markdownStatus === 'failed' ? (
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
        <div className="w-96 min-w-0 shrink-0 overflow-hidden rounded-xl border border-border">
          <AssetLibrary
            embedded
            selectedId={selected?.id ?? null}
            onSelect={(asset) => setSelected(asset)}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border panel-surface">
          {!selected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
              <FileText className="size-6" />
              <p className="text-sm">Select a file to preview it.</p>
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
                <span
                  className="min-w-0 truncate text-sm font-medium"
                  data-testid="assets-preview-title"
                >
                  {selected.filename}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {loading ? (
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
                ) : placeholder ? (
                  <div data-testid="assets-preview-empty">{placeholder}</div>
                ) : (
                  <div data-testid="assets-preview-body">
                    <MarkdownContent
                      content={content!.content!}
                      markdown={content!.format === 'markdown'}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <BackToChatLink />
    </div>
  );
};

export default AssetsView;
