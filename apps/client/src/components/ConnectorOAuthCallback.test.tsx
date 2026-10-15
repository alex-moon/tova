import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import ConnectorOAuthCallback from './ConnectorOAuthCallback';

const completeOAuth = vi.fn();

vi.mock('../services/connectors', async () => {
  const actual =
    await vi.importActual<typeof import('../services/connectors')>('../services/connectors');
  const MockedConnectorService = {
    completeOAuth: (...args: unknown[]) => completeOAuth(...args),
  };
  return { ...actual, default: MockedConnectorService };
});

const setQuery = (query: string) => {
  window.history.pushState({}, '', `/connectors/callback${query}`);
};

describe('ConnectorOAuthCallback (#327)', () => {
  beforeEach(() => {
    completeOAuth.mockReset();
    setQuery('');
  });

  afterEach(cleanup);

  it('relays code+state, then confirms the connected connector', async () => {
    setQuery('?code=auth-code&state=st');
    completeOAuth.mockResolvedValue({ name: 'Notion', type: 'mcp.oauth' });
    render(<ConnectorOAuthCallback />);

    await waitFor(() =>
      expect(completeOAuth).toHaveBeenCalledWith({ code: 'auth-code', state: 'st' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('connector-oauth-status')).toHaveTextContent('Notion connected.'),
    );
  });

  it('shows the provider decline (error param) without calling the API', async () => {
    setQuery('?error=access_denied&error_description=The%20user%20declined');
    render(<ConnectorOAuthCallback />);

    await waitFor(() =>
      expect(screen.getByTestId('connector-oauth-status')).toHaveTextContent('user declined'),
    );
    expect(completeOAuth).not.toHaveBeenCalled();
  });

  it('surfaces the engine failure message (expired state, exchange error)', async () => {
    setQuery('?code=c&state=s');
    const { ConnectorError } = await import('../services/connectors');
    completeOAuth.mockRejectedValue(
      new ConnectorError('This sign-in attempt expired or is not recognised. Start again.'),
    );
    render(<ConnectorOAuthCallback />);

    await waitFor(() =>
      expect(screen.getByTestId('connector-oauth-status')).toHaveTextContent(
        'expired or is not recognised',
      ),
    );
  });

  it('reports a redirect missing its code or state', async () => {
    setQuery('?state=only');
    render(<ConnectorOAuthCallback />);

    await waitFor(() =>
      expect(screen.getByTestId('connector-oauth-status')).toHaveTextContent(
        'missing its code or state',
      ),
    );
    expect(completeOAuth).not.toHaveBeenCalled();
  });
});
