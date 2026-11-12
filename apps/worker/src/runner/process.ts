import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** Host variables required to locate runtimes. Everything else must be passed explicitly for the project. */
const SAFE_HOST_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']);

export function sanitizedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (SAFE_HOST_ENV.has(k.toUpperCase()) && v !== undefined) env[k] = v;
  return { ...env, CI: 'true', PROJECTHUB: 'true', FORCE_COLOR: '0', NO_COLOR: '1', ...extra };
}

/** Replaces $PORT / ${PORT} so commands work the same in cmd.exe and sh. */
export function expandPort(command: string, port: number): string {
  return command.replace(/\$\{PORT\}|\$PORT\b|%PORT%/g, String(port));
}

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

/** Kills a process and its descendants. Resolves when the kill has been carried out (callers may ignore it). */
export function killTree(child: ChildProcess | number): Promise<void> {
  const pid = typeof child === 'number' ? child : child.pid;
  if (!pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const t = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      t.on('close', () => resolve());
      t.on('error', () => resolve());
    });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  return Promise.resolve();
}

/** Runs a shell command, streaming combined output to `onOutput`. Kills the whole process tree on timeout/cancel. */
export function runCommand(opts: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput: (text: string) => void;
  isCancelled?: () => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(opts.command, {
      cwd: opts.cwd,
      env: opts.env,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);
    const poll = opts.isCancelled
      ? setInterval(async () => {
          if (await opts.isCancelled!().catch(() => false)) {
            cancelled = true;
            killTree(child);
          }
        }, 2_000)
      : null;
    const onAbort = () => {
      cancelled = true;
      killTree(child);
    };
    opts.signal?.addEventListener('abort', onAbort);
    child.stdout!.on('data', (d: Buffer) => opts.onOutput(d.toString('utf8')));
    child.stderr!.on('data', (d: Buffer) => opts.onOutput(d.toString('utf8')));
    child.on('error', (e) => opts.onOutput(`\n[projecthub] komut başlatılamadı: ${e.message}\n`));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, timedOut, cancelled, durationMs: Date.now() - started });
    });
  });
}

/**
 * The Docker CLI's own environment: only what the client needs to reach the engine, plus the variables passed into
 * the container by name. Never the worker's full environment — on Windows a host value such as npm_config_cache would
 * otherwise win over the container value (environment names are case-insensitive there) and leak into the container.
 */
