import { describe, it, expect, vi, afterEach } from 'vitest';
import { issueDownloadToken, verifyDownloadToken } from '../../src/storage/downloadToken';

afterEach(() => {
  vi.useRealTimers();
});

describe('issueDownloadToken / verifyDownloadToken', () => {
  it('issues a token that verifies successfully', () => {
    const token = issueDownloadToken('audit-1', 'attach-1');
    const result = verifyDownloadToken(token);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.auditId).toBe('audit-1');
      expect(result.payload.attachmentId).toBe('attach-1');
    }
  });

  it('returns invalid for a tampered token', () => {
    const token = issueDownloadToken('audit-1', 'attach-1');
    const tampered = token.slice(0, -4) + 'xxxx';
    const result = verifyDownloadToken(tampered);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid');
    }
  });

  it('returns invalid for a completely malformed token', () => {
    const result = verifyDownloadToken('not-a-valid-token');
    expect(result.ok).toBe(false);
  });

  it('returns expired when token TTL has passed', () => {
    vi.useFakeTimers();

    const token = issueDownloadToken('audit-1', 'attach-1');

    // Advance time past the TTL (default 300s)
    vi.advanceTimersByTime(301 * 1000);

    const result = verifyDownloadToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired');
    }
  });
});