import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { ai, audit, blockedByDependencyConflict, canReprepare, createAutofixTasks, enqueue, getOrgSettings, PRE_EXISTING_CONFLICT, latestManifest, nextNumber, notFound, planAutofix, precondition, publish, QUEUES, reprepareAutofix, type Actor, type AutofixItem, type PlanFinding } from '@projecthub/core';
import { aiTasks, builds, deploymentTargets, environments, previews, projects, secrets, securityFindings, securityScans } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';
import { Repos } from '../../infra/repos.js';
import { AiService } from './ai.service.js';

export type { AutofixItem };

type StepStatus = 'todo' | 'queued' | 'running' | 'verifying' | 'needs_approval' | 'failed' | 'done' | 'blocked' | 'info';
export interface AssistantStep {
  id: string;
  phase: 'setup' | 'security' | 'quality' | 'release';
  title: string;
  /** Plain-language explanation: what it is and why it matters. */
  explain: string;
  status: StepStatus;
  severity?: string;
  /** Primary action the assistant offers for this step. */
  action?: { kind: 'autofix'; key: string; label: string } | { kind: 'trust'; label: string } | { kind: 'build'; label: string } | { kind: 'scan'; label: string } | { kind: 'link'; href: string; label: string } | { kind: 'reverify'; taskId: string; label: string } | { kind: 'envimport'; source: 'text' | 'history'; label: string };
  method?: string;
  risk?: 'low' | 'medium' | 'high';
  autoMerge?: boolean;
  details?: string[];
  findings?: PlanFindingView[];
  task?: { id: string; key: string; status: string; queuedAt?: Date; startedAt?: Date | null; verdict?: { status: string; reasons: string[] } | null; error?: string | null };
  reason?: string;
}
type PlanFindingView = PlanFinding & { references: string[]; advisoryId: string | null };

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * "Fix all with AI" and the project assistant. Planning is shared with the worker's automatic mode
 * (packages/core/src/autofix.ts); every fix is proven by the worker after its verification build.
 */
