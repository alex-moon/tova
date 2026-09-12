import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import {
  Check,
  ChevronDown,
  ExternalLink,
  Menu,
  Send,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Message, ToolEvent } from '../App';

interface ChatWindowProps {
  messages: Message[];
  onSendMessage: (content: string) => void;
  isLoading: boolean;
  onOpenSidebar: () => void;
  onFeedback?: (messageId: string, value: 'up' | 'down' | null) => void;
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

const isExternalHttp = (href?: string): href is string =>
  typeof href === 'string' && /^https?:\/\//i.test(href);

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// Outgoing link override (issue #33): https/email targets open in a new tab
// with noopener; the schema stays the default rehype-sanitize one because
// the override runs post-sanitize.
const MarkdownLink = ({ href, children }: { href?: string; children?: React.ReactNode }) => {
  if (!isExternalHttp(href)) return <a href={href}>{children}</a>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 hover:text-primary-hover"
    >
      {children}
      <ExternalLink size={12} className="ml-0.5 inline-block align-baseline" aria-hidden />
    </a>
  );
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
      className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-2 hover:text-primary-hover hover:underline"
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
      <span className="truncate">{title || url}</span>
    </a>
  </li>
);

const SourcesBlock: React.FC<{ message: Message }> = ({ message }) => {
  const titles = message.sourceTitles ?? [];
  const urls = message.sources ?? [];
  if (urls.length === 0) return null;
  return (
    <div data-testid="sources-block" className="mt-2 px-4 text-muted-foreground md:px-5">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide">Sources</div>
      <ul className="space-y-1">
        {urls.map((url) => (
          <SourceItem
            key={url}
            url={url}
            title={titles.find((t) => t.url === url)?.title}
          />
        ))}
      </ul>
    </div>
  );
};

// Tool feedback chip (#33): spinner → check / warning with a compact result
// summary. Detail toggle exposes the query and result domains. Stateless —
// the tool events arrive in order while streaming.
const detailText = (event: ToolEvent): string | null =>
  event.phase === 'result'
    ? [
        event.resultCount != null ? `${event.resultCount} result(s)` : null,
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
          {event.phase === 'result' && event.resultCount != null ? ` — ${event.resultCount} results` : ''}
        </span>
        {detail && <ChevronDown size={12} aria-hidden />}
      </button>
      {open && detail && (
        <span data-testid="tool-detail" className="ml-1.5 self-center text-xs text-muted-foreground">
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
    <div className="mb-2 flex flex-wrap gap-2" data-testid="suggestion-chips">
      {suggestions.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className="rounded-full border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-primary"
        >
          {s}
        </button>
      ))}
    </div>
  ) : null;

const MessageContent: React.FC<{ content: string; markdown: boolean }> = ({
  content,
  markdown,
}) => {
  if (!markdown) {
    return <>{content}</>;
  }
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={{ a: MarkdownLink }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};

const ChatWindow: React.FC<ChatWindowProps> = ({
  messages,
  onSendMessage,
  isLoading,
  onOpenSidebar,
  onFeedback,
}) => {
  const [input, setInput] = useState('');
  const [placeholder] = useState(pickPlaceholder);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  // Follow-to-bottom: pinned while the user sits at (or near) the bottom;
  // scrolling up releases the pin, sending/deltas restore it (#33 item 3).
  const pinnedRef = React.useRef(true);
  const [pendingFeedbackId, setPendingFeedbackId] = useState<string | null>(null);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distance < 64;
  };

  React.useEffect(() => {
    if (pinnedRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
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
      onSendMessage(input);
      setInput('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
  };

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
      <div ref={scrollRef} onScroll={handleScroll} className="flex flex-1 flex-col overflow-y-auto px-3 py-4 md:px-6 md:py-6">
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
                  className="rounded-full border border-border bg-muted px-3.5 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-primary"
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
                <div className="mb-4 max-w-[92%] self-start rounded-lg rounded-bl-sm border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive md:mb-6 md:max-w-[85%] md:px-4 md:py-3">
                  {msg.content}
                </div>
              ) : msg.role === 'user' ? (
                <div className="mb-4 flex flex-col items-end md:mb-6">
                  <div className="max-w-[92%] rounded-lg rounded-br-sm border border-primary/25 bg-msg-user px-4 py-3 md:max-w-[85%] md:px-5 md:py-4">
                    <MessageContent content={msg.content} markdown={false} />
                  </div>
                </div>
              ) : (
                <div className="mb-6 max-w-[92%] md:mb-8 md:max-w-[85%]">
                  <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                      <img src="/tova-logo.png" alt="Tova" className="size-5 rounded-full" />
                    </span>
                    Tova
                  </div>
                  <div className="px-4 py-3 md:px-5">
                    <ToolChips message={msg} />
                    <MessageContent content={msg.content || EMPTY_RESPONSE_PLACEHOLDER} markdown />
                  </div>
                  {msg.sources && msg.sources.length > 0 && <SourcesBlock message={msg} />}
                  {msg.modelName && (
                    <div className="mt-1 flex items-center gap-3 px-4 text-xs text-muted-foreground md:px-5">
                      <span>{msg.modelName}</span>
                      {onFeedback && (
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
            {pendingTools.length > 0 && <div className="px-4 pt-2 md:px-5">{<ToolChips message={{ tools: pendingTools } as Message} />}</div>}
          </div>
        )}
      </div>
      <footer className="pointer-events-auto shrink-0 border-t border-border bg-background p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:px-6">
        {!isLoading && followups.length > 0 && (
          <FollowupChips suggestions={followups} onPick={(value) => setInput(value)} />
        )}
        <form onSubmit={handleSubmit}>
          <div className="relative rounded-lg border border-border bg-msg-assistant px-3 py-2 shadow-sm">
            <textarea
              ref={textareaRef}
              className="block max-h-[40dvh] w-full resize-none overflow-y-auto bg-transparent pr-20 text-base outline-none placeholder:text-muted-foreground"
              rows={2}
              placeholder={placeholder}
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
            />
            <Button
              type="submit"
              size="sm"
              className="absolute bottom-2 right-2 h-8"
              disabled={isLoading || !input.trim()}
            >
              <Send />
              Send
            </Button>
          </div>
        </form>
      </footer>
    </section>
  );
};

export default ChatWindow;
