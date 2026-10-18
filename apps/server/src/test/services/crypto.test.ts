import {
  decryptEnvelope,
  encryptEnvelope,
  MCP_ENCRYPTION_KEY_ENV_VAR,
} from '../../main/services/crypto';

const setKey = (key: string | undefined) => {
  if (key === undefined) {
    delete process.env[MCP_ENCRYPTION_KEY_ENV_VAR];
  } else {
    process.env[MCP_ENCRYPTION_KEY_ENV_VAR] = key;
  }
};

describe('crypto envelope', () => {
  afterEach(() => {
    setKey(undefined);
  });

  it('throws with the env var name when MCP_ENCRYPTION_KEY is unset', () => {
    expect(() => encryptEnvelope('secret')).toThrow(/MCP_ENCRYPTION_KEY is not set/u);
    expect(() => decryptEnvelope({ iv: 'a', tag: 'b', ciphertext: 'c' })).toThrow(
      /MCP_ENCRYPTION_KEY is not set/u,
    );
  });

  it('round-trips plaintext', () => {
    setKey('test-key');
    const envelope = encryptEnvelope('Bearer xyz; secret: §✓');
    expect(envelope).toEqual({
      iv: expect.any(String),
      tag: expect.any(String),
      ciphertext: expect.any(String),
    });
    expect(envelope.ciphertext).not.toContain('Bearer');
    expect(decryptEnvelope(envelope)).toBe('Bearer xyz; secret: §✓');
  });

  it('produces a fresh iv per call', () => {
    setKey('test-key');
    const a = encryptEnvelope('same value');
    const b = encryptEnvelope('same value');
    expect(a.iv).not.toBe(b.iv);
    expect(decryptEnvelope(a)).toBe('same value');
    expect(decryptEnvelope(b)).toBe('same value');
  });

  it('throws on tampered ciphertext', () => {
    setKey('test-key');
    const envelope = encryptEnvelope('secret');
    const corrupted = {
      ...envelope,
      ciphertext: Buffer.from('tampered').toString('base64'),
    };
    expect(() => decryptEnvelope(corrupted)).toThrow();
  });

  it('throws on a different key (key rotation invalidates old envelopes)', () => {
    setKey('test-key');
    const envelope = encryptEnvelope('secret');
    setKey('other-key');
    expect(() => decryptEnvelope(envelope)).toThrow();
  });

  describe('envelope shape validation (#397)', () => {
    beforeEach(() => setKey('test-key'));

    it('rejects a wrong-length iv with a clear error', () => {
      const envelope = encryptEnvelope('secret');
      expect(() => decryptEnvelope({ ...envelope, iv: 'AAAA' })).toThrow(
        /Malformed encrypted envelope: iv must be 12 bytes/u,
      );
    });

    it('rejects a wrong-length tag with a clear error', () => {
      const envelope = encryptEnvelope('secret');
      expect(() => decryptEnvelope({ ...envelope, tag: 'AAAA' })).toThrow(
        /Malformed encrypted envelope: tag must be 16 bytes/u,
      );
    });

    it('rejects missing fields with a clear error', () => {
      expect(() => decryptEnvelope({ iv: '', tag: 'AAAA', ciphertext: 'x' })).toThrow(
        /Malformed encrypted envelope: iv missing/u,
      );
      const envelope = encryptEnvelope('secret');
      expect(() => decryptEnvelope({ ...envelope, ciphertext: '' })).toThrow(
        /Malformed encrypted envelope: ciphertext missing/u,
      );
    });

    it('reports the missing-key error before shape errors (encrypt parity)', () => {
      setKey(undefined);
      expect(() => decryptEnvelope({ iv: 'a', tag: 'b', ciphertext: 'c' })).toThrow(
        /MCP_ENCRYPTION_KEY is not set/u,
      );
    });
  });
});
