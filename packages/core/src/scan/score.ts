import type { FindingType, Severity } from '@projecthub/contracts';

const PENALTY: Record<Severity, number> = { critical: 25, high: 10, medium: 4, low: 1, info: 0 };

/**
 * Security score (0–100). A management signal, not a scientific measure:
 * each open finding subtracts a severity weighted penalty, with diminishing returns per category.
 */
export function securityScore(all: { severity: Severity; type: FindingType; packageName?: string | null; filePath?: string | null }[]): { score: number; breakdown: Record<string, number> } {
  // A vulnerable package is one problem however many advisories it has: one upgrade fixes all of them. Counting each
  // advisory drove a project with a single outdated axios (33 advisories) to 0 (2026-10-19). Its worst severity counts.
  const findings: typeof all = [];
  const packages = new Map<string, (typeof all)[number]>();
  for (const f of all) {
    if (f.type !== 'dependency' || !f.packageName) {
      findings.push(f);
      continue;
    }
    const key = `${f.filePath ?? ''}|${f.packageName}`;
    const prev = packages.get(key);
    if (!prev || PENALTY[f.severity] > PENALTY[prev.severity]) packages.set(key, f);
  }
  findings.push(...packages.values());
  const categories: FindingType[] = ['secret', 'dependency', 'code', 'config'];
  const breakdown: Record<string, number> = {};
  for (const c of categories) {
    const penalty = findings.filter((f) => f.type === c).reduce((s, f) => s + PENALTY[f.severity], 0);
    breakdown[c] = Math.max(0, Math.round(100 - 100 * (1 - Math.exp(-penalty / 40))));
  }
  const total = findings.reduce((s, f) => s + PENALTY[f.severity], 0);
  let score = Math.round(100 * Math.exp(-total / 60));
  if (findings.some((f) => f.severity === 'critical')) score = Math.min(score, 49);
  return { score: Math.max(0, Math.min(100, score)), breakdown };
}

export interface HealthInputs {
  securityScore: number | null;
  lastBuildPassed: boolean | null;
  recentBuildSuccessRate: number | null;
  testFiles: number;
  sourceFiles: number;
  hasReadme: boolean;
  todo: number;
  deploySuccessRate: number | null;
  openIncidents: number;
  outdatedMajor: number;
}

/** Project health (0–100) with the component breakdown shown on the overview page. */
export function projectHealth(i: HealthInputs): { score: number; components: Record<string, number | null> } {
  const components: Record<string, number | null> = {
    security: i.securityScore,
    build: i.recentBuildSuccessRate === null ? null : Math.round(i.recentBuildSuccessRate * 100),
    tests: i.sourceFiles === 0 ? null : Math.min(100, Math.round((i.testFiles / Math.max(1, i.sourceFiles)) * 300)),
    dependencies: Math.max(0, 100 - i.outdatedMajor * 8),
    documentation: i.hasReadme ? 100 - Math.min(40, Math.floor(i.todo / 5)) : 40,
    deployment: i.deploySuccessRate === null ? null : Math.round(i.deploySuccessRate * 100),
    incidents: Math.max(0, 100 - i.openIncidents * 30),
  };
  const weights: Record<string, number> = { security: 3, build: 2, tests: 2, dependencies: 1, documentation: 1, deployment: 2, incidents: 2 };
  let sum = 0;
  let wsum = 0;
  for (const [k, v] of Object.entries(components)) {
    if (v === null) continue;
    sum += v * weights[k]!;
    wsum += weights[k]!;
  }
  let score = wsum ? Math.round(sum / wsum) : 0;
  if (i.lastBuildPassed === false) score = Math.min(score, 69);
  return { score, components };
}
