import { spawn } from 'node:child_process';
import type { Manifest } from '@projecthub/contracts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';
import {
  ai,
  audit,
  blockedByDependencyConflict,
  compareVersions,
  createAutofixTasks,
  emitDomainEvent,
  enqueue,
  getOrgSettings,
  planAutofix,
  PRE_EXISTING_CONFLICT,
  isProtectedBranch,
  publish,
  QUEUES,
  reprepareAutofix,
  canReprepare,
  DeferJobError,
  scan,
  slugify,
  timeline,
  type Actor,
  type FileChange,
  type JobContext,
  type Logger,
} from '@projecthub/core';
import { aiActions, aiMemories, aiRuns, aiTasks, auditEvents, builds, previews, projectManifests, repositories, securityFindings, type AiAutofix, type AutofixUpgrade } from '@projecthub/database';
import { commitSnapshot, loadProject, openRepo, type WorkerCtx } from '../context.js';
import { commitPrepared, runAiTask } from './ai.js';
import { buildRelevantPaths } from './build-need.js';

/** Test code and test configuration (any language): changes there need a person's eye. */
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|e2e|cypress)\/|\.(test|spec)\.[cm]?[jt]sx?$|Test\.php$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|(^|\/)(phpunit\.xml(\.dist)?|pytest\.ini|conftest\.py)$/i;

const AUTOFIX_ACTOR: Actor = { type: 'ai', id: null, label: 'AI otomatik düzeltme' };
const LEVEL = { L0: 0, L1: 1, L2: 2, L3: 3 } as const;

/** Files a change of each kind may touch and still count as low risk. */
const ALLOWED_FILES: Partial<Record<AiAutofix['kind'], RegExp>> = {
  dependency: /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|npm-shrinkwrap\.json|requirements\.txt|composer\.json|composer\.lock)$/,
  docs: /(^|\/)([^/]+\.(md|mdx|txt|rst)|docs\/.+)$/i,
};

/** `ai.task.run`: deterministic dependency fixes need no model; every other task goes to the coding agent. */
export async function runAiTaskOrAutofix(ctx: WorkerCtx, jc: JobContext) {
  const { taskId } = jc.job.payload as { taskId: string };
  const task = (await ctx.db.select().from(aiTasks).where(eq(aiTasks.id, taskId)))[0];
  if (task?.autofix?.mode === 'dependency' && task.status === 'queued') return runDependencyFix(ctx, task, jc.logger);
  if (task?.autofix?.mode === 'files' && task.status === 'queued') return runFilesFix(ctx, task);
  return runAiTask(ctx, jc);
}

type TaskRow = typeof aiTasks.$inferSelect;

