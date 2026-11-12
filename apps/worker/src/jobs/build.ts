import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { laravelBootstrapEnv, prepareLaravelWorkspace } from './laravel-bootstrap.js';
import { npmLockMismatch } from './npm-lock.js';
import path from 'node:path';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { durationToMinutes, type Manifest, type StepStatus } from '@projecthub/contracts';
import {
  addEvidence,
  audit,
  copyDir,
  DeferJobError,
  detectProject,
  digestDirectory,
  emitDomainEvent,
  enqueue,
  ensureWorkflowStep,
  getOrgSettings,
  GitRepository,
  manifestFromDetection,
  MANIFEST_FILE,
  moveDir,
  parseManifest,
  PermanentJobError,
  previewSlug,
  publish,
  QUEUES,
  recordVerification,
  resolveEnvSecrets,
  setWorkflowStatus,
  setWorkflowStepStatus,
  startWorkflow,
  SYSTEM_ACTOR,
  timeline,
  type JobContext,
} from '@projecthub/core';
import { aiTasks, artifacts, builds, buildSteps, previews, projectManifests, securityFindings, users, workerHeartbeats, workflowSteps, type Executor } from '@projecthub/database';
import { commitSnapshot, loadProject, openRepo, type WorkerCtx } from '../context.js';
import { extractError } from '../runner/errors.js';
import {
  BuildLog,
  dockerBinary,
  listManagedBuildContainers,
  removeManagedBuildContainer,
  runCommand,
  runContainerCommand,
  runtimeEnv,
  composerPlatformWaivers,
  phpOpcacheEnv,
  sanitizedEnv,
  secretMaskList,
} from '../runner/process.js';
import { pruneArtifact } from './artifact-prune.js';
import { completedCommandStep } from './build-step-state.js';
import { ContainerWorkspace, listWorkspaceVolumes, removeWorkspaceVolume } from '../runner/container-workspace.js';
import { artifactWorkspace } from '../runner/preview-container.js';
import { blockingCriticals, criticalSecurityGate, hasSourceTests, inferTestCommand } from './build-quality.js';
import { dependencyCache, detachRewrittenFiles, restoreDependencies, saveDependencies } from './dep-cache.js';
import { registerPeriodic } from './maintenance.js';
import { runSecurityScan } from './security.js';

type StepKey = 'checkout' | 'manifest' | 'install' | 'security' | 'build' | 'test' | 'artifact';
const STEP_NAMES: Record<StepKey, string> = {
  checkout: 'Kaynak kod (checkout)',
  manifest: 'Manifest okuma',
  install: 'Bağımlılık kurulumu',
  security: 'Güvenlik taraması',
  build: 'Build',
  test: 'Testler',
  artifact: 'Artifact',
};

/** The manifest that applies to a commit: projecthub.yml in that commit, else the stored one, else detected. */
export async function manifestAt(ctx: WorkerCtx, projectId: string, git: GitRepository, commit: string): Promise<{ manifest: Manifest; source: string }> {
  const file = await git.readFile(commit, MANIFEST_FILE);
  if (file) return { manifest: parseManifest(file.content.toString('utf8')), source: 'repository' };
  const stored = (await ctx.db.select().from(projectManifests).where(eq(projectManifests.projectId, projectId)).orderBy(desc(projectManifests.version)).limit(1))[0];
  if (stored) return { manifest: stored.content, source: stored.source };
  const project = await loadProject(ctx, projectId);
  const det = await detectProject(await commitSnapshot(git, commit), project.slug);
  return { manifest: manifestFromDetection({ ...det, name: project.name }, project.slug), source: 'detected' };
}

/** A Node build needs its dependencies; a manifest that forgot the install step gets the one its lockfile implies. */
export async function withNodeInstall(manifest: Manifest, workspace: string): Promise<{ manifest: Manifest; added: string | null }> {
  const installCommand = manifest.install?.command ?? '';
  const exists = (name: string) => fs.access(path.join(workspace, name)).then(() => true, () => false);
  const nodeBuild = /\b(npm|npx|pnpm|yarn|bun)\b|\bvite\b/i.test(manifest.build?.command ?? '');
  const installsNode = /\b(npm\s+(ci|install)|pnpm\s+install|yarn\s+install|bun\s+install)\b/i.test(installCommand);
  if (!nodeBuild || installsNode || !(await exists('package.json'))) return { manifest, added: null };
  const nodeInstall = (await exists('pnpm-lock.yaml'))
    ? 'pnpm install --frozen-lockfile'
    : (await exists('yarn.lock'))
      ? 'yarn install --frozen-lockfile'
      : (await exists('bun.lock')) || (await exists('bun.lockb'))
        ? 'bun install'
        : (await exists('package-lock.json'))
          ? 'npm ci'
          : 'npm install';
  return { manifest: { ...manifest, install: { command: installCommand ? `${installCommand} && ${nodeInstall}` : nodeInstall } }, added: nodeInstall };
}

// Shared by builds and AI run_checks; never pass live project credentials/feature switches into tests.
export { testEnvironment } from './test-env.js';
import { testEnvironment } from './test-env.js';

/** Environment for project commands: scrubbed of the hub's own settings, plus build-scope secrets and shared caches. */
export function buildEnv(ctx: WorkerCtx, manifest: Manifest, secrets: Record<string, string>, toolDir: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const containerized = ctx.config.BUILD_EXECUTOR === 'container';
  const waivers = composerPlatformWaivers(manifest.runtime?.type, containerized);
  return sanitizedEnv({
    ...runtimeEnv(manifest.runtime?.type, containerized),
    ...(manifest.runtime?.type === 'php' && !containerized ? phpOpcacheEnv(ctx.storage.resolve('tmp/php')) : {}),
    // Before the secrets so a project that sets its own COMPOSER_IGNORE_PLATFORM_REQ keeps it.
    ...(waivers.length ? { COMPOSER_IGNORE_PLATFORM_REQ: waivers.join(',') } : {}),
    ...manifest.build?.env,
    ...secrets,
    // COMPOSER_HOME is per run because it may contain credentials or project-specific configuration. The Composer
    // and npm caches hold public, integrity-checked package archives only, so they are shared between runs.
    COMPOSER_HOME: containerized ? '/tmp/projecthub-composer' : path.join(toolDir, 'composer'),
    // In a container the caches live on the project's own volume (/cache); /tmp is a 256 MB tmpfs.
    COMPOSER_CACHE_DIR: containerized ? '/cache/composer' : ctx.storage.resolve('tmp/package-cache/composer'),
    npm_config_cache: containerized ? '/cache/npm' : ctx.storage.resolve('tmp/package-cache/npm'),
    // The security step scans dependencies itself. Composer's own post-install audit calls Packagist and was seen
    // hanging a build for good on a half-closed connection.
    COMPOSER_NO_AUDIT: '1',
    npm_config_prefer_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    ...extra,
  });
}

