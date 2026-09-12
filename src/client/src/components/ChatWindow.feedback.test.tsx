import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import ChatWindow from './ChatWindow';
import type { Message } from '../App';

const msg = (feedback?: { value: string | null }): Message => ({
  _id: 'm1',
  role: 'assistant',
  content: 'the answer',
  modelName: 'test-model',
  feedback,
});

describe('ChatWindow feedback thumbs', () => {
  afterEach(cleanup);

  it('sends a POST with the correct value on click and re-renders from props', async () => {
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    render(
      <ChatWindow
        messages={[msg({ value: 'up' })]}
        onSendMessage={vi.fn()}
        isLoading={false}
        onOpenSidebar={vi.fn()}
        onFeedback={onFeedback}
      />,
    );

    fireEvent.click(screen.getByLabelText('Poor response'));
    await waitFor(() => expect(onFeedback).toHaveBeenCalledWith('m1', 'down'));
    cleanup();
  });

  it('sends null (unvote) when the active thumb is clicked again', async () => {
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    render(
      <ChatWindow
        messages={[msg({ value: 'up' })]}
        onSendMessage={vi.fn()}
        isLoading={false}
        onOpenSidebar={vi.fn()}
        onFeedback={onFeedback}
      />,
    );

    fireEvent.click(screen.getByLabelText('Good response'));
    await waitFor(() => expect(onFeedback).toHaveBeenCalledWith('m1', null));
  });

  it('disables both thumbs while the request is pending', async () => {
    const onFeedback = vi.fn().mockReturnValue(new Promise(() => {}));
    render(
      <ChatWindow
        messages={[msg()]}
        onSendMessage={vi.fn()}
        isLoading={false}
        onOpenSidebar={vi.fn()}
        onFeedback={onFeedback}
      />,
    );

    fireEvent.click(screen.getByLabelText('Good response'));
    expect(screen.getByLabelText('Poor response')).toBeDisabled();
    expect(screen.getByLabelText('Good response')).toBeDisabled();
  });

  it('exposes the active vote as aria-pressed for screen readers', () => {
    render(
      <ChatWindow
        messages={[msg({ value: 'up' })]}
        onSendMessage={vi.fn()}
        isLoading={false}
        onOpenSidebar={vi.fn()}
        onFeedback={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Good response').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Poor response').getAttribute('aria-pressed')).toBe('false');
  });
});
