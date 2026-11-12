import { spawn } from 'node:child_process';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { addEvidence, audit, ensureWorkflowStep, PermanentJobError, publish, readSecret, recordVerification, setWorkflowStatus, setWorkflowStepStatus, startWorkflow, SYSTEM_ACTOR, timeline, type AppConfig, type JobContext } from '@projecthub/core';
import { backupRestores, backups, environments, migrationRuns, projectMigrations, versions, workflowSteps, type Executor } from '@projecthub/database';
import type { WorkerCtx } from '../context.js';
import { databaseUrl, dumpDatabase } from './deploy.js';

/** pg_restore lives next to pg_dump (same PostgreSQL client installation). */
export function pgRestoreBinary(config: AppConfig): string {
  return config.PG_DUMP_BINARY.replace(/pg_dump(\.exe)?$/i, (_m, ext: string | undefined) => `pg_restore${ext ?? ''}`);
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = 30 * 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${bin} başlatılamadı: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Verifies a dump is readable: pg_restore must list its table of contents (spec §53 "Verify"). */
export async function verifyBackupFile(ctx: WorkerCtx, backupId: string): Promise<{ ok: boolean; message: string }> {
  const b = (await ctx.db.select().from(backups).where(eq(backups.id, backupId)))[0];
  if (!b?.location) return { ok: false, message: 'Yedek dosyası yok' };
  const r = await run(pgRestoreBinary(ctx.config), ['--list', ctx.storage.resolve(b.location)], process.env, 5 * 60_000);
  if (r.code !== 0) return { ok: false, message: r.stderr.trim().slice(0, 300) || `pg_restore çıkış kodu ${r.code}` };
  const tables = r.stdout.split('\n').filter((l) => / TABLE DATA /.test(l)).length;
  await ctx.db.update(backups).set({ verifiedAt: new Date() }).where(eq(backups.id, backupId));
  return { ok: true, message: `${tables} tablo verisi okunabilir` };
}

export async function verifyBackup(ctx: WorkerCtx, { job }: JobContext) {
  const { backupId } = job.payload as { backupId: string };
  const r = await verifyBackupFile(ctx, backupId);
  const b = (await ctx.db.select().from(backups).where(eq(backups.id, backupId)))[0];
  if (b) {
    await timeline(ctx.db, { organizationId: b.organizationId, projectId: b.projectId, kind: 'deploy', tone: r.ok ? 'ok' : 'bad', title: r.ok ? 'Yedek doğrulandı' : 'Yedek doğrulanamadı', description: r.message });
    await publish(ctx.db, { type: 'backup.updated', organizationId: b.organizationId, projectId: b.projectId });
  }
  return r;
}

/** Drops every user schema (recreating an empty `public`) in one transaction. Returns an error message or null. */
async function resetUserSchemas(url: string): Promise<string | null> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
    await client.query('BEGIN');
    const { rows } = await client.query<{ name: string }>(
      `SELECT nspname AS name FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`,
    );
    for (const { name } of rows) await client.query(`DROP SCHEMA ${pg.escapeIdentifier(name)} CASCADE`);
    await client.query('CREATE SCHEMA public');
    await client.query('COMMIT');
    return null;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    return `Hedef veritabanı temizlenemedi: ${(e as Error).message}`;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Restores a backup into an environment's database. A safety dump of the target is always taken first, so the
 * restore itself can be undone; production restores reach this job only after a second person approved them.
 */
export async function restoreBackup(ctx: WorkerCtx, { job }: JobContext) {
  const { restoreId } = job.payload as { restoreId: string };
  const r = (await ctx.db.select().from(backupRestores).where(eq(backupRestores.id, restoreId)))[0];
  if (!r) throw new PermanentJobError('restore not found');
  if (r.status !== 'queued') return { skipped: r.status };
  const b = (await ctx.db.select().from(backups).where(eq(backups.id, r.backupId)))[0];
  const env = (await ctx.db.select().from(environments).where(eq(environments.id, r.environmentId)))[0];
  const workflow = await startWorkflow(ctx.db, {
    organizationId: r.organizationId,
    projectId: r.projectId,
    definitionKey: 'database.restore',
    definitionVersion: 1,
    title: `${env?.name ?? 'Bilinmeyen ortam'} veritabanı geri yükleme`,
    triggerType: 'backup_restore',
    triggerRef: r.id,
    environmentId: r.environmentId,
    riskLevel: env?.type === 'production' ? 'critical' : 'high',
    requestedByType: 'user',
    requestedBy: r.requestedBy,
    idempotencyKey: `database-restore:${r.id}`,
    context: { restoreId: r.id, backupId: r.backupId, backupChecksum: b?.checksum ?? null, environmentId: r.environmentId },
  });
  const safetyStep = await ensureWorkflowStep(ctx.db, { workflowRunId: workflow.id, key: 'safety_backup', name: 'Geri yükleme öncesi güvenlik yedeği', seq: 0 });
  const restoreStep = await ensureWorkflowStep(ctx.db, { workflowRunId: workflow.id, key: 'restore', name: 'Veritabanını geri yükle', seq: 1 });
  const verifyStep = await ensureWorkflowStep(ctx.db, { workflowRunId: workflow.id, key: 'verify', name: 'Geri yüklenen veritabanını doğrula', seq: 2 });
  await setWorkflowStatus(ctx.db, workflow.id, 'running', { phase: 'safety_backup', error: null });
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const finish = async (status: 'completed' | 'failed', error: string | null, needsReconciliation = false) => {
    const now = new Date();
    await ctx.db.update(workflowSteps).set({ status: needsReconciliation ? 'needs_reconciliation' : 'failed', error, finishedAt: now, updatedAt: now }).where(and(eq(workflowSteps.workflowRunId, workflow.id), eq(workflowSteps.status, 'running')));
    await ctx.db.update(workflowSteps).set({ status: 'skipped', error: status === 'completed' ? null : 'Önceki adım tamamlanmadı', finishedAt: now, updatedAt: now }).where(and(eq(workflowSteps.workflowRunId, workflow.id), eq(workflowSteps.status, 'pending')));
    await ctx.db.update(backupRestores).set({ status, error, log: lines.join('\n').slice(0, 20_000), finishedAt: new Date() }).where(eq(backupRestores.id, r.id));
    await recordVerification(ctx.db, {
      organizationId: r.organizationId,
      projectId: r.projectId,
      workflowRunId: workflow.id,
      workflowStepId: status === 'completed' ? verifyStep.id : restoreStep.id,
      key: 'database_restore:outcome',
      status: status === 'completed' ? 'passed' : needsReconciliation ? 'inconclusive' : 'failed',
      summary: status === 'completed' ? 'Veritabanı geri yükleme ve bağlantı doğrulaması tamamlandı' : needsReconciliation ? 'Hedef veritabanının gerçek durumu elle doğrulanmalı' : 'Geri yükleme tamamlanmadı; hedef güvenli durumda',
      expected: { backupId: r.backupId, checksum: b?.checksum ?? null },
      observed: { status, needsReconciliation, error },
    });
    await setWorkflowStatus(ctx.db, workflow.id, status === 'completed' ? 'succeeded' : needsReconciliation ? 'needs_reconciliation' : 'failed', {
      phase: status === 'completed' ? 'completed' : needsReconciliation ? 'reconciliation' : 'failed',
      error,
    });
    await audit(ctx.db, { organizationId: r.organizationId, projectId: r.projectId, actor: SYSTEM_ACTOR, action: `database.restore_${status}`, resourceType: 'backup', resourceId: r.backupId, metadata: { environment: env?.name, error } });
    await timeline(ctx.db, { organizationId: r.organizationId, projectId: r.projectId, kind: 'deploy', tone: status === 'completed' ? 'ok' : 'bad', title: `${env?.name ?? 'Ortam'} veritabanı geri yükleme ${status === 'completed' ? 'tamamlandı' : 'başarısız'}`, description: error ?? lines.at(-1) ?? '' });
    await publish(ctx.db, { type: 'backup.updated', organizationId: r.organizationId, projectId: r.projectId });
    return { status, error };
  };
  await ctx.db.update(backupRestores).set({ status: 'running' }).where(eq(backupRestores.id, r.id));
  await publish(ctx.db, { type: 'backup.updated', organizationId: r.organizationId, projectId: r.projectId });
  if (!b?.location || b.status !== 'completed') return finish('failed', 'Yedek dosyası kullanılamıyor');
  if (!env) return finish('failed', 'Ortam bulunamadı');
  const target = await databaseUrl(ctx, env.id);
  if (!target) return finish('failed', `${env.name} için veritabanı bağlantısı tanımlı değil`);
  let safetyId: string | null;
  try {
    await setWorkflowStepStatus(ctx.db, safetyStep.id, 'running');
    log(`Güvenlik yedeği alınıyor (${env.name})…`);
    safetyId = await dumpDatabase(ctx, { organizationId: r.organizationId, projectId: r.projectId, environmentId: env.id, deploymentId: null, versionLabel: 'geri-yükleme-öncesi', createdBy: r.requestedBy }, log);
    log(`Güvenlik yedeği: ${safetyId}`);
    const safetyBackup = safetyId ? (await ctx.db.select().from(backups).where(eq(backups.id, safetyId)))[0] : null;
    if (!safetyBackup?.verifiedAt) throw new Error('Güvenlik yedeği pg_restore ile doğrulanamadı');
    const evidence = await addEvidence(ctx.db, { organizationId: r.organizationId, projectId: r.projectId, workflowRunId: workflow.id, workflowStepId: safetyStep.id, kind: 'backup', subjectType: 'backup_restore', subjectId: r.id, sourceType: 'pg_dump', sourceRef: safetyId, environmentId: env.id, checksum: safetyBackup.checksum, artifactId: null, result: { backupId: safetyId, verified: true } });
    await setWorkflowStepStatus(ctx.db, safetyStep.id, 'passed', { output: { backupId: safetyId, checksum: safetyBackup.checksum } });
    await recordVerification(ctx.db, { organizationId: r.organizationId, projectId: r.projectId, workflowRunId: workflow.id, workflowStepId: safetyStep.id, key: 'database_restore:safety_backup', status: 'passed', summary: 'Geri dönüş için doğrulanmış güvenlik yedeği oluşturuldu', expected: { verified: true }, observed: { backupId: safetyId, checksum: safetyBackup.checksum, verified: true }, evidenceIds: [evidence.id] });
  } catch (e) {
    await setWorkflowStepStatus(ctx.db, safetyStep.id, 'failed', { error: (e as Error).message });
    return finish('failed', `Güvenlik yedeği alınamadı, geri yükleme yapılmadı: ${(e as Error).message}`);
  }
  const password = target.conn.passwordSecretId ? await readSecret(ctx.db, ctx.config.encryptionKey, target.conn.passwordSecretId) : '';
  const restoreFrom = async (file: string) => {
    // Restoring means "the database looks exactly like the backup": objects created after it must go too, which
    // pg_restore --clean alone would keep. User schemas are emptied first; pg_restore then runs as one transaction.
    const reset = await resetUserSchemas(target.url);
    if (reset) return reset;
    const res = await run(
      pgRestoreBinary(ctx.config),
      ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', '-h', target.conn.host, '-p', String(target.conn.port), '-U', target.conn.username, '-d', target.conn.databaseName, '--no-password', file],
      { ...process.env, PGPASSWORD: password, PGSSLMODE: target.conn.sslMode, PGCONNECT_TIMEOUT: '15' },
    );
    return res.code === 0 ? null : res.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500) || `pg_restore çıkış kodu ${res.code}`;
  };
  await setWorkflowStatus(ctx.db, workflow.id, 'running', { phase: 'restore' });
  await setWorkflowStepStatus(ctx.db, restoreStep.id, 'running');
  log(`pg_restore → ${target.conn.host}:${target.conn.port}/${target.conn.databaseName}`);
  const failure = await restoreFrom(ctx.storage.resolve(b.location));
  if (failure) {
    log(failure);
    const safety = safetyId ? (await ctx.db.select().from(backups).where(eq(backups.id, safetyId)))[0] : null;
    if (!safety?.location) {
      await setWorkflowStepStatus(ctx.db, restoreStep.id, 'needs_reconciliation', { error: failure, checkpoint: { targetReset: true, safetyBackupAvailable: false } });
      return finish('failed', `${failure} — güvenlik yedeği de yok, veritabanını kontrol edin`, true);
    }
    log('Geri yükleme başarısız; güvenlik yedeğine dönülüyor…');
    const back = await restoreFrom(ctx.storage.resolve(safety.location));
    if (back) {
      await setWorkflowStepStatus(ctx.db, restoreStep.id, 'needs_reconciliation', { error: `${failure}; rollback: ${back}`, checkpoint: { targetReset: true, safetyRestoreFailed: true } });
      return finish('failed', `${failure} — güvenlik yedeğine dönülemedi: ${back}`, true);
    }
    await setWorkflowStepStatus(ctx.db, restoreStep.id, 'failed', { error: failure, checkpoint: { compensatedBySafetyBackup: true, safetyBackupId: safety.id } });
    return finish('failed', `${failure} — veritabanı geri yükleme öncesi haline döndürüldü`);
  }
  const restoreEvidence = await addEvidence(ctx.db, { organizationId: r.organizationId, projectId: r.projectId, workflowRunId: workflow.id, workflowStepId: restoreStep.id, kind: 'restore_result', subjectType: 'backup_restore', subjectId: r.id, sourceType: 'pg_restore', sourceRef: b.location, environmentId: env.id, checksum: b.checksum, result: { backupId: b.id, restored: true } });
  await setWorkflowStepStatus(ctx.db, restoreStep.id, 'passed', { output: { backupId: b.id, checksum: b.checksum }, checkpoint: { safetyBackupId: safetyId } });
  await recordVerification(ctx.db, { organizationId: r.organizationId, projectId: r.projectId, workflowRunId: workflow.id, workflowStepId: restoreStep.id, key: 'database_restore:restore', status: 'passed', summary: 'pg_restore işlemi tek transaction ile tamamlandı', expected: { backupId: b.id, checksum: b.checksum }, observed: { exitCode: 0 }, evidenceIds: [restoreEvidence.id] });
  await setWorkflowStatus(ctx.db, workflow.id, 'running', { phase: 'verify' });
  await setWorkflowStepStatus(ctx.db, verifyStep.id, 'running');
  const verifyClient = new pg.Client({ connectionString: target.url, connectionTimeoutMillis: 15_000 });
  try {
    await verifyClient.connect();
    const check = await verifyClient.query<{ database: string; tables: string }>("SELECT current_database() AS database, count(*)::text AS tables FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')");
    const observed = { database: check.rows[0]?.database ?? target.conn.databaseName, tables: Number(check.rows[0]?.tables ?? 0) };
    const evidence = await addEvidence(ctx.db, { organizationId: r.organizationId, projectId: r.projectId, workflowRunId: workflow.id, workflowStepId: verifyStep.id, kind: 'database_probe', subjectType: 'backup_restore', subjectId: r.id, sourceType: 'postgresql', sourceRef: target.conn.databaseName, environmentId: env.id, result: observed });
    await setWorkflowStepStatus(ctx.db, verifyStep.id, 'passed', { output: observed });
    await recordVerification(ctx.db, { organizationId: r.organizationId, projectId: r.projectId, workflowRunId: workflow.id, workflowStepId: verifyStep.id, key: 'database_restore:probe', status: 'passed', summary: `Geri yüklenen veritabanına bağlanıldı (${observed.tables} tablo)`, expected: { reachable: true }, observed: { reachable: true, ...observed }, evidenceIds: [evidence.id] });
  } catch (e) {
    await setWorkflowStepStatus(ctx.db, verifyStep.id, 'needs_reconciliation', { error: (e as Error).message, checkpoint: { restoreCommandSucceeded: true } });
    return finish('failed', `Geri yükleme tamamlandı ancak bağlantı doğrulanamadı: ${(e as Error).message}`, true);
  } finally {
    await verifyClient.end().catch(() => undefined);
  }
  log('Geri yükleme tamamlandı ve veritabanı bağlantısı doğrulandı');
  return finish('completed', null);
}

/**
 * After a deployment ran its migration command successfully, every migration that belongs to the deployed
 * version (or an earlier one) counts as applied in that environment (spec §44, §52).
 */
export async function recordMigrationRuns(db: Executor, input: { projectId: string; environmentId: string; deploymentId: string; versionId: string }) {
  const due = await db
    .select({ id: projectMigrations.id })
    .from(projectMigrations)
    .innerJoin(versions, eq(versions.id, projectMigrations.firstVersionId))
    .where(and(eq(projectMigrations.projectId, input.projectId), sql`${versions.createdAt} <= (select v2.created_at from versions v2 where v2.id = ${input.versionId})`));
  if (!due.length) return 0;
  const rows = await db
    .insert(migrationRuns)
    .values(due.map((m) => ({ migrationId: m.id, environmentId: input.environmentId, deploymentId: input.deploymentId })))
    .onConflictDoNothing()
    .returning({ id: migrationRuns.id });
  return rows.length;
}
