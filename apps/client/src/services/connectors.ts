import axios from 'axios';
import type { ConnectorAddInput, ConnectorInfo } from '@shared/connectors';

// Normalised connector-registry failure: message comes from the server
// response when one arrived, otherwise the call's fallback. (Formerly
// McpError in types/mcp.ts — died into the shared-contract move, #329;
// mirrors AdminError from the PR #27 review.)
export class ConnectorError extends Error {
  constructor(message = 'Something went wrong.', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConnectorError';
  }
}

const toConnectorError = (err: unknown, fallback: string): ConnectorError => {
  if (axios.isAxiosError(err)) {
    const message = (err.response?.data as { message?: string } | undefined)?.message;
    if (message) return new ConnectorError(message, { cause: err });
  }
  return new ConnectorError(fallback, { cause: err });
};

// Service separating views from axios; the connector registry (personal
// connectors writable, platform rows read-only per API design, #329).
const ConnectorService = {
  async list(): Promise<ConnectorInfo[]> {
    try {
      const res = await axios.get<{ connectors: ConnectorInfo[] }>('/api/connectors');
      return res.data.connectors;
    } catch (err) {
      throw toConnectorError(err, 'Could not load connectors.');
    }
  },

  async add(input: ConnectorAddInput): Promise<ConnectorInfo> {
    try {
      const res = await axios.post<{ connector: ConnectorInfo }>('/api/connectors', input);
      return res.data.connector;
    } catch (err) {
      throw toConnectorError(err, 'Could not add connector.');
    }
  },

  async remove(id: string): Promise<void> {
    try {
      await axios.delete(`/api/connectors/${id}`);
    } catch (err) {
      throw toConnectorError(err, 'Could not remove connector.');
    }
  },
};

export default ConnectorService;
