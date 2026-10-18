import { useContext } from 'react';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  FileImage,
  FileText,
  HelpCircle,
  ListTree,
  Loader2,
  Menu,
  Paperclip,
  Send,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import MarkdownContent from './MarkdownContent';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import AssetService, { type AssetSummary } from '@/services/assets';
import CapabilityService, { type Capabilities } from '@/services/capabilities';
import TaskCard from './TaskCard';
// Tolerant context read: standalone renders (tests) have no AuthProvider.
import { AuthContext } from '../context/AuthContext';
import type { Message, ToolEvent } from '../App';

interface ChatWindowProps {
  messages: Message[];
  onSendMessage: (content: string, assetId?: string, assetFilename?: string) => void;
  // Hand composer text to the worker instead of a chat turn; never ZDR.
  // @see #255
  onSendToWorker?: (content: string) => void;
  // Bumped when a task is created so the embedded card refetches immediately.
  // @see #255
  taskRefreshSignal?: number;
  isLoading: boolean;
  onOpenSidebar: () => void;
  // Null on a new chat; the toggle is only available before first submission.
  sessionId?: string | null;
  // App owns the toggle state; standalone renders fall back to the default.
  // @see #144
  incognito?: boolean;
  onToggleIncognito?: (value: boolean) => void;
  onFeedback?: (messageId: string, value: 'up' | 'down' | null) => void;
  // Null on a new chat → the header shows the brand as before.
  // @see #359
  sessionTitle?: string | null;
  sessionSubtitle?: string | null;
  onRenameSession?: (title: string) => void | Promise<void>;
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

// Placeholder, not a dropped turn, when the provider returned nothing.
// @see #4
const EMPTY_RESPONSE_PLACEHOLDER = '(no content returned)';

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// Source list: page titles where available, hostnames otherwise.
// @see #33
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

// Not persisted — sources collapse by default on every load.
// @see #41
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

// Zero is only meaningful for list-producing tools; legacy zeros suppressed.
// @see #33 #114
const countDisplay = (event: ToolEvent): number | null => {
  if (event.resultCount == null) return null;
  const showZero = event.name === 'web_search' || event.name === 'list_files';
  return event.resultCount === 0 && !showZero ? null : event.resultCount;
};

// How the tool was used, not the chip label; null when nothing extra.
// @see #196
const detailText = (event: ToolEvent): string | null =>
  event.phase === 'result'
    ? [
        event.query ? `Query: ${event.query}` : null,
        event.status === 'empty' ? 'No results' : null,
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

// Collapsed "Used N tools" line; auto-expands while streaming.
// @see #196
const ToolSummary: React.FC<{ tools: ToolEvent[]; streaming?: boolean }> = ({
  tools,
  streaming = false,
}) => {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  if (tools.length === 0) return null;
  const open = userToggled ?? streaming;
  // Unresolved calls keep a spinner so a running tool doesn't look frozen.
  // @see #389
  const running = streaming && tools.some((t) => t.phase === 'call');
  return (
    <div className="mb-2 text-xs text-muted-foreground" data-testid="tool-summary">
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          onClick={() => setUserToggled(!open)}
          aria-expanded={open}
          data-testid="tool-summary-toggle"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary"
        >
          <ChevronDown
            size={12}
            aria-hidden
            className={`transition-transform ${open ? 'rotate-180' : ''}`}
          />
          <span>
            Used {tools.length} {tools.length === 1 ? 'tool' : 'tools'}
          </span>
        </button>
        {running && <Loader2 size={13} aria-hidden className="animate-spin" />}
      </span>
      {open && (
        <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="tool-chips">
          {tools.map((event, i) => (
            <ToolChip key={`${event.phase}-${event.name}-${i}`} event={event} />
          ))}
        </div>
      )}
    </div>
  );
};

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

// Two-line header: user-owned title over a system subtitle; keyed by session.
// @see #359
const SessionHeaderTitle: React.FC<{
  title: string;
  subtitle?: string | null;
  onRename?: (title: string) => void | Promise<void>;
}> = ({ title, subtitle, onRename }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title) void onRename?.(trimmed);
  };
  if (editing) {
    return (
      <input
        data-testid="chat-title-input"
        autoFocus
        value={draft}
        aria-label="Chat title"
        className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1 text-sm"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={commit}
      />
    );
  }
  return (
    <button
      type="button"
      data-testid="chat-title"
      title="Rename chat"
      onClick={() => {
        setDraft(title);
        setEditing(true);
      }}
      className="block w-full min-w-0 cursor-text rounded-md text-left focus-visible:outline-2 focus-visible:outline-primary"
    >
      <span className="block truncate font-heading text-sm font-semibold leading-tight">
        {title}
      </span>
      {subtitle && (
        <span
          data-testid="chat-subtitle"
          className="block truncate text-xs font-normal leading-tight text-muted-foreground"
        >
          {subtitle}
        </span>
      )}
    </button>
  );
};

