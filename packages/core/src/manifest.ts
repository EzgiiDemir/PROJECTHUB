import YAML from 'yaml';
import { manifestSchema, type DetectionResult, type Manifest } from '@projecthub/contracts';
import { invalid } from './errors.js';

export const MANIFEST_FILE = 'projecthub.yml';

export interface FileSource {
  /** All file paths of the project, forward slashes, relative to the root. */
  paths: string[];
  read(path: string): Promise<string | null>;
}

export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw invalid(`projecthub.yml okunamadı: ${(e as Error).message}`);
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalid('projecthub.yml geçersiz', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return parsed.data;
}

export function serializeManifest(m: Manifest): string {
  const header = '# Project Hub manifest — how this project is installed, built, previewed and deployed.\n# Reference: docs/manifest.md\n';
  return header + YAML.stringify(stripUndefined(m), { lineWidth: 0 });
}

function stripUndefined<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Builds a manifest from a detection result (used when a project has no projecthub.yml yet). */
export function manifestFromDetection(det: DetectionResult, slug: string): Manifest {
  return manifestSchema.parse({
    project: { name: det.name, slug, version: det.version },
    runtime: { type: det.runtime.type, version: det.runtime.version },
    install: det.installCommand ? { command: det.installCommand } : undefined,
    build: det.buildCommand || det.buildOutput ? { command: det.buildCommand, output: det.buildOutput } : undefined,
    test: det.testCommand ? { command: det.testCommand, env: det.testEnv } : undefined,
    artifact: det.artifactPrepare ? { prepare: det.artifactPrepare } : undefined,
    start: det.startCommand ? { command: det.startCommand, port: det.port ?? 3000 } : undefined,
    health: { path: '/' },
    database: {
      type: det.database,
      migrate: det.migrateCommand || det.migrationDirectory ? { command: det.migrateCommand, directory: det.migrationDirectory } : undefined,
    },
    preview: { enabled: det.previewMode !== 'none', ttl: '24h', mode: det.previewMode === 'none' ? undefined : det.previewMode, spa: false },
    env: det.envVars.map((name) => ({ name, required: false })),
  });
}

const FRAMEWORKS: [dep: string, label: string, port: number, output?: string, staticOutput?: boolean][] = [
  ['next', 'Next.js', 3000, '.next'],
  ['nuxt', 'Nuxt', 3000, '.output'],
  ['@nestjs/core', 'NestJS', 3000, 'dist'],
  ['@sveltejs/kit', 'SvelteKit', 5173, 'build'],
  ['astro', 'Astro', 4321, 'dist', true],
  ['@angular/core', 'Angular', 4200, 'dist', true],
  ['vue', 'Vue', 5173, 'dist', true],
  ['react', 'React', 5173, 'dist', true],
  ['express', 'Express', 3000],
  ['fastify', 'Fastify', 3000],
  ['hono', 'Hono', 3000],
  ['vite', 'Vite', 5173, 'dist', true],
];

/**
 * Smart Project Import: inspects a project's files and infers how to install, build, run and preview it.
 * Pure function over a FileSource, so it works for uploads, Git imports and existing repositories.
 */
