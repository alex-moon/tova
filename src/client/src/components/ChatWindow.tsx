import { useContext } from 'react';
import React, { useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  FileImage,
  Loader2,
  Menu,
  Paperclip,
  Send,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react';
import MarkdownContent from './MarkdownContent';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import AssetService from '@/services/assets';
// Tolerant context read (not the throwing useAuth hook): standalone renders
// of ChatWindow (tests, storybook-style usage) have no AuthProvider.
import { AuthContext } from '../context/AuthContext';
import type { Message, ToolEvent } from '../App';

interface ChatWindowProps {
  messages: Message[];
  onSendMessage: (content: string, assetId?: string, assetFilename?: string) => void;
  isLoading: boolean;
  onOpenSidebar: () => void;
  // Active persisted chat id (null on a new chat); the incognito toggle is
  // only available before a chat's first submission.
  sessionId?: string | null;
  // Per-chat incognito (#144): App owns the toggle state; the composer
  // controls it before a new chat's first submission. Standalone
  // renders (tests) fall back to the account default.
  incognito?: boolean;
  onToggleIncognito?: (value: boolean) => void;
  onFeedback?: (messageId: string, value: 'up' | 'down' | null) => void;
  incomingAsset?: {
    id: string;
    filename: string;
    contentType?: string;
    hasText: boolean;
    markdownStatus?: string;
  } | null;
  onPickedConsumed?: () => void;
}

const PLACEHOLDERS = [
  'Write me a short Python script to organise my Google Calendar',
  'Summarise this article into five bullet points',
  'Suggest a week of easy dinners with a shared shopping list',
  'Draft a friendly reply to a client asking for a status update',
  'Explain DNS like I have five minutes before a meeting',
  'Help me break down a big project into smaller tasks',
  'Turn these meeting notes into action items',
  'Review this email and make it more concise',
  'Come up with 10 ideas for a kids birthday party',
  'Write a SQL query to find duplicate orders',
];

const EXAMPLE_CHIPS = [
  'Summarise this article into five bullet points',
  'Suggest a week of easy dinners',
  'Explain DNS in plain English',
];

const pickPlaceholder = () => PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];

// An assistant message this old means the provider returned no content;
// show a placeholder in the UI instead of dropping the turn (#4 J).
const EMPTY_RESPONSE_PLACEHOLDER = '(no content returned)';

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// Sources footer block (#33): compact list of the URLs the search returned,
// labelled with captured page titles where available and hostnames otherwise.
// Favicons come from the public s2 service (third-party request, accepted in
// the issue); a failed load simply hides the image.
const SourceItem: React.FC<{ url: string; title?: string }> = ({ url, title }) => (
  <li>
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-center gap-1.5 text-sm text-primary underline-offset-2 hover:text-primary-hover hover:underline"
    >
      <img
        src={`https://www.google.com/s2/favicons?domain=${hostOf(url)}&sz=32`}
        alt=""
        aria-hidden
        className="inline-block size-4 shrink-0 rounded-sm"
        onError={(e) => {
          e.currentTarget.style.display = 'none';
        }}
      />
      <span className="max-w-48 truncate whitespace-nowrap">{title || url}</span>
    </a>
  </li>
);

// Sources collapse (#41): lists longer than COLLAPSED_SOURCES_COUNT render
// only the first entries plus a "show all" toggle. State is per-message and
// intentionally not persisted — "collapsed by default" on every load.
const COLLAPSED_SOURCES_COUNT = 3;

const SourcesBlock: React.FC<{ message: Message }> = ({ message }) => {
  const [expanded, setExpanded] = useState(false);
  const titles = message.sourceTitles ?? [];
  const urls = message.sources ?? [];
  if (urls.length === 0) return null;
  const collapsed = !expanded && urls.length > COLLAPSED_SOURCES_COUNT;
  const visibleUrls = collapsed ? urls.slice(0, COLLAPSED_SOURCES_COUNT) : urls;
  return (
    <div data-testid="sources-block" className="mt-2 px-4 text-muted-foreground md:px-5">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide">Sources</div>
      <ul className="space-y-1">
        {visibleUrls.map((url) => (
          <SourceItem key={url} url={url} title={titles.find((t) => t.url === url)?.title} />
        ))}
      </ul>
      {collapsed ? (
        <button
          type="button"
          data-testid="sources-show-all"
          onClick={() => setExpanded(true)}
          className="mt-1 shrink-0 text-xs underline hover:text-foreground"
        >
          Show all {urls.length} sources
        </button>
      ) : expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1 shrink-0 text-xs underline hover:text-foreground"
        >
          Show fewer sources
        </button>
      ) : null}
    </div>
  );
};

