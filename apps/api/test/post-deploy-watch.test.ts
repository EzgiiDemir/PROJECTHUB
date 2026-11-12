import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createLogger, newWorkerId, Storage } from '@projecthub/core';
import { deployments, environments, healthChecks, incidents } from '@projecthub/database';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client as makeClient, startHarness, waitFor, type Harness } from './harness.js';

let h: Harness;
const admin = makeClient(() => h.base);
const slug = 'izleme-projesi';
let staging = '';
let deploymentId = '';
let failing: http.Server;
let failingUrl = '';

beforeAll(async () => {
  h = await startHarness({ worker: true });
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  await admin.post('/projects', { name: 'İzleme Projesi', slug, source: { type: 'empty', template: 'static' } });
  await waitFor(async () => ((await admin.get(`/projects/${slug}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');
  const b = (await admin.post(`/projects/${slug}/builds`, {})).data as { id: string };
  await waitFor(async () => ((await admin.get(`/builds/${b.id}`)).data as { status: string }).status === 'passed', 90_000);
  const versionId = ((await admin.post(`/projects/${slug}/versions`, { version: '1.0.0', buildId: b.id, releaseNotes: '' })).data as { id: string }).id;
  staging = ((await admin.get(`/projects/${slug}/environments`)).data as { id: string; type: string }[]).find((e) => e.type === 'staging')!.id;
  expect((await admin.put(`/projects/${slug}/environments/${staging}/target`, { adapter: 'local', remotePath: path.join(h.config.storageDir, 'deploy-local', 'izleme-staging') })).status).toBe(200);
  deploymentId = ((await admin.post(`/projects/${slug}/deployments`, { environmentId: staging, versionId, runMigrations: false, backup: false })).data as { id: string }).id;
  await waitFor(async () => ((await admin.get(`/deployments/${deploymentId}`)).data as { status: string }).status === 'succeeded', 90_000);
  // The release passed its checks; minutes later the app starts answering 500.
  failing = http.createServer((_req, res) => res.writeHead(500).end('boom'));
  await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
  failingUrl = `http://127.0.0.1:${(failing.address() as AddressInfo).port}`;
  await h.server.handle.db.update(environments).set({ url: failingUrl, monitor: true, consecutiveFailures: 0, lastHealthAt: null }).where(eq(environments.id, staging));
}, 240_000);

afterAll(async () => {
  failing?.close();
  await h?.close();
});

describe('post-deploy watch (canary substitute)', () => {
  it('checks a just-deployed environment every minute and opens an incident after three failures', async () => {
    const { maintenanceTick } = await import('../../worker/dist/jobs/maintenance.js');
    const db = h.server.handle.db;
    const ctx = { config: h.config, db, pool: h.server.handle.pool, storage: new Storage(h.config.storageDir), logger: createLogger('worker', 'silent'), workerId: newWorkerId() };
    const tick = async () => {
      // minute 1: only every-minute tasks run (the 5-minute health monitor does not).
      const results = (await maintenanceTick(ctx as never, { job: { payload: { minute: 1 } }, logger: ctx.logger } as never)) as Record<string, unknown>;
      // The watch skips an environment checked in the last 50 s; the test stands in for a minute passing.
      await db.update(environments).set({ lastHealthAt: sql`now() - interval '2 minutes'` }).where(eq(environments.id, staging));
      return results;
    };
    expect((await tick())['post-deploy-watch']).toBe(1);
    await tick();
    await tick();
    const env = (await db.select().from(environments).where(eq(environments.id, staging)))[0]!;
    expect(env).toMatchObject({ status: 'down', consecutiveFailures: 3 });
    expect((await db.select().from(healthChecks).where(eq(healthChecks.environmentId, staging))).filter((c) => !c.ok)).toHaveLength(3);
    const open = await db.select().from(incidents).where(and(eq(incidents.environmentId, staging), eq(incidents.status, 'open')));
    expect(open).toHaveLength(1);
    // Nothing is rolled back automatically: the release stays until a person decides.
    expect(((await admin.get(`/deployments/${deploymentId}`)).data as { status: string }).status).toBe('succeeded');

    // Fifteen minutes after the deployment the environment is back on the normal 5-minute schedule.
    await db.update(deployments).set({ finishedAt: sql`now() - interval '20 minutes'` }).where(eq(deployments.id, deploymentId));
    expect((await tick())['post-deploy-watch']).toBe(0);
  }, 120_000);
});
