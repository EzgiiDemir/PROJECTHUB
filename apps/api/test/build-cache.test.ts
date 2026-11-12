import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client, startHarness, waitFor, type Harness } from './harness.js';

/** An install that takes a dependency into node_modules, and a build that needs it. */
const FILES = {
  'projecthub.yml': `project:
  name: Önbellek
runtime:
  type: node
install:
  command: node install.mjs
build:
  command: node build.mjs
`,
  'package.json': '{"name":"onbellek","version":"1.0.0"}\n',
  'package-lock.json': '{"lockfileVersion":3,"packages":{"":{"name":"onbellek"}}}\n',
  // Imported projects often commit their dependencies: on a cache hit they are not checked out at all.
  'node_modules/committed/index.mjs': 'export const old = true;\n',
  'install.mjs': `import fs from 'node:fs';
fs.mkdirSync('node_modules/dep', { recursive: true });
fs.writeFileSync('node_modules/dep/index.mjs', 'export const answer = 42;');
console.log('installed');
`,
  'build.mjs': `const { answer } = await import('./node_modules/dep/index.mjs');
if (answer !== 42) process.exit(1);
console.log('built with dep');
`,
};

let h: Harness;
const api = client(() => h.base);
const slug = 'onbellek';
type Step = { key: string; status: string; summary?: string | null };

async function commit(changes: Record<string, string>, message: string) {
  const head = ((await api.get(`/projects/${slug}/repo/branches`)).data as { branches: { name: string; sha: string }[] }).branches.find((b) => b.name === 'main')!.sha;
  const r = await api.post(`/projects/${slug}/repo/commits`, { branch: 'main', baseCommit: head, message, changes: Object.entries(changes).map(([path, content]) => ({ action: 'upsert', path, content })) });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
}

async function build() {
  const created = await api.post(`/projects/${slug}/builds`, { createPreview: false });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  const id = (created.data as { id: string }).id;
  const done = await waitFor(async () => {
    const b = (await api.get(`/builds/${id}`)).data as { status: string; steps: Step[] };
    return ['passed', 'failed'].includes(b.status) ? b : null;
  }, 180_000);
  expect(done.status).toBe('passed');
  return done.steps.find((s) => s.key === 'install')!;
}

describe('dependency cache', () => {
  beforeAll(async () => {
    h = await startHarness({ worker: true });
    expect((await api.post('/auth/login', ADMIN)).status).toBe(200);
    expect((await api.post('/projects', { name: 'Önbellek', slug, source: { type: 'empty' } })).status).toBe(201);
    await waitFor(async () => ((await api.get(`/projects/${slug}`)).data as { repository?: { status?: string } }).repository?.status === 'ready', 60_000);
    await commit(FILES, 'app');
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('shows in the activity feed who changed which files', async () => {
    const feed = (await api.get(`/projects/${slug}/timeline`)).data as { kind: string; description: string }[] | { items: { kind: string; description: string }[] };
    const items = Array.isArray(feed) ? feed : feed.items;
    const commit = items.find((e) => e.kind === 'commit');
    expect(commit?.description).toMatch(/\d+ dosya \(\+\d+ −\d+\): .*install\.mjs/);
  });

  it('installs once, then reuses the dependencies until a lockfile changes', async () => {
    expect((await build()).summary).not.toMatch(/Önbellekten/);
    // Same lockfiles, other code: no install, the build still finds its dependency.
    await commit({ 'README.md': '# değişti\n' }, 'docs');
    expect((await build()).summary).toMatch(/Önbellekten/);
    // A lockfile change installs again.
    await commit({ 'package-lock.json': '{"lockfileVersion":3,"packages":{"":{"name":"onbellek","version":"1.0.1"}}}\n' }, 'lock');
    expect((await build()).summary).not.toMatch(/Önbellekten/);
  }, 600_000);

  it('keeps the app database away from the test run: test.env wins over Secrets', async () => {
    expect((await api.post(`/projects/${slug}/secrets`, { name: 'DB_CONNECTION', value: 'pgsql', scope: 'all' })).status).toBeLessThan(300);
    // A data-store secret the manifest does not override never reaches the tests either.
    expect((await api.post(`/projects/${slug}/secrets`, { name: 'DB_HOST', value: 'gercek-veritabani.local', scope: 'all' })).status).toBeLessThan(300);
    await commit(
      {
        'projecthub.yml': `${FILES['projecthub.yml']}test:
  command: node check-env.mjs
  env:
    DB_CONNECTION: sqlite
`,
        'check-env.mjs': "if (process.env.DB_CONNECTION !== 'sqlite' || process.env.DB_HOST) { console.error('test saw ' + process.env.DB_CONNECTION + ' ' + process.env.DB_HOST); process.exit(1); }\n",
      },
      'test env',
    );
    await build();
  }, 300_000);
});
