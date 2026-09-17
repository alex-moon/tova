import crypto from 'crypto';

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
