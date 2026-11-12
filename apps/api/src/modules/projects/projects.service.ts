import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { OPEN_FEEDBACK_STATUSES, type FeatureFlagInput, type FeatureFlagOverrideInput, type Manifest, type ProjectAutomationPolicy, type ProjectGovernance, type ProjectRolloutPolicy, type ProjectStatus, type ProjectTemplateId } from '@projecthub/contracts';
import {
  assertImportableGitUrl,
  audit,
  conflict,
  emitDomainEvent,
  enqueue,
  forbidden,
  invalid,
  MANIFEST_FILE,
  notFound,
  parseManifest,
  publish,
  putSecret,
  QUEUES,
  serializeManifest,
  sha256,
  timeline,
  type Actor,
} from '@projecthub/core';
import {
  builds,
  deployments,
  environments,
  feedback,
  featureFlagOverrides,
  featureFlags,
  incidents,
  organizationMembers,
  capabilityProfiles,
  entityRelations,
  observations,
  previews,
  projectEvents,
  projectManifests,
  projectMembers,
  projects,
  repositories,
  reviewSessions,
  roles,
  securityScans,
  softwareEntities,
  teams,
  uploads,
  users,
  versions,
  type Executor,
} from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { Paged } from '../../infra/http.js';
import { ProjectAccess, type ProjectScope } from '../../infra/project-access.js';
import { Repos } from '../../infra/repos.js';

const PALETTE = ['#1F6F5C', '#234E8C', '#BE3B28', '#7A3EA8', '#B5520F', '#2563A8', '#5B6772', '#2E7D4F'];

function matchFlagRule(actual: string | undefined, operator: 'equals' | 'not_equals' | 'contains' | 'in', expected: string | string[]) {
  const values = Array.isArray(expected) ? expected : [expected];
  if (operator === 'not_equals') return actual !== values[0];
  if (actual === undefined) return false;
  if (operator === 'contains') return actual.includes(values[0] ?? '');
  if (operator === 'in') return values.includes(actual);
  return actual === values[0];
}

type CreateInput = {
  name: string;
  slug: string;
  description: string;
  customerName: string;
  teamId: string | null;
  color?: string;
  defaultBranch: string;
  source: { type: 'empty'; template?: ProjectTemplateId } | { type: 'git'; url: string; branch?: string; accessToken?: string } | { type: 'upload'; uploadId: string };
  createDefaultEnvironments: boolean;
};

