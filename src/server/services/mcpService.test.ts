import { RequestContext } from '@mastra/core/request-context';
import { McpServer } from '../models/McpServer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  callMcpTool,
  clearMcpCachesForTests,
  mcpToolsetsForUser,
  zodFromJsonSchema,
} from './mcpService';
import { toolIsFailed } from './toolDegrade';

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

  it('does not serve a rejected cached resolution on the next turn', async () => {
    await McpServer.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    const findSpy = jest.spyOn(McpServer, 'find').mockRejectedValueOnce(new Error('mongo down'));
    await expect(mcpToolsetsForUser(USER_ID)).rejects.toThrow('mongo down');
    // Within the same TTL window a fresh resolution must be rebuilt, not
    // served from the poisoned cache entry.
    const toolsets = await mcpToolsetsForUser(USER_ID);
    expect(Object.keys(toolsets)).toEqual(['mcp_platform_tools']);
    findSpy.mockRestore();
  });

  it('rebuilds after concurrent callers share one rejected resolution', async () => {
    await McpServer.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    const findSpy = jest.spyOn(McpServer, 'find').mockRejectedValueOnce(new Error('mongo down'));
    // Two turns racing inside one TTL window share the stored promise, so
    // both observe the rejection; the poisoned entry must nevertheless be
    // gone once either caller's cleanup runs.
    await Promise.allSettled([mcpToolsetsForUser(USER_ID), mcpToolsetsForUser(USER_ID)]).then(
      (results) => {
        expect(results.every((r) => r.status === 'rejected')).toBe(true);
      },
    );
    const toolsets = await mcpToolsetsForUser(USER_ID);
    expect(Object.keys(toolsets)).toEqual(['mcp_platform_tools']);
    findSpy.mockRestore();
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
    const result = (await callMcpTool('https://mcp.example.com/mcp', undefined, 'weather', {
      q: 'x',
    })) as { error?: string };
    // #82: the degraded payload names the tool, carries the failure reason,
    // and tells the model to surface the failure — not the bare
    // `{ error: 'unavailable' }` that the model could not distinguish from
    // an empty result.
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
    await McpServer.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    const toolsets = await mcpToolsetsForUser(USER_ID);
    mockConnect.mockRejectedValue(new Error('boom'));
    mockCallTool.mockRejectedValue(new Error('boom'));
    const weather = toolsets.mcp_platform_tools.weather as unknown as {
      execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>>;
    };
    const requestContext = new RequestContext();
    const ctx = { requestContext };
    // First attempt: full path — cached-client call, retry on a fresh
    // connection, then the degraded result and the mark.
    const first = (await weather.execute({ q: 'x' }, ctx)) as { error?: string };
    expect(first.error).toContain('mcp_platform_tools/weather');
    expect(first.error).toContain('boom');
    expect(toolIsFailed(ctx, 'mcp_platform_tools/weather')).toBe(true);
    const callsAfterFirst = mockCallTool.mock.calls.length; // includes the retry
    // Retry inside the same completion skips callMcpTool entirely.
    const second = await weather.execute({ q: 'y' }, ctx);
    expect(mockCallTool.mock.calls.length).toBe(callsAfterFirst);
    expect(second).toEqual(first);
    // A fresh RequestContext (a new completion) is not blocked: it goes
    // through callMcpTool again and degrades the same way.
    const retry = (await weather.execute({ q: 'z' }, { requestContext: new RequestContext() })) as {
      error?: string;
    };
    expect(retry.error).toContain('mcp_platform_tools/weather');
    expect(retry.error).toContain('boom');
  });

  it('does not mark a tool failed when it succeeds', async () => {
    await McpServer.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    const toolsets = await mcpToolsetsForUser(USER_ID);
    mockCallTool.mockResolvedValue({ content: [{ text: 'sunny' }] });
    const weather = toolsets.mcp_platform_tools.weather as unknown as {
      execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>>;
    };
    const ctx = { requestContext: new RequestContext() };
    await weather.execute({ q: 'x' }, ctx);
    expect(toolIsFailed(ctx, 'mcp_platform_tools/weather')).toBe(false);
  });
});

