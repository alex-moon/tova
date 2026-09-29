import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { toast } from 'sonner';
import ChatWindow from './ChatWindow';
import type { Message } from '../App';

const msg = (over: Partial<Message> = {}): Message => ({
  _id: 'm1',
  role: 'assistant',
  content: 'the answer',
  modelName: 'test-model',
  ...over,
});

const renderChat = (messages: Message[]) =>
  render(
    <ChatWindow
      messages={messages}
      onSendMessage={vi.fn()}
      isLoading={false}
      onOpenSidebar={vi.fn()}
    />,
  );

describe('ChatWindow copy as Markdown (issue #200)', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.assign(navigator, { clipboard: { writeText } });
  });

  afterEach(cleanup);

  it('copies a user message verbatim', async () => {
    renderChat([msg({ _id: 'u1', role: 'user', content: 'hello **world**' })]);
    fireEvent.click(screen.getByLabelText('Copy message as Markdown'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('hello **world**'));
  });

  it('copies the assistant raw Markdown, not rendered HTML', async () => {
    renderChat([msg({ content: 'a **bold** claim' })]);
    fireEvent.click(screen.getByLabelText('Copy message as Markdown'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('a **bold** claim'));
  });

  it('swaps the Copy icon for Check on success', async () => {
    renderChat([msg()]);
    const button = screen.getByLabelText('Copy message as Markdown');
    expect(button.querySelector('.lucide-copy')).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(button.querySelector('.lucide-check')).toBeInTheDocument());
  });

  it('renders the copy button for an assistant turn without a modelName', () => {
    renderChat([msg({ modelName: undefined })]);
    expect(screen.getByLabelText('Copy message as Markdown')).toBeInTheDocument();
  });

  it('renders no copy button for an assistant turn with empty content', () => {
    renderChat([msg({ content: '', modelName: undefined })]);
    expect(screen.queryByLabelText('Copy message as Markdown')).not.toBeInTheDocument();
  });

  it('surfaces a toast and does not flip state when writeText rejects', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    const errorSpy = vi.spyOn(toast, 'error');
    renderChat([msg()]);
    const button = screen.getByLabelText('Copy message as Markdown');
    fireEvent.click(button);
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith('Could not copy'));
    expect(button.querySelector('.lucide-check')).not.toBeInTheDocument();
    errorSpy.mockRestore();
  });

  it('warns and no-ops when the Clipboard API is unavailable', async () => {
    const original = navigator.clipboard;
    Object.assign(navigator, { clipboard: undefined });
    const errorSpy = vi.spyOn(toast, 'error');
    try {
      renderChat([msg()]);
      const button = screen.getByLabelText('Copy message as Markdown');
      fireEvent.click(button);
      await waitFor(() => expect(errorSpy).toHaveBeenCalledWith('Copy not supported'));
      expect(button.querySelector('.lucide-check')).not.toBeInTheDocument();
    } finally {
      Object.assign(navigator, { clipboard: original });
      errorSpy.mockRestore();
    }
  });

  it('preserves surrounding whitespace verbatim (raw source, no trim)', async () => {
    renderChat([msg({ content: '  padded **md**  \n' })]);
    fireEvent.click(screen.getByLabelText('Copy message as Markdown'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('  padded **md**  \n'));
  });

  it('no-ops without throwing for an empty user message', async () => {
    renderChat([msg({ _id: 'u-empty', role: 'user', content: '', modelName: undefined })]);
    const button = screen.getByLabelText('Copy message as Markdown');
    fireEvent.click(button);
    await waitFor(() => expect(writeText).not.toHaveBeenCalled());
    expect(button.querySelector('.lucide-check')).not.toBeInTheDocument();
  });

  it('only flags the most recently copied message as copied', async () => {
    renderChat([
      msg({ _id: 'a', content: 'first' }),
      msg({ _id: 'b', modelName: undefined, content: 'second' }),
    ]);
    const buttons = screen.getAllByLabelText('Copy message as Markdown');
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(buttons[0].querySelector('.lucide-check')).toBeInTheDocument());
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(buttons[1].querySelector('.lucide-check')).toBeInTheDocument());
    expect(buttons[0].querySelector('.lucide-check')).not.toBeInTheDocument();
  });
});
