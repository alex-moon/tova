"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.decryptEnvelope = exports.encryptEnvelope = exports.MCP_ENCRYPTION_KEY_ENV_VAR = void 0;
const crypto_1 = __importDefault(require("crypto"));
exports.MCP_ENCRYPTION_KEY_ENV_VAR = 'MCP_ENCRYPTION_KEY';
/*
 * AES-256-GCM envelope encryption for user-supplied MCP auth tokens
 * (issues #36, #80). Tokens must be decryptable — the server replays the
 * plaintext in the Authorization header on every MCP call — so a one-way
 * hash (bcrypt et al.) is not an option; reversible encryption is required.
 * Tokens are never stored in plaintext: the Mongo doc keeps
 * `{ iv, tag, ciphertext }` and toJSON strips the envelope entirely.
 * Long term, Atlas encrypted-at-rest could replace this scheme (#80).
 *
 * Key resolution: the raw env value is stretched to 32 bytes with SHA-256 so
 * operators can supply any passphrase-format key without a separate
 * "must be exactly 64 hex chars" failure mode.
 */
const derivedKey = (keyMaterial) => crypto_1.default.createHash('sha256').update(keyMaterial, 'utf8').digest();
const resolveKey = () => {
    const keyMaterial = process.env[exports.MCP_ENCRYPTION_KEY_ENV_VAR];
    if (!keyMaterial) {
        throw new Error(`${exports.MCP_ENCRYPTION_KEY_ENV_VAR} is not set; MCP server auth headers cannot be stored encrypted`);
    }
    return derivedKey(keyMaterial);
};
const encryptEnvelope = (plaintext) => {
    const iv = crypto_1.default.randomBytes(12);
    // authTagLength pinned at construction, not just getAuthTag(): the
    // decrypter must reject shorter-than-16-byte tags rather than accept them
    // (semgrep gcm-no-tag-length).
    const cipher = crypto_1.default.createCipheriv('aes-256-gcm', resolveKey(), iv, { authTagLength: 16 });
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
    };
};
exports.encryptEnvelope = encryptEnvelope;
const decryptEnvelope = (envelope) => {
    const decipher = crypto_1.default.createDecipheriv('aes-256-gcm', resolveKey(), Buffer.from(envelope.iv, 'base64'), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
    ]).toString('utf8');
};
exports.decryptEnvelope = decryptEnvelope;