async function runDependencyFix(ctx: WorkerCtx, task: TaskRow, logger: Logger) {
  const db = ctx.db;
  const project = await loadProject(ctx, task.projectId);
  const key = `AI-${task.number}`;
  const fail = async (message: string) => {
    await db.update(aiTasks).set({ status: 'failed', error: message, completedAt: new Date() }).where(eq(aiTasks.id, task.id));
    await timeline(db, { organizationId: task.organizationId, projectId: task.projectId, kind: 'ai', tone: 'bad', title: `${key} tamamlanamadı`, description: message, refType: 'ai_task', refId: task.id });
    await publish(db, { type: 'ai.task.updated', organizationId: task.organizationId, projectId: task.projectId, id: task.id });
    return { status: 'failed', message };
  };
  const settings = (await getOrgSettings(db, task.organizationId)).ai;
  if (!settings.policies.createBranch || !settings.policies.commitToAiBranch) return fail('AI politikaları branch oluşturmaya / commit etmeye izin vermiyor (Yönetim > AI kontrol merkezi).');
  // The package manager only resolves versions (--ignore-scripts, lockfile only), yet it still reads the project's
  // own config files; the same trust gate as builds applies.
  if ((project.settings as { executionTrust?: string }).executionTrust === 'untrusted') {
    return fail('Proje güvenilmeyen kaynak olarak işaretli. Bağımlılık güncellemesi paket yöneticisi çalıştırdığı için önce Ayarlar > Kod çalıştırma güveni onaylanmalı.');
  }
  const { git } = await openRepo(ctx, project.id);
  const baseBranch = task.baseBranch ?? project.defaultBranch;
  const base = await git.resolve(`refs/heads/${baseBranch}`);
  if (!base) return fail(`Temel branch bulunamadı: ${baseBranch}`);
  const branch = `ai/${key}-${slugify(task.title).slice(0, 40)}`;
  await db.update(aiTasks).set({ status: 'running', startedAt: new Date(), branch, baseCommit: base, baseBranch }).where(eq(aiTasks.id, task.id));
  await publish(db, { type: 'ai.task.updated', organizationId: task.organizationId, projectId: task.projectId, id: task.id });

  const dir = await ctx.storage.ensureDir(ctx.storage.workspaceKey('ai', task.id));
  // The commands the fix runs are recorded like an agent's tool calls, live: the task page shows each one while it
  // runs and its real output when it finishes.
  const run = (await db.insert(aiRuns).values({ organizationId: task.organizationId, projectId: task.projectId, taskId: task.id, purpose: 'autofix', provider: 'local', model: 'paket yöneticisi', userId: task.requestedBy }).returning({ id: aiRuns.id }))[0]!;
  const report: CommandReporter = async (e) => {
    const detail = { command: e.command, cwd: e.cwd, exitCode: e.code, durationMs: e.ms, result: e.code === null ? `… çalışıyor (${(e.ms / 1000).toFixed(0)} sn)\n${e.output.slice(-3000)}` : `${e.code === 0 ? '✔' : '✘'} çıkış kodu ${e.code} · ${(e.ms / 1000).toFixed(1)} sn\n${e.output.slice(-3000)}` };
    if (e.id) await db.update(aiActions).set({ detail }).where(eq(aiActions.id, e.id));
    else e.id = (await db.insert(aiActions).values({ runId: run.id, taskId: task.id, action: 'terminal', resource: `${e.cwd} $ ${e.command}`.slice(0, 500), riskLevel: 'medium', decision: 'allowed', detail }).returning({ id: aiActions.id }))[0]!.id;
    await publish(db, { type: 'ai.task.updated', organizationId: task.organizationId, projectId: task.projectId, id: task.id });
  };
  const closeRun = (status: 'completed' | 'failed', error?: string) => db.update(aiRuns).set({ status, error: error ?? null, finishedAt: new Date() }).where(eq(aiRuns.id, run.id)).catch(() => undefined);
  try {
    await git.exportTo(base, dir);
    const out = await applyUpgrades(dir, task.autofix!.upgrades ?? [], logger, report);
    await closeRun(out.changes.length ? 'completed' : 'failed');
    if (!out.changes.length) return fail(`Hiçbir dosya değişmedi. ${out.notes.join(' ')}`.trim());
    const finish = {
      summary: `${out.applied.length} bağımlılık güvenli sürüme yükseltildi`,
      explanation: [...out.applied.map((u) => `${u.name}: ${u.from ?? '?'} → ${u.to} (${u.source})`), ...out.notes],
    };
    return await commitPrepared(ctx, { task, project, git, branch, base, key, changes: out.changes, finish, settings, preparedBy: 'deterministik bağımlılık güncellemesi', logger, fail });
  } catch (e) {
    await closeRun('failed', (e as Error).message.slice(0, 400));
    return fail(`Bağımlılık güncellemesi hazırlanamadı: ${(e as Error).message.slice(0, 400)}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}

/**
 * Applies version bumps with the project's own package manager, lockfile only and without running any install
 * scripts. Returns the changed files as repository changes.
 */
/**
 * The cause of an npm ERESOLVE in one sentence. npm's last lines only point at log files, so the failed task said
 * nothing useful (Form, 2026-10-22: five security upgrades failed on eslint-plugin-import vs eslint 10). When neither
 * side of the conflict is a package being upgraded, the tree was already broken: no upgrade can succeed until it is.
 */
export function describeNpmConflict(output: string, upgraded: string[]): string | null {
  const lines = output.split(/\r?\n/).map((l) => l.replace(/^npm (?:error|ERR!)\s?/, '').trim());
  if (!lines.some((l) => /ERESOLVE/.test(l))) return null;
  const resolving = lines.find((l) => l.startsWith('While resolving:'))?.slice('While resolving:'.length).trim();
  const found = lines.find((l) => l.startsWith('Found:'))?.slice('Found:'.length).trim();
  const at = lines.findIndex((l) => /^Could not resolve dependency:/.test(l));
  const wants = at >= 0 ? lines[at + 1] : undefined;
  if (!resolving && !found) return 'ERESOLVE: paket sürümleri birbirini tutmuyor (ayrıntı build kaydında).';
  const name = (spec?: string) => spec?.replace(/^(@?[^@\s]+)@.*$/, '$1');
  const detail = `${resolving ?? 'bir paket'}${wants ? ` (${wants.replace(/\s+from\s+.*$/, '')} istiyor)` : ''}, projede ${found ?? 'farklı bir sürüm'} var`;
  const involved = [name(resolving), name(found)].filter(Boolean);
  const preExisting = involved.length > 0 && !involved.some((n) => upgraded.includes(n!));
  return preExisting
    ? `${PRE_EXISTING_CONFLICT} (bu yükseltmeden bağımsız): ${detail}. Bu çakışma giderilmeden bu klasörde hiçbir npm yükseltmesi yapılamaz.`
    : `ERESOLVE: ${detail}.`;
}

export async function applyUpgrades(dir: string, upgrades: AutofixUpgrade[], logger: Logger, report?: CommandReporter) {
  const runTool = (cmd: string, args: string[], cwd: string, log: Logger) => runReported(cmd, args, cwd, log, dir, report);
  const notes: string[] = [];
  const applied: AutofixUpgrade[] = [];
  const touched = new Map<string, string | null>(); // repo path → original content
  const remember = async (rel: string) => {
    if (!touched.has(rel)) touched.set(rel, await fs.readFile(path.join(dir, rel), 'utf8').catch(() => null));
  };
  const byFolder = new Map<string, AutofixUpgrade[]>();
  for (const u of upgrades) {
    const folder = path.posix.dirname(u.source) === '.' ? '' : path.posix.dirname(u.source);
    byFolder.set(`${u.ecosystem}|${folder}`, [...(byFolder.get(`${u.ecosystem}|${folder}`) ?? []), u]);
  }
  for (const [k, list] of byFolder) {
    const [ecosystem, folder] = k.split('|') as [string, string];
    const rel = (f: string) => (folder ? `${folder}/${f}` : f);
    const abs = (f: string) => path.join(dir, rel(f));
    if (ecosystem === 'npm') {
      const pkgText = await fs.readFile(abs('package.json'), 'utf8').catch(() => null);
      if (!pkgText) {
        notes.push(`${rel('package.json')} bulunamadı; ${list.map((u) => u.name).join(', ')} atlandı.`);
        continue;
      }
      const manager = (await exists(abs('pnpm-lock.yaml'))) ? 'pnpm' : (await exists(abs('package-lock.json'))) ? 'npm' : (await exists(abs('yarn.lock'))) ? 'yarn' : 'none';
      if (manager === 'yarn') {
        notes.push(`${rel('yarn.lock')}: Yarn lock dosyası için otomatik güncelleme yok; ${list.map((u) => u.name).join(', ')} elle yükseltilmeli.`);
        continue;
      }
      const pkg = JSON.parse(pkgText) as Record<string, unknown>;
      const indent = /^(\s+)"/m.exec(pkgText)?.[1] ?? '  ';
      const sections = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
      const done: AutofixUpgrade[] = [];
      for (const u of list) {
        if (!u.name) {
          // Lockfile only (no package changes): generated below.
          done.push(u);
          continue;
        }
        const section = sections.find((s) => (pkg[s] as Record<string, string> | undefined)?.[u.name] !== undefined);
        if (section) {
          const deps = pkg[section] as Record<string, string>;
          const spec = deps[u.name]!;
          const m = /^([~^]|>=)?\s*\d/.exec(spec);
          if (!m) {
            notes.push(`${u.name}: "${spec}" sürüm tanımı otomatik değiştirilemez (git/url/etiket).`);
            continue;
          }
          deps[u.name] = `${m[1] ?? ''}${u.to}`;
        } else {
          // Transitive dependency: pin the safe version through the package manager's override mechanism.
          if (manager === 'pnpm') {
            const p = ((pkg.pnpm as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
            p.overrides = { ...((p.overrides as Record<string, string>) ?? {}), [u.name]: `^${u.to}` };
            pkg.pnpm = p;
          } else {
            pkg.overrides = { ...((pkg.overrides as Record<string, string>) ?? {}), [u.name]: `^${u.to}` };
          }
          notes.push(`${u.name} dolaylı bağımlılık; "overrides" ile ^${u.to} sürümüne sabitlendi.`);
        }
        done.push(u);
      }
      if (!done.length) continue;
      const lockOnly = done.some((u) => !u.name);
      if (done.some((u) => u.name)) {
        await remember(rel('package.json'));
        await fs.writeFile(abs('package.json'), `${JSON.stringify(pkg, null, indent)}\n`);
      }
      // A project without any lockfile gets an npm one when it was asked for.
      const mgr = manager === 'none' && lockOnly ? 'npm' : manager;
      if (mgr !== 'none') {
        const lock = mgr === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json';
        await remember(rel(lock));
        const cmd = mgr === 'pnpm' ? ['corepack', ['pnpm', 'install', '--lockfile-only', '--ignore-scripts']] : ['npm', ['install', '--package-lock-only', '--ignore-scripts', '--strict-peer-deps', '--no-audit', '--no-fund']];
        const r = await runTool(cmd[0] as string, cmd[1] as string[], path.join(dir, folder), logger);
        if (r.code !== 0) {
          const conflict = mgr === 'npm' ? describeNpmConflict(r.output, done.map((u) => u.name).filter(Boolean)) : null;
          throw new Error(`${mgr} lock dosyasını güncelleyemedi (${folder || '.'}): ${conflict ?? r.output.split('\n').filter(Boolean).slice(-3).join(' ')}`);
        }
        if (manager === 'none') notes.push(`${rel(lock)} oluşturuldu; kurulumlar artık hep aynı sürümleri kullanır.`);
      } else notes.push(`${rel('package.json')} için lock dosyası yok; yalnızca sürüm aralığı güncellendi.`);
      applied.push(...done);
    } else if (ecosystem === 'Packagist') {
      // Composer: update only the affected packages inside their existing constraints, lockfile only, no scripts or
      // plugins. A package whose constraint does not allow the fixed version gets its constraint raised to ^fixed.
      if (!(await exists(abs('composer.json'))) || !(await exists(abs('composer.lock')))) {
        notes.push(`${rel('composer.json')} / composer.lock bulunamadı; ${list.map((u) => u.name).join(', ')} atlandı.`);
        continue;
      }
      const cwd = path.join(dir, folder);
      if ((await runTool('composer', ['--version'], cwd, logger)).code !== 0) {
        notes.push(`Sunucuda Composer yok; ${list.map((u) => u.name).join(', ')} için "composer update" elle çalıştırılmalı.`);
        continue;
      }
      await remember(rel('composer.json'));
      await remember(rel('composer.lock'));
      const flags = ['--with-dependencies', '--no-install', '--no-scripts', '--no-plugins', '--no-interaction', '--no-audit'];
      const update = (extra: string[] = []) => runTool('composer', ['update', ...list.map((u) => u.name), ...flags, ...extra], cwd, logger);
      let r = await update();
      if (r.code !== 0 && /php|platform|ext-/i.test(r.output)) {
        r = await update(['--ignore-platform-reqs']);
        if (r.code === 0) notes.push('Sunucudaki PHP sürümü projeninkinden farklı; kilit dosyası platform gereksinimleri yok sayılarak güncellendi.');
      }
      if (r.code !== 0) throw new Error(`composer kilit dosyasını güncelleyemedi: ${lastLines(r.output)}`);
      let lock = composerLocked(await fs.readFile(abs('composer.lock'), 'utf8'));
      const behind = list.filter((u) => compareVersions(lock.get(u.name.toLowerCase()) ?? '0', u.to) < 0);
      if (behind.length) {
        const manifest = JSON.parse(await fs.readFile(abs('composer.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
        let raised = 0;
        for (const u of behind) {
          for (const section of ['require', 'require-dev']) {
            if (manifest[section]?.[u.name]) {
              manifest[section]![u.name] = `^${u.to}`;
              raised++;
            }
          }
        }
        if (raised) {
          await fs.writeFile(abs('composer.json'), `${JSON.stringify(manifest, null, 4)}\n`);
          r = await update(['--ignore-platform-reqs']);
          if (r.code !== 0) throw new Error(`composer, sürüm kısıtı yükseltildikten sonra çözemedi: ${lastLines(r.output)}`);
          lock = composerLocked(await fs.readFile(abs('composer.lock'), 'utf8'));
        }
      }
      for (const u of list) {
        if (compareVersions(lock.get(u.name.toLowerCase()) ?? '0', u.to) >= 0) applied.push(u);
        else notes.push(`${u.name}: diğer paketlerin kısıtları ${u.to} sürümüne izin vermiyor; elle incelenmeli.`);
      }
    } else if (ecosystem === 'PyPI' && /requirements[^/]*\.txt$/.test(path.posix.basename(list[0]!.source))) {
      const file = list[0]!.source;
      const text = await fs.readFile(path.join(dir, file), 'utf8').catch(() => null);
      if (text === null) continue;
      let next = text;
      for (const u of list) {
        const name = u.name.replace(/[-_.]+/g, '[-_.]+');
        const re = new RegExp(`^(\\s*${name}(?:\\[[^\\]]*\\])?\\s*==\\s*)([^\\s;#]+)`, 'gim');
        if (re.test(next)) {
          next = next.replace(re, `$1${u.to}`);
          applied.push(u);
        } else notes.push(`${u.name}: ${file} içinde sabit (==) sürüm bulunamadı.`);
      }
      if (next !== text) {
        await remember(file);
        await fs.writeFile(path.join(dir, file), next);
      }
    } else {
      notes.push(`${ecosystem} ekosistemi için otomatik güncelleme yok: ${list.map((u) => u.name).join(', ')}.`);
    }
  }
  const changes: FileChange[] = [];
  for (const [rel, before] of touched) {
    const after = await fs.readFile(path.join(dir, rel), 'utf8').catch(() => null);
    if (after !== null && after !== before) changes.push({ action: 'upsert', path: rel, content: after });
  }
  return { changes, applied, notes };
}

