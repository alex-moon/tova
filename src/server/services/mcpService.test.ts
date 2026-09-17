import { McpServer } from '../models/McpServer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  callMcpTool,
  clearMcpCachesForTests,
  mcpToolsetsForUser,
  zodFromJsonSchema,
} from './mcpService';

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

// Transport mocks must export genuinely constructable values (the client
// does `new StreamableHTTPClientTransport(...)`), so a jest.fn whose mock
// implementation delegates to the per-test `streamableTransport` spy below.
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

jest.mock('./crypto', () => ({
  decryptEnvelope: jest.fn(() => JSON.stringify({ Authorization: 'Bearer from-mock-decrypt' })),
}));

const USER_ID = '507f1f77bcf86cd799439011';

beforeEach(() => {
  clearMcpCachesForTests();
  mockListTools.mockClear().mockResolvedValue(LIST_TOOLS_RESULT);
  mockCallTool.mockReset();
  mockConnect.mockClear().mockResolvedValue(undefined);
  mockClose.mockClear().mockResolvedValue(undefined);
  (Client as unknown as jest.Mock).mockClear();
  streamableTransport.mockReset().mockImplementation(() => ({}) as never);
  sseTransport.mockReset().mockImplementation(() => ({}) as never);
});

describe('mcpService', () => {
  it('returns no toolsets for a user with no MCP servers', async () => {
    const toolsets = await mcpToolsetsForUser(USER_ID);
    expect(toolsets).toEqual({});
  });

  it('exposes one toolset per platform server with wrapped tools', async () => {
    await McpServer.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    const toolsets = await mcpToolsetsForUser(USER_ID);
    // Server name sanitization keeps the toolset key stable and prefixed.
    expect(Object.keys(toolsets)).toEqual(['mcp_platform_tools']);
    expect(Object.keys(toolsets.mcp_platform_tools)).toEqual([
      'weather',
      'surf_board.shaper.build',
    ]);
  });

  it('skips servers whose handshake fails', async () => {
    // A dead host fails both transport attempts (streamable then the SSE
    // fallback), so it is skipped from the toolset entirely.
    streamableTransport.mockImplementation((url: URL) => {
      if (url.hostname === 'dead.example.com') throw new Error('ECONNREFUSED');
      return {} as never;
    });
    sseTransport.mockImplementation((url: URL) => {
      if (url.hostname === 'dead.example.com') throw new Error('ECONNREFUSED');
      return {} as never;
    });
    await McpServer.create({
      scope: 'platform',
      name: 'dead-server',
      url: 'https://dead.example.com/mcp',
    });
    await McpServer.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    const toolsets = await mcpToolsetsForUser(USER_ID);
    expect(Object.keys(toolsets)).toEqual(['mcp_platform_tools']);
  });

  it('decrypts stored auth headers before connecting', async () => {
    await McpServer.create({
      scope: 'user',
      userId: USER_ID,
      name: 'personal',
      url: 'https://personal.example.com/mcp',
      headers: { iv: 'a', tag: 'b', ciphertext: 'c' },
      headersConfigured: true,
    });
    await mcpToolsetsForUser(USER_ID);
    expect(streamableTransport).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'https://personal.example.com' }),
      { requestInit: { headers: { Authorization: 'Bearer from-mock-decrypt' } } },
    );
  });

  it('caches resolutions for one TTL window', async () => {
    await McpServer.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    await mcpToolsetsForUser(USER_ID);
    const afterFirst = (Client as unknown as jest.Mock).mock.calls.length;
    await mcpToolsetsForUser(USER_ID);
    expect((Client as unknown as jest.Mock).mock.calls.length).toBe(afterFirst);
  });

  it('degrades persistent call failures to an unavailable result', async () => {
    await McpServer.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    await mcpToolsetsForUser(USER_ID);
    mockConnect.mockRejectedValue(new Error('boom'));
    mockCallTool.mockRejectedValue(new Error('boom'));
    const result = await callMcpTool('https://mcp.example.com/mcp', undefined, 'weather', {
      q: 'x',
    });
    expect(result).toEqual({ error: 'unavailable' });
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
