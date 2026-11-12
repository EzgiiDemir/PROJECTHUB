import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, ROOT, startHarness, type Harness } from './harness.js';

// fflate is the browser's ZIP writer (apps/web); the test builds archives the same way.
const { zipSync, strToU8 } = createRequire(path.join(ROOT, 'apps/web/package.json'))('fflate') as typeof import('fflate');

let h: Harness;
let cookie = '';

const call = async (method: string, url: string, body?: BodyInit, headers: Record<string, string> = {}) => {
  const res = await fetch(`${h.base}/api/v1${url}`, { method, body, headers: { 'x-requested-with': 'projecthub', cookie, ...headers } });
  const json = (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string; details?: { received?: number } } } | null;
  return { status: res.status, data: json?.data as never, error: json?.error };
};

/** A working folder as it sits on a developer's disk: generated data, secrets and a nested repository included. */
const archive = () =>
  zipSync({
    'proje/.gitignore': strToU8('/vendor\n.env\n/storage/app/*\n!/storage/app/.gitignore\n/backend/\n'),
    'proje/.env': strToU8('APP_KEY=base64:secret\n'),
    'proje/composer.json': strToU8('{"require":{"laravel/framework":"^13.0"}}'),
    'proje/artisan': strToU8('<?php'),
    'proje/vendor/autoload.php': strToU8('<?php // composer'),
    'proje/public/vendor/bootstrap/bootstrap.custom.min.css': strToU8('.row{display:flex}'),
    'proje/storage/app/.gitignore': strToU8('*\n!.gitignore\n'),
    'proje/storage/app/upload.bin': new Uint8Array(200_000).fill(7),
    'proje/node_modules/vite/index.js': strToU8('x'),
    'proje/backend/.git/HEAD': strToU8('ref: refs/heads/main\n'),
    'proje/backend/app.php': strToU8('<?php echo 1;'),
  });

beforeAll(async () => {
  h = await startHarness();
  const res = await fetch(`${h.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'projecthub' }, body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }) });
  cookie = res.headers.getSetCookie().find((c) => c.startsWith('ph_session='))!.split(';')[0]!;
}, 120_000);

afterAll(async () => {
  await h?.close();
});

type Upload = { fileCount: number; sample: string[] };
const expected = ['.gitignore', 'artisan', 'backend/app.php', 'composer.json', 'public/vendor/bootstrap/bootstrap.custom.min.css', 'storage/app/.gitignore'];

describe('project import (folder/ZIP)', () => {
  it('imports source but rejects ignored dependencies, runtime uploads, secrets and VCS internals', async () => {
    const res = await call('POST', '/uploads', new Blob([archive()]), { 'content-type': 'application/zip', 'x-file-name': 'proje.zip' });
    expect(res.status).toBe(201);
    const up = res.data as Upload;
    expect([...up.sample].sort()).toEqual(expected);
    expect(up.fileCount).toBe(expected.length);
    expect(up.skipped).toBe(5);
  });

  it('uploads large projects in parts, rejects a part at the wrong offset and reports where to resume', async () => {
    const zip = archive();
    const start = await call('POST', '/uploads/chunked', '{}', { 'content-type': 'application/json' });
    expect(start.status).toBe(201);
    const { uploadId } = start.data as { uploadId: string; chunkBytes: number };
    const part = 64 * 1024;
    let offset = 0;
    while (offset < zip.length) {
      const r = await call('PUT', `/uploads/${uploadId}/chunk`, new Blob([zip.subarray(offset, offset + part)]), { 'content-type': 'application/octet-stream', 'x-upload-offset': String(offset) });
      expect(r.status).toBe(200);
      offset = (r.data as { received: number }).received;
      if (offset === part) {
        // A retried first part (already stored) must not be appended twice.
        const again = await call('PUT', `/uploads/${uploadId}/chunk`, new Blob([zip.subarray(0, part)]), { 'content-type': 'application/octet-stream', 'x-upload-offset': '0' });
        expect(again.status).toBe(409);
        expect(again.error?.details?.received).toBe(part);
      }
    }
    expect(offset).toBe(zip.length);
    // A volume cannot be skipped (volume 5 before volumes 1–4).
    const gap = await call('PUT', `/uploads/${uploadId}/chunk`, new Blob([zip]), { 'content-type': 'application/octet-stream', 'x-upload-offset': '0', 'x-upload-volume': '5' });
    expect(gap.status).toBe(409);
    const done = await call('POST', `/uploads/${uploadId}/complete`, JSON.stringify({ fileName: 'proje.zip' }), { 'content-type': 'application/json' });
    expect(done.status).toBe(201);
    expect([...(done.data as Upload).sample].sort()).toEqual(expected);

    // A completed or unknown upload cannot be appended to.
    const late = await call('PUT', `/uploads/${uploadId}/chunk`, new Blob([new Uint8Array(1)]), { 'content-type': 'application/octet-stream', 'x-upload-offset': String(zip.length) });
    expect(late.status).toBe(404);
  });

  it('merges a project uploaded as several ZIP volumes (huge folders)', async () => {
    const a = zipSync({ 'proje/app/a.php': strToU8('<?php // a'), 'proje/.git/HEAD': strToU8('ref') });
    const b = zipSync({ 'proje/vendor/big.bin': new Uint8Array(300_000).fill(1), 'proje/composer.json': strToU8('{}') });
    const { uploadId } = (await call('POST', '/uploads/chunked', '{}', { 'content-type': 'application/json' })).data as { uploadId: string };
    for (const [volume, zip] of [a, b].entries()) {
      const r = await call('PUT', `/uploads/${uploadId}/chunk`, new Blob([zip]), { 'content-type': 'application/octet-stream', 'x-upload-offset': '0', 'x-upload-volume': String(volume) });
      expect(r.status).toBe(200);
    }
    const done = await call('POST', `/uploads/${uploadId}/complete`, JSON.stringify({ fileName: 'proje.zip' }), { 'content-type': 'application/json' });
    expect(done.status).toBe(201);
    expect([...(done.data as Upload).sample].sort()).toEqual(['app/a.php', 'composer.json']);
  });
});
