import { sha256 } from '../crypto.js';
import { scanCode } from './code.js';
import { scanConfig } from './config.js';
import { scanInfrastructure } from './infra.js';
import { parseDependencies, scanDependencies, type InventoryItem, type PackageRegistries } from './dependencies.js';
import { scanSecrets } from './secrets.js';
import { isScannable, type RawFinding } from './types.js';

export * from './types.js';
export * from './secrets.js';
export * from './code.js';
export * from './config.js';
export * from './infra.js';
export * from './dependencies.js';
export * from './migrations.js';
export * from './codeindex.js';
export * from './score.js';
export * from './architecture.js';
export * from './tools.js';

export interface RepositorySnapshot {
  files: { path: string; size: number | null }[];
  read(path: string): Promise<string | null>;
}

export interface RepositoryScanResult {
  findings: (RawFinding & { fingerprint: string })[];
  filesScanned: number;
  packagesScanned: number;
  notes: string[];
  /** Every parsed dependency with its latest registry release (direct ones). */
  dependencies: InventoryItem[];
}

/** Manifest and lock basenames, supported at the root and inside independently installed applications. */
export const DEPENDENCY_FILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'composer.json', 'composer.lock', 'requirements.txt', 'go.mod', 'Cargo.lock'];

/** Installed dependencies: not the project's code (checked through the lockfiles by the dependency scan). */
const THIRD_PARTY = /(^|\/)(node_modules|vendor|bower_components|\.venv|venv|site-packages)(\/|$)/;
/** Tool, cache and editor folders such as .tools/, .cache/, .idea/ (CI configuration folders are project files). */
const TOOL_DIR = /(^|\/)\.(?!github\/|gitlab\/|circleci\/|husky\/|devcontainer\/|docker\/)[^/]+\//;

/** Minified or bundled output (published framework assets, generated docs): very long lines on average or at all. */
export function looksGenerated(text: string): boolean {
  if (text.length < 4000) return false;
  const lines = text.split('\n');
  return lines.some((l) => l.length > 1500) || text.length / lines.length > 400;
}

/** Runs every scanner over a repository snapshot (one commit). */
export async function scanRepository(
  snap: RepositorySnapshot,
  opts: { secretScan: boolean; dependencyScan: boolean; osvUrl: string; fetchImpl?: typeof fetch; registries?: PackageRegistries },
): Promise<RepositoryScanResult> {
  const findings: RawFinding[] = [];
  const configFiles = new Map<string, string>();
  let filesScanned = 0;
  for (const f of snap.files) {
    // Third-party code is checked through lockfiles, not source-code remediation.
    if (THIRD_PARTY.test(f.path) || TOOL_DIR.test(f.path)) continue;
    const isConfig = /(^|\/)Dockerfile[^/]*$/.test(f.path) || f.path === '.gitignore' || f.path === 'package.json';
    const isEnv = /(^|\/)\.env(\.[a-z]+)?$/i.test(f.path);
    if (!isScannable(f.path, f.size) && !isConfig && !isEnv) continue;
    const content = await snap.read(f.path);
    if (content === null || content.includes('\u0000')) continue;
    if (!isConfig && !isEnv && looksGenerated(content)) continue;
    filesScanned++;
    if (isConfig) configFiles.set(f.path, content);
    if (opts.secretScan) findings.push(...scanSecrets(f.path, content));
    findings.push(...scanCode(f.path, content));
    if (/\.(ya?ml|tf)$/i.test(f.path)) findings.push(...scanInfrastructure(f.path, content));
  }
  findings.push(...scanConfig(snap.files.map((f) => f.path), configFiles));

  let packagesScanned = 0;
  let dependencies: InventoryItem[] = [];
  const notes: string[] = [];
  if (opts.dependencyScan) {
    // Keep app manifests separate so one app's direct dependencies cannot label another app's transitive ones.
    const applications = new Map<string, Map<string, string>>();
    for (const file of snap.files) {
      if (THIRD_PARTY.test(file.path) || TOOL_DIR.test(file.path)) continue;
      const slash = file.path.lastIndexOf('/');
      const name = file.path.slice(slash + 1);
      if (!DEPENDENCY_FILES.includes(name)) continue;
      const content = await snap.read(file.path);
      if (content === null) continue;
      const dir = slash < 0 ? '' : file.path.slice(0, slash + 1);
      const group = applications.get(dir) ?? new Map<string, string>();
      group.set(name, content);
      applications.set(dir, group);
    }
    const deps = [...applications].flatMap(([dir, files]) => parseDependencies(files).map((dep) => ({ ...dep, source: `${dir}${dep.source}` })));
    const r = await scanDependencies(deps, { osvUrl: opts.osvUrl, fetchImpl: opts.fetchImpl, registries: opts.registries });
    findings.push(...r.findings);
    packagesScanned = r.packagesScanned;
    dependencies = r.inventory;
    notes.push(...r.notes);
  }

  const unique = new Map<string, RawFinding & { fingerprint: string }>();
  for (const f of findings) {
    const fingerprint = sha256(`${f.ruleId}|${f.identity}`);
    if (!unique.has(fingerprint)) unique.set(fingerprint, { ...f, fingerprint });
  }
  return { findings: [...unique.values()], filesScanned, packagesScanned, notes, dependencies };
}
