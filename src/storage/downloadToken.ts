import crypto from 'crypto';
import { env } from '../config/env';

/**
 * Signs and verifies short-lived, HMAC-secured download tokens.
 *
 * A token is a base64url-encoded JSON payload plus an HMAC-SHA256 signature.
 * No third-party library needed — Node's built-in `crypto` is sufficient and
 * keeps the dependency surface small.
 *
 * Format (after base64url decode): `<base64url(payload)>.<hex-signature>`
 *
 * Why not JWT here? JWTs are for identity assertions (the auth middleware uses
 * them). These tokens are single-purpose, short-lived, and opaque to clients —
 * a simpler HMAC scheme is easier to reason about and audit.
 */

export interface DownloadTokenPayload {
  auditId: string;
  attachmentId: string;
  /** Unix epoch seconds — checked on verify. */
  exp: number;
}

function sign(data: string): string {
  return crypto
    .createHmac('sha256', env.DOWNLOAD_TOKEN_SECRET)
    .update(data)
    .digest('hex');
}

function toBase64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}

function fromBase64url(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

export function issueDownloadToken(auditId: string, attachmentId: string): string {
  const payload: DownloadTokenPayload = {
    auditId,
    attachmentId,
    exp: Math.floor(Date.now() / 1000) + env.DOWNLOAD_TOKEN_TTL_SECONDS,
  };
  const encoded = toBase64url(JSON.stringify(payload));
  const sig = sign(encoded);
  return `${encoded}.${sig}`;
}

export type VerifyResult =
  | { ok: true; payload: DownloadTokenPayload }
  | { ok: false; reason: 'invalid' | 'expired' };

export function verifyDownloadToken(token: string): VerifyResult {
  const dotIndex = token.lastIndexOf('.');
  if (dotIndex === -1) return { ok: false, reason: 'invalid' };

  const encoded = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);
  const expectedSig = sign(encoded);

  // Constant-time comparison to prevent timing attacks.
  if (!crypto.timingSafeEqual(Buffer.from(providedSig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
    return { ok: false, reason: 'invalid' };
  }

  let payload: DownloadTokenPayload;
  try {
    payload = JSON.parse(fromBase64url(encoded)) as DownloadTokenPayload;
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  if (Math.floor(Date.now() / 1000) > payload.exp) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload };
}