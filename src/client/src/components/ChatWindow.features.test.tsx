import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { toast } from 'sonner';

vi.mock('../services/assets', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/assets')>();
  return {
    ...original,
    default: Object.assign(vi.fn(), original.default, { upload: vi.fn() }),
  };
});

import AssetService from '../services/assets';
import ChatWindow from './ChatWindow';
import type { Message, ToolEvent } from '../App';

const NO_TEXT_TOAST =
  'No text could be extracted from this file type — Tova will see the filename only.';

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
    expect(screen.getByTestId('tool-chip-list_files')).toHaveTextContent('3 results');
  });

  it('shows no results text when the event carries no count', () => {
    renderChat(
      resultMessage([{ phase: 'result', name: 'read_file', label: 'Read a file', status: 'ok' }]),
    );
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
    expect(screen.getByTestId('tool-chip-web_search')).toHaveTextContent('0 results');
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

describe('Composer library-pick (issue #51)', () => {
  const infoSpy = vi.spyOn(toast, 'info');
  afterEach(() => {
    cleanup();
    infoSpy.mockClear();
  });

  it('turns a picked asset into the attachment chip and fires the no-text toast when hasText is false', () => {
    const onPickedConsumed = vi.fn();
    renderChat([], false, {
      incomingAsset: {
        id: 'a9',
        filename: 'scan.dat',
        contentType: 'application/octet-stream',
        hasText: false,
      },
      onPickedConsumed,
    });
    expect(screen.getByTestId('attachment-chip')).toHaveTextContent('scan.dat');
    expect(onPickedConsumed).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(NO_TEXT_TOAST);
  });

  // Issue #115: images are first-class attachments — no no-text toast.
  it('shows no toast for an image pick and marks the chip with the image icon', () => {
    const onPickedConsumed = vi.fn();
    renderChat([], false, {
      incomingAsset: {
        id: 'a9',
        filename: 'photo.png',
        contentType: 'image/png',
        hasText: false,
      },
      onPickedConsumed,
    });
    expect(screen.getByTestId('attachment-chip')).toHaveTextContent('photo.png');
    expect(toast.info).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="attachment-chip"] svg.lucide-file-image'),
    ).toBeInTheDocument();
  });

  // #115 critic pass: only image attachments get the image icon; plain files
  // keep the paperclip (regression guard against the unconditional swap).
  it('keeps the paperclip icon for a non-image attachment', () => {
    const onPickedConsumed = vi.fn();
    renderChat([], false, {
      incomingAsset: {
        id: 'a10',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        hasText: true,
      },
      onPickedConsumed,
    });
    const chip = screen.getByTestId('attachment-chip');
    expect(chip.querySelector('svg.lucide-file-image')).not.toBeInTheDocument();
    expect(chip.querySelector('svg.lucide-paperclip')).toBeInTheDocument();
  });

  it('shows no toast when the picked asset has text', () => {
    const onPickedConsumed = vi.fn();
    renderChat([], false, {
      incomingAsset: { id: 'a9', filename: 'notes.txt', hasText: true },
      onPickedConsumed,
    });
    expect(screen.getByTestId('attachment-chip')).toHaveTextContent('notes.txt');
    expect(onPickedConsumed).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalled();
  });

  // Issue #83: pending conversion is a wait state, not a textless file.
  it('shows the extracting toast (not the no-text toast) for a pending pick', () => {
    renderChat([], false, {
      incomingAsset: {
        id: 'a9',
        filename: 'doc.pdf',
        hasText: false,
        markdownStatus: 'pending',
      },
      onPickedConsumed: vi.fn(),
    });
    expect(toast.info).toHaveBeenCalledWith('Still extracting text — try attaching again shortly.');
    expect(toast.info).not.toHaveBeenCalledWith(NO_TEXT_TOAST);
  });

  it('still fires the no-text toast for failed and none conversions', () => {
    renderChat([], false, {
      incomingAsset: {
        id: 'a9',
        filename: 'doc.pdf',
        hasText: false,
        markdownStatus: 'failed',
      },
      onPickedConsumed: vi.fn(),
    });
    expect(toast.info).toHaveBeenCalledWith(NO_TEXT_TOAST);
  });

  it('does not fire without a pick (no regression to the picker flow)', () => {
    const onPickedConsumed = vi.fn();
    renderChat([base()], false, { onPickedConsumed });
    expect(screen.queryByTestId('attachment-chip')).not.toBeInTheDocument();
    expect(onPickedConsumed).not.toHaveBeenCalled();
  });

  it('consumes a pick without applying it while an upload is in flight (race rule)', async () => {
    vi.mocked(AssetService.upload).mockReturnValue(
      new Promise(() => {
        /* hang: uploading stays true */
      }),
    );
    const onPickedConsumed = vi.fn();
    const view = render(
      <ChatWindow
        messages={[]}
        onSendMessage={vi.fn()}
        isLoading={false}
        onOpenSidebar={vi.fn()}
        onPickedConsumed={onPickedConsumed}
      />,
    );
    const file = new File(['x'], 'inflight.pdf', { type: 'application/pdf' });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(AssetService.upload).toHaveBeenCalled());
    // Pick arrives while the upload is still in flight.
    view.rerender(
      <ChatWindow
        messages={[]}
        onSendMessage={vi.fn()}
        isLoading={false}
        onOpenSidebar={vi.fn()}
        incomingAsset={{ id: 'a8', filename: 'late.txt', hasText: true }}
        onPickedConsumed={onPickedConsumed}
      />,
    );
    expect(onPickedConsumed).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('attachment-chip')).not.toBeInTheDocument();
    view.unmount();
  });
});