// Source of truth for capability state; never inferred from agent prose.
// @see #366
const CapabilitiesPanel: React.FC = () => {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    CapabilityService.get()
      .then((data) => {
        if (!cancelled) setCaps(data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (error) {
    return (
      <p data-testid="capabilities-error" className="px-1 py-2 text-xs text-muted-foreground">
        Could not load capabilities.
      </p>
    );
  }
  if (!caps) {
    return (
      <p data-testid="capabilities-loading" className="px-1 py-2 text-xs text-muted-foreground">
        Loading…
      </p>
    );
  }
  return (
    <div
      data-testid="capabilities-panel"
      className="mb-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs"
    >
      <div className="mb-1.5 font-medium uppercase tracking-wide text-muted-foreground">
        Built in
      </div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {caps.tools.map((tool) => (
          <span
            key={tool.name}
            data-testid={`capability-${tool.name}`}
            title={
              tool.status === 'unconfigured' ? 'Needs a search key on this deployment' : undefined
            }
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
              tool.status === 'ready'
                ? 'border-border bg-background text-foreground'
                : 'border-warning/40 bg-warning/10 text-warning'
            }`}
          >
            {tool.status === 'ready' ? (
              <Check size={11} aria-hidden className="text-success" />
            ) : (
              <TriangleAlert size={11} aria-hidden />
            )}
            {tool.label}
          </span>
        ))}
      </div>
      <div className="mb-1.5 font-medium uppercase tracking-wide text-muted-foreground">
        Connected tools
      </div>
      {caps.connectors.length === 0 ? (
        <p className="text-muted-foreground">
          None yet — connect a tool collection in{' '}
          <a href="/connectors" className="underline hover:text-foreground">
            /connectors
          </a>
          .
        </p>
      ) : (
        <div className="space-y-1.5">
          {caps.connectors.map((connector) => (
            <div key={connector.name} data-testid={`capability-connector-${connector.name}`}>
              <span className="font-medium">{connector.name}</span>
              <span className="text-muted-foreground">
                {' '}
                · {connector.tools.map((t) => t.name).join(', ')} — ask Tova to use one and it will
                find it (needs a tool search first)
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Bottom-sheet on phones, dialog on desktop; Escape/overlay click close it.
// @see #388
const PrivacyModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="presentation"
    >
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Privacy and capabilities"
        data-testid="privacy-modal"
        className="relative max-h-[85dvh] w-full overflow-y-auto rounded-t-lg border border-border panel-surface shadow-xl pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:max-w-lg sm:rounded-lg sm:pb-0"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border panel-surface px-4 py-3 backdrop-blur-sm">
          <h3 className="font-heading text-sm font-semibold">Privacy &amp; capabilities</h3>
          <button
            type="button"
            aria-label="Close"
            data-testid="privacy-modal-close"
            onClick={onClose}
            className="rounded p-1 transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-4 px-4 py-4 text-xs text-muted-foreground sm:px-5">
          <section data-testid="privacy-training-note">
            <h4 className="mb-1 text-sm font-medium text-foreground">
              Your data is never used to train models — by anyone, ever.
            </h4>
            <ul className="list-disc space-y-1 pl-4">
              <li>
                Chat is routed only to zero-data-retention (ZDR) providers, so prompts and replies
                are not retained on their side.
              </li>
              <li>
                Traces and logs (LangSmith, Grafana) are redacted before they leave the server —
                prompt sizes are recorded, not your conversation content.
              </li>
              <li>
                It does <em className="text-foreground">not</em> mean your chats are never stored:
                chats and uploaded files are stored because the product needs them — history,
                workspace memory, reranking. Delete any chat from the sidebar, or everything at once
                via factory reset in /profile.
              </li>
            </ul>
          </section>
          <section>
            <h4 className="mb-1 text-sm font-medium text-foreground">Incognito</h4>
            <p>
              Nothing sent or attached in an incognito chat is stored — it vanishes when the
              conversation ends. That is why incognito is limited: with nothing stored, there is no
              workspace memory to read or write, no follow-up suggestions and no background tasks,
              because all of those rely on saved conversation turns. Files uploaded in Assets are
              kept so you can reuse them; they are deleted only when you delete them.
            </p>
          </section>
          <section>
            <h4 className="mb-1 text-sm font-medium text-foreground">Factory reset</h4>
            <p>
              Permanently wipes every chat, message, uploaded file and derived trace for this
              account. Nothing survives. Find it in /profile under Danger zone.
            </p>
          </section>
          <section>
            <h4 className="mb-1 text-sm font-medium text-foreground">What Tova can use</h4>
            <CapabilitiesPanel />
          </section>
        </div>
      </div>
    </div>
  );
};

const ChatWindow: React.FC<ChatWindowProps> = ({
  messages,
  onSendMessage,
  onSendToWorker,
  taskRefreshSignal,
  isLoading,
  onOpenSidebar,
  sessionId,
  incognito: incognitoProp,
  onToggleIncognito,
  onFeedback,
  sessionTitle,
  sessionSubtitle,
  onRenameSession,
}) => {
  const auth = useContext(AuthContext);
  // Controlled from App when present, else the account default.
  // @see #144
  const incognito = incognitoProp ?? Boolean(auth?.user?.incognitoByDefault ?? auth?.user?.zdr);
  const [input, setInput] = useState('');
  const [placeholder] = useState(pickPlaceholder);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // The paperclip opens a popover with Upload plus the five recent files.
  // @see #214
  const attachMenuRef = React.useRef<HTMLDivElement>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [recentAssets, setRecentAssets] = useState<AssetSummary[] | null>(null);
  const [recentError, setRecentError] = useState(false);
  const [recentLoading, setRecentLoading] = useState(false);
  // One asset per message, uploaded on selection, referenced by id on send.
  // @see #34
  const [attachment, setAttachment] = useState<{
    id: string;
    filename: string;
    contentType?: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  // Pinned while at the bottom; scrolling up releases, sending/deltas restore.
  // @see #33
  const pinnedRef = React.useRef(true);
  // Capabilities open the privacy modal (? in the composer); lazily fetched.
  // @see #366 #388
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [pendingFeedbackId, setPendingFeedbackId] = useState<string | null>(null);
  // Raw Markdown copy; one timer ref so a rapid re-copy can't go stale.
  // @see #200
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopyMessage = async (msg: Message) => {
    // Copy the raw Markdown source, never rendered HTML or the placeholder.
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

  // Shared so the no-text toast copy can't drift between attach paths.
  // @see #51
  const toastNoText = () =>
    toast.info('No text could be extracted from this file type — Tova will see the filename only.');

  // The no-text toast is for unrewarded types, judged by content type only.
  // @see #115
  const isImageAttachment = (asset: { contentType?: string }): boolean =>
    typeof asset.contentType === 'string' && asset.contentType.startsWith('image/');

  // A pending conversion is a legitimate wait state, not a textless file.
  // @see #83
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

  // Absent on first load or after failures; the composer keeps a placeholder.
  // @see #33
  const followups = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.suggestions?.length) return msg.suggestions;
      if (msg.role === 'user') break;
    }
    return [];
  }, [messages]);

  // The streaming dots' message has no body; chips need detached events.
  // @see #33
  const pendingTools = React.useMemo(
    () =>
      messages
        .filter((m) => m.role === 'assistant' && m.content === '' && m.tools?.length)
        .flatMap((m) => m.tools ?? []),
    [messages],
  );

  const handleThumbClick = (msg: Message, value: 'up' | 'down') => {
    if (!onFeedback || pendingFeedbackId) return;
    // Active thumb unvotes, the other overwrites; re-enabled after round trip.
    const next: 'up' | 'down' | null = msg.feedback?.value === value ? null : value;
    setPendingFeedbackId(msg._id);
    Promise.resolve(onFeedback(msg._id, next)).finally(() => setPendingFeedbackId(null));
  };

  // Resend the flagged turn's user message verbatim; server injects the note.
  // @see #371
  const retryForReal = (msg: Message) => {
    if (isLoading) return;
    const idx = messages.findIndex((m) => m._id === msg._id);
    for (let i = idx - 1; i >= 0; i -= 1) {
      const prior = messages[i];
      if (prior.role === 'user' && prior.content) {
        onSendMessage(prior.content);
        return;
      }
    }
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

  // Same composer state as a send, but the turn never enters the stream.
  // @see #255
  const handleSendToWorker = () => {
    if (!input.trim() || isLoading || !onSendToWorker) return;
    onSendToWorker(input);
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleAttachFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || uploading) return;
    setUploading(true);
    try {
      // Uploads are tagged 'chat' so the server can make them ephemeral.
      // @see #116 #144
      const asset =
        sessionId !== undefined && sessionId !== null
          ? await AssetService.upload(file, undefined, 'chat', { chatId: sessionId })
          : await AssetService.upload(file, undefined, 'chat', { zdr: Boolean(incognito) });
      setAttachment({
        id: asset.id,
        filename: asset.filename,
        // The image chip needs the content type to show the right icon.
        // @see #115
        contentType: asset.contentType,
      });
      if (!asset.hasText) toastForAsset(asset);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  // Fetch once on first open, then cached for the page's lifetime.
  // @see #214
  const loadRecentAssets = useCallback(async () => {
    setRecentLoading(true);
    setRecentError(false);
    try {
      const page = await AssetService.list();
      setRecentAssets(page.assets.slice(0, 5));
    } catch {
      setRecentError(true);
    } finally {
      setRecentLoading(false);
    }
  }, []);

  const openAttachMenu = () => {
    setAttachMenuOpen(true);
    if (recentAssets === null && !recentLoading) void loadRecentAssets();
  };

  // Bound only while the menu is open; closed composers add no listeners.
  useEffect(() => {
    if (!attachMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!attachMenuRef.current?.contains(e.target as Node)) setAttachMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAttachMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [attachMenuOpen]);

  // Reuses the fresh-upload shape and the same toast; the menu closes on pick.
  // @see #51
  const pickRecentAsset = (asset: AssetSummary) => {
    setAttachment({
      id: asset.id,
      filename: asset.filename,
      contentType: asset.contentType,
    });
    if (!asset.hasText) toastForAsset(asset);
    setAttachMenuOpen(false);
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
        <Button variant="ghost" size="icon" aria-label="Open menu" onClick={onOpenSidebar}>
          <Menu />
        </Button>
        {sessionTitle ? (
          /* min-w-0 + truncate keeps the two lines inside a 375px row. */
          // @see #359
          <SessionHeaderTitle
            key={sessionId ?? 'chat'}
            title={sessionTitle}
            subtitle={sessionSubtitle}
            onRename={onRenameSession}
          />
        ) : (
          <div className="flex items-center gap-1.5">
            <img src="/tova-logo.png" alt="" className="size-7" />
            <h1 className="font-heading text-lg font-semibold">Tova</h1>
          </div>
        )}
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
                // In-flight stream placeholders render as thinking dots.
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
                    {/* While tools are unresolved the summary rides below the streaming text so incoming content can't scroll it off-screen; settled turns render it above. */}
                    {/* @see #389 */}
                    {(() => {
                      const streamingTools =
                        isLoading && (msg.tools ?? []).some((t) => t.phase === 'call');
                      const summary = (
                        <ToolSummary tools={msg.tools ?? []} streaming={streamingTools} />
                      );
                      return streamingTools ? (
                        <>
                          <MarkdownContent
                            content={msg.content || EMPTY_RESPONSE_PLACEHOLDER}
                            markdown
                          />
                          {summary}
                        </>
                      ) : (
                        <>
                          {summary}
                          <MarkdownContent
                            content={msg.content || EMPTY_RESPONSE_PLACEHOLDER}
                            markdown
                          />
                        </>
                      );
                    })()}
                  </div>
                  {msg.honesty?.flagged && (
                    <div
                      data-testid="honesty-flag"
                      className="mx-4 mt-1 flex flex-wrap items-center gap-2 md:mx-5"
                    >
                      <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning">
                        <TriangleAlert size={12} aria-hidden />
                        Described actions it didn’t perform
                      </span>
                      {!isLoading && (
                        <button
                          type="button"
                          data-testid="honesty-retry"
                          onClick={() => retryForReal(msg)}
                          className="text-xs text-warning underline underline-offset-2 hover:text-foreground"
                        >
                          Retry for real
                        </button>
                      )}
                    </div>
                  )}
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
                <ToolSummary tools={pendingTools} streaming />
              </div>
            )}
          </div>
        )}
      </div>
      <footer className="pointer-events-auto shrink-0 border-t border-border panel-surface p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:px-6">
        {sessionId && <TaskCard sessionId={sessionId} refreshSignal={taskRefreshSignal} />}
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
              className="block max-h-[40dvh] w-full resize-none overflow-y-auto bg-transparent text-base outline-none placeholder:text-muted-foreground"
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
            {!sessionId && incognito && (
              <p data-testid="privacy-note" className="mt-1 text-xs text-muted-foreground">
                Incognito is on for this chat: nothing sent or attached is stored.
              </p>
            )}
            {/* Icon band below the text: textarea and controls can never overlap. */}
            {/* @see #388 */}
            <div className="mt-1.5 flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Privacy and capabilities"
                title="Privacy & capabilities: what Tova stores and can do"
                onClick={() => setCapabilitiesOpen(true)}
                data-testid="capabilities-toggle"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
              >
                <HelpCircle className="size-4" />
              </Button>
              {/* Visible before a new chat's first submission only — the flag is fixed at creation and the server 409s later switches. */}
              {/* @see #144 */}
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
              {/* Popover with Upload plus recent library files, so an already-uploaded file can be referenced without re-uploading. */}
              {/* @see #214 */}
              <div ref={attachMenuRef} className="relative ml-auto">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Attach a file"
                  aria-haspopup="menu"
                  aria-expanded={attachMenuOpen}
                  title="Attach a file"
                  disabled={isLoading || uploading}
                  onClick={() => (attachMenuOpen ? setAttachMenuOpen(false) : openAttachMenu())}
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                >
                  {uploading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Paperclip className="size-4" />
                  )}
                </Button>
                {attachMenuOpen && (
                  <div
                    role="menu"
                    data-testid="attach-menu"
                    className="absolute bottom-10 right-0 z-20 w-60 overflow-hidden rounded-lg border border-border panel-surface shadow-lg"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="attach-menu-upload"
                      onClick={() => {
                        setAttachMenuOpen(false);
                        fileInputRef.current?.click();
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Upload className="size-4 shrink-0" aria-hidden />
                      Upload a file
                    </button>
                    <div className="border-t border-border" />
                    <div className="px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Recent files
                    </div>
                    {recentLoading ? (
                      <p
                        className="flex items-center gap-2 px-3 pb-2 text-sm text-muted-foreground"
                        data-testid="attach-menu-loading"
                      >
                        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading…
                      </p>
                    ) : recentError ? (
                      <p
                        className="px-3 pb-2 text-sm text-muted-foreground"
                        data-testid="attach-menu-error"
                      >
                        Could not load your files.
                      </p>
                    ) : recentAssets && recentAssets.length > 0 ? (
                      recentAssets.map((asset) => (
                        <button
                          key={asset.id}
                          type="button"
                          role="menuitem"
                          data-testid="attach-menu-item"
                          onClick={() => pickRecentAsset(asset)}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-foreground"
                        >
                          {isImageAttachment(asset) ? (
                            <FileImage className="size-4 shrink-0" aria-hidden />
                          ) : (
                            <FileText className="size-4 shrink-0" aria-hidden />
                          )}
                          <span className="min-w-0 flex-1 truncate">{asset.filename}</span>
                        </button>
                      ))
                    ) : (
                      <p
                        className="px-3 pb-2 text-sm text-muted-foreground"
                        data-testid="attach-menu-empty"
                      >
                        No files yet.
                      </p>
                    )}
                  </div>
                )}
              </div>
              {/* Send to the background worker instead of the chat; a task needs an origin session, and persistence is what ZDR forbids. */}
              {/* @see #255 */}
              {sessionId && !incognito && onSendToWorker && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Send to background worker"
                  title="Run this as a background task"
                  disabled={isLoading || !input.trim()}
                  onClick={handleSendToWorker}
                  data-testid="chat-send-to-worker"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                >
                  <ListTree className="size-4" />
                </Button>
              )}
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
      </footer>
      {capabilitiesOpen && <PrivacyModal onClose={() => setCapabilitiesOpen(false)} />}
    </section>
  );
};

export default ChatWindow;
