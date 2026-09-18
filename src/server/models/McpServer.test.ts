import mongoose from 'mongoose';
import { McpServer } from './McpServer';

describe('McpServer model', () => {
  beforeAll(async () => {
    // Mongoose builds indexes asynchronously on connect; under CI load the
    // unique partial index on (scope, userId, url) may not exist yet when the
    // first write lands. Await the build explicitly so the duplicate-key
    // expectation is deterministic.
    await McpServer.init();
  });

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

  it('rejects non-https, unparsable, and hostname-less urls', async () => {
    for (const badUrl of [
      'http://mcp.example.com/mcp',
      'not a url at all',
      'https://',
      'file:///etc/passwd',
    ]) {
      const doc = new McpServer({
        scope: 'user',
        userId: new mongoose.Types.ObjectId(),
        name: 'bad-url',
        url: badUrl,
      });
      await expect(doc.validate()).rejects.toThrow(/valid https URL/u);
    }
  });

  it('accepts a valid https url', async () => {
    const doc = new McpServer({
      scope: 'user',
      userId: new mongoose.Types.ObjectId(),
      name: 'good',
      url: 'https://mcp.example.com/mcp?x=1',
      headers: { iv: 'a', tag: 'b', ciphertext: 'c' },
      headersConfigured: true,
    });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('requires userId on user scope and forbids it on platform scope', async () => {
    await expect(
      new McpServer({
        scope: 'user',
        name: 'ownerless',
        url: 'https://mcp.example.com',
      }).validate(),
    ).rejects.toThrow(/ownership mismatch/u);
    await expect(
      new McpServer({
        scope: 'platform',
        userId: new mongoose.Types.ObjectId(),
        name: 'owned-platform',
        url: 'https://mcp.example.com',
      }).validate(),
    ).rejects.toThrow(/ownership mismatch/u);
  });
});