async function exists(p: string) {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

/** One package manager command of a fix: called when it starts (code null), every few seconds while it runs, and at the end. */
export type CommandReporter = (e: { id?: string; command: string; cwd: string; code: number | null; output: string; ms: number }) => Promise<void>;

async function runReported(cmd: string, args: string[], cwd: string, logger: Logger, root: string, report?: CommandReporter) {
  if (!report) return runTool(cmd, args, cwd, logger);
  const entry: Parameters<CommandReporter>[0] = { command: [cmd, ...args].join(' '), cwd: path.relative(root, cwd).replace(/\\/g, '/') || '.', code: null, output: '', ms: 0 };
  const started = Date.now();
  // Reports run one after another, so a late progress update can never overwrite the final result.
  let chain = Promise.resolve();
  const send = (e: Parameters<CommandReporter>[0]) => (chain = chain.then(() => report(e)).catch(() => undefined));
  await send(entry);
  let last = 0;
  const r = await runTool(cmd, args, cwd, logger, (output) => {
    if (Date.now() - last < 3_000) return;
    last = Date.now();
    void send({ ...entry, output, ms: Date.now() - started });
  });
  await send({ ...entry, code: r.code, output: r.output, ms: Date.now() - started });
  return r;
}

/** Runs a package manager with a minimal environment: no Project Hub secrets, no install scripts. */
function runTool(cmd: string, args: string[], cwd: string, logger: Logger, onOutput?: (output: string) => void): Promise<{ code: number; output: string }> {
  const keep = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SystemRoot', 'ComSpec', 'PATHEXT', 'COREPACK_HOME', 'npm_config_cache', 'NPM_CONFIG_REGISTRY'];
  const env: Record<string, string> = { CI: 'true', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', npm_config_ignore_scripts: 'true' };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return new Promise((resolve) => {
    // Arguments are fixed literals (never derived from the repository), so the Windows shell needed for .cmd shims is safe.
    const child = spawn(cmd, args, { cwd, env, shell: process.platform === 'win32', windowsHide: true });
    let output = '';
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    const take = (d: Buffer) => {
      output = (output + d).slice(-20_000);
      onOutput?.(output);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, output: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      logger.info({ cmd, code }, 'autofix package manager finished');
      resolve({ code: code ?? 1, output: output.slice(-4000) });
    });
  });
}

