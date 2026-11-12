/**
 * Which changes need a full build (owner decision 2026-10-16): ordinary code edits do not start builds — the
 * coding agent already verifies its own edits with the project's build and tests, and people build when they want
 * a preview. A build runs by itself only when the change touches what decides how the project installs, builds,
 * starts or migrates: dependency manifests and lockfiles, build/runtime configuration, containers, the Project Hub
 * manifest, database migrations and CI pipelines.
 */

/** File names (anywhere in the tree, outside dependency folders) that change how the project is installed or built. */
const KEY_FILE =
  /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc(\.yml)?|\.nvmrc|\.node-version|\.tool-versions|composer\.(json|lock)|requirements([-_.][\w.-]+)?\.txt|pipfile(\.lock)?|pyproject\.toml|poetry\.lock|uv\.lock|setup\.(py|cfg)|go\.(mod|sum)|cargo\.(toml|lock)|gemfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|[\w.-]+\.(csproj|fsproj|sln)|global\.json|nuget\.config|directory\.(build|packages)\.props|dockerfile([.-][\w.-]+)?|[\w.-]*\.dockerfile|\.dockerignore|(docker-)?compose(\.[\w-]+)?\.ya?ml|projecthub\.ya?ml|makefile|procfile|vercel\.json|netlify\.toml|turbo\.json|nx\.json|lerna\.json|angular\.json|tsconfig(\.[\w-]+)?\.json|jsconfig\.json|(next|nuxt|vite|vitest|webpack|rollup|svelte|astro|remix|gatsby|babel|postcss|tailwind|esbuild|tsup|metro|jest|playwright)\.config\.[cm]?[jt]s|\.babelrc|\.env\.(example|sample|dist|template))$/i;

/** Folders whose content is the database schema or the delivery pipeline. */
const KEY_DIR = /(^|\/)(migrations?|database\/migrations|db\/migrate|prisma|alembic|\.github\/workflows|\.gitlab|\.circleci|deploy|k8s|helm|infra)\//i;

const DEPENDENCY_DIR = /(^|\/)(node_modules|vendor|\.venv|venv|bower_components|\.git)\//;

/** The subset of `paths` that needs a build, so the caller can say why one runs. */
export function buildRelevantPaths(paths: Iterable<string>): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const path = p.replace(/\\/g, '/');
    if (DEPENDENCY_DIR.test(path)) continue;
    if (KEY_FILE.test(path.slice(path.lastIndexOf('/') + 1)) || KEY_DIR.test(path)) out.push(path);
  }
  return out;
}

/** One line for logs, the activity feed and the AI task: why a build ran or was skipped. */
export function buildDecisionText(relevant: string[]): string {
  if (!relevant.length) return 'Bağımlılık, build yapılandırması veya migration değişmedi; build gerekmedi.';
  return `Build gerekli: ${relevant.slice(0, 4).join(', ')}${relevant.length > 4 ? ` ve ${relevant.length - 4} dosya daha` : ''} değişti.`;
}
