import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
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

  it('hides the admin toggle for non-admin users', async () => {
    mockMe('user');
    renderApp();
    await waitFor(() => expect(axiosGet).toHaveBeenCalledWith('/api/chat/sessions'));
    expect(screen.queryByRole('button', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('shows the admin toggle for admin users', async () => {
    mockMe('admin');
    renderApp();
    expect(await screen.findByRole('button', { name: 'Admin' })).toBeInTheDocument();
  });

  it('renders the admin view when the toggle is used', async () => {
    mockMe('admin');
    renderApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Admin' }));
    expect(await screen.findByTestId('admin-view')).toBeInTheDocument();
  });
});
