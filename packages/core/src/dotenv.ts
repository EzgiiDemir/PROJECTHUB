/**
 * .env parser for importing settings into Secrets. Follows the dotenv/phpdotenv rules projects rely on:
 * `export` prefix, # comments, single quotes (literal), double quotes (escapes, multi-line), inline comments after
 * unquoted values and ${VAR} / ${VAR:-default} references to earlier keys. A bare `$` is kept literally so
 * passwords containing `$` survive. Issues never echo values, only line numbers and names.
 */
export interface DotenvEntry {
  name: string;
  value: string;
  line: number;
}

export interface DotenvIssue {
  line: number;
  name?: string;
  reason: string;
}

const KEY = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s?(.*)$/;

export function parseDotenv(text: string): { entries: DotenvEntry[]; issues: DotenvIssue[] } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const values = new Map<string, DotenvEntry>();
  const issues: DotenvIssue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw || raw.startsWith('#')) continue;
    const m = KEY.exec(raw);
    if (!m) {
      issues.push({ line: i + 1, reason: 'Satır ANAHTAR=değer biçiminde değil, atlandı' });
      continue;
    }
    const name = m[1]!;
    const start = i;
    let rest = m[2]!.trimStart();
    let value: string;
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      // Quoted value, possibly spanning several lines.
      let body = rest.slice(1);
      let end = closing(body, quote);
      while (end < 0 && i + 1 < lines.length) {
        body += '\n' + lines[++i]!;
        end = closing(body, quote);
      }
      if (end < 0) {
        issues.push({ line: start + 1, name, reason: 'Tırnak kapanmamış, atlandı' });
        i = start;
        continue;
      }
      body = body.slice(0, end);
      value = quote === '"' ? expand(unescape(body), values, name, start + 1, issues) : body;
    } else {
      const hash = rest.search(/\s#/);
      if (hash >= 0) rest = rest.slice(0, hash);
      value = expand(rest.trim(), values, name, start + 1, issues);
    }
    if (values.has(name)) issues.push({ line: start + 1, name, reason: 'Birden fazla tanım var; sonuncusu kullanıldı' });
    values.set(name, { name, value, line: start + 1 });
  }
  const entries: DotenvEntry[] = [];
  for (const e of values.values()) {
    if (e.value === '') issues.push({ line: e.line, name: e.name, reason: 'Değer boş, atlandı' });
    else entries.push(e);
  }
  return { entries, issues };
}

function closing(body: string, quote: string): number {
  for (let j = 0; j < body.length; j++) {
    if (body[j] === '\\' && quote === '"') j++;
    else if (body[j] === quote) return j;
  }
  return -1;
}

function unescape(s: string): string {
  return s.replace(/\\([nrt"\\$])/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
}

function expand(s: string, values: Map<string, DotenvEntry>, name: string, line: number, issues: DotenvIssue[]): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)(?::-([^}]*))?\}/g, (_, ref: string, fallback?: string) => {
    const v = values.get(ref)?.value;
    if (v !== undefined && v !== '') return v;
    if (fallback !== undefined) return fallback;
    issues.push({ line, name, reason: `\${${ref}} bu dosyada tanımlı değil; boş bırakıldı` });
    return '';
  });
}
