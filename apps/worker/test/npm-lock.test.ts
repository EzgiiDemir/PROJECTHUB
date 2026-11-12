import { describe, expect, it } from 'vitest';
import { npmLockMismatch, npmLockRecipe, setNpmDependency } from '../src/jobs/npm-lock.js';

describe('npm lock safety and early preflight', () => {
  it('updates a dependency without matching an old JSON snippet, preserving scripts, indentation and CRLF', () => {
    const source = '{\r\n\t"scripts": {"test":"node --test"},\r\n\t"dependencies": {"react":"^19.0.0"}\r\n}\r\n';
    const result = setNpmDependency(source, 'dompurify', '^3.2.1', 'dependencies');
    expect(JSON.parse(result)).toEqual({ scripts: { test: 'node --test' }, dependencies: { react: '^19.0.0', dompurify: '^3.2.1' } });
    expect(result).toContain('\r\n\t"scripts"');
    expect(result.replace(/\r\n/g, '')).not.toContain('\n');
    expect(setNpmDependency(result, 'dompurify', '^3.2.1', 'dependencies')).toBe(result);
    expect(JSON.parse(setNpmDependency('{}', '@types/dompurify', '3.0.0', 'devDependencies')).devDependencies).toEqual({ '@types/dompurify': '3.0.0' });
  });
  it('rejects non-registry inputs, malformed objects and conflicting dependency sections', () => {
    for (const name of ['__proto__', 'constructor', '../evil', 'x;curl', '@bad', '']) expect(() => setNpmDependency('{}', name, '1.0.0', 'dependencies')).toThrow();
    for (const version of ['latest', 'file:../secret', 'https://example.com/x', 'npm:evil@1', '$(evil)', '1.2.3 && evil']) expect(() => setNpmDependency('{}', 'safe', version, 'dependencies')).toThrow();
    for (const source of ['null', '[]', '{"dependencies":[]}', '{"devDependencies":null}']) expect(() => setNpmDependency(source, 'safe', '1.0.0', 'dependencies')).toThrow();
    expect(() => setNpmDependency('{"devDependencies":{"safe":"1.0.0"}}', 'safe', '2.0.0', 'dependencies')).toThrow('devDependencies');
  });
  it('only permits fixed lock-only recipes within repository paths', () => {
    expect(npmLockRecipe('ön yüz/package.json')).toEqual({ lockPath: 'ön yüz/package-lock.json', command: 'npm install --prefix "./ön yüz/" --package-lock-only --ignore-scripts --strict-peer-deps --no-audit --no-fund' });
    for (const path of ['../package.json', '/package.json', 'a/../../package.json', 'x" && evil/package.json', '$(evil)/package.json', '%PATH%/package.json', 'x;evil/package.json']) expect(() => npmLockRecipe(path)).toThrow();
  });
  it('finds missing or changed app dependencies before Composer or npm install starts', async () => {
    const files: Record<string, string> = {
      'frontend/package.json': JSON.stringify({ dependencies: { dompurify: '^3.4.17' } }),
      'frontend/package-lock.json': JSON.stringify({ packages: { '': { dependencies: {} } } }),
    };
    const check = () => npmLockMismatch(Object.keys(files), async (file) => files[file] ?? null);
    expect(await check()).toBe('frontend/package-lock.json');
    files['frontend/package-lock.json'] = JSON.stringify({ packages: { '': { dependencies: { dompurify: '^3.4.17' } } } });
    expect(await check()).toBeNull();
    files['frontend/package.json'] = '{}';
    expect(await check()).toBe('frontend/package-lock.json');
  });
});
