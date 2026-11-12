import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findWorkspaceRoot, scan } from '@projecthub/core';
import { ADMIN, client as makeClient, startHarness, waitFor, type Harness } from './harness.js';

// Real Gitleaks (installed under .data/tools by the setup, or SCANNER_TOOLS_DIR); skipped where it is not installed.
const toolsDir = process.env.SCANNER_TOOLS_DIR || path.join(findWorkspaceRoot(process.cwd()), '.data', 'tools');
const binary = scan.resolveTool('gitleaks', toolsDir);
const installed = binary !== 'gitleaks' && fs.existsSync(binary);

let h: Harness;
const admin = makeClient(() => h.base);
const slug = 'gecmis-anahtar';
const TOKEN = `ghp_${'Q7wErT9yUiOp3aSdFgHjKlZx5cVbNm1q2W4e'}`;
type Finding = { id: string; type: string; status: string; severity: string; ruleId: string; title: string; description: string; filePath: string | null; line: number | null };

const head = async () => ((await admin.get(`/projects/${slug}/repo/branches`)).data as { branches: { name: string; sha: string }[] }).branches.find((b) => b.name === 'main')!.sha;
const commit = async (content: string) => expect((await admin.post(`/projects/${slug}/repo/commits`, { branch: 'main', baseCommit: await head(), message: 'deploy.sh', changes: [{ action: 'upsert', path: 'deploy.sh', content }] })).status).toBe(201);
const findings = async () => ((await admin.get(`/projects/${slug}/security?status=all`)).data as { findings: Finding[] }).findings.filter((f) => f.filePath === 'deploy.sh');
/** A manual scan (history included) of the current head; automatic scans of earlier commits may finish in between. */
const scanNow = async () => {
  const sha = await head();
  const started = Date.now();
  await admin.post(`/projects/${slug}/security/scans`);
  return waitFor(async () => {
    const s = (await admin.get(`/projects/${slug}/security`)).data as { lastScan: { commitSha: string; createdBy: string | null; finishedAt: string | null; summary: { notes?: string[] } | null } | null };
    const l = s.lastScan;
    return l?.finishedAt && l.createdBy && l.commitSha === sha && new Date(l.finishedAt).getTime() >= started ? l : null;
  }, 120_000);
};

describe.skipIf(!installed)('secrets in Git history (real Gitleaks)', () => {
  beforeAll(async () => {
    h = await startHarness({ worker: true, env: { SCANNER_TOOLS_DIR: toolsDir } });
    await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
    await admin.post('/projects', { name: 'Geçmiş Anahtar', slug, source: { type: 'empty', template: 'static' } });
    await waitFor(async () => ((await admin.get(`/projects/${slug}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  });

  it('reports a token in the current code once, and keeps it reported from history after it is deleted', async () => {
    await commit(`export GH_TOKEN=${TOKEN}\n`);
    const first = await scanNow();
    expect(first.summary?.notes?.some((n) => n.startsWith('Gitleaks') && n.includes('Git geçmişi tarandı'))).toBe(true);
    // Built-in scanner and Gitleaks see the same line: one open finding, not two.
    const now = (await findings()).filter((f) => f.status === 'open' && f.type === 'secret');
    expect(now).toHaveLength(1);
    expect(now[0]!.line).toBe(1);

    await commit('export GH_TOKEN="$GH_TOKEN"\n');
    await scanNow();
    const after = await findings();
    // The current-code finding is gone; the history finding stays open with the commit and the instruction to rotate.
    const open = after.filter((f) => f.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ type: 'secret', severity: 'high', filePath: 'deploy.sh', line: null });
    expect(open[0]!.ruleId).toMatch(/^gitleaks:/);
    expect(open[0]!.title).toContain('Git geçmişinde');
    expect(open[0]!.description).toMatch(/iptal edip yenileyin/);
    expect(JSON.stringify(after)).not.toContain(TOKEN.slice(4));
  }, 300_000);
});
