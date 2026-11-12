import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomToken } from '../crypto.js';

/**
 * External scanner adapters. Each run reports whether the tool actually ran: a tool that is missing or failed
 * must never look like a clean result, and findings it produced earlier must not be auto-resolved by its absence.
 */
export interface ToolRun<T> {
  tool: string;
  version: string | null;
  status: 'ran' | 'unavailable' | 'failed';
  message: string;
  results: T[];
}

/** `<toolsDir>/<name>/<name>[.exe]` when present (installed next to the storage), else the name on PATH. */
export function resolveTool(name: string, toolsDir: string, override = ''): string {
  if (override) return override;
  const local = path.join(toolsDir, name, process.platform === 'win32' ? `${name}.exe` : name);
  return fs.existsSync(local) ? local : name;
}

function run(binary: string, args: string[], opts: { timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<{ code: number | null; stdout: string; stderr: string; error?: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(binary, args, { windowsHide: true, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout = (stdout + d.toString('utf8')).slice(-1_000_000)));
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-100_000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'ENOENT' : e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export interface GitleaksLeak {
  ruleId: string;
  description: string;
  file: string;
  line: number;
  commit: string;
  date: string;
  author: string;
}

/** Folders whose files are not the project's own (installed dependencies, build output, tool binaries). */
const GITLEAKS_ALLOWLIST = String.raw`(^|/)(node_modules|vendor|bower_components|\.next|\.nuxt|dist|build|coverage|storage/framework|bootstrap/cache|\.tools|\.venv|venv|site-packages)/`;

/**
 * Gitleaks over the history of a (bare) repository, secrets redacted in its output. With `commit`, only the history
 * reachable from that commit is scanned, so a scan of one commit never reports what was committed after it. Returns
 * where each leak was committed; whether it is still in the current tree is decided by the caller.
 */
export async function runGitleaks(opts: { binary: string; repoDir: string; commit?: string; timeoutMs?: number }): Promise<ToolRun<GitleaksLeak>> {
  const base = { tool: 'Gitleaks', version: null as string | null, results: [] as GitleaksLeak[] };
  // The Git for Windows system config adds textconv filters (docx2txt, ...) that print errors into the scan.
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  const v = await run(opts.binary, ['version'], { timeoutMs: 15_000, env });
  if (v.error === 'ENOENT') return { ...base, status: 'unavailable', message: 'Gitleaks kurulu değil: Git geçmişindeki secret\'lar taranmadı (SCANNER_TOOLS_DIR/gitleaks veya PATH).' };
  if (v.code !== 0) return { ...base, status: 'failed', message: `Gitleaks çalıştırılamadı: ${(v.error ?? v.stderr).slice(0, 200)}` };
  const version = v.stdout.trim().split('\n')[0] ?? null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ph-gitleaks-${randomToken(6)}-`));
  try {
    const config = path.join(dir, 'gitleaks.toml');
    fs.writeFileSync(config, `[extend]\nuseDefault = true\n\n[[allowlists]]\ndescription = "third-party and generated files"\npaths = ['''${GITLEAKS_ALLOWLIST}''']\n`);
    const report = path.join(dir, 'report.json');
    const r = await run(
      opts.binary,
      ['git', opts.repoDir, ...(opts.commit ? [`--log-opts=${opts.commit}`] : []), '--config', config, '--report-format', 'json', '--report-path', report, '--redact', '--no-banner', '--exit-code', '0', '--max-target-megabytes', '5', '--log-level', 'error'],
      { timeoutMs: opts.timeoutMs ?? 15 * 60_000, env },
    );
    if (r.timedOut) return { ...base, version, status: 'failed', message: `Gitleaks zaman aşımına uğradı (${Math.round((opts.timeoutMs ?? 900_000) / 60_000)} dk); Git geçmişi taraması tamamlanamadı.` };
    if (r.code !== 0 || !fs.existsSync(report)) return { ...base, version, status: 'failed', message: `Gitleaks hata verdi: ${(r.error ?? r.stderr).trim().slice(-300)}` };
    const raw = JSON.parse(fs.readFileSync(report, 'utf8') || '[]') as { RuleID: string; Description: string; File: string; StartLine: number; Commit: string; Date: string; Author: string }[];
    const results = raw.map((x) => ({ ruleId: x.RuleID, description: x.Description, file: x.File.replace(/\\/g, '/'), line: x.StartLine, commit: x.Commit, date: x.Date, author: x.Author }));
    return { ...base, version, status: 'ran', message: `Gitleaks ${version}: Git geçmişi tarandı, ${results.length} bulgu.`, results };
  } catch (e) {
    return { ...base, version, status: 'failed', message: `Gitleaks sonucu okunamadı: ${(e as Error).message}` };
  } finally {
    // The report holds no secret values (--redact), but it is removed right away anyway.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