@Injectable()
export class ProjectsService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
    private readonly repos: Repos,
  ) {}

  async list(auth: AuthInfo, q: { status: string; search?: string; teamId?: string; year?: number; technology?: string }) {
    const db = this.ctx.db;
    const conds: SQL[] = [eq(projects.organizationId, auth.organizationId)];
    if (!auth.orgPermissions.has('project.read.all')) {
      conds.push(sql`${projects.id} IN (SELECT project_id FROM project_members WHERE user_id = ${auth.user.id})`);
    }
    if (q.status !== 'all') conds.push(eq(projects.status, q.status as ProjectStatus));
    if (q.teamId) conds.push(eq(projects.teamId, q.teamId));
    if (q.year) conds.push(sql`extract(year from ${projects.createdAt}) = ${q.year}`);
    if (q.technology) conds.push(sql`${projects.technologies} @> ${JSON.stringify([q.technology])}::jsonb`);
    if (q.search) {
      const term = q.search.trim();
      conds.push(
        or(
          sql`to_tsvector('simple', ${projects.name} || ' ' || ${projects.description} || ' ' || ${projects.customerName}) @@ plainto_tsquery('simple', ${term})`,
          sql`${projects.name} ILIKE ${`%${term}%`}`,
          sql`${projects.customerName} ILIKE ${`%${term}%`}`,
          sql`${projects.technologies}::text ILIKE ${`%${term}%`}`,
          sql`${projects.sourceLabel} ILIKE ${`%${term}%`}`,
        )!,
      );
    }
    const rows = await db
      .select({
        p: projects,
        ownerName: users.displayName,
        ownerColor: users.avatarColor,
        teamName: teams.name,
        repoStatus: repositories.status,
      })
      .from(projects)
      .leftJoin(users, eq(users.id, projects.ownerId))
      .leftJoin(teams, eq(teams.id, projects.teamId))
      .leftJoin(repositories, eq(repositories.projectId, projects.id))
      .where(and(...conds))
      .orderBy(desc(projects.updatedAt));
    const ids = rows.map((r) => r.p.id);
    const idList = sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
    const lastBuilds = ids.length
      ? await db.execute<{ project_id: string; status: string }>(
          sql`SELECT DISTINCT ON (project_id) project_id, status FROM builds WHERE project_id IN (${idList}) ORDER BY project_id, created_at DESC`,
        )
      : { rows: [] };
    const lastDeploys = ids.length
      ? await db.execute<{ project_id: string; finished_at: Date; status: string }>(
          sql`SELECT DISTINCT ON (project_id) project_id, finished_at, status FROM deployments WHERE project_id IN (${idList}) AND status IN ('succeeded','failed','rolled_back') ORDER BY project_id, created_at DESC`,
        )
      : { rows: [] };
    const prod = ids.length
      ? await db
          .select({ projectId: environments.projectId, status: environments.status })
          .from(environments)
          .where(and(inArray(environments.projectId, ids), eq(environments.type, 'production')))
      : [];
    return rows.map((r) => ({
      ...summary(r.p),
      owner: r.p.ownerId ? { id: r.p.ownerId, displayName: r.ownerName, avatarColor: r.ownerColor } : null,
      teamName: r.teamName,
      repositoryStatus: r.repoStatus,
      lastBuildStatus: lastBuilds.rows.find((b) => b.project_id === r.p.id)?.status ?? null,
      lastDeploy: lastDeploys.rows.find((d) => d.project_id === r.p.id) ?? null,
      productionStatus: prod.find((e) => e.projectId === r.p.id)?.status ?? null,
    }));
  }

  async create(auth: AuthInfo, input: CreateInput, actor: Actor) {
    const db = this.ctx.db;
    if (input.teamId) {
      const t = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, input.teamId), eq(teams.organizationId, auth.organizationId)));
      if (!t.length) throw notFound('Ekip');
    }
    const exists = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.organizationId, auth.organizationId), eq(projects.slug, input.slug)));
    if (exists.length) throw conflict(`"${input.slug}" adresli bir proje zaten var`, { field: 'slug', code: 'PROJECT_SLUG_EXISTS' });

    // Only external Git servers: never this machine's files (other projects' repositories) or its internal services.
    if (input.source.type === 'git') await assertImportableGitUrl(input.source.url, { allowLocal: this.ctx.config.GIT_IMPORT_ALLOW_LOCAL, allowedHosts: this.ctx.config.GIT_IMPORT_ALLOWED_HOSTS.split(',') });
    let sourceLabel = 'Project Hub (yeni)';
    if (input.source.type === 'git') sourceLabel = `Git · ${input.source.url.replace(/^https?:\/\//, '').replace(/\/\/[^@]*@/, '//')}`;
    let upload: typeof uploads.$inferSelect | undefined;
    if (input.source.type === 'upload') {
      upload = (await db.select().from(uploads).where(and(eq(uploads.id, input.source.uploadId), eq(uploads.userId, auth.user.id), eq(uploads.organizationId, auth.organizationId))))[0];
      if (!upload || upload.consumedAt || upload.expiresAt.getTime() < Date.now()) throw invalid('Yükleme bulunamadı veya süresi doldu; dosyayı tekrar yükleyin');
      sourceLabel = `Yükleme · ${upload.fileName}`;
    }

    const project = await db.transaction(async (tx) => {
      const p = (
        await tx
          .insert(projects)
          .values({
            organizationId: auth.organizationId,
            name: input.name,
            slug: input.slug,
            description: input.description,
            customerName: input.customerName,
            teamId: input.teamId,
            color: input.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)]!,
            defaultBranch: input.defaultBranch,
            ownerId: auth.user.id,
            createdBy: auth.user.id,
            sourceLabel,
            // Imported repositories are team-safe by default: code/terminal/AI changes go through review. Empty
            // starter projects stay editable on main so their setup flow and solo-project ergonomics are preserved.
            settings: {
              executionTrust: input.source.type === 'empty' ? 'trusted' : 'untrusted',
              ...(input.source.type === 'empty' ? {} : { protection: { branches: [input.defaultBranch], requiredApprovals: 1, requirePassingBuild: true } }),
            },
          })
          .returning()
      )[0]!;
      let upstreamSecretId: string | null = null;
      if (input.source.type === 'git' && input.source.accessToken) {
        upstreamSecretId = await putSecret(tx, this.ctx.config.encryptionKey, {
          organizationId: auth.organizationId,
          projectId: p.id,
          environmentId: null,
          name: 'GIT_UPSTREAM_TOKEN',
          value: input.source.accessToken,
          kind: 'credential',
          scope: 'all',
          system: 'git-upstream',
          createdBy: auth.user.id,
        });
      }
      await tx.insert(repositories).values({
        projectId: p.id,
        storageKey: this.ctx.storage.repoKey(p.id),
        defaultBranch: input.defaultBranch,
        upstreamUrl: input.source.type === 'git' ? input.source.url : null,
        upstreamSecretId,
        status: 'provisioning',
      });
      await tx.insert(projectMembers).values({ projectId: p.id, userId: auth.user.id });
      if (input.createDefaultEnvironments) {
        await tx.insert(environments).values([
          { organizationId: auth.organizationId, projectId: p.id, name: 'Development', slug: 'development', type: 'development' },
          { organizationId: auth.organizationId, projectId: p.id, name: 'Staging', slug: 'staging', type: 'staging' },
          { organizationId: auth.organizationId, projectId: p.id, name: 'Production', slug: 'production', type: 'production', requiresApproval: true },
        ]);
      }
      if (upload) await tx.update(uploads).set({ consumedAt: new Date() }).where(eq(uploads.id, upload.id));
      await enqueue(tx, {
        queue: QUEUES.git,
        type: 'repository.provision',
        organizationId: auth.organizationId,
        projectId: p.id,
        dedupeKey: `provision:${p.id}`,
        maxAttempts: 2,
        payload: {
          projectId: p.id,
          source: input.source.type,
          branch: input.source.type === 'git' ? (input.source.branch ?? null) : null,
          template: input.source.type === 'empty' ? (input.source.template ?? null) : null,
          uploadId: upload?.id ?? null,
          requestedBy: auth.user.id,
        },
      });
      await audit(tx, {
        organizationId: auth.organizationId,
        projectId: p.id,
        actor,
        action: 'project.created',
        resourceType: 'project',
        resourceId: p.id,
        metadata: { name: p.name, slug: p.slug, source: input.source.type },
      });
      await timeline(tx, {
        organizationId: auth.organizationId,
        projectId: p.id,
        kind: 'project',
        tone: 'run',
        title: 'Proje oluşturuldu',
        description: `${sourceLabel} · repository hazırlanıyor`,
        actorLabel: actor.label,
      });
      await emitDomainEvent(tx, { event: 'project.created', organizationId: auth.organizationId, projectId: p.id, actor, data: { name: p.name, slug: p.slug } });
      return p;
    });
    return summary(project);
  }

  async get(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const db = this.ctx.db;
    const p = scope.project;
    const repo = (await db.select().from(repositories).where(eq(repositories.projectId, p.id)))[0] ?? null;
    const owner = p.ownerId ? (await db.select({ id: users.id, displayName: users.displayName, avatarColor: users.avatarColor }).from(users).where(eq(users.id, p.ownerId)))[0] : null;
    const team = p.teamId ? (await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.id, p.teamId)))[0] : null;
    return {
      ...summary(p),
      detection: p.detection,
      settings: p.settings,
      owner: owner ?? null,
      team: team ?? null,
      repository: repo
        ? {
            status: repo.status,
            error: repo.error,
            defaultBranch: repo.defaultBranch,
            headCommit: repo.headCommit,
            sizeBytes: repo.sizeBytes,
            upstreamUrl: repo.upstreamUrl,
            lastPushedAt: repo.lastPushedAt,
            cloneUrl: `${this.ctx.config.APP_URL.replace(/\/$/, '')}/git/${p.id}.git`,
          }
        : null,
      permissions: [...scope.permissions].sort(),
      isMember: scope.isMember,
    };
  }

  async update(
    auth: AuthInfo,
    idOrSlug: string,
    input: { name?: string; description?: string; customerName?: string; teamId?: string | null; color?: string; status?: ProjectStatus; executionTrust?: 'trusted' | 'untrusted'; ownerId?: string | null; governance?: ProjectGovernance; automationPolicy?: ProjectAutomationPolicy; rolloutPolicy?: ProjectRolloutPolicy },
    actor: Actor,
  ) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'project.update');
    if (input.teamId) {
      const t = await this.ctx.db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, input.teamId), eq(teams.organizationId, auth.organizationId)));
      if (!t.length) throw notFound('Ekip');
    }
    const people = [input.ownerId, input.governance?.maintenanceOwnerId].filter((id): id is string => !!id);
    if (people.length) {
      const valid = await this.ctx.db.select({ id: organizationMembers.userId }).from(organizationMembers).where(and(eq(organizationMembers.organizationId, auth.organizationId), inArray(organizationMembers.userId, people), eq(organizationMembers.status, 'active')));
      if (new Set(valid.map((x) => x.id)).size !== new Set(people).size) throw invalid('Sahip olarak yalnızca aktif organizasyon kullanıcıları seçilebilir');
    }
    const { executionTrust, governance, automationPolicy, rolloutPolicy, ...fields } = input;
    const settings = {
      ...scope.project.settings,
      ...(executionTrust ? { executionTrust } : {}),
      ...(governance ? { governance } : {}),
      ...(automationPolicy ? { automationPolicy } : {}),
      ...(rolloutPolicy ? { rolloutPolicy } : {}),
    };
    // updatedAt keeps the statement valid when the body carried no known field (an empty SET is a database error).
    const update = { ...(executionTrust || governance || automationPolicy || rolloutPolicy ? { ...fields, settings } : fields), updatedAt: new Date() };
    const row = (await this.ctx.db.update(projects).set(update).where(eq(projects.id, scope.project.id)).returning())[0]!;
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: row.id, actor, action: 'project.updated', resourceType: 'project', resourceId: row.id, metadata: input });
    if (input.status && input.status !== scope.project.status) {
      await timeline(this.ctx.db, { organizationId: auth.organizationId, projectId: row.id, kind: 'project', title: `Proje durumu: ${input.status}`, actorLabel: actor.label });
    }
    return summary(row);
  }

  async intelligence(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const [entities, relations, currentObservations, capabilities] = await Promise.all([
      this.ctx.db.select().from(softwareEntities).where(and(eq(softwareEntities.organizationId, auth.organizationId), eq(softwareEntities.projectId, scope.project.id))).orderBy(softwareEntities.kind, softwareEntities.name),
      this.ctx.db.select().from(entityRelations).where(and(eq(entityRelations.organizationId, auth.organizationId), eq(entityRelations.projectId, scope.project.id))).orderBy(desc(entityRelations.updatedAt)),
      this.ctx.db.select().from(observations).where(and(eq(observations.organizationId, auth.organizationId), eq(observations.projectId, scope.project.id), isNull(observations.supersededAt))).orderBy(desc(observations.observedAt)).limit(200),
      this.ctx.db.select().from(capabilityProfiles).where(eq(capabilityProfiles.projectId, scope.project.id)).orderBy(desc(capabilityProfiles.observedAt)).limit(1),
    ]);
    const now = Date.now();
    const head = (await this.ctx.db.select({ head: repositories.headCommit }).from(repositories).where(eq(repositories.projectId, scope.project.id)))[0]?.head ?? null;
    const capability = capabilities[0] ?? null;
    const drift = [
      ...(capability && head && capability.revision !== head ? [{ kind: 'capability_revision', severity: 'high', message: 'Yetenek profili repository head revizyonunun gerisinde', expected: head, observed: capability.revision }] : []),
      ...relations.filter((r) => r.status !== 'active' || (r.validUntil?.getTime() ?? Infinity) < now).map((r) => ({ kind: 'relation', severity: 'medium', relationId: r.id, message: `${r.kind} ilişkisi ${r.status === 'active' ? 'süresi dolduğu' : r.status} için yeniden doğrulanmalı` })),
      ...currentObservations.filter((o) => (o.validUntil?.getTime() ?? Infinity) < now).map((o) => ({ kind: 'observation', severity: 'medium', observationId: o.id, message: `${o.key} gözleminin geçerlilik süresi doldu` })),
    ];
    return { revision: head, capability, entities, relations, observations: currentObservations, drift };
  }

  async featureFlags(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const rows = await this.ctx.db.select().from(featureFlags).where(and(eq(featureFlags.organizationId, auth.organizationId), eq(featureFlags.projectId, scope.project.id))).orderBy(desc(featureFlags.updatedAt));
    if (!rows.length) return [];
    const overrides = await this.ctx.db.select({ override: featureFlagOverrides, environmentName: environments.name, environmentType: environments.type }).from(featureFlagOverrides).innerJoin(environments, eq(environments.id, featureFlagOverrides.environmentId)).where(inArray(featureFlagOverrides.flagId, rows.map((r) => r.id)));
    return rows.map((flag) => ({ ...flag, overrides: overrides.filter((x) => x.override.flagId === flag.id).map((x) => ({ ...x.override, environmentName: x.environmentName, environmentType: x.environmentType })) }));
  }

  async createFeatureFlag(auth: AuthInfo, idOrSlug: string, input: FeatureFlagInput, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'project.update');
    if (input.ownerId) await this.assertOrgUser(auth.organizationId, input.ownerId);
    const row = (await this.ctx.db.insert(featureFlags).values({ organizationId: auth.organizationId, projectId: scope.project.id, ...input, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, createdBy: auth.user.id }).returning())[0]!;
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'feature_flag.created', resourceType: 'feature_flag', resourceId: row.id, metadata: { key: row.key, defaultEnabled: row.defaultEnabled } });
    return row;
  }

  async updateFeatureFlag(auth: AuthInfo, flagId: string, input: Partial<FeatureFlagInput> & { status?: 'active' | 'archived' }, actor: Actor) {
    const flag = await this.loadFeatureFlag(auth, flagId, true);
    if (input.ownerId) await this.assertOrgUser(auth.organizationId, input.ownerId);
    const { expiresAt, ...fields } = input;
    const row = (await this.ctx.db.update(featureFlags).set({ ...fields, ...(expiresAt !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}) }).where(eq(featureFlags.id, flag.id)).returning())[0]!;
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: flag.projectId, actor, action: 'feature_flag.updated', resourceType: 'feature_flag', resourceId: flag.id, metadata: input });
    return row;
  }

  async setFeatureFlagOverride(auth: AuthInfo, flagId: string, input: FeatureFlagOverrideInput, actor: Actor) {
    const flag = await this.loadFeatureFlag(auth, flagId, true);
    const env = (await this.ctx.db.select({ id: environments.id }).from(environments).where(and(eq(environments.id, input.environmentId), eq(environments.projectId, flag.projectId), eq(environments.organizationId, auth.organizationId))))[0];
    if (!env) throw notFound('Ortam');
    const row = (await this.ctx.db.insert(featureFlagOverrides).values({ flagId: flag.id, ...input, updatedBy: auth.user.id }).onConflictDoUpdate({ target: [featureFlagOverrides.flagId, featureFlagOverrides.environmentId], set: { enabled: input.enabled, rolloutPercentage: input.rolloutPercentage, rules: input.rules, updatedBy: auth.user.id, updatedAt: new Date() } }).returning())[0]!;
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: flag.projectId, actor, action: 'feature_flag.override_updated', resourceType: 'feature_flag', resourceId: flag.id, metadata: input });
    return row;
  }

  async evaluateFeatureFlag(auth: AuthInfo, idOrSlug: string, key: string, environmentId?: string, subject?: string, attributes: Record<string, string> = {}) {
    const scope = await this.access.require(auth, idOrSlug);
    const flag = (await this.ctx.db.select().from(featureFlags).where(and(eq(featureFlags.organizationId, auth.organizationId), eq(featureFlags.projectId, scope.project.id), eq(featureFlags.key, key), eq(featureFlags.status, 'active'))))[0];
    if (!flag) throw notFound('Feature flag');
    const override = environmentId ? (await this.ctx.db.select().from(featureFlagOverrides).where(and(eq(featureFlagOverrides.flagId, flag.id), eq(featureFlagOverrides.environmentId, environmentId))))[0] : null;
    if (!override) return { key, enabled: flag.defaultEnabled, reason: 'default', variant: flag.defaultEnabled ? 'on' : 'off' };
    const matches = !override.rules.length || override.rules.every((r) => matchFlagRule(attributes[r.attribute], r.operator, r.value));
    if (!matches) return { key, enabled: false, reason: 'targeting_miss', variant: 'off' };
    const bucket = subject ? Number.parseInt(sha256(`${flag.id}:${subject}`).slice(0, 8), 16) % 100 : 0;
    const enabled = override.enabled && bucket < override.rolloutPercentage;
    return { key, enabled, reason: override.rolloutPercentage < 100 ? 'percentage' : 'environment', variant: enabled ? 'on' : 'off', bucket, rolloutPercentage: override.rolloutPercentage };
  }

  private async assertOrgUser(organizationId: string, userId: string) {
    const row = await this.ctx.db.select({ id: organizationMembers.userId }).from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'active')));
    if (!row.length) throw invalid('Kullanıcı bu organizasyonda aktif değil');
  }

  private async loadFeatureFlag(auth: AuthInfo, flagId: string, writable = false) {
    const flag = (await this.ctx.db.select().from(featureFlags).where(and(eq(featureFlags.id, flagId), eq(featureFlags.organizationId, auth.organizationId))))[0];
    if (!flag) throw notFound('Feature flag');
    if (writable) await this.access.requireWritable(auth, flag.projectId, 'project.update');
    else await this.access.require(auth, flag.projectId);
    return flag;
  }

  /** Archiving keeps code, versions, docs and audit history; it stops previews and blocks deployments. */
  async archive(auth: AuthInfo, idOrSlug: string, confirmSlug: string, actor: Actor) {
    const scope = await this.access.require(auth, idOrSlug, 'project.archive');
    if (confirmSlug !== scope.project.slug) throw invalid('Onay için proje adresini (slug) aynen yazın');
    if (scope.project.status === 'archived') return summary(scope.project);
    const row = await this.ctx.db.transaction(async (tx) => {
      const r = (await tx.update(projects).set({ status: 'archived', archivedAt: new Date() }).where(eq(projects.id, scope.project.id)).returning())[0]!;
      const running = await tx.select({ id: previews.id }).from(previews).where(and(eq(previews.projectId, r.id), inArray(previews.status, ['queued', 'starting', 'ready'])));
      for (const pv of running) {
        await enqueue(tx, { queue: QUEUES.preview, type: 'preview.stop', projectId: r.id, organizationId: auth.organizationId, payload: { previewId: pv.id, reason: 'archived' } });
      }
      // Customer links would otherwise stay "active" while pointing at stopped previews.
      await tx
        .update(reviewSessions)
        .set({ revokedAt: new Date(), revokedBy: auth.user.id })
        .where(and(eq(reviewSessions.projectId, r.id), isNull(reviewSessions.revokedAt), sql`${reviewSessions.expiresAt} > now()`));
      await audit(tx, { organizationId: auth.organizationId, projectId: r.id, actor, action: 'project.archived', resourceType: 'project', resourceId: r.id });
      await timeline(tx, { organizationId: auth.organizationId, projectId: r.id, kind: 'project', title: 'Proje arşivlendi', description: 'Kod, sürümler ve geçmiş korunur; ön izlemeler durduruldu, kullanıcı linkleri kapatıldı, deployment kapalı.', actorLabel: actor.label });
      await emitDomainEvent(tx, { event: 'project.archived', organizationId: auth.organizationId, projectId: r.id, actor, data: { name: r.name } });
      return r;
    });
    return summary(row);
  }

  async unarchive(auth: AuthInfo, idOrSlug: string, actor: Actor) {
    const scope = await this.access.require(auth, idOrSlug, 'project.archive');
    const row = (await this.ctx.db.update(projects).set({ status: 'maintenance', archivedAt: null }).where(eq(projects.id, scope.project.id)).returning())[0]!;
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: row.id, actor, action: 'project.unarchived', resourceType: 'project', resourceId: row.id });
    await timeline(this.ctx.db, { organizationId: auth.organizationId, projectId: row.id, kind: 'project', title: 'Proje arşivden çıkarıldı', actorLabel: actor.label });
    return summary(row);
  }

  /* ---------------- members ---------------- */

  async members(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    return this.ctx.db
      .select({
        userId: users.id,
        displayName: users.displayName,
        email: users.email,
        title: users.title,
        avatarColor: users.avatarColor,
        roleId: projectMembers.roleId,
        roleName: roles.name,
        addedAt: projectMembers.createdAt,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .leftJoin(roles, eq(roles.id, projectMembers.roleId))
      .where(eq(projectMembers.projectId, scope.project.id))
      .orderBy(users.displayName);
  }

  async addMember(auth: AuthInfo, idOrSlug: string, input: { userId: string; roleId: string | null }, actor: Actor) {
    const scope = await this.access.require(auth, idOrSlug, 'project.members.manage');
    const db = this.ctx.db;
    const m = await db.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, auth.organizationId), eq(organizationMembers.userId, input.userId)));
    if (!m.length) throw notFound('Kullanıcı');
    if (input.roleId) {
      const r = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.id, input.roleId), or(isNull(roles.organizationId), eq(roles.organizationId, auth.organizationId))));
      if (!r.length) throw notFound('Rol');
    }
    await db
      .insert(projectMembers)
      .values({ projectId: scope.project.id, userId: input.userId, roleId: input.roleId })
      .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { roleId: input.roleId } });
    await audit(db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'project.member_set', resourceType: 'user', resourceId: input.userId, metadata: { roleId: input.roleId } });
    return this.members(auth, idOrSlug);
  }

  async removeMember(auth: AuthInfo, idOrSlug: string, userId: string, actor: Actor) {
    const scope = await this.access.require(auth, idOrSlug, 'project.members.manage');
    const remaining = await this.ctx.db.select({ n: count() }).from(projectMembers).where(and(eq(projectMembers.projectId, scope.project.id), ne(projectMembers.userId, userId)));
    if ((remaining[0]?.n ?? 0) === 0) throw forbidden('Projenin en az bir üyesi kalmalı');
    await this.ctx.db.delete(projectMembers).where(and(eq(projectMembers.projectId, scope.project.id), eq(projectMembers.userId, userId)));
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'project.member_removed', resourceType: 'user', resourceId: userId });
    return this.members(auth, idOrSlug);
  }

  /* ---------------- manifest ---------------- */

  /** The effective manifest: projecthub.yml in the default branch wins over the stored (detected/manual) one. */
  async manifest(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const stored = (await this.ctx.db.select().from(projectManifests).where(eq(projectManifests.projectId, scope.project.id)).orderBy(desc(projectManifests.version)).limit(1))[0];
    let repoText: string | null = null;
    let repoError: string | null = null;
    try {
      const { git } = await this.repos.forProject(scope.project.id);
      const head = await git.resolve(`refs/heads/${scope.project.defaultBranch}`);
      if (head) repoText = (await git.readFile(head, MANIFEST_FILE))?.content.toString('utf8') ?? null;
    } catch {
      /* repository not ready yet */
    }
    let manifest: Manifest | null = stored?.content ?? null;
    let source: string = stored?.source ?? 'none';
    if (repoText !== null) {
      try {
        manifest = parseManifest(repoText);
        source = 'repository';
      } catch (e) {
        repoError = (e as Error).message;
      }
    }
    return {
      source,
      manifest,
      yaml: repoText ?? (manifest ? serializeManifest(manifest) : null),
      inRepository: repoText !== null,
      repositoryError: repoError,
      detection: scope.project.detection,
      storedVersion: stored?.version ?? null,
    };
  }

  /** Saves a manifest. With commit=true it is committed as projecthub.yml to the default branch. */
  async saveManifest(auth: AuthInfo, idOrSlug: string, yamlText: string, commit: boolean, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'project.update');
    const manifest = parseManifest(yamlText);
    let commitSha: string | null = null;
    if (commit) {
      if (!scope.can('repository.push')) throw forbidden('Repository\'ye yazma yetkiniz yok');
      const { git } = await this.repos.forProject(scope.project.id);
      const branch = scope.project.defaultBranch;
      const base = await git.resolve(`refs/heads/${branch}`);
      commitSha = await git.commitChanges({
        branch,
        baseCommit: base,
        message: 'Update projecthub.yml',
        author: { name: auth.user.displayName, email: auth.user.email },
        changes: [{ action: 'upsert', path: MANIFEST_FILE, content: yamlText.endsWith('\n') ? yamlText : `${yamlText}\n` }],
      });
    }
    await this.ctx.db.transaction(async (tx) => {
      const last = (await tx.select({ v: projectManifests.version }).from(projectManifests).where(eq(projectManifests.projectId, scope.project.id)).orderBy(desc(projectManifests.version)).limit(1))[0]?.v ?? 0;
      await tx.insert(projectManifests).values({ projectId: scope.project.id, version: last + 1, source: commit ? 'repository' : 'manual', commitSha, content: manifest, createdBy: auth.user.id });
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'project.manifest_updated', resourceType: 'project', resourceId: scope.project.id, metadata: { commit: commitSha } });
      await timeline(tx, { organizationId: auth.organizationId, projectId: scope.project.id, kind: commitSha ? 'commit' : 'project', title: 'Manifest güncellendi', description: commitSha ? `projecthub.yml · ${commitSha.slice(0, 7)}` : 'projecthub.yml (Project Hub kaydı)', actorLabel: actor.label });
      if (commitSha) await this.afterPush(tx, scope.project.id, auth.organizationId, scope.project.defaultBranch);
    });
    return this.manifest(auth, idOrSlug);
  }

  /** Jobs that keep derived data fresh after the default branch changes (index, security scan). */
  async afterPush(tx: Executor, projectId: string, organizationId: string, branch: string) {
    await enqueue(tx, { queue: QUEUES.index, type: 'code.index', projectId, organizationId, dedupeKey: `index:${projectId}`, payload: { projectId, branch } });
    await enqueue(tx, {
      queue: QUEUES.security,
      type: 'security.scan',
      projectId,
      organizationId,
      dedupeKey: `scan:${projectId}`,
      runAt: new Date(Date.now() + 5_000),
      payload: { projectId, branch, trigger: 'push' },
    });
    await publish(tx, { type: 'repository.updated', organizationId, projectId });
  }

  async redetect(auth: AuthInfo, idOrSlug: string, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'project.update');
    await enqueue(this.ctx.db, { queue: QUEUES.git, type: 'project.detect', projectId: scope.project.id, organizationId: auth.organizationId, dedupeKey: `detect:${scope.project.id}`, payload: { projectId: scope.project.id } });
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'project.detect_requested', resourceType: 'project', resourceId: scope.project.id });
    return { queued: true };
  }

  async syncUpstream(auth: AuthInfo, idOrSlug: string, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'repository.push');
    const repo = (await this.ctx.db.select().from(repositories).where(eq(repositories.projectId, scope.project.id)))[0];
    if (!repo?.upstreamUrl) throw invalid('Bu proje harici bir Git kaynağından içe aktarılmamış');
    await enqueue(this.ctx.db, { queue: QUEUES.git, type: 'repository.sync', projectId: scope.project.id, organizationId: auth.organizationId, dedupeKey: `sync:${scope.project.id}`, payload: { projectId: scope.project.id, requestedBy: auth.user.id } });
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'repository.sync_requested', resourceType: 'repository', resourceId: repo.id });
    return { queued: true };
  }

  /* ---------------- timeline / overview ---------------- */

  async timeline(auth: AuthInfo, idOrSlug: string, q: { kind?: string; cursor?: string; limit?: number }) {
    const scope = await this.access.require(auth, idOrSlug);
    const limit = Math.min(q.limit ?? 50, 200);
    const conds: SQL[] = [eq(projectEvents.projectId, scope.project.id)];
    if (q.kind) conds.push(eq(projectEvents.kind, q.kind as never));
    if (q.cursor) conds.push(lt(projectEvents.createdAt, new Date(q.cursor)));
    const rows = await this.ctx.db.select().from(projectEvents).where(and(...conds)).orderBy(desc(projectEvents.createdAt)).limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return new Paged(page, { hasMore, nextCursor: hasMore ? page.at(-1)!.createdAt.toISOString() : null });
  }

  async overview(auth: AuthInfo, idOrSlug: string) {
    const project = await this.get(auth, idOrSlug);
    const db = this.ctx.db;
    const pid = project.id;
    const [lastBuild] = await db.select().from(builds).where(eq(builds.projectId, pid)).orderBy(desc(builds.createdAt)).limit(1);
    const [buildStats] = await db.execute<{ total: number; passed: number }>(
      sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'passed')::int AS passed FROM (SELECT status FROM builds WHERE project_id = ${pid} AND status IN ('passed','failed') ORDER BY created_at DESC LIMIT 20) b`,
    ).then((r) => r.rows);
    const [openFeedback] = await db.select({ n: count() }).from(feedback).where(and(eq(feedback.projectId, pid), inArray(feedback.status, OPEN_FEEDBACK_STATUSES)));
    const [runningPreviews] = await db.select({ n: count() }).from(previews).where(and(eq(previews.projectId, pid), eq(previews.status, 'ready')));
    const [lastScan] = await db.select().from(securityScans).where(and(eq(securityScans.projectId, pid), eq(securityScans.status, 'completed'))).orderBy(desc(securityScans.createdAt)).limit(1);
    const envs = await db
      .select({ env: environments, version: versions.version })
      .from(environments)
      .leftJoin(versions, eq(versions.id, environments.currentVersionId))
      .where(eq(environments.projectId, pid))
      .orderBy(sql`CASE ${environments.type} WHEN 'development' THEN 0 WHEN 'staging' THEN 1 WHEN 'production' THEN 2 ELSE 3 END`);
    const recentDeploys = await db
      .select({ d: deployments, envName: environments.name, version: versions.version, by: users.displayName })
      .from(deployments)
      .innerJoin(environments, eq(environments.id, deployments.environmentId))
      .innerJoin(versions, eq(versions.id, deployments.versionId))
      .leftJoin(users, eq(users.id, deployments.requestedBy))
      .where(eq(deployments.projectId, pid))
      .orderBy(desc(deployments.createdAt))
      .limit(5);
    const [openIncidents] = await db.select({ n: count() }).from(incidents).where(and(eq(incidents.projectId, pid), eq(incidents.status, 'open')));
    const events = await db.select().from(projectEvents).where(eq(projectEvents.projectId, pid)).orderBy(desc(projectEvents.createdAt)).limit(10);
    return {
      project,
      lastBuild: lastBuild ?? null,
      buildSuccessRate: buildStats && buildStats.total ? buildStats.passed / buildStats.total : null,
      openFeedback: openFeedback?.n ?? 0,
      runningPreviews: runningPreviews?.n ?? 0,
      security: lastScan ? { score: lastScan.score, summary: lastScan.summary, scannedAt: lastScan.finishedAt, commitSha: lastScan.commitSha } : null,
      environments: envs.map((e) => ({ ...e.env, currentVersion: e.version })),
      recentDeployments: recentDeploys.map((r) => ({ ...r.d, environmentName: r.envName, version: r.version, requestedByName: r.by })),
      openIncidents: openIncidents?.n ?? 0,
      health: (project.settings as { health?: unknown }).health ?? null,
      techDebt: (project.settings as { techDebt?: unknown }).techDebt ?? null,
      events,
    };
  }
}

export function summary(p: typeof projects.$inferSelect) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    status: p.status,
    projectType: p.projectType,
    technologies: p.technologies,
    customerName: p.customerName,
    color: p.color,
    defaultBranch: p.defaultBranch,
    sourceLabel: p.sourceLabel,
    currentVersion: p.currentVersion,
    healthScore: p.healthScore,
    securityScore: p.securityScore,
    teamId: p.teamId,
    ownerId: p.ownerId,
    archivedAt: p.archivedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export type ProjectSummary = ReturnType<typeof summary>;
export type { ProjectScope };