<<<<<<< HEAD
describe('#77 MCP tool budget (user-scope toolsets)', () => {
  let warnSpy: jest.SpyInstance | undefined;
  afterEach(() => {
    delete process.env.MCP_TOOL_BUDGET_TOKENS;
    warnSpy?.mockRestore();
    warnSpy = undefined;
  });

  it('#109: DeepInfra turns attach user tools unaudited — no budget, no warn', async () => {
    // Default env (1500-token budget) yet every user tool attaches whole:
    // the budget is a Groq-TPM mitigation, not a DeepInfra policy.
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await McpServer.create({
      scope: 'user',
      userId: USER_ID,
      name: 'github',
      url: 'https://github.example.com/mcp',
    });
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: 'create_issue',
          description: 'Create a new issue in a GitHub repository'.repeat(3),
          inputSchema: { type: 'object', properties: { number: { type: 'string' } } },
        },
        { name: 'tiny', description: 'x', inputSchema: {} },
        { name: 'fat', description: 'h'.repeat(4000), inputSchema: { type: 'object' } },
      ],
    });
    const toolsets = await mcpToolsetsForUser(USER_ID, { provider: 'deepinfra' });
    expect(Object.keys(toolsets.mcp_github)).toEqual(['create_issue', 'tiny', 'fat']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('#109: an explicit MCP_TOOL_BUDGET_TOKENS override also applies to DeepInfra', async () => {
    // Operator intent beats provider heuristics: the override forces the
    // budget back on for every provider.
    process.env.MCP_TOOL_BUDGET_TOKENS = '10';
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await McpServer.create({
      scope: 'user',
      userId: USER_ID,
      name: 'github',
      url: 'https://github.example.com/mcp',
    });
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: 'create_issue',
          description: 'Create a new issue in a GitHub repository'.repeat(3),
          inputSchema: { type: 'object', properties: { number: { type: 'string' } } },
        },
      ],
    });
    const toolsets = await mcpToolsetsForUser(USER_ID, { provider: 'deepinfra' });
    expect(toolsets).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropped 1 user tool'));
  });

  it('#109: Groq turns keep the budget when the provider is tagged explicitly', async () => {
    // Same setup as #77 cases, but via the new provider path rather than
    // the un-tagged default.
    process.env.MCP_TOOL_BUDGET_TOKENS = '10';
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await McpServer.create({
      scope: 'user',
      userId: USER_ID,
      name: 'github',
      url: 'https://github.example.com/mcp',
    });
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: 'create_issue',
          description: 'Create a new issue in a GitHub repository'.repeat(3),
          inputSchema: { type: 'object', properties: { number: { type: 'string' } } },
        },
      ],
    });
    const toolsets = await mcpToolsetsForUser(USER_ID, { provider: 'groq' });
    expect(toolsets).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropped 1 user tool'));
=======
describe('#109 user toolsets attach unaudited (budget removed)', () => {
  it('attaches every user tool whole even when the serialized schemas are large', async () => {
    // Pre-#109 removal: the Groq-TPM token budget would have dropped `fat`
    // (and, at the 1500 default, `create_issue` too). With the budget gone no
    // user tool may be dropped or warned about, ever.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await McpServer.create({
        scope: 'user',
        userId: USER_ID,
        name: 'github',
        url: 'https://github.example.com/mcp',
      });
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: 'create_issue',
            description: 'Create a new issue in a GitHub repository'.repeat(3),
            inputSchema: { type: 'object', properties: { number: { type: 'string' } } },
          },
          { name: 'tiny', description: 'x', inputSchema: {} },
          { name: 'fat', description: 'h'.repeat(4000), inputSchema: { type: 'object' } },
        ],
      });
      const toolsets = await mcpToolsetsForUser(USER_ID);
      expect(Object.keys(toolsets.mcp_github)).toEqual(['create_issue', 'tiny', 'fat']);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
>>>>>>> feat/109-no-mcp
  });

  it('still deduplicates tools of the same name within one toolset', async () => {
    await McpServer.create({
      scope: 'user',
      userId: USER_ID,
      name: 'github',
      url: 'https://github.example.com/mcp',
    });
    mockListTools.mockResolvedValue({
      tools: [
        { name: 'create_issue', description: 'a', inputSchema: { type: 'object' } },
        { name: 'create_issue', description: 'b', inputSchema: { type: 'object' } },
      ],
    });
    const toolsets = await mcpToolsetsForUser(USER_ID);
    expect(Object.keys(toolsets.mcp_github)).toEqual(['create_issue']);
  });

  it('does not budget platform toolsets (they attach exactly like user tools)', async () => {
    await McpServer.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://mcp.example.com/mcp',
    });
    await McpServer.create({
      scope: 'user',
      userId: USER_ID,
      name: 'fat',
      url: 'https://fat.example.com/mcp',
    });
    mockListTools.mockResolvedValue({
      tools: [{ name: 'huge', description: 'h'.repeat(4000), inputSchema: { type: 'object' } }],
    });
    const toolsets = await mcpToolsetsForUser(USER_ID);
    expect(Object.keys(toolsets.mcp_platform_tools)).toEqual(['huge']);
    expect(Object.keys(toolsets.mcp_fat)).toEqual(['huge']);
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
