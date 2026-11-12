import os from 'node:os';
import { closeTerminal, openTerminal, runTerminalCommand } from './jobs/terminal.js';
import { autofixAuto, runAiTaskOrAutofix, verifyAutofix } from './jobs/autofix.js';
import { DeferJobError, getOrgSettings, PermanentJobError, type JobContext, type JobHandler } from '@projecthub/core';
import { and, count, eq, inArray } from 'drizzle-orm';
import { buildSteps, jobs, projects } from '@projecthub/database';
import type { WorkerCtx } from './context.js';
import { analyseBuildFailure, relateFeedback } from './jobs/ai.js';
import { feedbackScreenshot, responsiveTest } from './jobs/browser.js';
import { executeBuild } from './jobs/build.js';
import { backupDatabase, checkDatabase, executeDeployment, testTarget } from './jobs/deploy.js';
import { restoreBackup, verifyBackup } from './jobs/database.js';
import { deliverWebhook, dispatchEvent } from './jobs/events.js';
import { generateGuide } from './jobs/guide.js';
import { indexCode, recomputeHealth } from './jobs/index-code.js';
import { maintenanceTick } from './jobs/maintenance.js';
import { startPreview, stopPreview } from './jobs/preview.js';
import { runRemediation } from './jobs/remediation.js';
import { compactRepository, detectJob, provisionRepository, syncJob } from './jobs/repository.js';
import { securityScan } from './jobs/security.js';

type Job = (ctx: WorkerCtx, job: JobContext) => Promise<unknown>;

const EMERGENCY_STOP_TYPES = new Set([
  'repository.provision',
  'repository.sync',
  'build.execute',
  'preview.start',
  'ai.build_analysis',
  'ai.task.run',
  'ai.autofix.verify',
  'autofix.auto',
  'ai.remediation.run',
  'terminal.open',
  'terminal.run',
  'deployment.execute',
  'database.backup',
  'database.restore',
]);

/** Jobs that load a model, install dependencies, run a build or start browsers/servers: several GB each. */
const HEAVY_TYPES = new Set(['build.execute', 'preview.start', 'responsive.test', 'guide.generate', 'feedback.screenshot', 'ai.task.run', 'ai.remediation.run']);
/** AI jobs reuse what the local model already holds; that memory counts as available to them (not to builds). */
const AI_TYPES = new Set(['ai.task.run', 'ai.remediation.run']);
/** After this long the waiting message asks an operator to act (the job keeps waiting; it is never forced to start). */
const OPERATOR_NOTICE_MS = 15 * 60_000;

/**
 * Resource guard: a heavy job does not start while free memory is critically low (measured 1.1 GB free of 31.6 GB with
 * the local model, a Form build and a preview running on 2026-10-19 — another build there makes Windows swap and every
 * job time out). It waits — however long — with the reason visible; it is never started anyway after a deadline,
 * because that would remove the protection exactly when it is needed. Running jobs are never touched.
 * `modelBytes`: RAM held by models loaded in Ollama (host part, not VRAM), usable by AI jobs.
 */
export function assertMemoryAvailable(type: string, createdAt: Date, minFreeMb: number, freeBytes = os.freemem(), now = Date.now(), modelBytes = 0) {
  if (!HEAVY_TYPES.has(type) || minFreeMb <= 0) return;
  const usable = freeBytes + (AI_TYPES.has(type) ? modelBytes : 0);
  if (usable >= minFreeMb * 1024 * 1024) return;
  const waited = Math.round((now - createdAt.getTime()) / 60_000);
  const notice = now - createdAt.getTime() > OPERATOR_NOTICE_MS ? ` ${waited} dakikadır bekliyor: çalışan işleri, ön izlemeleri veya bellek eşiğini (MIN_FREE_MEMORY_MB) kontrol edin.` : '';
  throw new DeferJobError(`Kaynak bekleniyor: boş bellek ${Math.round(freeBytes / 1024 / 1024)} MB, en az ${minFreeMb} MB gerekli. İş bellek açılınca kendiliğinden başlayacak.${notice}`, 30_000);
}

