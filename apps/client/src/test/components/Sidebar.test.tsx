import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import Sidebar from '../../main/components/Sidebar';
import { AuthContext } from '../../main/context/AuthContext';
import type { User } from '../../main/context/AuthContext';

const renderSidebar = (
  user: User | null,
  opts: {
    sessions?: { _id: string; title: string; subtitle?: string | null }[];
    onDeleteSession?: (id: string) => void;
    onRenameSession?: (id: string, title: string) => void;
  } = {},
) => {
  const onClose = vi.fn();
  const onDeleteSession = opts.onDeleteSession ?? vi.fn();
  const onRenameSession = opts.onRenameSession ?? vi.fn();
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
        onRenameSession={onRenameSession}
        onClose={onClose}
      />
    </AuthContext.Provider>,
  );
  return { onClose, container: result.container, onDeleteSession, onRenameSession };
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

  // Links to the standalone /files view; /assets would be shadowed by nginx ahead of the SPA fallback.
  // @see #197
  it('links the files view at /files and renders no files modal (issue #197)', () => {
    renderSidebar(user);
    const link = screen.getByRole('link', { name: 'Files' });
    expect(link.getAttribute('href')).toBe('/files');
    expect(screen.queryByTestId('asset-library')).not.toBeInTheDocument();
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
    // Focus moves to Yes so keyboard/screen-reader users stay oriented.
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

describe('Sidebar — session subtitle (#359)', () => {
  afterEach(cleanup);

  const user: User = {
    id: '1',
    email: 'a@b.c',
    role: 'user',
    permissions: [],
  };

  it('renders the subtitle as a secondary line when present and omits it otherwise', () => {
    renderSidebar(user, {
      sessions: [
        { _id: 's1', title: 'Personal journey and life', subtitle: 'CV draft for the pm role' },
        { _id: 's2', title: 'No subtitle chat' },
      ],
    });
    expect(screen.getByText('CV draft for the pm role')).toBeInTheDocument();
    expect(screen.getByText('Personal journey and life')).toBeInTheDocument();
    const bareRow = screen.getByText('No subtitle chat').parentElement!;
    expect(bareRow.children).toHaveLength(1);
  });
});

describe('Sidebar — inline chat rename (#359)', () => {
  afterEach(cleanup);

  const user: User = {
    id: '1',
    email: 'a@b.c',
    role: 'user',
    permissions: [],
  };

  it('swaps the row for an input and commits the trimmed title on Enter', () => {
    const onRenameSession = vi.fn();
    renderSidebar(user, {
      sessions: [{ _id: 's1', title: 'Old name' }],
      onRenameSession,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Rename chat: Old name' }));
    const input = screen.getByTestId('sidebar-rename-input') as HTMLInputElement;
    expect(input.value).toBe('Old name');

    fireEvent.change(input, { target: { value: '  New name  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameSession).toHaveBeenCalledWith('s1', 'New name');
    expect(screen.queryByTestId('sidebar-rename-input')).toBeNull();
  });

  it('treats an empty or unchanged edit as a cancel, and Escape cancels', () => {
    const onRenameSession = vi.fn();
    renderSidebar(user, {
      sessions: [{ _id: 's1', title: 'Old name' }],
      onRenameSession,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Rename chat: Old name' }));
    const input = screen.getByTestId('sidebar-rename-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sidebar-rename-input')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Rename chat: Old name' }));
    fireEvent.keyDown(screen.getByTestId('sidebar-rename-input'), { key: 'Escape' });
    expect(onRenameSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sidebar-rename-input')).toBeNull();
  });
});
