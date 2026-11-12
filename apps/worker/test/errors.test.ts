import { describe, expect, it } from 'vitest';
import { extractError } from '../src/runner/errors.js';

describe('build error extraction', () => {
  it('does not misclassify a Vite font DNS failure as a failed test', () => {
    const error = extractError(['✗ Build failed in 27ms', 'Error: getaddrinfo EAI_AGAIN fonts.bunny.net']);
    expect(error.message).toContain('Ağ hatası (EAI_AGAIN)');
    expect(error.message).toContain('fonts.bunny.net');
    expect(error.message).not.toContain('Test başarısız');
  });
  it('preserves Composer filesystem and network failures instead of the usage footer', () => {
    const footer = 'install [--prefer-source] [--prefer-dist] [--dry-run]';
    expect(extractError(['The file could not be written to C:/cache/archive.zip: Failed to open stream: Permission denied', footer]).message).toMatch(/^Dosya erişim hatası \(Composer\):.*Permission denied/);
    expect(extractError(['curl error 28 while downloading https://example.test/archive.zip: Operation timed out', footer]).message).toMatch(/^curl error 28 while downloading/);
  });

  it('reports npm failures by their code, not by the "complete log" footer', () => {
    const network = ['npm error code ECONNRESET', 'npm error network aborted', 'npm error A complete log of this run can be found in: debug-0.log'];
    expect(extractError(network).message).toMatch(/^Ağ hatası \(ECONNRESET\)/);
    const sync = ['npm error code EUSAGE', 'npm error', 'npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.', 'npm error A complete log of this run can be found in: x.log'];
    expect(extractError(sync).message).toBe('npm EUSAGE: `npm ci` can only install packages when your package.json and package-lock.json are in sync.');
    expect(extractError(['npm error something failed', 'npm error A complete log of this run can be found in: x.log']).message).toBe('npm error something failed');
  });

  it('reports the failed node:test assertion instead of the trailing object brace', () => {
    const tap = [
      '✔ health endpoint (3.1ms)',
      '✖ task title is safely escaped (1.6ms)',
      'ℹ tests 3',
      '✖ failing tests:',
      'test at test\\app.test.mjs:13:1',
      '✖ task title is safely escaped (1.6ms)',
      '  AssertionError [ERR_ASSERTION]: user-controlled HTML must be escaped',
      '  true !== false',
      '}',
    ];
    expect(extractError(tap)).toEqual({
      file: 'test/app.test.mjs',
      line: 13,
      message: 'Test başarısız: task title is safely escaped — AssertionError [ERR_ASSERTION]: user-controlled HTML must be escaped',
    });
  });
});
