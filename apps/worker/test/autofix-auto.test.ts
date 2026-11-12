import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, loadConfig, Storage, type JobContext } from '@projecthub/core';
import { aiTasks, organizations, projects, securityFindings, securityScans, type DatabaseHandle } from '@projecthub/database';
import { freshDatabase } from '../../../test/support/db.js';
import type { WorkerCtx } from '../src/context.js';
import { autofixAuto } from '../src/jobs/autofix.js';

let h: DatabaseHandle;
let tmp: string;
let ctx: WorkerCtx;
const logger = createLogger('test', 'silent');
const job = (projectId: string) => ({ job: { id: 'j', type: 'autofix.auto', payload: { projectId }, attempts: 1, maxAttempts: 1 }, logger, signal: new AbortController().signal }) as unknown as JobContext;

beforeAll(async () => {
  h = await freshDatabase();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-autofix-'));
  const config = loadConfig({ ...process.env, STORAGE_DIR: tmp, AI_ENABLED: 'false' }, { cwd: tmp });
  ctx = { config, db: h.db, pool: h.pool, storage: new Storage(config.storageDir), logger, workerId: 'test-worker' };
});

afterAll(async () => {
  await h?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('automatic fixes', () => {
  it('does not fill the automatic queue with optional major-version migrations', async () => {
    const org = (await h.db.insert(organizations).values({ name: 'Optional', slug: 'optional', settings: { ai: { autonomyLevel: 'L2' } } }).returning())[0]!;
    const project = (await h.db.insert(projects).values({ organizationId: org.id, name: 'Optional', slug: 'optional', settings: { executionTrust: 'trusted' } }).returning())[0]!;
    const scan = (await h.db.insert(securityScans).values({ organizationId: org.id, projectId: project.id, status: 'completed' }).returning())[0]!;
    await h.db.insert(securityFindings).values({ organizationId: org.id, projectId: project.id, lastScanId: scan.id, number: 1, severity: 'info', type: 'dependency', ruleId: 'dependency/outdated-major', title: 'Optional TypeScript upgrade', filePath: 'frontend/package-lock.json', packageName: 'typescript', packageVersion: '5.9.0', fixedVersion: '6.0.0', fingerprint: 'fp-major' });
    expect(await autofixAuto(ctx, job(project.id))).toEqual({ started: 0 });
    expect(await h.db.select().from(aiTasks).where(eq(aiTasks.projectId, project.id))).toHaveLength(0);
  });

  it('does not open a duplicate while an older fix for the same problem still waits for approval', async () => {
    const org = (await h.db.insert(organizations).values({ name: 'Org', slug: 'org', settings: { ai: { autonomyLevel: 'L2' } } }).returning())[0]!;
    const project = (await h.db.insert(projects).values({ organizationId: org.id, name: 'Form', slug: 'form', settings: { executionTrust: 'trusted' } }).returning())[0]!;
    const scan = (await h.db.insert(securityScans).values({ organizationId: org.id, projectId: project.id, status: 'completed' }).returning())[0]!;
    const finding = (
      await h.db
        .insert(securityFindings)
        .values({ organizationId: org.id, projectId: project.id, lastScanId: scan.id, number: 1, severity: 'high', type: 'secret', ruleId: 'secret/env-file', title: '.env repoda', filePath: 'backend/.env', fingerprint: 'fp-env' })
        .returning()
    )[0]!;
    // Prepared three days ago and never decided: older than the 24-hour retry window.
    await h.db.insert(aiTasks).values({
      organizationId: org.id,
      projectId: project.id,
      number: 1,
      type: 'fix',
      title: 'Repoya eklenmiş gizli/üretilmiş dosyaları kaldır (1)',
      instruction: 'x',
      autonomyLevel: 'L2',
      sourceType: 'finding',
      sourceId: finding.id,
      baseBranch: 'main',
      status: 'awaiting_approval',
      autofix: { key: 'secret-env-files', kind: 'secret', mode: 'files', risk: 'high', findingIds: [finding.id] },
      createdAt: new Date(Date.now() - 3 * 86_400_000),
    } as typeof aiTasks.$inferInsert);

    expect(await autofixAuto(ctx, job(project.id))).toEqual({ started: 0 });
    expect(await h.db.select().from(aiTasks).where(eq(aiTasks.projectId, project.id))).toHaveLength(1);
  });
});