/**
 * `ai.autofix.verify` — runs when an AI task's verification build finishes. Proves the fix (build and tests passed,
 * the targeted findings are gone from a fresh scan of the AI branch, nothing serious was introduced, only expected
 * files changed) and merges low-risk fixes when the organization's policy allows; otherwise records why a human must
 * decide.
 */
export async function verifyAutofix(ctx: WorkerCtx, { job, logger }: JobContext) {
  // `buildId`: after the verification build. `taskId`: a targeted fix that needed no full build (see commitPrepared).
  const { buildId, taskId } = job.payload as { buildId?: string; taskId?: string };
  const db = ctx.db;
  const task = (await db.select().from(aiTasks).where(buildId ? eq(aiTasks.buildId, buildId) : eq(aiTasks.id, taskId!)))[0];
  if (!task?.autofix || task.status !== 'awaiting_approval' || !task.headCommit || !task.branch) return { skipped: true };
  const fullBuild = buildId ? (await db.select().from(builds).where(eq(builds.id, buildId)))[0] : undefined;
  if (buildId && (!fullBuild || fullBuild.status === 'queued' || fullBuild.status === 'running')) return { skipped: 'build not finished' };
  // Evidence that the change works: the full build, or for a targeted fix the project's own build/tests the agent ran
  // on exactly these edits before committing (file removals need no execution at all).
  const build = fullBuild ?? { status: 'passed' as const, error: null as { step?: string; message?: string } | null, logKey: null as string | null };
  const project = await loadProject(ctx, task.projectId);
  const settings = (await getOrgSettings(db, task.organizationId)).ai;
  const { git } = await openRepo(ctx, project.id);
  const reasons: string[] = [];
  let remaining: string[] = [];
  let proven = false;
  /** Files a security fix should not need to touch; their change always goes to a person. */
  let guarded: string[] = [];
  let smoke: Awaited<ReturnType<typeof smokeCheck>> = null;

  if (build.status === 'cancelled') {
    reasons.push("Doğrulama build'i iptal edildi; düzeltme doğrulanmadı. \"Yeniden doğrula\" ile tekrar başlatabilirsiniz.");
  } else if (build.status !== 'passed') {
    reasons.push(`Doğrulama build'i başarısız: ${build.error?.step ?? ''} ${build.error?.message ?? build.status}`.trim());
  } else {
    const manifest = (await db.select({ content: projectManifests.content }).from(projectManifests).where(eq(projectManifests.projectId, project.id)).orderBy(desc(projectManifests.version)).limit(1))[0]?.content;
    // Behaviour, not only build + tests: the fixed app must start and its key pages must answer (before the scan, so a
    // still-starting app does not repeat it).
    smoke = fullBuild ? await smokeCheck(ctx, fullBuild, manifest) : null;
    if (smoke?.pending) throw new DeferJobError(smoke.pending, 20_000);
    if (smoke?.failed) reasons.push(smoke.failed);
    const snap = await commitSnapshot(git, task.headCommit);
    await snap.preload(snap.entries.filter((f) => scan.isScannable(f.path, f.size) || /(^|\/)(Dockerfile[^/]*|\.gitignore|\.env(\.[a-z]+)?)$/i.test(f.path)).map((f) => f.path));
    const result = await scan.scanRepository(snap, {
      secretScan: manifest?.security.secretScan ?? true,
      dependencyScan: manifest?.security.dependencyScan ?? true,
      osvUrl: ctx.config.OSV_API_URL,
      registries: { npm: ctx.config.NPM_REGISTRY_URL, pypi: ctx.config.PYPI_URL, packagist: ctx.config.PACKAGIST_URL },
    });
    const found = new Set(result.findings.map((f) => f.fingerprint));
    remaining = task.autofix.fingerprints.filter((fp) => found.has(fp));
    if (remaining.length) reasons.push(`${remaining.length} hedef bulgu yeniden taramada hâlâ var.`);
    const known = new Set(
      (
        await db
          .select({ fp: securityFindings.fingerprint })
          .from(securityFindings)
          .where(and(eq(securityFindings.projectId, project.id), eq(securityFindings.status, 'open')))
      ).map((r) => r.fp),
    );
    const introduced = result.findings.filter((f) => (f.severity === 'high' || f.severity === 'critical') && !known.has(f.fingerprint));
    if (introduced.length) reasons.push(`Değişiklik ${introduced.length} yeni yüksek/kritik bulgu getiriyor: ${introduced.slice(0, 3).map((f) => f.title).join('; ')}`);
    const allowed = ALLOWED_FILES[task.autofix.kind];
    const stats = await git.diffStat(task.baseCommit, task.headCommit);
    const unexpected = allowed ? stats.map((s) => s.path).filter((p) => !allowed.test(p)) : [];
    if (unexpected.length) reasons.push(`Beklenmeyen dosyalar değişti: ${unexpected.slice(0, 5).join(', ')}`);
    // A fix that edits or deletes tests, CI or build/runtime configuration can make "build and tests passed" mean
    // nothing (a weakened test, a skipped step). Lockfiles of a dependency fix are its expected output.
    guarded = stats.map((s) => s.path).filter((p) => TEST_FILE.test(p) || (task.autofix!.kind !== 'dependency' && buildRelevantPaths([p]).length > 0));
    if (guarded.length) reasons.push(`Test, CI veya build yapılandırması değişti (${guarded.slice(0, 5).join(', ')}); testlerin gevşetilmediğini kontrol edip elle onaylayın.`);
    proven = !remaining.length && !introduced.length && !unexpected.length && !smoke?.failed;
  }

  let merged: string | null = null;
  if (proven) {
    const rate = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(and(eq(auditEvents.projectId, project.id), eq(auditEvents.action, 'ai.task.auto_merged'), gte(auditEvents.createdAt, new Date(Date.now() - 3600_000))));
    if (guarded.length) reasons.push('Bu dosyalara dokunan düzeltmeler hiçbir zaman kendiliğinden birleştirilmez.');
    else if (task.autofix.risk !== 'low') reasons.push(`Risk seviyesi "${task.autofix.risk}": insan onayı gerekli.`);
    else if (!settings.autoFix.autoMergeLowRisk) reasons.push('Düşük riskli otomatik birleştirme organizasyon ayarında kapalı.');
    else if (LEVEL[settings.autonomyLevel] < 2) reasons.push(`Otonomi seviyesi ${settings.autonomyLevel}: otomatik değişiklikler durdurulmuş.`);
    else if (isProtectedBranch(project.settings, task.baseBranch ?? project.defaultBranch)) reasons.push(`"${task.baseBranch}" korumalı branch; birleştirme pull request onayıyla yapılır.`);
    else if ((rate[0]?.n ?? 0) >= settings.autoFix.maxAutoMergesPerHour) reasons.push(`Saatlik otomatik birleştirme sınırına (${settings.autoFix.maxAutoMergesPerHour}) ulaşıldı.`);
    else {
      try {
        merged = await autoMerge(ctx, task, project);
      } catch (e) {
        // The target moved after verification: merging now would ship a combination nobody tested. Deterministic
        // fixes are prepared again on the current code and verified again; other fixes go to a person.
        if (e instanceof BaseMovedError && canReprepare(task)) {
          await reprepareAutofix(db, git, { ...task, autofix: { ...task.autofix, verdict: undefined } }, AUTOFIX_ACTOR, e.message);
          logger.info({ taskId: task.id }, 'autofix re-prepared on the moved base before merging');
          return { verdict: 'reprepared', merged: null };
        }
        reasons.push(`Otomatik birleştirme yapılamadı: ${(e as Error).message}`);
      }
    }
  }

  const verdict: NonNullable<AiAutofix['verdict']> = {
    status: merged ? 'merged' : proven ? 'needs_approval' : 'failed',
    reasons: [
      ...(merged ? [`${fullBuild ? 'Build ve testler geçti' : task.autofix.mode === 'files' ? 'Yalnızca dosya kaldırıldı' : 'Projenin build ve testleri bu değişiklikle commit öncesi geçti'}, hedef bulgular yeniden taramada yok, yalnızca beklenen dosyalar değişti.`] : proven ? ['Doğrulandı.', ...reasons] : reasons),
      ...(smoke?.ok ? [smoke.ok] : []),
    ],
    remaining,
    checkedAt: new Date().toISOString(),
  };
  // Self-correction: an AI-written fix whose verification build broke in the project's own install/build/test step
  // gets one more attempt that sees the error, instead of waiting for a human with a broken change.
  const codeStep = ['Bağımlılık kurulumu', 'Build', 'Testler'].includes(build.error?.step ?? '');
  const targetStillOpen = build.status === 'passed' && remaining.length > 0;
  if (((build.status === 'failed' && codeStep) || targetStillOpen) && task.autofix.mode === 'agent') {
    const retried = (await db.select({ n: sql<number>`count(*)::int` }).from(auditEvents).where(and(eq(auditEvents.resourceId, task.id), eq(auditEvents.action, 'ai.task.reverify'), sql`${auditEvents.metadata}->>'selfCorrect' = 'true'`)))[0]?.n ?? 0;
    if (!retried) {
      const logTail = build.logKey ? await fs.readFile(ctx.storage.resolve(build.logKey), 'utf8').then((t) => t.split('\n').slice(-60).join('\n'), () => '') : '';
      const changed = (await git.diffStat(task.baseCommit, task.headCommit).catch(() => [])).map((s) => s.path);
      const note = [
        '',
        '## Önceki deneme doğrulamada başarısız oldu',
        `Değiştirilen dosyalar: ${changed.join(', ') || '-'}`,
        targetStillOpen
          ? `${remaining.length} hedef güvenlik bulgusu yeniden taramada hâlâ bulundu. Gizli değeri fallback, örnek, yorum veya başka bir dosyada bırakma; kod yalnızca ortam değişkenini kullanmalı.`
          : `Adım: ${build.error?.step ?? '?'} · Hata: ${build.error?.message ?? '?'}`,
        logTail ? `Build kaydının sonu:\n\`\`\`\n${logTail.slice(-6000)}\n\`\`\`` : '',
        'Görevi baştan, bu hatayı da giderecek şekilde yap. Önceki denemedeki hatalı değişikliği tekrarlama.',
      ].filter(Boolean).join('\n');
      await db.update(aiTasks).set({ instruction: `${task.instruction}\n${note}`.slice(0, 20_000) }).where(eq(aiTasks.id, task.id));
      await reprepareAutofix(
        db,
        git,
        { ...task, autofix: { ...task.autofix, verdict } },
        AUTOFIX_ACTOR,
        targetStillOpen ? 'Hedef güvenlik bulgusu yeniden taramada hâlâ bulundu; AI bir kez daha deniyor.' : `Doğrulama build'i düştü (${build.error?.step}); AI hatayı görerek bir kez daha deniyor.`,
      );
      await audit(db, { organizationId: task.organizationId, projectId: task.projectId, actor: AUTOFIX_ACTOR, action: 'ai.task.reverify', resourceType: 'ai_task', resourceId: task.id, metadata: { selfCorrect: true, buildId } });
      logger.info({ taskId: task.id }, 'autofix self-correction queued');
      return { verdict: 'retrying', merged: null };
    }
  }

  await db.update(aiTasks).set({ autofix: { ...task.autofix, verdict } }).where(eq(aiTasks.id, task.id));
  await publish(db, { type: 'ai.task.updated', organizationId: task.organizationId, projectId: task.projectId, id: task.id });
  logger.info({ taskId: task.id, verdict: verdict.status }, 'autofix verified');
  // Automatic mode continues with the remaining fixes (a merge already does this through the rescan).
  if (!merged) await enqueue(db, { queue: QUEUES.maintenance, type: 'autofix.auto', projectId: project.id, organizationId: project.organizationId, dedupeKey: `autofix-auto:${project.id}`, runAt: new Date(Date.now() + 15_000), payload: { projectId: project.id } });
  return { verdict: verdict.status, merged };
}

