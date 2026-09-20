import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import Sidebar from './Sidebar';
import { AuthContext } from '../context/AuthContext';
import type { User } from '../context/AuthContext';

const renderSidebar = (
  user: User | null,
  opts: {
    sessions?: { _id: string; title: string }[];
    onDeleteSession?: (id: string) => void;
  } = {},
) => {
  const onClose = vi.fn();
  const onDeleteSession = opts.onDeleteSession ?? vi.fn();
  const result = render(
    <AuthContext.Provider
      value={{
        user,
        loading: false,
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
        updateUser: vi.fn(),
      }}
    >
      <Sidebar
        sessions={opts.sessions ?? []}
        activeSessionId={null}
        open
        onSelectSession={vi.fn()}
        onNewChat={vi.fn()}
        onDeleteSession={onDeleteSession}
        onClose={onClose}
        showFiles={false}
        onToggleFiles={vi.fn()}
      />
    </AuthContext.Provider>,
  );
  return { onClose, container: result.container, onDeleteSession };
};

describe('Sidebar footer avatar (issue #35)', () => {
  afterEach(cleanup);

  const user: User = {
    id: '1',
    email: 'a@b.c',
    role: 'user',
    permissions: [],
    name: 'Alex Moon',
    preferredName: 'Al',
  };

  it('renders an initial fallback when avatarUrl is absent', () => {
    renderSidebar(user);
    expect(screen.getByTestId('avatar-fallback')).toHaveTextContent('A');
  });

  it('derives the initial from the email when no names exist', () => {
    renderSidebar({ ...user, preferredName: '   ', name: undefined });
    expect(screen.getByTestId('avatar-fallback')).toHaveTextContent('A');
  });

  it('renders an image when avatarUrl is set and none otherwise', () => {
    renderSidebar({ ...user, avatarUrl: 'https://example.com/x.png' });
    const img = screen.getByTestId('avatar-img');
    expect(img).toHaveAttribute('src', 'https://example.com/x.png');
    expect(screen.queryByTestId('avatar-fallback')).not.toBeInTheDocument();
  });

  it('links the profile view from the footer (issue #95)', () => {
    renderSidebar(user);
    const link = screen.getByRole('link', { name: 'Open profile' });
    expect(link.getAttribute('href')).toBe('/profile');
    expect(screen.queryByTestId('profile-modal')).not.toBeInTheDocument();
  });
});

describe('Sidebar — inline chat delete confirm (issue #59)', () => {
  afterEach(cleanup);

  const user: User = {
    id: '1',
    email: 'a@b.c',
    role: 'user',
    permissions: [],
  };

  const sessions = [{ _id: 's1', title: 'Chores' }];

  it('arms the row on trash click and deletes on Yes', () => {
    const onDeleteSession = vi.fn();
    renderSidebar(user, { sessions, onDeleteSession });
    expect(screen.queryByText('Sure? Irreversible.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat: Chores' }));
    expect(screen.getByText('Sure? Irreversible.')).toBeInTheDocument();
    expect(onDeleteSession).not.toHaveBeenCalled();
    // Focus moves to Yes so keyboard/screen-reader users stay oriented when
    // the row swaps to the armed card (focus would otherwise drop to <body>).
    expect(screen.getByTestId('confirm-yes')).toHaveFocus();
    fireEvent.click(screen.getByTestId('confirm-yes'));
    expect(onDeleteSession).toHaveBeenCalledWith('s1');
    expect(screen.queryByText('Sure? Irreversible.')).not.toBeInTheDocument();
  });

  it('No cancels without deleting', () => {
    const onDeleteSession = vi.fn();
    renderSidebar(user, { sessions, onDeleteSession });
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat: Chores' }));
    fireEvent.click(screen.getByTestId('confirm-no'));
    expect(screen.queryByText('Sure? Irreversible.')).not.toBeInTheDocument();
    expect(onDeleteSession).not.toHaveBeenCalled();
  });

  it('deletes immediately when the chat confirm preference is off', () => {
    const onDeleteSession = vi.fn();
    renderSidebar(
      { ...user, confirmDeletes: { chat: false, file: true } },
      {
        sessions,
        onDeleteSession,
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat: Chores' }));
    expect(onDeleteSession).toHaveBeenCalledWith('s1');
    expect(screen.queryByText('Sure? Irreversible.')).not.toBeInTheDocument();
  });
});
