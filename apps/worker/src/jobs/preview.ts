import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { and, asc, eq, gt, inArray, isNull, like, lt, ne, or, sql } from 'drizzle-orm';
import {
  emitDomainEvent,
  enqueue,
  getOrgSettings,
  PermanentJobError,
  previewUrl,
  publish,
  QUEUES,
  resolveEnvSecrets,
  timeline,
  type JobContext,
  retainPreviewArtifact,
  missingRequiredEnv,
} from '@projecthub/core';
import { artifacts, builds, jobs, previews } from '@projecthub/database';
import { loadProject, type WorkerCtx } from '../context.js';
import { registerLifecycle } from '../lifecycle.js';
import { registerPeriodic } from './maintenance.js';
import { dockerBinary, expandPort, isPortFree, killPortListener, killPortRangeListeners, killTree, phpOpcacheEnv, runtimeEnv, sanitizedEnv, secretMaskList, startService } from '../runner/process.js';
import { hostLoopbackToGateway, listPreviewResources, PreviewContainer, previewContainerName, removePreviewContainer, removePreviewVolume } from '../runner/preview-container.js';
import { removeStaleWorkspaceHelpers } from '../runner/container-workspace.js';
import { previewAttemptOwner } from './preview-owner.js';

/** Processes started by this worker instance (previewId → child). */
const running = new Map<string, ChildProcess>();
/** Containers of server previews started by this worker instance (PREVIEW_EXECUTOR=container). */
const containers = new Map<string, PreviewContainer>();

function previewBox(ctx: WorkerCtx, previewId: string, artifactId: string): PreviewContainer {
  const c = ctx.config;
  return new PreviewContainer(dockerBinary(), { image: c.BUILD_CONTAINER_IMAGE, cpus: c.PREVIEW_CONTAINER_CPUS, memoryMb: c.PREVIEW_CONTAINER_MEMORY_MB, pids: c.PREVIEW_CONTAINER_PIDS }, previewId, artifactId);
}
/** How long an app (and each service) gets to answer its health check after starting. */
const START_TIMEOUT_MS = 180_000;

/** Previews being stopped on purpose: their processes' exits are expected. */
const stopping = new Set<string>();
/** Manifest services started by this worker instance (previewId → children). */
const runningServices = new Map<string, ChildProcess[]>();

async function allocatePort(ctx: WorkerCtx, taken: number[] = []): Promise<number> {
  const active = await ctx.db.select({ port: previews.internalPort, services: previews.services }).from(previews).where(inArray(previews.status, ['starting', 'ready']));
  const used = new Set([...taken, ...active.flatMap((r) => [r.port, ...r.services.map((x) => x.port)])]);
  const { from, to } = ctx.config.PREVIEW_PORT_RANGE;
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = from + Math.floor(Math.random() * (to - from + 1));
    if (!used.has(port) && (await isPortFree(port))) return port;
  }
  throw new Error('Boş ön izleme portu bulunamadı');
}

