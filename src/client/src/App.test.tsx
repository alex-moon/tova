import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import App from './App';
import { AuthProvider } from './context/AuthContext';

const axiosGet = vi.fn();
const axiosPost = vi.fn();

vi.mock('axios', () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    isAxiosError: vi.fn(() => false),
  },
}));

const renderApp = () =>
  render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );

const mockMe = (role: string) =>
  axiosGet.mockImplementation((url: string) => {
    if (url === '/api/auth/me') {
      return Promise.resolve({
        data: { user: { id: '1', email: 'a@b.c', role, permissions: [] } },
      });
    }
    return Promise.reject(new Error('no data'));
  });

describe('App', () => {
  afterEach(cleanup);

  beforeEach(() => {
    axiosGet.mockReset().mockRejectedValue(new Error('Not authenticated'));
    axiosPost.mockReset();
  });

  it('shows the login screen when the user is not authenticated', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: /Login to Tova/i })).toBeInTheDocument();
  });

  it('has email and password inputs on the login screen', async () => {
    renderApp();
    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('hides the admin link for non-admin users', async () => {
    mockMe('user');
    renderApp();
    await waitFor(() => expect(axiosGet).toHaveBeenCalledWith('/api/chat/sessions'));
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('shows the admin link for admin users', async () => {
    mockMe('admin');
    renderApp();
    expect(await screen.findByRole('link', { name: 'Admin' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Admin' }).getAttribute('href')).toBe('/admin');
  });

  it('renders exactly one chat window on the chat route', async () => {
    mockMe('admin');
    renderApp();
    expect(await screen.findByRole('link', { name: 'Admin' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /new chat/i }).length).toBeGreaterThan(0);
  });

  it('renders the admin view at the /admin route', async () => {
    mockMe('admin');
    window.history.pushState({}, '', '/admin');
    renderApp();
    expect(await screen.findByTestId('admin-view')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to chat' }).getAttribute('href')).toBe('/');
    window.history.pushState({}, '', '/');
  });

  it('renders the profile view at the /profile route', async () => {
    mockMe('user');
    window.history.pushState({}, '', '/profile');
    renderApp();
    expect(await screen.findByTestId('profile-view')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to chat' }).getAttribute('href')).toBe('/');
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
    window.history.pushState({}, '', '/');
  });

  it('renders the profile view for admins too (profile branch wins over admin, #95)', async () => {
    mockMe('admin');
    window.history.pushState({}, '', '/profile');
    renderApp();
    expect(await screen.findByTestId('profile-view')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-view')).not.toBeInTheDocument();
    window.history.pushState({}, '', '/');
  });

  it('still shows Login when unauthenticated, even at /profile', async () => {
    window.history.pushState({}, '', '/profile');
    renderApp();
    expect(await screen.findByRole('heading', { name: /Login to Tova/i })).toBeInTheDocument();
    expect(screen.queryByTestId('profile-view')).not.toBeInTheDocument();
    window.history.pushState({}, '', '/');
  });

  it('falls back to the chat view for non-admins at /admin', async () => {
    mockMe('user');
    window.history.pushState({}, '', '/admin');
    renderApp();
    await waitFor(() => expect(axiosGet).toHaveBeenCalledWith('/api/chat/sessions'));
    expect(screen.queryByTestId('admin-view')).not.toBeInTheDocument();
    window.history.pushState({}, '', '/');
  });
});

describe('App startup chat (issue #96)', () => {
  afterEach(cleanup);
  beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
    window.history.pushState({}, '', '/');
  });

  const sessions = [
    { _id: 'recent', title: 'Newest chat' },
    { _id: 'older', title: 'Older chat' },
  ];

  const mockStartup = (startupChat?: 'recent' | 'new') =>
    axiosGet.mockImplementation((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          data: {
            user: { id: '1', email: 'a@b.c', role: 'user', permissions: [], startupChat },
          },
        });
      }
      if (url === '/api/chat/sessions') {
        return Promise.resolve({ data: sessions });
      }
      if (url === '/api/chat/sessions/recent' || url === '/api/chat/sessions/older') {
        return Promise.resolve({
          data: { messages: [{ _id: 'm1', role: 'user', content: 'hi' }] },
        });
      }
      return Promise.reject(new Error('no data'));
    });

  it('opens the most recent chat by default (startupChat unset)', async () => {
    mockStartup(undefined);
    renderApp();
    await waitFor(() => expect(axiosGet).toHaveBeenCalledWith('/api/chat/sessions/recent'));
  });

  it('opens the most recent chat with startupChat recent', async () => {
    mockStartup('recent');
    renderApp();
    await waitFor(() => expect(axiosGet).toHaveBeenCalledWith('/api/chat/sessions/recent'));
  });

  it('starts blank when startupChat is new', async () => {
    mockStartup('new');
    renderApp();
    await waitFor(() => expect(axiosGet).toHaveBeenCalledWith('/api/chat/sessions'));
    await new Promise((r) => setTimeout(r, 0));
    expect(axiosGet).not.toHaveBeenCalledWith('/api/chat/sessions/recent');
    expect(axiosGet).not.toHaveBeenCalledWith('/api/chat/sessions/older');
  });

  it('does not re-select a startup session after a refetch', async () => {
    mockStartup('recent');
    renderApp();
    await waitFor(() => expect(axiosGet).toHaveBeenCalledWith('/api/chat/sessions/recent'));

    // Refetch (e.g. after send): the already-applied startup must not reset.
    axiosGet.mockClear();
    mockStartup('recent');
    await axiosGet;
    renderApp();
  });
});
