import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { enqueue, QUEUES, type JobContext } from '@projecthub/core';
import { jobs, uploads, workerHeartbeats } from '@projecthub/database';
import type { WorkerCtx } from '../context.js';

type Task = { name: string; everyMinutes: number; run: (ctx: WorkerCtx) => Promise<unknown> };
const tasks: Task[] = [];

/** Feature modules register periodic tasks; the minute tick runs those that are due. */
export function registerPeriodic(task: Task) {
  tasks.push(task);
}

registerPeriodic({
  name: 'expire-uploads',
  everyMinutes: 30,
  run: async (ctx) => {
    const expired = await ctx.db.select().from(uploads).where(and(lt(uploads.expiresAt, new Date()), isNull(uploads.consumedAt)));
    for (const u of expired) {
      await ctx.storage.remove(u.storageKey);
      await ctx.db.delete(uploads).where(eq(uploads.id, u.id));
    }
    return expired.length;
  },
});

// Automatic mode also works on projects nobody touched since it was switched on: every 15 minutes each active,
// trusted project with open problems gets an autofix.auto run (it skips problems already being fixed).
registerPeriodic({
  name: 'autofix-sweep',
  everyMinutes: 15,
  run: async (ctx) => {
    const rows = await ctx.db.execute<{ id: string; organization_id: string }>(sql`
      SELECT p.id, p.organization_id FROM projects p
      WHERE p.status = 'active'
        AND coalesce(p.settings->>'autoFix', 'true') <> 'false'
        AND coalesce(p.settings->>'executionTrust', '') <> 'untrusted'
        AND EXISTS (SELECT 1 FROM security_findings f WHERE f.project_id = p.id AND f.status = 'open')`);
    for (const p of rows.rows) {
      await enqueue(ctx.db, { queue: QUEUES.maintenance, type: 'autofix.auto', projectId: p.id, organizationId: p.organization_id, dedupeKey: `autofix-auto:${p.id}`, payload: { projectId: p.id } });
    }
    return rows.rows.length;
  },
});

// Upload folders that never became a project: unfinished chunked uploads and failed extractions (the database
// rows of finished uploads are expired by expire-uploads).
registerPeriodic({
  name: 'prune-upload-dirs',
  everyMinutes: 60,
  run: async (ctx) => {
    const base = ctx.storage.resolve('uploads');
    const dirs = await fs.readdir(base).catch(() => [] as string[]);
    const known = new Set((await ctx.db.select({ id: uploads.id }).from(uploads)).map((u) => u.id));
    let removed = 0;
    for (const d of dirs) {
      if (known.has(d)) continue;
      const st = await fs.stat(path.join(base, d)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 24 * 3600_000) {
        await ctx.storage.remove(`uploads/${d}`).catch(() => undefined);
        removed++;
      }
    }
    return removed;
  },
});

// Build and AI workspaces are removed when their job ends, but on Windows a locked file (EBUSY/EPERM) leaves the
// folder behind, sometimes renamed with a timestamp suffix. No build or AI job runs for 12 hours.
registerPeriodic({
  name: 'prune-stale-workspaces',
  everyMinutes: 60,
  run: async (ctx) => {
    const base = ctx.storage.resolve('workspaces');
    const dirs = await fs.readdir(base).catch(() => [] as string[]);
    let removed = 0;
    for (const d of dirs.filter((n) => /^(build|ai)-/.test(n))) {
      const st = await fs.stat(path.join(base, d)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 12 * 3600_000) {
        await ctx.storage.remove(`workspaces/${d}`).catch(() => undefined);
        removed++;
      }
    }
    return removed;
  },
});

// A worker that restarts mid-call leaves its AI run "running" for good, and usage/monitoring count it as live. Close
// runs whose task has already ended, and runs without a task (analyses, chat) after two hours.
registerPeriodic({
  name: 'close-orphaned-ai-runs',
  everyMinutes: 10,
  run: async (ctx) => {
    const r = await ctx.db.execute(sql`
      UPDATE ai_runs r SET status = 'failed', error = 'Yarıda kaldı (worker yeniden başladı)', finished_at = now()
      WHERE r.status = 'running' AND (
        (r.task_id IS NOT NULL AND EXISTS (SELECT 1 FROM ai_tasks t WHERE t.id = r.task_id AND t.status NOT IN ('queued', 'running')))
        OR (r.task_id IS NULL AND r.started_at < now() - interval '2 hours'))
      RETURNING r.id`);
    return r.rows.length;
  },
});

registerPeriodic({
  name: 'prune-jobs',
  everyMinutes: 60,
  run: async (ctx) => {
    const r = await ctx.db.delete(jobs).where(and(sql`${jobs.status} IN ('completed','cancelled')`, lt(jobs.finishedAt, new Date(Date.now() - 7 * 86400_000)))).returning({ id: jobs.id });
    await ctx.db.delete(workerHeartbeats).where(lt(workerHeartbeats.lastSeenAt, new Date(Date.now() - 3600_000)));
    return r.length;
  },
});

export async function maintenanceTick(ctx: WorkerCtx, { job, logger }: JobContext) {
  const minute = Number((job.payload as { minute?: number }).minute ?? Math.floor(Date.now() / 60_000));
  const results: Record<string, unknown> = {};
  for (const t of tasks) {
    if (minute % t.everyMinutes !== 0) continue;
    try {
      results[t.name] = await t.run(ctx);
    } catch (e) {
      logger.error({ err: e, task: t.name }, 'maintenance task failed');
      results[t.name] = `error: ${(e as Error).message}`;
    }
  }
  return results;
}