async function waitHealthy(port: number, healthPath: string, timeoutMs: number, child: ChildProcess, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    // A worker shutting down must not wait minutes for an app to boot: the re-queued job starts it again.
    if (signal?.aborted) {
      killTree(child);
      throw new Error('Worker kapanıyor; ön izleme yeniden başlatılacak');
    }
    if (child.exitCode !== null) return { ok: false, detail: `Süreç kapandı (çıkış kodu ${child.exitCode})` };
    try {
      // A first request may boot the whole framework (a cold Laravel start took 18 s): give it time instead of
      // aborting every attempt after a few seconds and calling a slow app broken.
      const res = await fetch(`http://127.0.0.1:${port}${healthPath}`, { signal: AbortSignal.timeout(20_000), redirect: 'manual' });
      // Only the status matters. An unread body that is still open when the server goes away crashes Node's HTTP
      // client (undici "assert(!this.paused)"), which took the whole worker down.
      await res.body?.cancel().catch(() => undefined);
      if (res.status < 500) return { ok: true, detail: `HTTP ${res.status}` };
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return { ok: false, detail: `Sağlık kontrolü zaman aşımı (${last})` };
}

export async function startPreview(ctx: WorkerCtx, { job, logger, signal }: JobContext) {
  // restart: brought back automatically after a worker restart; people were already told it was ready.
  const { previewId, restart } = job.payload as { previewId: string; restart?: boolean };
  const db = ctx.db;
  const pv = (await db.select().from(previews).where(eq(previews.id, previewId)))[0];
  if (!pv) throw new PermanentJobError('preview not found');
  // Restart lifecycle explicitly moves ready previews to queued. A delayed duplicate must not restart a winner.
  if (['stopped', 'expired', 'ready'].includes(pv.status)) return { skipped: pv.status };
  if (pv.status === 'starting' && pv.runnerId) {
    const owners = await db.select({ id: jobs.id, worker: jobs.lockedBy, attempts: jobs.attempts }).from(jobs)
      .where(and(eq(jobs.type, 'preview.start'), eq(jobs.projectId, pv.projectId), eq(jobs.organizationId, pv.organizationId),
        ne(jobs.id, job.id), eq(jobs.status, 'running'), gt(jobs.lockedUntil, new Date()), sql`${jobs.payload}->>'previewId' = ${pv.id}`));
    if (owners.some((owner) => owner.worker && previewAttemptOwner(owner.worker, owner.id, owner.attempts) === pv.runnerId)) {
      return { skipped: 'another leased attempt is starting this preview' };
    }
  }
  const project = await loadProject(ctx, pv.projectId);
  const build = (await db.select().from(builds).where(eq(builds.id, pv.buildId)))[0];
  const artifact = build?.artifactId ? (await db.select().from(artifacts).where(eq(artifacts.id, build.artifactId)))[0] : undefined;
  const url = previewUrl(ctx.config.PREVIEW_PUBLIC_URL_TEMPLATE, pv.slug);
  // A job whose worker is stopping (or lost its lease) must not write "failed" or clean up: whatever went wrong may be
  // the shutdown itself (its containers removed, a `docker exec` refused), and a replacement worker may already be
  // starting this preview under the same container name. The re-queued job starts it again.
  const abandonIfAborted = () => {
    if (signal?.aborted) throw new Error('Worker kapanıyor; ön izleme yeniden başlatılacak');
  };
  let starting = false;
  const ownerId = previewAttemptOwner(ctx.workerId, job.id, job.attempts);
  const ownsJobLease = () => sql<boolean>`exists (select 1 from ${jobs} where ${jobs.id} = ${job.id}
    and ${jobs.organizationId} = ${pv.organizationId} and ${jobs.projectId} = ${pv.projectId}
    and ${jobs.status} = 'running' and ${jobs.lockedBy} = ${ctx.workerId} and ${jobs.lockedUntil} > now())`;
  const claimWhere = () => and(eq(previews.id, pv.id), inArray(previews.status, ['queued', 'starting', 'ready', 'failed']), gt(previews.expiresAt, new Date()), ownsJobLease());
  const startupWhere = () => and(claimWhere(), eq(previews.runnerId, ownerId), eq(previews.status, 'starting'));
  const assertStartupCurrent = async () => {
    abandonIfAborted();
    const [owner] = await db.select({ id: previews.id }).from(previews).where(startupWhere());
    abandonIfAborted();
    if (!owner) throw new Error('Ön izleme başlangıç sahipliği değişti; eski deneme devam edemez');
  };
  const fail = async (message: string) => {
    abandonIfAborted();
    if (starting) await assertStartupCurrent();
    const changed = await db.update(previews).set({ status: 'failed', error: message })
      .where(starting ? startupWhere() : claimWhere())
      .returning({ id: previews.id });
    if (!changed.length) throw new Error('Ön izleme durumu değişti; eski hata sonucu uygulanmadı');
    await timeline(db, { organizationId: project.organizationId, projectId: project.id, kind: 'preview', tone: 'bad', title: 'Ön izleme başlatılamadı', description: message, refType: 'preview', refId: pv.id });
    await publish(db, { type: 'preview.updated', organizationId: project.organizationId, projectId: project.id, id: pv.id });
  };
  if (!build || build.status !== 'passed' || !artifact) return fail('Build artifact\'ı bulunamadı (build başarılı değil veya artifact silinmiş)');
  if (!(await ctx.storage.exists(artifact.storageKey))) return fail('Artifact dosyaları saklama politikası gereği silinmiş; yeniden build alın');
  // Keep the artifact while a preview uses it (plus the preview-build retention window).
  await retainPreviewArtifact(db, project.organizationId, artifact.id, pv.expiresAt);

  const manifest = build.manifest;
  const services = manifest?.services ?? [];
  const isProcess = build.outputKind === 'process';
  if (!isProcess && !services.length) {
    abandonIfAborted();
    const ready = await db.update(previews).set({ kind: 'static', status: 'ready', rootKey: artifact.storageKey, error: null }).where(claimWhere()).returning({ id: previews.id });
    if (!ready.length) throw new Error('Ön izleme durumu veya iş sahipliği değişti');
  } else {
    if (!manifest || (isProcess && !manifest.start?.command)) return fail('Manifestte start.command tanımlı değil');
    await enforcePreviewLimit(ctx, project.organizationId, pv.id);
    const port = isProcess ? await allocatePort(ctx) : null;
    abandonIfAborted();
    const claimed = await db.update(previews).set({ kind: isProcess ? 'process' : 'static', status: 'starting', rootKey: artifact.storageKey, internalPort: port, services: [], runnerId: ownerId, error: null })
      .where(and(claimWhere(), eq(previews.status, pv.status), pv.runnerId ? eq(previews.runnerId, pv.runnerId) : isNull(previews.runnerId))).returning({ id: previews.id });
    if (!claimed.length) return { skipped: 'preview state or startup owner changed' };
    starting = true;
    await assertStartupCurrent();
    await publish(db, { type: 'preview.updated', organizationId: project.organizationId, projectId: project.id, id: pv.id });
    const unreadable: string[] = [];
    const secrets = await resolveEnvSecrets(db, ctx.config.encryptionKey, { organizationId: project.organizationId, projectId: project.id, environmentId: null, scope: 'runtime' }, (name) => unreadable.push(name));
    if (unreadable.length) logger.warn({ previewId: pv.id, names: unreadable }, 'preview secrets could not be decrypted; started without them');
    const missing = missingRequiredEnv(manifest, secrets);
    if (missing.length) return fail(`Zorunlu ortam değişkeni eksik: ${missing.join(', ')}. Secret'lar ekranından "Çalışma" veya "Tümü" kullanımıyla ekleyin.`);
    const logKey = ctx.storage.previewLogKey(project.id, pv.id);
    await ctx.storage.ensureDir(path.dirname(logKey));
    const logFile = ctx.storage.resolve(logKey);
    const cwd = ctx.storage.resolve(artifact.storageKey);
    const inContainer = ctx.config.PREVIEW_EXECUTOR === 'container';
    const runtime = inContainer
      ? { ...runtimeEnv(manifest.runtime?.type, true), ...hostLoopbackToGateway(secrets) }
      : { ...runtimeEnv(manifest.runtime?.type), ...(manifest.runtime?.type === 'php' ? phpOpcacheEnv(ctx.storage.resolve('tmp/php')) : {}), ...secrets };
    const env: Record<string, string> = { ...runtime, HOST: '127.0.0.1', HOSTNAME: '127.0.0.1', NODE_ENV: 'production', PROJECTHUB_PREVIEW_URL: url };
    const failWithLog = async (detail: string) => {
      await assertStartupCurrent();
      stopServiceChildren(pv.id);
      const tail = await fs.readFile(logFile, 'utf8').then((t) => t.split('\n').slice(-15).join('\n')).catch(() => '');
      return fail(`${detail}${tail ? `\n${tail}` : ''}`);
    };

    const servicePorts: number[] = [];
    for (let i = 0; i < services.length; i++) servicePorts.push(await allocatePort(ctx, [...(port ? [port] : []), ...servicePorts]));
    // Container mode: one container per preview, every port published up front; the app and each service are then
    // started inside it exactly like host processes (the Docker client process stands in for them).
    let box: PreviewContainer | null = null;
    if (inContainer) {
      box = previewBox(ctx, pv.id, artifact.id);
      containers.set(pv.id, box);
      try {
        await box.start(cwd, [...(port ? [port] : []), ...servicePorts], ctx.config.PREVIEW_PORT_RANGE, { signal, assertCurrent: assertStartupCurrent });
      } catch (e) {
        if (containers.get(pv.id) === box) containers.delete(pv.id);
        abandonIfAborted();
        await box.remove();
        // Never fall back to running the app on this machine: the preview fails with a clear reason instead.
        return fail(`Ön izleme container'ı başlatılamadı (Docker çalışıyor mu, ${ctx.config.BUILD_CONTAINER_IMAGE} imajı var mı?): ${(e as Error).message.split('\n').slice(-3).join(' ').slice(0, 400)}`);
      }
      // Copying can take minutes: a worker that started stopping meanwhile leaves the rest to the re-queued job.
      if (signal?.aborted) {
        if (containers.get(pv.id) === box) containers.delete(pv.id);
        abandonIfAborted();
      }
    }
    const launch = (command: string, processPort: number) => {
      abandonIfAborted();
      const processEnv = { ...env, PORT: String(processPort) };
      return box
        ? startService({ command, cwd, env: processEnv, logFile, mask: secretMaskList(secrets), dockerArgs: box.execArgs(command, Object.keys(processEnv)) })
        : startService({ command, cwd, env: sanitizedEnv(processEnv), logFile, mask: secretMaskList(secrets) });
    };

    // Services start first: the app may call them while it starts. Their output goes to the preview log too.
    const started: { name: string; port: number; paths: string[]; processId: number | null }[] = [];
    for (const [i, service] of services.entries()) {
      await assertStartupCurrent();
      const servicePort = servicePorts[i]!;
      const child = launch(expandPort(service.command, servicePort), servicePort);
      runningServices.set(pv.id, [...(runningServices.get(pv.id) ?? []), child]);
      const health = await waitHealthy(servicePort, service.health, START_TIMEOUT_MS, child, signal);
      await assertStartupCurrent();
      if (!health.ok) return failWithLog(`Servis "${service.name}": ${health.detail}`);
      child.on('exit', (code) => {
        if (!signal?.aborted && (!box || containers.get(pv.id) === box)) void onProcessExit(ctx, pv.id, ownerId, code, service.name).catch(() => undefined);
      });
      started.push({ name: service.name, port: servicePort, paths: service.paths, processId: child.pid ?? null });
      const base = `http://127.0.0.1:${servicePort}`;
      env[`PROJECTHUB_SERVICE_${service.name.toUpperCase().replace(/-/g, '_')}_URL`] = base;
      if (service.urlEnv) env[service.urlEnv] = base;
    }
    await assertStartupCurrent();
    await db.update(previews).set({ services: started }).where(startupWhere());

    if (port) {
      const child = launch(expandPort(manifest.start!.command, port), port);
      running.set(pv.id, child);
      child.on('exit', (code) => {
        if (signal?.aborted || (box && containers.get(pv.id) !== box) || running.get(pv.id) !== child) return;
        running.delete(pv.id);
        // A late exit (worker shutting down, database already closed) must not become an unhandled rejection.
        void onProcessExit(ctx, pv.id, ownerId, code).catch(() => undefined);
      });
      const health = await waitHealthy(port, manifest.health.path, START_TIMEOUT_MS, child, signal);
      await assertStartupCurrent();
      if (!health.ok) {
        killTree(child);
        running.delete(pv.id);
        return failWithLog(health.detail);
      }
    }
    await assertStartupCurrent();
    const ready = await db.update(previews).set({ status: 'ready', processId: running.get(pv.id)?.pid ?? null }).where(startupWhere()).returning({ id: previews.id });
    if (!ready.length) throw new Error('Ön izleme durumu değişti; eski hazır sonucu uygulanmadı');
  }
  await db.transaction(async (tx) => {
    // An automatic restart is silent: the preview was announced when it first became ready.
    if (!restart) {
      await timeline(tx, {
        organizationId: project.organizationId,
        projectId: project.id,
        kind: 'preview',
        tone: 'ok',
        title: `Ön izleme hazır: ${pv.slug}`,
        description: `Build #${build.number} · ${pv.sourceBranch} · ${new Date(pv.expiresAt).toLocaleString('tr-TR')} tarihine kadar`,
        refType: 'preview',
        refId: pv.id,
      });
      await emitDomainEvent(tx, { event: 'preview.ready', organizationId: project.organizationId, projectId: project.id, data: { previewId: pv.id, url, createdBy: pv.createdBy } });
    }
    await publish(tx, { type: 'preview.updated', organizationId: project.organizationId, projectId: project.id, id: pv.id });
  });
  logger.info({ previewId: pv.id, kind: build.outputKind }, 'preview ready');
  return { url };
}

async function onProcessExit(ctx: WorkerCtx, previewId: string, ownerId: string, code: number | null, service?: string) {
  if (stopping.has(previewId)) return;
  const pv = (await ctx.db.select().from(previews).where(eq(previews.id, previewId)))[0];
  if (!pv || pv.status !== 'ready' || pv.runnerId !== ownerId) return;
  // The app and its services work together: one of them gone means the preview no longer works.
  const app = running.get(previewId);
  if (service && app) killTree(app);
  stopServiceChildren(previewId);
  const what = service ? `"${service}" servisi` : 'Uygulama süreci';
  await ctx.db.update(previews).set({ status: 'failed', error: `${what} beklenmedik şekilde kapandı (kod ${code})`, processId: null }).where(and(eq(previews.id, previewId), eq(previews.runnerId, ownerId), eq(previews.status, 'ready')));
  await publish(ctx.db, { type: 'preview.updated', organizationId: pv.organizationId, projectId: pv.projectId, id: previewId });
}

function stopServiceChildren(previewId: string) {
  const children = runningServices.get(previewId) ?? [];
  runningServices.delete(previewId);
  for (const child of children) killTree(child);
  // Killing a `docker exec` client leaves its process running in the container: the container itself goes.
  const box = containers.get(previewId);
  containers.delete(previewId);
  if (box) void box.remove();
}

/** Spec §109–110: cap concurrently running server previews; the oldest is stopped first. */
async function enforcePreviewLimit(ctx: WorkerCtx, organizationId: string, exceptId: string) {
  const { retention } = await getOrgSettings(ctx.db, organizationId);
  const active = await ctx.db
    .select({ id: previews.id })
    .from(previews)
    .where(and(eq(previews.organizationId, organizationId), eq(previews.kind, 'process'), inArray(previews.status, ['starting', 'ready']), ne(previews.id, exceptId)))
    .orderBy(asc(previews.createdAt));
  const excess = active.length - (retention.maxRunningPreviews - 1);
  for (const p of active.slice(0, Math.max(0, excess))) {
    await stopPreviewNow(ctx, p.id, 'stopped', 'Eşzamanlı ön izleme sınırı nedeniyle durduruldu');
  }
}

export async function stopPreviewNow(ctx: WorkerCtx, previewId: string, status: 'stopped' | 'expired', reason?: string) {
  const pv = (await ctx.db.select().from(previews).where(eq(previews.id, previewId)))[0];
  if (!pv || ['stopped', 'expired'].includes(pv.status)) return;
  // The terminal state is written before anything is killed: the processes' exit handlers then see an intentional
  // stop and cannot turn it into "failed".
  stopping.add(previewId);
  await ctx.db.update(previews).set({ status, stoppedAt: new Date(), processId: null, error: reason ?? null }).where(eq(previews.id, previewId));
  const child = running.get(previewId);
  running.delete(previewId);
  const local = pv.runnerId?.split(':')[0] === os.hostname();
  if (child) killTree(child);
  else if (pv.processId && local) killTree(pv.processId);
  const ownServices = runningServices.has(previewId);
  const box = containers.get(previewId);
  containers.delete(previewId);
  stopServiceChildren(previewId);
  // Container previews: removed by name even when another worker process started them (idempotent).
  if (ctx.config.PREVIEW_EXECUTOR === 'container' || box) {
    await removePreviewContainer(previewContainerName(previewId), dockerBinary());
    await removeUnusedPreviewVolumes(ctx).catch(() => 0);
  }
  if (local) {
    if (!ownServices) for (const s of pv.services) if (s.processId) killTree(s.processId);
    for (const p of [...(pv.kind === 'process' && pv.internalPort ? [pv.internalPort] : []), ...pv.services.map((s) => s.port)]) await killPortListener(p);
  }
  setTimeout(() => stopping.delete(previewId), 30_000).unref();
  await timeline(ctx.db, {
    organizationId: pv.organizationId,
    projectId: pv.projectId,
    kind: 'preview',
    tone: 'idle',
    title: status === 'expired' ? `Ön izleme süresi doldu: ${pv.slug}` : `Ön izleme durduruldu: ${pv.slug}`,
    description: reason ?? '',
    refType: 'preview',
    refId: pv.id,
  });
  await publish(ctx.db, { type: 'preview.updated', organizationId: pv.organizationId, projectId: pv.projectId, id: pv.id });
}

export async function stopPreview(ctx: WorkerCtx, { job }: JobContext) {
  const { previewId, reason } = job.payload as { previewId: string; reason?: string };
  await stopPreviewNow(ctx, previewId, reason === 'expired' ? 'expired' : 'stopped', reason === 'archived' ? 'Proje arşivlendi' : undefined);
  return { ok: true };
}

/* Previews survive worker restarts: server previews owned by a previous worker process are restarted. */
registerLifecycle({
  start: async (ctx) => {
    const orphaned = await ctx.db
      .select({ id: previews.id, organizationId: previews.organizationId, projectId: previews.projectId, processId: previews.processId, internalPort: previews.internalPort, services: previews.services })
      .from(previews)
      .where(
        and(
          or(eq(previews.kind, 'process'), sql`jsonb_array_length(${previews.services}) > 0`),
          or(
            inArray(previews.status, ['starting', 'ready']),
            // Stopped together with the dev server / worker (Ctrl+C on Windows = 3221225786, or a signal): not a
            // problem of the app, so it comes back as long as it has not expired.
            and(eq(previews.status, 'failed'), gt(previews.expiresAt, new Date()), or(like(previews.error, '%(kod 3221225786)%'), like(previews.error, '%(kod null)%'), like(previews.error, '%(kod 130)%'))),
          ),
        ),
      );
    // Every preview server left by an earlier worker process goes first (their shell parents may already be gone,
    // so per-process kills miss them); the ones still wanted are restarted below. Preview containers go the same way
    // (`docker rm -f`); the port-range sweep never touches Docker's own port proxy.
    // Their artifact volumes stay: the restarted previews reuse them.
    if (ctx.config.PREVIEW_EXECUTOR === 'container') {
      const left = await listPreviewResources(dockerBinary());
      for (const c of left.containers) await removePreviewContainer(c.name, dockerBinary());
      if (left.containers.length) ctx.logger.info({ removed: left.containers.length }, 'removed preview containers left by an earlier worker');
      // Nothing copies at worker start: every copy helper is a leftover of the previous worker process.
      await removeStaleWorkspaceHelpers(dockerBinary(), Number.MAX_SAFE_INTEGER);
    }
    const { from, to } = ctx.config.PREVIEW_PORT_RANGE;
    const killed = await killPortRangeListeners(from, to);
    if (killed) ctx.logger.info({ killed }, 'stopped preview servers left by an earlier worker');
    for (const p of orphaned) {
      if (p.processId) await killTree(p.processId);
      for (const s of p.services) if (s.processId) await killTree(s.processId);
      await ctx.db.update(previews).set({ status: 'queued', processId: null }).where(eq(previews.id, p.id));
      await enqueue(ctx.db, { queue: QUEUES.preview, type: 'preview.start', projectId: p.projectId, organizationId: p.organizationId, payload: { previewId: p.id, restart: true }, dedupeKey: `preview-start:${p.id}` });
    }
    if (orphaned.length) ctx.logger.info({ count: orphaned.length }, 'restarting server previews after worker restart');
  },
  stop: async () => {
    // The worker is going away, the previews are not: their exits are expected, their state stays "ready" and the
    // next worker start brings them back. Marking them failed left every preview dead after a worker restart.
    for (const id of [...running.keys(), ...runningServices.keys()]) stopping.add(id);
    for (const child of running.values()) killTree(child);
    for (const id of [...runningServices.keys()]) stopServiceChildren(id);
  },
});

registerPeriodic({
  name: 'expire-previews',
  everyMinutes: 1,
  run: async (ctx) => {
    const due = await ctx.db
      .select({ id: previews.id })
      .from(previews)
      .where(and(inArray(previews.status, ['queued', 'starting', 'ready', 'failed']), lt(previews.expiresAt, new Date())));
    for (const p of due) await stopPreviewNow(ctx, p.id, 'expired');
    return due.length;
  },
});

/** Artifact volumes no queued, starting or ready preview uses any more. */
async function removeUnusedPreviewVolumes(ctx: WorkerCtx, volumes?: { name: string; artifactId: string; createdAt: number }[]): Promise<number> {
  const list = volumes ?? (await listPreviewResources(dockerBinary())).volumes;
  if (!list.length) return 0;
  const inUse = new Set(
    (await ctx.db.select({ artifactId: builds.artifactId }).from(previews).innerJoin(builds, eq(builds.id, previews.buildId)).where(inArray(previews.status, ['queued', 'starting', 'ready']))).map((r) => r.artifactId),
  );
  // A container build fills the volume before its preview row exists: young volumes are left alone.
  const unused = list.filter((v) => !inUse.has(v.artifactId) && Date.now() - v.createdAt > 30 * 60_000);
  for (const v of unused) await removePreviewVolume(v.name, dockerBinary());
  return unused.length;
}

/* A preview container whose preview is no longer live (a crash mid-stop), an unused artifact volume or a copy helper
   of a killed worker is removed. */
registerPeriodic({
  name: 'reconcile-preview-containers',
  everyMinutes: 10,
  run: async (ctx) => {
    if (ctx.config.PREVIEW_EXECUTOR !== 'container') return 0;
    await removeStaleWorkspaceHelpers(dockerBinary());
    const left = await listPreviewResources(dockerBinary());
    const ids = [...new Set(left.containers.map((r) => r.previewId))];
    const live = new Set(ids.length ? (await ctx.db.select({ id: previews.id }).from(previews).where(and(inArray(previews.id, ids), inArray(previews.status, ['queued', 'starting', 'ready'])))).map((r) => r.id) : []);
    let removed = 0;
    for (const c of left.containers.filter((r) => !live.has(r.previewId))) {
      await removePreviewContainer(c.name, dockerBinary());
      removed++;
    }
    return removed + (await removeUnusedPreviewVolumes(ctx, left.volumes));
  },
});