// Tool feedback chip (#33): spinner → check / warning with a compact result
// summary. Detail toggle exposes the query and result domains. Stateless —
// the tool events arrive in order while streaming.
// Issue #114: a zero count is only meaningful for tools whose output IS a
// results list (web_search, list_files). Legacy persisted events from other
// tools carried the old universal `resultCount: 0` artifact — suppress its
// display there instead of migrating stored data.
const countDisplay = (event: ToolEvent): number | null => {
  if (event.resultCount == null) return null;
  const showZero = event.name === 'web_search' || event.name === 'list_files';
  return event.resultCount === 0 && !showZero ? null : event.resultCount;
};

const detailText = (event: ToolEvent): string | null =>
  event.phase === 'result'
    ? [
        countDisplay(event) != null ? `${countDisplay(event)} result(s)` : null,
        ...(event.domains ?? []),
      ]
        .filter(Boolean)
        .join(' · ')
    : event.query
      ? `Query: ${event.query}`
      : null;

const ToolChip: React.FC<{ event: ToolEvent }> = ({ event }) => {
  const [open, setOpen] = useState(false);
  const running = event.phase === 'call';
  const ok = event.status === 'ok';
  const detail = detailText(event);
  return (
    <div data-testid={`tool-chip-${event.name}`} className="mb-2 inline-flex">
      <button
        type="button"
        onClick={() => detail && setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary"
      >
        {running ? (
          <span className="thinking-dot inline-block size-3 rounded-full border-2 border-muted-foreground border-t-transparent" />
        ) : (
          <Check size={12} aria-hidden className={ok ? 'text-success' : 'text-warning'} />
        )}
        <span className="truncate">
          {event.label}
          {event.query ? ` “${event.query}”` : ''}
          {event.phase === 'result' && countDisplay(event) != null
            ? ` — ${countDisplay(event)} results`
            : ''}
        </span>
        {detail && <ChevronDown size={12} aria-hidden />}
      </button>
      {open && detail && (
        <span
          data-testid="tool-detail"
          className="ml-1.5 self-center text-xs text-muted-foreground"
        >
          {detail}
        </span>
      )}
    </div>
  );
};

const ToolChips: React.FC<{ message: Message }> = ({ message }) =>
  message.tools?.length ? (
    <div className="mb-2 flex flex-wrap gap-1.5" data-testid="tool-chips">
      {message.tools.map((event, i) => (
        <ToolChip key={`${event.phase}-${event.name}-${i}`} event={event} />
      ))}
    </div>
  ) : null;

const FollowupChips: React.FC<{ suggestions: string[]; onPick: (value: string) => void }> = ({
  suggestions,
  onPick,
}) =>
  suggestions.length > 0 ? (
    <div className="mb-2 flex flex-nowrap gap-2 overflow-x-auto" data-testid="suggestion-chips">
      {suggestions.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className="shrink-0 whitespace-nowrap rounded-full border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-primary"
        >
          {s}
        </button>
      ))}
    </div>
  ) : null;