export async function detectProject(src: FileSource, fallbackName: string): Promise<DetectionResult> {
  const paths = src.paths;
  const set = new Set(paths);
  const find = (name: string): string | undefined =>
    set.has(name) ? name : paths.find((p) => p.endsWith(`/${name}`) && p.split('/').length <= 2);
  const get = async (name: string) => {
    const p = find(name);
    return p ? src.read(p) : null;
  };

  const checks: string[] = [];
  const warnings: string[] = [];
  const tech: string[] = [];
  const r: DetectionResult = {
    name: fallbackName,
    version: '0.1.0',
    projectType: 'Özel proje',
    runtime: { type: 'other' },
    technologies: [],
    database: 'none',
    previewMode: 'none',
    envVars: [],
    checks,
    warnings,
    hasManifest: set.has('projecthub.yml'),
  };

  // Apps kept one folder down (backend/, frontend/, app/) are found too; their commands must then run in that folder.
  // A package.json next to composer.json (Laravel + Vite) belongs to the same app and is preferred.
  const topDir = (p: string | undefined) => (p?.includes('/') ? p.slice(0, p.indexOf('/')) : '');
  const inDir = (dir: string, cmd: string) => (dir ? `cd ${dir} && ${cmd}` : cmd);
  const composerPath = find('composer.json');
  const phpDir = topDir(composerPath);
  let pkgPath = set.has('package.json') ? 'package.json' : phpDir && set.has(`${phpDir}/package.json`) ? `${phpDir}/package.json` : find('package.json');
  if (pkgPath === 'package.json' && phpDir && set.has(`${phpDir}/package.json`)) {
    try {
      const root = JSON.parse((await src.read('package.json')) ?? '{}');
      // A root SDK/tooling dependency is not an application entry point (Campus: openai only).
      if (!['build', 'start', 'dev', 'test'].some((name) => root.scripts?.[name])) pkgPath = `${phpDir}/package.json`;
    } catch { /* Report malformed JSON in the normal package parser. */ }
  }
  const nodeDir = topDir(pkgPath);
  const atNode = (name: string) => (nodeDir ? `${nodeDir}/${name}` : name);
  let nodeInstall: string | undefined;

  // --- Node.js ---
  const pkgText = pkgPath ? await src.read(pkgPath) : null;
  let pkg: { name?: string; version?: string; description?: string; scripts?: Record<string, string>; engines?: { node?: string }; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; packageManager?: string } | null = null;
  if (pkgText) {
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      warnings.push('package.json okunamadı (geçersiz JSON)');
    }
  }
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const has = (d: string) => Object.keys(deps).some((k) => k === d || k.startsWith(`${d}/`));
  if (pkg) {
    checks.push('package.json bulundu');
    if (pkg.name) r.name = pkg.name.replace(/^@[^/]+\//, '');
    if (pkg.version) r.version = pkg.version;
    if (pkg.description) r.description = pkg.description;
    r.runtime = { type: 'node', version: (/\d+/.exec(pkg.engines?.node ?? '') ?? ['22'])[0] };
    tech.push('Node.js');
    const pm = set.has(atNode('pnpm-lock.yaml')) || pkg.packageManager?.startsWith('pnpm')
      ? 'pnpm'
      : set.has(atNode('yarn.lock')) || pkg.packageManager?.startsWith('yarn')
        ? 'yarn'
        : set.has(atNode('bun.lockb')) || set.has(atNode('bun.lock'))
          ? 'bun'
          : 'npm';
    r.packageManager = pm;
    const lock = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', bun: 'bun.lock' }[pm];
    if (set.has(atNode(lock)) || (pm === 'bun' && set.has(atNode('bun.lockb')))) checks.push(`${lock} bulundu (tekrarlanabilir kurulum)`);
    else if (Object.keys(deps).length) warnings.push('Lock dosyası yok: kurulumlar her seferinde farklı sürüm çekebilir');
    nodeInstall = {
      npm: set.has(atNode('package-lock.json')) ? 'npm ci' : 'npm install',
      pnpm: 'pnpm install --frozen-lockfile',
      yarn: 'yarn install --frozen-lockfile',
      bun: 'bun install',
    }[pm];
    r.installCommand = inDir(nodeDir, nodeInstall);
    if (nodeDir) checks.push(`Uygulama ${nodeDir}/ klasöründe; komutlar orada çalışır`);
    const run = (s: string) => inDir(nodeDir, pm === 'npm' ? `npm run ${s}` : `${pm} run ${s}`);
    let port: number | undefined;
    let output: string | undefined;
    let staticOut = false;
    for (const [dep, label, p, out, isStatic] of FRAMEWORKS) {
      if (has(dep)) {
        tech.push(label);
        if (port === undefined) {
          port = p;
          output = out;
          staticOut = !!isStatic;
        }
      }
    }
    if (has('typescript') || set.has(atNode('tsconfig.json'))) tech.push('TypeScript');
    const scripts = pkg.scripts ?? {};
    if (scripts.build) r.buildCommand = run('build');
    if (scripts.test && !/no test specified/.test(scripts.test)) r.testCommand = inDir(nodeDir, pm === 'npm' ? 'npm test' : `${pm} test`);
    const isServer = has('next') || has('nuxt') || has('@nestjs/core') || has('express') || has('fastify') || has('hono') || (has('@sveltejs/kit') && !has('@sveltejs/adapter-static'));
    if (scripts.start) r.startCommand = run('start');
    else if (isServer && scripts.dev) r.startCommand = run('dev');
    if (has('next') && /output:\s*['"]export['"]/.test((await get('next.config.js')) ?? (await get('next.config.mjs')) ?? (await get('next.config.ts')) ?? '')) {
      output = 'out';
      staticOut = true;
    }
    if (has('@sveltejs/adapter-static')) staticOut = true;
    r.port = port ?? 3000;
    if (output && nodeDir) output = `${nodeDir}/${output}`;
    r.buildOutput = staticOut ? output : undefined;
    r.previewMode = staticOut && r.buildCommand ? 'static' : r.startCommand ? 'process' : r.buildCommand && output ? 'static' : 'none';
    r.projectType =
      isServer && (has('react') || has('vue') || has('next') || has('nuxt'))
        ? 'Web uygulaması'
        : isServer
          ? 'API servisi'
          : staticOut || has('react') || has('vue')
            ? 'Web arayüzü (SPA)'
            : 'Node.js uygulaması';
  }

  // --- PHP ---
  const composer = composerPath ? await src.read(composerPath) : null;
  if (composer) {
    checks.push('composer.json bulundu');
    if (phpDir && phpDir !== nodeDir) checks.push(`PHP uygulaması ${phpDir}/ klasöründe; komutlar orada çalışır`);
    tech.push('PHP');
    r.runtime = { type: 'php', version: /"php"\s*:\s*"[^\d]*(\d+\.\d+)/.exec(composer)?.[1] ?? '8.3' };
    r.packageManager = 'composer';
    // A suite needs its development dependencies (PHPUnit/Pest): install them, test, and only then drop them for the
    // artifact. Installing --no-dev up front made every PHP test run impossible.
    const phpTests = paths.some((p) => p.startsWith(phpDir ? `${phpDir}/tests/` : 'tests/') && p.endsWith('.php'));
    const testable = phpTests && /"require-dev"\s*:\s*\{[^}]*"(phpunit\/phpunit|pestphp\/pest)"/.test(composer);
    const composerInstall = testable ? 'composer install' : 'composer install --no-dev --optimize-autoloader';
    if (testable) r.artifactPrepare = inDir(phpDir, 'composer install --no-dev --optimize-autoloader');
    // Laravel/Symfony applications frequently use Vite or another Node build alongside Composer. Preserve the
    // already-detected Node install instead of silently replacing it and later running an unavailable build tool.
    r.installCommand = !nodeInstall
      ? inDir(phpDir, composerInstall)
      : nodeDir === phpDir
        ? inDir(phpDir, `${composerInstall} && ${nodeInstall}`)
        : [inDir(phpDir, composerInstall), ...(phpDir ? ['cd ..'] : []), inDir(nodeDir, nodeInstall)].join(' && ');
    if (/laravel\/framework/.test(composer)) {
      tech.push('Laravel');
      r.startCommand = inDir(phpDir, 'php artisan serve --host=127.0.0.1 --port=$PORT');
      r.port = 8000;
      r.migrateCommand = inDir(phpDir, 'php artisan migrate --force');
      r.migrationDirectory = phpDir ? `${phpDir}/database/migrations` : 'database/migrations';
      if (testable && !r.testCommand) {
        r.testCommand = inDir(phpDir, 'php artisan test');
        // Laravel suites reset their database (RefreshDatabase): always an in-memory one, never the app's.
        r.testEnv = { APP_ENV: 'testing', DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', CACHE_STORE: 'array', SESSION_DRIVER: 'array', QUEUE_CONNECTION: 'sync', MAIL_MAILER: 'array' };
      }
    } else if (testable && !r.testCommand) r.testCommand = inDir(phpDir, 'vendor/bin/phpunit');
    if (/symfony\//.test(composer)) tech.push('Symfony');
    r.projectType = 'Web uygulaması';
    r.previewMode = r.startCommand ? 'process' : 'none';
    try {
      const c = JSON.parse(composer) as { name?: string; version?: string };
      if (!pkg && c.name) r.name = c.name.split('/').pop()!;
      if (c.version) r.version = c.version;
    } catch {
      /* ignore */
    }
  }

  // A project builds and previews one app. When that app sits in a subfolder (backend/ + frontend/), say which sibling
  // apps are left out instead of skipping them silently.
  const chosenDir = phpDir || nodeDir;
  if (chosenDir) {
    const others = [...new Set(paths.filter((p) => /^[^/]+\/package\.json$/.test(p)).map(topDir))].filter((d) => d !== nodeDir && d !== phpDir);
    for (const d of others) warnings.push(`${d}/ klasöründeki ayrı uygulama build ve önizlemeye dahil değil; yalnız ${chosenDir}/ çalıştırılıyor. Önizlenecek uygulamayı projecthub.yml ile belirleyebilirsiniz.`);
  }

  // --- Python ---
  const reqPath = find('requirements.txt') ?? find('pyproject.toml');
  const req = reqPath ? await src.read(reqPath) : null;
  const pythonPrimary = !composer && (!pkg || !['build', 'start', 'dev', 'test'].some((name) => pkg!.scripts?.[name]));
  if (req && !pythonPrimary) {
    tech.push('Python');
    warnings.push(`${reqPath}: ayrı Python servisi otomatik olarak ana uygulamanın yerine geçirilmedi; ek servisleri projecthub.yml services ile yapılandırın.`);
  }
  if (req && pythonPrimary) {
    const pyDir = topDir(reqPath);
    const atPython = (name: string) => pyDir ? `${pyDir}/${name}` : name;
    const pythonCommand = (command: string) => inDir(pyDir, command);
    checks.push(`${reqPath} bulundu`);
    tech.push('Python');
    r.runtime = { type: 'python', version: '3.13' };
    r.packageManager = 'pip';
    // Per-project dependency folder (the hub puts .pydeps on PYTHONPATH); never the worker's global site-packages.
    // .pydeps stays at the repository root, where the runner's PYTHONPATH points, even for a nested app.
    const target = pyDir ? '../.pydeps' : '.pydeps';
    r.installCommand = pythonCommand(reqPath!.endsWith('requirements.txt') ? `python -m pip install --target ${target} -r requirements.txt` : `python -m pip install --target ${target} .`);
    if (/fastapi/i.test(req)) {
      tech.push('FastAPI');
      const entry = set.has(atPython('main.py')) ? 'main:app' : set.has(atPython('app/main.py')) ? 'app.main:app' : null;
      r.startCommand = entry ? pythonCommand(`python -m uvicorn ${entry} --host 127.0.0.1 --port $PORT`) : undefined;
      if (!entry) warnings.push('FastAPI giriş dosyası bulunamadı; start.command değerini projecthub.yml içinde açıkça tanımlayın.');
      r.projectType = 'API servisi';
    } else if (/django/i.test(req)) {
      tech.push('Django');
      r.startCommand = pythonCommand('python manage.py runserver 127.0.0.1:$PORT');
      r.migrateCommand = pythonCommand('python manage.py migrate --noinput');
      r.projectType = 'Web uygulaması';
    } else if (/flask/i.test(req)) {
      tech.push('Flask');
      r.startCommand = pythonCommand('python -m flask run --host 127.0.0.1 --port $PORT');
      r.projectType = 'API servisi';
    }
    if (/alembic/i.test(req)) {
      r.migrateCommand = pythonCommand('python -m alembic upgrade head');
      r.migrationDirectory = atPython('alembic/versions');
    }
    if (/pytest/i.test(req) || paths.some((p) => p.startsWith(pyDir ? `${pyDir}/` : '') && /(^|\/)tests?\/.*\.py$/.test(p))) r.testCommand = pythonCommand('python -m pytest -q');
    r.port = 8000;
    if (r.startCommand) r.previewMode = 'process';
  }

  // --- Go / Java / .NET ---
  if (find('go.mod')) {
    checks.push('go.mod bulundu');
    tech.push('Go');
    r.runtime = { type: 'go' };
    r.buildCommand = 'go build -o app ./...';
    r.testCommand = 'go test ./...';
    r.startCommand = './app';
    r.port = 8080;
    r.projectType = 'API servisi';
    r.previewMode = 'process';
  }
  const pom = (await get('pom.xml')) ?? (await get('build.gradle')) ?? (await get('build.gradle.kts'));
  if (pom) {
    checks.push(`${find('pom.xml') ? 'pom.xml' : 'build.gradle'} bulundu`);
    tech.push('Java');
    if (/spring-boot/.test(pom)) tech.push('Spring Boot');
    r.runtime = { type: 'java', version: '21' };
    r.buildCommand = find('pom.xml') ? 'mvn -B package -DskipTests' : 'gradle build -x test';
    r.testCommand = find('pom.xml') ? 'mvn -B test' : 'gradle test';
    r.port = 8080;
    r.projectType = 'API servisi';
  }
  if (paths.some((p) => p.endsWith('.csproj'))) {
    checks.push('.csproj bulundu');
    tech.push('.NET');
    r.runtime = { type: 'dotnet', version: '9' };
    r.buildCommand = 'dotnet publish -c Release -o out';
    r.testCommand = 'dotnet test';
    r.projectType = 'Web uygulaması';
  }

  // --- Flutter clients are separate verification targets, not a backend's implied success. ---
  for (const pubspecPath of paths.filter((p) => /(^|\/)pubspec\.yaml$/.test(p) && !/(^|\/)(node_modules|vendor|\.dart_tool|build|\.git)\//.test(p))) {
    try {
      const pubspec = YAML.parse((await src.read(pubspecPath)) ?? '');
      if (pubspec?.dependencies?.flutter?.sdk !== 'flutter') continue;
      checks.push(`${pubspecPath}: Flutter istemcisi bulundu`);
      tech.push('Flutter', 'Dart');
      warnings.push(`${pubspecPath}: Flutter SDK sürümü, flutter analyze/test ve hedef platform build'i ayrı doğrulanmalıdır; backend build'inin geçmesi Flutter istemcisinin çalıştığını kanıtlamaz. SDK içeren izole bir çalıştırıcı ve açık projecthub.yml komutları gerekir.`);
      if (r.runtime.type === 'other') r.projectType = 'Flutter uygulaması';
    } catch {
      warnings.push(`${pubspecPath} okunamadı; Flutter desteği ve komutları otomatik doğrulanamadı.`);
    }
  }

  // --- Static site ---
  const rootHtml = paths.filter((p) => /^[^/]+\.html?$/i.test(p));
  if (!tech.length && (rootHtml.length || paths.some((p) => /^public\/index\.html?$/i.test(p)))) {
    const hasIndex = rootHtml.some((p) => /^index\.html?$/i.test(p));
    checks.push(hasIndex ? 'index.html bulundu — statik site' : `${rootHtml.length} HTML sayfası bulundu — statik site`);
    tech.push('HTML/CSS');
    if (paths.some((p) => /\.js$/i.test(p)) || rootHtml.length) tech.push('JavaScript');
    r.runtime = { type: 'static' };
    r.projectType = 'Statik site';
    r.previewMode = 'static';
    r.buildOutput = rootHtml.length ? '.' : 'public';
    r.port = 80;
    if (!hasIndex && rootHtml.length === 1) checks.push(`Giriş sayfası: ${rootHtml[0]}`);
  }

  // --- Database ---
  const envExample = (await get('.env.example')) ?? (await get('.env.sample')) ?? '';
  const prisma = (await get('schema.prisma')) ?? (await get('prisma/schema.prisma')) ?? '';
  const dbHints = `${envExample}\n${prisma}\n${composer ?? ''}\n${pythonPrimary ? req ?? '' : ''}`;
  if (/postgres|pgsql/i.test(dbHints) || has('pg') || has('postgres') || has('@neondatabase/serverless')) r.database = 'postgresql';
  else if (/mysql|mariadb/i.test(dbHints) || has('mysql2')) r.database = 'mysql';
  else if (/mongodb/i.test(dbHints) || has('mongoose') || has('mongodb')) r.database = 'mongodb';
  else if (/sqlite/i.test(dbHints) || has('better-sqlite3')) r.database = 'sqlite';
  if (r.database !== 'none') checks.push(`${r.database === 'postgresql' ? 'PostgreSQL' : r.database} kullanımı tespit edildi`);
  if (prisma || has('@prisma/client')) {
    tech.push('Prisma');
    r.migrateCommand ??= 'npx prisma migrate deploy';
    r.migrationDirectory ??= 'prisma/migrations';
  }
  if (has('drizzle-orm')) {
    tech.push('Drizzle ORM');
    r.migrationDirectory ??= paths.find((p) => /(^|\/)drizzle\/[^/]+\.sql$/.test(p))?.replace(/\/[^/]+$/, '') ?? undefined;
  }
  if (has('ioredis') || has('redis') || /REDIS_/i.test(envExample)) {
    tech.push('Redis');
    checks.push('Redis kullanımı tespit edildi');
  }
  if (!r.migrationDirectory) {
    const dir = ['migrations', 'db/migrations', 'database/migrations', 'sql/migrations'].find((d) => paths.some((p) => p.startsWith(`${d}/`)));
    if (dir) r.migrationDirectory = dir;
  }
  if (r.migrationDirectory) checks.push(`Migration klasörü: ${r.migrationDirectory}`);

  // --- Environment, containers, tests ---
  r.envVars = [...new Set(envExample.split(/\r?\n/).map((l) => /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(l)?.[1]).filter((v): v is string => !!v))];
  if (envExample) checks.push(`.env.example bulundu · ${r.envVars.length} ortam değişkeni`);
  if (find('Dockerfile')) checks.push('Dockerfile bulundu');
  if (find('docker-compose.yml') || find('compose.yaml') || find('docker-compose.yaml')) checks.push('docker-compose dosyası bulundu');
  const tests = paths.filter((p) => /(\.|_)(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\/|(^|\/)tests?\/.+\.(py|php|go|java|cs|dart)$|_test\.go$/.test(p));
  if (tests.length) checks.push(`${tests.length} test dosyası bulundu`);
  else warnings.push('Test dosyası bulunamadı');
  if (paths.some((p) => /(^|\/)\.env$/.test(p))) warnings.push('.env dosyası repository içinde. Değerleri secret store\'a taşıyın ve dosyayı kaldırın.');
  if (r.hasManifest) checks.push('projecthub.yml mevcut — doğrudan kullanılacak');
  if (r.buildCommand) checks.push(`Build komutu: ${r.buildCommand}`);
  if (!tech.length) warnings.push('Teknoloji otomatik tanınamadı. Manifesti elle düzenleyebilirsiniz.');

  // README first paragraph as description
  const readme = (await get('README.md')) ?? (await get('readme.md'));
  if (readme) {
    const h1 = /^#\s+(.+)$/m.exec(readme)?.[1]?.trim();
    if (h1 && h1.length < 80 && !pkg?.name) r.name = h1;
    if (!r.description) {
      const para = readme
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !/^[#!\[<>`|-]/.test(l));
      if (para) r.description = para.slice(0, 300);
    }
  }
  if (r.hasManifest) {
    const text = await src.read('projecthub.yml');
    try {
      const m = text ? parseManifest(text) : null;
      if (m) {
        r.name = m.project.name;
        r.version = m.project.version;
        // The manifest is authoritative for what code alone cannot reveal (e.g. raw SQL migrations + DATABASE_URL).
        if (r.database === 'none' && m.database.type !== 'none') {
          r.database = m.database.type;
          checks.push(`Veritabanı (manifest): ${m.database.type === 'postgresql' ? 'PostgreSQL' : m.database.type}`);
        }
      }
    } catch (e) {
      warnings.push(`projecthub.yml geçersiz: ${(e as Error).message}`);
    }
  }
  r.technologies = [...new Set(tech)];
  return r;
}

export function prettifyName(raw: string): string {
  return raw.includes(' ') ? raw : raw.replace(/[-_]+/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase()).trim();
}

const TR: Record<string, string> = { ğ: 'g', ü: 'u', ş: 's', ı: 'i', ö: 'o', ç: 'c', Ğ: 'g', Ü: 'u', Ş: 's', İ: 'i', Ö: 'o', Ç: 'c' };
export function slugify(s: string): string {
  return (
    s
      .replace(/[ğüşıöçĞÜŞİÖÇ]/g, (c) => TR[c] ?? c)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'proje'
  );
}
