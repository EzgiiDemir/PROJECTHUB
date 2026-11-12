import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareVersions, ecosystemOf, encrypt, sameMajor } from '@projecthub/core';
import { aiTasks, auditEvents, projects, secrets, securityFindings } from '@projecthub/database';
import { ADMIN, client as makeClient, startHarness, waitFor, type Harness } from './harness.js';

/** OSV.dev stand-in: minimist 1.2.5 is vulnerable (prototype pollution), fixed in 1.2.6. */
function fakeOsv() {
  return http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/osv/v1/querybatch') {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const { queries } = JSON.parse(raw) as { queries: { package: { name: string }; version: string }[] };
        send(200, { results: queries.map((q) => (q.package.name === 'minimist' && q.version === '1.2.5' ? { vulns: [{ id: 'GHSA-xvch-5gv4-984h' }] } : {})) });
      });
      return;
    }
    if (req.url === '/osv/v1/vulns/GHSA-xvch-5gv4-984h') {
      return send(200, {
        id: 'GHSA-xvch-5gv4-984h',
        summary: 'Prototype Pollution in minimist',
        aliases: ['CVE-2021-44906'],
        database_specific: { severity: 'CRITICAL' },
        affected: [{ package: { name: 'minimist', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.6' }] }] }],
      });
    }
    send(404, {});
  });
}

let h: Harness;
const osv = fakeOsv();
const admin = makeClient(() => h.base);
const slug = 'otomatik-duzeltme';

type Plan = { items: { key: string; kind: string; mode: string; risk: string; autoMerge: boolean; details: string[] }[]; skipped: { title: string; reason: string }[] };
type Fix = { id: string; key: string; status: string; autofix: { risk: string; verdict?: { status: string; reasons: string[] } } };
type Assistant = { steps: { id: string; status: string; findings?: { number: number; packageName: string | null }[] }[]; fixAllKeys: string[] };

