import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPreviewTicket } from '@projecthub/core';
import { createPreviewGateway } from '../dist/modules/gateway/gateway.js';
import { ADMIN, client, startHarness, waitFor, type Harness } from './harness.js';

/**
 * A real user's journey through an existing project, run against a fresh test database with the real API and worker:
 * import from Git → repository ready → detected manifest → trust → build (install, security, build, test, artifact)
 * → preview answering HTTP → preview stopped.
 * Opt-in: PROJECTHUB_JOURNEY_REPO=<path to a bare repository> (e.g. the "form" project under .data/storage/repos).
 * PROJECTHUB_JOURNEY_REPORT=<file> receives every stage with its duration as JSON.
 */
const repo = process.env.PROJECTHUB_JOURNEY_REPO;
const reportFile = process.env.PROJECTHUB_JOURNEY_REPORT;
/** Branch to build (default: the repository's default branch). */
const branch = process.env.PROJECTHUB_JOURNEY_BRANCH;
let h: Harness;
let gateway: http.Server;
const api = client(() => h.base);
const slug = 'journey';
const report: { stage: string; seconds: number; detail?: unknown }[] = [];

type Step = { key: string; status: string; summary?: string | null };
type Build = { id: string; status: string; steps?: Step[]; error?: unknown };

describe.skipIf(!repo)('existing project journey (real API, real worker)', () => {
  beforeAll(async () => {
    h = await startHarness({ worker: true });
    gateway = createPreviewGateway(h.server.ctx);
    await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
    expect((await api.post('/auth/login', ADMIN)).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    if (reportFile) await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
    await new Promise((r) => gateway?.close(r));
    await h?.close();
  }, 300_000);

  it('imports, builds and previews the project', async () => {
    let t = Date.now();
    const stage = (name: string, detail?: unknown) => {
      report.push({ stage: name, seconds: Math.round((Date.now() - t) / 100) / 10, detail });
      t = Date.now();
    };
    const created = await api.post('/projects', { name: 'Journey', slug, source: { type: 'git', url: pathToFileURL(repo!).href } });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    await waitFor(async () => {
      const p = await api.get(`/projects/${slug}`);
      const status = (p.data as { repository?: { status?: string } }).repository?.status;
      if (status === 'failed') throw new Error(`repository failed: ${JSON.stringify(p.data)}`);
      return status === 'ready';
    }, 1_200_000);
    stage('repository ready');
    const manifest = await waitFor(async () => ((await api.get(`/projects/${slug}/manifest`)).data as { manifest: unknown; detection: { warnings: string[] } | null }).detection ? (await api.get(`/projects/${slug}/manifest`)).data : null, 120_000);
    stage('detection', manifest);

    // Imported sources start untrusted; the owner confirms before commands run.
    expect((await api.post(`/projects/${slug}/builds`, { createPreview: true, branch })).status).toBe(412);
    expect((await api.patch(`/projects/${slug}`, { executionTrust: 'trusted' })).status).toBe(200);
    // Settings move from the committed (or since removed) .env into Secrets, as the Secrets page offers.
    const imported = await api.post(`/projects/${slug}/secrets/import`, { source: 'history', dryRun: false });
    stage('secrets imported', imported.status === 201 ? { origin: (imported.data as { origin: unknown }).origin, saved: (imported.data as { saved: number }).saved } : imported.error);
    const build = await api.post(`/projects/${slug}/builds`, { createPreview: true, branch });
    expect(build.status, JSON.stringify(build.error)).toBe(201);
    const buildId = (build.data as { id: string }).id;
    const done = await waitFor(async () => {
      const b = (await api.get(`/builds/${buildId}`)).data as Build;
      return ['passed', 'failed', 'cancelled'].includes(b.status) ? b : null;
    }, 2_400_000);
    const logTail = done.status === 'passed' ? undefined : String(((await api.get(`/builds/${buildId}/log`)).data as { text?: string } | null)?.text ?? '').split('\n').slice(-80).join('\n');
    stage(`build ${done.status}`, { steps: done.steps?.map((s) => `${s.key}: ${s.status} ${s.summary ?? ''}`), error: done.error, logTail });
    expect(done.status).toBe('passed');

    const preview = await waitFor(async () => {
      const rows = (await h.server.handle.db.execute<{ id: string; slug: string; status: string; error: string | null; kind: string; services: unknown }>(sql`SELECT id, slug, status, error, kind, services FROM previews WHERE build_id = ${buildId}`)).rows;
      const pv = rows[0];
      return pv && ['ready', 'failed'].includes(pv.status) ? pv : null;
    }, 600_000);
    // Through the real preview gateway, as a person opening the preview would.
    const ticket = signPreviewTicket(h.config.encryptionKey, { previewId: preview.id, subject: 'system', ttlSeconds: 600 });
    const open = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: (gateway.address() as AddressInfo).port, path, headers: { host: `${preview.slug}.${h.config.PREVIEW_BASE_DOMAIN}`, cookie: `ph_pv=${ticket}`, accept: 'text/html,application/json' } }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: body.slice(0, 600) }));
        });
        req.on('error', (e) => resolve({ status: 0, body: e.message }));
        req.setTimeout(120_000, () => req.destroy(new Error('timeout')));
        req.end();
      });
    const pages = preview.status === 'ready' ? { site: await open('/'), api: await open('/api/forms') } : null;
    stage(`preview ${preview.status}`, { kind: preview.kind, error: preview.error, services: preview.services, pages });
    expect(preview.status).toBe('ready');
    expect(pages!.site.status, pages!.site.body).toBeLessThan(500);
    // The backend answers through the same address (routed by the gateway), not only the frontend.
    expect(pages!.api.status, pages!.api.body).toBeLessThan(500);

    expect((await api.post(`/previews/${preview.id}/stop`)).status).toBeLessThan(300);
    stage('preview stopped');

    // The next build of unchanged lockfiles reuses the installed dependencies.
    if (process.env.PROJECTHUB_JOURNEY_REBUILD === '1') {
      const again = await api.post(`/projects/${slug}/builds`, { createPreview: false, branch });
      expect(again.status).toBe(201);
      const second = await waitFor(async () => {
        const b = (await api.get(`/builds/${(again.data as { id: string }).id}`)).data as Build;
        return ['passed', 'failed', 'cancelled'].includes(b.status) ? b : null;
      }, 2_400_000);
      stage(`rebuild ${second.status}`, { steps: second.steps?.map((s) => `${s.key}: ${s.status} ${s.summary ?? ''}`) });
      expect(second.status).toBe('passed');
    }
  }, 3_600_000);
});
