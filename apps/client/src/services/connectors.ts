import axios from 'axios';
import type {
  ConnectorAddInput,
  ConnectorInfo,
  ConnectorOAuthCallbackInput,
  ConnectorOAuthStartInput,
} from '@shared/connectors';

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

// StrictMode (dev) double-fires the callback effect: two completeOAuth calls
// for the same state must share one request, not race two token exchanges
// (the provider's code is single-use).
const inflightComplete = new Map<string, Promise<ConnectorInfo>>();

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

  // OAuth connect flow (#327): start returns the provider consent URL the
  // browser must be redirected to; complete exchanges the relayed code for
  // the stored connector; reauth restarts consent for a dead grant.
  async startOAuth(input: ConnectorOAuthStartInput): Promise<string> {
    try {
      const res = await axios.post<{ authorizationUrl: string }>(
        '/api/connectors/oauth/start',
        input,
      );
      return res.data.authorizationUrl;
    } catch (err) {
      throw toConnectorError(err, 'Could not start sign-in.');
    }
  },

  async completeOAuth(input: ConnectorOAuthCallbackInput): Promise<ConnectorInfo> {
    const inflight = inflightComplete.get(input.state);
    if (inflight) return inflight;
    const request = axios
      .post<{ connector: ConnectorInfo }>('/api/connectors/oauth/callback', input)
      .then((res) => res.data.connector)
      .finally(() => inflightComplete.delete(input.state))
      .catch((err) => {
        throw toConnectorError(err, 'Could not complete sign-in.');
      });
    inflightComplete.set(input.state, request as Promise<ConnectorInfo>);
    return request;
  },

  async reauth(id: string): Promise<string> {
    try {
      const res = await axios.post<{ authorizationUrl: string }>(
        `/api/connectors/${id}/reauth`,
        {},
      );
      return res.data.authorizationUrl;
    } catch (err) {
      throw toConnectorError(err, 'Could not start re-connect.');
    }
  },
};

export default ConnectorService;
