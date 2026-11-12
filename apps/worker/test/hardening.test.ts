import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeferJobError } from '@projecthub/core';
import { describe, expect, it } from 'vitest';
import { assertMemoryAvailable } from '../src/handlers.js';
import { BuildLog, maskSecrets, secretMaskList, startService } from '../src/runner/process.js';

describe('secrets never reach logs or the AI', () => {
  it('masks secret values (and each line of multi-line ones), never short or empty values', () => {
    const list = secretMaskList({ DB_PASSWORD: 'Sup3rS3cret!', APP_KEY: 'base64:abcdefghij', DEBUG: 'true', CERT: '-----BEGIN KEY-----\nMIIBOgIBAAJBAKj34GkxFhD\n-----END KEY-----' });
    expect(list).toContain('Sup3rS3cret!');
    expect(list).not.toContain('true');
    expect(maskSecrets('mysql://app:Sup3rS3cret!@db/app debug=true', list)).toBe('mysql://app:***@db/app debug=true');
    expect(maskSecrets('key line MIIBOgIBAAJBAKj34GkxFhD', list)).toBe('key line ***');
  });

  it('recognises secrets by name, credentials in URLs and random-looking values, not ordinary settings', () => {
    const list = secretMaskList({
      APP_NAME: 'Laravel',
      APP_URL: 'https://basvuru.arucad.edu.tr',
      DATABASE_URL: 'mysql://app:pa55word9@db:3306/app',
      SMTP_USER: 'support@arucad.edu.tr',
      MAILGUN_DOMAIN_VALUE: 'xk29Fh3LqP0zR7tW8yB1mN4c',
    });
    expect(list).toEqual(['mysql://app:pa55word9@db:3306/app', 'xk29Fh3LqP0zR7tW8yB1mN4c']);
  });

  it('a build log stores and reports masked lines', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-mask-'));
    const log = new BuildLog(path.join(dir, 'build.log'));
    log.mask(['Sup3rS3cret!']);
    log.write('connecting with Sup3rS3cret!\nok\n');
    log.close();
    const text = await fs.readFile(path.join(dir, 'build.log'), 'utf8');
    expect(text).not.toContain('Sup3rS3cret!');
    expect(text).toContain('connecting with ***');
    expect(log.lastLines().join('\n')).not.toContain('Sup3rS3cret!');
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('preview logs', () => {
  it('a running app that prints a secret writes *** to its log', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-pvmask-'));
    const logFile = path.join(dir, 'preview.log');
    const child = startService({ command: `node -e "console.log('db=' + process.env.DB_PASSWORD); console.error('done')"`, cwd: dir, env: { ...process.env, DB_PASSWORD: 'Sup3rS3cret!' }, logFile, mask: ['Sup3rS3cret!'] });
    await new Promise((r) => child.on('close', r));
    await new Promise((r) => setTimeout(r, 200));
    const text = await fs.readFile(logFile, 'utf8');
    expect(text).toContain('db=***');
    expect(text).not.toContain('Sup3rS3cret!');
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('resource guard', () => {
  const now = Date.now();
  const gb = 1024 * 1024 * 1024;
  it('holds a heavy job while memory is critically low, and never starts it anyway after a deadline', () => {
    expect(() => assertMemoryAvailable('build.execute', new Date(now - 60_000), 1536, 1 * gb, now)).toThrow(DeferJobError);
    expect(() => assertMemoryAvailable('build.execute', new Date(now - 60_000), 1536, 4 * gb, now)).not.toThrow();
    // Still low after 16 minutes: still waiting, now asking an operator to act.
    expect(() => assertMemoryAvailable('build.execute', new Date(now - 16 * 60_000), 1536, 1 * gb, now)).toThrow(/Kaynak bekleniyor.*16 dakikadır bekliyor/);
  });

  it('counts the memory a loaded model holds for AI jobs only', () => {
    // The model already holds 11 GB: an AI task reuses it; a build cannot.
    expect(() => assertMemoryAvailable('ai.task.run', new Date(now), 1024, 0.5 * gb, now, 11 * gb)).not.toThrow();
    expect(() => assertMemoryAvailable('build.execute', new Date(now), 1024, 0.5 * gb, now, 11 * gb)).toThrow(DeferJobError);
    // No model loaded and memory low: the AI task waits too.
    expect(() => assertMemoryAvailable('ai.task.run', new Date(now), 1024, 0.5 * gb, now, 0)).toThrow(DeferJobError);
  });

  it('never holds light jobs, and can be turned off', () => {
    expect(() => assertMemoryAvailable('security.scan', new Date(now), 1536, 0.5 * gb, now)).not.toThrow();
    expect(() => assertMemoryAvailable('build.execute', new Date(now), 0, 0.5 * gb, now)).not.toThrow();
  });
});
