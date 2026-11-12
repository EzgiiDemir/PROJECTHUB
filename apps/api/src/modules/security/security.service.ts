import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { FindingStatus, importSecretsSchema, SecretKind, SecretScope, Severity } from '@projecthub/contracts';
import { audit, enqueue, forbidden, getProjectAccess, isSecretReadable, notFound, parseDotenv, precondition, publish, putSecret, QUEUES, readRepositoryEnv, readSecret, scan, type Actor } from '@projecthub/core';
import { environments, projects, secrets, securityFindings, securityScans, users } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';
import { Repos } from '../../infra/repos.js';

type ImportSecretsInput = z.infer<typeof importSecretsSchema>;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const SENSITIVE = /PASS|SECRET|TOKEN|_KEY$|KEY_ID$|PRIVATE|CREDENTIAL|DSN$/i;

const SEVERITY_ORDER = sql`CASE ${securityFindings.severity} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

@Injectable()
export class SecurityService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
    private readonly repos: Repos,
  ) {}

  /* ---------------- secrets ---------------- */

  async listSecrets(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug, 'secret.manage');
    const rows = await this.ctx.db
      .select({ s: secrets, env: environments.name, by: users.displayName })
      .from(secrets)
      .leftJoin(environments, eq(environments.id, secrets.environmentId))
      .leftJoin(users, eq(users.id, secrets.createdBy))
      .where(and(eq(secrets.projectId, scope.project.id), isNull(secrets.system)))
      .orderBy(asc(secrets.name));
    // Values never leave the server here; only metadata.
    const now = Date.now();
    return rows.map((r) => {
      const rotationBase = r.s.rotatedAt ?? r.s.createdAt;
      const rotationDueAt = r.s.rotationIntervalDays > 0 ? new Date(rotationBase.getTime() + r.s.rotationIntervalDays * 86_400_000) : null;
      const nextDueAt = [r.s.expiresAt, rotationDueAt].filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
      const rotationStatus = r.s.expiresAt && r.s.expiresAt.getTime() <= now ? 'expired' : rotationDueAt && rotationDueAt.getTime() <= now ? 'due' : nextDueAt && nextDueAt.getTime() <= now + 14 * 86_400_000 ? 'upcoming' : 'current';
      return {
      id: r.s.id,
      name: r.s.name,
      kind: r.s.kind,
      scope: r.s.scope,
      environmentId: r.s.environmentId,
      environmentName: r.env ?? 'Tüm ortamlar',
      createdByName: r.by,
      createdAt: r.s.createdAt,
      updatedAt: r.s.updatedAt,
      rotatedAt: r.s.rotatedAt,
      rotationIntervalDays: r.s.rotationIntervalDays,
      rotationDueAt,
      expiresAt: r.s.expiresAt,
      rotationStatus,
      lastAccessedAt: r.s.lastAccessedAt,
      // Saved under another encryption key: builds and previews run without it until it is saved again.
      readable: isSecretReadable(this.ctx.config.encryptionKey, r.s),
      };
    });
  }

  async upsertSecret(auth: AuthInfo, idOrSlug: string, input: { name: string; value: string; kind: SecretKind; scope: SecretScope; environmentId: string | null; rotationIntervalDays: number; expiresAt: string | null }, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'secret.manage');
    if (input.environmentId) {
      const e = await this.ctx.db.select({ id: environments.id }).from(environments).where(and(eq(environments.id, input.environmentId), eq(environments.projectId, scope.project.id)));
      if (!e.length) throw notFound('Ortam');
    }
    const { rotationIntervalDays, expiresAt, ...secretInput } = input;
    const id = await putSecret(this.ctx.db, this.ctx.config.encryptionKey, { organizationId: auth.organizationId, projectId: scope.project.id, ...secretInput, system: null, createdBy: auth.user.id });
    await this.ctx.db.update(secrets).set({ rotationIntervalDays, expiresAt: expiresAt ? new Date(expiresAt) : null }).where(and(eq(secrets.id, id), eq(secrets.organizationId, auth.organizationId)));
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'secret.written', resourceType: 'secret', resourceId: id, metadata: { name: input.name, scope: input.scope, environmentId: input.environmentId, rotationIntervalDays, expiresAt } });
    return { id };
  }

  /**
   * Bulk import from a pasted .env or from the .env that is (or was) committed to the repository. Parsed with the
   * dotenv rules; the preview (dryRun) returns names and lengths only, never values. Nothing is stored until the
   * person confirms with dryRun=false.
   */
  async importSecrets(auth: AuthInfo, idOrSlug: string, input: ImportSecretsInput, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'secret.manage');
    const p = scope.project;
    if (input.environmentId) {
      const e = await this.ctx.db.select({ id: environments.id }).from(environments).where(and(eq(environments.id, input.environmentId), eq(environments.projectId, p.id)));
      if (!e.length) throw notFound('Ortam');
    }
    let text = input.text ?? '';
    let origin: { kind: 'text' } | { kind: 'history'; commit: string; date: string; removed: boolean; paths: string[] } = { kind: 'text' };
    if (input.source === 'history') {
      const found = await readRepositoryEnv((await this.repos.forProject(p.id)).git, p.defaultBranch);
      if (!found) throw precondition('Repoda ya da geçmişinde bir .env bulunamadı; değerleri yapıştırın.');
      text = found.text;
      origin = { kind: 'history', commit: found.commit, date: found.date, removed: found.removed, paths: found.paths };
    }
    if (!text.trim()) throw precondition('İçe aktarılacak .env içeriği boş');
    const { entries, issues } = parseDotenv(text);
    const values = new Map(entries.map((e) => [e.name, e.value]));
    const generated = new Set<string>();
    if (input.rotateAppKey && values.has('APP_KEY')) {
      // Laravel 11+: APP_PREVIOUS_KEYS keeps data encrypted with the leaked key readable while new data uses the new key.
      const previous = [values.get('APP_KEY')!, ...(values.get('APP_PREVIOUS_KEYS') ?? '').split(',')].map((k) => k.trim()).filter(Boolean);
      values.set('APP_KEY', `base64:${randomBytes(32).toString('base64')}`);
      values.set('APP_PREVIOUS_KEYS', [...new Set(previous)].join(','));
      generated.add('APP_KEY').add('APP_PREVIOUS_KEYS');
    }
    const rows = await this.ctx.db
      .select({ name: secrets.name, system: secrets.system, ciphertext: secrets.ciphertext, iv: secrets.iv, authTag: secrets.authTag })
      .from(secrets)
      .where(and(eq(secrets.organizationId, auth.organizationId), eq(secrets.projectId, p.id), input.environmentId ? eq(secrets.environmentId, input.environmentId) : isNull(secrets.environmentId)));
    const existing = new Map(rows.map((r) => [r.name, { system: r.system, readable: isSecretReadable(this.ctx.config.encryptionKey, r) }]));
    const items = [...values].map(([name, value]) => {
      const base = { name, length: value.length, generated: generated.has(name) };
      if (!SECRET_NAME.test(name) || name.length > 120) return { ...base, action: 'skip' as const, note: 'Geçersiz ad' };
      if (value.length > 50_000) return { ...base, action: 'skip' as const, note: 'Değer çok uzun' };
      const current = existing.get(name);
      if (current?.system) return { ...base, action: 'skip' as const, note: 'Project Hub tarafından yönetiliyor' };
      if (current) {
        if (input.overwrite === true || (input.overwrite === 'unreadable' && !current.readable)) return { ...base, action: 'update' as const, ...(current.readable ? {} : { note: 'Okunamıyordu; onarıldı' }) };
        return { ...base, action: 'skip' as const, note: 'Zaten var' };
      }
      return { ...base, action: 'create' as const };
    });
    const toSave = items.filter((i) => i.action !== 'skip');
    if (!input.dryRun && toSave.length) {
      await this.ctx.db.transaction(async (tx) => {
        for (const i of toSave) {
          await putSecret(tx, this.ctx.config.encryptionKey, { organizationId: auth.organizationId, projectId: p.id, environmentId: input.environmentId, name: i.name, value: values.get(i.name)!, kind: 'env', scope: input.scope, system: null, createdBy: auth.user.id });
        }
        await audit(tx, { organizationId: auth.organizationId, projectId: p.id, actor, action: 'secret.imported', resourceType: 'project', resourceId: p.id, metadata: { names: toSave.map((i) => i.name), source: input.source, scope: input.scope, environmentId: input.environmentId, rotatedAppKey: generated.has('APP_KEY') } });
      });
    }
    // Credentials of outside services (database, mail, cloud) cannot be rotated from here; list them so the person
    // renews them at the provider when the file was exposed in Git.
    const external = items.filter((i) => !i.generated && i.action !== 'skip' && SENSITIVE.test(i.name) && !/^(null|false|true|\d+)$/i.test(values.get(i.name)!)).map((i) => i.name);
    return { origin, items, issues, external, saved: input.dryRun ? 0 : toSave.length, hasAppKey: values.has('APP_KEY') };
  }


  /** Explicit reveal (spec §54): needs secret.read and is always audited. */
  async reveal(auth: AuthInfo, secretId: string, actor: Actor) {
    const s = (await this.ctx.db.select().from(secrets).where(and(eq(secrets.id, secretId), eq(secrets.organizationId, auth.organizationId))))[0];
    if (!s || !s.projectId || s.system) throw notFound('Secret');
    await this.access.require(auth, s.projectId, 'secret.read');
    const value = await readSecret(this.ctx.db, this.ctx.config.encryptionKey, s.id);
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: s.projectId, actor, action: 'secret.revealed', resourceType: 'secret', resourceId: s.id, metadata: { name: s.name } });
    return { value };
  }

  async deleteSecret(auth: AuthInfo, secretId: string, actor: Actor) {
    const s = (await this.ctx.db.select().from(secrets).where(and(eq(secrets.id, secretId), eq(secrets.organizationId, auth.organizationId))))[0];
    if (!s || !s.projectId || s.system) throw notFound('Secret');
    await this.access.requireWritable(auth, s.projectId, 'secret.manage');
    await this.ctx.db.delete(secrets).where(eq(secrets.id, s.id));
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: s.projectId, actor, action: 'secret.deleted', resourceType: 'secret', resourceId: s.id, metadata: { name: s.name } });
  }

  /* ---------------- scans & findings ---------------- */

  async projectSecurity(auth: AuthInfo, idOrSlug: string, q: { status?: string; severity?: string; type?: string }) {
    const scope = await this.access.require(auth, idOrSlug, 'security.read');
    const conds: SQL[] = [eq(securityFindings.projectId, scope.project.id)];
    if (q.status !== 'all') conds.push(eq(securityFindings.status, (q.status ?? 'open') as FindingStatus));
    if (q.severity) conds.push(eq(securityFindings.severity, q.severity as Severity));
    if (q.type) conds.push(eq(securityFindings.type, q.type as never));
    const findings = await this.ctx.db.select().from(securityFindings).where(and(...conds)).orderBy(SEVERITY_ORDER, desc(securityFindings.lastSeenAt)).limit(500);
    const scans = await this.ctx.db.select().from(securityScans).where(eq(securityScans.projectId, scope.project.id)).orderBy(desc(securityScans.createdAt)).limit(20);
    const counts = await this.ctx.db
      .select({ status: securityFindings.status, severity: securityFindings.severity, n: count() })
      .from(securityFindings)
      .where(eq(securityFindings.projectId, scope.project.id))
      .groupBy(securityFindings.status, securityFindings.severity);
    return {
      score: scope.project.securityScore,
      lastScan: scans.find((s) => s.status === 'completed') ?? null,
      running: scans.some((s) => s.status === 'running' || s.status === 'queued'),
      scans,
      counts,
      findings: findings.map((f) => ({ ...f, key: `SEC-${f.number}` })),
    };
  }

  async startScan(auth: AuthInfo, idOrSlug: string, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'security.manage');
    const row = await this.ctx.db.transaction(async (tx) => {
      const s = (await tx.insert(securityScans).values({ organizationId: auth.organizationId, projectId: scope.project.id, branch: scope.project.defaultBranch, createdBy: auth.user.id }).returning())[0]!;
      await enqueue(tx, { queue: QUEUES.security, type: 'security.scan', organizationId: auth.organizationId, projectId: scope.project.id, maxAttempts: 2, payload: { projectId: scope.project.id, scanId: s.id, trigger: 'manual', requestedBy: auth.user.id } });
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'security.scan_requested', resourceType: 'security_scan', resourceId: s.id });
      await publish(tx, { type: 'security.scan', organizationId: auth.organizationId, projectId: scope.project.id, id: s.id });
      return s;
    });
    return row;
  }

  /** Accept risk / mark false positive / reopen. Accepted findings stop blocking production (audited). */
  async updateFinding(auth: AuthInfo, findingId: string, input: { status: FindingStatus; reason?: string }, actor: Actor) {
    const f = (await this.ctx.db.select().from(securityFindings).where(and(eq(securityFindings.id, findingId), eq(securityFindings.organizationId, auth.organizationId))))[0];
    if (!f) throw notFound('Bulgu');
    await this.access.require(auth, f.projectId, 'security.manage');
    if ((input.status === 'accepted' || input.status === 'false_positive') && (!input.reason || input.reason.trim().length < 5)) {
      throw forbidden('Risk kabulü / yanlış alarm için gerekçe yazın');
    }
    await this.ctx.db
      .update(securityFindings)
      .set({ status: input.status, statusReason: input.reason ?? null, statusChangedBy: auth.user.id, resolvedAt: input.status === 'open' ? null : new Date() })
      .where(eq(securityFindings.id, f.id));
    // Score reflects only open findings.
    const open = await this.ctx.db.select({ severity: securityFindings.severity, type: securityFindings.type, packageName: securityFindings.packageName, filePath: securityFindings.filePath }).from(securityFindings).where(and(eq(securityFindings.projectId, f.projectId), eq(securityFindings.status, 'open')));
    const { score } = scan.securityScore(open);
    await this.ctx.db.update(projects).set({ securityScore: score }).where(eq(projects.id, f.projectId));
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: f.projectId, actor, action: `security.finding_${input.status}`, resourceType: 'security_finding', resourceId: f.id, metadata: { key: `SEC-${f.number}`, reason: input.reason } });
    await enqueue(this.ctx.db, { queue: QUEUES.maintenance, type: 'project.health', projectId: f.projectId, organizationId: auth.organizationId, dedupeKey: `health:${f.projectId}`, payload: { projectId: f.projectId } });
    await publish(this.ctx.db, { type: 'security.scan', organizationId: auth.organizationId, projectId: f.projectId });
    return { ...f, status: input.status, key: `SEC-${f.number}` };
  }

  /**
   * "Çözüldü": marks the finding resolved and immediately scans the default branch again. The scanner reopens a
   * resolved finding it still sees, so the verification result is objective (see `verification`).
   */
  async resolveAndVerify(auth: AuthInfo, findingId: string, note: string | undefined, actor: Actor) {
    const f = (await this.ctx.db.select().from(securityFindings).where(and(eq(securityFindings.id, findingId), eq(securityFindings.organizationId, auth.organizationId))))[0];
    if (!f) throw notFound('Bulgu');
    if (f.status === 'resolved') throw precondition('Bulgu zaten çözüldü olarak işaretli');
    await this.updateFinding(auth, f.id, { status: 'resolved', reason: note?.trim() || undefined }, actor);
    const scan = await this.startScan(auth, f.projectId, actor);
    return { scanId: scan.id };
  }

  /** Result of the verification scan started by `resolveAndVerify`. */
  async verification(auth: AuthInfo, findingId: string, scanId: string) {
    const f = (await this.ctx.db.select().from(securityFindings).where(and(eq(securityFindings.id, findingId), eq(securityFindings.organizationId, auth.organizationId))))[0];
    if (!f) throw notFound('Bulgu');
    await this.access.require(auth, f.projectId, 'security.read');
    const s = (await this.ctx.db.select().from(securityScans).where(and(eq(securityScans.id, scanId), eq(securityScans.projectId, f.projectId))))[0];
    if (!s) throw notFound('Tarama');
    const finding = { status: f.status, lastSeenAt: f.lastSeenAt };
    if (s.status === 'queued' || s.status === 'running') return { state: 'pending' as const, message: 'Doğrulama taraması sürüyor…', finding };
    if (s.status === 'failed') return { state: 'unverifiable' as const, message: `Doğrulama taraması başarısız: ${s.error ?? 'bilinmeyen hata'}`, finding };
    if (f.status === 'open') return { state: 'still_present' as const, message: `Sorun ${s.commitSha?.slice(0, 7) ?? 'son'} commit'inde hâlâ mevcut; bulgu yeniden açıldı.`, finding };
    const depUnchecked = f.type === 'dependency' && (s.summary?.notes ?? []).some((n) => n.includes('ulaşılamadı') || n.includes('kapalı'));
    if (depUnchecked) return { state: 'unverifiable' as const, message: 'Zafiyet veritabanına ulaşılamadığı için bu tarama bağımlılığı kontrol edemedi.', finding };
    return { state: 'verified' as const, message: `Doğrulandı: ${s.branch} branch'inin ${s.commitSha?.slice(0, 7) ?? 'son'} commit'inde sorun bulunamadı.`, finding };
  }

  /** Organization-wide Security Center (spec §24). Only projects the caller can see. */
  async center(auth: AuthInfo) {
    const visibleProjects = auth.orgPermissions.has('project.read.all')
      ? await this.ctx.db.select({ id: projects.id, name: projects.name, slug: projects.slug, score: projects.securityScore }).from(projects).where(eq(projects.organizationId, auth.organizationId))
      : await this.ctx.db
          .select({ id: projects.id, name: projects.name, slug: projects.slug, score: projects.securityScore })
          .from(projects)
          .where(and(eq(projects.organizationId, auth.organizationId), sql`${projects.id} IN (SELECT project_id FROM project_members WHERE user_id = ${auth.user.id})`));
    // Findings only for projects where the caller's role may read them (designers/viewers see none).
    const readable = auth.orgPermissions.has('security.read')
      ? visibleProjects
      : (
          await Promise.all(
            visibleProjects.map(async (p) => ((await getProjectAccess(this.ctx.db, { organizationId: auth.organizationId, userId: auth.user.id, projectId: p.id, orgPermissions: auth.orgPermissions })).permissions.has('security.read') ? p : null)),
          )
        ).filter((p) => p !== null);
    visibleProjects.splice(0, visibleProjects.length, ...readable);
    const ids = visibleProjects.map((p) => p.id);
    if (!ids.length) return { score: null, counts: {}, projects: [], findings: [] };
    const findings = await this.ctx.db
      .select()
      .from(securityFindings)
      .where(and(inArray(securityFindings.projectId, ids), eq(securityFindings.status, 'open')))
      .orderBy(SEVERITY_ORDER, desc(securityFindings.lastSeenAt))
      .limit(300);
    const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    const all = await this.ctx.db
      .select({ severity: securityFindings.severity, n: count() })
      .from(securityFindings)
      .where(and(inArray(securityFindings.projectId, ids), eq(securityFindings.status, 'open')))
      .groupBy(securityFindings.severity);
    for (const c of all) counts[c.severity] = c.n;
    const scored = visibleProjects.filter((p) => p.score !== null);
    return {
      score: scored.length ? Math.round(scored.reduce((s, p) => s + (p.score ?? 0), 0) / scored.length) : null,
      counts,
      projects: visibleProjects,
      findings: findings.map((f) => ({ ...f, key: `SEC-${f.number}`, projectName: visibleProjects.find((p) => p.id === f.projectId)?.name, projectSlug: visibleProjects.find((p) => p.id === f.projectId)?.slug })),
    };
  }
}
