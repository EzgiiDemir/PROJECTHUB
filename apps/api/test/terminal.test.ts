import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client as makeClient, startHarness, waitFor, type Harness } from './harness.js';

// Real containers: runs only where a Docker engine and the terminal image are available.
const docker = process.env.DOCKER_BINARY || 'docker';
const image = process.env.TERMINAL_IMAGE || 'node:22-bookworm-slim';
const available = spawnSync(docker, ['image', 'inspect', image], { stdio: 'ignore' }).status === 0;

let h: Harness;
const admin = makeClient(() => h.base);
const slug = 'terminal-projesi';

type Cmd = { id: string; command: string; status: string; exitCode: number | null; output: string; commitSha: string | null; syncNote: string | null; finishedAt: string | null };
type Session = { id: string; status: string; branch: string; commands: Cmd[] };

describe.skipIf(!available)('browser terminal (real API, worker and Docker)', () => {
  let session: Session;

  beforeAll(async () => {
    h = await startHarness({ worker: true, env: { TERMINAL_ENABLED: 'true', TERMINAL_IMAGE: image } });
    await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
    await admin.post('/projects', { name: 'Terminal Projesi', slug, source: { type: 'empty', template: 'node-api' } });
    await waitFor(async () => ((await admin.get(`/projects/${slug}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  const runCmd = async (command: string, timeoutMs = 120_000) => {
    const r = await admin.post(`/terminal/${session.id}/commands`, { command });
    expect(r.status, JSON.stringify(r.error)).toBe(201);
    const id = (r.data as { id: string }).id;
    return waitFor(async () => {
      const s = (await admin.get(`/terminal/${session.id}`)).data as Session;
      const c = s.commands.find((x) => x.id === id);
      return c && !['queued', 'running'].includes(c.status) ? c : null;
    }, timeoutMs);
  };

  it('opens a private working copy of the branch', async () => {
    const r = await admin.post(`/projects/${slug}/terminal`, {});
    expect(r.status).toBe(201);
    session = r.data as Session;
    session = await waitFor(async () => {
      const s = (await admin.get(`/terminal/${session.id}`)).data as Session;
      return s.status === 'ready' ? s : null;
    }, 60_000);
    expect(session.branch).toBe('main');
  }, 90_000);

  it('runs commands as a non-root user without capabilities or Project Hub secrets', async () => {
    const c = await runCmd('id -u && grep CapEff /proc/self/status && (env | grep -ci "DATABASE_URL\\|APP_ENCRYPTION_KEY" || true) && node --version');
    expect(c.status).toBe('done');
    const lines = c.output.trim().split('\n');
    expect(lines[0]).toBe('1000');
    expect(lines[1]).toMatch(/CapEff:\s+0+$/);
    expect(lines[2]).toBe('0');
    expect(lines[3]).toMatch(/^v\d+\./);
  }, 150_000);

  it('runs the project tests and commits changed files back to the branch', async () => {
    const test = await runCmd('npm test');
    expect(test.status, test.output).toBe('done');
    expect(test.commitSha).toBeNull();

    const edit = await runCmd('echo "terminalden eklendi" > terminal-notu.txt && mkdir -p node_modules/x && echo ignored > node_modules/x/index.js');
    expect(edit.status).toBe('done');
    expect(edit.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const file = (await admin.get(`/projects/${slug}/repo/file?ref=main&path=terminal-notu.txt`)).data as { content: string };
    expect(file.content).toBe('terminalden eklendi\n');
    const files = ((await admin.get(`/projects/${slug}/repo/files?ref=main`)).data as { files: { path: string }[] }).files.map((f) => f.path);
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
  }, 200_000);

  it('picks up changes made elsewhere before the next command', async () => {
    const head = ((await admin.get(`/projects/${slug}/repo/branches`)).data as { branches: { name: string; sha: string }[] }).branches.find((b) => b.name === 'main')!.sha;
    await admin.post(`/projects/${slug}/repo/commits`, { branch: 'main', baseCommit: head, message: 'web', changes: [{ action: 'upsert', path: 'web-notu.txt', content: 'webden\n' }] });
    const c = await runCmd('cat web-notu.txt');
    expect(c.output).toContain('Başka yerde yapılan değişiklikler alındı');
    expect(c.output).toContain('webden');
  }, 150_000);

  it('cancels a running command and closes the session', async () => {
    const r = await admin.post(`/terminal/${session.id}/commands`, { command: 'sleep 60' });
    const id = (r.data as { id: string }).id;
    await waitFor(async () => ((await admin.get(`/terminal/${session.id}`)).data as Session).commands.find((x) => x.id === id)?.status === 'running', 60_000);
    await admin.post(`/terminal/${session.id}/commands/${id}/cancel`, {});
    const done = await waitFor(async () => {
      const c = ((await admin.get(`/terminal/${session.id}`)).data as Session).commands.find((x) => x.id === id)!;
      return c.finishedAt !== null && c.status === 'cancelled' ? c : null;
    }, 30_000);
    expect(done.status).toBe('cancelled');
    expect((await admin.post(`/terminal/${session.id}/close`, {})).status).toBe(201);
    expect((await admin.post(`/terminal/${session.id}/commands`, { command: 'ls' })).status).toBe(412);
  }, 150_000);
});