export async function executeBuild(ctx: WorkerCtx, { job, logger, signal }: JobContext) {
  const { buildId } = job.payload as { buildId: string };
  const db = ctx.db;
  const build = (await db.select().from(builds).where(eq(builds.id, buildId)))[0];
  if (!build) throw new PermanentJobError('build not found');
  if (build.status !== 'queued' && build.status !== 'running') return { skipped: build.status };
  const project = await loadProject(ctx, build.projectId);
  const workflow = await startWorkflow(db, {
    organizationId: build.organizationId,
    projectId: build.projectId,
    definitionKey: 'build',
    definitionVersion: 1,
    title: `Build #${build.number}: ${build.branch}@${build.commitSha.slice(0, 7)}`,
    triggerType: 'build',
    triggerRef: build.id,
    baseRevision: build.commitSha,
    riskLevel: 'medium',
    requestedByType: build.triggeredByType === 'ai' ? 'ai' : 'user',
    requestedBy: build.triggeredBy,
    idempotencyKey: `build:${build.id}`,
    context: { buildId: build.id, branch: build.branch, commitSha: build.commitSha, trigger: build.trigger, createPreview: build.createPreview },
  });
  if ((project.settings as { executionTrust?: string }).executionTrust === 'untrusted') {
    const message = 'Güvenilmeyen proje için host üzerinde build komutu çalıştırılması engellendi';
    await db.transaction(async (tx) => {
      await tx.update(builds).set({ status: 'failed', error: { step: 'Güvenlik ilkesi', message }, finishedAt: new Date() }).where(eq(builds.id, build.id));
      await audit(tx, {
        organizationId: project.organizationId,
        projectId: project.id,
        actor: SYSTEM_ACTOR,
        action: 'build.blocked_untrusted_source',
        resourceType: 'build',
        resourceId: build.id,
        metadata: { executionTrust: 'untrusted' },
      });
      if (build.trigger === 'ai') await enqueue(tx, { queue: QUEUES.security, type: 'ai.autofix.verify', projectId: project.id, organizationId: project.organizationId, dedupeKey: `autofix-verify:${build.id}`, payload: { buildId: build.id } });
      await timeline(tx, {
        organizationId: project.organizationId,
        projectId: project.id,
        kind: 'build',
        tone: 'bad',
        title: `Build #${build.number} güvenlik ilkesiyle engellendi`,
        description: message,
        refType: 'build',
        refId: build.id,
      });
      await recordVerification(tx, { organizationId: project.organizationId, projectId: project.id, workflowRunId: workflow.id, key: 'build:execution_policy', status: 'failed', summary: message, expected: { executionTrust: 'trusted' }, observed: { executionTrust: 'untrusted' } });
      await setWorkflowStatus(tx, workflow.id, 'failed', { phase: 'policy', error: message });
    });
    await publish(db, { type: 'build.updated', organizationId: project.organizationId, projectId: project.id, id: build.id });
    return { status: 'failed', blocked: true };
  }
  const { git } = await openRepo(ctx, project.id);
  const settings = await getOrgSettings(db, project.organizationId);
  if (build.status === 'queued') {
    // Admin > Saklama ve kapasite: organization-wide cap on simultaneous builds (the 8 GB server guard).
    // The advisory lock makes "count running + claim" atomic across worker processes.
    const claim = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`builds:${project.organizationId}`}))`);
      const currentStatus = (await tx.select({ status: builds.status }).from(builds).where(eq(builds.id, build.id)))[0]?.status;
      if (currentStatus !== 'queued') return { state: 'not_queued' as const, status: currentStatus };
      const projectLimit = (project.settings as { automationPolicy?: { maxConcurrentRuns?: number } }).automationPolicy?.maxConcurrentRuns ?? settings.retention.maxConcurrentBuilds;
      const limit = Math.min(settings.retention.maxConcurrentBuilds, projectLimit);
      const running = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM builds WHERE organization_id = ${project.organizationId} AND status = 'running'`);
      const projectRunning = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM builds WHERE project_id = ${project.id} AND status = 'running'`);
      if ((running.rows[0]?.n ?? 0) >= settings.retention.maxConcurrentBuilds || (projectRunning.rows[0]?.n ?? 0) >= limit) return { state: 'capacity' as const, limit };
      const transitioned = await tx.update(builds).set({ status: 'running', startedAt: new Date() }).where(and(eq(builds.id, build.id), eq(builds.status, 'queued'))).returning({ id: builds.id });
      return transitioned.length ? { state: 'claimed' as const } : { state: 'not_queued' as const, status: 'cancelled' as const };
    });
    if (claim.state === 'capacity') throw new DeferJobError(`Eşzamanlı build sınırı (${claim.limit}) dolu; build sırada bekliyor`, 10_000);
    if (claim.state === 'not_queued') return { skipped: claim.status ?? 'unknown' };
  }

  const logKey = ctx.storage.buildLogKey(project.id, build.id);
  await ctx.storage.ensureDir(path.dirname(logKey));
  await fs.rm(ctx.storage.resolve(logKey), { force: true });
  const log = new BuildLog(ctx.storage.resolve(logKey));
  let workspace = ctx.storage.resolve(ctx.storage.workspaceKey('build', build.id));
  // An attempt cut off by a worker restart can leave processes holding files (Windows locks loaded .node modules);
  // continue in a fresh directory instead of failing the build.
  if (!(await fs.rm(workspace, { recursive: true, force: true, maxRetries: 3 }).then(() => true, () => false))) workspace = `${workspace}-${Date.now()}`;
  await fs.mkdir(workspace, { recursive: true });
  // Package managers need a writable home, but inheriting the worker user's APPDATA/HOME would leak host state.
  // Keep all tool state in an isolated per-build directory outside the artifact workspace.
  const buildToolDir = ctx.storage.resolve(`tmp/build-tools-${build.id}`);
  const sharedComposerCache = ctx.storage.resolve('tmp/package-cache/composer');
  // npm's cache is content-addressed and every tarball is checked against the lockfile's integrity hash, so sharing
  // it between builds is as safe as the Composer archive cache and saves re-downloading hundreds of packages.
  const sharedNpmCache = ctx.storage.resolve('tmp/package-cache/npm');
  await fs.rm(buildToolDir, { recursive: true, force: true });
  await Promise.all([fs.mkdir(buildToolDir, { recursive: true }), fs.mkdir(sharedComposerCache, { recursive: true }), fs.mkdir(sharedNpmCache, { recursive: true })]);

  // Container builds work in a Docker volume (one tar stream in, one out), never on a bind-mounted host folder.
  const cws = ctx.config.BUILD_EXECUTOR === 'container' ? new ContainerWorkspace(dockerBinary(), ctx.config.BUILD_CONTAINER_IMAGE, `build-${build.id}`, { 'com.projecthub.build': build.id }) : null;
  const started = new Date();
  await db.delete(buildSteps).where(eq(buildSteps.buildId, build.id));
  const order: StepKey[] = ['checkout', 'manifest', 'install', 'security', 'build', 'test', 'artifact'];
  const stepIds = new Map<StepKey, string>();
  const workflowStepIds = new Map<StepKey, string>();
  for (const [i, key] of order.entries()) {
    const row = (await db.insert(buildSteps).values({ buildId: build.id, key, name: STEP_NAMES[key], seq: i }).returning({ id: buildSteps.id }))[0]!;
    stepIds.set(key, row.id);
    const workflowStep = await ensureWorkflowStep(db, { workflowRunId: workflow.id, key, name: STEP_NAMES[key], seq: i });
    workflowStepIds.set(key, workflowStep.id);
  }
  await db.update(builds).set({ status: 'running', startedAt: started, logKey }).where(eq(builds.id, build.id));
  await setWorkflowStatus(db, workflow.id, 'running', { phase: 'checkout', error: null });
  const notify = () => publish(db, { type: 'build.updated', organizationId: project.organizationId, projectId: project.id, id: build.id });
  await notify();

  /** The step in progress, so an unexpected crash is reported on the step where it happened. */
  let current: StepKey = 'checkout';
  const setStep = async (key: StepKey, status: StepStatus, extra: { summary?: string; exitCode?: number | null } = {}) => {
    if (status === 'running') current = key;
    const now = new Date();
    await db
      .update(buildSteps)
      .set({
        status,
        ...(status === 'running' ? { startedAt: now } : {}),
        ...(['passed', 'failed', 'skipped'].includes(status) ? { finishedAt: now } : {}),
        ...(extra.summary !== undefined ? { summary: extra.summary.slice(0, 2000) } : {}),
        ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
      })
      .where(eq(buildSteps.id, stepIds.get(key)!));
    await setWorkflowStepStatus(db, workflowStepIds.get(key)!, status, {
      ...(extra.summary !== undefined ? { output: { summary: extra.summary.slice(0, 2000), exitCode: extra.exitCode ?? null } } : {}),
      ...(status === 'failed' ? { error: extra.summary?.slice(0, 2000) ?? 'Build adımı başarısız' } : {}),
    });
    if (status === 'running') await setWorkflowStatus(db, workflow.id, 'running', { phase: key });
    if (status === 'passed' || status === 'failed') {
      const evidence = await addEvidence(db, {
        organizationId: project.organizationId,
        projectId: project.id,
        workflowRunId: workflow.id,
        workflowStepId: workflowStepIds.get(key)!,
        kind: 'step_result',
        subjectType: 'build',
        subjectId: build.id,
        sourceType: 'worker',
        sourceRef: key,
        revision: build.commitSha,
        result: { status, summary: extra.summary ?? '', exitCode: extra.exitCode ?? null },
      });
      await recordVerification(db, {
        organizationId: project.organizationId,
        projectId: project.id,
        workflowRunId: workflow.id,
        workflowStepId: workflowStepIds.get(key)!,
        key: `step:${key}`,
        status,
        summary: `${STEP_NAMES[key]} ${status === 'passed' ? 'başarılı' : 'başarısız'}`,
        expected: { status: 'passed' },
        observed: { status, summary: extra.summary ?? '', exitCode: extra.exitCode ?? null },
        evidenceIds: [evidence.id],
      });
    }
    await notify();
  };
  const isCancelled = async () => (await db.select({ s: builds.status }).from(builds).where(eq(builds.id, build.id)))[0]?.s === 'cancelled';

  let manifest: Manifest | null = null;
  let failure: { step: StepKey; file?: string; line?: number; message: string } | null = null;
  let cancelled = false;

  const stopIfCancelled = async () => {
    if (!(await isCancelled())) return;
    cancelled = true;
    throw new StepFailed();
  };

  const run = async (key: StepKey, command: string, env: NodeJS.ProcessEnv, timeoutMs: number) => {
    await setStep(key, 'running');
    const containerized = ctx.config.BUILD_EXECUTOR === 'container';
    log.section(`${STEP_NAMES[key]}${containerized ? ' (ephemeral container)' : ''}: ${command}`);
    const common = { command, cwd: workspace, env, timeoutMs, onOutput: (t: string) => log.write(t), isCancelled, signal };
    if (cws) await cws.seed(workspace);
    const r = containerized
      ? await runContainerCommand({
          ...common,
          cacheVolume: `projecthub-cache-${project.id}`,
          workspaceMount: cws?.mount(),
          limits: {
            image: ctx.config.BUILD_CONTAINER_IMAGE,
            cpus: ctx.config.BUILD_CONTAINER_CPUS,
            memoryMb: ctx.config.BUILD_CONTAINER_MEMORY_MB,
            pids: ctx.config.BUILD_CONTAINER_PIDS,
            // Only dependency installation receives egress. Build/test code executes without a network.
            network: key === 'install' ? 'bridge' : 'none',
          },
          labels: {
            'com.projecthub.managed': 'build',
            'com.projecthub.worker': ctx.workerId,
            'com.projecthub.build': build.id,
          },
        })
      : await runCommand(common);
    log.flush();
    if (r.cancelled) {
      cancelled = true;
      log.line('[projecthub] build iptal edildi');
      await setStep(key, 'failed', { summary: 'İptal edildi', exitCode: r.exitCode });
      return false;
    }
    if (r.timedOut || r.exitCode !== 0) {
      const extracted = r.timedOut ? { message: `Zaman aşımı (${Math.round(timeoutMs / 60000)} dk)` } : extractError(log.lastLines(200));
      failure = { step: key, ...extracted };
      await setStep(key, 'failed', { summary: extracted.message, exitCode: r.exitCode });
      return false;
    }
    const completed = completedCommandStep(key, r.durationMs);
    await setStep(key, completed.status, { summary: completed.summary, exitCode: 0 });
    return true;
  };

  try {
    // 1. checkout
    await stopIfCancelled();
    await setStep('checkout', 'running');
    log.section(`Checkout ${build.branch} @ ${build.commitSha}`);
    // The manifest and the lockfiles come from Git, so the dependency cache is known before anything is written: on
    // a hit the dependency folders are not checked out file by file but linked from the last install.
    const resolved = await manifestAt(ctx, project.id, git, build.commitSha);
    // Container builds install inside their volume (package downloads come from the project's /cache volume).
    const deps = cws ? null : await dependencyCache(ctx, project.id, git, build.commitSha, resolved.manifest, false).catch(() => null);
    await git.exportTo(build.commitSha, workspace, { skipDirs: deps?.hit ? deps.dirs : [] });
    let depsRestored = false;
    if (deps?.hit) {
      const started = Date.now();
      const restored = await restoreDependencies(ctx, project.id, deps, workspace).catch(() => ({ ok: false, files: 0 }));
      depsRestored = restored.ok;
      log.line(restored.ok ? `[projecthub] bağımlılıklar önbellekten bağlandı: ${restored.files} dosya, ${((Date.now() - started) / 1000).toFixed(1)} sn` : '[projecthub] bağımlılık önbelleği okunamadı; kurulum yapılacak');
    }
    await setStep('checkout', 'passed', { summary: `${build.commitSha.slice(0, 7)} · ${build.branch}` });

    // 2. manifest
    await stopIfCancelled();
    await setStep('manifest', 'running');
    const completed = await withNodeInstall(resolved.manifest, workspace);
    manifest = completed.manifest;
    if (completed.added) log.line(`[projecthub] Node build aracı için eksik kurulum adımı eklendi: ${completed.added}`);
    log.line(`[projecthub] manifest kaynağı: ${resolved.source}`);
    log.line(JSON.stringify(manifest, null, 2));
    await db.update(builds).set({ manifest }).where(eq(builds.id, build.id));
    await setStep('manifest', 'passed', { summary: `${manifest.runtime.type}${manifest.runtime.version ? ` ${manifest.runtime.version}` : ''} · kaynak: ${resolved.source}` });

    const unreadable: string[] = [];
    const secrets = await resolveEnvSecrets(db, ctx.config.encryptionKey, { organizationId: project.organizationId, projectId: project.id, environmentId: null, scope: 'build' }, (name) => unreadable.push(name));
    log.mask(secretMaskList(secrets));
    if (unreadable.length) log.line(`[projecthub] UYARI: şu ortam değişkenleri çözülemedi ve build'e verilmedi (Gizli bilgiler sayfasından yeniden kaydedin): ${unreadable.join(', ')}`);
    const sourceFiles = (await git.listFiles(build.commitSha)).map((file) => file.path);
    await prepareLaravelWorkspace(workspace, sourceFiles);
    const configuredEnv = buildEnv(ctx, manifest, secrets, buildToolDir, { PROJECTHUB_BUILD: String(build.number), PROJECTHUB_COMMIT: build.commitSha, PROJECTHUB_BRANCH: build.branch });
    const env = laravelBootstrapEnv(configuredEnv, sourceFiles);
    if (env !== configuredEnv) log.line('[projecthub] Laravel build bootstrap: veritabanı ayarı yok; yalnız bu build için SQLite :memory: kullanılıyor. Runtime ayarları değiştirilmedi.');
    const timeoutMs = Math.min(manifest.build?.timeoutMinutes ?? 20, ctx.config.BUILD_TIMEOUT_MINUTES) * 60_000;

    // 3. install
    await stopIfCancelled();
    if (/\bnpm\s+ci\b/.test(manifest.install?.command ?? '')) {
      const mismatch = await npmLockMismatch(sourceFiles, (file) => fs.readFile(path.join(workspace, file), 'utf8').catch(() => null));
      if (mismatch) {
        failure = { step: 'install', file: mismatch, message: `${mismatch} package.json ile uyumsuz; lock dosyasını paket yöneticisiyle güncelleyin. Uzun bağımlılık kurulumu başlatılmadı.` };
        await setStep('install', 'failed', { summary: failure.message });
        throw new StepFailed();
      }
    }
    if (manifest.install?.command && depsRestored) {
      await setStep('install', 'passed', { summary: 'Önbellekten · lock dosyaları değişmedi' });
    } else if (manifest.install?.command) {
      if (/\bcomposer\s+install\b/.test(manifest.install.command)) {
        await seedComposerVendor(ctx, project.id, project.defaultBranch, workspace, log);
        if (env.COMPOSER_IGNORE_PLATFORM_REQ) log.line(`[projecthub] host build: Composer şu platform gereksinimlerini yok sayıyor (yalnız bu sunucuda karşılanamayanlar; üretim ortamında geçerlidir): ${env.COMPOSER_IGNORE_PLATFORM_REQ}`);
      }
      if (!(await run('install', manifest.install.command, env, Math.max(timeoutMs, ctx.config.BUILD_INSTALL_TIMEOUT_MINUTES * 60_000)))) throw new StepFailed();
      if (deps) {
        const started = Date.now();
        const saved = await saveDependencies(ctx, project.id, deps, workspace).catch((e: Error) => (log.line(`[projecthub] bağımlılık önbelleği kaydedilemedi: ${e.message}`), 0));
        if (saved) log.line(`[projecthub] bağımlılıklar sonraki build'ler için önbelleğe alındı: ${saved} dosya, ${((Date.now() - started) / 1000).toFixed(1)} sn`);
      }
    } else await setStep('install', 'skipped', { summary: 'Manifestte kurulum komutu yok' });

    // 4. security (source scan of this commit; findings feed the deploy policy)
    await stopIfCancelled();
    await setStep('security', 'running');
    log.section('Güvenlik taraması');
    const scanResult = await runSecurityScan(ctx, { projectId: project.id, buildId: build.id, commitSha: build.commitSha, branch: build.branch, trigger: 'build' }, logger);
    const s = scanResult.summary as { critical: number; high: number; medium: number } | null;
    const scanSummary = s ? `skor ${scanResult.score}/100 · ${s.critical} kritik, ${s.high} yüksek, ${s.medium} orta` : 'tamamlandı';
    log.line(`[projecthub] ${scanSummary}`);
    const fingerprints: string[] = ('criticalFingerprints' in scanResult && scanResult.criticalFingerprints) || [];
    const triage = fingerprints.length
      ? new Map((await db.select({ fp: securityFindings.fingerprint, status: securityFindings.status }).from(securityFindings).where(and(eq(securityFindings.projectId, project.id), inArray(securityFindings.fingerprint, fingerprints)))).map((r) => [r.fp, r.status]))
      : new Map<string, string>();
    const onDefaultBranch = build.branch === project.defaultBranch;
    const blocking = blockingCriticals(fingerprints, triage, onDefaultBranch);
    if (fingerprints.length > blocking.length) log.line(`[projecthub] ${fingerprints.length - blocking.length} kritik bulgu build'i durdurmadı (yanlış pozitif / kabul edildi${onDefaultBranch ? '' : ' / varsayılan dalda zaten açık'})`);
    const securityFailure = criticalSecurityGate(blocking.length, onDefaultBranch);
    if (securityFailure) {
      failure = { step: 'security', message: securityFailure };
      await setStep('security', 'failed', { summary: securityFailure });
      throw new StepFailed();
    }
    await setStep('security', 'passed', { summary: scanSummary });

    // 5. build
    await stopIfCancelled();
    if (manifest.build?.command) {
      if (!(await run('build', manifest.build.command, env, timeoutMs))) throw new StepFailed();
    } else await setStep('build', 'skipped', { summary: 'Manifestte build komutu yok' });

    // 6. tests
    await stopIfCancelled();
    const sourceHasTests = hasSourceTests(sourceFiles);
    const inferredTest = !manifest.test?.command && sourceHasTests
      ? await inferTestCommand(sourceFiles, (file) => fs.readFile(path.join(workspace, file), 'utf8').catch(() => null), manifest.install?.command ?? '')
      : null;
    const testCommand = manifest.test?.command ?? inferredTest;
    if (testCommand) {
      if (inferredTest) log.line(`[projecthub] manifestte test komutu yok; proje yapısından güvenli komut çıkarıldı: ${inferredTest}`);
      if (!(await run('test', testCommand, testEnvironment(env, Object.keys(secrets), manifest.test?.env), timeoutMs))) throw new StepFailed();
    } else {
      if (sourceHasTests) {
        failure = { step: 'test', message: 'Repository test dosyaları içeriyor ancak güvenli bir test komutu belirlenemedi; projecthub.yml içine test.command ekleyin.' };
        await setStep('test', 'failed', { summary: failure.message });
        throw new StepFailed();
      }
      await setStep('test', 'skipped', { summary: 'Test dosyası ve manifest test komutu yok' });
    }

    // 7. artifact
    await stopIfCancelled();
    if (manifest.artifact?.prepare) {
      // Workspace dependencies are hard links into the cache (restored or just saved): files the command rewrites
      // in place get their own copy first.
      if (deps) await detachRewrittenFiles(workspace, deps.dirs);
      if (!(await run('artifact', manifest.artifact.prepare, env, timeoutMs))) throw new StepFailed();
    }
    await setStep('artifact', 'running');
    log.section('Artifact');
    if (cws) {
      const copied = Date.now();
      await cws.copyBack(workspace);
      log.line(`[projecthub] container çalışma alanı geri alındı (${((Date.now() - copied) / 1000).toFixed(1)} sn)`);
    }
    const artifactKey = ctx.storage.buildArtifactKey(project.id, build.id);
    const artifactDir = ctx.storage.resolve(artifactKey);
    await fs.rm(artifactDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(artifactDir), { recursive: true });
    const wantsProcess = manifest.preview.mode === 'process' || (!manifest.preview.mode && !manifest.build?.output && !!manifest.start?.command);
    let outputKind: 'static' | 'process';
    if (wantsProcess && manifest.start?.command) {
      // Server apps run from the complete workspace (dependencies included).
      // moveDir re-points links into the old workspace (Turbopack server externals) at the artifact.
      await moveDir(workspace, artifactDir);
      outputKind = 'process';
    } else {
      const out = manifest.build?.output ?? '.';
      const src = path.resolve(workspace, out);
      if (!src.startsWith(workspace)) throw new PermanentJobError('build.output depo dışını gösteremez');
      try {
        await fs.access(src);
      } catch {
        failure = { step: 'artifact', message: `Build çıktısı bulunamadı: ${out}. Manifestte build.output değerini kontrol edin.` };
        await setStep('artifact', 'failed', { summary: failure.message });
        throw new StepFailed();
      }
      await copyDir(src, artifactDir, (rel) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(rel));
      outputKind = 'static';
    }
    // Credentials and the app's runtime data (uploads, logs, caches) never become part of a kept artifact.
    const pruned = await pruneArtifact(artifactDir);
    if (pruned.envFiles.length) log.line(`[projecthub] artifact'tan gizli bilgi dosyaları çıkarıldı (değerler çalışma anında Secret'lardan verilir): ${pruned.envFiles.join(', ')}`);
    if (pruned.runtimeFiles) log.line(`[projecthub] artifact'tan uygulama çalışma verisi çıkarıldı (yüklemeler, loglar, önbellekler): ${pruned.runtimeFiles} dosya, ${(pruned.runtimeBytes / 1024 / 1024).toFixed(1)} MB`);
    if (pruned.toolFiles) log.line(`[projecthub] artifact'tan proje-içi araç kopyaları çıkarıldı: ${pruned.toolFiles} dosya, ${(pruned.toolBytes / 1024 / 1024).toFixed(1)} MB`);
    const { checksum, sizeBytes: size } = await digestDirectory(artifactDir);
    const artifact = (
      await db
        .insert(artifacts)
        .values({
          organizationId: project.organizationId,
          projectId: project.id,
          buildId: build.id,
          type: 'build',
          storageKey: artifactKey,
          fileName: `build-${build.number}`,
          contentType: 'inode/directory',
          sizeBytes: size,
          checksum,
          retentionUntil: new Date(Date.now() + settings.retention.temporaryBuildDays * 86400_000),
        })
        .returning()
    )[0]!;
    const provenanceEvidence = await addEvidence(db, {
      organizationId: project.organizationId,
      projectId: project.id,
      workflowRunId: workflow.id,
      workflowStepId: workflowStepIds.get('artifact')!,
      kind: 'artifact_provenance',
      subjectType: 'build',
      subjectId: build.id,
      sourceType: 'build_worker',
      sourceRef: artifact.storageKey,
      revision: build.commitSha,
      artifactId: artifact.id,
      checksum,
      result: { outputKind, sizeBytes: size, branch: build.branch, commitSha: build.commitSha },
    });
    await recordVerification(db, {
      organizationId: project.organizationId,
      projectId: project.id,
      workflowRunId: workflow.id,
      workflowStepId: workflowStepIds.get('artifact')!,
      key: 'build:artifact_provenance',
      status: 'passed',
      summary: `Artifact ${build.commitSha.slice(0, 7)} revizyonuna ve SHA-256 özetine bağlandı`,
      expected: { revision: build.commitSha },
      observed: { revision: build.commitSha, checksum, artifactId: artifact.id, sizeBytes: size },
      evidenceIds: [provenanceEvidence.id],
    });
    log.line(`[projecthub] ${outputKind === 'static' ? 'statik çıktı' : 'çalıştırılabilir uygulama'} · ${(size / 1024 / 1024).toFixed(2)} MB · sha256:${checksum.slice(0, 12)}`);
    // Only a volume a container command worked in holds the app (a build without commands never filled one).
    if (cws?.isSeeded && outputKind === 'process' && ctx.config.PREVIEW_EXECUTOR === 'container') {
      // The preview container runs from a volume: fill it from this build's volume now (seconds) instead of streaming
      // the stored artifact back in from the host disk later (Form: over 10 minutes). Pruned like the artifact.
      const previewWs = artifactWorkspace(dockerBinary(), ctx.config.BUILD_CONTAINER_IMAGE, artifact.id);
      const copied = Date.now();
      try {
        await previewWs.seedFrom(cws, pruned.removed);
        log.line(`[projecthub] ön izleme container kopyası hazırlandı (${((Date.now() - copied) / 1000).toFixed(1)} sn)`);
      } catch (e) {
        await previewWs.remove();
        log.line(`[projecthub] ön izleme container kopyası hazırlanamadı; ön izleme artifact'ı kopyalayarak başlayacak: ${(e as Error).message.slice(0, 300)}`);
      }
    }
    await setStep('artifact', 'passed', { summary: `${outputKind === 'static' ? 'Statik çıktı' : 'Uygulama'} · ${(size / 1024 / 1024).toFixed(2)} MB · sha256:${checksum.slice(0, 12)}` });

    const finished = new Date();
    await db.transaction(async (tx) => {
      await tx.update(builds).set({ status: 'passed', artifactId: artifact.id, outputKind, finishedAt: finished, durationMs: finished.getTime() - started.getTime() }).where(eq(builds.id, build.id));
      await timeline(tx, {
        organizationId: project.organizationId,
        projectId: project.id,
        kind: 'build',
        tone: 'ok',
        title: `Build #${build.number} başarılı`,
        description: `${build.branch} · ${build.commitSha.slice(0, 7)} · ${Math.round((finished.getTime() - started.getTime()) / 1000)} sn`,
        refType: 'build',
        refId: build.id,
      });
      await audit(tx, { organizationId: project.organizationId, projectId: project.id, actor: SYSTEM_ACTOR, action: 'build.passed', resourceType: 'build', resourceId: build.id });
      await emitDomainEvent(tx, { event: 'build.completed', organizationId: project.organizationId, projectId: project.id, data: { buildId: build.id, number: build.number, branch: build.branch, commitSha: build.commitSha } });
      await recordVerification(tx, { organizationId: project.organizationId, projectId: project.id, workflowRunId: workflow.id, key: 'build:outcome', status: 'passed', summary: `Build #${build.number} doğrulandı`, expected: { status: 'passed', revision: build.commitSha }, observed: { status: 'passed', artifactId: artifact.id, checksum } });
      await setWorkflowStatus(tx, workflow.id, 'succeeded', { phase: 'completed', error: null });
      if (build.createPreview && manifest!.preview.enabled) await createPreviewFor(tx, ctx, project, build, manifest!);
      // An AI auto-fix waits for its verification build: prove it and, for low-risk fixes, merge it.
      if (build.trigger === 'ai') await enqueue(tx, { queue: QUEUES.security, type: 'ai.autofix.verify', projectId: project.id, organizationId: project.organizationId, dedupeKey: `autofix-verify:${build.id}`, payload: { buildId: build.id } });
      await enqueue(tx, { queue: QUEUES.maintenance, type: 'project.health', projectId: project.id, organizationId: project.organizationId, dedupeKey: `health:${project.id}`, payload: { projectId: project.id } });
    });
    await notify();
    return { status: 'passed' };
  } catch (e) {
    if (!(e instanceof StepFailed) && !cancelled) {
      logger.error({ err: e }, 'build crashed');
      log.line(`[projecthub] beklenmeyen hata: ${(e as Error).message}`);
      if (!failure) {
        failure = { step: current, message: (e as Error).message };
        await setStep(current, 'failed', { summary: failure.message }).catch(() => undefined);
      }
    }
    // Stopped because this worker is shutting down (a deploy, a dev rebuild), not because a person cancelled it: the
    // build goes back to the queue and the next worker runs it. Marking it "cancelled" lost three 20-minute
    // verification builds in one morning (2026-10-19) and left their fixes unverified.
    // The job runner puts the job itself back in the queue on shutdown (and a lost lease lets another worker claim it);
    // the build only has to be runnable again. After three interrupted attempts it fails like any other problem.
    if (cancelled && signal.aborted && job.attempts < 3 && !(await isCancelled().catch(() => false))) {
      log.line('[projecthub] worker yeniden başlıyor; build kuyruğa geri alındı ve baştan çalışacak');
      log.flush();
      await db.transaction(async (tx) => {
        await tx.update(builds).set({ status: 'queued', startedAt: null }).where(eq(builds.id, build.id));
        await tx.update(buildSteps).set({ status: 'pending' }).where(eq(buildSteps.buildId, build.id));
      });
      await notify();
      return { status: 'requeued' };
    }
    const finished = new Date();
    const status = cancelled ? 'cancelled' : 'failed';
    await db.transaction(async (tx) => {
      await tx
        .update(builds)
        .set({ status, error: failure ? { ...failure, step: STEP_NAMES[failure.step] } : null, finishedAt: finished, durationMs: finished.getTime() - started.getTime() })
        .where(eq(builds.id, build.id));
      // Remaining pending steps are marked skipped.
      await tx.update(buildSteps).set({ status: 'skipped' }).where(and(eq(buildSteps.buildId, build.id), eq(buildSteps.status, 'pending')));
      await tx.update(workflowSteps).set({ status: 'skipped', finishedAt: new Date() }).where(and(eq(workflowSteps.workflowRunId, workflow.id), eq(workflowSteps.status, 'pending')));
      await recordVerification(tx, {
        organizationId: project.organizationId,
        projectId: project.id,
        workflowRunId: workflow.id,
        workflowStepId: workflowStepIds.get(current) ?? null,
        key: 'build:outcome',
        status: 'failed',
        summary: cancelled ? `Build #${build.number} iptal edildi` : `Build #${build.number} başarısız`,
        expected: { status: 'passed', revision: build.commitSha },
        observed: { status, error: failure?.message ?? null, step: failure?.step ?? current },
      });
      await setWorkflowStatus(tx, workflow.id, cancelled ? 'cancelled' : 'failed', { phase: cancelled ? 'cancelled' : current, error: failure?.message ?? null });
      await timeline(tx, {
        organizationId: project.organizationId,
        projectId: project.id,
        kind: 'build',
        tone: cancelled ? 'idle' : 'bad',
        title: cancelled ? `Build #${build.number} iptal edildi` : `Build #${build.number} başarısız`,
        description: failure ? `${STEP_NAMES[failure.step]}: ${failure.message}${failure.file ? ` (${failure.file}${failure.line ? `:${failure.line}` : ''})` : ''}` : '',
        refType: 'build',
        refId: build.id,
      });
      if (!cancelled) {
        const triggeredBy = build.triggeredBy ? (await tx.select({ id: users.id }).from(users).where(eq(users.id, build.triggeredBy)))[0]?.id : null;
        await emitDomainEvent(tx, { event: 'build.failed', organizationId: project.organizationId, projectId: project.id, data: { buildId: build.id, number: build.number, triggeredBy: triggeredBy ?? null, error: failure?.message ?? '' } });
        await enqueue(tx, { queue: QUEUES.ai, type: 'ai.build_analysis', projectId: project.id, organizationId: project.organizationId, dedupeKey: `build-analysis:${build.id}`, maxAttempts: 2, payload: { buildId: build.id } });
      }
      // An AI auto-fix waits for its verification build: prove it and, for low-risk fixes, merge it.
      if (build.trigger === 'ai') await enqueue(tx, { queue: QUEUES.security, type: 'ai.autofix.verify', projectId: project.id, organizationId: project.organizationId, dedupeKey: `autofix-verify:${build.id}`, payload: { buildId: build.id } });
      await enqueue(tx, { queue: QUEUES.maintenance, type: 'project.health', projectId: project.id, organizationId: project.organizationId, dedupeKey: `health:${project.id}`, payload: { projectId: project.id } });
    });
    await notify();
    return { status };
  } finally {
    log.close();
    await cws?.remove();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    await fs.rm(buildToolDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}

class StepFailed extends Error {}

registerPeriodic({
  name: 'reconcile-build-containers',
  everyMinutes: 1,
  run: async (ctx) => {
    if (ctx.config.BUILD_EXECUTOR !== 'container') return 0;
    const containers = await listManagedBuildContainers();
    if (!containers.length) return 0;
    const activeWorkerRows = await ctx.db
      .select({ id: workerHeartbeats.workerId })
      .from(workerHeartbeats)
      .where(and(inArray(workerHeartbeats.workerId, [...new Set(containers.map((item) => item.workerId))]), gt(workerHeartbeats.lastSeenAt, new Date(Date.now() - 45_000))));
    const buildRows = await ctx.db
      .select({ id: builds.id, status: builds.status })
      .from(builds)
      .where(inArray(builds.id, [...new Set(containers.map((item) => item.buildId))]));
    const activeWorkers = new Set(activeWorkerRows.map((row) => row.id));
    const runningBuilds = new Set(buildRows.filter((row) => row.status === 'running').map((row) => row.id));
    const orphaned = containers.filter((item) => !activeWorkers.has(item.workerId) || !runningBuilds.has(item.buildId));
    await Promise.all(orphaned.map((item) => removeManagedBuildContainer(item.id)));
    return orphaned.length;
  },
});

/** Creates a preview for a successful build (called inside the build's finishing transaction). */
export async function createPreviewFor(
  tx: Executor,
  ctx: WorkerCtx,
  project: { id: string; organizationId: string; slug: string },
  build: { id: string; number: number; branch: string; commitSha: string; triggeredBy: string | null },
  manifest: Manifest,
) {
  const ttlMinutes = Math.min(durationToMinutes(manifest.preview.ttl), 60 * 24 * 14);
  const slug = previewSlug(project.slug, build.number);
  const row = (
    await tx
      .insert(previews)
      .values({
        organizationId: project.organizationId,
        projectId: project.id,
        buildId: build.id,
        slug,
        kind: 'static',
        status: 'queued',
        spa: manifest.preview.spa,
        sourceBranch: build.branch,
        sourceCommit: build.commitSha,
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
        createdBy: build.triggeredBy,
      })
      .returning({ id: previews.id })
  )[0]!;
  await enqueue(tx, { queue: QUEUES.preview, type: 'preview.start', projectId: project.id, organizationId: project.organizationId, payload: { previewId: row.id } });
  return row.id;
}

/**
 * Builds whose job is gone (worker restarted or crashed mid-build) would otherwise show "running" forever and block
 * the AI fix that waits for them. Re-run them, at most three times in total, then fail them with a clear reason.
 */
registerPeriodic({
  name: 'recover-orphaned-builds',
  everyMinutes: 2,
  run: async (ctx) => {
    const stuck = await ctx.db
      .select({ id: builds.id, projectId: builds.projectId, organizationId: builds.organizationId, number: builds.number, trigger: builds.trigger })
      .from(builds)
      .where(
        and(
          inArray(builds.status, ['queued', 'running']),
          sql`${builds.createdAt} < now() - interval '2 minutes'`,
          sql`not exists (select 1 from jobs j where j.type = 'build.execute' and j.status in ('queued', 'running') and j.payload->>'buildId' = ${builds.id}::text)`,
        ),
      );
    for (const b of stuck) {
      const tries = Number((await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where type = 'build.execute' and payload->>'buildId' = ${b.id}::text`)).rows[0]?.n ?? 0);
      if (tries < 3) {
        await ctx.db.update(builds).set({ status: 'queued', startedAt: null }).where(eq(builds.id, b.id));
        await ctx.db.update(buildSteps).set({ status: 'pending' }).where(eq(buildSteps.buildId, b.id));
        await enqueue(ctx.db, { queue: QUEUES.build, type: 'build.execute', organizationId: b.organizationId, projectId: b.projectId, maxAttempts: 1, payload: { buildId: b.id } });
        ctx.logger.info({ buildId: b.id, number: b.number, tries }, 're-queued a build whose job was lost');
      } else {
        await ctx.db.transaction(async (tx) => {
          await tx.update(builds).set({ status: 'failed', error: { step: 'Altyapı', message: 'Build işi üç kez yarıda kaldı (worker yeniden başladı). Yeniden başlatın.' }, finishedAt: new Date() }).where(eq(builds.id, b.id));
          if (b.trigger === 'ai') await enqueue(tx, { queue: QUEUES.security, type: 'ai.autofix.verify', projectId: b.projectId, organizationId: b.organizationId, dedupeKey: `autofix-verify:${b.id}`, payload: { buildId: b.id } });
        });
      }
      await publish(ctx.db, { type: 'build.updated', organizationId: b.organizationId, projectId: b.projectId, id: b.id });
    }
    return stuck.length;
  },
});

/**
 * A fresh checkout makes Composer extract every package archive again (minutes on Windows, even from its cache).
 * vendor/ is seeded from the newest passed build of the same project whose commit is already part of the default
 * branch, so `composer install` only adds, removes or changes the packages that differ from composer.lock. Output of
 * unmerged branches is never reused, so a branch build cannot plant files into another build. Files are hard-linked,
 * not copied: on Windows every freshly written file is scanned on its first read, which made Composer's autoload
 * step take minutes; a link is the already scanned file. Any problem falls back to a normal install.
 */
async function seedComposerVendor(ctx: WorkerCtx, projectId: string, defaultBranch: string, workspace: string, log: { line(text: string): void }) {
  const target = path.join(workspace, 'vendor');
  const has = (p: string) => fs.access(p).then(() => true, () => false);
  if (!(await has(path.join(workspace, 'composer.lock'))) || (await has(target))) return;
  const recent = await ctx.db
    .select({ id: builds.id, branch: builds.branch, commitSha: builds.commitSha })
    .from(builds)
    .where(and(eq(builds.projectId, projectId), eq(builds.status, 'passed')))
    .orderBy(desc(builds.finishedAt))
    .limit(10);
  const { git } = await openRepo(ctx, projectId);
  const head = await git.resolve(`refs/heads/${defaultBranch}`);
  for (const b of recent) {
    if (b.branch !== defaultBranch && !(head && (await git.isAncestor(b.commitSha, head)))) continue;
    const source = path.join(ctx.storage.resolve(ctx.storage.buildArtifactKey(projectId, b.id)), 'vendor');
    if (!(await has(path.join(source, 'composer', 'installed.json')))) continue;
    const started = Date.now();
    try {
      const how = await linkVendor(source, target).then(
        () => 'bağlandı',
        async () => {
          await fs.rm(target, { recursive: true, force: true });
          await copyTree(source, target);
          return 'kopyalandı';
        },
      );
      log.line(`[projecthub] vendor/ önceki başarılı build'den ${how} (${((Date.now() - started) / 1000).toFixed(1)} sn); Composer yalnızca değişen paketleri kuracak.`);
    } catch (e) {
      await fs.rm(target, { recursive: true, force: true });
      log.line(`[projecthub] vendor/ önbelleği kullanılamadı, normal kurulum yapılıyor: ${(e as Error).message}`);
    }
    return;
  }
}

/**
 * Hard-links a vendor tree. Files Composer rewrites in place (vendor/composer/*, vendor/bin proxies, autoload.php)
 * are real copies so the source artifact is never modified; everything else Composer replaces by deleting and
 * extracting, which only removes the link.
 */
async function linkVendor(from: string, to: string): Promise<void> {
  const copied = new Set(['composer', 'bin', 'autoload.php'].map((n) => path.join(from, n)));
  const jobs: [string, string][] = [];
  const walk = async (a: string, b: string) => {
    await fs.mkdir(b, { recursive: true });
    for (const e of await fs.readdir(a, { withFileTypes: true })) {
      const src = path.join(a, e.name);
      const dst = path.join(b, e.name);
      if (copied.has(src)) await fs.cp(src, dst, { recursive: true, verbatimSymlinks: true });
      else if (e.isDirectory()) await walk(src, dst);
      else if (e.isFile()) jobs.push([src, dst]);
      else await fs.cp(src, dst, { verbatimSymlinks: true });
    }
  };
  await walk(from, to);
  let next = 0;
  await Promise.all(
    Array.from({ length: 32 }, async () => {
      while (next < jobs.length) {
        const [src, dst] = jobs[next++]!;
        await fs.link(src, dst);
      }
    }),
  );
}

/** Fast directory copy: robocopy on Windows (multi-threaded), fs.cp elsewhere. */
async function copyTree(from: string, to: string): Promise<void> {
  if (process.platform !== 'win32') return fs.cp(from, to, { recursive: true, verbatimSymlinks: true });
  await new Promise<void>((resolve, reject) => {
    execFile('robocopy', [from, to, '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'], { windowsHide: true }, (err) => {
      // robocopy exit codes below 8 mean success (files copied, extras, mismatches); 8+ are failures.
      const code = (err as (Error & { code?: number }) | null)?.code ?? 0;
      if (typeof code === 'number' && code < 8) resolve();
      else reject(new Error(`robocopy çıkış kodu ${code}`));
    });
  });
}

registerPeriodic({
  // Workspace volumes of builds/AI checks a crashed worker left behind (each holds a full dependency tree).
  name: 'reconcile-workspace-volumes',
  everyMinutes: 10,
  run: async (ctx) => {
    if (ctx.config.BUILD_EXECUTOR !== 'container') return 0;
    const volumes = await listWorkspaceVolumes();
    if (!volumes.length) return 0;
    const buildIds = volumes.map((v) => v.buildId).filter((x): x is string => !!x);
    const taskIds = volumes.map((v) => v.taskId).filter((x): x is string => !!x);
    const activeBuilds = new Set(buildIds.length ? (await ctx.db.select({ id: builds.id }).from(builds).where(and(inArray(builds.id, buildIds), inArray(builds.status, ['queued', 'running'])))).map((r) => r.id) : []);
    const activeTasks = new Set(taskIds.length ? (await ctx.db.select({ id: aiTasks.id }).from(aiTasks).where(and(inArray(aiTasks.id, taskIds), inArray(aiTasks.status, ['queued', 'running'])))).map((r) => r.id) : []);
    const orphaned = volumes.filter((v) => (v.buildId ? !activeBuilds.has(v.buildId) : v.taskId ? !activeTasks.has(v.taskId) : true));
    for (const v of orphaned) await removeWorkspaceVolume(v.name);
    return orphaned.length;
  },
});
