import crypto from 'crypto';
import { env } from '../config/env';

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