class BaseMovedError extends Error {}

/**
 * Starts nothing itself: the verification build of a fix opens a preview (see commitPrepared); this waits until the
 * app is up, requests its health path and smoke paths (manifest `smoke.paths`, default "/"), routing service paths
 * like the gateway does, then stops the preview. A 5xx or no answer means the fix broke the running app even though
 * build and tests passed.
 */
export async function smokeCheck(ctx: WorkerCtx, build: { id: string; finishedAt: Date | null }, manifest: Manifest | undefined): Promise<{ pending?: string; failed?: string; ok?: string } | null> {
  const pv = (await ctx.db.select().from(previews).where(eq(previews.buildId, build.id)).orderBy(desc(previews.createdAt)).limit(1))[0];
  if (!pv || pv.kind === 'static') return null;
  const waited = Date.now() - (build.finishedAt?.getTime() ?? Date.now());
  if (pv.status === 'queued' || pv.status === 'starting') return waited < 15 * 60_000 ? { pending: 'Uygulama açılıyor; davranış kontrolü bekliyor' } : { failed: 'Davranış kontrolü: uygulama 15 dakikada açılmadı.' };
  if (pv.status !== 'ready' || !pv.internalPort) {
    // Only a regression counts against the fix: if this project's app never came up in a preview, the fix did not
    // break it (and blocking every fix would leave the project's real problems unfixed).
    const everStarted = await ctx.db
      .select({ id: previews.id })
      .from(previews)
      .where(and(eq(previews.projectId, pv.projectId), sql`${previews.id} <> ${pv.id}`, inArray(previews.status, ['ready', 'stopped', 'expired']), sql`${previews.error} IS NULL`, eq(previews.kind, pv.kind)))
      .limit(1);
    if (!everStarted.length) return { ok: 'Davranış kontrolü yapılamadı: bu projenin uygulaması daha önce hiçbir ön izlemede açılmadı.' };
    return { failed: `Davranış kontrolü: düzeltilmiş uygulama başlatılamadı (${pv.error ?? pv.status}); önceki sürümler açılıyordu.` };
  }
  const paths = [...new Set([manifest?.health?.path ?? '/', ...(manifest?.smoke?.paths ?? ['/'])])];
  const results: string[] = [];
  try {
    for (const p of paths) {
      const service = pv.services
        .flatMap((sv) => sv.paths.filter((sp) => p === sp || p.startsWith(sp.endsWith('/') ? sp : `${sp}/`)).map((sp) => ({ port: sv.port, length: sp.length })))
        .sort((a, b) => b.length - a.length)[0];
      try {
        const res = await fetch(`http://127.0.0.1:${service?.port ?? pv.internalPort}${p}`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        await res.body?.cancel().catch(() => undefined);
        results.push(`${p} → ${res.status}`);
        if (res.status >= 500) return { failed: `Davranış kontrolü başarısız: ${results.join(', ')}` };
      } catch (e) {
        return { failed: `Davranış kontrolü: ${p} yanıt vermedi (${(e as Error).message}).` };
      }
    }
    return { ok: `Davranış kontrolü geçti: uygulama açıldı, ${results.join(', ')}.` };
  } finally {
    await enqueue(ctx.db, { queue: QUEUES.preview, type: 'preview.stop', projectId: pv.projectId, organizationId: pv.organizationId, payload: { previewId: pv.id, reason: 'Doğrulama tamamlandı' } });
  }
}

async function autoMerge(ctx: WorkerCtx, task: TaskRow, project: Awaited<ReturnType<typeof loadProject>>) {
  const db = ctx.db;
  const { git } = await openRepo(ctx, project.id);
  const key = `AI-${task.number}`;
  const head = await git.resolve(`refs/heads/${task.branch}`);
  if (head !== task.headCommit) throw new Error('AI branch\'i doğrulamadan sonra değişmiş');
  const target = task.baseBranch ?? project.defaultBranch;
  // Only the exact combination that was built, tested and scanned may merge by itself.
  if ((await git.resolve(`refs/heads/${target}`)) !== task.baseCommit) throw new BaseMovedError(`${target} doğrulamadan sonra ilerledi; birleşim sonucu doğrulanmadı`);
  const merged = await git.merge({
    source: task.branch!,
    target,
    message: `Merge ${key}: ${task.title}\n\nAuto-merged by policy: low-risk fix verified by build, tests and a re-scan.`,
    author: { name: 'Project Hub AI', email: 'ai@projecthub.local' },
  });
  await db.transaction(async (tx) => {
    await tx.update(aiTasks).set({ status: 'merged', decisionComment: 'Otomatik birleştirildi: düşük risk politikası, doğrulama geçti.' }).where(eq(aiTasks.id, task.id));
    if (target === project.defaultBranch) await tx.update(repositories).set({ headCommit: merged.sha, lastPushedAt: new Date() }).where(eq(repositories.projectId, project.id));
    await audit(tx, { organizationId: task.organizationId, projectId: project.id, actor: AUTOFIX_ACTOR, action: 'ai.task.auto_merged', resourceType: 'ai_task', resourceId: task.id, metadata: { merge: merged.sha, risk: task.autofix?.risk, kind: task.autofix?.kind } });
    await timeline(tx, { organizationId: task.organizationId, projectId: project.id, kind: 'ai', tone: 'ok', title: `${key} otomatik birleştirildi`, description: `${task.title} · ${task.branch} → ${target} · ${merged.sha.slice(0, 7)}`, actorLabel: AUTOFIX_ACTOR.label, refType: 'ai_task', refId: task.id });
    await emitDomainEvent(tx, { event: 'ai.task.merged', organizationId: task.organizationId, projectId: project.id, actor: AUTOFIX_ACTOR, data: { taskId: task.id, key, requestedBy: task.requestedBy } });
    await tx.insert(aiMemories).values({
      organizationId: task.organizationId,
      projectId: project.id,
      category: 'task_outcome',
      title: `${key}: ${task.title}`.slice(0, 200),
      content: [task.result?.summary ?? task.title, ...(task.result?.explanation ?? [])].join('\n').slice(0, 20000),
      verification: 'verified',
      sourceType: 'ai_task',
      sourceRef: task.id,
      sourceLabel: `${key} · ${merged.sha.slice(0, 7)} · otomatik`,
      createdByType: 'ai',
      createdBy: task.requestedBy,
    });
    if (target === project.defaultBranch) {
      await enqueue(tx, { queue: QUEUES.index, type: 'code.index', projectId: project.id, organizationId: task.organizationId, dedupeKey: `index:${project.id}`, payload: { projectId: project.id, branch: target } });
      // A fresh scan of the default branch resolves the fixed findings for everyone.
      await enqueue(tx, { queue: QUEUES.security, type: 'security.scan', projectId: project.id, organizationId: task.organizationId, dedupeKey: `scan:${project.id}`, payload: { projectId: project.id, branch: target, trigger: 'autofix' } });
    }
    await publish(tx, { type: 'ai.task.updated', organizationId: task.organizationId, projectId: project.id, id: task.id });
    await publish(tx, { type: 'repository.updated', organizationId: task.organizationId, projectId: project.id, data: { branch: target, sha: merged.sha, message: `Merge ${key} (otomatik)`, actor: AUTOFIX_ACTOR.label, actorId: null } });
  });
  return merged.sha;
}

function lastLines(output: string) {
  return output.split('\n').filter(Boolean).slice(-3).join(' ');
}

/** name → locked version for composer.lock (runtime and dev packages). */
function composerLocked(text: string): Map<string, string> {
  const lock = JSON.parse(text) as { packages?: { name: string; version: string }[]; 'packages-dev'?: { name: string; version: string }[] };
  return new Map([...(lock.packages ?? []), ...(lock['packages-dev'] ?? [])].map((p) => [p.name.toLowerCase(), p.version.replace(/^v/, '')]));
}

/**
 * files mode: committed secrets in .env files or build/cache output are removed from the repository (not from
 * anyone's disk) and ignored from now on. No model and no project code involved; always reviewed by a person.
 */
async function runFilesFix(ctx: WorkerCtx, task: TaskRow) {
  const db = ctx.db;
  const project = await loadProject(ctx, task.projectId);
  const key = `AI-${task.number}`;
  const fail = async (message: string) => {
    await db.update(aiTasks).set({ status: 'failed', error: message, completedAt: new Date() }).where(eq(aiTasks.id, task.id));
    await publish(db, { type: 'ai.task.updated', organizationId: task.organizationId, projectId: task.projectId, id: task.id });
    return { status: 'failed', message };
  };
  const settings = (await getOrgSettings(db, task.organizationId)).ai;
  const { git } = await openRepo(ctx, project.id);
  const baseBranch = task.baseBranch ?? project.defaultBranch;
  const base = await git.resolve(`refs/heads/${baseBranch}`);
  if (!base) return fail(`Temel branch bulunamadı: ${baseBranch}`);
  const branch = `ai/${key}-${slugify(task.title).slice(0, 40)}`;
  await db.update(aiTasks).set({ status: 'running', startedAt: new Date(), branch, baseCommit: base, baseBranch }).where(eq(aiTasks.id, task.id));
  await publish(db, { type: 'ai.task.updated', organizationId: task.organizationId, projectId: task.projectId, id: task.id });
  const spec = task.autofix!.files ?? { delete: [], ignore: [] };
  const present = new Map((await git.listFiles(base)).map((f) => [f.path, f]));
  const changes: FileChange[] = spec.delete.filter((p) => present.has(p)).map((p) => ({ action: 'delete' as const, path: p }));
  const gi = present.get('.gitignore');
  const current = gi ? (await git.readBlob(gi.sha, 1024 * 1024)).toString('utf8') : '';
  const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = spec.ignore.filter((p) => !lines.has(p));
  if (missing.length) changes.push({ action: 'upsert', path: '.gitignore', content: `${current}${current && !current.endsWith('\n') ? '\n' : ''}\n# Project Hub: never commit secrets or generated files\n${missing.join('\n')}\n` });
  if (!changes.length) return fail('Kaldırılacak dosya kalmamış; sorun başka bir değişiklikle çözülmüş olabilir. Yeniden tarayın.');
  // Only the variable names are read (never values) so the reviewer knows what has to move to Secrets.
  const envNames = new Set<string>();
  for (const c of changes) {
    const f = c.action === 'delete' && /(^|\/)\.env$/.test(c.path) ? present.get(c.path) : undefined;
    if (!f) continue;
    const text = (await git.readBlob(f.sha, 256 * 1024)).toString('utf8');
    for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) envNames.add(m[1]!);
  }
  const envNotes = envNames.size
    ? [
        `Birleştirmeden önce bu ${envNames.size} ayarı yeni değerleriyle Secret'lar ekranına ("Çalışma" veya "Tümü") ekleyin; yoksa ön izleme ve yayın anahtarsız açılır: ${[...envNames].join(', ')}`,
        'Bilgisayarınızdaki .env silinmez; ancak bu değişikliği git pull ile çektiğinizde Git onu silebilir — önce yedekleyin.',
      ]
    : [];
  return commitPrepared(ctx, {
    task,
    project,
    git,
    branch,
    base,
    key,
    changes,
    finish: {
      summary: `${spec.delete.length} dosya repodan kaldırıldı, .gitignore güncellendi`,
      explanation: [...spec.delete.map((p) => `Silindi (yalnızca repodan): ${p}`), ...(missing.length ? [`.gitignore: ${missing.join(', ')}`] : []), 'İçindeki şifre ve anahtarlar Git geçmişinde kaldığı için yenilenmelidir.', ...envNotes],
    },
    settings,
    preparedBy: 'deterministik dosya düzeltmesi',
    logger: ctx.logger,
    fail,
  });
}