@Injectable()
export class AutofixService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
    private readonly aiService: AiService,
    private readonly repos: Repos,
  ) {}

  private async inputs(auth: AuthInfo, projectId: string, project: typeof projects.$inferSelect) {
    const org = await getOrgSettings(this.ctx.db, auth.organizationId);
    const aiReady = await ai.resolveAi(this.ctx.db, this.ctx.config, auth.organizationId, { minLevel: 'L2', projectId }).then(
      () => true,
      () => false,
    );
    const findings = await this.ctx.db.select().from(securityFindings).where(and(eq(securityFindings.projectId, projectId), eq(securityFindings.status, 'open')));
    const openFixes = await this.ctx.db
      .select()
      .from(aiTasks)
      .where(and(eq(aiTasks.projectId, projectId), isNotNull(aiTasks.autofix), inArray(aiTasks.status, ['queued', 'running', 'awaiting_approval'])));
    // A fix that already failed in the last 24 hours is not offered again (no retry loops); it is listed with the
    // reason it failed so a person can act on it.
    const recentlyFailed = await this.ctx.db
      .select()
      .from(aiTasks)
      .where(and(eq(aiTasks.projectId, projectId), isNotNull(aiTasks.autofix), inArray(aiTasks.status, ['failed', 'rejected', 'cancelled']), sql`${aiTasks.createdAt} > now() - interval '7 days'`))
      .orderBy(desc(aiTasks.createdAt));
    const busy = new Set(openFixes.flatMap((t) => t.autofix?.findingIds ?? []));
    // Only problems that are still open count, and only real failures: a task cut off by a worker restart or a
    // provider timeout says nothing about the fix, so the AI simply tries again.
    const openIds = new Set(findings.map((f) => f.id));
    const failedBefore = new Map<string, typeof aiTasks.$inferSelect>();
    for (const t of recentlyFailed) {
      // A person rejected the proposed code, not the underlying problem. Keep the finding available for an explicit
      // new attempt; automatic mode still treats rejected tasks as busy and will not create a retry loop itself.
      if (t.status === 'rejected') continue;
      if (transientFailure(t.error)) continue;
      // Handled below for the whole folder, not as a problem of this task's packages.
      if (preExistingConflict(t)) continue;
      // Deterministic package/file fixes are safe to prepare again after their cause is fixed; keeping them hidden
      // for 24 hours turned a recoverable .env cleanup into a dead-end "manual" step. An upgrade the package manager
      // could not resolve is different: it fails the same way until the other packages move too (laravel/framework
      // 13 failed three times in a day, 2026-10-19), so it is not offered again for 7 days.
      const age = Date.now() - t.createdAt.getTime();
      if (t.autofix?.mode === 'agent' ? age > 24 * 3600_000 : !unresolvableUpgrade(t)) continue;
      for (const id of t.autofix?.findingIds ?? []) if (openIds.has(id) && !busy.has(id) && !failedBefore.has(id)) failedBefore.set(id, t);
    }
    for (const id of failedBefore.keys()) busy.add(id);
    const lastBuild = (await this.ctx.db.select().from(builds).where(and(eq(builds.projectId, projectId), eq(builds.branch, project.defaultBranch))).orderBy(desc(builds.createdAt)).limit(1))[0];
    // A dependency tree that was already broken (npm ERESOLVE between packages nobody is upgrading) fails every npm
    // upgrade in that folder the same way: Form tried five security upgrades in three days, each blamed on its own
    // package. Until the default branch changes (a new build), the folder's npm findings wait and one entry says why.
    const blockedByConflict = blockedByDependencyConflict(recentlyFailed, findings, lastBuild?.createdAt);
    for (const { findingIds } of blockedByConflict.values()) for (const id of findingIds) busy.add(id);
    // One AI attempt per failed build; environment failures (missing PHP extension, Composer home, network) are not
    // code problems and never go to the AI.
    const buildTried = lastBuild ? (await this.ctx.db.select({ n: sql<number>`count(*)::int` }).from(aiTasks).where(and(eq(aiTasks.projectId, projectId), eq(aiTasks.sourceType, 'build'), eq(aiTasks.sourceId, lastBuild.id))))[0]!.n > 0 : false;
    const buildBusy = buildTried || openFixes.some((t) => t.autofix?.kind === 'build');
    const environmentFailure = lastBuild?.status === 'failed' ? environmentProblem(lastBuild.error) : null;
    const health = (project.settings as { health?: { components?: Record<string, number | null> } }).health;
    const docsMissing = health?.components?.documentation != null && health.components.documentation <= 40 && !openFixes.some((t) => t.autofix?.kind === 'docs') && !recentlyFailed.some((t) => t.autofix?.kind === 'docs');
    const plan = planAutofix({
      findings,
      busy,
      failedBuild: lastBuild?.status === 'failed' && !buildBusy && !environmentFailure ? { id: lastBuild.id, number: lastBuild.number, error: lastBuild.error, aiAnalysis: lastBuild.aiAnalysis } : null,
      docsMissing,
      aiReady,
      autoMergeOn: org.ai.autoFix.autoMergeLowRisk,
      // "Fix all" is for real problems. Optional major-version migrations (not vulnerabilities) each need a full build
      // and a person's review; they filled the queue for hours (2026-10-19). They start one by one from Dependencies.
      includeOptionalUpgrades: false,
    });
    const byTask = new Map<string, { task: typeof aiTasks.$inferSelect; findingIds: string[] }>();
    for (const [id, t] of failedBefore) byTask.set(t.id, { task: t, findingIds: [...(byTask.get(t.id)?.findingIds ?? []), id] });
    for (const { task, findingIds } of byTask.values()) {
      plan.skipped.push({
        title: task.title,
        reason: unresolvableUpgrade(task)
          ? `AI-${task.number}: paket yöneticisi bu yükseltmeyi mevcut bağımlılıklarla çözemedi (başka paketler eski sürümü istiyor). Bu bir güvenlik açığı düzeltmesi değilse beklemesinde sakınca yok; 7 gün boyunca yeniden denenmez. Bağlı paketlerle birlikte elle veya AI görevine "birlikte yükselt" diyerek yükseltebilirsiniz.`
          : `AI-${task.number} başarısız oldu: ${failureReason(task)} 24 saat içinde otomatik yeniden denenmez; nedeni giderdikten sonra tekrar başlatabilirsiniz.`,
        findingIds,
      });
    }
    for (const [folder, { task, findingIds: ids }] of blockedByConflict) {
      const cause = (task.error ?? '').replace(/^.*?zaten çakışıyor \(bu yükseltmeden bağımsız\):\s*/, '').replace(/\s*Bu çakışma giderilmeden.*$/, '').replace(/\.$/, '');
      plan.skipped.push({
        title: `${folder === '.' ? 'Proje' : folder} npm bağımlılıkları çakışıyor`,
        reason: `AI-${task.number}: projenin mevcut bağımlılıkları zaten birbirini tutmuyor (${cause}). Bu giderilmeden bu klasördeki ${ids.length} npm güvenlik güncellemesi yapılamaz; yeni bir commit/build gelince yeniden denenir. Çözüm: çakışan paketi uyumlu sürüme getirin (örneğin AI'ya "${cause.split(' ')[0]} çakışmasını gider" deyin).`,
        findingIds: ids,
      });
    }
    if (environmentFailure && lastBuild) {
      plan.skipped.push({ title: `Build #${lastBuild.number} ortam nedeniyle başarısız`, reason: environmentFailure, findingIds: [] });
    } else if (lastBuild?.status === 'failed' && buildTried && !openFixes.some((t) => t.autofix?.kind === 'build')) {
      plan.skipped.push({ title: `Build #${lastBuild.number} başarısız`, reason: 'Bu build için AI düzeltmesi bir kez denendi ve sonuç vermedi. Build kaydındaki hatayı inceleyin veya AI\'ya sorun.', findingIds: [] });
    }
    return { org, aiReady, findings, openFixes, lastBuild, plan };
  }

  async plan(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug, 'security.read');
    const { org, plan } = await this.inputs(auth, scope.project.id, scope.project);
    return {
      items: plan.items,
      skipped: plan.skipped,
      autoMergeLowRisk: org.ai.autoFix.autoMergeLowRisk,
      summary: { automatic: plan.items.filter((i) => i.autoMerge).length, approval: plan.items.filter((i) => !i.autoMerge).length, skipped: plan.skipped.length },
    };
  }

  async start(auth: AuthInfo, idOrSlug: string, input: { keys?: string[] }, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'ai.execute');
    const { org, plan } = await this.inputs(auth, scope.project.id, scope.project);
    const chosen = input.keys?.length ? plan.items.filter((i) => input.keys!.includes(i.key)) : plan.items;
    const out = await createAutofixTasks(this.ctx.db, {
      organizationId: auth.organizationId,
      projectId: scope.project.id,
      defaultBranch: scope.project.defaultBranch,
      requestedBy: auth.user.id,
      autonomyLevel: org.ai.autonomyLevel,
      items: chosen,
      actor,
    });
    return { ...out, skipped: plan.skipped };
  }

  /**
   * "Fix everything" from the security center: starts the planned fixes of every project the caller may run AI on.
   * Fixes already queued, running or waiting are left alone, so pressing it again never duplicates work.
   */
  async startAll(auth: AuthInfo, actor: Actor) {
    const rows = await this.ctx.db
      .selectDistinct({ id: projects.id, name: projects.name, slug: projects.slug })
      .from(projects)
      .innerJoin(securityFindings, and(eq(securityFindings.projectId, projects.id), eq(securityFindings.status, 'open')))
      .where(and(eq(projects.organizationId, auth.organizationId), eq(projects.status, 'active')));
    const results: { slug: string; name: string; created: number; skipped: number; error?: string }[] = [];
    for (const p of rows) {
      try {
        const out = await this.start(auth, p.id, {}, actor);
        results.push({ slug: p.slug, name: p.name, created: out.created.length, skipped: out.skipped.length });
      } catch (e) {
        // No access or no AI permission on that project: report it, keep going with the others.
        results.push({ slug: p.slug, name: p.name, created: 0, skipped: 0, error: (e as Error).message });
      }
    }
    return { projects: results, created: results.reduce((n, r) => n + r.created, 0) };
  }

  async list(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug, 'security.read');
    const rows = await this.ctx.db
      .select()
      .from(aiTasks)
      .where(and(eq(aiTasks.projectId, scope.project.id), isNotNull(aiTasks.autofix)))
      .orderBy(desc(aiTasks.createdAt))
      .limit(50);
    return rows.map((t) => ({ id: t.id, key: `AI-${t.number}`, title: t.title, status: t.status, error: t.error, buildId: t.buildId, autofix: t.autofix, createdAt: t.createdAt, completedAt: t.completedAt }));
  }

  /** One click for everything a human may approve: proven fixes (build, tests and re-scan passed) that need a person. */
  async approveVerified(auth: AuthInfo, idOrSlug: string, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'ai.execute');
    const rows = await this.ctx.db
      .select({ id: aiTasks.id })
      .from(aiTasks)
      .where(and(eq(aiTasks.projectId, scope.project.id), eq(aiTasks.status, 'awaiting_approval'), sql`${aiTasks.autofix}->'verdict'->>'status' = 'needs_approval'`));
    const approved: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const r of rows) {
      try {
        await this.aiService.approve(auth, r.id, 'Toplu onay: doğrulanmış otomatik düzeltme', actor);
        approved.push(r.id);
      } catch (e) {
        failed.push({ id: r.id, reason: (e as Error).message });
      }
    }
    return { approved, failed };
  }

  /**
   * Re-runs the verification of a prepared fix (same commit) — e.g. after the build machine was fixed. A new build is
   * started for the AI branch head; the verdict is cleared and recomputed when that build finishes.
   */
  async reverify(auth: AuthInfo, taskId: string, actor: Actor) {
    const t = (await this.ctx.db.select().from(aiTasks).where(and(eq(aiTasks.id, taskId), eq(aiTasks.organizationId, auth.organizationId))))[0];
    if (!t) throw notFound('AI görevi');
    const scope = await this.access.requireWritable(auth, t.projectId, 'ai.execute');
    if (t.status !== 'awaiting_approval' || !t.headCommit || !t.branch) throw precondition('Yalnızca onay bekleyen, hazırlanmış bir düzeltme yeniden doğrulanabilir');
    if (t.buildId) {
      const b = (await this.ctx.db.select({ s: builds.status }).from(builds).where(eq(builds.id, t.buildId)))[0];
      if (b && (b.s === 'queued' || b.s === 'running')) throw precondition('Doğrulama build’i zaten çalışıyor');
    }
    // A model change that built successfully but left the targeted finding in place must be rewritten, not merely
    // run through the identical build and scan again.
    const { git } = await this.repos.forProject(t.projectId);
    if (t.autofix?.mode === 'agent' && t.autofix.verdict?.status === 'failed' && t.autofix.verdict.remaining.length) {
      const note = [
        t.instruction,
        '',
        '## Önceki deneme güvenlik doğrulamasında başarısız oldu',
        `${t.autofix.verdict.remaining.length} hedef bulgu yeniden taramada hâlâ bulundu. Gizli değeri fallback, örnek, yorum veya başka bir dosyada bırakma; kod yalnızca ortam değişkenini kullanmalı.`,
      ].join('\n');
      await this.ctx.db.update(aiTasks).set({ instruction: note.slice(0, 20_000) }).where(eq(aiTasks.id, t.id));
      await reprepareAutofix(this.ctx.db, git, { ...t, instruction: note }, actor, 'Hedef güvenlik bulgusu yeniden taramada hâlâ bulundu');
      await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'ai.task.reverify', resourceType: 'ai_task', resourceId: t.id, metadata: { selfCorrect: true, reason: 'finding_remaining' } });
      return { buildId: null, reprepared: true };
    }
    // Deterministic fixes (package upgrades, file removals) are re-prepared on the current base when it moved, so the
    // verification runs against what would actually be merged; agent fixes keep their reviewed commit.
    const baseHead = await git.resolve(`refs/heads/${t.baseBranch ?? scope.project.defaultBranch}`);
    if (canReprepare(t) && baseHead && baseHead !== t.baseCommit) {
      await reprepareAutofix(this.ctx.db, git, t, actor, 'Yeniden doğrulama: temel branch değişti');
      return { buildId: null, reprepared: true };
    }
    const buildId = await this.ctx.db.transaction(async (tx) => {
      const number = await nextNumber(tx, scope.project.id, 'build');
      const id = (await tx.insert(builds).values({ organizationId: auth.organizationId, projectId: scope.project.id, number, branch: t.branch!, commitSha: t.headCommit!, commitMessage: `AI-${t.number}: yeniden doğrulama`, trigger: 'ai', triggeredByType: 'user', triggeredBy: auth.user.id, createPreview: t.autofix?.kind !== 'docs' }).returning({ id: builds.id }))[0]!.id;
      await enqueue(tx, { queue: QUEUES.build, type: 'build.execute', organizationId: auth.organizationId, projectId: scope.project.id, maxAttempts: 1, payload: { buildId: id } });
      await tx.update(aiTasks).set({ buildId: id, autofix: t.autofix ? { ...t.autofix, verdict: undefined } : t.autofix }).where(eq(aiTasks.id, t.id));
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'ai.task.reverify', resourceType: 'ai_task', resourceId: t.id, metadata: { buildId: id } });
      await publish(tx, { type: 'ai.task.updated', organizationId: auth.organizationId, projectId: scope.project.id, id: t.id });
      return id;
    });
    return { buildId };
  }

  /** Per-project automatic mode: after every scan the worker starts proven-safe (low-risk) fixes by itself. */
  async setAuto(auth: AuthInfo, idOrSlug: string, enabled: boolean, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'ai.execute');
    await this.ctx.db
      .update(projects)
      .set({ settings: sql`jsonb_set(${projects.settings}, '{autoFix}', ${JSON.stringify(enabled)}::jsonb, true)` })
      .where(eq(projects.id, scope.project.id));
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'project.autofix_mode', resourceType: 'project', resourceId: scope.project.id, metadata: { enabled } });
    // Start right away with what is open now instead of waiting for the next scan.
    if (enabled) await enqueue(this.ctx.db, { queue: QUEUES.maintenance, type: 'autofix.auto', projectId: scope.project.id, organizationId: auth.organizationId, dedupeKey: `autofix-auto:${scope.project.id}`, payload: { projectId: scope.project.id } });
    return { enabled };
  }

  /**
   * The project assistant: every open problem and missing setup step in the order to handle them, each with a plain
   * explanation, where it is, and the action that fixes it (or the reason it needs a person).
   */
  async assistant(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug, 'repository.read');
    const p = scope.project;
    const { org, aiReady, findings, openFixes, lastBuild, plan } = await this.inputs(auth, p.id, p);
    const steps: AssistantStep[] = [];
    const settings = p.settings as { executionTrust?: string; autoFix?: boolean; health?: { components?: Record<string, number | null> } };
    const byId = new Map(findings.map((f) => [f.id, f]));
    const view = (ids: string[]): PlanFindingView[] =>
      ids
        .map((id) => byId.get(id))
        .filter((f): f is NonNullable<typeof f> => !!f)
        .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
        .map((f) => ({ id: f.id, number: f.number, type: f.type, ruleId: f.ruleId, severity: f.severity, title: f.title, description: f.description, filePath: f.filePath, line: f.line, packageName: f.packageName, packageVersion: f.packageVersion, fixedVersion: f.fixedVersion, references: f.references, advisoryId: f.advisoryId }));
    const worst = (ids: string[]) => view(ids)[0]?.severity;

    // Setup
    const untrusted = settings.executionTrust === 'untrusted';
    steps.push({
      id: 'trust',
      phase: 'setup',
      title: untrusted ? 'Kaynak kodu güvenilir olarak onaylayın' : 'Kaynak kod güvenilir olarak onaylandı',
      explain: untrusted
        ? 'Proje dışarıdan (ZIP/Git) içe aktarıldı. Build, test ve paket güncellemeleri projenin kendi komutlarını sunucuda çalıştırır; bu yüzden kodu tanıyan biri bir kez onaylamalı. Onaydan sonra build, ön izleme ve otomatik paket düzeltmeleri açılır.'
        : 'Build, test ve otomatik paket güncellemeleri bu projede çalışabilir.',
      status: untrusted ? 'todo' : 'done',
      ...(untrusted && scope.can('project.update') ? { action: { kind: 'trust' as const, label: 'Kodu tanıyorum, güvenilir olarak onayla' } } : {}),
    });
    const lastScan = (await this.ctx.db.select().from(securityScans).where(eq(securityScans.projectId, p.id)).orderBy(desc(securityScans.createdAt)).limit(1))[0];
    if (!lastScan || lastScan.status === 'failed') {
      steps.push({ id: 'scan', phase: 'setup', title: 'Güvenlik taraması yapın', explain: 'Kod, gizli bilgiler, bağımlılık açıkları ve yapılandırma sorunları taranır; bulunan her sorun bu listeye düzeltme yoluyla eklenir.', status: lastScan?.status === 'failed' ? 'blocked' : 'todo', action: { kind: 'scan', label: 'Şimdi tara' } });
    } else if (lastScan.status === 'running' || lastScan.status === 'queued') {
      steps.push({ id: 'scan', phase: 'setup', title: 'Güvenlik taraması sürüyor', explain: 'Tarama bitince bulunan sorunlar burada sırayla listelenir.', status: 'running' });
    }

    // Security and health fixes (planned now) — most severe first.
    const planned = [...plan.items].sort((a, b) => SEVERITY_ORDER.indexOf(worst(a.findingIds) ?? 'info') - SEVERITY_ORDER.indexOf(worst(b.findingIds) ?? 'info'));
    for (const item of planned) {
      const blockedByTrust = untrusted && (item.mode === 'dependency' || item.kind === 'build');
      steps.push({
        id: `fix-${item.key}`,
        phase: item.kind === 'build' || item.kind === 'docs' ? 'quality' : 'security',
        title: item.title,
        explain: EXPLAIN[item.kind],
        status: blockedByTrust ? 'blocked' : 'todo',
        severity: worst(item.findingIds),
        method: item.method,
        risk: item.risk,
        autoMerge: item.autoMerge,
        details: item.details,
        findings: view(item.findingIds),
        ...(blockedByTrust ? { reason: 'Önce 1. adımda kaynak kodu onaylayın; bu düzeltme projenin paket yöneticisini/build’ini çalıştırır.' } : { action: { kind: 'autofix' as const, key: item.key, label: item.autoMerge ? 'AI ile düzelt (doğrulanınca kendiliğinden birleşir)' : 'AI ile düzelt (doğrulandıktan sonra onayınıza gelir)' } }),
      });
    }
    // Fixes already under way.
    for (const t of openFixes) {
      const v = t.autofix?.verdict;
      steps.push({
        id: `task-${t.id}`,
        phase: t.autofix?.kind === 'build' || t.autofix?.kind === 'docs' ? 'quality' : 'security',
        title: t.title,
        explain: EXPLAIN[t.autofix?.kind ?? 'code'],
        status: t.status === 'queued' ? 'queued' : t.status === 'awaiting_approval' ? (v ? (v.status === 'needs_approval' ? 'needs_approval' : 'failed') : 'verifying') : 'running',
        severity: worst(t.autofix?.findingIds ?? []),
        risk: t.autofix?.risk,
        findings: view(t.autofix?.findingIds ?? []),
        task: { id: t.id, key: `AI-${t.number}`, status: t.status, queuedAt: t.updatedAt, startedAt: t.startedAt, verdict: v ?? null, error: t.error },
        action: v?.status === 'failed' && t.headCommit ? { kind: 'reverify', taskId: t.id, label: 'Yeniden doğrula (build + test + tarama)' } : { kind: 'link', href: `/projects/${p.slug}/ai/tasks/${t.id}`, label: 'Değişikliği incele' },
      });
    }
    // What needs a person, with the reason and the way to do it.
    for (const s of plan.skipped) {
      steps.push({
        id: `manual-${s.findingIds[0] ?? s.title}`,
        phase: 'security',
        title: s.title,
        explain: 'Bu adım otomatik yapılamıyor; nedeni ve nasıl yapılacağı aşağıda.',
        status: 'info',
        severity: worst(s.findingIds),
        reason: s.reason,
        findings: view(s.findingIds),
      });
    }

    // Quality and release readiness.
    if (!lastBuild) {
      steps.push({ id: 'build', phase: 'quality', title: 'İlk build’i çalıştırın', explain: 'Build projeyi kurar, derler ve testlerini çalıştırır; başarılı build ön izleme ve yayın için gereklidir.', status: untrusted ? 'blocked' : 'todo', ...(untrusted ? { reason: 'Önce kaynak kodu onaylayın.' } : { action: { kind: 'build' as const, label: 'Build ve ön izleme başlat' } }) });
    } else if (lastBuild.status === 'passed') {
      steps.push({ id: 'build', phase: 'quality', title: `Build #${lastBuild.number} başarılı`, explain: 'Proje kuruluyor, derleniyor ve testleri geçiyor.', status: 'done' });
    }
    // Runtime settings: once .env is out of the repository (or a pending fix removes it), previews and deployments get
    // their configuration only from Secrets — otherwise the app starts without keys and fails at runtime.
    const envNames = (await latestManifest(this.ctx.db, p.id))?.env?.map((e) => e.name) ?? [];
    if (envNames.length) {
      const [{ n }] = await this.ctx.db.select({ n: sql<number>`count(*)::int` }).from(secrets).where(and(eq(secrets.projectId, p.id), inArray(secrets.scope, ['runtime', 'all'])));
      if (!n) {
        const removing = openFixes.some((t) => t.autofix?.files?.delete.some((f) => /(^|\/)\.env$/.test(f)));
        const { git } = await this.repos.forProject(p.id);
        const head = await git.resolve(`refs/heads/${p.defaultBranch}`);
        const committed = !!head && (await git.listFiles(head)).some((f) => f.path === '.env');
        // The values are usually still in history (the .env removed by a fix): offer to take them from there.
        const inHistory = removing || (!committed && !!head && (await git.log({ ref: head, path: '.env', limit: 1 })).length > 0);
        if (removing || !committed) {
          const sample = envNames.slice(0, 6).join(', ') + (envNames.length > 6 ? ' …' : '');
          steps.push({
            id: 'env',
            phase: 'release',
            title: removing ? '.env kaldırılmadan önce çalışma ayarlarını Secret olarak ekleyin' : 'Çalışma ayarlarını (Secret) ekleyin',
            explain: inHistory
              ? `Ön izleme ve yayın ayarları Secret'lardan alır. Repodaki eski .env'in ${envNames.length} değişkeni (${sample}) tek tıkla aktarılır: önce listeyi görürsünüz, onaylayınca şifreli kaydedilir; APP_KEY yenilenir.`
              : `Ön izleme ve yayın ayarları Secret'lardan alır. ${envNames.length} değişken (${sample}) gerekiyor: .env dosyanızı yapıştırın, hepsi tek seferde doğru şekilde eklenir.`,
            status: 'todo',
            ...(scope.can('secret.manage') ? { action: { kind: 'envimport' as const, source: inHistory ? ('history' as const) : ('text' as const), label: inHistory ? 'Eski .env’den otomatik aktar' : '.env yapıştır' } } : {}),
          });
        }
      }
    }
    const preview = (await this.ctx.db.select({ id: previews.id }).from(previews).where(and(eq(previews.projectId, p.id), eq(previews.status, 'ready'))).limit(1))[0];
    if (lastBuild?.status === 'passed' && !preview) {
      steps.push({ id: 'preview', phase: 'release', title: 'Ön izleme açın', explain: 'Ön izleme, uygulamanın çalışan bir kopyasıdır; kullanıcılara link göndermek ve görsel testler için gerekir.', status: 'todo', action: { kind: 'link', href: `/projects/${p.slug}/previews`, label: 'Ön izlemeye git' } });
    }
    const targets = (await this.ctx.db.select({ id: deploymentTargets.id }).from(deploymentTargets).innerJoin(environments, eq(environments.id, deploymentTargets.environmentId)).where(eq(environments.projectId, p.id)).limit(1))[0];
    steps.push({
      id: 'deploy-target',
      phase: 'release',
      title: targets ? 'Yayın hedefi tanımlı' : 'Yayın hedefini tanımlayın',
      explain: 'Uygulamanın yayınlanacağı sunucu (SFTP/SSH/FTP veya sunucu klasörü). Production yayını her zaman insan onayıyla yapılır.',
      status: targets ? 'done' : 'todo',
      ...(targets ? {} : { action: { kind: 'link' as const, href: `/projects/${p.slug}/environments`, label: 'Ortamlara git' } }),
    });

    const actionable = steps.filter((s) => s.status === 'todo' && s.action?.kind === 'autofix').map((s) => (s.action as { key: string }).key);
    return {
      steps,
      summary: {
        total: steps.filter((s) => s.status !== 'info').length,
        done: steps.filter((s) => s.status === 'done').length,
        todo: steps.filter((s) => s.status === 'todo' || s.status === 'blocked').length,
        queued: steps.filter((s) => s.status === 'queued').length,
        inProgress: steps.filter((s) => ['running', 'verifying'].includes(s.status)).length,
        manual: steps.filter((s) => s.status === 'info').length,
      },
      fixAllKeys: actionable,
      autoMode: settings.autoFix ?? true,
      autoMergeLowRisk: org.ai.autoFix.autoMergeLowRisk,
      aiReady,
      canFix: scope.can('ai.execute') && p.status !== 'archived',
    };
  }
}

