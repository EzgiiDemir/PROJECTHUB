const TEST_FILE = /(^|\/)(__tests__\/|tests?\/).+\.(?:[cm]?[jt]sx?|php|py|go|java|cs|dart)$|(?:\.|_)(?:test|spec)\.(?:[cm]?[jt]sx?|dart)$|_test\.go$/i;
const DEPENDENCY_OR_OUTPUT = /(^|\/)(node_modules|vendor|\.git|\.venv|venv|\.pydeps|\.dart_tool|build|dist|\.next|coverage)\//i;

export function hasSourceTests(paths: string[]): boolean {
  return paths.some((path) => {
    const normalized = path.replaceAll('\\', '/');
    return !DEPENDENCY_OR_OUTPUT.test(normalized) && TEST_FILE.test(normalized);
  });
}

/**
 * The critical findings of a scan that stop the build. Never those a person triaged on the project (false positive,
 * accepted risk). On a branch other than the default one, only what the branch adds: a finding still open on the
 * default branch is existing debt — production deploys stay blocked by the deploy policy — and must not fail an
 * unrelated fix. Without this every Form AI fix failed its verification on the same triaged backend/.env finding.
 */
export function blockingCriticals(fingerprints: string[], known: ReadonlyMap<string, string>, onDefaultBranch: boolean): string[] {
  return fingerprints.filter((fp) => {
    const status = known.get(fp);
    if (status === 'false_positive' || status === 'accepted') return false;
    return onDefaultBranch || status !== 'open';
  });
}

export function criticalSecurityGate(count: number, onDefaultBranch = true): string | null {
  if (count <= 0) return null;
  return onDefaultBranch
    ? `Güvenlik taramasında ${count} açık kritik bulgu var; build artifact ve ön izleme oluşturulmadı.`
    : `Bu değişiklik ${count} yeni kritik güvenlik bulgusu ekliyor; build artifact ve ön izleme oluşturulmadı.`;
}

/**
 * A repository with tests must not become a dead end just because an imported/hand-written manifest omitted the
 * command. Infer only conventional, non-destructive test runners; anything ambiguous still fails closed.
 */
export async function inferTestCommand(paths: string[], read: (path: string) => Promise<string | null>, installCommand?: string): Promise<string | null> {
  const files = paths.map((p) => p.replaceAll('\\', '/')).filter((p) => !DEPENDENCY_OR_OUTPUT.test(p));
  // The project's own apps only: the root or one folder down. Every package inside a committed node_modules has a
  // package.json with a test script, and Form's builds ran one of those ("… not recognized … operable program").
  const dirsFor = (name: string) =>
    files
      .filter((p) => p === name || (p.endsWith(`/${name}`) && p.split('/').length === 2 && !/^(node_modules|vendor|\.[^/]+)\//.test(p)))
      .map((p) => p.slice(0, -name.length).replace(/\/$/, ''));
  // Only an app the install step sets up can run its tests (a folder's dependencies are installed by "cd folder").
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const installed = (dir: string) => !dir || installCommand === undefined || new RegExp(`(^|[\\s&;|])cd\\s+(\\.\\./)?${escape(dir)}(\\s|&|;|$)`).test(installCommand);
  // "composer install --no-dev" leaves PHPUnit out: such a suite cannot run.
  const phpDevInstalled = installCommand === undefined || !/composer\s+install\b[^&;|]*--no-dev/.test(installCommand);
  const inDir = (dir: string, command: string) => (dir ? `cd ${dir} && ${command}` : command);

  for (const dir of dirsFor('package.json')) {
    if (!installed(dir)) continue;
    const file = dir ? `${dir}/package.json` : 'package.json';
    try {
      const pkg = JSON.parse((await read(file)) ?? '') as { scripts?: Record<string, string>; packageManager?: string };
      if (!pkg.scripts?.test || /no test specified/i.test(pkg.scripts.test)) continue;
      const pm = files.includes(`${dir ? `${dir}/` : ''}pnpm-lock.yaml`) || pkg.packageManager?.startsWith('pnpm')
        ? 'pnpm'
        : files.includes(`${dir ? `${dir}/` : ''}yarn.lock`) || pkg.packageManager?.startsWith('yarn')
          ? 'yarn'
          : files.includes(`${dir ? `${dir}/` : ''}bun.lock`) || files.includes(`${dir ? `${dir}/` : ''}bun.lockb`) || pkg.packageManager?.startsWith('bun')
            ? 'bun'
            : 'npm';
      return inDir(dir, pm === 'npm' ? 'npm test' : `${pm} test`);
    } catch {
      // Invalid package metadata is reported by install/build; it is not a safe inference source.
    }
  }

  for (const dir of phpDevInstalled ? dirsFor('composer.json') : []) {
    if (!installed(dir)) continue;
    const prefix = dir ? `${dir}/` : '';
    const hasPhpTests = files.some((p) => p.startsWith(`${prefix}tests/`) && p.endsWith('.php'));
    if (!hasPhpTests) continue;
    try {
      const composer = JSON.parse((await read(`${prefix}composer.json`)) ?? '') as { scripts?: Record<string, unknown>; require?: Record<string, string> };
      if (composer.scripts?.test) return inDir(dir, 'composer test');
      if (files.includes(`${prefix}artisan`) || composer.require?.['laravel/framework']) return inDir(dir, 'php artisan test');
    } catch {
      // Fall through to the conventional PHPUnit configuration check.
    }
    if (files.some((p) => p === `${prefix}phpunit.xml` || p === `${prefix}phpunit.xml.dist`)) return inDir(dir, 'vendor/bin/phpunit');
  }

  const pyTest = files.find((p) => /(^|\/)tests?\/.+\.py$/i.test(p));
  if (pyTest) {
    const pyDir = /^(.*?)(?:tests?)\//i.exec(pyTest)?.[1]?.replace(/\/$/, '') ?? '';
    return inDir(pyDir, 'python -m pytest -q');
  }
  if (files.some((p) => /_test\.go$/i.test(p))) return 'go test ./...';
  return null;
}

