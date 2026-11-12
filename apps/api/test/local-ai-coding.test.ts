import fs from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client, startHarness, waitFor, type Harness } from './harness.js';

/**
 * Coding benchmark for the local model through the real fix-agent pipeline (Ollama, PostgreSQL, API, worker): a real
 * bug with failing tests; the agent has to find it, fix it, run the checks itself and stop at human approval.
 * Opt-in: PROJECTHUB_REAL_OLLAMA=1 (OLLAMA_MODEL, OLLAMA_CONTEXT_TOKENS and OLLAMA_GPU_LAYERS from the environment).
 * PROJECTHUB_AI_BENCH_REPORT=<file> receives duration, steps and outcome.
 */
const enabled = process.env.PROJECTHUB_REAL_OLLAMA === '1';
const model = process.env.OLLAMA_MODEL ?? 'qwen3-coder:30b';
let h: Harness;
const api = client(() => h.base);
const slug = 'yerel-kodlama';

const FILES = {
  'projecthub.yml': `project:
  name: Sepet
runtime:
  type: node
test:
  command: node --test
`,
  'package.json': '{"name":"sepet","version":"1.0.0","type":"module","scripts":{"test":"node --test"}}\n',
  'src/cart.mjs': `/** Sepet toplamı: her kalem fiyat × adet, sonuç kuruş hassasiyetinde yuvarlanır. */
export function cartTotal(items) {
  return items.reduce((sum, i) => sum + i.price, 0);
}

/** Kupon indirimi yüzde olarak uygulanır (ör. 10 → %10). */
export function applyCoupon(total, percent) {
  return total - percent;
}
`,
  'test/cart.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCoupon, cartTotal } from '../src/cart.mjs';

test('adet ile çarpar ve kuruşa yuvarlar', () => {
  assert.equal(cartTotal([{ price: 1.1, qty: 3 }, { price: 2, qty: 1 }]), 5.3);
});

test('kupon yüzde olarak indirir', () => {
  assert.equal(applyCoupon(200, 10), 180);
});
`,
};

describe.skipIf(!enabled)('local model coding benchmark (real fix agent)', () => {
  beforeAll(async () => {
    h = await startHarness({
      worker: true,
      env: { OLLAMA_MODEL: model, OLLAMA_CONTEXT_TOKENS: process.env.OLLAMA_CONTEXT_TOKENS ?? '24576', OLLAMA_REQUEST_TIMEOUT_SECONDS: '600' },
    });
    expect((await api.post('/auth/login', ADMIN)).status).toBe(200);
    expect((await api.post('/projects', { name: 'Sepet', slug, source: { type: 'empty' } })).status).toBe(201);
    await waitFor(async () => ((await api.get(`/projects/${slug}`)).data as { repository?: { status?: string } }).repository?.status === 'ready', 60_000);
    const head = ((await api.get(`/projects/${slug}/repo/branches`)).data as { branches: { name: string; sha: string }[] }).branches.find((b) => b.name === 'main')!.sha;
    const commit = await api.post(`/projects/${slug}/repo/commits`, { branch: 'main', baseCommit: head, message: 'sepet', changes: Object.entries(FILES).map(([path, content]) => ({ action: 'upsert', path, content })) });
    expect(commit.status, JSON.stringify(commit.error)).toBe(201);
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 120_000);

  it('fixes two real bugs, verifies them with the tests and waits for approval', async () => {
    const started = Date.now();
    const created = await api.post(`/projects/${slug}/ai/tasks`, {
      sourceType: 'manual',
      title: 'Sepet hesabı hatalı',
      instruction: 'test/cart.test.mjs içindeki testler başarısız: sepet toplamı adet ile çarpılmıyor ve yuvarlanmıyor, kupon da yüzde yerine tutar olarak düşülüyor. src/cart.mjs dosyasını düzelt ve testlerin geçtiğini run_checks ile doğrula.',
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const id = (created.data as { id: string }).id;
    const task = await waitFor(async () => {
      const t = (await api.get(`/ai/tasks/${id}`)).data as { status: string; error?: string; diff?: { patch: string } | null; result?: { summary?: string; explanation?: string[] } | null };
      return ['awaiting_approval', 'failed', 'cancelled'].includes(t.status) ? t : null;
    }, 3_000_000);
    const report = { model, seconds: Math.round((Date.now() - started) / 1000), status: task.status, error: task.error ?? null, summary: task.result?.summary ?? null, explanation: task.result?.explanation ?? null, patch: task.diff?.patch?.slice(0, 3000) ?? null };
    if (process.env.PROJECTHUB_AI_BENCH_REPORT) await fs.writeFile(process.env.PROJECTHUB_AI_BENCH_REPORT, JSON.stringify(report, null, 2));
    expect(task.status, task.error).toBe('awaiting_approval');
    expect(task.diff?.patch).toContain('qty');
  }, 3_300_000);
});