/** Host RAM held by the models Ollama has loaded (total minus the part in VRAM); 0 when Ollama is unreachable. */
async function loadedModelBytes(baseUrl: string): Promise<number> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ps`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return 0;
    const body = (await res.json()) as { models?: { size?: number; size_vram?: number }[] };
    return (body.models ?? []).reduce((n, m) => n + Math.max(0, (m.size ?? 0) - (m.size_vram ?? 0)), 0);
  } catch {
    return 0;
  }
}

/** Waits for memory (see assertMemoryAvailable) and shows the reason on a waiting build, apart from code failures. */
async function waitForResources(ctx: WorkerCtx, jc: JobContext) {
  const type = jc.job.type;
  if (!HEAVY_TYPES.has(type)) return;
  const modelBytes = AI_TYPES.has(type) && ctx.config?.OLLAMA_BASE_URL ? await loadedModelBytes(ctx.config.OLLAMA_BASE_URL) : 0;
  try {
    assertMemoryAvailable(type, jc.job.createdAt ?? new Date(), ctx.config?.MIN_FREE_MEMORY_MB ?? 1024, os.freemem(), Date.now(), modelBytes);
  } catch (e) {
    const buildId = (jc.job.payload as { buildId?: string } | null)?.buildId;
    if (e instanceof DeferJobError && type === 'build.execute' && buildId) {
      await ctx.db.update(buildSteps).set({ summary: e.message.slice(0, 500) }).where(and(eq(buildSteps.buildId, buildId), eq(buildSteps.key, 'checkout'), eq(buildSteps.status, 'pending'))).catch(() => undefined);
    }
    throw e;
  }
}

export async function assertAutomationAllowed(ctx: WorkerCtx, jc: JobContext) {
  await waitForResources(ctx, jc);
  if (!jc.job.organizationId) return;
  const { automation } = await getOrgSettings(ctx.db, jc.job.organizationId);
  if (automation.pausedJobTypes.includes(jc.job.type)) {
    throw new DeferJobError(`İş türü yönetici tarafından duraklatıldı: ${jc.job.type}`, 60_000);
  }
  if (automation.emergencyStop && EMERGENCY_STOP_TYPES.has(jc.job.type)) {
    throw new DeferJobError(`Organizasyon acil durdurması etkin${automation.reason ? `: ${automation.reason}` : ''}`, 60_000);
  }
  if (jc.job.projectId && EMERGENCY_STOP_TYPES.has(jc.job.type)) {
    const project = (await ctx.db.select({ settings: projects.settings }).from(projects).where(and(eq(projects.id, jc.job.projectId), eq(projects.organizationId, jc.job.organizationId))))[0];
    const policy = (project?.settings as { automationPolicy?: { maxConcurrentRuns?: number; maxWorkflowDepth?: number; maxRetries?: number } } | undefined)?.automationPolicy;
    if (policy) {
      const depth = Number((jc.job.payload as { workflowDepth?: number }).workflowDepth ?? 0);
      if (depth > (policy.maxWorkflowDepth ?? 5)) throw new DeferJobError(`Proje workflow zincir sınırı aşıldı (${depth}/${policy.maxWorkflowDepth})`, 60_000);
      if (jc.job.attempts > (policy.maxRetries ?? 2) + 1) throw new PermanentJobError(`Proje otomasyon yeniden deneme sınırı aşıldı (${policy.maxRetries})`);
      const [running] = await ctx.db.select({ n: count() }).from(jobs).where(and(eq(jobs.projectId, jc.job.projectId), eq(jobs.status, 'running'), inArray(jobs.type, [...EMERGENCY_STOP_TYPES])));
      if ((running?.n ?? 0) > (policy.maxConcurrentRuns ?? 2)) throw new DeferJobError(`Proje eşzamanlı otomasyon sınırı dolu (${policy.maxConcurrentRuns})`, 15_000);
    }
  }
}

/** Job type → implementation. Every job type the API or worker enqueues must be listed here. */
export function buildHandlers(ctx: WorkerCtx): Record<string, JobHandler> {
  const jobs: Record<string, Job> = {
    'repository.provision': provisionRepository,
    'repository.sync': syncJob,
    'repository.compact': compactRepository,
    'project.detect': detectJob,
    'code.index': indexCode,
    'project.health': recomputeHealth,
    'security.scan': securityScan,
    'event.dispatch': dispatchEvent,
    'webhook.deliver': deliverWebhook,
    'maintenance.tick': maintenanceTick,
    'build.execute': executeBuild,
    'preview.start': startPreview,
    'preview.stop': stopPreview,
    'feedback.screenshot': feedbackScreenshot,
    'responsive.test': responsiveTest,
    'guide.generate': generateGuide,
    'feedback.relate': relateFeedback,
    'ai.build_analysis': analyseBuildFailure,
    'ai.task.run': runAiTaskOrAutofix,
    'ai.autofix.verify': verifyAutofix,
    'autofix.auto': autofixAuto,
    'terminal.open': openTerminal,
    'terminal.run': runTerminalCommand,
    'terminal.close': closeTerminal,
    'ai.remediation.run': runRemediation,
    'deployment.execute': executeDeployment,
    'deployment.test_target': testTarget,
    'database.check': checkDatabase,
    'database.backup': backupDatabase,
    'database.verify_backup': verifyBackup,
    'database.restore': restoreBackup,
  };
  return Object.fromEntries(
    Object.entries(jobs).map(([k, fn]) => [
      k,
      async (job: JobContext) => {
        await assertAutomationAllowed(ctx, job);
        return fn(ctx, job);
      },
    ]),
  );
}
