import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { FindingType } from '@projecthub/contracts';
import { addEvidence, audit, emitDomainEvent, enqueue, ensureWorkflowStep, nextNumber, publish, QUEUES, recordVerification, scan, setWorkflowStatus, setWorkflowStepStatus, sha256, startWorkflow, SYSTEM_ACTOR, timeline, type JobContext, type Logger } from '@projecthub/core';
import { aiTasks, projectManifests, projects, securityFindings, securityScans, workflowSteps } from '@projecthub/database';
import { commitSnapshot, loadProject, openRepo, type WorkerCtx } from '../context.js';

export interface ScanPayload {
  projectId: string;
  scanId?: string;
  branch?: string;
  commitSha?: string;
  buildId?: string;
  trigger?: string;
  requestedBy?: string;
}

export async function securityScan(ctx: WorkerCtx, { job, logger }: JobContext) {
  return runSecurityScan(ctx, job.payload as unknown as ScanPayload, logger);
}

/** Scans one commit and reconciles findings. Used by the scan job and by the build pipeline's security step. */
export async function runSecurityScan(ctx: WorkerCtx, p: ScanPayload, logger: Logger) {
  const project = await loadProject(ctx, p.projectId);
  const { git } = await openRepo(ctx, p.projectId);
  const branch = p.branch ?? project.defaultBranch;
  const canonical = branch === project.defaultBranch;
  const commit = p.commitSha ?? (await git.resolve(`refs/heads/${branch}`));
  const db = ctx.db;
  let scanId = p.scanId;
  if (!scanId) {
    scanId = (
      await db
        .insert(securityScans)
        .values({ organizationId: project.organizationId, projectId: project.id, buildId: p.buildId ?? null, branch, commitSha: commit, status: 'running', startedAt: new Date(), createdBy: p.requestedBy ?? null })
        .returning({ id: securityScans.id })
    )[0]!.id;
  } else {
    await db.update(securityScans).set({ status: 'running', startedAt: new Date(), commitSha: commit, branch }).where(eq(securityScans.id, scanId));
  }
  const workflow = await startWorkflow(db, {
    organizationId: project.organizationId,
    projectId: project.id,
    definitionKey: 'security.scan',
    definitionVersion: 1,
    title: `${project.name} güvenlik taraması`,
    triggerType: 'security_scan',
    triggerRef: scanId,
    baseRevision: commit,
    riskLevel: 'medium',
    requestedByType: p.requestedBy ? 'user' : 'system',
    requestedBy: p.requestedBy ?? null,
    idempotencyKey: `security-scan:${scanId}`,
    context: { scanId, branch, buildId: p.buildId ?? null, trigger: p.trigger ?? 'job' },
  });
  const sourceStep = await ensureWorkflowStep(db, { workflowRunId: workflow.id, key: 'source', name: 'Kaynak revizyonunu doğrula', seq: 0 });
  const scannersStep = await ensureWorkflowStep(db, { workflowRunId: workflow.id, key: 'scanners', name: 'Güvenlik tarayıcılarını çalıştır', seq: 1 });
  const reconcileStep = await ensureWorkflowStep(db, { workflowRunId: workflow.id, key: 'reconcile', name: 'Bulguları uzlaştır', seq: 2 });
  await setWorkflowStatus(db, workflow.id, 'running', { phase: 'source', error: null });
  await publish(db, { type: 'security.scan', organizationId: project.organizationId, projectId: project.id, id: scanId });
  if (!commit) {
    await db.update(securityScans).set({ status: 'failed', error: 'Repository boş', finishedAt: new Date() }).where(eq(securityScans.id, scanId));
    await setWorkflowStepStatus(db, sourceStep.id, 'failed', { error: 'Repository boş' });
    await setWorkflowStatus(db, workflow.id, 'failed', { phase: 'source', error: 'Repository boş' });
    return { skipped: 'empty' };
  }

  try {
    await setWorkflowStepStatus(db, sourceStep.id, 'running');
    const sourceEvidence = await addEvidence(db, {
      organizationId: project.organizationId,
      projectId: project.id,
      workflowRunId: workflow.id,
      workflowStepId: sourceStep.id,
      kind: 'source_revision',
      subjectType: 'security_scan',
      subjectId: scanId,
      sourceType: 'git',
      sourceRef: branch,
      revision: commit,
      result: { branch, commit },
    });
    await setWorkflowStepStatus(db, sourceStep.id, 'passed', { output: { branch, commit }, checkpoint: { immutableRevision: commit } });
    await recordVerification(db, { organizationId: project.organizationId, projectId: project.id, workflowRunId: workflow.id, workflowStepId: sourceStep.id, key: 'source:revision', status: 'passed', summary: `${branch} revizyonu sabitlendi`, expected: { revision: commit }, observed: { revision: commit }, evidenceIds: [sourceEvidence.id] });
    await setWorkflowStatus(db, workflow.id, 'running', { phase: 'scanners' });
    await setWorkflowStepStatus(db, scannersStep.id, 'running');
    const manifest = (await db.select({ content: projectManifests.content }).from(projectManifests).where(eq(projectManifests.projectId, project.id)).orderBy(desc(projectManifests.version)).limit(1))[0]?.content;
    const opts = { secretScan: manifest?.security.secretScan ?? true, dependencyScan: manifest?.security.dependencyScan ?? true };
    const snap = await commitSnapshot(git, commit);
    await snap.preload(snap.entries.filter((f) => scan.isScannable(f.path, f.size) || /(^|\/)(Dockerfile[^/]*|\.gitignore|\.env(\.[a-z]+)?)$/i.test(f.path)).map((f) => f.path));
    const result = await scan.scanRepository(snap, {
      ...opts,
      osvUrl: ctx.config.OSV_API_URL,
      registries: { npm: ctx.config.NPM_REGISTRY_URL, pypi: ctx.config.PYPI_URL, packagist: ctx.config.PACKAGIST_URL },
    });
    // Secrets anywhere in the Git history (Gitleaks). A whole-history pass is not repeated for every build.
    let historyScanned = false;
    if (opts.secretScan && p.trigger !== 'build') {
      const leaks = await scan.runGitleaks({ binary: scan.resolveTool('gitleaks', ctx.config.toolsDir), repoDir: git.dir, commit });
      result.notes.push(leaks.message);
      if (leaks.status === 'ran') {
        historyScanned = true;
        result.findings.push(...(await historyFindings(git, commit, leaks.results, result.findings)));
      } else logger.warn({ projectId: project.id, status: leaks.status }, leaks.message);
    }
    const dependencyCovered = opts.dependencyScan && !result.notes.some((n) => n.includes('ulaşılamadı') || n.includes('kapalı'));
    const historyExpected = opts.secretScan && p.trigger !== 'build';
    const coverageComplete = (!opts.dependencyScan || dependencyCovered) && (!historyExpected || historyScanned);
    const covered: FindingType[] = ['code', 'config', ...(opts.secretScan ? (['secret'] as const) : []), ...(dependencyCovered ? (['dependency'] as const) : [])];

    const scannerEvidence = await addEvidence(db, {
      organizationId: project.organizationId,
      projectId: project.id,
      workflowRunId: workflow.id,
      workflowStepId: scannersStep.id,
      kind: 'scanner_coverage',
      subjectType: 'security_scan',
      subjectId: scanId,
      sourceType: 'security_scanners',
      sourceRef: commit,
      revision: commit,
      result: {
        filesScanned: result.filesScanned,
        packagesScanned: result.packagesScanned,
        findingCount: result.findings.length,
        codeAndConfig: true,
        currentSecrets: opts.secretScan,
        historySecrets: historyScanned,
        dependencies: dependencyCovered,
        notes: result.notes,
      },
    });
    await setWorkflowStepStatus(db, scannersStep.id, coverageComplete ? 'passed' : 'unknown', { output: { filesScanned: result.filesScanned, packagesScanned: result.packagesScanned, findingCount: result.findings.length, coverageComplete } });
    await recordVerification(db, {
      organizationId: project.organizationId,
      projectId: project.id,
      workflowRunId: workflow.id,
      workflowStepId: scannersStep.id,
      key: 'security:coverage',
      status: coverageComplete ? 'passed' : 'inconclusive',
      summary: coverageComplete ? 'Etkin güvenlik tarayıcıları kapsamı tamamladı' : 'Bir veya daha fazla etkin tarayıcının kapsamı doğrulanamadı',
      expected: { dependencyScan: opts.dependencyScan, secretScan: opts.secretScan, historyScan: historyExpected },
      observed: { dependencyScan: dependencyCovered, currentSecretScan: opts.secretScan, historyScan: historyScanned },
      evidenceIds: [scannerEvidence.id],
    });
    await setWorkflowStatus(db, workflow.id, 'running', { phase: 'reconcile' });
    await setWorkflowStepStatus(db, reconcileStep.id, 'running');

    const now = new Date();
    const newCritical: string[] = [];
    await db.transaction(async (tx) => {
      // A feature/AI branch scan is evidence for that immutable revision, not the project's canonical risk state.
      // Reconciling it globally used to close findings on main and could make a still-vulnerable AI change look safe.
      const existing = canonical ? await tx.select().from(securityFindings).where(eq(securityFindings.projectId, project.id)) : [];
      const byFp = new Map(existing.map((f) => [f.fingerprint, f]));
      for (const f of canonical ? result.findings : []) {
        const prev = byFp.get(f.fingerprint);
        const fields = {
          severity: f.severity,
          type: f.type,
          ruleId: f.ruleId,
          title: f.title.slice(0, 300),
          description: f.description,
          filePath: f.filePath ?? null,
          line: f.line ?? null,
          packageName: f.packageName ?? null,
          packageVersion: f.packageVersion ?? null,
          fixedVersion: f.fixedVersion ?? null,
          advisoryId: f.advisoryId ?? null,
          references: f.references ?? [],
          lastScanId: scanId!,
          lastSeenAt: now,
        };
        if (prev) {
          const reopen = prev.status === 'resolved';
          await tx
            .update(securityFindings)
            .set({ ...fields, ...(reopen ? { status: 'open' as const, resolvedAt: null } : {}) })
            .where(eq(securityFindings.id, prev.id));
        } else {
          const number = await nextNumber(tx, project.organizationId, 'finding');
          await tx.insert(securityFindings).values({ ...fields, organizationId: project.organizationId, projectId: project.id, number, fingerprint: f.fingerprint, firstSeenAt: now });
          if (f.severity === 'critical') newCritical.push(`SEC-${number} ${f.title}`);
        }
      }
      // Findings that disappeared from a scanner that actually ran are resolved automatically.
      const seen = result.findings.map((f) => f.fingerprint);
      if (canonical) {
        await tx
          .update(securityFindings)
          .set({ status: 'resolved', resolvedAt: now })
          .where(
            and(
              eq(securityFindings.projectId, project.id),
              eq(securityFindings.status, 'open'),
              inArray(securityFindings.type, covered),
              seen.length ? notInArray(securityFindings.fingerprint, seen) : sql`true`,
              // History findings only disappear when the history scan really ran (not on build scans or a missing tool).
              historyScanned ? sql`true` : sql`${securityFindings.ruleId} NOT LIKE 'gitleaks:%'`,
            ),
          );
      }
      const open = canonical
        ? await tx
            .select({ severity: securityFindings.severity, type: securityFindings.type, packageName: securityFindings.packageName, filePath: securityFindings.filePath })
            .from(securityFindings)
            .where(and(eq(securityFindings.projectId, project.id), eq(securityFindings.status, 'open')))
        : result.findings.map((f) => ({ severity: f.severity, type: f.type, packageName: f.packageName ?? null, filePath: f.filePath ?? null }));
      if (canonical) {
        // Another branch may have fixed the same issue first. Do not leave an obsolete, now-dangerous proposal
        // looking "verified" and mergeable after its target findings disappeared from the default branch.
        const openFindingIds = new Set(
          (
            await tx
              .select({ id: securityFindings.id })
              .from(securityFindings)
              .where(and(eq(securityFindings.projectId, project.id), eq(securityFindings.status, 'open')))
          ).map((f) => f.id),
        );
        const prepared = await tx
          .select({ id: aiTasks.id, autofix: aiTasks.autofix })
          .from(aiTasks)
          .where(and(eq(aiTasks.projectId, project.id), eq(aiTasks.status, 'awaiting_approval')));
        for (const task of prepared) {
          const ids = task.autofix?.findingIds ?? [];
          if (ids.length && ids.every((id) => !openFindingIds.has(id))) {
            await tx
              .update(aiTasks)
              .set({ status: 'cancelled', error: 'İlgili bulgular varsayılan branch üzerinde başka bir değişiklikle kapandı; eski öneri birleştirilmedi.', completedAt: now })
              .where(eq(aiTasks.id, task.id));
            await publish(tx, { type: 'ai.task.updated', organizationId: project.organizationId, projectId: project.id, id: task.id });
          }
        }
      }
      const { score, breakdown } = scan.securityScore(open);
      const tally = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
      const byType: Record<string, number> = {};
      for (const f of open) {
        tally[f.severity]++;
        byType[f.type] = (byType[f.type] ?? 0) + 1;
      }
      await tx
        .update(securityScans)
        .set({
          status: 'completed',
          score,
          finishedAt: new Date(),
          summary: { ...tally, byType, packagesScanned: result.packagesScanned, filesScanned: result.filesScanned, breakdown, notes: result.notes },
        })
        .where(eq(securityScans.id, scanId!));
      const dependencyInventory = result.dependencies.filter((item) => item.direct).slice(0, 1000);
      if (canonical) {
        await tx
          .update(projects)
          .set({ securityScore: score, settings: sql`jsonb_set(${projects.settings}, '{dependencyInventory}', ${JSON.stringify(dependencyInventory)}::jsonb, true)` })
          .where(eq(projects.id, project.id));
      }
      await setWorkflowStepStatus(tx, reconcileStep.id, 'passed', { output: { score, openFindings: open.length, ...tally } });
      await recordVerification(tx, {
        organizationId: project.organizationId,
        projectId: project.id,
        workflowRunId: workflow.id,
        workflowStepId: reconcileStep.id,
        key: 'security:reconciliation',
        status: 'passed',
        summary: `${open.length} açık bulgu immutable revizyonla uzlaştırıldı`,
        expected: { revision: commit },
        observed: { revision: commit, score, openFindings: open.length },
      });
      await setWorkflowStatus(tx, workflow.id, coverageComplete ? 'succeeded' : 'partially_completed', { phase: 'completed', error: coverageComplete ? null : 'Tarayıcı kapsamı kısmi; ayrıntılar doğrulama kaydında' });
      await audit(tx, { organizationId: project.organizationId, projectId: project.id, actor: SYSTEM_ACTOR, action: 'security.scan_completed', resourceType: 'security_scan', resourceId: scanId!, metadata: { score, ...tally } });
      await timeline(tx, {
        organizationId: project.organizationId,
        projectId: project.id,
        kind: 'security',
        tone: tally.critical ? 'bad' : tally.high ? 'warn' : 'ok',
        title: `Güvenlik taraması tamamlandı · skor ${score}/100`,
        description: `${tally.critical} kritik, ${tally.high} yüksek, ${tally.medium} orta · ${result.filesScanned} dosya, ${result.packagesScanned} paket`,
        refType: 'security_scan',
        refId: scanId!,
      });
      for (const c of canonical ? newCritical : []) {
        await emitDomainEvent(tx, { event: 'security.finding.critical', organizationId: project.organizationId, projectId: project.id, data: { title: c, projectName: project.name } });
      }
      if (canonical) await enqueue(tx, { queue: QUEUES.maintenance, type: 'project.health', projectId: project.id, organizationId: project.organizationId, dedupeKey: `health:${project.id}`, payload: { projectId: project.id } });
      // Automatic mode: after a scan of the default branch, start the proven-safe fixes (after the health update).
      if (branch === project.defaultBranch) await enqueue(tx, { queue: QUEUES.maintenance, type: 'autofix.auto', projectId: project.id, organizationId: project.organizationId, dedupeKey: `autofix-auto:${project.id}`, runAt: new Date(Date.now() + 15_000), payload: { projectId: project.id } });
      await publish(tx, { type: 'security.scan', organizationId: project.organizationId, projectId: project.id, id: scanId });
    });
    logger.info({ projectId: project.id, findings: result.findings.length }, 'security scan completed');
    const summary = (await db.select({ summary: securityScans.summary, score: securityScans.score }).from(securityScans).where(eq(securityScans.id, scanId)))[0];
    return { scanId, findings: result.findings.length, score: summary?.score ?? null, summary: summary?.summary ?? null, criticalFingerprints: result.findings.filter((f) => f.severity === 'critical').map((f) => f.fingerprint) };
  } catch (e) {
    const error = (e as Error).message.slice(0, 2000);
    await db.transaction(async (tx) => {
      await tx.update(securityScans).set({ status: 'failed', error: error.slice(0, 1000), finishedAt: new Date() }).where(eq(securityScans.id, scanId));
      await tx.update(workflowSteps).set({ status: 'failed', error, finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(workflowSteps.workflowRunId, workflow.id), eq(workflowSteps.status, 'running')));
      await tx.update(workflowSteps).set({ status: 'skipped', error: 'Önceki adım başarısız oldu', finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(workflowSteps.workflowRunId, workflow.id), eq(workflowSteps.status, 'pending')));
      await setWorkflowStatus(tx, workflow.id, 'failed', { phase: 'failed', error });
    });
    await publish(db, { type: 'security.scan', organizationId: project.organizationId, projectId: project.id, id: scanId });
    throw e;
  }
}

