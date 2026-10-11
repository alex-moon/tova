import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

vi.mock('../services/assets', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/assets')>();
  return {
    ...original,
    default: { ...original.default, list: vi.fn(), upload: vi.fn() },
  };
});

// #255: the embedded TaskCard mounts with a sessionId and calls the task
// service; mock it so these feature tests never touch axios.
vi.mock('../services/tasks', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/tasks')>();
  return {
    ...original,
    default: {
      list: vi.fn(),
      listForSession: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      get: vi.fn(),
      instruct: vi.fn(),
      cancel: vi.fn(),
    },
  };
});

import ChatWindow from './ChatWindow';
import AssetService from '../services/assets';
import type { AssetSummary } from '../services/assets';
import type { Message, ToolEvent } from '../App';

const mockAsset = (over: Partial<AssetSummary> = {}): AssetSummary => ({
  id: 'a1',
  filename: 'notes.txt',
  contentType: 'text/plain',
  size: 12,
  status: 'ready',
  hasText: true,
  createdAt: new Date().toISOString(),
  ...over,
});

const base = (over: Partial<Message> = {}): Message => ({
  _id: 'm1',
  role: 'assistant',
  content: 'the answer',
  modelName: 'test-model',
  ...over,
});

const renderChat = (
  messages: Message[],
  isLoading = false,
  extra: Partial<ComponentProps<typeof ChatWindow>> = {},
) =>
  render(
    <ChatWindow
      messages={messages}
      onSendMessage={vi.fn()}
      isLoading={isLoading}
      onOpenSidebar={vi.fn()}
      {...extra}
    />,
  );

// Settled turns collapse the summary box (#196, D5); tests that assert on the
// individual chips must expand it first. The streaming case auto-expands.
const expandTools = () => fireEvent.click(screen.getByTestId('tool-summary-toggle'));