beforeAll(async () => {
  await new Promise<void>((r) => osv.listen(0, '127.0.0.1', r));
  h = await startHarness({ worker: true, env: { OSV_API_URL: `http://127.0.0.1:${(osv.address() as AddressInfo).port}/osv`, OLLAMA_BASE_URL: 'http://127.0.0.1:9' } });
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  await admin.post('/projects', { name: 'Otomatik Düzeltme', slug, source: { type: 'empty', template: 'node-api' } });
  await waitFor(async () => ((await admin.get(`/projects/${slug}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');

  // A real npm project with a real lockfile that pins the vulnerable version, plus a test that uses the package.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-lock-'));
  const pkg = (await admin.get(`/projects/${slug}/repo/file?ref=main&path=package.json`)).data as { content: string };
  const manifest = { ...JSON.parse(pkg.content), dependencies: { minimist: '1.2.5' } };
  await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify(manifest, null, 2));
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: tmp, shell: process.platform === 'win32', encoding: 'utf8' });
  if (npm.status !== 0) throw new Error(`npm: ${npm.stderr}`);
  const lock = await fs.readFile(path.join(tmp, 'package-lock.json'), 'utf8');
  await fs.rm(tmp, { recursive: true, force: true });
  const head = ((await admin.get(`/projects/${slug}/repo/branches`)).data as { branches: { sha: string }[] }).branches[0]!.sha;
  const commit = await admin.post(`/projects/${slug}/repo/commits`, {
    branch: 'main',
    baseCommit: head,
    message: 'minimist',
    changes: [
      { action: 'upsert', path: 'package.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
      { action: 'upsert', path: 'package-lock.json', content: lock },
      { action: 'upsert', path: '.env', content: 'APP_SECRET=Abcd1234!\n' },
      { action: 'upsert', path: 'test/args.test.mjs', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport minimist from 'minimist';\n\ntest('argümanlar ayrıştırılır', () => {\n  assert.deepEqual(minimist(['--port', '8080']).port, 8080);\n});\n" },
    ],
  });
  expect(commit.status).toBe(201);
  await admin.patch(`/projects/${slug}`, { executionTrust: 'trusted' });
  const scan = await admin.post(`/projects/${slug}/security/scans`, {});
  expect(scan.status).toBeLessThan(300);
  await waitFor(async () => ((await admin.get(`/projects/${slug}/security?status=all`)).data as { findings: { packageName: string | null; status: string }[] }).findings.some((f) => f.packageName === 'minimist' && f.status === 'open'), 60_000);
}, 240_000);

afterAll(async () => {
  await h?.close();
  osv.close();
});

describe('version helpers', () => {
  it('classifies upgrades by semver risk', () => {
    expect(sameMajor('1.2.5', '1.2.6')).toBe(true);
    expect(sameMajor('4.17.20', '4.18.0')).toBe(true);
    expect(sameMajor('1.9.0', '2.0.0')).toBe(false);
    expect(sameMajor('0.3.1', '0.4.0')).toBe(false); // 0.x: the minor is the breaking part
    expect(sameMajor(null, '1.0.0')).toBe(false);
    expect(compareVersions('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(ecosystemOf('apps/web/package-lock.json')).toBe('npm');
    expect(ecosystemOf('requirements-dev.txt')).toBe('PyPI');
    expect(ecosystemOf('composer.lock')).toBe('Packagist');
  });
});

describe('fix all with AI (real API, worker, package manager, build, tests and re-scan)', () => {
  it('plans a low-risk deterministic upgrade that may merge itself', async () => {
    const plan = (await admin.get(`/projects/${slug}/autofix/plan`)).data as Plan;
    const dep = plan.items.find((i) => i.kind === 'dependency');
    expect(dep).toMatchObject({ mode: 'dependency', risk: 'low', autoMerge: true });
    expect(dep!.details).toEqual(['minimist 1.2.5 → 1.2.6']);

    // These are the exact reads used by the overview assistant and security page.
    expect((await admin.get(`/projects/${slug}/autofix`)).data).toEqual([]);
    const assistant = (await admin.get(`/projects/${slug}/assistant`)).data as Assistant;
    expect(assistant.fixAllKeys).toContain(dep!.key);
    expect(assistant.steps.find((s) => s.id === `fix-${dep!.key}`)).toMatchObject({
      status: 'todo',
      findings: [expect.objectContaining({ packageName: 'minimist', number: expect.any(Number) })],
    });
  });

  it('does not keep offering an upgrade the package manager could not resolve', async () => {
    const db = h.server.handle.db;
    const project = (await db.select().from(projects).where(eq(projects.slug, slug)))[0]!;
    const finding = (await db.select().from(securityFindings).where(eq(securityFindings.projectId, project.id))).find((f) => f.packageName === 'minimist')!;
    const failed = (
      await db
        .insert(aiTasks)
        .values({
          organizationId: project.organizationId,
          projectId: project.id,
          number: 9_999,
          type: 'fix',
          title: 'minimist paketini yükselt',
          instruction: '-',
          autonomyLevel: 'L2',
          sourceType: 'security',
          status: 'failed',
          error: "Bağımlılık güncellemesi hazırlanamadı: composer, sürüm kısıtı yükseltildikten sonra çözemedi: - Conclusion: don't install laravel/framework v13.0.0",
          autofix: { batchId: '00000000-0000-0000-0000-000000000000', risk: 'low', mode: 'dependency', kind: 'dependency', findingIds: [finding.id], fingerprints: [] },
        })
        .returning()
    )[0]!;
    try {
      const plan = (await admin.get(`/projects/${slug}/autofix/plan`)).data as Plan;
      expect(plan.items.some((i) => i.kind === 'dependency')).toBe(false);
      expect(plan.skipped).toContainEqual(expect.objectContaining({ title: 'minimist paketini yükselt', reason: expect.stringMatching(/çözemedi.*7 gün/) }));
    } finally {
      await db.delete(aiTasks).where(eq(aiTasks.id, failed.id));
    }
    // A failure that says nothing about resolution (e.g. a .env cleanup that can be redone) stays available.
    expect(((await admin.get(`/projects/${slug}/autofix/plan`)).data as Plan).items.some((i) => i.kind === 'dependency')).toBe(true);
  });

  it('upgrades, verifies with the real build and tests, re-scans, merges and resolves the finding', async () => {
    const plan = (await admin.get(`/projects/${slug}/autofix/plan`)).data as Plan;
    const key = plan.items.find((i) => i.kind === 'dependency')!.key;
    // The project assistant starts selected steps this way.
    const started = await admin.post(`/projects/${slug}/autofix`, { keys: [key] });
    expect(started.status).toBe(201);
    const id = (started.data as { created: { id: string }[] }).created[0]!.id;

    // Race: someone pushes to main while the fix is being verified. The old verification must not be merged; the fix
    // is prepared again on the new main and verified again before it merges.
    await waitFor(async () => ((await admin.get(`/projects/${slug}/autofix`)).data as Fix[]).find((x) => x.id === id)?.status === 'awaiting_approval', 120_000);
    const verifiedBase = (await h.server.handle.db.select().from(aiTasks).where(eq(aiTasks.id, id)))[0]!.baseCommit!;
    const pushed = await admin.post(`/projects/${slug}/repo/commits`, { branch: 'main', baseCommit: verifiedBase, message: 'docs: eşzamanlı değişiklik', changes: [{ action: 'upsert', path: 'NOTES.md', content: '# başka bir geliştirici\n' }] });
    expect(pushed.status, JSON.stringify(pushed.error)).toBe(201);
    const newMain = (pushed.data as { commit: string }).commit;

    const fix = await waitFor(
      async () => {
        const list = (await admin.get(`/projects/${slug}/autofix`)).data as Fix[];
        const t = list.find((x) => x.id === id);
        return t && (t.status === 'merged' || t.status === 'failed' || t.autofix.verdict) ? t : null;
      },
      300_000,
    );
    expect(fix.autofix.verdict?.reasons ?? []).toBeDefined();
    expect(fix.status, JSON.stringify(fix.autofix.verdict ?? fix)).toBe('merged');
    expect(fix.autofix.verdict?.status).toBe('merged');
    // It was re-prepared because main moved, and what merged was verified on top of the concurrent commit.
    const reprepared = (await h.server.handle.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'ai.task.reverify'), eq(auditEvents.resourceId, id)))).map((a) => (a.metadata as { reason?: string }).reason ?? '');
    expect(reprepared.some((r) => /ilerledi/.test(r)), JSON.stringify(reprepared)).toBe(true);
    expect((await h.server.handle.db.select().from(aiTasks).where(eq(aiTasks.id, id)))[0]!.baseCommit).toBe(newMain);
    expect((await admin.get(`/projects/${slug}/repo/file?ref=main&path=NOTES.md`)).status).toBe(200);

    // main now carries the safe version in both the manifest and the real lockfile.
    const pkg = JSON.parse(((await admin.get(`/projects/${slug}/repo/file?ref=main&path=package.json`)).data as { content: string }).content);
    expect(pkg.dependencies.minimist).toBe('1.2.6');
    const lock = JSON.parse(((await admin.get(`/projects/${slug}/repo/file?ref=main&path=package-lock.json`)).data as { content: string }).content);
    expect(lock.packages['node_modules/minimist'].version).toBe('1.2.6');

    // The default-branch scan that the merge triggers closes the finding for everyone.
    await waitFor(async () => {
      const f = ((await admin.get(`/projects/${slug}/security?status=all`)).data as { findings: { packageName: string | null; status: string }[] }).findings.find((x) => x.packageName === 'minimist');
      return f?.status === 'resolved';
    }, 60_000);
    const audit = (await admin.get(`/admin/audit?action=ai.task.auto_merged`)).data as { action: string; actorLabel: string }[];
    expect(audit.find((a) => a.action === 'ai.task.auto_merged')?.actorLabel).toBe('AI otomatik düzeltme');
  }, 360_000);

  it('removes a committed .env, adds ignore rules, verifies it and waits for human approval', async () => {
    const plan = (await admin.get(`/projects/${slug}/autofix/plan`)).data as Plan;
    const env = plan.items.find((i) => i.key === 'secret-env-files');
    expect(env).toMatchObject({ mode: 'files', risk: 'high', autoMerge: false });

    const started = await admin.post(`/projects/${slug}/autofix`, { keys: [env!.key] });
    expect(started.status).toBe(201);
    const id = (started.data as { created: { id: string }[] }).created[0]!.id;
    const verified = await waitFor(
      async () => {
        const task = ((await admin.get(`/projects/${slug}/autofix`)).data as Fix[]).find((item) => item.id === id);
        return task?.autofix.verdict ? task : null;
      },
      300_000,
    );
    expect(verified.status).toBe('awaiting_approval');
    expect(verified.autofix.verdict?.status).toBe('needs_approval');

    const approved = await admin.post(`/projects/${slug}/autofix/approve-verified`, {});
    expect(approved.status).toBe(201);
    expect((approved.data as { approved: string[] }).approved).toContain(id);
    await waitFor(async () => {
      const task = ((await admin.get(`/projects/${slug}/autofix`)).data as Fix[]).find((item) => item.id === id);
      return task?.status === 'merged' ? task : null;
    });

    expect((await admin.get(`/projects/${slug}/repo/file?ref=main&path=.env`)).status).toBe(404);
    const ignore = ((await admin.get(`/projects/${slug}/repo/file?ref=main&path=.gitignore`)).data as { content: string }).content;
    expect(ignore).toContain('.env');
    expect(ignore).toContain('!.env.example');

    // The removed .env moves into Secrets in one step: preview (names only), then save after confirmation.
    const preview = await admin.post(`/projects/${slug}/secrets/import`, { source: 'history' });
    expect(preview.status).toBe(201);
    const p = preview.data as { origin: { kind: string; removed: boolean }; items: { name: string; action: string; length: number }[]; external: string[]; saved: number };
    expect(p.origin).toMatchObject({ kind: 'history', removed: true });
    expect(p.items).toEqual([{ name: 'APP_SECRET', action: 'create', length: 9, generated: false }]);
    expect(p.external).toEqual(['APP_SECRET']);
    expect(JSON.stringify(p)).not.toContain('Abcd1234');
    expect(((await admin.get(`/projects/${slug}/secrets`)).data as unknown[]).length).toBe(0);

    const saved = await admin.post(`/projects/${slug}/secrets/import`, { source: 'history', dryRun: false });
    expect((saved.data as { saved: number }).saved).toBe(1);
    const pasted = await admin.post(`/projects/${slug}/secrets/import`, { text: 'APP_NAME="Demo"\nAPP_KEY=base64:old\nMAIL_FROM_NAME="${APP_NAME}"\nEMPTY=\n', rotateAppKey: true, dryRun: false });
    expect((pasted.data as { saved: number; issues: { reason: string }[] }).saved).toBe(4);
    const list = (await admin.get(`/projects/${slug}/secrets`)).data as { id: string; name: string; scope: string }[];
    expect(list.map((s) => s.name)).toEqual(['APP_KEY', 'APP_NAME', 'APP_PREVIOUS_KEYS', 'APP_SECRET', 'MAIL_FROM_NAME']);
    expect(list.every((s) => s.scope === 'all')).toBe(true);
    const value = async (name: string) => ((await admin.post(`/secrets/${list.find((s) => s.name === name)!.id}/reveal`, {})).data as { value: string }).value;
    expect(await value('APP_SECRET')).toBe('Abcd1234!');
    expect(await value('MAIL_FROM_NAME')).toBe('Demo');
    expect(await value('APP_PREVIOUS_KEYS')).toBe('base64:old');
    expect(await value('APP_KEY')).toMatch(/^base64:[A-Za-z0-9+/]{43}=$/);

    // A backend/ + frontend/ repository keeps its .env in the app folder.
    const branches = ((await admin.get(`/projects/${slug}/repo/branches`)).data as { branches: { name: string; sha: string }[] }).branches;
    const main = branches.find((b) => b.name === 'main')!.sha;
    expect((await admin.post(`/projects/${slug}/repo/commits`, { branch: 'main', baseCommit: main, message: 'backend env', changes: [{ action: 'upsert', path: 'backend/.env', content: 'DB_PASSWORD=Gizli-123\nAPP_SECRET=yeni\n' }] })).status).toBe(201);
    const nested = (await admin.post(`/projects/${slug}/secrets/import`, { source: 'history', overwrite: true })).data as { origin: { removed: boolean; paths: string[] }; items: { name: string; action: string }[] };
    expect(nested.origin).toMatchObject({ removed: false, paths: ['backend/.env'] });
    expect(nested.items.map((i) => `${i.name}:${i.action}`).sort()).toEqual(['APP_SECRET:update', 'DB_PASSWORD:create']);
    expect((await admin.post(`/projects/${slug}/secrets/import`, { source: 'history', overwrite: true, dryRun: false })).status).toBe(201);

    // A value saved under another encryption key is repaired; readable values are left alone.
    const foreign = encrypt(randomBytes(32), 'eski-anahtar');
    await h.server.handle.db.update(secrets).set(foreign).where(eq(secrets.name, 'APP_SECRET'));
    const repair = (await admin.post(`/projects/${slug}/secrets/import`, { source: 'history', overwrite: 'unreadable', dryRun: false })).data as { items: { name: string; action: string }[]; saved: number };
    expect(repair.items.map((i) => `${i.name}:${i.action}`).sort()).toEqual(['APP_SECRET:update', 'DB_PASSWORD:skip']);
    expect(repair.saved).toBe(1);
    const repaired = ((await admin.get(`/projects/${slug}/secrets`)).data as { id: string; name: string }[]).find((s) => s.name === 'APP_SECRET')!;
    expect(((await admin.post(`/secrets/${repaired.id}/reveal`, {})).data as { value: string }).value).toBe('yeni');
  }, 360_000);
});
