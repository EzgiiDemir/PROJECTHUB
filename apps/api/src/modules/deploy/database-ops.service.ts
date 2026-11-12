import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Manifest } from '@projecthub/contracts';
import {
  audit,
  deploymentWindowDecision,
  enqueue,
  forbidden,
  missingRequiredEnv,
  notFound,
  policyDenied,
  precondition,
  publish,
  QUEUES,
  resolveEnvSecrets,
  sha256,
  startWorkflow,
  setWorkflowStatus,
  addEvidence,
  recordVerification,
  timeline,
  type Actor,
} from '@projecthub/core';
import {
  artifacts,
  backupRestores,
  backups,
  builds,
  databaseConnections,
  deploymentTargets,
  environments,
  featureFlags,
  migrationRuns,
  projectMigrations,
  securityFindings,
  secrets as storedSecrets,
  users,
  versions,
  workflowRuns,
  workflowSteps,
} from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess, type ProjectScope } from '../../infra/project-access.js';
import { Repos } from '../../infra/repos.js';

type CheckStatus = 'ok' | 'warn' | 'block';
const MANIFEST_SECTIONS = ['runtime', 'install', 'build', 'start', 'health', 'database', 'deploy', 'env', 'preview', 'smoke'] as const;
const trDate = (d: Date) => d.toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Database safety around releases (spec §49–53): what an update will change before it runs, which migrations
 * each environment has, and verified, restorable backups.
 */