describe('Tool chip (issue #33)', () => {
  afterEach(cleanup);

  it('shows a running chip with the query while a tool call is in flight', () => {
    const msg = base({
      tools: [
        { phase: 'call', name: 'web_search', label: 'Searched the web', query: 'groq pricing' },
      ],
    });
    renderChat([msg]);
    expandTools();
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
    expandTools();
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
    expandTools();
    expect(screen.queryByTestId('tool-detail')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tool-chip-web_search').querySelector('button')!);
    expect(screen.getByTestId('tool-detail')).toHaveTextContent('5 result(s) · groq.com');
    expect(screen.getByTestId('tool-detail')).toHaveTextContent('groq.com');
  });
});

describe('Tool-use summary box (issue #196)', () => {
  afterEach(cleanup);

  it('collapses chips behind a "Used N tools" line on a settled turn', () => {
    renderChat([
      base({
        tools: [{ phase: 'result', name: 'web_search', label: 'Searched the web', status: 'ok' }],
      }),
    ]);
    const summary = screen.getByTestId('tool-summary');
    expect(summary).toHaveTextContent('Used 1 tool');
    expect(screen.queryByTestId('tool-chips')).not.toBeInTheDocument();
    expandTools();
    expect(screen.getByTestId('tool-chips')).toBeInTheDocument();
    expect(screen.getByTestId('tool-chip-web_search')).toBeInTheDocument();
  });

  it('pluralises the count and auto-expands while streaming', () => {
    renderChat(
      [
        base({
          _id: 'stream-1',
          content: '',
          tools: [
            { phase: 'result', name: 'web_search', label: 'Searched the web', status: 'ok' },
            { phase: 'call', name: 'fetch_url', label: 'Read a page', query: 'example.com' },
          ],
        }),
      ],
      true,
    );
    expect(screen.getByTestId('tool-summary')).toHaveTextContent('Used 2 tools');
    // streaming ⇒ open without a click
    expect(screen.getByTestId('tool-chips')).toBeInTheDocument();
  });

  it('renders no summary box when the turn used no tools', () => {
    renderChat([base({ tools: undefined })]);
    expect(screen.queryByTestId('tool-summary')).not.toBeInTheDocument();
  });

  it('shows the carried query and status in a resolved chip detail (#196, D4)', () => {
    renderChat([
      base({
        tools: [
          {
            phase: 'result',
            name: 'web_search',
            label: 'Searched the web',
            query: 'groq pricing',
            status: 'empty',
            resultCount: 0,
          },
        ],
      }),
    ]);
    expandTools();
    fireEvent.click(screen.getByTestId('tool-chip-web_search').querySelector('button')!);
    const detail = screen.getByTestId('tool-detail');
    expect(detail).toHaveTextContent('Query: groq pricing');
    expect(detail).toHaveTextContent('No results');
  });
});

describe('Tool chip result counts (issue #114)', () => {
  afterEach(cleanup);

  const resultMessage = (tools: ToolEvent[]): Message[] => [
    { _id: 'm1', role: 'assistant', content: 'answer', tools },
  ];

  it('shows the file count for list_files results', () => {
    renderChat(
      resultMessage([
        {
          phase: 'result',
          name: 'list_files',
          label: 'Listed your files',
          status: 'ok',
          resultCount: 3,
        },
      ]),
    );
    expandTools();
    expect(screen.getByTestId('tool-chip-list_files')).toHaveTextContent('3 results');
  });

  it('shows no results text when the event carries no count', () => {
    renderChat(
      resultMessage([{ phase: 'result', name: 'read_file', label: 'Read a file', status: 'ok' }]),
    );
    expandTools();
    expect(screen.getByTestId('tool-chip-read_file')).not.toHaveTextContent('results');
  });

  it('suppresses the legacy resultCount 0 artifact on unknown tools', () => {
    renderChat(
      resultMessage([
        {
          phase: 'result',
          name: 'list_repositories',
          label: 'Listed repositories',
          status: 'ok',
          resultCount: 0,
        },
      ]),
    );
    expandTools();
    expect(screen.getByTestId('tool-chip-list_repositories')).not.toHaveTextContent('results');
  });

  it('keeps a real 0 visible for web_search', () => {
    renderChat(
      resultMessage([
        {
          phase: 'result',
          name: 'web_search',
          label: 'Searched the web',
          status: 'empty',
          resultCount: 0,
        },
      ]),
    );
    expandTools();
    expect(screen.getByTestId('tool-chip-web_search')).toHaveTextContent('0 results');
  });
});

describe('Fenced code blocks (issue #167)', () => {
  afterEach(cleanup);

  it('renders a fenced code block as pre > code inside markdown-body', () => {
    renderChat([
      {
        _id: 'm1',
        role: 'assistant',
        content: 'before\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nafter',
      },
    ]);
    const pre = document.querySelector('.markdown-body pre');
    expect(pre).toBeInTheDocument();
    expect(pre?.querySelector('code')).toBeInTheDocument();
    expect(pre?.textContent).toContain('const a = 1;');
  });
});

describe('Wide markdown tables (issue #197)', () => {
  afterEach(cleanup);

  it('wraps a GFM table in a horizontal scroll container', () => {
    renderChat([
      {
        _id: 'm1',
        role: 'assistant',
        content: '| A | B |\n| --- | --- |\n| 1 | 2 |',
      },
    ]);
    const table = document.querySelector('.markdown-body table');
    expect(table).toBeInTheDocument();
    // The table's parent scrolls, so the table never widens the chat column.
    expect(table?.parentElement).toHaveClass('overflow-x-auto');
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

describe('Horizontal overflow (issue #118)', () => {
  afterEach(cleanup);

  const overflow = (el: Element) => /overflow-x-auto|overflow-x-hidden/.test(el.className);

  it('scrolls the chat container horizontally only via overflow-x-hidden', () => {
    renderChat([base()]);
    const scroller = document.querySelector('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(overflow(scroller!)).toBe(true);
    expect(scroller!.className).toContain('overflow-x-hidden');
  });

  it('expands the sources block vertically (issue #127 reverts #118 for sources)', () => {
    renderChat([base({ sources: ['https://a.example.com', 'https://b.example.com'] })]);
    const ul = screen.getByTestId('sources-block').querySelector('ul')!;
    expect(ul.className).toContain('space-y-1');
    expect(ul.className).not.toContain('overflow-x');
    expect(ul.className).not.toContain('flex');
    for (const li of ul.querySelectorAll('li')) {
      expect(li.className).not.toContain('shrink-0');
    }
    for (const span of ul.querySelectorAll('span')) {
      expect(span.className).toContain('truncate');
    }
  });

  it('renders follow-up chips as one non-wrapping scrollable row', () => {
    renderChat([
      { _id: 'u1', role: 'user', content: 'question' },
      { _id: 'm1', role: 'assistant', content: 'answer', suggestions: ['a', 'b'] },
    ]);
    const chips = screen.getAllByTestId('suggestion-chips')[0];
    expect(chips.className).toContain('flex-nowrap');
    expect(overflow(chips)).toBe(true);
    for (const btn of chips.querySelectorAll('button')) {
      expect(btn.className).toContain('shrink-0');
    }
  });

  it('truncates a long attachment filename inside the user bubble', () => {
    renderChat([
      {
        _id: 'u1',
        role: 'user',
        content: 'question',
        assetFilename: 'a'.repeat(300) + '.png',
      },
    ]);
    const chip = screen.getByTestId('message-attachment-chip');
    expect(chip.className).toContain('max-w-[92%]');
    expect(chip.querySelector('span')!.className).toContain('truncate');
  });
});

describe('Composer placeholder (issue #41)', () => {
  afterEach(cleanup);

  it('shows a placeholder on a fresh session with no user messages', () => {
    renderChat([]);
    const textarea = document.querySelector('textarea');
    expect(textarea?.getAttribute('placeholder')).toBeTruthy();
  });

  it('hides the placeholder once the user has sent at least one message', () => {
    renderChat([{ _id: 'u1', role: 'user', content: 'hello' }]);
    expect(document.querySelector('textarea')?.getAttribute('placeholder')).toBe('');
  });

  it('uses a non-empty placeholder that disappears once a user message exists', () => {
    const { rerender } = renderChat([base()]);
    const textarea = document.querySelector('textarea')!;
    expect(textarea.getAttribute('placeholder')).toBeTruthy();
    rerender(
      <ChatWindow
        messages={[{ _id: 'u1', role: 'user', content: 'hello' }, base()]}
        onSendMessage={vi.fn()}
        isLoading={false}
        onOpenSidebar={vi.fn()}
      />,
    );
    expect(textarea.getAttribute('placeholder')).toBe('');
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

describe('Composer incognito toggle (issue #144)', () => {
  afterEach(cleanup);

  it('renders next to attach before first submission and toggles', () => {
    const onToggle = vi.fn();
    renderChat([], false, { incognito: false, onToggleIncognito: onToggle });
    const toggle = screen.getByTestId('chat-incognito-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('disappears once a message exists or a session is active', () => {
    const onToggle = vi.fn();
    const view = renderChat([], false, { incognito: false, onToggleIncognito: onToggle });
    view.rerender(
      <ChatWindow
        messages={[base()]}
        onSendMessage={vi.fn()}
        isLoading={false}
        onOpenSidebar={vi.fn()}
        sessionId={null}
        incognito={false}
        onToggleIncognito={onToggle}
      />,
    );
    expect(screen.queryByTestId('chat-incognito-toggle')).not.toBeInTheDocument();
    view.rerender(
      <ChatWindow
        messages={[]}
        onSendMessage={vi.fn()}
        isLoading={false}
        onOpenSidebar={vi.fn()}
        sessionId="abc"
        incognito={false}
        onToggleIncognito={onToggle}
      />,
    );
    expect(screen.queryByTestId('chat-incognito-toggle')).not.toBeInTheDocument();
  });
});

describe('Composer attach menu (issue #214)', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(AssetService.list).mockReset();
  });

  const openMenu = () => {
    fireEvent.click(screen.getByLabelText('Attach a file'));
    return screen.getByTestId('attach-menu');
  };

  it('does not open the menu until the paperclip is clicked', () => {
    renderChat([]);
    expect(screen.queryByTestId('attach-menu')).not.toBeInTheDocument();
  });

  it('lazily lists the five most recent files with Upload on top', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: Array.from({ length: 6 }, (_, i) =>
        mockAsset({ id: `a${i}`, filename: `file-${i}.txt` }),
      ),
      nextCursor: null,
    });
    renderChat([]);
    // No fetch on render — only when the menu opens.
    expect(AssetService.list).not.toHaveBeenCalled();
    openMenu();
    await waitFor(() => expect(screen.getAllByTestId('attach-menu-item')).toHaveLength(5));
    expect(screen.getByTestId('attach-menu-upload')).toBeInTheDocument();
    expect(AssetService.list).toHaveBeenCalledTimes(1);
    expect(screen.getByText('file-0.txt')).toBeInTheDocument();
    expect(screen.queryByText('file-5.txt')).not.toBeInTheDocument();
  });

  it('caches the recent list across open/close', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [mockAsset()], nextCursor: null });
    renderChat([]);
    openMenu();
    await waitFor(() => expect(screen.getByTestId('attach-menu-item')).toBeInTheDocument());
    fireEvent.mouseDown(document.body);
    openMenu();
    await waitFor(() => expect(screen.getByTestId('attach-menu-item')).toBeInTheDocument());
    expect(AssetService.list).toHaveBeenCalledTimes(1);
  });

  it('picks a recent file into the attachment chip and closes', async () => {
    vi.mocked(AssetService.list).mockResolvedValue({
      assets: [mockAsset({ id: 'img', filename: 'photo.png', contentType: 'image/png' })],
      nextCursor: null,
    });
    renderChat([]);
    openMenu();
    await waitFor(() => expect(screen.getByTestId('attach-menu-item')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('attach-menu-item'));
    expect(screen.queryByTestId('attach-menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('attachment-chip')).toHaveTextContent('photo.png');
  });

  it('keeps Upload usable when the recent fetch fails', async () => {
    vi.mocked(AssetService.list).mockRejectedValue(new Error('nope'));
    renderChat([]);
    openMenu();
    await waitFor(() => expect(screen.getByTestId('attach-menu-error')).toBeInTheDocument());
    expect(screen.getByTestId('attach-menu-upload')).toBeInTheDocument();
  });

  it('closes on Escape and on an outside pointer-down', () => {
    vi.mocked(AssetService.list).mockResolvedValue({ assets: [], nextCursor: null });
    renderChat([]);
    openMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('attach-menu')).not.toBeInTheDocument();
    openMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('attach-menu')).not.toBeInTheDocument();
  });
});

describe('Send to worker (#255)', () => {
  afterEach(cleanup);

  const renderWithWorker = (extra: Partial<ComponentProps<typeof ChatWindow>> = {}) =>
    renderChat([], false, { sessionId: 's1', onSendToWorker: vi.fn(), ...extra });

  it('offers the worker button on a persisted, non-incognito chat', () => {
    renderWithWorker();
    expect(screen.getByTestId('chat-send-to-worker')).toBeInTheDocument();
  });

  it('hides the worker button on a new chat (no session id)', () => {
    renderChat([], false, { sessionId: null, onSendToWorker: vi.fn() });
    expect(screen.queryByTestId('chat-send-to-worker')).toBeNull();
  });

  it('hides the worker button on an incognito chat', () => {
    renderWithWorker({ incognito: true });
    expect(screen.queryByTestId('chat-send-to-worker')).toBeNull();
  });

  it('is disabled until there is text, then hands the text to the worker and clears it', async () => {
    const onSendToWorker = vi.fn();
    renderWithWorker({ onSendToWorker });
    const button = screen.getByTestId('chat-send-to-worker');
    expect(button).toBeDisabled();

    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'research the market' } });
    expect(button).not.toBeDisabled();

    fireEvent.click(button);
    expect(onSendToWorker).toHaveBeenCalledWith('research the market');
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
  });
});