const EXPLAIN: Record<string, string> = {
  dependency: 'Projenin kullandığı bazı paketlerde bilinen güvenlik açıkları var. Paket yöneticisi bunları açığın kapatıldığı sürüme yükseltir; build ve testler geçer, yeniden taramada açık görünmezse düzeltme tamamlanır.',
  secret: 'Şifre, anahtar veya token gibi gizli bilgiler kodun içinde duruyor; kodu gören herkes bu bilgiyi görebilir. Değer koddan çıkarılır ve sunucu ayarından (ortam değişkeni) okunur. Bilgi Git geçmişinde kaldığı için birleştirmeden sonra şifreyi/anahtarı yenilemeniz gerekir.',
  code: 'Kodda veya yapılandırmada saldırıya açık bir kalıp bulundu. AI ilgili dosyayı davranışı değiştirmeden düzeltir; build, testler ve yeniden tarama düzeltmeyi doğrular.',
  build: 'Son build başarısız: proje kurulamıyor, derlenemiyor veya testleri geçmiyor. AI hata kaydına bakarak düzeltme hazırlar ve aynı build ile doğrular.',
  docs: 'Projede README yok. Yeni gelen biri projenin ne yaptığını, nasıl kurulup çalıştırılacağını bilemez. AI yalnızca dokümantasyon dosyası oluşturur.',
};

