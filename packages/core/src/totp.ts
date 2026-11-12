import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256 } from './crypto.js';

/** Authenticator app codes (TOTP, RFC 6238: HMAC-SHA1, 6 digits, 30 s) and one-time recovery codes. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Geçersiz base32 anahtar');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 as authenticator apps expect it. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, at = Date.now(), step = Math.floor(at / 1000 / PERIOD)): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

/** Accepts the current code and one step either side (phone clocks drift). */
export function verifyTotp(secret: string, code: string, at = Date.now()): boolean {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  const step = Math.floor(at / 1000 / PERIOD);
  let ok = false;
  for (const s of [step - 1, step, step + 1]) ok = timingSafeEqual(Buffer.from(totpCode(secret, at, s)), Buffer.from(given)) || ok;
  return ok;
}

export function totpUri(secret: string, account: string, issuer = 'Project Hub'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${PERIOD}`;
}

/** Ten one-time recovery codes ("abcd-efgh-ijkl") and the hashes to store. */
export function generateRecoveryCodes(count = 10): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: count }, () =>
    base32Encode(randomBytes(8))
      .slice(0, 12)
      .toLowerCase()
      .replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3'),
  );
  return { codes, hashes: codes.map(recoveryCodeHash) };
}

export function recoveryCodeHash(code: string): string {
  return sha256(code.toLowerCase().replace(/[^a-z2-7]/g, ''));
}
