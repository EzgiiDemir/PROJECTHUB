import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { acquireDevWorkerLease } from '../src/dev-worker-lease.js';
import { freshDatabase } from '../../../test/support/db.js';

function fixture(acquired = true) {
  const client = { query: vi.fn().mockResolvedValue({ rows: [{ acquired }] }), release: vi.fn() };
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  return { client, pool: pool as unknown as pg.Pool, connect: pool.connect };
}

describe('local development worker exclusivity', () => {
  it('holds one connection until shutdown and unlocks only once', async () => {
    const f = fixture();
    const release = await acquireDevWorkerLease(f.pool, 'host-a', 'development');
    expect(f.client.release).not.toHaveBeenCalled();
    await release(); await release();
    expect(f.client.query).toHaveBeenCalledTimes(2);
    expect(f.client.release).toHaveBeenCalledTimes(1);
  });
  it('refuses the duplicate without leaking its connection', async () => {
    const f = fixture(false);
    await expect(acquireDevWorkerLease(f.pool, 'host-a', 'development')).rejects.toThrow('İkinci worker');
    expect(f.client.release).toHaveBeenCalledTimes(1);
  });
  it('does not constrain production horizontal scaling or test harnesses', async () => {
    const f = fixture();
    await (await acquireDevWorkerLease(f.pool, 'host-a', 'production'))();
    await (await acquireDevWorkerLease(f.pool, 'host-a', 'test'))();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('excludes a second process connection on real PostgreSQL and permits restart after release', async () => {
    const h = await freshDatabase();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireDevWorkerLease(h.pool, 'regression-local-host', 'development');
      await expect(acquireDevWorkerLease(h.pool, 'regression-local-host', 'development')).rejects.toThrow('İkinci worker');
      await release();
      release = await acquireDevWorkerLease(h.pool, 'regression-local-host', 'development');
    } finally {
      await release?.();
      await h.close();
    }
  });
});
