import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilityProfiles, entityRelations, observations, softwareEntities } from '@projecthub/database';
import { ADMIN, client as makeClient, startHarness, type Harness } from './harness.js';

let h: Harness;
const admin = makeClient(() => h.base);
let projectId = '';
let organizationId = '';
let staging = '';
let otherEnvironment = '';

beforeAll(async () => {
  h = await startHarness();
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  const me = (await admin.get('/auth/me')).data as { organization: { id: string } };
  organizationId = me.organization.id;
  projectId = ((await admin.post('/projects', { name: 'Yönetişim', slug: 'yonetisim', source: { type: 'empty', template: 'static' } })).data as { id: string }).id;
  staging = ((await admin.get('/projects/yonetisim/environments')).data as { id: string; type: string }[]).find((e) => e.type === 'staging')!.id;
  await admin.post('/projects', { name: 'Başka Proje', slug: 'baska-proje', source: { type: 'empty', template: 'static' } });
  otherEnvironment = ((await admin.get('/projects/baska-proje/environments')).data as { id: string }[])[0]!.id;
});

afterAll(async () => h.close());

describe('project governance, catalog and feature flags', () => {
  it('stores validated ownership, automation and rollout policy', async () => {
    const me = (await admin.get('/auth/me')).data as { user: { id: string } };
    const body = {
      ownerId: me.user.id,
      governance: { lifecycleStage: 'production', maintenanceOwnerId: me.user.id, runbookUrl: 'https://example.com/runbook', runbookPath: 'docs/runbook.md', criticality: 'critical', dataClassification: 'restricted', rtoMinutes: 30, rpoMinutes: 5 },
      automationPolicy: { automaticDiscovery: true, automaticSecurityScan: true, automaticBuild: true, automaticLowRiskFix: false, stagingDeployment: 'automatic', productionDeployment: 'approval_required', maxConcurrentRuns: 2, maxRetries: 2, maxWorkflowDepth: 5 },
      rolloutPolicy: { strategy: 'feature_flag', initialPercentage: 10, stepPercentage: 25, minimumHealthyMinutes: 15, maximumErrorRatePercent: 2, automaticRollback: true },
    };
    expect((await admin.patch('/projects/yonetisim', body)).status).toBe(200);
    const project = (await admin.get('/projects/yonetisim')).data as { ownerId: string; settings: typeof body };
    expect(project.ownerId).toBe(me.user.id);
    expect(project.settings.governance).toMatchObject({ lifecycleStage: 'production', criticality: 'critical', rtoMinutes: 30 });
    expect(project.settings.automationPolicy).toMatchObject({ automaticBuild: true, maxConcurrentRuns: 2 });
    expect(project.settings.rolloutPolicy).toMatchObject({ strategy: 'feature_flag', automaticRollback: true });
    expect((await admin.patch('/projects/yonetisim', { ownerId: '00000000-0000-4000-8000-000000000001' })).status).toBe(400);
  });

  it('evaluates percentage flags deterministically and rejects cross-project overrides', async () => {
    const created = await admin.post('/projects/yonetisim/feature-flags', { key: 'new.checkout', name: 'Yeni ödeme', description: 'Kontrollü ödeme akışı', defaultEnabled: false, ownerId: null, tags: ['checkout'], expiresAt: null });
    expect(created.status).toBe(201);
    const id = (created.data as { id: string }).id;
    expect((await admin.put(`/feature-flags/${id}/override`, { environmentId: otherEnvironment, enabled: true, rolloutPercentage: 25, rules: [] })).status).toBe(404);
    expect((await admin.put(`/feature-flags/${id}/override`, { environmentId: staging, enabled: true, rolloutPercentage: 30, rules: [] })).status).toBe(200);
    const one = (await admin.get(`/projects/yonetisim/feature-flags/evaluate?key=new.checkout&environmentId=${staging}&subject=user-42`)).data as { enabled: boolean; bucket: number; reason: string };
    const two = (await admin.get(`/projects/yonetisim/feature-flags/evaluate?key=new.checkout&environmentId=${staging}&subject=user-42`)).data as typeof one;
    expect(two).toEqual(one);
    expect(one.reason).toBe('percentage');
    expect(one.enabled).toBe(one.bucket < 30);
    const list = (await admin.get('/projects/yonetisim/feature-flags')).data as { key: string; overrides: unknown[] }[];
    expect(list).toEqual([expect.objectContaining({ key: 'new.checkout', overrides: [expect.objectContaining({ environmentId: staging, rolloutPercentage: 30 })] })]);
    expect((await admin.patch(`/feature-flags/${id}`, { status: 'archived' })).status).toBe(200);
    expect((await admin.get(`/projects/yonetisim/feature-flags/evaluate?key=new.checkout&environmentId=${staging}&subject=user-42`)).status).toBe(404);
  });

  it('exposes catalog evidence and drift instead of presenting stale facts as current', async () => {
    const project = (await h.server.handle.db.insert(softwareEntities).values({ organizationId, projectId, kind: 'project', externalKey: `project:${projectId}`, name: 'Yönetişim' }).returning())[0]!;
    const repo = (await h.server.handle.db.insert(softwareEntities).values({ organizationId, projectId, kind: 'repository', externalKey: `repository:${projectId}`, name: 'Yönetişim repository' }).returning())[0]!;
    await h.server.handle.db.insert(entityRelations).values({ organizationId, projectId, fromEntityId: project.id, toEntityId: repo.id, kind: 'HAS_REPOSITORY', status: 'stale', detectionMethod: 'test', sourceType: 'repository_index', sourceRef: 'old', confidence: 'high' });
    await h.server.handle.db.insert(observations).values({ organizationId, projectId, entityId: repo.id, subjectType: 'repository', subjectId: projectId, key: 'head_commit', value: { commit: 'old' }, sourceType: 'git', sourceRef: 'old', confidence: 'verified' });
    await h.server.handle.db.insert(capabilityProfiles).values({ projectId, revision: 'old', status: 'stale', capabilities: { build: { status: 'supported' } }, source: 'test' });
    const data = (await admin.get('/projects/yonetisim/intelligence')).data as { entities: unknown[]; relations: unknown[]; observations: unknown[]; drift: { kind: string }[] };
    expect(data.entities).toHaveLength(2);
    expect(data.relations).toHaveLength(1);
    expect(data.observations).toHaveLength(1);
    expect(data.drift).toContainEqual(expect.objectContaining({ kind: 'relation' }));
  });

  it('tracks secret expiry and rotation policy without returning its value', async () => {
    expect((await admin.post('/projects/yonetisim/secrets', { name: 'LEGACY_API_KEY', value: 'never-return-this', kind: 'api_key', scope: 'all', environmentId: null, rotationIntervalDays: 30, expiresAt: new Date(Date.now() - 60_000).toISOString() })).status).toBe(201);
    const rows = (await admin.get('/projects/yonetisim/secrets')).data as { name: string; rotationIntervalDays: number; rotationStatus: string; expiresAt: string; value?: string }[];
    expect(rows).toContainEqual(expect.objectContaining({ name: 'LEGACY_API_KEY', rotationIntervalDays: 30, rotationStatus: 'expired' }));
    expect(rows.find((s) => s.name === 'LEGACY_API_KEY')).not.toHaveProperty('value');
  });

  it('reports AI quality and regression metrics from durable task evidence', async () => {
    const response = await admin.get('/admin/ai/usage');
    expect(response.status, JSON.stringify(response.error)).toBe(200);
    const usage = response.data as { quality: { total: number; completionRate: number | null; regressionRate: number | null; tokensPerVerifiedTask: number | null } };
    expect(usage.quality).toMatchObject({ total: 0, completionRate: null, regressionRate: null, tokensPerVerifiedTask: null });
  });
});
