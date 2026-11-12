import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builds } from '@projecthub/database';
import { ADMIN, client, startHarness, waitFor, type Harness } from './harness.js';

let h: Harness;
const api = client(() => h.base);
const slug = 'yeniden-baslama';
type Step = { key: string; status: string };

describe('a worker restart during a build', () => {
  beforeAll(async () => {
    h = await startHarness({ worker: true });
    expect((await api.post('/auth/login', ADMIN)).status).toBe(200);
    expect((await api.post('/projects', { name: 'Yeniden başlama', slug, source: { type: 'empty' } })).status).toBe(201);
    await waitFor(async () => ((await api.get(`/projects/${slug}`)).data as { repository?: { status?: string } }).repository?.status === 'ready', 60_000);
    const head = ((await api.get(`/projects/${slug}/repo/branches`)).data as { branches: { name: string; sha: string }[] }).branches.find((b) => b.name === 'main')!.sha;
    const files = {
      'projecthub.yml': 'project:\n  name: Yeniden başlama\nruntime:\n  type: node\nbuild:\n  command: node slow.mjs\n',
      'package.json': '{"name":"yeniden","version":"1.0.0"}\n',
      'slow.mjs': "console.log('build başladı'); setTimeout(() => console.log('bitti'), 120000);\n",
    };
    expect((await api.post(`/projects/${slug}/repo/commits`, { branch: 'main', baseCommit: head, message: 'app', changes: Object.entries(files).map(([path, content]) => ({ action: 'upsert', path, content })) })).status).toBe(201);
    expect((await api.patch(`/projects/${slug}`, { executionTrust: 'trusted' })).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('puts the build back in the queue instead of cancelling it', async () => {
    const created = await api.post(`/projects/${slug}/builds`, { createPreview: false });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const id = (created.data as { id: string }).id;
    await waitFor(async () => ((await api.get(`/builds/${id}`)).data as { steps: Step[] }).steps.some((s) => s.key === 'build' && s.status === 'running'), 120_000);

    await h.stopWorker();

    const db = h.server.handle.db;
    const b = (await db.select().from(builds).where(eq(builds.id, id)))[0]!;
    expect(b.status).toBe('queued');
    const queued = (await db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where type = 'build.execute' and status = 'queued' and payload->>'buildId' = ${id}`)).rows[0]!.n;
    expect(queued).toBe(1);
    const steps = ((await api.get(`/builds/${id}`)).data as { steps: Step[] }).steps;
    expect(steps.every((s) => s.status === 'pending')).toBe(true);
  }, 180_000);
});
