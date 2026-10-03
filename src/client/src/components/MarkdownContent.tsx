import type React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { ExternalLink } from 'lucide-react';

const isExternalHttp = (href?: string): href is string =>
  typeof href === 'string' && /^https?:\/\//i.test(href);

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

// Shared markdown renderer: assistant messages in the chat and the in-app
// asset preview (issue #197) must render identically. Stored markdown can
// contain raw HTML, so rehype-raw is paired with rehype-sanitize.
const MarkdownContent: React.FC<{ content: string; markdown: boolean }> = ({
  content,
  markdown,
}) => {
  if (!markdown) {
    return <div className="min-w-0 break-words">{content}</div>;
  }
  return (
    <div className="markdown-body min-w-0 break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto">
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

export default MarkdownContent;