type RepoGit = Awaited<ReturnType<typeof openRepo>>['git'];

/** Turkish names for the most common Gitleaks rules; others show the provider from the rule id. */
const LEAK_NAMES: [RegExp, string][] = [
  [/^generic-api-key$/, 'API anahtarı'],
  [/^private-key$/, 'özel anahtar (private key)'],
  [/^jwt/, 'JWT token'],
  [/^github-/, 'GitHub token'],
  [/^gitlab-/, 'GitLab token'],
  [/^aws-/, 'AWS erişim anahtarı'],
  [/^gcp-|^google/, 'Google Cloud anahtarı'],
  [/^azure/, 'Azure anahtarı'],
  [/^openai/, 'OpenAI API anahtarı'],
  [/^anthropic/, 'Anthropic API anahtarı'],
  [/^slack-/, 'Slack token'],
  [/^stripe-/, 'Stripe anahtarı'],
  [/^(sendgrid|mailgun|mailchimp)/, 'e-posta servisi anahtarı'],
  [/^(twilio|telegram|discord)/, 'mesajlaşma servisi token\'ı'],
];
const leakName = (ruleId: string) => LEAK_NAMES.find(([re]) => re.test(ruleId))?.[1] ?? `${ruleId.split('-').slice(0, -1).join(' ') || ruleId} anahtarı`;