const ChatWindow: React.FC<ChatWindowProps> = ({
  messages,
  onSendMessage,
  isLoading,
  onOpenSidebar,
  sessionId,
  incognito: incognitoProp,
  onToggleIncognito,
  onFeedback,
  incomingAsset,
  onPickedConsumed,
}) => {
  const auth = useContext(AuthContext);
  // Per-chat incognito (#144): a controlled value from App when present,
  // else the account default; the toggle can only move a *new* chat.
  const incognito = incognitoProp ?? Boolean(auth?.user?.incognitoByDefault ?? auth?.user?.zdr);
  const [input, setInput] = useState('');
  const [placeholder] = useState(pickPlaceholder);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // Attached file (issue #34): a single asset per message; uploaded
  // immediately on selection (presign → direct PUT → confirm) and referenced
  // by id when the message is sent.
  const [attachment, setAttachment] = useState<{
    id: string;
    filename: string;
    contentType?: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  // Follow-to-bottom: pinned while the user sits at (or near) the bottom;
  // scrolling up releases the pin, sending/deltas restore it (#33 item 3).
  const pinnedRef = React.useRef(true);
  const [pendingFeedbackId, setPendingFeedbackId] = useState<string | null>(null);
  // Issue #200: raw Markdown copy. The transient "copied" state is keyed by
  // message id; one timer ref so a rapid re-copy can't leave a stale timer.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopyMessage = async (msg: Message) => {
    // Copy the raw Markdown source; never the rendered HTML or the
    // empty-response placeholder.
    if (!msg.content) return;
    if (!navigator.clipboard?.writeText) {
      toast.error('Copy not supported');
      return;
    }
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopiedId(msg._id);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedId(null), 1500);
    } catch {
      toast.error('Could not copy');
    }
  };

  React.useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  // Issue #51: byte-identical toast for both attach paths (fresh upload and
  // library pick) — a shared helper so the copy can't drift.
  const toastNoText = () =>
    toast.info('No text could be extracted from this file type — Tova will see the filename only.');

  // Issue #115: images are first-class now (they attach as real image parts
  // to the model), so the no-text toast is for genuinely unrewarded file
  // types only — judged by content type, never the filename extension.
  const isImageAttachment = (asset: { contentType?: string }): boolean =>
    typeof asset.contentType === 'string' && asset.contentType.startsWith('image/');

  // Issue #83: a pending conversion is a legitimate wait state, not a
  // textless file — word it as such instead of firing the false-negative
  // no-text toast. Only reached when `hasText` is already false.
  const toastForAsset = (asset: { contentType?: string; markdownStatus?: string }) => {
    if (isImageAttachment(asset)) return;
    if (asset.markdownStatus === 'pending')
      toast.info('Still extracting text — try attaching again shortly.');
    else toastNoText();
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distance < 64;
  };

  React.useEffect(() => {
    if (pinnedRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages, isLoading]);

  // Contextual follow-ups: the last assistant message carrying generated
  // suggestions (#33 item 7). Absent on first load or after generation
  // failures — the composer keeps its static placeholder then.
  const followups = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.suggestions?.length) return msg.suggestions;
      if (msg.role === 'user') break;
    }
    return [];
  }, [messages]);

  // Tool events of the in-flight optimistic placeholder (ids 'stream-…'):
  // while its content is still empty the dots render, and the chips need the
  // detached events to show the search round (#33 tool feedback).
  const pendingTools = React.useMemo(
    () =>
      messages
        .filter((m) => m.role === 'assistant' && m.content === '' && m.tools?.length)
        .flatMap((m) => m.tools ?? []),
    [messages],
  );

  const handleThumbClick = (msg: Message, value: 'up' | 'down') => {
    if (!onFeedback || pendingFeedbackId) return;
    // Clicking the active thumb clears the vote (unvote); the other one
    // overwrites it. Re-enabled only after the round trip resolves.
    const next: 'up' | 'down' | null = msg.feedback?.value === value ? null : value;
    setPendingFeedbackId(msg._id);
    Promise.resolve(onFeedback(msg._id, next)).finally(() => setPendingFeedbackId(null));
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
    el.scrollTop = el.scrollHeight;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isLoading) {
      pinnedRef.current = true;
      onSendMessage(input, attachment?.id, attachment?.filename);
      setInput('');
      setAttachment(null);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
  };

  const handleAttachFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || uploading) return;
    setUploading(true);
    try {
      // Issue #116/#144: composer uploads are always tagged 'chat' — the
      // server turns that tag into throwaway (ephemeral) uploads when the
      // effective per-chat incognito flag says so. The composer tells the
      // server which chat the upload belongs to (stored flag decides for an
      // existing chat) or what the toggle currently says (a new chat's
      // upload must precede session creation).
      const asset =
        sessionId !== undefined && sessionId !== null
          ? await AssetService.upload(file, undefined, 'chat', { chatId: sessionId })
          : await AssetService.upload(file, undefined, 'chat', { zdr: Boolean(incognito) });
      setAttachment({
        id: asset.id,
        filename: asset.filename,
        // #115: the image chip needs the content type to show the right icon.
        contentType: asset.contentType,
      });
      if (!asset.hasText) toastForAsset(asset);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  // Library pick (issue #51): the pick carries { id, filename, hasText }; it
  // becomes the same in-memory attachment shape as a fresh upload. The pick is
  // consumed exactly once (so re-picking the same asset re-triggers later). If
  // an upload is in flight, the pick is consumed without applying — the
  // in-flight upload wins and would otherwise silently overwrite the pick.
  React.useEffect(() => {
    if (!incomingAsset) return;
    if (!uploading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAttachment({
        id: incomingAsset.id,
        filename: incomingAsset.filename,
        contentType: incomingAsset.contentType,
      });
      if (!incomingAsset.hasText) toastForAsset(incomingAsset);
    }
    onPickedConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingAsset]);

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
        <Button variant="ghost" size="icon" aria-label="Open menu" onClick={onOpenSidebar}>
          <Menu />
        </Button>
        <div className="flex items-center gap-1.5">
          <img src="/tova-logo.png" alt="" className="size-7" />
          <h1 className="font-heading text-lg font-semibold">Tova</h1>
        </div>
      </header>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-3 py-4 md:px-6 md:py-6 ambient-wash recessed-frame"
      >
        {messages.length === 0 && !isLoading && (
          <div className="animate-message-in mx-auto my-auto max-w-full text-center">
            <h1 className="font-heading text-3xl font-semibold text-foreground md:text-4xl">
              How can I help you today?
            </h1>
            <p className="mt-2 text-muted-foreground">
              Ask anything — pick one below or type your own.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {EXAMPLE_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => {
                    setInput(chip);
                    if (textareaRef.current) textareaRef.current.focus();
                  }}
                  className="rounded-full border border-border bg-muted px-3.5 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-primary edge-glow"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages
          .filter(
            (msg) =>
              !(
                msg.role === 'assistant' &&
                msg.content.length === 0 &&
                // In-flight optimistic placeholder bubbles (ids 'stream-…')
                // are rendered as thinking dots during streaming; persisted
                // empty messages stay visible with the placeholder below.
                isLoading &&
                msg._id.startsWith('stream-')
              ),
          )
          .map((msg) => (
            <div key={msg._id} className="animate-message-in">
              {msg.isError ? (
                <div className="mb-4 max-w-[92%] min-w-0 self-start rounded-lg rounded-bl-sm border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm break-words text-destructive md:mb-6 md:max-w-[85%] md:px-4 md:py-3">
                  {msg.content}
                </div>
              ) : msg.role === 'user' ? (
                <div className="mb-4 flex min-w-0 flex-col items-end md:mb-6">
                  {msg.assetFilename && (
                    <span
                      className="mb-1 inline-flex max-w-[92%] min-w-0 items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      data-testid="message-attachment-chip"
                    >
                      <Paperclip className="size-3" aria-hidden />
                      <span className="truncate">{msg.assetFilename ?? 'Attached file'}</span>
                    </span>
                  )}
                  <div className="max-w-[92%] min-w-0 rounded-lg rounded-br-sm border border-primary/25 bg-msg-user px-4 py-3 break-words md:max-w-[85%] md:px-5 md:py-4">
                    <MarkdownContent content={msg.content} markdown={false} />
                  </div>
                  <div className="mt-1 flex justify-end px-1">
                    <button
                      type="button"
                      aria-label="Copy message as Markdown"
                      onClick={() => void handleCopyMessage(msg)}
                      className="rounded p-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      {copiedId === msg._id ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mb-6 min-w-0 max-w-[92%] md:mb-8 md:max-w-[85%]">
                  <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                      <img src="/tova-logo.png" alt="Tova" className="size-5 rounded-full" />
                    </span>
                    Tova
                  </div>
                  <div className="px-4 py-3 md:px-5">
                    <ToolChips message={msg} />
                    <MarkdownContent content={msg.content || EMPTY_RESPONSE_PLACEHOLDER} markdown />
                  </div>
                  {msg.sources && msg.sources.length > 0 && <SourcesBlock message={msg} />}
                  {(msg.modelName || msg.content) && (
                    <div className="mt-1 flex items-center gap-3 px-4 text-xs text-muted-foreground md:px-5">
                      {msg.modelName && (
                        <span>
                          {msg.provider && msg.modelName
                            ? `${msg.provider} · ${msg.modelName}`
                            : msg.modelName}
                        </span>
                      )}
                      {msg.content && (
                        <button
                          type="button"
                          aria-label="Copy message as Markdown"
                          onClick={() => void handleCopyMessage(msg)}
                          className="rounded p-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                        >
                          {copiedId === msg._id ? <Check size={13} /> : <Copy size={13} />}
                        </button>
                      )}
                      {onFeedback && msg.modelName && (
                        <span className="flex items-center gap-1">
                          <button
                            type="button"
                            aria-label="Good response"
                            aria-pressed={msg.feedback?.value === 'up'}
                            disabled={pendingFeedbackId !== null}
                            onClick={() => handleThumbClick(msg, 'up')}
                            className="rounded p-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
                          >
                            <ThumbsUp
                              size={13}
                              className={msg.feedback?.value === 'up' ? 'text-primary' : undefined}
                            />
                          </button>
                          <button
                            type="button"
                            aria-label="Poor response"
                            aria-pressed={msg.feedback?.value === 'down'}
                            disabled={pendingFeedbackId !== null}
                            onClick={() => handleThumbClick(msg, 'down')}
                            className="rounded p-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
                          >
                            <ThumbsDown
                              size={13}
                              className={
                                msg.feedback?.value === 'down' ? 'text-primary' : undefined
                              }
                            />
                          </button>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        {isLoading && messages.some((m) => m.role === 'assistant' && m.content === '') && (
          <div className="animate-message-in mb-6 self-start md:mb-8">
            <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                <img src="/tova-logo.png" alt="Tova" className="size-5 rounded-full" />
              </span>
              Tova
            </div>
            <div className="flex items-center gap-1.5 px-4 py-3 md:px-5 pt-2 pb-0">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="thinking-dot inline-block size-2 rounded-full bg-muted-foreground"
                />
              ))}
            </div>
            {pendingTools.length > 0 && (
              <div className="px-4 pt-2 md:px-5">
                {<ToolChips message={{ tools: pendingTools } as Message} />}
              </div>
            )}
          </div>
        )}
      </div>
      <footer className="pointer-events-auto shrink-0 border-t border-border panel-surface p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:px-6">
        {!isLoading && followups.length > 0 && (
          <FollowupChips suggestions={followups} onPick={(value) => setInput(value)} />
        )}
        <form onSubmit={handleSubmit}>
          <div className="relative rounded-lg border border-border px-3 py-2 shadow-sm edge-glow-strong panel-surface">
            {attachment && (
              <div
                className="mb-1.5 flex items-center gap-2 rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs text-muted-foreground"
                data-testid="attachment-chip"
              >
                {isImageAttachment(attachment) ? (
                  <FileImage className="size-3.5 shrink-0" aria-hidden />
                ) : (
                  <Paperclip className="size-3.5 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
                <button
                  type="button"
                  aria-label={`Remove attachment ${attachment.filename}`}
                  onClick={() => setAttachment(null)}
                  className="rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
            <textarea
              ref={textareaRef}
              className="block max-h-[40dvh] w-full resize-none overflow-y-auto bg-transparent pr-24 text-base outline-none placeholder:text-muted-foreground"
              rows={2}
              placeholder={messages.some((m) => m.role === 'user') ? '' : placeholder}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoGrow(e.target);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (input.trim() && !isLoading) handleSubmit(e as unknown as React.FormEvent);
                }
              }}
              disabled={isLoading}
              data-testid="chat-input"
            />
            <div className="absolute bottom-2 right-2 flex items-center gap-1">
              {/* Per-chat incognito (#144): visible before the first
                  submission of a new chat only — the flag is fixed at
                  creation and the server 409s any later switch attempt. */}
              {!sessionId && messages.length === 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Incognito chat"
                  aria-pressed={incognito}
                  title="Incognito: nothing sent or attached in this chat is stored"
                  onClick={() => onToggleIncognito?.(!incognito)}
                  disabled={isLoading}
                  data-testid="chat-incognito-toggle"
                  className={`h-8 w-8 ${
                    incognito ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {incognito ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                aria-hidden
                onChange={(e) => {
                  void handleAttachFile(e.target.files);
                  e.target.value = '';
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Attach a file"
                title="Attach a file"
                disabled={isLoading || uploading}
                onClick={() => fileInputRef.current?.click()}
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
              >
                {uploading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Paperclip className="size-4" />
                )}
              </Button>
              <Button
                type="submit"
                size="sm"
                className="h-8"
                disabled={isLoading || !input.trim()}
                data-testid="chat-send"
              >
                <Send />
                Send
              </Button>
            </div>
          </div>
        </form>
        <p className="mt-2 text-center text-xs text-muted-foreground" data-testid="privacy-note">
          Your chats and files are never used to train models — by anyone, ever.
          {!sessionId && incognito
            ? ' Incognito is on for this chat: nothing sent or attached is stored.'
            : ''}
        </p>
      </footer>
    </section>
  );
};

export default ChatWindow;
