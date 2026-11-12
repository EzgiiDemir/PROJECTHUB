import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventRecords, organizations, projects, workflowRuns, type DatabaseHandle } from '@projecthub/database';
import { deriveCapabilityProfile, recordEvent, startWorkflow } from '../src/orchestration.js';
import { parseManifest } from '../src/manifest.js';
import { freshDatabase } from '../../../test/support/db.js';

let h: DatabaseHandle;
let organizationId: string;
let projectId: string;

beforeAll(async () => {
  h = await freshDatabase();
  organizationId = (await h.db.insert(organizations).values({ name: 'Orchestration', slug: 'orchestration' }).returning())[0]!.id;
  projectId = (await h.db.insert(projects).values({ organizationId, name: 'Project', slug: 'project' }).returning())[0]!.id;
});

afterAll(async () => h.close());

describe('durable orchestration backbone', () => {
  it('stores ordered immutable events with correlation', async () => {
    const first = await recordEvent(h.db, { eventType: 'test.started', organizationId, projectId, payload: { n: 1 } });
    const second = await recordEvent(h.db, { eventType: 'test.finished', organizationId, projectId, correlationId: first.correlationId, causationId: first.id, payload: { n: 2 } });
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(second).toMatchObject({ correlationId: first.correlationId, causationId: first.id });
    await expect(h.db.update(eventRecords).set({ eventType: 'rewritten' }).where(eq(eventRecords.id, first.id))).rejects.toThrow();
    expect((await h.db.select().from(eventRecords).where(eq(eventRecords.id, first.id)))[0]!.eventType).toBe('test.started');
  });

  it('deduplicates workflow starts by organization and idempotency key', async () => {
    const input = {
      organizationId,
      projectId,
      definitionKey: 'security.autofix',
      title: 'Fix finding',
      triggerType: 'finding',
      triggerRef: 'SEC-1',
      requestedByType: 'system' as const,
      idempotencyKey: 'finding:SEC-1:revision:abc',
    };
    const a = await startWorkflow(h.db, input);
    const b = await startWorkflow(h.db, input);
    expect(b.id).toBe(a.id);
    expect(await h.db.select().from(workflowRuns).where(eq(workflowRuns.idempotencyKey, input.idempotencyKey))).toHaveLength(1);
  });

  it('derives an explicit capability profile instead of applying every workflow to every project', () => {
    const profile = deriveCapabilityProfile(
      parseManifest(`project:\n  name: Static\nruntime:\n  type: static\npreview:\n  enabled: true\nsecurity:\n  dependencyScan: false\n  secretScan: true\n`),
    );
    expect(profile.build.status).toBe('supported');
    expect(profile.preview.status).toBe('supported');
    expect(profile.database.status).toBe('unsupported');
    expect(profile.dependency_scan.status).toBe('unsupported');
  });
});
