/**
 * Which files of an imported folder or archive belong to the project — the same set `git add -A` would take:
 * - every .gitignore applies to its own directory and below, .git/info/exclude to its repository;
 * - a folder with its own .git is a separate project root, so outer ignore rules cannot drop it
 *   (e.g. a parent repo that ignores /backend/ because backend is its own repository);
 * - dependency, VCS and editor folders are always left out;
 * - vendor/, dist/, build/, out/, target/, bin/, obj/ are left out only where they are really generated (next to
 *   composer.json, package.json, Cargo.toml/pom.xml or a .csproj), so hand-written assets such as public/vendor stay.
 * Used in the browser (folder import) and on the server (ZIP import). Pure TypeScript, no Node APIs.
 */

const ALWAYS_SKIP = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.cache', '.tools', '.idea', '.vs', '.DS_Store', 'Thumbs.db']);

/** Never present a silently reduced source upload as complete. */
export function assertImportFileCount(expected: number, received: number): void {
  if (expected !== received) throw new Error(`Dosya doğrulaması başarısız: ${expected} kaynak dosya gönderildi, sunucu ${received} dosya aldı. Eksik aktarım ile proje oluşturulmadı; ZIP ve .gitignore kurallarını kontrol edin.`);
}

/** Secrets and Laravel runtime data never belong to an imported source repository, even if .gitignore is missing. */
function unsafeImportPath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  const env = /^\.env(?:\..+)?$/i.test(name) && !/^\.env\.(example|sample|template|dist)$/i.test(name);
  const runtime = name !== '.gitignore' && /(^|\/)storage\/(?:app\/private|framework|logs)(\/|$)/i.test(normalized);
  return env || runtime;
}

interface Rule {
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

/** Paths whose text must be read before filtering: every .gitignore and each repository's .git/info/exclude. */
export function importRuleFiles(paths: string[]): string[] {
  return paths.filter((p) => /(^|\/)\.gitignore$/.test(p) || /(^|\/)\.git\/info\/exclude$/.test(p));
}

export function createImportFilter(paths: string[], ruleText: Record<string, string>): (path: string) => boolean {
  const set = new Set(paths);
  const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  // Repository roots: the import root plus every folder holding its own .git (directory or submodule file).
  const repoRoots = new Set<string>(['']);
  for (const p of paths) {
    const m = /^(.*?)(?:^|\/)\.git(?:\/|$)/.exec(p);
    if (m) repoRoots.add(m[1]!.replace(/\/$/, ''));
  }
  const rulesByDir = new Map<string, Rule[]>();
  const addRules = (dir: string, text: string) => rulesByDir.set(dir, [...(rulesByDir.get(dir) ?? []), ...parseRules(text)]);
  for (const [file, text] of Object.entries(ruleText)) {
    if (file.endsWith('.git/info/exclude')) addRules(`${file.slice(0, -'.git/info/exclude'.length).replace(/\/$/, '')}\u0000exclude`, text);
    else addRules(dirOf(file), text);
  }
  const hasSibling = (dir: string, test: (name: string) => boolean) => {
    const prefix = dir ? `${dir}/` : '';
    for (const p of set) if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && test(p.slice(prefix.length))) return true;
    return false;
  };
  const siblingCache = new Map<string, boolean>();
  const generated = (dir: string, name: string): boolean => {
    const key = `${dir}\u0000${name}`;
    const hit = siblingCache.get(key);
    if (hit !== undefined) return hit;
    const parent = dir;
    let out = false;
    if (name === 'vendor') out = set.has(parent ? `${parent}/composer.json` : 'composer.json');
    else if (['dist', 'build', 'out', 'coverage'].includes(name)) out = set.has(parent ? `${parent}/package.json` : 'package.json');
    else if (name === 'target') out = hasSibling(parent, (n) => n === 'Cargo.toml' || n === 'pom.xml');
    else if (name === 'bin' || name === 'obj') out = hasSibling(parent, (n) => /\.(csproj|fsproj|vbproj|sln)$/.test(n));
    else if (name === 'venv' || name === '.venv') out = set.has(`${parent ? `${parent}/` : ''}${name}/pyvenv.cfg`) || name === '.venv';
    siblingCache.set(key, out);
    return out;
  };
  const rootOf = (p: string) => {
    let best = '';
    for (const r of repoRoots) if (r && (p === r || p.startsWith(`${r}/`)) && r.length > best.length) best = r;
    return best;
  };
  const matches = (path: string, isDir: boolean): boolean => {
    const root = rootOf(path);
    if (path === root) return false; // a repository root is never ignored by outer rules
    let ignored = false;
    const check = (base: string, rules: Rule[] | undefined) => {
      if (!rules) return;
      const rel = base ? path.slice(base.length + 1) : path;
      for (const r of rules) if ((!r.dirOnly || isDir) && r.regex.test(rel)) ignored = !r.negate;
    };
    check(root, rulesByDir.get(`${root}\u0000exclude`));
    const segments = path.split('/');
    for (let i = root ? root.split('/').length : 0; i < segments.length; i++) {
      const base = segments.slice(0, i).join('/');
      check(base, rulesByDir.get(base));
    }
    return ignored;
  };
  const dirIgnored = new Map<string, boolean>();
  const isDirIgnored = (dir: string): boolean => {
    if (!dir) return false;
    const hit = dirIgnored.get(dir);
    if (hit !== undefined) return hit;
    const parent = dirOf(dir);
    const name = dir.slice(parent ? parent.length + 1 : 0);
    const out = isDirIgnored(parent) || ALWAYS_SKIP.has(name) || (!repoRoots.has(dir) && (generated(parent, name) || matches(dir, true)));
    dirIgnored.set(dir, out);
    return out;
  };
  return (path: string) => {
    if (unsafeImportPath(path)) return false;
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (isDirIgnored(dirOf(path)) || ALWAYS_SKIP.has(name)) return false;
    return !matches(path, false);
  };
}

function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  for (let line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    if (!line) continue;
    const body = globToRegex(line);
    rules.push({ regex: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`), negate, dirOnly });
  }
  return rules;
}

function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        out += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) out += '\\[';
      else {
        out += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (c === '\\' && i + 1 < glob.length) out += `\\${glob[++i]}`;
    else out += /[.+^${}()|]/.test(c) ? `\\${c}` : c;
  }
  return out;
}
