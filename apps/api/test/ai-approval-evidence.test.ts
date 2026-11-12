import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { GitRepository, parseManifest, Storage } from '@projecthub/core';
import { aiTasks, builds, organizations, projects, repositories } from '@projecthub/database';
import { ADMIN, client, startHarness, type Harness } from './harness.js';

let h: Harness;
const admin = client(() => h.base);
let git: GitRepository;
let project: typeof projects.$inferSelect;
let base: string;
let sequence = 0;
beforeAll(async () => {
  h = await startHarness();
  expect((await admin.post('/auth/login', ADMIN)).status).toBe(200);
  const org = (await h.server.handle.db.select().from(organizations))[0]!;
  project = (await h.server.handle.db.insert(projects).values({ organizationId: org.id, name: 'Approval evidence', slug: 'approval-evidence' }).returning())[0]!;
  const storage = new Storage(h.config.storageDir);
  const key = storage.repoKey(project.id);
  git = await GitRepository.initBare(storage.resolve(key), 'main');
  base = await git.commitChanges({ branch: 'main', baseCommit: null, message: 'init', author: { name: 'Fixture', email: 'fixture@example.com' }, changes: [{ action: 'upsert', path: 'README.md', content: 'base' }] });
  await h.server.handle.db.insert(repositories).values({ projectId: project.id, storageKey: key, status: 'ready', defaultBranch: 'main', headCommit: base });
});
afterAll(async () => h?.close());

async function proposal(status: 'passed' | 'cancelled', stale = false, target = 'main') {
  const number = ++sequence;
  const current = (await git.resolve(`refs/heads/${target}`))!;
  const branch = `ai/evidence-${number}`;
  await git.createBranch(branch, current);
  const head = await git.commitChanges({ branch, baseCommit: current, message: 'fix', author: { name: 'Fixture', email: 'fixture@example.com' }, changes: [{ action: 'upsert', path: `fix-${number}.txt`, content: 'verified fixture' }] });
  const build = (await h.server.handle.db.insert(builds).values({ organizationId: project.organizationId, projectId: project.id, number, branch, commitSha: stale ? current : head, status, trigger: 'ai', triggeredByType: 'ai', manifest: parseManifest('project:\n  name: Evidence\nruntime:\n  type: node\n') }).returning())[0]!;
  const task = (await h.server.handle.db.insert(aiTasks).values({ organizationId: project.organizationId, projectId: project.id, number, title: 'Fixture fix', type: 'fix', autonomyLevel: 'L2', status: 'awaiting_approval', sourceType: 'manual', branch, baseBranch: target, baseCommit: current, headCommit: head, buildId: build.id }).returning())[0]!;
  return { task, head, current };
}
it('refuses cancelled verification instead of treating cancellation as success', async () => {
  const p = await proposal('cancelled');
  const response = await admin.post(`/ai/tasks/${p.task.id}/approve`, {});
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.error?.message).toContain('başarıyla tamamlanmadı');
  expect(await git.resolve('refs/heads/main')).toBe(p.current);
});
it('refuses a passed build for a different commit', async () => {
  const p = await proposal('passed', true);
  const response = await admin.post(`/ai/tasks/${p.task.id}/approve`, {});
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.error?.message).toContain('commit');
  expect(await git.resolve('refs/heads/main')).toBe(p.current);
});
it('updates the catalogue atomically after a verified human main approval', async () => {
  const p = await proposal('passed');
  const response = await admin.post(`/ai/tasks/${p.task.id}/approve`, {});
  expect(response.status, JSON.stringify(response.error)).toBe(201);
  const actual = await git.resolve('refs/heads/main');
  expect(actual).not.toBe(p.current);
  expect((await h.server.handle.db.select().from(repositories).where(eq(repositories.projectId, project.id)))[0]!.headCommit).toBe(actual);
});
it('does not replace the default-branch catalogue head when approving a feature branch', async () => {
  const main = (await git.resolve('refs/heads/main'))!;
  await git.createBranch('feature/scoped', main);
  const p = await proposal('passed', false, 'feature/scoped');
  expect((await admin.post(`/ai/tasks/${p.task.id}/approve`, {})).status).toBe(201);
  expect(await git.resolve('refs/heads/main')).toBe(main);
  expect((await h.server.handle.db.select().from(repositories).where(eq(repositories.projectId, project.id)))[0]!.headCommit).toBe(main);
});
