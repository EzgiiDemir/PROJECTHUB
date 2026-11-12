import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Manifest } from '@projecthub/contracts';
import { resolveEnvSecrets, type FileChange, type GitRepository } from '@projecthub/core';
import type { WorkerCtx } from '../context.js';
import { extractError } from '../runner/errors.js';
import { dockerBinary, maskSecrets, runCommand, runContainerCommand, secretMaskList } from '../runner/process.js';
import { ContainerWorkspace } from '../runner/container-workspace.js';
import { buildEnv, manifestAt, testEnvironment, withNodeInstall } from './build.js';
import { hasSourceTests, inferTestCommand } from './build-quality.js';
import { dependencyCache, restoreDependencies, saveDependencies, touchesDependencies, type DependencyCache } from './dep-cache.js';
import { laravelBootstrapEnv, prepareLaravelWorkspace } from './laravel-bootstrap.js';
import { npmLockMismatch, npmLockRecipe } from './npm-lock.js';

/** Runs per task: enough for edit → check → fix cycles, bounded so a confused model cannot loop on builds. */
export const MAX_AGENT_CHECK_RUNS = 6;
const OUTPUT_TAIL_LINES = 80;

export type CheckKind = 'build' | 'test' | 'all';

/**
 * The coding agent's own verification loop. A private working copy of the base commit receives the agent's pending
 * edits, and the project's real install, build and test commands run there with the same isolation as builds (in
 * container mode: ephemeral container, network only for the install). The agent sees what failed and can fix it
 * before anything is committed; the commit still gets its own independent verification build afterwards.
 */
export class AgentChecks {
  private dir: string | null = null;
  private toolDir: string | null = null;
  private manifest: Manifest | null = null;
  private env: NodeJS.ProcessEnv | null = null;
  private installed = false;
  private deps: DependencyCache | null = null;
  /** The agent's lockfile/manifest edits the installed dependencies reflect ('' = none, the base commit's). */
  private installedFor = '';
  /** Dependency folders are hard links into the cache. */
  private linked = false;
  private secretNames: string[] = [];
  private secretValues: string[] = [];
  private cws: ContainerWorkspace | null = null;
  /** What the working copy currently holds for each path the agent touched (null = deleted). */
  private applied = new Map<string, string | null>();
  runs = 0;
  /** One-line outcome of the latest run (✔/✘ per step), for the task's result. */
  lastResult: string | null = null;
  /** Edit sets (signatures) that a passing build / test run covered. */
  private passed = { build: '', test: '' };
  /** A repeated check on identical edits cannot produce new evidence; keep failures as well as successes. */
  private readonly results = new Map<string, string>();

  constructor(
    private readonly ctx: WorkerCtx,
    private readonly opts: { organizationId: string; projectId: string; taskId: string; git: GitRepository; base: string; signal: AbortSignal },
  ) {}

  /** The commands a check would run, or null when the project defines none (the tool is then not offered). */
  static async commandsFor(ctx: WorkerCtx, projectId: string, git: GitRepository, base: string): Promise<{ build?: string; test?: string } | null> {
    const resolved = await manifestAt(ctx, projectId, git, base);
    const files = (await git.listFiles(base)).map((file) => file.path);
    const manifest = await withInferredTest(resolved.manifest, files, async (file) => (await git.readFile(base, file))?.content.toString('utf8') ?? null);
    const out = { build: manifest.build?.command || undefined, test: manifest.test?.command || undefined };
    return out.build || out.test ? out : null;
  }

