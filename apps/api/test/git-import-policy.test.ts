import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client, startHarness, type Harness } from './harness.js';

let h: Harness;
const api = client(() => h.base);

describe('Git import policy (production default: no local sources)', () => {
  beforeAll(async () => {
    h = await startHarness({ env: { GIT_IMPORT_ALLOW_LOCAL: 'false' } });
    expect((await api.post('/auth/login', ADMIN)).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it("cannot copy another project's repository from this server's disk or reach internal services", async () => {
    const steal = await api.post('/projects', { name: 'Kopya', slug: 'kopya', source: { type: 'git', url: 'file:///C:/projecthub/.data/storage/repos/other.git' } });
    expect(steal.status).toBe(400);
    expect(steal.error?.message).toMatch(/https, http veya ssh/);
    const ssrf = await api.post('/projects', { name: 'Ic', slug: 'ic', source: { type: 'git', url: 'http://169.254.169.254/latest/meta-data' } });
    expect(ssrf.status).toBe(400);
    expect(((await api.get('/projects')).data as unknown[]).length).toBe(0);
  });
});
