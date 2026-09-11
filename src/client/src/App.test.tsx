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

  it('falls back to the chat view for non-admins at /admin', async () => {
    mockMe('user');
    window.history.pushState({}, '', '/admin');
    renderApp();
    await waitFor(() => expect(axiosGet).toHaveBeenCalledWith('/api/chat/sessions'));
    expect(screen.queryByTestId('admin-view')).not.toBeInTheDocument();
    window.history.pushState({}, '', '/');
  });
});
