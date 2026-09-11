import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { Menu, Send, ThumbsDown, ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Message } from '../App';

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

const MessageContent: React.FC<{ content: string; markdown: boolean }> = ({
  content,
  markdown,
}) => {
  if (!markdown) {
    return <>{content}</>;
  }
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]}>
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
  const [pendingFeedbackId, setPendingFeedbackId] = useState<string | null>(null);

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
        <h1 className="font-heading text-lg font-semibold">Tova</h1>
      </header>
      <div className="flex flex-1 flex-col overflow-y-auto px-3 py-4 md:px-6 md:py-6">
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
          .filter((msg) => !(msg.role === 'assistant' && msg.content.length === 0))
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
                      T
                    </span>
                    Tova
                  </div>
                  <div className="px-4 py-3 md:px-5">
                    <MessageContent content={msg.content} markdown />
                  </div>
                  {msg.modelName && (
                    <div className="mt-1 flex items-center gap-3 px-4 text-xs text-muted-foreground md:px-5">
                      <span>{msg.modelName}</span>
                      {onFeedback && (
                        <span className="flex items-center gap-1">
                          <button
                            type="button"
                            aria-label="Good response"
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
                T
              </span>
              Tova
            </div>
            <div className="flex items-center gap-1.5 px-4 py-3 md:px-5">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="thinking-dot inline-block size-2 rounded-full bg-muted-foreground"
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <footer className="pointer-events-auto shrink-0 border-t border-border bg-background p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:px-6">
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
