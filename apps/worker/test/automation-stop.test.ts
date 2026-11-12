import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeferJobError, PermanentJobError, type JobContext } from '@projecthub/core';
import { organizations, projects, type DatabaseHandle } from '@projecthub/database';
import { freshDatabase } from '../../../test/support/db.js';
import { assertAutomationAllowed } from '../src/handlers.js';
import type { WorkerCtx } from '../src/context.js';

let h: DatabaseHandle;
let organizationId: string;
let governedOrganizationId: string;
let governedProjectId: string;

beforeAll(async () => {
  h = await freshDatabase();
  organizationId = (
    await h.db
      .insert(organizations)
      .values({
        name: 'Automation Stop',
        slug: 'automation-stop',
        settings: { automation: { emergencyStop: true, reason: 'Bakım', pausedJobTypes: ['security.scan'] } },
      })
      .returning({ id: organizations.id })
  )[0]!.id;
  governedOrganizationId = (await h.db.insert(organizations).values({ name: 'Governed Automation', slug: 'governed-automation' }).returning({ id: organizations.id }))[0]!.id;
  governedProjectId = (await h.db.insert(projects).values({ organizationId: governedOrganizationId, name: 'Policy Project', slug: 'policy-project', settings: { automationPolicy: { maxConcurrentRuns: 2, maxRetries: 2, maxWorkflowDepth: 5 } } }).returning({ id: projects.id }))[0]!.id;
});

afterAll(async () => h.close());

const context = (type: string) =>
  ({ job: { type, organizationId }, logger: {}, signal: new AbortController().signal }) as unknown as JobContext;
const governedContext = (attempts: number) =>
  ({ job: { type: 'build.execute', organizationId: governedOrganizationId, projectId: governedProjectId, attempts, payload: {} }, logger: {}, signal: new AbortController().signal }) as unknown as JobContext;
// Policy only: the memory guard (tested in hardening.test.ts) must not depend on this machine's free RAM here.
const worker = () => ({ db: h.db, config: { MIN_FREE_MEMORY_MB: 0 } }) as unknown as WorkerCtx;

describe('organization automation emergency stop', () => {
  it('defers high-impact work without consuming or dropping the job', async () => {
    await expect(assertAutomationAllowed(worker(), context('deployment.execute'))).rejects.toBeInstanceOf(DeferJobError);
  });

  it('also honors a fine-grained paused job type', async () => {
    await expect(assertAutomationAllowed(worker(), context('security.scan'))).rejects.toThrow('duraklatıldı');
  });

  it('keeps health and notification-safe work running during the stop', async () => {
    await expect(assertAutomationAllowed(worker(), context('project.health'))).resolves.toBeUndefined();
  });

  it('stops retry storms at the project policy limit', async () => {
    await expect(assertAutomationAllowed(worker(), governedContext(3))).resolves.toBeUndefined();
    await expect(assertAutomationAllowed(worker(), governedContext(4))).rejects.toBeInstanceOf(PermanentJobError);
  });
});
