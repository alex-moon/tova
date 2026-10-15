import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import McpServersSection from './McpServersSection';
import type { ConnectorInfo } from '@shared/connectors';
import { MCP_SUGGESTIONS } from './mcpSuggestions';

const list = vi.fn();
const add = vi.fn();
const remove = vi.fn();

vi.mock('../services/connectors', async () => {
  const actual =
    await vi.importActual<typeof import('../services/connectors')>('../services/connectors');
  const MockedConnectorService = {
    list: (...args: unknown[]) => list(...args),
    add: (...args: unknown[]) => add(...args),
    remove: (...args: unknown[]) => remove(...args),
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