/** Build failures caused by the build machine rather than the project's code (an AI code change cannot fix them). */
function environmentProblem(error: { step?: string; message?: string } | null): string | null {
  const msg = `${error?.message ?? ''}`;
  if (/permission denied|access is denied|read-only file system|\bEACCES\b|\bEPERM\b|Dosya erişim hatası/i.test(msg)) return 'Kurulum dosyaya yazamadı veya erişemedi. Dosya izinleri, kilitli dosyalar ve paket yöneticisi kontrol edilmeli; proje kodunu AI ile değiştirmek bu hatayı çözmez.';
  if (/^install \[--prefer-source\]/i.test(msg)) return 'Composer yalnız kullanım bilgisini hata özeti olarak kaydetmiş. Asıl kurulum hatası build logundan belirlenmeli; neden bilinmeden AI kod değişikliği başlatılmaz.';
  // Checkout, manifest and artifact are Project Hub's own steps: a failure there is never fixed by editing code.
  if (/checkout|Manifest|Artifact/i.test(error?.step ?? '') || /unable to authenticate data|gizli değeri çözülemedi|safe\.directory|timed out/i.test(msg)) {
    return `Build, proje kodundan değil Project Hub tarafındaki bir adımdan düştü (${error?.step ?? 'bilinmiyor'}: ${msg.slice(0, 160)}). AI'ya gönderilmedi; build'i yeniden başlatın, sürerse yöneticinize bildirin.`;
  }
  if (/ext-([a-z0-9_]+)\b.*(missing|enable)|requires ext-|PHP's ([a-z0-9]+) extension/i.test(msg)) {
    const ext = /ext-([a-z0-9_]+)/i.exec(msg)?.[1] ?? 'gerekli';
    return `Build makinesindeki PHP'de "${ext}" eklentisi kapalı. Bu proje kodundan değil, sunucu ayarından kaynaklanıyor: php.ini dosyasında extension=${ext} satırını açın (Docker kurulumunda worker imajına ekleyin), sonra build'i yeniden başlatın.`;
  }
  if (/COMPOSER_HOME|APPDATA or COMPOSER_HOME/i.test(msg)) return 'Composer çalışma dizini tanımlı değil (sunucu ayarı). Worker güncellendikten sonra build’i yeniden başlatın.';
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|getaddrinfo|network|Could not resolve host|SSL|curl error (?:5|6|7|28|35|60)\b/i.test(msg)) return 'Paket kaynağına (npm/Packagist) ulaşılamadı: ağ veya proxy sorunu. Bağlantı düzelince build’i yeniden başlatın.';
  if (/command not found|is not recognized as an internal or external command|ENOENT.*spawn/i.test(msg)) return `Build makinesinde gerekli bir araç kurulu değil: ${msg.slice(0, 160)}`;
  return null;
}

