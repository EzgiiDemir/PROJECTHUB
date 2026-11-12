/** Structured edits avoid asking a local model to reproduce an entire JSON dependency block exactly. */
export function setNpmDependency(source: string, name: string, version: string, section: 'dependencies' | 'devDependencies' | 'optionalDependencies'): string {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Geçersiz npm paket adı');
  // Deliberately no URL, alias, workspace/file dependency, tag or model-supplied shell input.
  if (!/^[~^]?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Paket sürümü açık olmalı: ör. 3.2.1 veya ^3.2.1');
  const pkg = JSON.parse(source);
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('package.json bir JSON nesnesi olmalı');
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const deps = pkg[key];
    if (deps !== undefined && (!deps || typeof deps !== 'object' || Array.isArray(deps))) throw new Error(`Geçersiz ${key} bölümü`);
    if (key !== section && deps && Object.hasOwn(deps, name)) throw new Error(`${name} zaten ${key} içinde; aynı bölümü kullan`);
  }
  pkg[section] = { ...pkg[section], [name]: version };
  const indent = source.match(/\n([\t ]+)"/)?.[1] ?? '  ';
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(pkg, null, indent).replace(/\n/g, eol) + (source.endsWith('\n') ? eol : '');
}

/** Fixed recipe only; no model-supplied command or shell metacharacters. Unicode/spaced app directories are valid. */
export function npmLockRecipe(packagePath: string) {
  if (!/^(?:[\p{L}\p{N}_ .-]+\/)*package\.json$/u.test(packagePath) || packagePath.split('/').some((p) => p === '.' || p === '..')) throw new Error('Geçersiz package.json yolu');
  const directory = packagePath.slice(0, -'package.json'.length);
  return { lockPath: `${directory}package-lock.json`, command: `npm install --prefix "./${directory || '.'}" --package-lock-only --ignore-scripts --strict-peer-deps --no-audit --no-fund` };
}

/** Catch npm-ci metadata drift before a multi-app build spends minutes installing unrelated Composer packages. */
export async function npmLockMismatch(files: string[], read: (file: string) => Promise<string | null>): Promise<string | null> {
  for (const file of files.filter((p) => /(^|\/)package\.json$/.test(p) && !/(^|\/)(node_modules|vendor|\.tools)\//.test(p))) {
    const lockPath = file.replace(/package\.json$/, 'package-lock.json');
    if (!files.includes(lockPath)) continue;
    try {
      const pkg = JSON.parse((await read(file)) ?? '{}');
      const lock = JSON.parse((await read(lockPath)) ?? '{}');
      const root = lock.packages?.[''];
      if (!root) continue; // v1 lockfiles need npm's full resolver, not a guessed comparison.
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const names = new Set([...Object.keys(pkg[section] ?? {}), ...Object.keys(root[section] ?? {})]);
        if ([...names].some((name) => pkg[section]?.[name] !== root[section]?.[name])) return lockPath;
      }
    } catch { /* npm reports malformed JSON with its own exact location. */ }
  }
  return null;
}
