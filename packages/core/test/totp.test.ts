import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateRecoveryCodes, recoveryCodeHash, totpCode, verifyTotp } from '../src/index.js';

// RFC 6238 appendix B (SHA-1 seed "12345678901234567890"); authenticator apps show the last 6 digits.
const SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('authenticator app codes (TOTP)', () => {
  it('matches the RFC 6238 test vectors', () => {
    expect(SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(SECRET).toString()).toBe('12345678901234567890');
    expect(totpCode(SECRET, 59_000)).toBe('287082');
    expect(totpCode(SECRET, 1_111_111_109_000)).toBe('081804');
    expect(totpCode(SECRET, 1_234_567_890_000)).toBe('005924');
    expect(totpCode(SECRET, 2_000_000_000_000)).toBe('279037');
  });

  it('accepts one step of clock drift either side, nothing more', () => {
    const now = 1_234_567_890_000;
    expect(verifyTotp(SECRET, totpCode(SECRET, now - 30_000), now)).toBe(true);
    expect(verifyTotp(SECRET, totpCode(SECRET, now + 30_000), now)).toBe(true);
    expect(verifyTotp(SECRET, totpCode(SECRET, now - 90_000), now)).toBe(false);
    expect(verifyTotp(SECRET, 'abcdef', now)).toBe(false);
  });

  it('recovery codes are unique and match regardless of case and dashes', () => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
    expect(recoveryCodeHash(codes[0]!.toUpperCase().replace(/-/g, ' '))).toBe(hashes[0]);
  });
});
