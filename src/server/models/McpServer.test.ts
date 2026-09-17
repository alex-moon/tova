import mongoose from 'mongoose';
import { McpServer } from './McpServer';

describe('McpServer model', () => {
  it('strips the headers envelope from toJSON output', async () => {
    const doc = new McpServer({
      scope: 'user',
      userId: new mongoose.Types.ObjectId(),
      name: 'mine',
      url: 'https://mcp.example.com',
      headers: { iv: 'a', tag: 'b', ciphertext: 'c' },
      headersConfigured: true,
    });
    expect(doc.toJSON().headers).toBeUndefined();
    expect(doc.toJSON().headersConfigured).toBe(true);
    // The in-memory document still carries the envelope for decryption.
  });

  it('defaults scope-driven fields', async () => {
    const doc = new McpServer({
      scope: 'platform',
      name: 'builtin',
      url: 'https://mcp.tova.dev',
    });
    expect(doc.userId).toBeNull();
    expect(doc.headersConfigured).toBe(false);
    expect(doc.headers).toBeNull();
    expect(doc.tools).toEqual([]);
    expect(doc.status).toBe('never-tested');
    expect(doc.enabled).toBe(true);
  });

  it('persists and keeps the user-scope unique index on url', async () => {
    const userId = new mongoose.Types.ObjectId();
    await McpServer.create({
      scope: 'user',
      userId,
      name: 'first',
      url: 'https://mcp.example.com',
    });
    await McpServer.create({
      scope: 'user',
      userId: new mongoose.Types.ObjectId(),
      name: 'same-url-different-user',
      url: 'https://mcp.example.com',
    });
    await expect(
      McpServer.create({
        scope: 'user',
        userId,
        name: 'dup',
        url: 'https://mcp.example.com',
      }),
    ).rejects.toThrow(/duplicate key/u);
    // Same URL at platform scope does not collide with user scope.
    await expect(
      McpServer.create({
        scope: 'platform',
        name: 'platform-same-url',
        url: 'https://mcp.example.com',
      }),
    ).resolves.toBeTruthy();
  });

  it('rejects an unknown status value', async () => {
    const doc = new McpServer({
      scope: 'platform',
      name: 'bad',
      url: 'https://mcp.example.com',
      status: 'exploded',
    });
    await expect(doc.validate()).rejects.toThrow();
  });
});
