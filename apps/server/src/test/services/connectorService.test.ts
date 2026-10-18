import { RequestContext } from '@mastra/core/request-context';
import { Connector } from '../../main/models/Connector';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  callMcpTool,
  clearConnectorCachesForTests,
  connectorToolsetsForUser,
  zodFromJsonSchema,
} from '../../main/services/connectorService';
import { toolIsFailed } from '../../main/services/toolDegrade';

const LIST_TOOLS_RESULT = {
  tools: [
    { name: 'weather', description: 'Get weather', inputSchema: { type: 'object' } },
    { name: 'surf_board.shaper.build', description: '', inputSchema: { type: 'object' } },
  ],
};

const mockListTools = jest.fn().mockResolvedValue(LIST_TOOLS_RESULT);
const mockCallTool = jest.fn();
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockConnect = jest.fn().mockResolvedValue(undefined);

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    listTools: mockListTools,
    callTool: mockCallTool,
    close: mockClose,
  })),
}));

const streamableTransport = jest.fn().mockImplementation(() => ({}));
const sseTransport = jest.fn().mockImplementation(() => ({}));

// Transport mocks must be constructable; delegates to per-test spies.
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest
    .fn()
    .mockImplementation((...args: unknown[]) => streamableTransport(...(args as []))),
}));

jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: jest
    .fn()
    .mockImplementation((...args: unknown[]) => sseTransport(...(args as []))),
}));

jest.mock('../../main/services/crypto', () => ({
  decryptEnvelope: jest.fn(() => JSON.stringify({ Authorization: 'Bearer from-mock-decrypt' })),
  encryptEnvelope: jest.fn((plaintext: string) => ({
    iv: 'a',
    tag: 'b',
    ciphertext: plaintext.slice(0, 10),
  })),
}));

const USER_ID = '507f1f77bcf86cd799439011';

beforeEach(() => {
  clearConnectorCachesForTests();
  mockListTools.mockClear().mockResolvedValue(LIST_TOOLS_RESULT);
  mockCallTool.mockReset();
  mockConnect.mockClear().mockResolvedValue(undefined);
  mockClose.mockClear().mockResolvedValue(undefined);
  (Client as unknown as jest.Mock).mockClear();
  streamableTransport.mockReset().mockImplementation(() => ({}) as never);
  sseTransport.mockReset().mockImplementation(() => ({}) as never);
});