const DOCKER_CLIENT_ENV = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'];
function dockerClientEnv(passed: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const passedKeys = new Set(Object.keys(passed).map((k) => k.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (DOCKER_CLIENT_ENV.includes(k.toUpperCase()) && !passedKeys.has(k.toUpperCase())) env[k] = v;
  return { ...env, ...passed };
}

/** Docker CLI used for container builds and terminal commands (Docker Desktop on Windows may not be on PATH). */
/** Read when used: the worker loads .env after this module is imported. */
export const dockerBinary = () => process.env.DOCKER_BINARY || 'docker';

export interface ContainerLimits {
  image: string;
  cpus: number;
  memoryMb: number;
  pids: number;
  /** Dependency installation may use the default bridge; build and test steps use `none`. */
  network: 'bridge' | 'none';
}

/**
 * Runs a trusted project's command in an ephemeral, non-root Linux container. The project container receives no
 * Docker socket, host PID namespace, extra capability or Project Hub environment. This is defense in depth, not a
 * claim that a shared-kernel container is a sufficient boundary for arbitrary hostile code.
 */
export function runContainerCommand(opts: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  limits: ContainerLimits;
  labels?: Record<string, string>;
  /** Docker volume mounted at /cache for package-manager caches (one per project: no cross-project cache poisoning). */
  cacheVolume?: string;
  /** Mount for /workspace instead of binding `cwd` (a ContainerWorkspace volume). */
  workspaceMount?: string;
  onOutput: (text: string) => void;
  isCancelled?: () => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<RunResult> {
  const started = Date.now();
  const name = `projecthub-build-${process.pid}-${randomUUID().slice(0, 12)}`;
  const args = [
    'run',
    '--name', name,
    '--rm',
    '--init',
    '--pull', 'never',
    '--network', opts.limits.network,
    '--cpus', String(opts.limits.cpus),
    '--memory', `${opts.limits.memoryMb}m`,
    '--pids-limit', String(opts.limits.pids),
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--user', '1000:1000',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=268435456',
    '--mount', opts.workspaceMount ?? `type=bind,source=${opts.cwd},target=/workspace`,
    '--workdir', '/workspace',
  ];
  if (opts.cacheVolume) args.push('--mount', `type=volume,source=${opts.cacheVolume},target=/cache`);
  for (const [key, value] of Object.entries(opts.labels ?? {}).sort(([a], [b]) => a.localeCompare(b))) args.push('--label', `${key}=${value}`);
  // Pass explicit project variables by name so values do not appear in the command line. Host plumbing such as a
  // Windows PATH must not replace the image's Linux PATH.
  for (const key of Object.keys(opts.env).sort()) if (!SAFE_HOST_ENV.has(key.toUpperCase())) args.push('--env', key);
  args.push(opts.limits.image, '/bin/sh', '-lc', opts.command);

  return new Promise((resolve) => {
    const child = spawn(dockerBinary(), args, {
      cwd: opts.cwd,
      env: dockerClientEnv(opts.env),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let cancelled = false;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      execFile(dockerBinary(), ['rm', '-f', name], { windowsHide: true }, () => undefined);
      killTree(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    const poll = opts.isCancelled
      ? setInterval(async () => {
          if (await opts.isCancelled!().catch(() => false)) {
            cancelled = true;
            stop();
          }
        }, 2_000)
      : null;
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    opts.signal?.addEventListener('abort', onAbort);
    child.stdout!.on('data', (d: Buffer) => opts.onOutput(d.toString('utf8')));
    child.stderr!.on('data', (d: Buffer) => opts.onOutput(d.toString('utf8')));
    child.on('error', (e) => opts.onOutput(`\n[projecthub] container başlatılamadı: ${e.message}\n`));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      opts.signal?.removeEventListener('abort', onAbort);
      // Covers daemon/client disconnects where --rm did not get a chance to execute.
      execFile(dockerBinary(), ['rm', '-f', name], { windowsHide: true }, () => undefined);
      resolve({ exitCode: code, timedOut, cancelled, durationMs: Date.now() - started });
    });
  });
}

export interface ManagedBuildContainer {
  id: string;
  workerId: string;
  buildId: string;
}

/** Lists only containers created by this runner; used to reconcile leftovers after a worker crash. */
export async function listManagedBuildContainers(): Promise<ManagedBuildContainer[]> {
  const format = '{{.ID}}\t{{.Label "com.projecthub.worker"}}\t{{.Label "com.projecthub.build"}}';
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(dockerBinary(), ['ps', '-a', '--filter', 'label=com.projecthub.managed=build', '--format', format], { windowsHide: true }, (error, out) =>
      error ? reject(error) : resolve(out),
    );
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split('\t'))
    .filter((row): row is [string, string, string] => row.length === 3 && row.every(Boolean))
    .map(([id, workerId, buildId]) => ({ id, workerId, buildId }));
}

export async function removeManagedBuildContainer(id: string): Promise<void> {
  await new Promise<void>((resolve) => execFile(dockerBinary(), ['rm', '-f', id], { windowsHide: true }, () => resolve()));
}

/** Starts a long-running process (preview server) detached from the job, logging to a file. */
export function startService(opts: { command: string; cwd: string; env: NodeJS.ProcessEnv; logFile: string; mask?: readonly string[]; dockerArgs?: string[] }): ChildProcess {
  // dockerArgs: the command runs inside a preview container (`docker exec …`); the env is handed to the Docker client
  // so `--env NAME` entries take their values without putting them on the command line.
  const spawnIt = (stdio: ('ignore' | 'pipe' | number)[]) =>
    opts.dockerArgs
      ? spawn(dockerBinary(), opts.dockerArgs, { cwd: opts.cwd, env: dockerClientEnv(opts.env), shell: false, windowsHide: true, stdio: stdio as never })
      : spawn(opts.command, { cwd: opts.cwd, env: opts.env, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: stdio as never });
  if (!opts.mask?.length) {
    const out = fs.openSync(opts.logFile, 'a');
    const child = spawnIt(['ignore', out, out]);
    fs.closeSync(out);
    return child;
  }
  // Output passes through the worker line by line so Secrets values printed by the app are written as ***.
  const child = spawnIt(['ignore', 'pipe', 'pipe']);
  const file = fs.createWriteStream(opts.logFile, { flags: 'a' });
  let partial = '';
  const take = (d: Buffer) => {
    const lines = (partial + d.toString('utf8')).split('\n');
    partial = lines.pop() ?? '';
    if (partial.length > 64 * 1024) {
      lines.push(partial);
      partial = '';
    }
    if (lines.length) file.write(`${lines.map((l) => maskSecrets(l, opts.mask!)).join('\n')}\n`);
  };
  child.stdout!.on('data', take);
  child.stderr!.on('data', take);
  child.on('close', () => file.end(partial ? `${maskSecrets(partial, opts.mask!)}\n` : undefined));
  return child;
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * Replaces secret values in command output with ***, so a project that prints its environment (or a failing tool that
 * echoes a connection string) does not leak Secrets into stored logs, the UI or the AI. Short values are left alone:
 * masking "1" or "true" would destroy the log without protecting anything.
 */
export function maskSecrets(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of values) if (v.length >= 6 && out.includes(v)) out = out.split(v).join('***');
  return out;
}

const SECRET_NAME = /(pass(word|wd)?|secret|token|api_?key|_key$|^key$|private|credential|auth|salt|cert|dsn|signature|cookie|session|webhook)/i;
const CREDENTIAL_URL = /:\/\/[^/\s:@]+:[^/\s@]+@/;

/** Looks like a generated key or token: long, no spaces, letters and digits, varied characters. */
function looksRandom(v: string): boolean {
  return v.length >= 20 && !/\s/.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v) && new Set(v).size / v.length > 0.35 && !/^https?:\/\/[^@]*$/i.test(v);
}

/**
 * Environment values worth masking, longest first (so a value containing another is masked whole). Every project
 * setting lives in the same store, so masking all of them would turn APP_NAME=Laravel into "***" everywhere in the
 * log; secrets are recognised by name, by credentials inside a URL, or by looking like a generated key.
 */
export function secretMaskList(secrets: Record<string, string>): string[] {
  const values = Object.entries(secrets)
    .filter(([name, v]) => SECRET_NAME.test(name) || CREDENTIAL_URL.test(v) || looksRandom(v.trim()))
    .flatMap(([, v]) => [v, ...v.split(/\r?\n/)])
    .map((v) => v.trim());
  return [...new Set(values.filter((v) => v.length >= 6))].sort((a, b) => b.length - a.length);
}

/** Line-buffered log writer that timestamps output and caps the file size. */
export class BuildLog {
  private fd: number;
  private bytes = 0;
  private partial = '';
  private readonly tail: string[] = [];
  private masked: string[] = [];
  /** Secret values to hide from this log from now on (see maskSecrets). */
  mask(values: readonly string[]): void {
    this.masked = [...new Set([...this.masked, ...values])].sort((a, b) => b.length - a.length);
  }
  constructor(
    readonly path: string,
    private readonly maxBytes = 20 * 1024 * 1024,
  ) {
    this.fd = fs.openSync(path, 'a');
  }
  write(text: string): void {
    const data = this.partial + text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = data.split('\n');
    this.partial = lines.pop() ?? '';
    for (const l of lines) this.line(l);
  }
  line(l: string): void {
    // eslint-disable-next-line no-control-regex
    const clean = maskSecrets(l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''), this.masked);
    this.tail.push(clean);
    if (this.tail.length > 400) this.tail.shift();
    if (this.bytes > this.maxBytes) return;
    const out = `${clean}\n`;
    this.bytes += Buffer.byteLength(out);
    fs.writeSync(this.fd, this.bytes > this.maxBytes ? '[projecthub] log boyut sınırına ulaştı, kalan çıktı kesildi\n' : out);
  }
  section(title: string): void {
    this.flush();
    this.line(`\n━━ ${title} ━━ ${new Date().toISOString()}`);
  }
  flush(): void {
    if (this.partial) {
      this.line(this.partial);
      this.partial = '';
    }
  }
  lastLines(n = 120): string[] {
    return this.tail.slice(-n);
  }
  close(): void {
    this.flush();
    fs.closeSync(this.fd);
  }
}

/**
 * Windows keeps no parent links once a process exits, so a preview whose wrapper shell died (e.g. the worker was
 * killed) cannot be reached through its recorded PID. Kill whatever still listens on the preview's port instead.
 * POSIX previews run in their own process group, which killTree() already terminates as a whole.
 */
/**
 * Kills every process listening on a port in [from, to]. Used when a worker starts: preview servers of earlier worker
 * processes outlive them on Windows (a dead shell parent breaks taskkill /T) and would pile up on every restart.
 */
export async function killPortRangeListeners(from: number, to: number): Promise<number> {
  const pids = new Set<number>();
  if (process.platform === 'win32') {
    const out = await new Promise<string>((resolve) => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout)));
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
      if (m && Number(m[1]) >= from && Number(m[1]) <= to && Number(m[2]) !== process.pid) pids.add(Number(m[2]));
    }
  } else {
    const out = await new Promise<string>((resolve) => execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], (err, stdout) => resolve(err ? '' : stdout)));
    let pid = 0;
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      const m = /^n.*:(\d+)$/.exec(line);
      if (m && pid && Number(m[1]) >= from && Number(m[1]) <= to && pid !== process.pid) pids.add(pid);
    }
  }
  const targets = await withoutDockerProcesses(pids);
  await Promise.all(targets.map((p) => killTree(p)));
  return targets.length;
}

