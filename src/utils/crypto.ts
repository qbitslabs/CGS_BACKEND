/* Two-way AES-256-GCM encryption and automatic decryption utility for API keys and tokens.
 * Note: Bcrypt is a one-way password hash and cannot be decrypted.
 * For API tokens that must be sent to Meta Graph API, AES-256-GCM authenticated
 * encryption provides security at rest while allowing auto-decryption on fetch. */
import crypto from 'crypto';
import { env } from '../config/env.js';

const getMasterKey = (): Buffer => {
  const secret =
    process.env.ENCRYPTION_MASTER_KEY ||
    env.INTERNAL_SERVICE_SECRET ||
    env.JWT_SECRET ||
    'cgs-default-secret-salt-key-2026';
  return crypto.createHash('sha256').update(secret).digest();
};

/**
 * Encrypts a sensitive API key or token using AES-256-GCM.
 * Output format: enc:gcm:<iv_hex>:<tag_hex>:<ciphertext_hex>
 */
export const encryptToken = (rawToken: string): string => {
  if (!rawToken || typeof rawToken !== 'string') return rawToken;
  if (rawToken.startsWith('enc:gcm:')) return rawToken;

  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(rawToken, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return `enc:gcm:${iv.toString('hex')}:${tag}:${encrypted}`;
};

/**
 * Automatically decrypts a token stored in the database.
 * If the token is plaintext (legacy / unencrypted), it safely returns as-is.
 */
export const decryptToken = (storedToken: string): string => {
  if (!storedToken || typeof storedToken !== 'string') return storedToken;
  if (!storedToken.startsWith('enc:gcm:')) {
    return storedToken;
  }

  try {
    const parts = storedToken.split(':');
    if (parts.length !== 5) return storedToken;

    const [, , ivHex, tagHex, encryptedHex] = parts;
    const key = getMasterKey();
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err: any) {
    console.error('[Crypto] Failed to decrypt token, returning as-is:', err?.message || err);
    return storedToken;
  }
};