function failureReason(t: typeof aiTasks.$inferSelect): string {
  const v = t.autofix?.verdict;
  if (v?.reasons?.length) return `${v.reasons[0]}.`.replace(/\.\.$/, '.');
  return `${(t.error ?? 'bilinmeyen hata').slice(0, 220)}`.replace(/([^.])$/, '$1.');
}

/** The upgrade failed on a conflict the project already had (worker: describeNpmConflict). */
function preExistingConflict(t: typeof aiTasks.$inferSelect): boolean {
  return t.status === 'failed' && t.autofix?.mode === 'dependency' && (t.error ?? '').includes(PRE_EXISTING_CONFLICT);
}

/** A package upgrade the package manager could not resolve against the project's other dependencies. */
function unresolvableUpgrade(t: typeof aiTasks.$inferSelect): boolean {
  return t.autofix?.mode === 'dependency' && /sürüm kısıtı yükseltildikten sonra çözemedi|kilit dosyasını güncelleyemedi|lock dosyasını güncelleyemedi|Conclusion: don't install|ERESOLVE|could not be resolved/i.test(t.error ?? '');
}

/** Failures caused by the environment of the attempt (restart, timeout, provider hiccup), not by the fix itself. */
function transientFailure(error: string | null): boolean {
  return (
    !!error &&
    /worker yeniden başladığı|timeout|zaman aşımı|aborted|sağlayıcısı hatası|ECONNRESET|ECONNREFUSED|token repeat limit|[İi]lgili bulgular yeni güvenlik taramasında kapandığı/i.test(error)
  );
}
