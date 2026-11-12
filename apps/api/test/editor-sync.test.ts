import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client as makeClient, ROOT, startHarness, waitFor, type Harness } from './harness.js';

const run = promisify(execFile);
const AGENT = path.join(ROOT, 'apps/api/assets/projecthub-sync.mjs');

let h: Harness;
const admin = makeClient(() => h.base);
let projectId = '';
let otherId = '';
const slug = 'senk-projesi';
const tmpDirs: string[] = [];

type Access = { cloneUrl: string; username: string; token: string; canPush: boolean; openers: { id: string; url: string }[]; sync: { powershell: string; bash: string } };

beforeAll(async () => {
  h = await startHarness({ worker: true });
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  projectId = ((await admin.post('/projects', { name: 'Senk Projesi', slug, source: { type: 'empty' } })).data as { id: string }).id;
  otherId = ((await admin.post('/projects', { name: 'Diğer Proje', slug: 'diger-proje', source: { type: 'empty' } })).data as { id: string }).id;
  for (const s of [slug, 'diger-proje']) {
    await waitFor(async () => ((await admin.get(`/projects/${s}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');
  }
}, 120_000);

afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  await h?.close();
});

const repoUrl = (id: string) => `${h.base}/git/${id}.git`;
const agent = (access: Access, dir: string) =>
  run(process.execPath, [AGENT, '--url', repoUrl(projectId), '--user', access.username, '--dir', dir, '--branch', 'main', '--once'], { env: { ...process.env, PH_TOKEN: access.token } });
const head = async () => ((await admin.get(`/projects/${slug}/repo/branches`)).data as { branches: { name: string; sha: string }[] }).branches.find((b) => b.name === 'main')!.sha;
// Git may check files out with CRLF on Windows (core.autocrlf); the content is what matters.
const read = async (file: string) => (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');

describe('editor access and two-way sync (real API, Git server and sync agent)', () => {
  let access: Access;

  it('issues a project-scoped Git token with links for desktop editors', async () => {
    const res = await admin.post(`/projects/${slug}/editor-access`, { expiresInDays: 7 });
    expect(res.status).toBe(201);
    access = res.data as Access;
    expect(access.token).toMatch(/^ph_/);
    expect(access.canPush).toBe(true);
    expect(access.openers.map((o) => o.id)).toEqual(expect.arrayContaining(['vscode', 'cursor', 'jetbrains', 'github-desktop']));
    expect(access.openers.find((o) => o.id === 'vscode')!.url).toBe(`vscode://vscode.git/clone?url=${encodeURIComponent(access.cloneUrl)}`);
    // Not embedded unless asked: the token never appears in the editor links by default.
    expect(access.openers.every((o) => !o.url.includes(access.token))).toBe(true);
    expect(access.sync.bash).toContain('projecthub-sync.mjs');

    const tokens = (await admin.get('/auth/tokens')).data as { id: string; scope: string; projectId: string | null }[];
    expect(tokens.find((t) => t.scope === 'git')?.projectId).toBe(projectId);
  });

  it('refuses the editor token on the REST API and on other repositories', async () => {
    const rest = await fetch(`${h.base}/api/v1/projects`, { headers: { authorization: `Bearer ${access.token}` } });
    expect(rest.status).toBe(403);
    const basic = { authorization: `Basic ${Buffer.from(`${access.username}:${access.token}`).toString('base64')}` };
    const own = await fetch(`${repoUrl(projectId)}/info/refs?service=git-upload-pack`, { headers: basic });
    expect(own.status).toBe(200);
    const other = await fetch(`${repoUrl(otherId)}/info/refs?service=git-upload-pack`, { headers: basic });
    expect(other.status).toBe(403);
  });

  it('serves the sync agent without authentication', async () => {
    const res = await fetch(`${h.base}/api/v1/tools/projecthub-sync.mjs`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Project Hub Sync');
  });

  it('downloads a portable source snapshot without requiring Git on the client', async () => {
    const login = await fetch(`${h.base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'projecthub' },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const res = await fetch(`${h.base}/api/v1/projects/${slug}/repo/archive?ref=main`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/senk-projesi-[0-9a-f]{7}\.zip/);
    expect(res.headers.get('x-projecthub-commit')).toBe(await head());
    const zip = Buffer.from(await res.arrayBuffer());
    expect(zip.subarray(0, 2).toString('hex')).toBe('504b');
  });

  it('pushes edits made on the PC and pulls edits made elsewhere, and announces each change live', async () => {
    const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'ph-sync-')), slug);
    tmpDirs.push(path.dirname(dir));

    // Live stream, as an open browser tab receives it.
    const events: { type: string; data?: { branch?: string; sha?: string } }[] = [];
    const login = await fetch(`${h.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'projecthub' }, body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }) });
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const abort = new AbortController();
    const stream = await fetch(`${h.base}/api/v1/stream`, { headers: { cookie }, signal: abort.signal });
    void (async () => {
      const reader = stream.body!.getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) break;
        buf += new TextDecoder().decode(value);
        for (const m of buf.matchAll(/event: event\ndata: (.*)\n/g)) events.push(JSON.parse(m[1]!));
        buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
      }
    })();

    try {
      // 1. First run clones; an edit on the PC is committed and pushed by the next run.
      await agent(access, dir);
      await fs.writeFile(path.join(dir, 'pc-notu.md'), '# Bilgisayardan eklendi\n');
      await fs.mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
      await fs.writeFile(path.join(dir, 'node_modules', 'x', 'index.js'), 'ignored');
      await fs.writeFile(path.join(dir, '.env'), 'SECRET=never-pushed');
      await agent(access, dir);
      const pushed = (await admin.get(`/projects/${slug}/repo/file?ref=main&path=pc-notu.md`)).data as { content: string };
      expect(pushed.content).toBe('# Bilgisayardan eklendi\n');
      const files = ((await admin.get(`/projects/${slug}/repo/files?ref=main`)).data as { files: { path: string }[] }).files.map((f) => f.path);
      expect(files).not.toContain('.env');
      expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
      const afterPc = await head();
      await waitFor(async () => events.some((e) => e.type === 'repository.updated' && e.data?.sha === afterPc));

      // 2. An edit in the web editor reaches the PC folder on the next run.
      const web = await admin.post(`/projects/${slug}/repo/commits`, { branch: 'main', baseCommit: afterPc, message: 'web editörü', changes: [{ action: 'upsert', path: 'web-notu.md', content: 'webden\n' }] });
      expect(web.status).toBe(201);
      await waitFor(async () => events.some((e) => e.type === 'repository.updated' && e.data?.sha === (web.data as { commit: string }).commit));
      await agent(access, dir);
      expect(await read(path.join(dir, 'web-notu.md'))).toBe('webden\n');

      // 3. Both sides change the same line: nothing is overwritten, the PC version goes to a safety branch.
      const base = await head();
      await admin.post(`/projects/${slug}/repo/commits`, { branch: 'main', baseCommit: base, message: 'web', changes: [{ action: 'upsert', path: 'pc-notu.md', content: '# Web sürümü\n' }] });
      await fs.writeFile(path.join(dir, 'pc-notu.md'), '# PC sürümü\n');
      const conflict = await agent(access, dir).then(
        () => 0,
        (e: { code: number }) => e.code,
      );
      expect(conflict).toBe(3);
      expect(await read(path.join(dir, 'pc-notu.md'))).toBe('# PC sürümü\n');
      expect(((await admin.get(`/projects/${slug}/repo/file?ref=main&path=pc-notu.md`)).data as { content: string }).content).toBe('# Web sürümü\n');
      const branches = ((await admin.get(`/projects/${slug}/repo/branches`)).data as { branches: { name: string }[] }).branches.map((b) => b.name);
      expect(branches.some((b) => b.startsWith('sync-cakisma/'))).toBe(true);
    } finally {
      abort.abort();
    }
  }, 120_000);
});