describe('connectorService', () => {
  it('returns no toolsets for a user with no connectors', async () => {
    const toolsets = await connectorToolsetsForUser(USER_ID);
    expect(toolsets).toEqual({});
  });

  it('exposes one toolset per platform connector with wrapped tools', async () => {
    await Connector.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    const toolsets = await connectorToolsetsForUser(USER_ID);
    // Server name sanitization keeps the toolset key stable and prefixed.
    expect(Object.keys(toolsets)).toEqual(['mcp_platform_tools']);
    expect(Object.keys(toolsets.mcp_platform_tools)).toEqual([
      'weather',
      'surf_board.shaper.build',
    ]);
  });

  it('skips connectors whose handshake fails', async () => {
    // A dead host fails both transport attempts and is skipped entirely.
    streamableTransport.mockImplementation((url: URL) => {
      if (url.hostname === 'dead.example.com') throw new Error('ECONNREFUSED');
      return {} as never;
    });
    sseTransport.mockImplementation((url: URL) => {
      if (url.hostname === 'dead.example.com') throw new Error('ECONNREFUSED');
      return {} as never;
    });
    await Connector.create({
      scope: 'platform',
      name: 'dead-connector',
      url: 'https://dead.example.com/mcp',
    });
    await Connector.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    const toolsets = await connectorToolsetsForUser(USER_ID);
    expect(Object.keys(toolsets)).toEqual(['mcp_platform_tools']);
  });

  it('sends the vaulted bearer token for mcp.oauth connectors (#327)', async () => {
    await Connector.create({
      type: 'mcp.oauth',
      scope: 'user',
      userId: USER_ID,
      name: 'oauthed',
      url: 'https://oauthed.example.com/mcp',
      // The crypto mock decrypts to header JSON; oauth reads the vault shape.
      oauth: { iv: 'a', tag: 'b', ciphertext: 'vault' },
    });
    // Vault JSON differs from the pat header; point the mock at the vault.
    const { decryptEnvelope } = jest.requireMock('../../main/services/crypto') as {
      decryptEnvelope: jest.Mock;
    };
    decryptEnvelope.mockReturnValueOnce(
      JSON.stringify({
        accessToken: 'vault-token',
        authorizationServerUrl: 'https://as.example.com',
        expiresAt: Date.now() + 3600_000,
      }),
    );
    await connectorToolsetsForUser(USER_ID);
    expect(streamableTransport).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'https://oauthed.example.com' }),
      { requestInit: { headers: { Authorization: 'Bearer vault-token' } } },
    );
  });

  it('decrypts stored mcp.pat auth headers before connecting', async () => {
    await Connector.create({
      scope: 'user',
      userId: USER_ID,
      name: 'personal',
      url: 'https://personal.example.com/mcp',
      headers: { iv: 'a', tag: 'b', ciphertext: 'c' },
      headersConfigured: true,
    });
    await connectorToolsetsForUser(USER_ID);
    expect(streamableTransport).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'https://personal.example.com' }),
      { requestInit: { headers: { Authorization: 'Bearer from-mock-decrypt' } } },
    );
  });

  it('caches resolutions for one TTL window', async () => {
    await Connector.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    await connectorToolsetsForUser(USER_ID);
    const afterFirst = (Client as unknown as jest.Mock).mock.calls.length;
    await connectorToolsetsForUser(USER_ID);
    expect((Client as unknown as jest.Mock).mock.calls.length).toBe(afterFirst);
  });

  it('does not serve a rejected cached resolution on the next turn', async () => {
    await Connector.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    const findSpy = jest.spyOn(Connector, 'find').mockRejectedValueOnce(new Error('mongo down'));
    await expect(connectorToolsetsForUser(USER_ID)).rejects.toThrow('mongo down');
    // Same TTL window: rebuild fresh, never serve the poisoned cache entry.
    const toolsets = await connectorToolsetsForUser(USER_ID);
    expect(Object.keys(toolsets)).toEqual(['mcp_platform_tools']);
    findSpy.mockRestore();
  });

  it('rebuilds after concurrent callers share one rejected resolution', async () => {
    await Connector.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    const findSpy = jest.spyOn(Connector, 'find').mockRejectedValueOnce(new Error('mongo down'));
    // Racing turns share the stored promise; cleanup clears the poison.
    await Promise.allSettled([
      connectorToolsetsForUser(USER_ID),
      connectorToolsetsForUser(USER_ID),
    ]).then((results) => {
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
    });
    const toolsets = await connectorToolsetsForUser(USER_ID);
    expect(Object.keys(toolsets)).toEqual(['mcp_platform_tools']);
    findSpy.mockRestore();
  });

  it('degrades persistent call failures to an unavailable result', async () => {
    await Connector.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    await connectorToolsetsForUser(USER_ID);
    mockConnect.mockRejectedValue(new Error('boom'));
    mockCallTool.mockRejectedValue(new Error('boom'));
    const result = (await callMcpTool('https://mcp.example.com/mcp', undefined, 'weather', {
      q: 'x',
    })) as { error?: string };
    // The degraded payload names the tool and carries the failure reason.
    // @see #82
    expect(result.error).toContain('weather');
    expect(result.error).toContain('boom');
    expect(result.error).toContain('tell the user');
    expect(result.error).not.toBe('unavailable');
  });

  it('degrades with the fallback wording when the error has no usable message', async () => {
    mockConnect.mockRejectedValue(new Error('   \n  '));
    mockCallTool.mockRejectedValue(new Error(''));
    const result = (await callMcpTool('https://mcp.example.com/mcp', undefined, 'q', {})) as {
      error?: string;
    };
    expect(result.error).toContain('reason unknown');
    expect(result.error).toContain('tell the user');
  });

  it('truncates overlong failure reasons', async () => {
    mockConnect.mockRejectedValue(new Error(`${'x'.repeat(1200)} HTTP 500`));
    mockCallTool.mockRejectedValue(new Error('x'));
    const result = (await callMcpTool('https://mcp.example.com/mcp', undefined, 'q', {})) as {
      error?: string;
    };
    expect(result.error).toContain('Tool q failed to run');
    // Truncated: the tail of the 1200-char message never appears.
    expect(result.error).not.toContain('HTTP 500');
    expect((result.error as string).length).toBeLessThan(500);
  });

  it('short-circuits a retried tool within one completion (#82): no second handshake', async () => {
    await Connector.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    const toolsets = await connectorToolsetsForUser(USER_ID);
    mockConnect.mockRejectedValue(new Error('boom'));
    mockCallTool.mockRejectedValue(new Error('boom'));
    const weather = toolsets.mcp_platform_tools.weather as unknown as {
      execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>>;
    };
    const requestContext = new RequestContext();
    const ctx = { requestContext };
    // First attempt: cached call, fresh-connection retry, then the degrade.
    const first = (await weather.execute({ q: 'x' }, ctx)) as { error?: string };
    expect(first.error).toContain('mcp_platform_tools/weather');
    expect(first.error).toContain('boom');
    expect(toolIsFailed(ctx, 'mcp_platform_tools/weather')).toBe(true);
    const callsAfterFirst = mockCallTool.mock.calls.length; // includes the retry
    // Retry inside the same completion skips callMcpTool entirely.
    const second = await weather.execute({ q: 'y' }, ctx);
    expect(mockCallTool.mock.calls.length).toBe(callsAfterFirst);
    expect(second).toEqual(first);
    // A fresh RequestContext is not blocked: it degrades the same way.
    const retry = (await weather.execute({ q: 'z' }, { requestContext: new RequestContext() })) as {
      error?: string;
    };
    expect(retry.error).toContain('mcp_platform_tools/weather');
    expect(retry.error).toContain('boom');
  });

  it('does not mark a tool failed when it succeeds', async () => {
    await Connector.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    const toolsets = await connectorToolsetsForUser(USER_ID);
    mockCallTool.mockResolvedValue({ content: [{ text: 'sunny' }] });
    const weather = toolsets.mcp_platform_tools.weather as unknown as {
      execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>>;
    };
    const ctx = { requestContext: new RequestContext() };
    await weather.execute({ q: 'x' }, ctx);
    expect(toolIsFailed(ctx, 'mcp_platform_tools/weather')).toBe(false);
  });
});

describe('zodFromJsonSchema', () => {
  it('maps required and optional object properties', () => {
    const schema = zodFromJsonSchema({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text' },
        limit: { type: 'integer' },
        factor: { type: 'number' },
        flag: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
    });
    expect(
      (
        schema.safeParse({
          query: 'x',
          limit: 2,
          factor: 1.5,
          flag: true,
          tags: ['a'],
        }) as { success: boolean }
      ).success,
    ).toBe(true);
    expect((schema.safeParse({ limit: 2 }) as { success: boolean }).success).toBe(false);
  });

  it('degrades unknown schema shapes to any', () => {
    expect(zodFromJsonSchema({ type: 'weird' }).safeParse(7).success).toBe(true);
    expect(zodFromJsonSchema(null).safeParse('x').success).toBe(true);
  });
});
