import crypto from 'crypto';

/*
 * AES-256-GCM envelope encryption for user-supplied MCP auth header values
 * (issue #36). Header values are never stored in plaintext: the Mongo doc
 * keeps `{ iv, tag, ciphertext }` and toJSON strips the envelope entirely.
 *
 * The key comes from MCP_ENCRYPTION_KEY. Accepts 32 random bytes base64…
 */
const KEY_ENV = 'MCP_ENCRYPTION_KEY';
const IV_BYTES = 12;

function loadKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    throw new Error(`${KEY_ENV} not configured — refusing to store MCP auth headers in plaintext`);
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`${KEY_ENV} must be exactly 32 bytes base64-encoded`);
  }
  return key;
}

function decodeEnvelope(envelope: { iv: string; tag: string; ciphertext: string }): {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
} {
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  if (iv.length !== IV_BYTES) throw new Error('corrupt MCP header envelope: bad iv length');
  return { iv, tag, ciphertext };
}

export type HeaderEnvelope = { iv: string; tag: string; ciphertext: string };

export function encryptHeader(value: string): HeaderEnvelope {
  const key = loadKey();
  const iv = crypto.randomBytes(IV_BYTES);
  // authTagLength pinned at construction, not just getAuthTag(): the
  // decrypter must reject shorter-than-16-byte tags rather than accept them
  // (semgrep gcm-no-tag-length).
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export const MCP_ENCRYPTION_KEY_ENV_VAR = 'MCP_ENCRYPTION_KEY';

export interface EncryptedEnvelope {
  iv: string;
  tag: string;
  ciphertext: string;
}

// Key resolution: the raw env value is stretched to 32 bytes with SHA-256 so
// operators can supply any passphrase-format key without a separate
// "must be exactly 64 hex chars" failure mode.
const derivedKey = (keyMaterial: string): Buffer =>
  crypto.createHash('sha256').update(keyMaterial, 'utf8').digest();

const resolveKey = (): Buffer => {
  const keyMaterial = process.env[MCP_ENCRYPTION_KEY_ENV_VAR];
  if (!keyMaterial) {
    throw new Error(
      `${MCP_ENCRYPTION_KEY_ENV_VAR} is not set; MCP server auth headers cannot be stored encrypted`,
    );
  }
  return derivedKey(keyMaterial);
};

export const encryptEnvelope = (plaintext: string): EncryptedEnvelope => {
  const iv = crypto.randomBytes(12);
  // authTagLength pinned at construction, not just getAuthTag(): the
  // decrypter must reject shorter-than-16-byte tags rather than accept them
  // (semgrep gcm-no-tag-length).
  const cipher = crypto.createCipheriv('aes-256-gcm', resolveKey(), iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
};

export function decryptHeader(envelope: HeaderEnvelope): string {
  const key = loadKey();
  const { iv, tag, ciphertext } = decodeEnvelope(envelope);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export const decryptEnvelope = (envelope: EncryptedEnvelope): string => {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    resolveKey(),
    Buffer.from(envelope.iv, 'base64'),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
};