export async function killPortListener(port: number): Promise<void> {
  if (process.platform !== 'win32') return;
  const out = await new Promise<string>((resolve) => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout)));
  const pids = new Set<number>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
    if (m && Number(m[1]) === port && Number(m[2]) !== process.pid) pids.add(Number(m[2]));
  }
  for (const pid of await withoutDockerProcesses(pids)) killTree(pid);
}

/**
 * A container preview's published port is held by Docker's own port proxy (com.docker.backend, wslrelay, vpnkit,
 * docker-proxy). Killing it would take Docker — and every build and preview — down, so it is never a kill target;
 * container previews are stopped with `docker rm -f` instead.
 */
export const DOCKER_PROCESS = /docker|vpnkit|wslrelay|wslhost|wsl\.exe/i;
async function withoutDockerProcesses(pids: Set<number>): Promise<number[]> {
  if (!pids.size) return [];
  const names = new Map<number, string>();
  if (process.platform === 'win32') {
    const out = await new Promise<string>((resolve) => execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout)));
    for (const line of out.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)"/.exec(line);
      if (m) names.set(Number(m[2]), m[1]!);
    }
  } else {
    const out = await new Promise<string>((resolve) => execFile('ps', ['-eo', 'pid=,comm='], (err, stdout) => resolve(err ? '' : stdout)));
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (m) names.set(Number(m[1]), m[2]!.trim());
    }
  }
  return [...pids].filter((pid) => !DOCKER_PROCESS.test(names.get(pid) ?? ''));
}