  async check(kind: CheckKind, changes: FileChange[]): Promise<string> {
    const key = `${kind}:${signatureOf(changes)}`;
    const previous = this.results.get(key);
    if (previous !== undefined) return `Bu kod ve kontrol için sonuç zaten alındı; komutlar yeniden çalıştırılmadı. Hata kod dışındaysa finish ile bildirin.\n${previous}`;
    const text = await this.run(kind, changes);
    // Cancellation is not a completed verification and must never become reusable evidence.
    if (!this.opts.signal.aborted && /^[✔✘]/m.test(text) && !text.includes('Kontrol iptal edildi.')) this.results.set(key, text);
    const status = text.split('\n').filter((l) => /^[✔✘]/.test(l));
    if (status.length) this.lastResult = status.map((l) => l.replace(/\s*\(.*$/, '')).join(' · ');
    if (text.endsWith('Tüm kontroller geçti.')) {
      const sig = signatureOf(changes);
      if (kind !== 'test') this.passed.build = sig;
      if (kind !== 'build') this.passed.test = sig;
    }
    return text;
  }

  async updateNpmLock(packagePath: string, changes: FileChange[]): Promise<FileChange> {
    const recipe = npmLockRecipe(packagePath);
    await this.prepare();
    const before = await Promise.all([packagePath, recipe.lockPath].map(async (file) => ({
      file, content: await fs.readFile(path.join(this.dir!, file)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; }),
      applied: this.applied.get(file), tracked: this.applied.has(file),
    })));
    try {
      await this.sync(changes);
      const dir = packagePath.slice(0, -'package.json'.length);
      for (const other of ['pnpm-lock.yaml', 'yarn.lock']) {
        if (await fs.stat(path.join(this.dir!, dir, other)).catch(() => null)) throw new Error('Bu uygulama npm değil; kendi paket yöneticisinin lock dosyası korunmalı.');
      }
      let output = '';
      const result = await this.exec(recipe.command, 'bridge', this.ctx.config.BUILD_INSTALL_TIMEOUT_MINUTES * 60_000, (text) => { output = (output + text).slice(-4000); }, this.env!);
      if (result.cancelled || result.timedOut || result.exitCode !== 0) throw new Error(`Lock üretilemedi: ${result.cancelled ? 'iptal edildi' : result.timedOut ? 'zaman aşımı' : extractError(output.split('\n')).message}`);
      return { action: 'upsert', path: recipe.lockPath, content: await fs.readFile(path.join(this.dir!, recipe.lockPath), 'utf8') };
    } catch (error) {
      // A failed resolver must not contaminate the next check with an unaccepted package or partial lockfile.
      for (const entry of before) {
        const target = path.join(this.dir!, entry.file);
        if (entry.content === null) await fs.rm(target, { force: true });
        else await fs.writeFile(target, entry.content);
        if (entry.tracked) this.applied.set(entry.file, entry.applied!);
        else this.applied.delete(entry.file);
      }
      throw error;
    }
  }

  /** True when the build and tests the project defines passed on exactly these edits. */
  verifies(changes: FileChange[]): boolean {
    if (!this.manifest) return false;
    const sig = signatureOf(changes);
    return (!this.manifest.build?.command || this.passed.build === sig) && (!this.manifest.test?.command || this.passed.test === sig);
  }

