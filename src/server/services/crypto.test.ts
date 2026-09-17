import { decryptHeader, encryptHeader } from './crypto';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('MCP header envelope crypto (#36)', () => {
  afterEach(() => {
    delete process.env.MCP_ENCRYPTION_KEY;
  });

  it('round-trips a header value', () => {
    process.env.MCP_ENCRYPTION_KEY = KEY;
    const envelope = encryptHeader('Bearer sk-secret-123');
    expect(Buffer.from(envelope.ciphertext, 'base64').toString('utf8')).not.toContain('Bearer');
    expect(decryptHeader(envelope)).toBe('Bearer sk-secret-123');
  });

  it('produces a fresh iv per call (deterministic rebuild, not shared state)', () => {
    process.env.MCP_ENCRYPTION_KEY = KEY;
    const a = encryptHeader('same value');
    const b = encryptHeader('same value');
    expect(a.iv).not.toBe(b.iv);
    expect(decryptHeader(a)).toBe('same value');
    expect(decryptHeader(b)).toBe('same value');
  });

  it('throws on tampering', () => {
    process.env.MCP_ENCRYPTION_KEY = KEY;
    const envelope = encryptHeader('Bearer sk-secret-123');
    const forged = {
      ...envelope,
      ciphertext: Buffer.from('tampered').toString('base64'),
    };
    expect(() => decryptHeader(forged)).toThrow();
  });

  it('throws on corrupted envelope', () => {
    process.env.MCP_ENCRYPTION_KEY = KEY;
    expect(() =>
      decryptHeader({ iv: 'short', tag: Buffer.alloc(16).toString('base64'), ciphertext: 'x' }),
    ).toThrow('corrupt MCP header envelope: bad iv length');
  });

  it('refuses to encrypt without a configured key', () => {
    expect(() => encryptHeader('Bearer sk-secret-123')).toThrow(
      /MCP_ENCRYPTION_KEY not configured/,
    );
  });

  it('refuses to decrypt without a configured key', () => {
    process.env.MCP_ENCRYPTION_KEY = KEY;
    const envelope = encryptHeader('Bearer sk-secret-123');
    delete process.env.MCP_ENCRYPTION_KEY;
    expect(() => decryptHeader(envelope)).toThrow(/MCP_ENCRYPTION_KEY not configured/);
  });
});