/**
 * Gitleaks reports where a secret was committed. A secret still in the scanned commit is a current, critical finding
 * (unless the built-in scanner already reported that line); one that only lives in history is high: deleting the
 * file does not un-leak it, the credential must be revoked. Secret values are never read into findings.
 */
async function historyFindings(git: RepoGit, commit: string, leaks: scan.GitleaksLeak[], current: { type: string; filePath?: string; line?: number }[]) {
  const out: (scan.RawFinding & { fingerprint: string })[] = [];
  const lineAt = async (rev: string, file: string, line: number) => {
    const f = await git.readFile(rev, file, 2 * 1024 * 1024).catch(() => null);
    return f ? (f.content.toString('utf8').split(/\r?\n/)[line - 1] ?? '') : null;
  };
  for (const leak of leaks) {
    const text = (await lineAt(leak.commit, leak.file, leak.line))?.trim() ?? '';
    const head = await git.readFile(commit, leak.file, 2 * 1024 * 1024).catch(() => null);
    const headLine = text && head ? head.content.toString('utf8').split(/\r?\n/).findIndex((l) => l.trim() === text) + 1 : 0;
    if (headLine && current.some((f) => f.type === 'secret' && f.filePath === leak.file && f.line === headLine)) continue;
    const ruleId = `gitleaks:${leak.ruleId}`;
    const identity = `${leak.file}|${sha256(text || `${leak.commit}:${leak.line}`)}`;
    const when = `${leak.commit.slice(0, 7)} commit'i (${leak.date.slice(0, 10)}${leak.author ? `, ${leak.author}` : ''})`;
    out.push({
      type: 'secret',
      severity: headLine ? 'critical' : 'high',
      ruleId,
      title: headLine ? `Kodda açık ${leakName(leak.ruleId)}` : `Git geçmişinde açık ${leakName(leak.ruleId)}`,
      description: headLine
        ? `${leak.file} dosyasında bir ${leakName(leak.ruleId)} bulunuyor (ilk kez ${when}). Değeri koddan çıkarıp gizli bilgilere taşıyın ve anahtarı sağlayıcıda yenileyin. Gitleaks: ${leak.description}`
        : `${leak.file} dosyası güncel kodda bu değeri içermiyor, ancak ${when} Git geçmişinde duruyor. Repoya erişen herkes görebilir: anahtarı sağlayıcıda iptal edip yenileyin; gerekirse geçmişi temizleyin. Gitleaks: ${leak.description}`,
      filePath: leak.file,
      ...(headLine ? { line: headLine } : {}),
      references: ['https://github.com/gitleaks/gitleaks'],
      identity,
      fingerprint: sha256(`${ruleId}|${identity}`),
    });
  }
  return out;
}