  private async run(kind: CheckKind, changes: FileChange[]): Promise<string> {
    if (this.runs >= MAX_AGENT_CHECK_RUNS) return `Bu görevde en fazla ${MAX_AGENT_CHECK_RUNS} kontrol çalıştırılabilir; sınıra ulaşıldı. Son sonuca göre değişikliği tamamla ve finish çağır.`;
    this.runs += 1;
    await this.prepare();
    // An edit to a lockfile or package manifest needs a real install; the cached set is the base commit's.
    const depEdits = changes.filter((c) => touchesDependencies([c.path]));
    const signature = depEdits.length ? JSON.stringify(depEdits.map((c) => [c.path, c.action, c.action === 'delete' ? '' : c.content.toString()]).sort()) : '';
    if (this.installed && signature !== this.installedFor) {
      this.installed = false;
      // Linked from the cache: an install would rewrite shared files in place (Composer's autoload), so it starts
      // from empty folders instead. Removing a link never touches the cached copy.
      if (this.linked) for (const rel of this.deps?.dirs ?? []) await fs.rm(path.join(this.dir!, rel), { recursive: true, force: true });
      this.linked = false;
    }
    await this.sync(changes);
    const manifest = this.manifest!;
    if (/\bnpm\s+ci\b/.test(manifest.install?.command ?? '')) {
      const files = [...new Set([...(await this.opts.git.listFiles(this.opts.base)).map((f) => f.path), ...changes.filter((c) => c.action !== 'delete').map((c) => c.path)])];
      const mismatch = await npmLockMismatch(files, (file) => fs.readFile(path.join(this.dir!, file), 'utf8').catch(() => null));
      if (mismatch) return `✘ Kurulum BAŞARISIZ\n${mismatch} package.json ile uyumsuz. update_npm_lock aracını ilgili package.json yolu ile çağır, sonra run_checks çalıştır. Diğer paket kurulumları başlatılmadı.`;
    }
    const steps: { name: string; command: string; network: 'bridge' | 'none'; timeoutMinutes: number; test?: boolean }[] = [];
    if (!this.installed && manifest.install?.command) steps.push({ name: 'Kurulum', command: manifest.install.command, network: 'bridge', timeoutMinutes: this.ctx.config.BUILD_INSTALL_TIMEOUT_MINUTES });
    if (kind !== 'test' && manifest.build?.command) steps.push({ name: 'Build', command: manifest.build.command, network: 'none', timeoutMinutes: manifest.build.timeoutMinutes ?? 20 });
    if (kind !== 'build' && manifest.test?.command) steps.push({ name: 'Testler', command: manifest.test.command, network: 'none', timeoutMinutes: 15, test: true });
    if (!steps.some((s) => s.name !== 'Kurulum')) return `Projede ${kind === 'test' ? 'test' : 'build'} komutu tanımlı değil; ${kind === 'test' ? "kind: 'build'" : "kind: 'test'"} deneyin.`;

    const report: string[] = [];
    for (const step of steps) {
      let output = '';
      const limit = step.name === 'Kurulum' ? this.ctx.config.BUILD_INSTALL_TIMEOUT_MINUTES : this.ctx.config.BUILD_TIMEOUT_MINUTES;
      const r = await this.exec(step.command, step.network, Math.min(step.timeoutMinutes, limit) * 60_000, (t) => {
        output = (output + t).slice(-200_000);
      }, step.test ? testEnvironment(this.env!, this.secretNames, manifest.test?.env) : this.env!);
      // What the model sees (and the task page stores) never contains a Secrets value the command printed.
      const lines = maskSecrets(output.replace(/\r/g, ''), this.secretValues).split('\n');
      if (r.cancelled) return 'Kontrol iptal edildi.';
      if (r.timedOut || r.exitCode !== 0) {
        const extracted = r.timedOut ? { message: `Zaman aşımı (${step.timeoutMinutes} dk)` } : extractError(lines.slice(-200));
        report.push(
          `✘ ${step.name} BAŞARISIZ (${step.command}, çıkış kodu ${r.exitCode ?? '-'})`,
          `Hata: ${extracted.message}${'file' in extracted && extracted.file ? ` · ${extracted.file}${'line' in extracted && extracted.line ? `:${extracted.line}` : ''}` : ''}`,
          'Çıktının sonu:',
          lines.slice(-OUTPUT_TAIL_LINES).join('\n'),
        );
        if (step.name === 'Kurulum') report.push('Bağımlılık kurulumu başarısız olduğu için build/test çalıştırılmadı.');
        return report.join('\n');
      }
      if (step.name === 'Kurulum') {
        this.installed = true;
        this.installedFor = signature;
        if (this.deps && !signature) await saveDependencies(this.ctx, this.opts.projectId, this.deps, this.dir!).catch(() => 0);
      }
      report.push(`✔ ${step.name} başarılı (${step.command}, ${(r.durationMs / 1000).toFixed(1)} sn)`);
    }
    return `${report.join('\n')}\nTüm kontroller geçti.`;
  }

  async dispose(): Promise<void> {
    await this.cws?.remove();
    for (const dir of [this.dir, this.toolDir]) if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }

  private async prepare() {
    if (this.dir) return;
    const dir = this.ctx.storage.resolve(this.ctx.storage.workspaceKey('ai', `${this.opts.taskId}-checks`));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    await fs.mkdir(dir, { recursive: true });
    const base = (await manifestAt(this.ctx, this.opts.projectId, this.opts.git, this.opts.base)).manifest;
    // Container checks work in a Docker volume like container builds (no bind mount, no host dependency cache).
    this.cws = this.ctx.config.BUILD_EXECUTOR === 'container' ? new ContainerWorkspace(dockerBinary(), this.ctx.config.BUILD_CONTAINER_IMAGE, `ai-${this.opts.taskId}`, { 'com.projecthub.ai-task': this.opts.taskId }) : null;
    this.deps = this.cws ? null : await dependencyCache(this.ctx, this.opts.projectId, this.opts.git, this.opts.base, base, false).catch(() => null);
    await this.opts.git.exportTo(this.opts.base, dir, { skipDirs: this.deps?.hit ? this.deps.dirs : [] });
    // Same dependency cache as builds: a check starts without a ten-minute install when the lockfiles are unchanged.
    if (this.deps?.hit) this.installed = this.linked = (await restoreDependencies(this.ctx, this.opts.projectId, this.deps, dir).catch(() => ({ ok: false }))).ok;
    const toolDir = this.ctx.storage.resolve(`tmp/build-tools-ai-${this.opts.taskId}`);
    await fs.mkdir(toolDir, { recursive: true });
    await Promise.all([fs.mkdir(this.ctx.storage.resolve('tmp/package-cache/npm'), { recursive: true }), fs.mkdir(this.ctx.storage.resolve('tmp/package-cache/composer'), { recursive: true })]);
    const files = (await this.opts.git.listFiles(this.opts.base)).map((file) => file.path);
    await prepareLaravelWorkspace(dir, files);
    const inferred = await withInferredTest(base, files, (file) => fs.readFile(path.join(dir, file), 'utf8').catch(() => null));
    const { manifest } = await withNodeInstall(inferred, dir);
    // Values that cannot be decrypted are left out, as in builds; the check output shows what that breaks.
    const secrets = await resolveEnvSecrets(this.ctx.db, this.ctx.config.encryptionKey, { organizationId: this.opts.organizationId, projectId: this.opts.projectId, environmentId: null, scope: 'build' }, () => undefined);
    this.env = laravelBootstrapEnv(buildEnv(this.ctx, manifest, secrets, toolDir, { PROJECTHUB_AI_CHECK: '1', PROJECTHUB_COMMIT: this.opts.base }), files);
    this.secretNames = Object.keys(secrets);
    this.secretValues = secretMaskList(secrets);
    this.manifest = manifest;
    this.toolDir = toolDir;
    this.dir = dir;
  }

  /** Brings the working copy in line with the agent's pending changes (only paths that changed since the last run). */
  private async sync(changes: FileChange[]) {
    const dir = this.dir!;
    const touched: { rel: string; deleted: boolean }[] = [];
    for (const c of changes) {
      const next = c.action === 'delete' ? null : typeof c.content === 'string' ? c.content : c.content.toString('utf8');
      if (this.applied.has(c.path) && this.applied.get(c.path) === next) continue;
      const target = path.resolve(dir, c.path);
      if (!target.startsWith(dir + path.sep)) continue;
      if (next === null) await fs.rm(target, { force: true });
      else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, next);
      }
      this.applied.set(c.path, next);
      touched.push({ rel: c.path, deleted: next === null });
    }
    // Once the volume exists, only the files the agent changed since the last run are copied into it.
    await this.cws?.sync(dir, touched);
  }

  private async exec(command: string, network: 'bridge' | 'none', timeoutMs: number, onOutput: (t: string) => void, env: NodeJS.ProcessEnv) {
    const common = { command, cwd: this.dir!, env, timeoutMs, onOutput, signal: this.opts.signal };
    const cfg = this.ctx.config;
    if (this.cws) await this.cws.seed(this.dir!);
    return cfg.BUILD_EXECUTOR === 'container'
      ? runContainerCommand({
          ...common,
          cacheVolume: `projecthub-cache-${this.opts.projectId}`,
          workspaceMount: this.cws?.mount(),
          limits: { image: cfg.BUILD_CONTAINER_IMAGE, cpus: cfg.BUILD_CONTAINER_CPUS, memoryMb: cfg.BUILD_CONTAINER_MEMORY_MB, pids: cfg.BUILD_CONTAINER_PIDS, network },
          labels: { 'com.projecthub.managed': 'build', 'com.projecthub.worker': this.ctx.workerId, 'com.projecthub.ai-task': this.opts.taskId },
        })
      : runCommand(common);
  }
}

/** Keep the AI edit loop and the final build on the same test contract when a manifest omitted test.command. */
async function withInferredTest(manifest: Manifest, files: string[], read: (file: string) => Promise<string | null>): Promise<Manifest> {
  if (manifest.test?.command || !hasSourceTests(files)) return manifest;
  const command = await inferTestCommand(files, read, manifest.install?.command ?? '');
  return command ? { ...manifest, test: { command, env: {} } } : manifest;
}

function signatureOf(changes: FileChange[]): string {
  return JSON.stringify(changes.map((c) => [c.path, c.action, c.action === 'delete' ? '' : createHash('sha1').update(c.content).digest('hex')]).sort());
}
