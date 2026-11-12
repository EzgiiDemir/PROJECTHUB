import { describe, expect, it } from 'vitest';
import { blockedByDependencyConflict } from '@projecthub/core';
import { describeNpmConflict } from '../src/jobs/autofix.js';

// What npm printed for Form on 2026-10-22 while a vite security upgrade was prepared (shortened).
const FORM_OUTPUT = [
  'npm error code ERESOLVE',
  'npm error ERESOLVE could not resolve',
  'npm error',
  'npm error While resolving: eslint-plugin-import@2.32.0',
  'npm error Found: eslint@10.13.0',
  'npm error node_modules/eslint',
  'npm error   dev eslint@"^10.13.0" from the root project',
  'npm error',
  'npm error Could not resolve dependency:',
  'npm error peer eslint@"^2 || ^3 || ^4 || ^5 || ^6 || ^7.2.0 || ^8 || ^9" from eslint-plugin-import@2.32.0',
  'npm error node_modules/eslint-config-next/node_modules/eslint-plugin-import',
  'npm error For a full report see:',
  'npm error C:\\Users\\x\\AppData\\Local\\npm-cache\\_logs\\2026-10-22T08_45_58_924Z-eresolve-report.txt',
].join('\n');

describe('npm conflict explanation', () => {
  it('names the conflict and marks it as pre-existing when neither side is being upgraded', () => {
    const text = describeNpmConflict(FORM_OUTPUT, ['vite'])!;
    expect(text).toContain('projenin mevcut bağımlılıkları zaten çakışıyor');
    expect(text).toContain('eslint-plugin-import@2.32.0');
    expect(text).toContain('peer eslint@"^2 || ^3 || ^4 || ^5 || ^6 || ^7.2.0 || ^8 || ^9" istiyor');
    expect(text).toContain('projede eslint@10.13.0 var');
    expect(text).not.toContain('npm-cache');
  });

  it('blames the upgrade itself when it is one side of the conflict', () => {
    const text = describeNpmConflict(FORM_OUTPUT, ['eslint'])!;
    expect(text).toMatch(/^ERESOLVE: eslint-plugin-import@2\.32\.0/);
    expect(text).not.toContain('mevcut bağımlılıkları');
  });

  it('leaves other failures to the generic message', () => {
    expect(describeNpmConflict('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope', ['nope'])).toBeNull();
  });
});

describe('findings blocked by a pre-existing conflict', () => {
  const failed = (error: string, createdAt: Date, source = 'frontend/package.json') => ({ status: 'failed', error, createdAt, autofix: { mode: 'dependency', upgrades: [{ source }] } });
  const findings = [
    { id: 'vite', filePath: 'frontend/package-lock.json' },
    { id: 'sharp', filePath: 'frontend/package.json' },
    { id: 'laravel', filePath: 'backend/composer.lock' },
    { id: 'other-app', filePath: 'admin/package.json' },
  ];
  const conflict = `Bağımlılık güncellemesi hazırlanamadı: npm lock dosyasını güncelleyemedi (frontend): ${describeNpmConflict(FORM_OUTPUT, ['vite'])}`;

  it("holds back every npm finding of the folder, nothing else, until the default branch changes", () => {
    const at = new Date('2026-10-22T08:45:54Z');
    const blocked = blockedByDependencyConflict([failed(conflict, at)], findings, new Date('2026-10-22T07:00:00Z'));
    expect([...blocked.keys()]).toEqual(['frontend']);
    expect(blocked.get('frontend')!.findingIds.sort()).toEqual(['sharp', 'vite']);
    // A newer default-branch build (someone changed the dependencies) lets the upgrades be tried again.
    expect(blockedByDependencyConflict([failed(conflict, at)], findings, new Date('2026-10-22T09:00:00Z')).size).toBe(0);
  });

  it('ignores failures of the upgraded package itself', () => {
    const own = 'Bağımlılık güncellemesi hazırlanamadı: npm lock dosyasını güncelleyemedi (frontend): ERESOLVE: vite@8.3.0 (peer x istiyor), projede x@1 var.';
    expect(blockedByDependencyConflict([failed(own, new Date())], findings, null).size).toBe(0);
  });
});
