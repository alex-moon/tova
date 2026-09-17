// Normalised MCP failure: message comes from the server response when one
// arrived, otherwise the call's fallback. Mirrors AdminError (PR #27 review).
export class McpError extends Error {
  constructor(message = 'Something went wrong.', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'McpError';
  }
}