/** Runtime-specific variables for project processes (Python dependencies live in the project's own .pydeps). */
export function runtimeEnv(runtime: string | undefined, containerized = false): Record<string, string> {
  if (runtime === 'python') return { PYTHONPATH: '.pydeps', PYTHONDONTWRITEBYTECODE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' };
  // Windows PHP installations commonly select their CLI php.ini through PHPRC. The generic sanitizer intentionally
  // drops user-profile variables, so pass this runtime path explicitly on host execution only. Never leak a host path
  // into a Linux build container, whose image supplies its own php.ini.
  if (runtime === 'php' && !containerized && process.env.PHPRC) return { PHPRC: process.env.PHPRC };
  return {};
}

/**
 * PHP's CLI — artisan and the built-in server behind `artisan serve` — runs without OPcache, so every process and
 * every preview request read the whole framework again: a cold Laravel boot took 18 s on the Windows host and preview
 * health checks gave up. An extra ini (appended to PHP's own scan directories, never replacing them) enables it with
 * a file cache shared across processes. Host execution only; containers bring their own PHP configuration.
 */
export function phpOpcacheEnv(dir: string): Record<string, string> {
  const cache = path.join(dir, 'opcache');
  fs.mkdirSync(cache, { recursive: true });
  const ini = path.join(dir, 'projecthub-opcache.ini');
  const content = `opcache.enable_cli=1\nopcache.file_cache="${cache.replace(/\\/g, '/')}"\nopcache.validate_timestamps=1\n`;
  if ((fs.existsSync(ini) ? fs.readFileSync(ini, 'utf8') : '') !== content) fs.writeFileSync(ini, content);
  return { PHP_INI_SCAN_DIR: `${path.delimiter}${dir}` };
}

/**
 * Composer platform requirements a host build cannot meet for reasons unrelated to the project. Windows has no
 * Unix-only process-control extensions (laravel/horizon requires ext-pcntl), and a host has a single PHP that may be
 * newer than a lock file's upper bounds. `php+` waives upper bounds only: minimum versions and every other extension
 * stay enforced. A container runs the project's real platform, so nothing is waived there.
 */
export function composerPlatformWaivers(runtime: string | undefined, containerized = false, platform: NodeJS.Platform = process.platform): string[] {
  if (runtime !== 'php' || containerized) return [];
  return platform === 'win32' ? ['ext-pcntl', 'ext-posix', 'php+'] : ['php+'];
}