/**
 * autofix.auto — automatic mode, after each scan of the default branch (and when the mode is switched on): prepares
 * and verifies every fix it can, so nobody has to start them by hand. Proven low-risk fixes merge themselves; the
 * rest wait for a person's approval. A fix that failed or was rejected in the last 24 hours is not retried.
 */
export async function autofixAuto(ctx: WorkerCtx, { job, logger }: JobContext) {
  const { projectId } = job.payload as { projectId: string };
  const db = ctx.db;
  const project = await loadProject(ctx, projectId);
  const ps = project.settings as { autoFix?: boolean; executionTrust?: string; health?: { components?: Record<string, number | null> } };
  if (project.status !== 'archived') await reprepareConflicting(ctx, project.id, project.defaultBranch);
  if (ps.autoFix === false || project.status === 'archived' || ps.executionTrust === 'untrusted') return { skipped: 'off' };
  const org = await getOrgSettings(db, project.organizationId);
  if (LEVEL[org.ai.autonomyLevel] < 2) return { skipped: 'policy' };
  const findings = await db.select().from(securityFindings).where(and(eq(securityFindings.projectId, projectId), eq(securityFindings.status, 'open')));
  const recent = await db
    .select({ status: aiTasks.status, autofix: aiTasks.autofix, error: aiTasks.error, createdAt: aiTasks.createdAt })
    .from(aiTasks)
    // Open fixes stay busy however old they are: one waiting two days for approval must not get a duplicate.
    .where(and(eq(aiTasks.projectId, projectId), isNotNull(aiTasks.autofix), or(gte(aiTasks.createdAt, new Date(Date.now() - 24 * 3600_000)), inArray(aiTasks.status, ['queued', 'running', 'awaiting_approval']))));
  // A failure caused by a restart or provider timeout is retried automatically (at most twice per problem a day).
  const transientTries = new Map<string, number>();
  for (const t of recent) if (t.status === 'failed' && transientFailure(t.error)) for (const id of t.autofix?.findingIds ?? []) transientTries.set(id, (transientTries.get(id) ?? 0) + 1);
  const busy = new Set(
    recent
      // A cancelled fix (by a person or because it targeted third-party code) is not started again for a day either.
      .filter((t) => ['queued', 'running', 'awaiting_approval', 'rejected', 'cancelled'].includes(t.status) || (t.status === 'failed' && !transientFailure(t.error)))
      .flatMap((t) => t.autofix?.findingIds ?? []),
  );
  for (const [id, n] of transientTries) if (n >= 3) busy.add(id);
  // npm findings in a folder whose dependency tree was already broken wait until the default branch changes.
  const lastDefaultBuild = (await db.select({ createdAt: builds.createdAt }).from(builds).where(and(eq(builds.projectId, projectId), eq(builds.branch, project.defaultBranch))).orderBy(desc(builds.createdAt)).limit(1))[0];
  const conflictTasks = await db
    .select({ status: aiTasks.status, autofix: aiTasks.autofix, error: aiTasks.error, createdAt: aiTasks.createdAt })
    .from(aiTasks)
    .where(and(eq(aiTasks.projectId, projectId), eq(aiTasks.status, 'failed'), gte(aiTasks.createdAt, new Date(Date.now() - 7 * 86400_000))));
  for (const { findingIds } of blockedByDependencyConflict(conflictTasks, findings, lastDefaultBuild?.createdAt).values()) for (const id of findingIds) busy.add(id);
  const docsTried = recent.some((t) => t.autofix?.kind === 'docs');
  const aiReady = await ai.resolveAi(db, ctx.config, project.organizationId, { minLevel: 'L2', projectId }).then(
    () => true,
    () => false,
  );
  const plan = planAutofix({
    findings,
    busy,
    failedBuild: null,
    includeOptionalUpgrades: false,
    docsMissing: !docsTried && ps.health?.components?.documentation != null && ps.health.components.documentation <= 40,
    aiReady,
    autoMergeOn: org.ai.autoFix.autoMergeLowRisk,
  });
  // Package and file fixes (deterministic, quick) start right away, safest first. AI code fixes go one at a time per
  // project so the model is not flooded; the next one starts when the previous one has been verified.
  const RISK = { low: 0, medium: 1, high: 2 } as const;
  const agentBusy = recent.some((t) => (t.status === 'queued' || t.status === 'running') && t.autofix?.mode === 'agent');
  const bySafety = [...plan.items].sort((a, b) => RISK[a.risk] - RISK[b.risk]);
  const items = [...bySafety.filter((i) => i.mode !== 'agent').slice(0, 6), ...(agentBusy ? [] : bySafety.filter((i) => i.mode === 'agent').slice(0, 1))];
  if (!items.length) return { started: 0 };
  const out = await createAutofixTasks(db, { organizationId: project.organizationId, projectId, defaultBranch: project.defaultBranch, requestedBy: null, autonomyLevel: org.ai.autonomyLevel, items, actor: AUTOFIX_ACTOR });
  logger.info({ projectId, started: out.created.length }, 'automatic fixes started');
  return { started: out.created.length };
}

