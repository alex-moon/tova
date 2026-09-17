import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import McpServerService, { type McpServerInfo } from '../services/mcp';
import { McpError } from '../types/mcp';

/*
 * Personal MCP servers settings section (issue #36). Platform servers show
 * read-only; personal ones can be added (with a live add-time handshake) and
 * removed here. Auth header values are never sent back from the API, so the
 * list only shows whether one is configured.
 */

const statusDotColor = (status: string): string =>
  status === 'connected' ? 'bg-green-500' : status === 'unreachable' ? 'bg-red-500' : 'bg-gray-400';

const McpServersSection: React.FC = () => {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [authHeader, setAuthHeader] = useState('');
  const [pendingAdd, setPendingAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    McpServerService.list()
      .then((next) => {
        if (alive) setServers(next);
      })
      .catch((err) => {
        if (alive && err instanceof McpError) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  const add = async () => {
    setPendingAdd(true);
    setError(null);
    try {
      const trimmedHeader = authHeader.trim();
      const created = await McpServerService.add({
        name: name.trim(),
        url: url.trim(),
        ...(trimmedHeader ? { authHeader: trimmedHeader } : {}),
      });
      setName('');
      setUrl('');
      setAuthHeader('');
      setServers((prev) => [...(prev ?? []), created]);
    } catch (err) {
      if (err instanceof McpError) setError(err.message);
      else setError('Could not add MCP server.');
    } finally {
      setPendingAdd(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await McpServerService.remove(id);
      setServers((prev) => (prev ?? []).filter((s) => s.id !== id));
    } catch (err) {
      if (err instanceof McpError) setError(err.message);
      else setError('Could not remove MCP server.');
    }
  };

  const canAdd = name.trim().length > 0 && url.trim().length > 0 && !pendingAdd;

  return (
    <div data-testid="mcp-servers-section" className="border-t border-border pt-4">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="font-heading text-sm font-semibold">MCP servers</h3>
        {servers && (
          <span className="text-xs text-muted-foreground">
            platform: {servers.filter((s) => s.scope === 'platform').length}, personal:{' '}
            {servers.filter((s) => s.scope === 'user').length}
          </span>
        )}
      </div>

      {servers === null ? (
        <p className="text-xs text-muted-foreground" data-testid="mcp-servers-loading">
          Loading...
        </p>
      ) : servers.length === 0 ? (
        <p className="text-xs text-muted-foreground">No MCP servers connected.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {servers.map((server) => (
            <li
              key={server.id}
              data-testid={`mcp-server-${server.name}`}
              className="flex items-start justify-between gap-3 rounded-lg border border-border p-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${statusDotColor(server.status)}`}
                    aria-label={`Status: ${server.status}`}
                  />
                  <span className="truncate font-medium">{server.name}</span>
                  {server.scope === 'platform' && (
                    <span className="rounded border-border px-1 text-[10px] uppercase">
                      platform
                    </span>
                  )}
                  {server.headersConfigured && (
                    <span data-testid="mcp-auth-configured" className="text-[10px] uppercase">
                      auth set
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">{server.url}</p>
                <p className="text-xs text-muted-foreground">
                  {server.tools.length ? server.tools.map((t) => t.name).join(', ') : 'No tools'}
                </p>
              </div>
              <div className="shrink-0">
                {server.scope === 'user' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => remove(server.id)}
                    data-testid={`mcp-server-${server.name}-remove`}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 space-y-2">
        <label className="block text-xs">
          <span className="mb-1 block">Name of your MCP server</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            data-testid="mcp-add-name"
            placeholder="my-tools"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block">URL (https)</span>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            maxLength={2048}
            data-testid="mcp-add-url"
            placeholder="https://example.com/mcp"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block">Auth header (optional, encrypted at rest)</span>
          <Input
            value={authHeader}
            onChange={(e) => setAuthHeader(e.target.value)}
            maxLength={4000}
            data-testid="mcp-add-auth-header"
            placeholder="Authorization: Bearer token"
            autoComplete="off"
          />
        </label>
        <div className="flex justify-end">
          <Button variant="outline" onClick={add} disabled={!canAdd} data-testid="mcp-add-save">
            {pendingAdd ? 'Testing connection...' : 'Add MCP server'}
          </Button>
        </div>
      </div>

      {error && (
        <div
          data-testid="mcp-servers-error"
          className="mt-2 rounded-lg border border-destructive bg-destructive/10 p-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}
    </div>
  );
};

export default McpServersSection;
