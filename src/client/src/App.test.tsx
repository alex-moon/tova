import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';
import { AuthProvider } from './context/AuthContext';

vi.mock('axios', () => ({
  default: {
    get: vi.fn().mockRejectedValue(new Error('Not authenticated')),
    post: vi.fn(),
    isAxiosError: vi.fn(() => false),
  },
}));

const renderApp = () =>
  render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );

describe('App', () => {
  it('shows the login screen when the user is not authenticated', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: /Login to Tova/i })).toBeInTheDocument();
  });

  it('has email and password inputs on the login screen', async () => {
    renderApp();
    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });
});
