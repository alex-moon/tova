import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ChatWindow from '../../main/components/ChatWindow';
import type { Message } from '../../main/App';

const flagged = (): Message => ({
  _id: 'm2',
  role: 'assistant',
  content: 'Read it — 87 lines, all of it.',
  modelName: 'test-model',
  honesty: { flagged: true, reason: 'no tools executed', checkedAt: new Date().toISOString() },
});

const renderWith = (messages: Message[], onSendMessage = vi.fn()) => {
  render(
    <ChatWindow
      messages={messages}
      onSendMessage={onSendMessage}
      isLoading={false}
      onOpenSidebar={vi.fn()}
    />,
  );
  return onSendMessage;
};

describe('ChatWindow honesty flag (#371)', () => {
  afterEach(cleanup);

  it('renders the badge and retry affordance on a flagged message', () => {
    renderWith([{ _id: 'm1', role: 'user', content: 'read the file' }, flagged()]);
    expect(screen.getByTestId('honesty-flag')).toBeTruthy();
    expect(screen.getByTestId('honesty-retry')).toBeTruthy();
  });

  it('renders nothing on an unflagged or unassessed message', () => {
    renderWith([
      { _id: 'm1', role: 'user', content: 'hi' },
      { _id: 'm2', role: 'assistant', content: 'the answer', modelName: 'test-model' },
    ]);
    expect(screen.queryByTestId('honesty-flag')).toBeNull();
  });

  it('resends the preceding user message verbatim on retry', () => {
    const onSendMessage = renderWith([
      { _id: 'm1', role: 'user', content: 'read the file' },
      flagged(),
    ]);
    fireEvent.click(screen.getByTestId('honesty-retry'));
    expect(onSendMessage).toHaveBeenCalledWith('read the file');
  });
});
