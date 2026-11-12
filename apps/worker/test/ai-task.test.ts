import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger, GitRepository, loadConfig, parseManifest, Storage, type JobContext } from '@projecthub/core';
import { aiActions, aiRuns, aiTasks, builds, jobs, organizations, projectManifests, projects, repositories, users, type DatabaseHandle } from '@projecthub/database';
import { freshDatabase } from '../../../test/support/db.js';
import { startFakeAnthropic, type RecordedRequest, type ScriptedTurn } from '../../../test/support/fake-anthropic.js';
import type { WorkerCtx } from '../src/context.js';
import { runAiTask } from '../src/jobs/ai.js';
import { AgentChecks } from '../src/jobs/agent-checks.js';

const BUGGY = `/** Sepet toplamı (kuruş hassasiyetinde yuvarlanır). */
export function cartTotal(items) {
  return items.reduce((sum, i) => sum + i.price, 0);
}
`;
const FIXED = `/** Sepet toplamı (kuruş hassasiyetinde yuvarlanır). */
export function cartTotal(items) {
  return Math.round(items.reduce((sum, i) => sum + i.price * i.qty, 0) * 100) / 100;
}
`;

let h: DatabaseHandle;
let tmp: string;
let ctx: WorkerCtx;
let fake: Awaited<ReturnType<typeof startFakeAnthropic>>;
let orgId: string;
let userId: string;
let projectId: string;
let base: string;
let turnFor: (req: RecordedRequest, i: number) => ScriptedTurn = () => ({ text: 'no script' });
const logger = createLogger('test', 'silent');

beforeAll(async () => {
  h = await freshDatabase();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-ai-'));
  fake = await startFakeAnthropic((req, i) => turnFor(req, i));
  const config = loadConfig({ ...process.env, STORAGE_DIR: tmp, ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: fake.url }, { cwd: tmp });
  const storage = new Storage(config.storageDir);
  await storage.init();
  ctx = { config, db: h.db, pool: h.pool, storage, logger, workerId: 'test-worker' };

  orgId = (await h.db.insert(organizations).values({ name: 'Test', slug: 'test', settings: { ai: { provider: 'anthropic', autonomyLevel: 'L2' } } }).returning())[0]!.id;
  userId = (await h.db.insert(users).values({ email: 'dev@example.com', displayName: 'Dev', status: 'active' }).returning())[0]!.id;
  projectId = (await h.db.insert(projects).values({ organizationId: orgId, name: 'Nova Mağaza', slug: 'nova', technologies: ['Node.js'] }).returning())[0]!.id;
  const repoKey = storage.repoKey(projectId);
  await h.db.insert(repositories).values({ projectId, storageKey: repoKey, status: 'ready', defaultBranch: 'main' });
  const git = await GitRepository.initBare(storage.resolve(repoKey), 'main');
  base = await git.commitChanges({
    branch: 'main',
    baseCommit: null,
    message: 'init',
    author: { name: 'Dev', email: 'dev@example.com' },
    changes: [
      { action: 'upsert', path: 'src/cart.mjs', content: BUGGY },
      { action: 'upsert', path: 'README.md', content: '# Nova\n' },
      { action: 'upsert', path: '.env', content: 'STRIPE_SECRET=sk_live_should_never_be_read\n' },
      { action: 'upsert', path: '.env.example', content: 'APP_NAME=Nova\n' },
    ],
  });
});

