import axios from 'axios';
import { McpError } from '../types/mcp';

export type McpServerScope = 'platform' | 'user';
export type McpServerStatus = 'connected' | 'unreachable' | 'never-tested';

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpServerInfo {
  id: string;
  scope: McpServerScope;
  name: string;
  url: string;
  status: McpServerStatus;
  headersConfigured: boolean;
  tools: McpToolInfo[];
}

export interface McpServerAddInput {
  name: string;
  url: string;
  authToken?: string;
}

const toMcpError = (err: unknown, fallback: string): McpError => {
  if (axios.isAxiosError(err)) {
    const message = (err.response?.data as { message?: string } | undefined)?.message;
    if (message) return new McpError(message, { cause: err });
  }
  return new McpError(fallback, { cause: err });
};

// Connector separating views from axios; personal MCP servers only, per the
// auth-connector convention (PR #27 review). Platform servers are part of
// the GET payload but read-only by API design.
const McpServerService = {
  async list(): Promise<McpServerInfo[]> {
    try {
      const res = await axios.get<{ servers: McpServerInfo[] }>('/api/mcp-servers');
      return res.data.servers;
    } catch (err) {
      throw toMcpError(err, 'Could not load MCP servers.');
    }
  },

  async add(input: McpServerAddInput): Promise<McpServerInfo> {
    try {
      const res = await axios.post<{ server: McpServerInfo }>('/api/mcp-servers', input);
      return res.data.server;
    } catch (err) {
      throw toMcpError(err, 'Could not add MCP server.');
    }
  },

  async remove(id: string): Promise<void> {
    try {
      await axios.delete(`/api/mcp-servers/${id}`);
    } catch (err) {
      throw toMcpError(err, 'Could not remove MCP server.');
    }
  },
};

export default McpServerService;
