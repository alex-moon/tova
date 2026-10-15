import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import McpServersSection from './McpServersSection';
import type { ConnectorInfo } from '@shared/connectors';
import { MCP_SUGGESTIONS } from './mcpSuggestions';

const list = vi.fn();
const add = vi.fn();
const remove = vi.fn();
const startOAuth = vi.fn();
const completeOAuth = vi.fn();
const reauth = vi.fn();

vi.mock('../services/connectors', async () => {
  const actual =
    await vi.importActual<typeof import('../services/connectors')>('../services/connectors');
  const MockedConnectorService = {
    list: (...args: unknown[]) => list(...args),
    add: (...args: unknown[]) => add(...args),
    remove: (...args: unknown[]) => remove(...args),
    startOAuth: (...args: unknown[]) => startOAuth(...args),
    completeOAuth: (...args: unknown[]) => completeOAuth(...args),
    reauth: (...args: unknown[]) => reauth(...args),
  };
  return { ...actual, default: MockedConnectorService };
});

const server: ConnectorInfo = {
  id: '1',
  scope: 'user',
  type: 'mcp.pat',
  name: 'my-tools',
  url: 'https://mcp.example.com/mcp',
  status: 'connected',
  authConfigured: true,
  authState: 'ok',
  tools: [
    { name: 'weather', description: 'Get weather' },
    { name: 'forecast', description: 'Get forecast' },
  ],
};

describe('McpServersSection (issues #36, #80)', () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue([server]);
    add.mockReset().mockResolvedValue(server);
    remove.mockReset().mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it('submits a raw token as authToken, not a full header spec', async () => {
    render(<McpServersSection />);
    await screen.findByTestId(`mcp-server-${server.name}`);

    fireEvent.change(screen.getByTestId('mcp-add-name'), { target: { value: 'new' } });
    fireEvent.change(screen.getByTestId('mcp-add-url'), {
      target: { value: 'https://new.example.com/mcp' },
    });
    fireEvent.change(screen.getByTestId('mcp-add-auth-token'), {
      target: { value: 'sk-tok:en-1' },
    });
    fireEvent.click(screen.getByTestId('mcp-add-save'));

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        type: 'mcp.pat',
        name: 'new',
        url: 'https://new.example.com/mcp',
        authToken: 'sk-tok:en-1',
      }),
    );
  });

  it('collapses scopes behind a toggle and expands on click', async () => {
    render(<McpServersSection />);
    await screen.findByTestId(`mcp-server-${server.name}`);

    const toggle = screen.getByTestId(`mcp-show-scopes-${server.name}`);
    expect(toggle).toHaveTextContent('2 scopes');
    expect(screen.queryByText('weather, forecast')).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(screen.getByText('weather, forecast')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('hide scopes');
  });

  it('hides suggestions by default and prefills the add form on click', async () => {
    render(<McpServersSection />);
    await screen.findByTestId(`mcp-server-${server.name}`);

    expect(screen.queryByTestId('mcp-suggestion-0')).not.toBeInTheDocument();

    const suggestionsToggle = screen.getByTestId('mcp-show-suggestions');
    expect(suggestionsToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(suggestionsToggle);
    expect(suggestionsToggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByTestId('mcp-suggestion-0'));
    expect(screen.getByTestId('mcp-add-name')).toHaveValue(MCP_SUGGESTIONS[0].name);
    expect(screen.getByTestId('mcp-add-url')).toHaveValue(MCP_SUGGESTIONS[0].url);
  });
});

describe('McpServersSection OAuth affordances (#327)', () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue([server]);
    startOAuth.mockReset().mockResolvedValue('https://as.example.com/authorize?client_id=dcr');
    reauth.mockReset().mockResolvedValue('https://as.example.com/authorize?client_id=dcr');
  });

  afterEach(cleanup);

  it('connects via browser sign-in: startOAuth with the form fields, then redirect', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<McpServersSection />);
    await screen.findByTestId(`mcp-server-${server.name}`);

    fireEvent.change(screen.getByTestId('mcp-add-name'), { target: { value: 'notion' } });
    fireEvent.change(screen.getByTestId('mcp-add-url'), {
      target: { value: 'https://mcp.notion.com/mcp' },
    });
    fireEvent.click(screen.getByTestId('mcp-add-oauth'));

    await waitFor(() =>
      expect(startOAuth).toHaveBeenCalledWith({
        name: 'notion',
        url: 'https://mcp.notion.com/mcp',
      }),
    );
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('https://as.example.com/authorize?client_id=dcr', '_self'),
    );
    // The token form was not used.
    expect(add).not.toHaveBeenCalled();
  });

  it('surfaces the discovery failure (no OAuth advertised) without navigating', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<McpServersSection />);
    await screen.findByTestId(`mcp-server-${server.name}`);

    const { ConnectorError } = await import('../services/connectors');
    startOAuth.mockRejectedValue(
      new ConnectorError('This endpoint does not advertise OAuth sign-in.'),
    );

    fireEvent.change(screen.getByTestId('mcp-add-name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByTestId('mcp-add-url'), {
      target: { value: 'https://noauth.example.com/mcp' },
    });
    fireEvent.click(screen.getByTestId('mcp-add-oauth'));

    await waitFor(() =>
      expect(screen.getByTestId('mcp-servers-error')).toHaveTextContent('does not advertise OAuth'),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('offers re-connect on a needs-reauth row without deleting it', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const deadGrant = { ...server, type: 'mcp.oauth' as const, authState: 'needs-reauth' as const };
    list.mockResolvedValue([deadGrant]);
    render(<McpServersSection />);
    await screen.findByTestId(`mcp-reconnect-${deadGrant.name}`);

    fireEvent.click(screen.getByTestId(`mcp-reconnect-${deadGrant.name}`));
    await waitFor(() => expect(reauth).toHaveBeenCalledWith(deadGrant.id));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('https://as.example.com/authorize?client_id=dcr', '_self'),
    );
  });
});
