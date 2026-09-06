import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Message } from '../App';

interface ChatWindowProps {
  messages: Message[];
  onSendMessage: (content: string) => void;
  isLoading: boolean;
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
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
};

const ChatWindow: React.FC<ChatWindowProps> = ({ messages, onSendMessage, isLoading }) => {
  const [input, setInput] = useState('');
  const [placeholder] = useState(pickPlaceholder);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

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
    <section className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 flex-col overflow-y-auto px-6 py-6">
        {messages.length === 0 && !isLoading && (
          <div className="mx-auto my-auto text-center">
            <h1 className="text-3xl font-bold text-muted-foreground">How can I help you today?</h1>
          </div>
        )}
        {messages
          .filter((msg) => !(msg.role === 'assistant' && msg.content.length === 0))
          .map((msg) => (
            <div
              key={msg._id}
              className={
                msg.isError
                  ? 'mb-6 max-w-[85%] self-start rounded-lg rounded-bl-sm border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive'
                  : msg.role === 'user'
                    ? 'mb-6 max-w-[85%] self-end rounded-lg rounded-br-sm bg-msg-user px-5 py-4'
                    : 'mb-8 w-full self-stretch'
              }
            >
              {msg.isError ? (
                <div>{msg.content}</div>
              ) : (
                <MessageContent content={msg.content} markdown={msg.role === 'assistant'} />
              )}
              <div className="mt-2 text-xs opacity-50">
                {msg.modelName && `Model: ${msg.modelName}`}
              </div>
            </div>
          ))}
        {isLoading && messages.some((m) => m.role === 'assistant' && m.content === '') && (
          <div className="mb-6 max-w-[85%] self-start rounded-lg rounded-bl-sm border border-border bg-msg-assistant px-5 py-4 opacity-70">
            Thinking...
          </div>
        )}
      </div>
      <footer className="pointer-events-none relative h-28 shrink-0">
        <form
          className="pointer-events-auto absolute bottom-0 left-0 right-0 p-4"
          onSubmit={handleSubmit}
        >
          <div className="relative rounded-lg border border-border bg-msg-assistant px-3 py-2 shadow-sm">
            <textarea
              ref={textareaRef}
              className="block max-h-[40vh] w-full resize-none overflow-y-auto bg-transparent pr-24 text-base outline-none placeholder:text-muted-foreground"
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
