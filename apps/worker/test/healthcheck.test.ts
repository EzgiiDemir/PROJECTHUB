import { describe, expect, it } from 'vitest';
import { isWorkerAlive } from '../src/healthcheck.js';

describe('worker container liveness', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const row = { hostname: 'own-container', pid: 7, last_seen_at: new Date(now - 15_000) };
  it('accepts a fresh heartbeat and live process in this container', () => {
    expect(isWorkerAlive(row, row.hostname, now, () => true)).toBe(true);
  });
  it.each([
    { ...row, hostname: 'other-container' },
    { ...row, pid: 1 },
    { ...row, pid: -7 },
    { ...row, last_seen_at: new Date(now - 46_000) },
    { ...row, last_seen_at: new Date(now + 6_000) },
    { ...row, last_seen_at: 'invalid' },
  ])('rejects foreign, stale or invalid evidence: %j', (candidate) => {
    expect(isWorkerAlive(candidate, row.hostname, now, () => true)).toBe(false);
  });
  it('rejects a stopped process despite a fresh database heartbeat', () => {
    expect(isWorkerAlive(row, row.hostname, now, () => false)).toBe(false);
  });
});
