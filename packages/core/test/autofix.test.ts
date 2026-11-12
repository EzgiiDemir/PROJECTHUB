import { describe, expect, it } from 'vitest';
import { planAutofix, type PlanFinding } from '../src/autofix.js';

function finding(input: Partial<PlanFinding> & Pick<PlanFinding, 'id' | 'type' | 'filePath'>): PlanFinding {
  return {
    number: 1,
    ruleId: 'test/rule',
    severity: 'high',
    title: 'Test bulgusu',
    description: 'Test açıklaması',
    line: null,
    packageName: null,
    packageVersion: null,
    fixedVersion: null,
    ...input,
  };
}

describe('project assistant auto-fix planning', () => {
  it('keeps optional major upgrades manual without dropping genuine vulnerability fixes', () => {
    const input = {
      findings: [
        finding({ id: 'major', type: 'dependency', ruleId: 'dependency/outdated-major', filePath: 'frontend/package-lock.json', packageName: 'typescript', packageVersion: '5.9.0', fixedVersion: '6.0.0' }),
        finding({ id: 'vulnerability', type: 'dependency', filePath: 'backend/composer.lock', packageName: 'league/commonmark', packageVersion: '2.10.0', fixedVersion: '2.10.2' }),
      ],
      busy: new Set<string>(), failedBuild: null, docsMissing: false, aiReady: true, autoMergeOn: true,
    };
    const automatic = planAutofix({ ...input, includeOptionalUpgrades: false });
    expect(automatic.items.flatMap((item) => item.findingIds)).toEqual(['vulnerability']);
    expect(automatic.skipped).toContainEqual(expect.objectContaining({ findingIds: ['major'] }));
    expect(planAutofix(input).items.flatMap((item) => item.findingIds)).toContain('major');
  });
  it('routes Composer, committed env, generated cache and source secrets to the correct fix methods', () => {
    const plan = planAutofix({
      findings: [
        finding({ id: 'composer', type: 'dependency', filePath: 'composer.lock', packageName: 'league/commonmark', packageVersion: '2.10.0', fixedVersion: '2.10.2' }),
        finding({ id: 'env', type: 'secret', filePath: '.env' }),
        finding({ id: 'cache', type: 'secret', filePath: 'storage/framework/views/compiled.php' }),
        finding({ id: 'source', type: 'secret', filePath: 'app/Console/Commands/MailTest.php', line: 36 }),
      ],
      busy: new Set(),
      failedBuild: null,
      docsMissing: false,
      aiReady: true,
      autoMergeOn: true,
    });

    expect(plan.items.find((item) => item.key === 'dependency-low')).toMatchObject({
      mode: 'dependency',
      risk: 'low',
      autoMerge: true,
      upgrades: [expect.objectContaining({ ecosystem: 'Packagist', name: 'league/commonmark', to: '2.10.2' })],
    });
    expect(plan.items.find((item) => item.key === 'secret-env-files')).toMatchObject({
      mode: 'files',
      risk: 'high',
      autoMerge: false,
      findingIds: ['env', 'cache'],
      files: { delete: ['.env', 'storage/framework/views/compiled.php'], ignore: ['.env', '.env.*', '!.env.example', '/storage/framework/views/*'] },
    });
    expect(plan.items.find((item) => item.key === 'secret-source-0')).toMatchObject({ mode: 'agent', risk: 'high', findingIds: ['source'] });
  });

  it('prepares major version upgrades as separate fixes that always wait for approval', () => {
    const plan = planAutofix({
      findings: [
        finding({ id: 'f', type: 'dependency', ruleId: 'dependency/outdated-major', severity: 'info', filePath: 'composer.lock', packageName: 'filament/filament', packageVersion: '4.15.1', fixedVersion: '5.10.1' }),
        finding({ id: 'p', type: 'dependency', ruleId: 'dependency/outdated-major', severity: 'info', filePath: 'composer.lock', packageName: 'phpunit/phpunit', packageVersion: '12.5.33', fixedVersion: '13.4.1' }),
        finding({ id: 'y', type: 'dependency', ruleId: 'dependency/outdated-major', severity: 'info', filePath: 'yarn.lock', packageName: 'left-pad', packageVersion: '1.0.0', fixedVersion: '2.0.0' }),
      ],
      busy: new Set(),
      failedBuild: null,
      docsMissing: false,
      aiReady: false,
      autoMergeOn: true,
    });
    expect(plan.items.map((i) => [i.key, i.mode, i.risk, i.autoMerge, i.upgrades])).toEqual([
      ['major-filament/filament', 'dependency', 'high', false, [{ ecosystem: 'Packagist', name: 'filament/filament', from: '4.15.1', to: '5.10.1', source: 'composer.lock' }]],
      ['major-phpunit/phpunit', 'dependency', 'high', false, [{ ecosystem: 'Packagist', name: 'phpunit/phpunit', from: '12.5.33', to: '13.4.1', source: 'composer.lock' }]],
    ]);
    expect(plan.skipped.map((s) => s.findingIds)).toEqual([['y']]);
  });

  it('generates a missing npm lockfile with the package manager instead of the AI', () => {
    const plan = planAutofix({
      findings: [finding({ id: 'l', type: 'config', ruleId: 'config/missing-lockfile', severity: 'low', filePath: 'package.json' })],
      busy: new Set(),
      failedBuild: null,
      docsMissing: false,
      aiReady: false,
      autoMergeOn: true,
    });
    expect(plan.items).toEqual([expect.objectContaining({ key: 'lockfile-package.json', mode: 'dependency', risk: 'low', autoMerge: true, upgrades: [{ ecosystem: 'npm', name: '', from: null, to: 'lockfile', source: 'package.json' }] })]);
    expect(plan.skipped).toEqual([]);
  });

  it('keeps deterministic fixes available when the local AI model is offline', () => {
    const plan = planAutofix({
      findings: [
        finding({ id: 'env', type: 'secret', filePath: '.env' }),
        finding({ id: 'source', type: 'secret', filePath: 'config/mail.php' }),
      ],
      busy: new Set(),
      failedBuild: null,
      docsMissing: false,
      aiReady: false,
      autoMergeOn: true,
    });

    expect(plan.items.map((item) => item.mode)).toEqual(['files']);
    expect(plan.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ findingIds: ['source'], reason: expect.stringContaining('Yerel AI modeli hazır değil') })]));
  });

  it('groups source secrets across files into one bounded AI verification task', () => {
    const plan = planAutofix({
      findings: [
        finding({ id: 'blade-86', type: 'secret', filePath: 'resources/views/lms/account.blade.php', line: 86 }),
        finding({ id: 'blade-87', type: 'secret', filePath: 'resources/views/lms/account.blade.php', line: 87 }),
        finding({ id: 'mail-36', type: 'secret', filePath: 'app/Console/Commands/MailTest.php', line: 36 }),
      ],
      busy: new Set(),
      failedBuild: null,
      docsMissing: false,
      aiReady: true,
      autoMergeOn: true,
    });

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      key: 'secret-source-0',
      mode: 'agent',
      risk: 'high',
      autoMerge: false,
      findingIds: ['blade-86', 'blade-87', 'mail-36'],
    });
  });
});