/**
 * Prepared changes that no longer merge cleanly after other changes landed are redone on the current code right away,
 * so an approval never ends in a merge conflict that someone has to resolve by hand.
 */
async function reprepareConflicting(ctx: WorkerCtx, projectId: string, defaultBranch: string) {
  const waiting = await ctx.db.select().from(aiTasks).where(and(eq(aiTasks.projectId, projectId), eq(aiTasks.status, 'awaiting_approval'), isNotNull(aiTasks.branch)));
  if (!waiting.length) return;
  const { git } = await openRepo(ctx, projectId);
  for (const t of waiting) {
    const base = t.baseBranch ?? defaultBranch;
    const baseHead = await git.resolve(`refs/heads/${base}`);
    if (!baseHead || baseHead === t.baseCommit) continue;
    if (t.buildId) {
      const b = (await ctx.db.select({ status: builds.status }).from(builds).where(eq(builds.id, t.buildId)))[0];
      if (b?.status === 'queued' || b?.status === 'running') continue;
    }
    const check = await git.mergeCheck(t.branch!, base).catch(() => null);
    if (check?.conflicts.length) await reprepareAutofix(ctx.db, git, t, AUTOFIX_ACTOR, `${base} değişti, ${check.conflicts.slice(0, 3).join(', ')} çakışıyordu`);
  }
}

/** Failures caused by the environment of the attempt (restart, timeout, provider hiccup), not by the fix itself. */
function transientFailure(error: string | null): boolean {
  return !!error && /worker yeniden başladığı|timeout|zaman aşımı|aborted|sağlayıcısı hatası|ECONNRESET|ECONNREFUSED|token repeat limit/i.test(error);
}