afterAll(async () => {
  await fake?.close();
  await h?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function newTask(number: number, title: string) {
  return (
    await h.db
      .insert(aiTasks)
      .values({ organizationId: orgId, projectId, number, type: 'fix', title, instruction: 'Sepet toplamı adet ile çarpılmıyor; düzelt.', autonomyLevel: 'L2', sourceType: 'manual', baseBranch: 'main', requestedBy: userId })
      .returning()
  )[0]!;
}

const job = (taskId: string) => ({ job: { id: 'j', type: 'ai.task.run', payload: { taskId }, attempts: 1, maxAttempts: 1 }, logger, signal: new AbortController().signal }) as unknown as JobContext;

describe('AI fix task (real worker job, Anthropic SDK against a scripted Messages API)', () => {
  const npmDependencyRegression = () => it('stages structured npm dependencies and their generated lock together, never a failed resolver candidate', async () => {
    const pid = (await h.db.insert(projects).values({ organizationId: orgId, name: 'Paket kontrol', slug: 'paket-kontrol', technologies: ['Node.js'], settings: { executionTrust: 'trusted' } }).returning())[0]!.id;
    const key = ctx.storage.repoKey(pid);
    await h.db.insert(repositories).values({ projectId: pid, storageKey: key, status: 'ready', defaultBranch: 'main' });
    const repo = await GitRepository.initBare(ctx.storage.resolve(key), 'main');
    const head = await repo.commitChanges({ branch: 'main', baseCommit: null, message: 'init', author: { name: 'Dev', email: 'dev@example.com' }, changes: [{ action: 'upsert', path: 'package.json', content: '{"name":"fixture","version":"1.0.0"}' }] });
    await h.db.insert(projectManifests).values({ projectId: pid, version: 1, source: 'detected', commitSha: head, content: parseManifest('project:\n  name: Paket\nruntime:\n  type: node\ntest:\n  command: node --version\n') });
    const resolver = vi.spyOn(AgentChecks.prototype, 'updateNpmLock').mockRejectedValueOnce(new Error('Registry unavailable')).mockImplementation(async (_path, changes) => {
      const pkg = changes.find((change) => change.path === 'package.json')!;
      if (pkg.action === 'delete') throw new Error('unexpected deletion');
      const parsed = JSON.parse(pkg.content.toString());
      return { action: 'upsert', path: 'package-lock.json', content: JSON.stringify({ lockfileVersion: 3, packages: { '': parsed } }) };
    });
    const start = fake.requests.length;
    const script: ScriptedTurn[] = [
      { toolCalls: [{ name: 'set_npm_dependency', input: { path: 'package.json', name: 'dompurify', version: '^1.0.0', section: 'dependencies' } }] },
      { toolCalls: [{ name: 'read_file', input: { path: 'package.json' } }] },
      { toolCalls: [{ name: 'set_npm_dependency', input: { path: 'package.json', name: 'dompurify', version: '^1.0.0', section: 'dependencies' } }] },
      { toolCalls: [{ name: 'set_npm_dependency', input: { path: 'package.json', name: 'dompurify', version: '^2.0.0', section: 'dependencies' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: 'Bağımlılık ve lock hazırlandı; doğrulama bekleniyor.', explanation: ['Henüz kontroller çalıştırılmadı.'] } }] },
    ];
    turnFor = (_req, i) => script[i - start]!;
    try {
      const task = (await h.db.insert(aiTasks).values({ organizationId: orgId, projectId: pid, number: 38, type: 'fix', title: 'Paket bağımlılığı', instruction: 'Bağımlılığı hazırla.', autonomyLevel: 'L2', sourceType: 'manual', baseBranch: 'main', requestedBy: userId }).returning())[0]!;
      await runAiTask(ctx, job(task.id));
      const result = (await h.db.select().from(aiTasks).where(eq(aiTasks.id, task.id)))[0]!;
      expect(result.status).toBe('awaiting_approval');
      expect(resolver).toHaveBeenCalledTimes(2); // read-before-edit still enforced
      const pkg = JSON.parse((await repo.readFile(result.headCommit!, 'package.json'))!.content.toString());
      const lock = JSON.parse((await repo.readFile(result.headCommit!, 'package-lock.json'))!.content.toString());
      expect(pkg.dependencies).toEqual({ dompurify: '^2.0.0' });
      expect(lock.packages['']).toEqual(pkg);
      expect(await repo.resolve('refs/heads/main')).toBe(head);
      expect(result.buildId).toBeTruthy(); // resolver success alone is not verification
    } finally { resolver.mockRestore(); }
  }, 60_000);

  it('investigates, edits on its own branch, is denied forbidden files, and waits for human approval', async () => {
    const script: ScriptedTurn[] = [
      { text: 'Önce sepet hesabını bulayım.', toolCalls: [{ name: 'search_code', input: { query: 'cartTotal' } }] },
      { toolCalls: [{ name: 'list_files', input: { prefix: '' } }, { name: 'search_code', input: { query: 'STRIPE_SECRET' } }, { name: 'read_file', input: { path: 'src/cart.mjs' } }, { name: 'read_file', input: { path: '.env.example' } }, { name: 'read_file', input: { path: '.env' } }, { name: 'delete_file', input: { path: '.env' } }] },
      { toolCalls: [{ name: 'write_file', input: { path: 'src/cart.mjs', content: FIXED } }, { name: 'write_file', input: { path: '.env.example', content: 'APP_NAME=Nova\nSTRIPE_SECRET=\n' } }, { name: 'write_file', input: { path: 'README.md', content: '# Değiştirildi\n' } }, { name: 'write_file', input: { path: 'projecthub.yml', content: 'x' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: 'Sepet toplamı adet ile çarpılıyor ve yuvarlanıyor.', explanation: ['cartTotal fiyatı adetle çarpıyor', 'Sonuç kuruşa yuvarlanıyor'] } }] },
    ];
    turnFor = (_req, i) => script[i]!;
    const task = await newTask(1, 'Sepet toplamı hatası');
    await runAiTask(ctx, job(task.id));

    const t = (await h.db.select().from(aiTasks).where(eq(aiTasks.id, task.id)))[0]!;
    expect(t.status).toBe('awaiting_approval');
    expect(t.branch).toMatch(/^ai\/AI-1-/);
    expect(t.baseCommit).toBe(base);
    expect(t.result?.filesChanged).toEqual([
      { path: '.env.example', additions: 1, deletions: 0 },
      { path: 'src/cart.mjs', additions: 1, deletions: 1 },
    ]);

    // The change lives only on the AI branch; main is untouched.
    const git = new GitRepository(ctx.storage.resolve(ctx.storage.repoKey(projectId)));
    expect((await git.readFile(t.headCommit!, 'src/cart.mjs'))!.content.toString()).toBe(FIXED);
    expect(await git.resolve('refs/heads/main')).toBe(base);

    // Every tool call is in the audit trail; secrets and the manifest were refused.
    const actions = await h.db.select().from(aiActions).where(eq(aiActions.taskId, task.id));
    const summary = actions.map((a) => `${a.action}:${a.resource ?? ''}:${a.decision}`).sort();
    expect(summary).toEqual([
      'delete_file:.env:denied',
      'finish::allowed',
      'list_files::allowed',
      'read_file:.env:denied',
      'read_file:.env.example:allowed',
      'read_file:src/cart.mjs:allowed',
      'search_code::allowed',
      'search_code::allowed',
      'write_file:README.md:denied',
      'write_file:.env.example:allowed',
      'write_file:projecthub.yml:denied',
      'write_file:src/cart.mjs:allowed',
    ].sort());

    // Usage is accounted per run.
    const run = (await h.db.select().from(aiRuns).where(eq(aiRuns.taskId, task.id)))[0]!;
    expect(run).toMatchObject({ purpose: 'fix_agent', status: 'completed', provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 480, outputTokens: 160 });

    // Verification build is queued on the AI branch; at L2 it does not open a preview.
    const b = (await h.db.select().from(builds).where(and(eq(builds.projectId, projectId), eq(builds.trigger, 'ai'))))[0]!;
    expect(b).toMatchObject({ branch: t.branch, commitSha: t.headCommit, createPreview: false, triggeredByType: 'ai' });
    expect((await h.db.select().from(jobs).where(eq(jobs.type, 'build.execute'))).length).toBe(1);

    // What actually went over the wire.
    const first = fake.requests[0]!;
    expect(first.path).toContain('/v1/messages');
    expect(String(first.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(first.body).toMatchObject({ model: 'claude-opus-5-5', stream: true, fallbacks: 'default', output_config: { effort: 'high' } });
    expect(first.body.tools!.every((tool) => tool.eager_input_streaming === true)).toBe(true);
    expect(first.body.system![0]!.text).toContain('Nova Mağaza');
    const results = (i: number) => (fake.requests[i]!.body.messages.at(-1)!.content as { type: string; content: string; is_error: boolean }[]);
    expect(results(1)[0]!.content).toContain('src/cart.mjs:2');
    const listed = results(2).find((r) => r.content.includes('README.md'))!.content.split('\n');
    expect(listed).not.toContain('.env');
    expect(listed).toContain('.env.example');
    expect(results(2).filter((r) => r.content === 'Eşleşme yok')).toHaveLength(1);
    expect(results(2).find((r) => r.content.includes('izin yok'))!.is_error).toBe(true);
    expect(results(2).find((r) => r.content.includes('items.reduce'))!.is_error).toBe(false);
    expect(results(3).find((r) => r.content.includes('read_file ile tamamen okunmalı'))!.is_error).toBe(true);
  }, 60_000);

  it('runs the real tests on its own edits, sees the failure, fixes it and finishes only when the checks pass', async () => {
    // A separate trusted project with a real test command.
    const pid = (await h.db.insert(projects).values({ organizationId: orgId, name: 'Kontrol', slug: 'kontrol', technologies: ['Node.js'], settings: { executionTrust: 'trusted' } }).returning())[0]!.id;
    const key = ctx.storage.repoKey(pid);
    await h.db.insert(repositories).values({ projectId: pid, storageKey: key, status: 'ready', defaultBranch: 'main' });
    const repo = await GitRepository.initBare(ctx.storage.resolve(key), 'main');
    const head = await repo.commitChanges({
      branch: 'main',
      baseCommit: null,
      message: 'init',
      author: { name: 'Dev', email: 'dev@example.com' },
      changes: [
        { action: 'upsert', path: 'src/cart.mjs', content: BUGGY },
        { action: 'upsert', path: 'check.mjs', content: "import { cartTotal } from './src/cart.mjs';\nconst got = cartTotal([{ price: 1.1, qty: 3 }]);\nif (got !== 3.3) { console.error(`cartTotal: beklenen 3.3, gelen ${got}`); process.exit(1); }\nconsole.log('ok');\n" },
      ],
    });
    await h.db.insert(projectManifests).values({ projectId: pid, version: 1, source: 'detected', commitSha: head, content: parseManifest('project:\n  name: Kontrol\nruntime:\n  type: node\ntest:\n  command: node check.mjs\n') });
    const script: ScriptedTurn[] = [
      { toolCalls: [{ name: 'read_file', input: { path: 'src/cart.mjs' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'src/cart.mjs', old_text: 'sum + i.price, 0', new_text: 'sum + i.price * i.qty, 0' } }] },
      { toolCalls: [{ name: 'run_checks', input: { kind: 'test' } }] },
      { toolCalls: [{ name: 'write_file', input: { path: 'src/cart.mjs', content: FIXED } }] },
      { toolCalls: [{ name: 'run_checks', input: { kind: 'all' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: 'Toplam adetle çarpılıyor ve yuvarlanıyor.', explanation: ['cartTotal düzeltildi'] } }] },
    ];
    const start = fake.requests.length;
    turnFor = (_req, i) => script[i - start]!;
    const t0 = (await h.db.insert(aiTasks).values({ organizationId: orgId, projectId: pid, number: 10, type: 'fix', title: 'Sepet toplamı', instruction: 'Testi geçir.', autonomyLevel: 'L2', sourceType: 'manual', baseBranch: 'main', requestedBy: userId }).returning())[0]!;
    await runAiTask(ctx, job(t0.id));

    const t = (await h.db.select().from(aiTasks).where(eq(aiTasks.id, t0.id)))[0]!;
    expect(t.status).toBe('awaiting_approval');
    expect(await new GitRepository(ctx.storage.resolve(key)).readFile(t.headCommit!, 'src/cart.mjs').then((f) => f!.content.toString())).toBe(FIXED);
    // What the model saw: the real failure first, then a pass.
    const toolResult = (i: number) => (fake.requests[start + i]!.body.messages.at(-1)!.content as { content: string }[])[0]!.content;
    expect(toolResult(3)).toMatch(/✘ Testler BAŞARISIZ[\s\S]*beklenen 3\.3, gelen 3\.3000000000000003/);
    expect(toolResult(5)).toMatch(/✔ Testler başarılı[\s\S]*Tüm kontroller geçti/);
    expect(t.result?.explanation.at(-2)).toBe('Commit öncesi kontrol (2. çalıştırma): ✔ Testler başarılı');
    // Verified on exactly these edits and no dependency/config change: no second full build.
    expect(t.result?.explanation.at(-1)).toMatch(/Ayrı doğrulama build’i başlatılmadı/);
    expect(t.buildId).toBeNull();
    const checks = (await h.db.select().from(aiActions).where(eq(aiActions.taskId, t0.id))).filter((a) => a.action === 'run_checks');
    expect(checks).toHaveLength(2);
    // The private working copy is gone after the task.
    await expect(fs.access(ctx.storage.resolve(ctx.storage.workspaceKey('ai', `${t0.id}-checks`)))).rejects.toThrow();
  }, 120_000);

  it('inspects safe project capabilities, recovers from read-before-edit and searches pending edits', async () => {
    const script: ScriptedTurn[] = [
      { toolCalls: [{ name: 'project_status', input: {} }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'src/cart.mjs', old_text: 'sum + i.price, 0', new_text: 'sum + i.price * i.qty, 0' } }] },
      { toolCalls: [{ name: 'read_file', input: { path: 'src/cart.mjs' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'src/cart.mjs', old_text: 'sum + i.price, 0', new_text: 'sum + i.price * i.qty, 0' } }] },
      { toolCalls: [{ name: 'search_code', input: { query: 'sum + i.price, 0' } }] },
      { toolCalls: [{ name: 'search_code', input: { query: 'sum + i.price * i.qty' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: 'Adet çarpanı eklendi; yuvarlama henüz doğrulanmadı.', explanation: ['Bekleyen düzenleme aramada görüldü.'] } }] },
    ];
    const start = fake.requests.length;
    turnFor = (_req, i) => script[i - start]!;
    const task = await newTask(41, 'Araç erişimi ve güncel kaynak');
    await runAiTask(ctx, job(task.id));
    const result = (i: number) => (fake.requests[start + i]!.body.messages.at(-1)!.content as { content: string; is_error?: boolean }[])[0]!;
    const status = JSON.parse(result(1).content);
    expect(status).toMatchObject({ project: 'Nova Mağaza', baseBranch: 'main', baseCommit: base, capabilities: { editSource: true, shell: false, readSecretValues: false, editExecutionManifest: false, merge: false, deploy: false } });
    expect(result(1).content).not.toContain('sk_live_should_never_be_read');
    expect(result(2)).toMatchObject({ is_error: true });
    expect(result(2).content).toContain('read_file ile okunmalı');
    expect(result(4).content).toContain('Düzenlendi: src/cart.mjs');
    expect(result(5).content).toBe('Eşleşme yok');
    expect(result(6).content).toContain('sum + i.price * i.qty');
    const t = (await h.db.select().from(aiTasks).where(eq(aiTasks.id, task.id)))[0]!;
    expect(t.status).toBe('awaiting_approval');
    expect(await new GitRepository(ctx.storage.resolve(ctx.storage.repoKey(projectId))).resolve('refs/heads/main')).toBe(base);
  }, 60_000);

  it('verifies a targeted security fix by re-scan instead of a full build when its own checks passed', async () => {
    const pid = (await h.db.insert(projects).values({ organizationId: orgId, name: 'Hedefli', slug: 'hedefli', technologies: ['Node.js'], settings: { executionTrust: 'trusted' } }).returning())[0]!.id;
    const key = ctx.storage.repoKey(pid);
    await h.db.insert(repositories).values({ projectId: pid, storageKey: key, status: 'ready', defaultBranch: 'main' });
    const repo = await GitRepository.initBare(ctx.storage.resolve(key), 'main');
    const head = await repo.commitChanges({
      branch: 'main',
      baseCommit: null,
      message: 'init',
      author: { name: 'Dev', email: 'dev@example.com' },
      changes: [
        { action: 'upsert', path: 'src/cart.mjs', content: BUGGY },
        { action: 'upsert', path: 'check.mjs', content: "import { cartTotal } from './src/cart.mjs';\nif (cartTotal([{ price: 1.1, qty: 3 }]) !== 3.3) process.exit(1);\n" },
      ],
    });
    await h.db.insert(projectManifests).values({ projectId: pid, version: 1, source: 'detected', commitSha: head, content: parseManifest('project:\n  name: Hedefli\nruntime:\n  type: node\ntest:\n  command: node check.mjs\n') });
    const script: ScriptedTurn[] = [
      { toolCalls: [{ name: 'read_file', input: { path: 'src/cart.mjs' } }] },
      { toolCalls: [{ name: 'write_file', input: { path: 'src/cart.mjs', content: FIXED } }] },
      { toolCalls: [{ name: 'run_checks', input: { kind: 'all' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: 'Toplam düzeltildi.', explanation: ['cartTotal'] } }] },
    ];
    const start = fake.requests.length;
    turnFor = (_req, i) => script[i - start]!;
    const t0 = (
      await h.db
        .insert(aiTasks)
        .values({
          organizationId: orgId,
          projectId: pid,
          number: 11,
          type: 'fix',
          title: 'src/cart.mjs: 1 sorunu düzelt',
          instruction: 'Düzelt.',
          autonomyLevel: 'L2',
          sourceType: 'security',
          baseBranch: 'main',
          requestedBy: userId,
          autofix: { batchId: '00000000-0000-0000-0000-000000000000', risk: 'medium', mode: 'agent', kind: 'code', findingIds: [], fingerprints: [] },
        })
        .returning()
    )[0]!;
    await runAiTask(ctx, job(t0.id));

    const t = (await h.db.select().from(aiTasks).where(eq(aiTasks.id, t0.id)))[0]!;
    expect(t.status, t.error ?? '').toBe('awaiting_approval');
    // No 20-minute build: the verification (re-scan of exactly what changed) is queued for the task itself.
    expect(t.buildId).toBeNull();
    expect(t.result?.explanation.at(-1)).toMatch(/Tam build yapılmadı/);
    const verify = (await h.db.select().from(jobs).where(eq(jobs.type, 'ai.autofix.verify'))).filter((j) => (j.payload as { taskId?: string }).taskId === t0.id);
    expect(verify).toHaveLength(1);
  }, 120_000);

  it('keeps a task interrupted by a worker shutdown runnable instead of failing it', async () => {
    const t0 = (await h.db.insert(aiTasks).values({ organizationId: orgId, projectId, number: 12, type: 'fix', title: 'Kesinti', instruction: 'Düzelt.', autonomyLevel: 'L2', sourceType: 'manual', baseBranch: 'main', requestedBy: userId }).returning())[0]!;
    // The shutdown signal arrives while the model is answering.
    const controller = new AbortController();
    turnFor = () => {
      controller.abort();
      return { toolCalls: [{ name: 'read_file', input: { path: 'src/cart.mjs' } }] };
    };
    const out = await runAiTask(ctx, { job: { id: 'j', type: 'ai.task.run', payload: { taskId: t0.id }, attempts: 1, maxAttempts: 1 }, logger, signal: controller.signal } as unknown as JobContext);
    expect(out).toEqual({ status: 'interrupted' });
    const t = (await h.db.select().from(aiTasks).where(eq(aiTasks.id, t0.id)))[0]!;
    expect(t.status).toBe('running'); // the re-queued job replays it from the start
    expect(t.error).toBeNull();
  }, 60_000);

  it('never commits or builds twice when a task interrupted after its commit runs again', async () => {
    const before = fake.requests.length;
    const buildsBefore = (await h.db.select().from(builds)).length;
    const t0 = (
      await h.db
        .insert(aiTasks)
        .values({ organizationId: orgId, projectId, number: 13, type: 'fix', title: 'Commit sonrası kesinti', instruction: 'Düzelt.', autonomyLevel: 'L2', sourceType: 'manual', baseBranch: 'main', requestedBy: userId, status: 'running', branch: 'ai/AI-13-x', headCommit: 'b'.repeat(40) })
        .returning()
    )[0]!;
    const out = await runAiTask(ctx, job(t0.id));
    expect(out).toMatchObject({ status: 'failed' });
    const t = (await h.db.select().from(aiTasks).where(eq(aiTasks.id, t0.id)))[0]!;
    expect(t.error).toMatch(/commit\/build aşamasında kesildi/);
    expect(t.headCommit).toBe('b'.repeat(40)); // the existing commit is kept, no second one
    expect(fake.requests.length).toBe(before); // the model was not asked again
    expect((await h.db.select().from(builds)).length).toBe(buildsBefore);
  });

  it('fails the task (no branch, no build) when the model refuses', async () => {
    const before = fake.requests.length;
    turnFor = () => ({ text: '', stopReason: 'refusal' });
    const task = await newTask(2, 'Riskli istek');
    await runAiTask(ctx, job(task.id));
    const t = (await h.db.select().from(aiTasks).where(eq(aiTasks.id, task.id)))[0]!;
    expect(t.status).toBe('failed');
    expect(t.error).toContain('reddetti');
    expect(fake.requests.length).toBe(before + 1);
    const git = new GitRepository(ctx.storage.resolve(ctx.storage.repoKey(projectId)));
    expect((await git.branches()).map((b) => b.name).filter((n) => n.startsWith('ai/AI-2'))).toEqual([]);
  });

  it('reads a file larger than one read in parts and edits it without rewriting what it did not see', async () => {
    const git = new GitRepository(ctx.storage.resolve(ctx.storage.repoKey(projectId)));
    const big = `${Array.from({ length: 3000 }, (_, i) => `// satır ${i + 1} ${'x'.repeat(40)}`).join('\n')}\nexport const LIMIT = 1;\n`;
    await git.commitChanges({ branch: 'main', baseCommit: (await git.resolve('refs/heads/main'))!, message: 'big', author: { name: 'Dev', email: 'dev@example.com' }, changes: [{ action: 'upsert', path: 'src/big.mjs', content: big }] });
    const before = fake.requests.length;
    const script: ScriptedTurn[] = [
      { toolCalls: [{ name: 'read_file', input: { path: 'src/big.mjs' } }] },
      { toolCalls: [{ name: 'write_file', input: { path: 'src/big.mjs', content: 'export const LIMIT = 2;\n' } }, { name: 'edit_file', input: { path: 'src/big.mjs', old_text: 'export const LIMIT = 1;', new_text: 'export const LIMIT = 2;' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: 'Limit 2 oldu.', explanation: ['LIMIT 2'] } }] },
    ];
    turnFor = (_req, i) => script[i - before]!;
    const task = await newTask(9, 'Büyük dosya');
    await runAiTask(ctx, job(task.id));

    const results = (i: number) => (fake.requests[before + i]!.body.messages.at(-1)!.content as { content: string; is_error: boolean }[]);
    const part = results(1)[0]!.content;
    expect(part.length).toBeLessThan(big.length);
    expect(part).toMatch(/Devamı için read_file start_line=\d+/);
    expect(results(2)[0]).toMatchObject({ is_error: true, content: expect.stringContaining('yalnız bir kısmını') });
    expect(results(2)[1]!.is_error).toBe(false);
    const t = (await h.db.select().from(aiTasks).where(eq(aiTasks.id, task.id)))[0]!;
    expect(t.status).toBe('awaiting_approval');
    expect((await git.readFile(t.headCommit!, 'src/big.mjs'))!.content.toString()).toBe(big.replace('LIMIT = 1', 'LIMIT = 2'));
  }, 60_000);

  it('respects a project-level autonomy cap from projecthub.yml (ai.autonomy L1 forbids code changes)', async () => {
    await h.db.insert(projectManifests).values({ projectId, version: 1, source: 'repository', commitSha: base, content: parseManifest(`project:
  name: Nova
ai:
  autonomy: L1
`) });
    const before = fake.requests.length;
    const task = await newTask(3, 'Kapalı projede değişiklik');
    await runAiTask(ctx, job(task.id));
    const t = (await h.db.select().from(aiTasks).where(eq(aiTasks.id, task.id)))[0]!;
    expect(t.status).toBe('failed');
    expect(t.error).toContain('en az L2');
    expect(fake.requests.length).toBe(before); // the model is never called
  });
  it('resumes an interrupted draft from PostgreSQL and verifies the restored edits without changing main', async () => {
    const pid = (await h.db.insert(projects).values({ organizationId: orgId, name: 'Resume', slug: 'resume', technologies: ['Node.js'], settings: { executionTrust: 'trusted' } }).returning())[0]!.id;
    const key = ctx.storage.repoKey(pid);
    await h.db.insert(repositories).values({ projectId: pid, storageKey: key, status: 'ready', defaultBranch: 'main' });
    const repo = await GitRepository.initBare(ctx.storage.resolve(key), 'main');
    const head = await repo.commitChanges({ branch: 'main', baseCommit: null, message: 'init', author: { name: 'Dev', email: 'dev@example.com' }, changes: [
      { action: 'upsert', path: 'src/cart.mjs', content: BUGGY },
      { action: 'upsert', path: 'check.mjs', content: "import { cartTotal } from './src/cart.mjs'; if (cartTotal([{price:1.1,qty:3}]) !== 3.3) process.exit(1);" },
    ] });
    await h.db.insert(projectManifests).values({ projectId: pid, version: 1, source: 'detected', commitSha: head, content: parseManifest('project:\n  name: Resume\nruntime:\n  type: node\ntest:\n  command: node check.mjs\n') });
    const task = (await h.db.insert(aiTasks).values({ organizationId: orgId, projectId: pid, number: 39, type: 'fix', title: 'Resume cart fix', instruction: 'Testi geçir.', autonomyLevel: 'L2', sourceType: 'manual', baseBranch: 'main', requestedBy: userId }).returning())[0]!;
    const queued = (await h.db.insert(jobs).values({ organizationId: orgId, projectId: pid, type: 'ai.task.run', queue: 'ai', status: 'running', lockedBy: ctx.workerId, lockedUntil: new Date(Date.now() + 600_000), payload: { taskId: task.id } }).returning())[0]!;
    const controller = new AbortController();
    let start = fake.requests.length;
    turnFor = (_req, i) => {
      if (i - start === 0) return { toolCalls: [{ name: 'read_file', input: { path: 'src/cart.mjs' } }] };
      if (i - start === 1) return { toolCalls: [{ name: 'write_file', input: { path: 'src/cart.mjs', content: FIXED } }] };
      controller.abort();
      return { toolCalls: [{ name: 'finish', input: { summary: 'Interrupted', explanation: ['Interrupted'] } }] };
    };
    expect(await runAiTask(ctx, { job: queued, logger, signal: controller.signal })).toEqual({ status: 'interrupted' });
    const saved = (await h.db.select().from(jobs).where(eq(jobs.id, queued.id)))[0]!;
    expect(saved.payload.aiCheckpoint).toEqual(expect.any(String));
    expect(String(saved.payload.aiCheckpoint)).not.toContain('cartTotal');
    expect(await repo.resolve('refs/heads/main')).toBe(head);
    start = fake.requests.length;
    const script: ScriptedTurn[] = [
      { toolCalls: [{ name: 'read_file', input: { path: 'src/cart.mjs' } }] },
      { toolCalls: [{ name: 'run_checks', input: { kind: 'all' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: 'Kayıtlı düzeltme doğrulandı.', explanation: ['Test geçti.'] } }] },
    ];
    turnFor = (_req, i) => script[i - start]!;
    await runAiTask(ctx, { job: saved, logger, signal: new AbortController().signal });
    const result = (await h.db.select().from(aiTasks).where(eq(aiTasks.id, task.id)))[0]!;
    expect(result.status, result.error ?? '').toBe('awaiting_approval');
    expect((await repo.readFile(result.headCommit!, 'src/cart.mjs'))!.content.toString()).toBe(FIXED);
    expect(await repo.resolve('refs/heads/main')).toBe(head);
    const messages = fake.requests[start]!.body.messages;
    expect(JSON.stringify(messages)).toContain('Interrupted run recovery');
    expect(JSON.stringify(fake.requests[start + 1]!.body.messages.at(-1))).toContain('i.price * i.qty');
    expect(result.result?.explanation.join('\n')).toMatch(/kontrol/i);
  }, 120_000);
  it('does not checkpoint or commit a draft after another worker owns the job lease', async () => {
    const pid = (await h.db.insert(projects).values({ organizationId: orgId, name: 'Lease', slug: 'lease', technologies: ['Node.js'] }).returning())[0]!.id;
    const key = ctx.storage.repoKey(pid);
    await h.db.insert(repositories).values({ projectId: pid, storageKey: key, status: 'ready', defaultBranch: 'main' });
    const repo = await GitRepository.initBare(ctx.storage.resolve(key), 'main');
    const head = await repo.commitChanges({ branch: 'main', baseCommit: null, message: 'init', author: { name: 'Dev', email: 'dev@example.com' }, changes: [{ action: 'upsert', path: 'src/cart.mjs', content: BUGGY }] });
    const task = (await h.db.insert(aiTasks).values({ organizationId: orgId, projectId: pid, number: 40, type: 'fix', title: 'Lease fix', instruction: 'Düzelt.', autonomyLevel: 'L2', sourceType: 'manual', baseBranch: 'main', requestedBy: userId }).returning())[0]!;
    const claimed = (await h.db.insert(jobs).values({ organizationId: orgId, projectId: pid, type: 'ai.task.run', queue: 'ai', status: 'running', lockedBy: 'another-worker', lockedUntil: new Date(Date.now() + 600_000), payload: { taskId: task.id } }).returning())[0]!;
    const start = fake.requests.length;
    const script: ScriptedTurn[] = [
      { toolCalls: [{ name: 'read_file', input: { path: 'src/cart.mjs' } }] },
      { toolCalls: [{ name: 'write_file', input: { path: 'src/cart.mjs', content: FIXED } }] },
      { toolCalls: [{ name: 'finish', input: { summary: 'Must not commit', explanation: ['Must not commit'] } }] },
    ];
    turnFor = (_req, i) => script[i - start]!;
    const outcome = await runAiTask(ctx, { job: claimed, logger, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ status: 'failed', message: expect.stringContaining('ara kaydı') });
    const result = (await h.db.select().from(aiTasks).where(eq(aiTasks.id, task.id)))[0]!;
    expect(result.headCommit).toBeNull();
    expect(result.buildId).toBeNull();
    expect((await h.db.select().from(jobs).where(eq(jobs.id, claimed.id)))[0]!.payload.aiCheckpoint).toBeUndefined();
    expect(await repo.resolve('refs/heads/main')).toBe(head);
  }, 60_000);
  npmDependencyRegression();
});
