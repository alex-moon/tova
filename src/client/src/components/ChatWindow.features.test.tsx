import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ChatWindow from './ChatWindow';
import type { Message } from '../App';

const base = (over: Partial<Message> = {}): Message => ({
  _id: 'm1',
  role: 'assistant',
  content: 'the answer',
  modelName: 'test-model',
  ...over,
});

const renderChat = (messages: Message[], isLoading = false) =>
  render(
    <ChatWindow
      messages={messages}
      onSendMessage={vi.fn()}
      isLoading={isLoading}
      onOpenSidebar={vi.fn()}
    />,
  );

describe('Tool chip (issue #33)', () => {
  afterEach(cleanup);

  it('shows a running chip with the query while a tool call is in flight', () => {
    const msg = base({
      tools: [
        { phase: 'call', name: 'web_search', label: 'Searched the web', query: 'groq pricing' },
      ],
    });
    renderChat([msg]);
    const chip = screen.getByTestId('tool-chip-web_search');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent('Searched the web');
    expect(chip).toHaveTextContent('groq pricing');
  });

  it('resolves to a success state with a result summary once the round completes', () => {
    const messages: Message[] = [
      {
        _id: 'm1',
        role: 'assistant',
        content: 'answer',
        tools: [
          { phase: 'call', name: 'web_search', label: 'Searched the web', query: 'groq pricing' },
          {
            phase: 'result',
            name: 'web_search',
            label: 'Searched the web',
            status: 'ok',
            resultCount: 5,
            domains: ['groq.com'],
          },
        ],
      },
    ];
    renderChat(messages);
    const chips = screen.getAllByTestId('tool-chip-web_search');
    expect(chips[1]).toHaveTextContent('5 results');
  });

  it('reveals the result detail on click', () => {
    const messages: Message[] = [
      {
        _id: 'm1',
        role: 'assistant',
        content: 'answer',
        tools: [
          {
            phase: 'result',
            name: 'web_search',
            label: 'Searched the web',
            status: 'ok',
            resultCount: 5,
            domains: ['groq.com'],
          },
        ],
      },
    ];
    renderChat(messages);
    expect(screen.queryByTestId('tool-detail')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tool-chip-web_search').querySelector('button')!);
    expect(screen.getByTestId('tool-detail')).toHaveTextContent('5 result(s) · groq.com');
    expect(screen.getByTestId('tool-detail')).toHaveTextContent('groq.com');
  });
});

describe('Message content links (issue #33)', () => {
  afterEach(cleanup);

  it('renders external https links with target=_blank and noopener', () => {
    renderChat([
      {
        _id: 'm1',
        role: 'assistant',
        content: 'See [docs](https://groq.com/docs) for details.',
      },
    ]);
    const link = document.querySelector('.markdown-body a');
    expect(link).toBeInTheDocument();
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
  });

  it('renders a Sources block with titles when sources exist', () => {
    renderChat([
      {
        _id: 'm1',
        role: 'assistant',
        content: 'answer',
        sources: ['https://a.example.com', 'https://b.example.com'],
        sourceTitles: [{ url: 'https://a.example.com', title: 'A page' }],
      },
    ]);
    const block = screen.getByTestId('sources-block');
    expect(screen.getByText('Sources')).toBeInTheDocument();
    const links = block.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('https://a.example.com');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0]).toHaveTextContent('A page');
    expect(links[1]).toHaveTextContent('b.example.com');
  });

  it('omits the Sources block when there are no sources', () => {
    renderChat([{ _id: 'm1', role: 'assistant', content: 'answer' }]);
    expect(screen.queryByTestId('sources-block')).not.toBeInTheDocument();
  });

  it('collapses sources beyond 3 with a show-all button (issue #41)', () => {
    const urls = [
      'https://1.example.com',
      'https://2.example.com',
      'https://3.example.com',
      'https://4.example.com',
      'https://5.example.com',
    ];
    renderChat([base({ sources: urls })]);
    const block = screen.getByTestId('sources-block');
    const links = block.querySelectorAll('a');
    expect(links).toHaveLength(3);
    expect(screen.getByTestId('sources-show-all')).toHaveTextContent('Show all 5 sources');
  });

  it('expands to the full list and collapses back (issue #41)', () => {
    const urls = [
      'https://1.example.com',
      'https://2.example.com',
      'https://3.example.com',
      'https://4.example.com',
    ];
    renderChat([base({ sources: urls })]);
    fireEvent.click(screen.getByTestId('sources-show-all'));
    let links = screen.getByTestId('sources-block').querySelectorAll('a');
    expect(links).toHaveLength(4);
    fireEvent.click(screen.getByText('Show fewer sources'));
    links = screen.getByTestId('sources-block').querySelectorAll('a');
    expect(links).toHaveLength(3);
    expect(screen.getByTestId('sources-show-all')).toBeInTheDocument();
  });

  it('shows the full list with no button at exactly 3 sources (issue #41)', () => {
    renderChat([
      base({
        sources: ['https://a.example.com', 'https://b.example.com', 'https://c.example.com'],
      }),
    ]);
    expect(screen.getByTestId('sources-block').querySelectorAll('a')).toHaveLength(3);
    expect(screen.queryByTestId('sources-show-all')).not.toBeInTheDocument();
  });
});

describe('Follow-up suggestions (issue #33)', () => {
  afterEach(cleanup);

  it('renders suggestion chips after a completed turn and fills the composer on click', () => {
    renderChat([
      { _id: 'u1', role: 'user', content: 'question' },
      {
        _id: 'm1',
        role: 'assistant',
        content: 'answer',
        suggestions: ['What about pricing?', 'Show an example'],
      },
    ]);
    const chips = screen.getAllByTestId('suggestion-chips')[0];
    fireEvent.click(chips.querySelectorAll('button')[0]);
    const input = document.querySelector('textarea');
    expect(input?.value).toBe('What about pricing?');
  });

  it('does not render chips without suggestion data', () => {
    renderChat([{ _id: 'm1', role: 'assistant', content: 'plain answer' }]);
    expect(screen.queryByTestId('suggestion-chips')).not.toBeInTheDocument();
  });
});