@Injectable()
export class DatabaseOpsService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
    private readonly repos: Repos,
  ) {}

  private async env(scope: ProjectScope, environmentId: string) {
    const env = (await this.ctx.db.select().from(environments).where(and(eq(environments.id, environmentId), eq(environments.projectId, scope.project.id))))[0];
    if (!env) throw notFound('Ortam');
    return env;
  }

  /**
   * Migrations brought by versions up to `upToVersionId` (inclusive), with where they are applied.
   * Compared in SQL: timestamps carry microseconds that a JS Date would truncate.
   */
  private async migrationsUpTo(projectId: string, upToVersionId: string | null) {
    const conds = [eq(projectMigrations.projectId, projectId)];
    if (upToVersionId) conds.push(sql`${versions.createdAt} <= (select v2.created_at from versions v2 where v2.id = ${upToVersionId})`);
    const rows = await this.ctx.db
      .select({ m: projectMigrations, version: versions.version })
      .from(projectMigrations)
      .innerJoin(versions, eq(versions.id, projectMigrations.firstVersionId))
      .where(and(...conds))
      .orderBy(projectMigrations.path);
    const runs = rows.length ? await this.ctx.db.select().from(migrationRuns).where(inArray(migrationRuns.migrationId, rows.map((r) => r.m.id))) : [];
    return rows.map((r) => ({ ...r.m, version: r.version, appliedIn: runs.filter((x) => x.migrationId === r.m.id) }));
  }

  /** Per environment: connection, deployed version, applied/pending migrations, last backup (spec §51). */
  async overview(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const envs = await this.ctx.db.select().from(environments).where(eq(environments.projectId, scope.project.id));
    const latest = (await this.ctx.db.select().from(versions).where(eq(versions.projectId, scope.project.id)).orderBy(desc(versions.createdAt)).limit(1))[0] ?? null;
    const all = await this.migrationsUpTo(scope.project.id, latest?.id ?? null);
    const out = [];
    for (const env of envs) {
      const conn = (await this.ctx.db.select().from(databaseConnections).where(eq(databaseConnections.environmentId, env.id)))[0];
      const current = env.currentVersionId ? (await this.ctx.db.select().from(versions).where(eq(versions.id, env.currentVersionId)))[0] : null;
      const lastBackup = (await this.ctx.db.select().from(backups).where(and(eq(backups.environmentId, env.id), eq(backups.status, 'completed'))).orderBy(desc(backups.createdAt)).limit(1))[0] ?? null;
      const applied = all.filter((m) => m.appliedIn.some((r) => r.environmentId === env.id));
      out.push({
        environment: { id: env.id, name: env.name, type: env.type },
        connection: conn ? { host: conn.host, port: conn.port, databaseName: conn.databaseName, lastCheckOk: conn.lastCheckOk, lastCheckedAt: conn.lastCheckedAt, lastCheckMessage: conn.lastCheckMessage } : null,
        currentVersion: current?.version ?? null,
        appliedCount: applied.length,
        pending: all.filter((m) => !m.appliedIn.some((r) => r.environmentId === env.id)).map((m) => ({ id: m.id, path: m.path, name: m.name, riskLevel: m.riskLevel, version: m.version })),
        lastBackup: lastBackup ? { id: lastBackup.id, createdAt: lastBackup.createdAt, sizeBytes: lastBackup.sizeBytes, verifiedAt: lastBackup.verifiedAt } : null,
      });
    }
    return { latestVersion: latest?.version ?? null, environments: out };
  }

  async migrations(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const envs = await this.ctx.db.select({ id: environments.id, name: environments.name }).from(environments).where(eq(environments.projectId, scope.project.id));
    const rows = await this.migrationsUpTo(scope.project.id, null);
    return rows.map((m) => ({
      id: m.id,
      path: m.path,
      name: m.name,
      riskLevel: m.riskLevel,
      operations: m.operations,
      version: m.version,
      detectedAt: m.detectedAt,
      environments: envs.map((e) => ({ id: e.id, name: e.name, appliedAt: m.appliedIn.find((r) => r.environmentId === e.id)?.appliedAt ?? null })),
    }));
  }

  /** "Update analysis" shown before a deployment (spec §49): everything that will change and what could block it. */
  async preflight(auth: AuthInfo, idOrSlug: string, environmentId: string, versionId: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const env = await this.env(scope, environmentId);
    const target = (await this.ctx.db.select().from(versions).where(and(eq(versions.id, versionId), eq(versions.projectId, scope.project.id))))[0];
    if (!target) throw notFound('Versiyon');
    const current = env.currentVersionId ? ((await this.ctx.db.select().from(versions).where(eq(versions.id, env.currentVersionId)))[0] ?? null) : null;
    const targetBuild = (await this.ctx.db.select().from(builds).where(eq(builds.id, target.buildId)))[0];
    const currentBuild = current ? (await this.ctx.db.select().from(builds).where(eq(builds.id, current.buildId)))[0] : null;
    const manifest = (targetBuild?.manifest ?? null) as Manifest | null;
    const checks: { key: string; status: CheckStatus; label: string; detail: string }[] = [];
    const add = (key: string, status: CheckStatus, label: string, detail = '') => checks.push({ key, status, label, detail });

    const art = targetBuild?.artifactId ? (await this.ctx.db.select().from(artifacts).where(eq(artifacts.id, targetBuild.artifactId)))[0] : null;
    if (art && (await this.ctx.storage.exists(art.storageKey))) add('source', 'ok', 'Paket hazır', `Build #${targetBuild!.number} artifact'ı mevcut`);
    else add('source', 'block', 'Paket yok', 'Versiyonun build çıktısı bulunamadı');

    const tgt = (await this.ctx.db.select().from(deploymentTargets).where(eq(deploymentTargets.environmentId, env.id)))[0];
    add('target', tgt ? 'ok' : 'block', tgt ? 'Yayın hedefi tanımlı' : 'Yayın hedefi tanımlı değil', tgt ? tgt.adapter.toUpperCase() : 'Ortamlar ekranından hedef ekleyin');

    const conn = (await this.ctx.db.select().from(databaseConnections).where(eq(databaseConnections.environmentId, env.id)))[0];
    if (!conn) add('database', manifest?.database.type && manifest.database.type !== 'none' ? 'warn' : 'ok', 'Veritabanı bağlantısı tanımlı değil', 'Yedek alınamaz; migration için DATABASE_URL secret\'ı gerekir');
    else if (conn.lastCheckOk === false) add('database', 'warn', 'Veritabanına son kontrolde ulaşılamadı', conn.lastCheckMessage ?? '');
    else add('database', 'ok', 'Veritabanı bağlantısı hazır', `${conn.host}/${conn.databaseName}`);
    const lastBackup = (await this.ctx.db.select().from(backups).where(and(eq(backups.environmentId, env.id), eq(backups.status, 'completed'))).orderBy(desc(backups.createdAt)).limit(1))[0];
    if (conn) add('backup', 'ok', 'Yedek alınacak', lastBackup ? `Son yedek ${trDate(lastBackup.createdAt)}${lastBackup.verifiedAt ? ' (doğrulandı)' : ''}` : 'Bu ortamın ilk yedeği olacak');

    const all = await this.migrationsUpTo(scope.project.id, target.id);
    const pending = all.filter((m) => !m.appliedIn.some((r) => r.environmentId === env.id));
    const modified: string[] = [];
    const { git } = await this.repos.forProject(scope.project.id);
    for (const m of all) {
      const f = await git.readFile(target.commitSha, m.path, 2 * 1024 * 1024);
      if (f && sha256(f.content) !== m.checksum) modified.push(m.name);
    }
    if (pending.length) {
      const high = pending.filter((m) => m.riskLevel === 'high').length;
      add('migrations', high ? 'warn' : 'ok', `${pending.length} migration uygulanacak`, `${high ? `${high} yüksek riskli (veri kaybı olabilir). ` : ''}${manifest?.database.migrate?.command ? '' : 'Manifestte migrate komutu yok; elle uygulanmalı.'}`);
    } else add('migrations', 'ok', 'Bekleyen migration yok');
    if (modified.length) add('migrations-modified', 'warn', 'Kaydedildikten sonra değiştirilmiş migration', modified.join(', '));

    const configChanges = currentBuild?.manifest && manifest ? MANIFEST_SECTIONS.filter((k) => JSON.stringify((currentBuild.manifest as Manifest)[k] ?? null) !== JSON.stringify(manifest[k] ?? null)) : [];
    add('config', configChanges.length ? 'warn' : 'ok', configChanges.length ? `${configChanges.length} yapılandırma değişikliği` : 'Yapılandırma değişikliği yok', configChanges.join(', '));

    const secretMetadata = await this.ctx.db
      .select({ name: storedSecrets.name, expiresAt: storedSecrets.expiresAt, interval: storedSecrets.rotationIntervalDays, rotatedAt: storedSecrets.rotatedAt, createdAt: storedSecrets.createdAt })
      .from(storedSecrets)
      .where(and(eq(storedSecrets.projectId, scope.project.id), isNull(storedSecrets.system), eq(storedSecrets.kind, 'env'), inArray(storedSecrets.scope, ['runtime', 'deploy', 'all']), or(isNull(storedSecrets.environmentId), eq(storedSecrets.environmentId, env.id))));
    const now = Date.now();
    const expiredSecrets = secretMetadata.filter((s) => s.expiresAt && s.expiresAt.getTime() <= now);
    const rotationDue = secretMetadata.filter((s) => s.interval > 0 && (s.rotatedAt ?? s.createdAt).getTime() + s.interval * 86_400_000 <= now);
    if (expiredSecrets.length) add('secrets-lifecycle', env.type === 'production' ? 'block' : 'warn', `${expiredSecrets.length} secret'ın süresi dolmuş`, expiredSecrets.map((s) => s.name).join(', '));
    else if (rotationDue.length) add('secrets-lifecycle', 'warn', `${rotationDue.length} secret rotasyon bekliyor`, rotationDue.map((s) => s.name).join(', '));
    else add('secrets-lifecycle', 'ok', 'Secret yaşam döngüsü güncel');

    const secrets = await resolveEnvSecrets(this.ctx.db, this.ctx.config.encryptionKey, { organizationId: auth.organizationId, projectId: scope.project.id, environmentId: env.id, scope: 'runtime' });
    const missing = missingRequiredEnv(manifest, secrets);
    if (missing.length) add('env', 'warn', 'Zorunlu ortam değişkeni eksik', missing.join(', '));

    if (env.type === 'production') {
      const crit = (await this.ctx.db.select({ n: count() }).from(securityFindings).where(and(eq(securityFindings.projectId, scope.project.id), eq(securityFindings.status, 'open'), eq(securityFindings.severity, 'critical'))))[0]?.n ?? 0;
      add('security', crit ? 'block' : 'ok', crit ? `${crit} açık kritik güvenlik bulgusu` : 'Kritik güvenlik bulgusu yok', crit ? 'Production policy deployment\'ı engeller (gerekçeli istisna verilebilir)' : '');
    }
    const window = deploymentWindowDecision(scope.project.settings, env.type);
    if (window.status === 'outside') add('window', window.action === 'deny' ? 'block' : 'warn', window.action === 'deny' ? 'Zaman penceresi dışında' : 'Zaman penceresi dışında: onay gerekecek', window.message);
    else if (window.status === 'inside') add('window', 'ok', 'Deployment zaman penceresi içinde');
    if (env.requiresApproval) add('approval', 'ok', `${env.requiredApprovals} kişi onayı gerekecek`, 'İsteyen kişi kendi deployment\'ını onaylayamaz');
    const rollout = (scope.project.settings as { rolloutPolicy?: { strategy: string; initialPercentage: number; minimumHealthyMinutes: number; maximumErrorRatePercent: number; automaticRollback: boolean } }).rolloutPolicy;
    if (rollout?.strategy === 'feature_flag') {
      const activeFlags = (await this.ctx.db.select({ n: count() }).from(featureFlags).where(and(eq(featureFlags.projectId, scope.project.id), eq(featureFlags.status, 'active'))))[0]?.n ?? 0;
      add('rollout', activeFlags ? 'ok' : 'warn', activeFlags ? `Feature flag kontrollü yayın · ${activeFlags} aktif flag` : 'Feature flag stratejisi seçili ancak aktif flag yok', `Sağlık eşiği: ${rollout.minimumHealthyMinutes} dk · hata <%${rollout.maximumErrorRatePercent}`);
    } else if (rollout && rollout.strategy !== 'all_at_once') {
      add('rollout', 'warn', `${rollout.strategy === 'canary' ? 'Canary' : 'Yüzde bazlı'} yayın politikası`, `İlk grup %${rollout.initialPercentage}. Trafik bölme deployment hedefinin önündeki load balancer tarafından uygulanmalı; Project Hub sağlık eşiğini ve geri alma politikasını kaydeder.`);
    } else add('rollout', 'ok', 'Tek seferde yayın');

    return {
      environment: { id: env.id, name: env.name, type: env.type },
      current: current ? { version: current.version, commitSha: current.commitSha } : null,
      target: { version: target.version, commitSha: target.commitSha },
      pendingMigrations: pending.map((m) => ({ path: m.path, name: m.name, riskLevel: m.riskLevel, operations: m.operations, version: m.version })),
      configChanges,
      checks,
      rolloutPolicy: rollout ?? null,
      blocked: checks.some((c) => c.status === 'block' && c.key !== 'security'),
    };
  }

  /** One release, every environment: a concise compatibility matrix backed by the full deployment preflight. */
  async compatibility(auth: AuthInfo, idOrSlug: string, versionId: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const version = (await this.ctx.db.select({ id: versions.id, version: versions.version, commitSha: versions.commitSha }).from(versions).where(and(eq(versions.id, versionId), eq(versions.projectId, scope.project.id))))[0];
    if (!version) throw notFound('Versiyon');
    const envs = await this.ctx.db.select({ id: environments.id }).from(environments).where(eq(environments.projectId, scope.project.id)).orderBy(environments.type, environments.name);
    const matrix = await Promise.all(
      envs.map(async (env) => {
        const result = await this.preflight(auth, scope.project.id, env.id, version.id);
        const status = result.blocked ? 'blocked' : result.checks.some((c) => c.status === 'warn') ? 'risk' : 'compatible';
        return { ...result, status };
      }),
    );
    return {
      version,
      overall: matrix.some((x) => x.status === 'blocked') ? 'blocked' : matrix.some((x) => x.status === 'risk') ? 'risk' : 'compatible',
      summary: {
        compatible: matrix.filter((x) => x.status === 'compatible').length,
        risk: matrix.filter((x) => x.status === 'risk').length,
        blocked: matrix.filter((x) => x.status === 'blocked').length,
      },
      environments: matrix,
    };
  }

  /* ---------------- backups ---------------- */

  private async backup(auth: AuthInfo, backupId: string) {
    const b = (await this.ctx.db.select().from(backups).where(and(eq(backups.id, backupId), eq(backups.organizationId, auth.organizationId))))[0];
    if (!b) throw notFound('Yedek');
    const scope = await this.access.requireWritable(auth, b.projectId, 'database.manage');
    return { b, scope };
  }

  async verify(auth: AuthInfo, backupId: string, actor: Actor) {
    const { b } = await this.backup(auth, backupId);
    if (b.status !== 'completed') throw precondition('Yalnızca tamamlanmış yedekler doğrulanabilir');
    await enqueue(this.ctx.db, { queue: QUEUES.deployment, type: 'database.verify_backup', organizationId: auth.organizationId, projectId: b.projectId, maxAttempts: 1, payload: { backupId: b.id } });
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: b.projectId, actor, action: 'database.backup_verify_requested', resourceType: 'backup', resourceId: b.id });
    return { queued: true };
  }

  /** Deleting backups is allowed except recent production backups (kept at least 7 days, spec §53 "if policy permits"). */
  async remove(auth: AuthInfo, backupId: string, actor: Actor) {
    const { b } = await this.backup(auth, backupId);
    const env = b.environmentId ? (await this.ctx.db.select().from(environments).where(eq(environments.id, b.environmentId)))[0] : null;
    if (env?.type === 'production' && b.status === 'completed' && Date.now() - b.createdAt.getTime() < 7 * 86400_000) {
      throw policyDenied('Production yedekleri ilk 7 gün silinemez');
    }
    if (b.location) await this.ctx.storage.remove(b.location).catch(() => undefined);
    await this.ctx.db.delete(backups).where(eq(backups.id, b.id));
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: b.projectId, actor, action: 'database.backup_deleted', resourceType: 'backup', resourceId: b.id, metadata: { environment: env?.name, sizeBytes: b.sizeBytes } });
    await publish(this.ctx.db, { type: 'backup.updated', organizationId: auth.organizationId, projectId: b.projectId });
    return { ok: true };
  }

  /** Restore a backup into an environment. Production needs another database manager's approval. */
  async requestRestore(auth: AuthInfo, backupId: string, environmentId: string, actor: Actor) {
    const { b, scope } = await this.backup(auth, backupId);
    if (b.status !== 'completed' || !b.location) throw precondition('Yalnızca tamamlanmış yedekler geri yüklenebilir');
    const env = await this.env(scope, environmentId);
    const conn = (await this.ctx.db.select().from(databaseConnections).where(eq(databaseConnections.environmentId, env.id)))[0];
    if (!conn) throw precondition(`${env.name} için veritabanı bağlantısı tanımlı değil`);
    const needsApproval = env.type === 'production';
    const r = await this.ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'restore:' + env.id}, 0))`);
      const busy = await tx.select({ id: backupRestores.id }).from(backupRestores).where(and(eq(backupRestores.environmentId, env.id), inArray(backupRestores.status, ['pending_approval', 'queued', 'running'])));
      if (busy.length) throw precondition('Bu ortam için bekleyen veya süren bir geri yükleme var');
      const row = (
        await tx
          .insert(backupRestores)
          .values({ organizationId: auth.organizationId, projectId: scope.project.id, backupId: b.id, environmentId: env.id, status: needsApproval ? 'pending_approval' : 'queued', requestedBy: auth.user.id })
          .returning()
      )[0]!;
      const workflow = await startWorkflow(tx, {
        organizationId: auth.organizationId,
        projectId: scope.project.id,
        definitionKey: 'database.restore',
        definitionVersion: 1,
        title: `${env.name} veritabanı geri yükleme`,
        triggerType: 'backup_restore',
        triggerRef: row.id,
        environmentId: env.id,
        riskLevel: env.type === 'production' ? 'critical' : 'high',
        requestedByType: actor.type,
        requestedBy: actor.id,
        idempotencyKey: `database-restore:${row.id}`,
        context: { restoreId: row.id, backupId: b.id, backupChecksum: b.checksum, environmentId: env.id, approvalRequired: needsApproval },
      });
      await setWorkflowStatus(tx, workflow.id, needsApproval ? 'waiting' : 'pending', { phase: needsApproval ? 'approval' : 'queued' });
      if (!needsApproval) await enqueue(tx, { queue: QUEUES.deployment, type: 'database.restore', organizationId: auth.organizationId, projectId: scope.project.id, maxAttempts: 1, dedupeKey: `database-restore:${row.id}`, payload: { restoreId: row.id } });
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'database.restore_requested', resourceType: 'backup', resourceId: b.id, metadata: { environment: env.name, approvalRequired: needsApproval } });
      await timeline(tx, { organizationId: auth.organizationId, projectId: scope.project.id, kind: 'deploy', tone: needsApproval ? 'warn' : 'run', title: `${env.name} veritabanı geri yükleme ${needsApproval ? 'onay bekliyor' : 'başladı'}`, description: `Yedek ${b.versionLabel ?? ''} · ${trDate(b.createdAt)}`, actorLabel: actor.label });
      await publish(tx, { type: 'backup.updated', organizationId: auth.organizationId, projectId: scope.project.id });
      return row;
    });
    return r;
  }

  async decideRestore(auth: AuthInfo, restoreId: string, approve: boolean, actor: Actor) {
    const r = (await this.ctx.db.select().from(backupRestores).where(and(eq(backupRestores.id, restoreId), eq(backupRestores.organizationId, auth.organizationId))))[0];
    if (!r) throw notFound('Geri yükleme');
    await this.access.requireWritable(auth, r.projectId, 'database.manage');
    if (r.status !== 'pending_approval') throw precondition('Geri yükleme onay beklemiyor');
    if (r.requestedBy === auth.user.id) throw forbidden('Kendi geri yükleme isteğinizi onaylayamazsınız');
    await this.ctx.db.transaction(async (tx) => {
      await tx.update(backupRestores).set({ status: approve ? 'queued' : 'rejected', approvedBy: auth.user.id, finishedAt: approve ? null : new Date() }).where(eq(backupRestores.id, r.id));
      const workflow = (await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.organizationId, r.organizationId), eq(workflowRuns.definitionKey, 'database.restore'), eq(workflowRuns.triggerRef, r.id))).limit(1))[0];
      if (workflow) await setWorkflowStatus(tx, workflow.id, approve ? 'pending' : 'cancelled', { phase: approve ? 'queued' : 'approval_rejected', error: approve ? null : 'Geri yükleme onayı reddedildi' });
      if (approve) await enqueue(tx, { queue: QUEUES.deployment, type: 'database.restore', organizationId: auth.organizationId, projectId: r.projectId, maxAttempts: 1, dedupeKey: `database-restore:${r.id}`, payload: { restoreId: r.id } });
      await audit(tx, { organizationId: auth.organizationId, projectId: r.projectId, actor, action: approve ? 'database.restore_approved' : 'database.restore_rejected', resourceType: 'backup', resourceId: r.backupId });
      await publish(tx, { type: 'backup.updated', organizationId: auth.organizationId, projectId: r.projectId });
    });
    return { ok: true };
  }

  async restores(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const rows = await this.ctx.db
      .select({ r: backupRestores, env: environments.name, by: users.displayName, workflowStatus: workflowRuns.status, workflowPhase: workflowRuns.phase })
      .from(backupRestores)
      .innerJoin(environments, eq(environments.id, backupRestores.environmentId))
      .leftJoin(users, eq(users.id, backupRestores.requestedBy))
      .leftJoin(workflowRuns, and(eq(workflowRuns.organizationId, backupRestores.organizationId), eq(workflowRuns.definitionKey, 'database.restore'), sql`${workflowRuns.triggerRef} = ${backupRestores.id}::text`))
      .where(eq(backupRestores.projectId, scope.project.id))
      .orderBy(desc(backupRestores.createdAt))
      .limit(50);
    return rows.map((x) => ({ ...x.r, environmentName: x.env, requestedByName: x.by, workflowStatus: x.workflowStatus, workflowPhase: x.workflowPhase, canApprove: scope.can('database.manage') && x.r.requestedBy !== auth.user.id && x.r.status === 'pending_approval', canReconcile: scope.can('database.manage') && x.workflowStatus === 'needs_reconciliation' }));
  }

  /** Resolves a restore whose target state could not be proven automatically. */
  async reconcileRestore(auth: AuthInfo, restoreId: string, input: { outcome: 'confirmed_restored' | 'confirmed_previous' | 'confirmed_failed'; comment: string }, actor: Actor) {
    const r = (await this.ctx.db.select().from(backupRestores).where(and(eq(backupRestores.id, restoreId), eq(backupRestores.organizationId, auth.organizationId))))[0];
    if (!r) throw notFound('Geri yükleme');
    await this.access.requireWritable(auth, r.projectId, 'database.manage');
    const workflow = (await this.ctx.db.select().from(workflowRuns).where(and(eq(workflowRuns.organizationId, r.organizationId), eq(workflowRuns.definitionKey, 'database.restore'), eq(workflowRuns.triggerRef, r.id))).limit(1))[0];
    if (!workflow || workflow.status !== 'needs_reconciliation') throw precondition('Bu geri yükleme uzlaştırma beklemiyor');
    const env = (await this.ctx.db.select().from(environments).where(and(eq(environments.id, r.environmentId), eq(environments.organizationId, r.organizationId))))[0];
    const restored = input.outcome === 'confirmed_restored';
    await this.ctx.db.transaction(async (tx) => {
      const evidence = await addEvidence(tx, { organizationId: r.organizationId, projectId: r.projectId, workflowRunId: workflow.id, kind: 'human_attestation', subjectType: 'backup_restore', subjectId: r.id, sourceType: 'user', sourceRef: actor.id, environmentId: r.environmentId, result: { ...input, verifiedBy: actor.label } });
      await tx.update(backupRestores).set({ status: restored ? 'completed' : 'failed', error: restored ? null : input.comment, finishedAt: new Date() }).where(eq(backupRestores.id, r.id));
      await tx.update(workflowSteps).set({ status: restored ? 'passed' : 'failed', error: restored ? null : input.comment, finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(workflowSteps.workflowRunId, workflow.id), eq(workflowSteps.status, 'needs_reconciliation')));
      await recordVerification(tx, { organizationId: r.organizationId, projectId: r.projectId, workflowRunId: workflow.id, key: 'database_restore:human_reconciliation', status: restored ? 'passed' : 'failed', summary: restored ? 'Geri yüklenen veritabanı yetkili kullanıcı tarafından doğrulandı' : input.outcome === 'confirmed_previous' ? 'Geri yükleme öncesi veritabanı durumunun korunduğu doğrulandı' : 'Hedef veritabanının geri yüklenmediği doğrulandı', expected: { backupId: r.backupId }, observed: { outcome: input.outcome, attestedBy: actor.label }, evidenceIds: [evidence.id] });
      await setWorkflowStatus(tx, workflow.id, restored ? 'succeeded' : 'failed', { phase: 'reconciled', error: restored ? null : input.comment });
      await audit(tx, { organizationId: r.organizationId, projectId: r.projectId, actor, action: 'database.restore_reconciled', resourceType: 'backup_restore', resourceId: r.id, metadata: input });
      await timeline(tx, { organizationId: r.organizationId, projectId: r.projectId, kind: 'deploy', tone: restored ? 'ok' : 'warn', title: `${env?.name ?? 'Ortam'} geri yüklemesi uzlaştırıldı`, description: `${actor.label}: ${input.comment}`, actorLabel: actor.label, refType: 'backup_restore', refId: r.id });
      await publish(tx, { type: 'backup.updated', organizationId: r.organizationId, projectId: r.projectId });
    });
    return { ok: true };
  }
}
