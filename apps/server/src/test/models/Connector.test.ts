import mongoose from 'mongoose';
import { Connector } from '../../main/models/Connector';

describe('Connector model', () => {
  beforeAll(async () => {
    // Mongoose builds indexes asynchronously; await explicitly so the duplicate-key expectation is deterministic under CI load.
    await Connector.init();
  });

  it('strips the headers envelope from toJSON output', async () => {
    const doc = new Connector({
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
    const doc = new Connector({
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
    await Connector.create({
      scope: 'user',
      userId,
      name: 'first',
      url: 'https://mcp.example.com',
    });
    await Connector.create({
      scope: 'user',
      userId: new mongoose.Types.ObjectId(),
      name: 'same-url-different-user',
      url: 'https://mcp.example.com',
    });
    await expect(
      Connector.create({
        scope: 'user',
        userId,
        name: 'dup',
        url: 'https://mcp.example.com',
      }),
    ).rejects.toThrow(/duplicate key/u);
    // Same URL at platform scope does not collide with user scope.
    await expect(
      Connector.create({
        scope: 'platform',
        name: 'platform-same-url',
        url: 'https://mcp.example.com',
      }),
    ).resolves.toBeTruthy();
  });

  it('rejects an unknown status value', async () => {
    const doc = new Connector({
      scope: 'platform',
      name: 'bad',
      url: 'https://mcp.example.com',
      status: 'exploded',
    });
    await expect(doc.validate()).rejects.toThrow();
  });

  it('defaults type to mcp.pat so pre-migration rows behave unchanged (#329)', async () => {
    const doc = new Connector({
      scope: 'user',
      userId: new mongoose.Types.ObjectId(),
      name: 'pre-migration',
      url: 'https://mcp.example.com',
    });
    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.type).toBe('mcp.pat');
  });

  it('accepts the mcp.oauth type and defaults grant health to ok (#327)', async () => {
    const doc = new Connector({
      scope: 'user',
      userId: new mongoose.Types.ObjectId(),
      name: 'oauthed',
      url: 'https://mcp.notion.com/mcp',
      type: 'mcp.oauth',
      oauth: { iv: 'a', tag: 'b', ciphertext: 'c' },
      authState: 'ok',
    });
    await expect(doc.validate()).resolves.toBeUndefined();
    // Both vault envelopes are stripped on the wire; authState is visible.
    const json = doc.toJSON();
    expect(json.oauth).toBeUndefined();
    expect(json.headers).toBeUndefined();
    expect(json.authState).toBe('ok');
  });

  it('rejects an out-of-enum authState (#327)', async () => {
    const doc = new Connector({
      scope: 'user',
      userId: new mongoose.Types.ObjectId(),
      name: 'bad-state',
      url: 'https://mcp.example.com',
      authState: 'revoked' as never,
    });
    await expect(doc.validate()).rejects.toThrow();
  });

  it('rejects connector types outside the storable enum (#329)', async () => {
    // Only mcp.pat is storable for now.
    // @see #329 #327
    const doc = new Connector({
      scope: 'user',
      userId: new mongoose.Types.ObjectId(),
      name: 'bad-type',
      url: 'https://mcp.example.com',
      // Runtime value the static enum cannot express yet; the model must still refuse it.
      type: 'api' as unknown as 'mcp.pat',
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
      const doc = new Connector({
        scope: 'user',
        userId: new mongoose.Types.ObjectId(),
        name: 'bad-url',
        url: badUrl,
      });
      await expect(doc.validate()).rejects.toThrow(/valid https URL/u);
    }
  });

  it('accepts a valid https url', async () => {
    const doc = new Connector({
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
      new Connector({
        scope: 'user',
        name: 'ownerless',
        url: 'https://mcp.example.com',
      }).validate(),
    ).rejects.toThrow(/ownership mismatch/u);
    await expect(
      new Connector({
        scope: 'platform',
        userId: new mongoose.Types.ObjectId(),
        name: 'owned-platform',
        url: 'https://mcp.example.com',
      }).validate(),
    ).rejects.toThrow(/ownership mismatch/u);
  });
});
