import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import ConnectorsView from './ConnectorsView';
import type { ConnectorInfo } from '@shared/connectors';

const list = vi.fn();
const add = vi.fn();
const remove = vi.fn();
const startOAuth = vi.fn();
const reauth = vi.fn();
const open = vi.fn();

vi.mock('../services/connectors', async () => {
  const actual =
    await vi.importActual<typeof import('../services/connectors')>('../services/connectors');
  const MockedConnectorService = {
    list: (...args: unknown[]) => list(...args),
    add: (...args: unknown[]) => add(...args),
    remove: (...args: unknown[]) => remove(...args),
    startOAuth: (...args: unknown[]) => startOAuth(...args),
    completeOAuth: vi.fn(),
    reauth: (...args: unknown[]) => reauth(...args),
  };
  return { ...actual, default: MockedConnectorService };
});

const patRow: ConnectorInfo = {
  id: 'row-1',
  scope: 'user',
  type: 'mcp.pat',
  name: 'GitHub',
  url: 'https://api.githubcopilot.com/mcp',
  status: 'connected',
  authConfigured: true,
  authState: 'ok',
  tools: [],
};

const customRow: ConnectorInfo = {
  id: 'row-2',
  scope: 'user',
  type: 'mcp.pat',
  name: 'my-tools',
  url: 'https://custom.example.com/mcp',
  status: 'connected',
  authConfigured: false,
  authState: 'ok',
  tools: [],
};

beforeEach(() => {
  list.mockReset().mockResolvedValue([]);
  open.mockReset().mockReturnValue(null);
  vi.spyOn(window, 'open').mockImplementation(open);
});

afterEach(cleanup);

describe('ConnectorsView (#331)', () => {
  it('renders the curated grid in market-share order with status badges', async () => {
    render(<ConnectorsView />);
    await screen.findByTestId('connector-card-dropbox');
    const ids = [
      'google-drive',
      'gmail',
      'google-calendar',
      'google-maps',
      'spotify',
      'dropbox',
      'notion',
      'slack',
      'trello',
      'atlassian',
      'github',
    ];
    for (let i = 1; i < ids.length; i += 1) {
      const a = screen.getByTestId(`connector-card-${ids[i - 1]}`);
      const b = screen.getByTestId(`connector-card-${ids[i]}`);
      expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // Watchlisted entries say coming soon, not connect.
    expect(screen.getByTestId('connector-card-spotify-status')).toHaveTextContent('Coming soon');
    expect(screen.getByTestId('connector-card-trello-status')).toHaveTextContent('Connect');
  });

  it('joins connected rows by url and shows the connected badge', async () => {
    list.mockResolvedValue([patRow]);
    render(<ConnectorsView />);
    await screen.findByTestId('connector-card-github');
    expect(screen.getByTestId('connector-card-github-status')).toHaveTextContent('Connected');
    expect(screen.getByTestId('connectors-count')).toHaveTextContent('1 connected');
  });

  it('opens the OAuth modal with a single Connect button and redirects on click', async () => {
    startOAuth.mockResolvedValue('https://as.example.com/authorize?client_id=dcr');
    render(<ConnectorsView />);
    fireEvent.click(await screen.findByTestId('connector-card-trello'));
    await screen.findByTestId('connector-modal');
    expect(screen.getByTestId('connector-modal-connect')).toHaveTextContent('Connect');
    fireEvent.click(screen.getByTestId('connector-modal-connect'));
    await waitFor(() =>
      expect(startOAuth).toHaveBeenCalledWith({
        name: 'Trello',
        url: 'https://mcp.trello.com/v1',
      }),
    );
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('https://as.example.com/authorize?client_id=dcr', '_self'),
    );
  });

  it('shows watchlisted copy and no connect button in the modal', async () => {
    render(<ConnectorsView />);
    fireEvent.click(await screen.findByTestId('connector-card-spotify'));
    await screen.findByTestId('connector-modal');
    expect(screen.getByTestId('connector-modal-watchlist')).toBeInTheDocument();
    expect(screen.queryByTestId('connector-modal-connect')).not.toBeInTheDocument();
  });

  it('collects a token for PAT connectors and adds through the registry', async () => {
    add.mockResolvedValue(patRow);
    render(<ConnectorsView />);
    fireEvent.click(await screen.findByTestId('connector-card-github'));
    // A PAT connect requires a token up front (a tokenless row is a dead
    // end: there is no update-token path).
    expect(screen.getByTestId('connector-modal-connect')).toBeDisabled();
    fireEvent.change(screen.getByTestId('connector-modal-token'), {
      target: { value: 'api-token-1' },
    });
    expect(screen.getByTestId('connector-modal-connect')).toBeEnabled();
    fireEvent.click(screen.getByTestId('connector-modal-connect'));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        type: 'mcp.pat',
        name: 'GitHub',
        url: 'https://api.githubcopilot.com/mcp',
        authToken: 'api-token-1',
      }),
    );
  });

  it('renders the per-provider token instructions (#332) for PAT entries', async () => {
    render(<ConnectorsView />);
    fireEvent.click(await screen.findByTestId('connector-card-github'));
    const steps = await screen.findByTestId('connector-modal-instructions');
    // Real provider path, not the generic fallback.
    expect(steps).toHaveTextContent('personal-access-tokens');
    expect(steps).toHaveTextContent('Fine-grained token');
    // Scope guidance present (GitHub: narrow repository set).
    expect(steps).toHaveTextContent('invisible to the assistant');
  });

  it('offers re-connect and disconnect for a needs-reauth row', async () => {
    list.mockResolvedValue([
      { ...patRow, type: 'mcp.oauth' as const, authState: 'needs-reauth' as const },
    ]);
    reauth.mockResolvedValue('https://as.example.com/authorize');
    render(<ConnectorsView />);
    fireEvent.click(await screen.findByTestId('connector-card-github'));
    await screen.findByTestId('connector-modal-reconnect');
    fireEvent.click(screen.getByTestId('connector-modal-reconnect'));
    await waitFor(() => expect(reauth).toHaveBeenCalledWith('row-1'));
    expect(open).toHaveBeenCalledWith('https://as.example.com/authorize', '_self');
  });

  it('lists custom rows under "Added by you" with a manage modal offering disconnect', async () => {
    list.mockResolvedValue([customRow]);
    render(<ConnectorsView />);
    await screen.findByTestId('connector-row-row-2');
    fireEvent.click(screen.getByTestId('connector-row-row-2-manage'));
    await screen.findByTestId('connector-modal-disconnect');
    remove.mockResolvedValue(undefined);
    fireEvent.click(screen.getByTestId('connector-modal-disconnect'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('row-2'));
  });

  it('adds a custom connector with a token from the advanced section', async () => {
    add.mockResolvedValue(customRow);
    render(<ConnectorsView />);
    fireEvent.click(await screen.findByTestId('connectors-custom-toggle'));
    fireEvent.change(screen.getByTestId('connector-add-name'), { target: { value: 'my-tools' } });
    fireEvent.change(screen.getByTestId('connector-add-url'), {
      target: { value: 'https://custom.example.com/mcp' },
    });
    fireEvent.click(screen.getByTestId('connector-add-save'));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        type: 'mcp.pat',
        name: 'my-tools',
        url: 'https://custom.example.com/mcp',
        authToken: undefined,
      }),
    );
  });
});
