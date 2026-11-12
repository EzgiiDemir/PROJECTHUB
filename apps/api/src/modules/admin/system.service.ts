import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { and, count, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AiSettings, AutomationSettings, RetentionSettings } from '@projecthub/contracts';
import { ai, audit, dirSize, encryptToString, getOrgSettings, notFound, randomToken, type Actor } from '@projecthub/core';
import { aiActions, aiMemories, aiRuns, aiTasks, auditEvents, codeChunks, codeFiles, jobs, organizations, projects, users, webhookDeliveries, webhooks, workerHeartbeats } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { Paged } from '../../infra/http.js';

@Injectable()
export class SystemService {
  constructor(private readonly ctx: Ctx) {}

  async getSettings(auth: AuthInfo) {
    const s = await getOrgSettings(this.ctx.db, auth.organizationId);
    return {
      ...s,
      aiProviders: { ollama: !!this.ctx.config.OLLAMA_BASE_URL, openai: !!this.ctx.config.OPENAI_API_KEY, anthropic: !!this.ctx.config.ANTHROPIC_API_KEY },
    };
  }

  private async patchSettings(auth: AuthInfo, key: 'ai' | 'retention' | 'automation', value: unknown, actor: Actor) {
    await this.ctx.db
      .update(organizations)
      .set({ settings: sql`jsonb_set(${organizations.settings}, ${`{${key}}`}::text[], ${JSON.stringify(value)}::jsonb, true)` })
      .where(eq(organizations.id, auth.organizationId));
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: `settings.${key}_updated`, resourceType: 'organization', resourceId: auth.organizationId, metadata: { [key]: value } });
    return this.getSettings(auth);
  }

  updateAi(auth: AuthInfo, value: AiSettings, actor: Actor) {
    return this.patchSettings(auth, 'ai', value, actor);
  }
  updateRetention(auth: AuthInfo, value: RetentionSettings, actor: Actor) {
    return this.patchSettings(auth, 'retention', value, actor);
  }
  updateAutomation(auth: AuthInfo, value: AutomationSettings, actor: Actor) {
    return this.patchSettings(auth, 'automation', value, actor);
  }

  async auditLog(auth: AuthInfo, q: { actorType?: string; projectId?: string; action?: string; from?: string; to?: string; cursor?: string; limit: number }) {
    const conds: SQL[] = [eq(auditEvents.organizationId, auth.organizationId)];
    if (q.actorType) conds.push(eq(auditEvents.actorType, q.actorType as never));
    if (q.projectId) conds.push(eq(auditEvents.projectId, q.projectId));
    if (q.action) conds.push(or(ilike(auditEvents.action, `%${q.action}%`), ilike(auditEvents.actorLabel, `%${q.action}%`))!);
    if (q.from) conds.push(gte(auditEvents.createdAt, new Date(q.from)));
    if (q.to) conds.push(lt(auditEvents.createdAt, new Date(q.to)));
    if (q.cursor) {
      const [ts, id] = q.cursor.split('|');
      conds.push(sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${new Date(ts!)}, ${id}::uuid)`);
    }
    const rows = await this.ctx.db
      .select({ e: auditEvents, projectName: projects.name, projectSlug: projects.slug })
      .from(auditEvents)
      .leftJoin(projects, eq(projects.id, auditEvents.projectId))
      .where(and(...conds))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return new Paged(
      page.map((r) => ({ ...r.e, projectName: r.projectName, projectSlug: r.projectSlug })),
      { hasMore, nextCursor: hasMore && last ? `${last.e.createdAt.toISOString()}|${last.e.id}` : null },
    );
  }

  /** Infrastructure view: host resources, storage usage per category, workers and queues (spec §20–22, §108). */
  async systemStatus(organizationId?: string) {
    // Disk walks can take tens of seconds for large repositories. Serve the last snapshot immediately and refresh it
    // in the background so the system/worker health page never waits behind storage accounting.
    const { usage, refreshing: storageRefreshing } = storageUsage(this.ctx.storage.root);
    const root = this.ctx.storage.root;
    let disk: { total: number; free: number } | null = null;
    try {
      const s = await fs.statfs(root);
      disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      disk = null;
    }
    const dbSize = await this.ctx.db.execute<{ size: number }>(sql`SELECT pg_database_size(current_database())::bigint AS size`);
    // Only workers that are alive now; ones replaced by a restart are history and only add noise.
    const workers = await this.ctx.db.select().from(workerHeartbeats).where(gte(workerHeartbeats.lastSeenAt, new Date(Date.now() - 90_000))).orderBy(desc(workerHeartbeats.lastSeenAt));
    const recentErrors = organizationId
      ? (
          await this.ctx.db
            .select({ requestId: auditEvents.resourceId, at: auditEvents.createdAt, user: auditEvents.actorLabel, metadata: auditEvents.metadata })
            .from(auditEvents)
            .where(and(eq(auditEvents.organizationId, organizationId), eq(auditEvents.action, 'system.error'), gte(auditEvents.createdAt, new Date(Date.now() - 7 * 86_400_000))))
            .orderBy(desc(auditEvents.createdAt))
            .limit(20)
        ).map((e) => ({ requestId: e.requestId, at: e.at, user: e.user, method: String(e.metadata.method ?? ''), path: String(e.metadata.path ?? ''), message: String(e.metadata.message ?? '') }))
      : [];
    const queueStats = await this.ctx.db
      .select({ queue: jobs.queue, status: jobs.status, n: count() })
      .from(jobs)
      .where(sql`${jobs.status} IN ('queued','running') OR (${jobs.status} = 'failed' AND ${jobs.finishedAt} > now() - interval '24 hours')`)
      .groupBy(jobs.queue, jobs.status);
    const failedJobs = await this.ctx.db
      .select({ id: jobs.id, type: jobs.type, lastError: jobs.lastError, finishedAt: jobs.finishedAt, attempts: jobs.attempts })
      .from(jobs)
      .where(eq(jobs.status, 'failed'))
      .orderBy(desc(jobs.finishedAt))
      .limit(20);
    const now = Date.now();
    const localAi = await ai.getOllamaRuntimeStatus(this.ctx.config.OLLAMA_BASE_URL);
    return {
      host: {
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()}`,
        cpus: os.cpus().length,
        loadAverage: os.loadavg(),
        memory: { total: os.totalmem(), free: os.freemem() },
        uptimeSeconds: Math.round(os.uptime()),
        nodeVersion: process.version,
      },
      disk,
      storage: { ...usage, database: Number(dbSize.rows[0]?.size ?? 0) },
      storageRefreshing,
      workers: workers.map((w) => ({ ...w, healthy: now - w.lastSeenAt.getTime() < 60_000 })),
      queues: queueStats,
      failedJobs,
      recentErrors,
      services: {
        api: true,
        database: true,
        worker: workers.some((w) => now - w.lastSeenAt.getTime() < 60_000),
        ai: localAi.reachable || !!(this.ctx.config.OPENAI_API_KEY || this.ctx.config.ANTHROPIC_API_KEY),
        localAi,
        smtp: !!this.ctx.config.SMTP_HOST,
        dependencyDatabase: !!this.ctx.config.OSV_API_URL,
      },
    };
  }

  /** AI control center data: this month's usage by purpose, recent runs and policy-denied agent actions (spec §25–26). */
  async aiUsage(auth: AuthInfo) {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const byPurpose = await this.ctx.db
      .select({
        purpose: aiRuns.purpose,
        runs: count(),
        failed: sql<number>`count(*) FILTER (WHERE ${aiRuns.status} = 'failed')::int`,
        tokens: sql<number>`coalesce(sum(${aiRuns.inputTokens} + ${aiRuns.outputTokens}), 0)::bigint`,
      })
      .from(aiRuns)
      .where(and(eq(aiRuns.organizationId, auth.organizationId), gte(aiRuns.startedAt, monthStart)))
      .groupBy(aiRuns.purpose);
    const recent = await this.ctx.db
      .select({ r: aiRuns, projectName: projects.name, projectSlug: projects.slug, userName: users.displayName })
      .from(aiRuns)
      .leftJoin(projects, eq(projects.id, aiRuns.projectId))
      .leftJoin(users, eq(users.id, aiRuns.userId))
      .where(eq(aiRuns.organizationId, auth.organizationId))
      .orderBy(desc(aiRuns.startedAt))
      .limit(50);
    const denied = await this.ctx.db
      .select({ a: aiActions })
      .from(aiActions)
      .innerJoin(aiRuns, eq(aiRuns.id, aiActions.runId))
      .where(and(eq(aiRuns.organizationId, auth.organizationId), eq(aiActions.decision, 'denied')))
      .orderBy(desc(aiActions.createdAt))
      .limit(20);
    const qualityRows = await this.ctx.db.execute<{
      total: number; completed: number; failed: number; verified: number; decided: number; corrected: number; retried: number; merged: number; regressed: number;
    }>(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE t.status IN ('completed','merged','awaiting_approval'))::int AS completed,
        count(*) FILTER (WHERE t.status IN ('failed','cancelled'))::int AS failed,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM builds b WHERE b.id = t.build_id AND b.status = 'passed'))::int AS verified,
        count(*) FILTER (WHERE t.status IN ('merged','rejected'))::int AS decided,
        count(*) FILTER (WHERE t.status = 'rejected')::int AS corrected,
        count(*) FILTER (WHERE (SELECT count(*) FROM ai_runs r WHERE r.task_id = t.id) > 1)::int AS retried,
        count(*) FILTER (WHERE t.status = 'merged')::int AS merged,
        count(*) FILTER (WHERE t.status = 'merged' AND EXISTS (
          SELECT 1 FROM workflow_runs w
          INNER JOIN verification_results v ON v.workflow_run_id = w.id
          WHERE w.trigger_ref = t.id::text AND v.status = 'failed'
        ))::int AS regressed
      FROM ai_tasks t
      WHERE t.organization_id = ${auth.organizationId} AND t.created_at >= ${monthStart}
    `);
    const quality = qualityRows.rows[0] ?? { total: 0, completed: 0, failed: 0, verified: 0, decided: 0, corrected: 0, retried: 0, merged: 0, regressed: 0 };
    const totalTokens = byPurpose.reduce((sum, p) => sum + Number(p.tokens), 0);
    return {
      byPurpose: byPurpose.map((p) => ({ ...p, tokens: Number(p.tokens) })),
      recent: recent.map((x) => ({ ...x.r, projectName: x.projectName, projectSlug: x.projectSlug, userName: x.userName })),
      denied: denied.map((d) => d.a),
      quality: {
        ...quality,
        completionRate: quality.total ? quality.completed / quality.total : null,
        verifiedFixRate: quality.total ? quality.verified / quality.total : null,
        failureRate: quality.total ? quality.failed / quality.total : null,
        humanCorrectionRate: quality.decided ? quality.corrected / quality.decided : null,
        retryRate: quality.total ? quality.retried / quality.total : null,
        regressionRate: quality.merged ? quality.regressed / quality.merged : null,
        tokensPerVerifiedTask: quality.verified ? Math.round(totalTokens / quality.verified) : null,
      },
    };
  }

  /**
   * AI operations view: tasks that are running or waiting for a human decision, the AI job queue, per-project index
   * and memory status, and host resources (CPU/RAM sampled here, GPU through nvidia-smi when the API host has one).
   */
  async aiOperations(auth: AuthInfo) {
    const org = auth.organizationId;
    const taskRows = await this.ctx.db
      .select({ t: aiTasks, projectName: projects.name, projectSlug: projects.slug, requestedBy: users.displayName })
      .from(aiTasks)
      .innerJoin(projects, eq(projects.id, aiTasks.projectId))
      .leftJoin(users, eq(users.id, aiTasks.requestedBy))
      .where(and(eq(aiTasks.organizationId, org), inArray(aiTasks.status, ['queued', 'running', 'awaiting_approval'])))
      .orderBy(desc(aiTasks.createdAt))
      .limit(100);
    const tasks = taskRows.map((r) => ({
      id: r.t.id,
      key: `AI-${r.t.number}`,
      type: r.t.type,
      title: r.t.title,
      status: r.t.status,
      autonomyLevel: r.t.autonomyLevel,
      startedAt: r.t.startedAt,
      createdAt: r.t.createdAt,
      projectName: r.projectName,
      projectSlug: r.projectSlug,
      requestedBy: r.requestedBy,
    }));
    const [queue] = await this.ctx.db
      .select({
        queued: sql<number>`count(*) FILTER (WHERE ${jobs.status} = 'queued')::int`,
        running: sql<number>`count(*) FILTER (WHERE ${jobs.status} = 'running')::int`,
        failed24h: sql<number>`count(*) FILTER (WHERE ${jobs.status} = 'failed' AND ${jobs.finishedAt} > now() - interval '24 hours')::int`,
      })
      .from(jobs)
      .where(and(eq(jobs.organizationId, org), eq(jobs.queue, 'ai')));
    const index = await this.ctx.db
      .select({
        projectId: projects.id,
        name: projects.name,
        slug: projects.slug,
        files: sql<number>`(SELECT count(*) FROM ${codeFiles} WHERE ${codeFiles.projectId} = ${projects.id})::int`,
        lastIndexedAt: sql<string | null>`(SELECT max(${codeFiles.updatedAt}) FROM ${codeFiles} WHERE ${codeFiles.projectId} = ${projects.id})`,
        chunks: sql<number>`(SELECT count(*) FROM ${codeChunks} WHERE ${codeChunks.projectId} = ${projects.id})::int`,
        embedded: sql<number>`(SELECT count(*) FROM ${codeChunks} WHERE ${codeChunks.projectId} = ${projects.id} AND ${codeChunks.embedding} IS NOT NULL)::int`,
        memories: sql<number>`(SELECT count(*) FROM ${aiMemories} WHERE ${aiMemories.projectId} = ${projects.id})::int`,
        verifiedMemories: sql<number>`(SELECT count(*) FROM ${aiMemories} WHERE ${aiMemories.projectId} = ${projects.id} AND ${aiMemories.verification} = 'verified')::int`,
      })
      .from(projects)
      .where(and(eq(projects.organizationId, org), sql`${projects.archivedAt} IS NULL`))
      .orderBy(projects.name);
    return {
      active: tasks.filter((t) => t.status !== 'awaiting_approval'),
      approvals: tasks.filter((t) => t.status === 'awaiting_approval'),
      queue: queue ?? { queued: 0, running: 0, failed24h: 0 },
      index,
      host: await hostResources(),
    };
  }

  async retryJob(id: string) {
    const r = await this.ctx.db
      .update(jobs)
      .set({ status: 'queued', attempts: 0, runAt: new Date(), lastError: null, finishedAt: null })
      .where(and(eq(jobs.id, id), eq(jobs.status, 'failed')))
      .returning({ id: jobs.id });
    if (!r.length) throw notFound('Başarısız iş');
  }

  /* ---------------- webhooks ---------------- */

  async listWebhooks(auth: AuthInfo) {
    const rows = await this.ctx.db.select().from(webhooks).where(eq(webhooks.organizationId, auth.organizationId)).orderBy(desc(webhooks.createdAt));
    return rows.map(({ secretCiphertext: _s, ...w }) => w);
  }

  async createWebhook(auth: AuthInfo, input: { url: string; events: string[]; projectId: string | null; active: boolean }, actor: Actor) {
    if (input.projectId) {
      const p = await this.ctx.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.organizationId, auth.organizationId)));
      if (!p.length) throw notFound('Proje');
    }
    const secret = `whsec_${randomToken(32)}`;
    const row = (
      await this.ctx.db
        .insert(webhooks)
        .values({ organizationId: auth.organizationId, projectId: input.projectId, url: input.url, events: input.events, active: input.active, secretCiphertext: encryptToString(this.ctx.config.encryptionKey, secret), createdBy: auth.user.id })
        .returning()
    )[0]!;
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'webhook.created', resourceType: 'webhook', resourceId: row.id, metadata: { url: input.url, events: input.events } });
    // The signing secret is shown once; receivers verify X-ProjectHub-Signature with it.
    return { id: row.id, url: row.url, events: row.events, signingSecret: secret };
  }

  async deleteWebhook(auth: AuthInfo, id: string, actor: Actor) {
    const r = await this.ctx.db.delete(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.organizationId, auth.organizationId))).returning();
    if (!r.length) throw notFound('Webhook');
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'webhook.deleted', resourceType: 'webhook', resourceId: id, metadata: { url: r[0]!.url } });
  }

  async webhookDeliveries(auth: AuthInfo, id: string) {
    const hook = await this.ctx.db.select({ id: webhooks.id }).from(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.organizationId, auth.organizationId)));
    if (!hook.length) throw notFound('Webhook');
    return this.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, id)).orderBy(desc(webhookDeliveries.createdAt)).limit(50);
  }
}

export interface GpuStat {
  name: string;
  utilization: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
}

let gpuCache: { at: number; value: GpuStat[] | null } = { at: 0, value: null };

/** CPU busy share over a short sample, memory, and GPUs (nvidia-smi, cached 10 s; null when unavailable). */
async function hostResources() {
  const sample = () => os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
  const a = sample();
  await new Promise((r) => setTimeout(r, 250));
  const b = sample();
  const cpuPercent = b.total > a.total ? Math.round((1 - (b.idle - a.idle) / (b.total - a.total)) * 100) : null;
  if (Date.now() - gpuCache.at > 10_000) {
    gpuCache = {
      at: Date.now(),
      value: await new Promise<GpuStat[] | null>((resolve) =>
        execFile('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 3000, windowsHide: true }, (err, out) => {
          if (err) return resolve(null);
          resolve(
            out
              .trim()
              .split(/\r?\n/)
              .filter(Boolean)
              .map((l) => {
                const [name, util, used, total] = l.split(',').map((x) => x.trim());
                return { name: name ?? 'GPU', utilization: Number(util), memoryUsedMb: Number(used), memoryTotalMb: Number(total) };
              }),
          );
        }),
      ),
    };
  }
  return { cpuCount: os.cpus().length, cpuPercent, memoryTotal: os.totalmem(), memoryFree: os.freemem(), gpus: gpuCache.value };
}

const STORAGE_CATEGORIES = ['repos', 'artifacts', 'workspaces', 'logs', 'backups', 'uploads'];
let storageCache: { at: number; value: Record<string, number> } | null = null;
let storageRefresh: Promise<void> | null = null;

/**
 * Storage size per category. Walking build artifacts (node_modules included) takes seconds, so the result is shared by
 * concurrent requests and reused for 5 minutes; the page polls every 15 s and must not queue up full disk walks.
 */
function storageUsage(root: string): { usage: Record<string, number>; refreshing: boolean } {
  const stale = !storageCache || Date.now() - storageCache.at > 5 * 60_000;
  if (stale && !storageRefresh) {
    storageRefresh = Promise.all(STORAGE_CATEGORIES.map(async (category) => [category, await dirSize(`${root}/${category}`)] as const))
      .then((entries) => {
        storageCache = { at: Date.now(), value: Object.fromEntries(entries) };
      })
      .finally(() => {
        storageRefresh = null;
      });
  }
  return {
    usage: storageCache?.value ?? Object.fromEntries(STORAGE_CATEGORIES.map((category) => [category, 0])),
    refreshing: !!storageRefresh,
  };
}
