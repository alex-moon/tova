import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import Sidebar from './Sidebar';
import { AuthContext } from '../context/AuthContext';
import type { User } from '../context/AuthContext';

const renderSidebar = (user: User | null) => {
  const onClose = vi.fn();
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
        sessions={[]}
        activeSessionId={null}
        open
        onSelectSession={vi.fn()}
        onNewChat={vi.fn()}
        onDeleteSession={vi.fn()}
        onClose={onClose}
      />
    </AuthContext.Provider>,
  );
  return { onClose, container: result.container };
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

  it('opens the profile modal from the footer', () => {
    renderSidebar(user);
    fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
    expect(screen.getByTestId('profile-modal')).toBeInTheDocument();
  });
});
