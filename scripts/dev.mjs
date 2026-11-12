// Development runner: compiles the server packages in watch mode and runs API, worker and web together.
// Prerequisite: PostgreSQL reachable at DATABASE_URL (pnpm db:start provides a local one).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopService } from './service-stop.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const runtimeDir = path.resolve(root, process.env.PROJECTHUB_RUNTIME_DIR ?? path.join('..', 'PROJECTHUB_RUNTIME'));
const isWin = process.platform === 'win32';
const colors = { tsc: 36, api: 32, worker: 35, web: 34 };
const children = [];

function run(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: root, shell: isWin, env: { ...process.env, FORCE_COLOR: '1' }, ...opts });
  const prefix = `\x1b[${colors[name]}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) out.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => process.stdout.write(`${prefix}exited (${code})\n`));
  children.push(child);
  return child;
}

// One dev stack per checkout. A second one (another terminal, another agent) could not bind the ports, ran a second
// worker against the same database and doubled the memory taken by builds and AI tasks.
const lockFile = path.join(runtimeDir, 'run', 'dev.pid');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const previous = Number(fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8') : 0);
if (previous && previous !== process.pid && alive(previous)) {
  console.error(`Project Hub zaten çalışıyor (dev süreci ${previous}). İkinci bir örnek başlatılmadı; önce onu kapatın.`);
  process.exit(1);
}
const apiPort = Number(process.env.API_PORT ?? (fs.existsSync(path.join(root, '.env')) ? /^API_PORT=(\d+)/m.exec(fs.readFileSync(path.join(root, '.env'), 'utf8'))?.[1] : null) ?? 4000);
// The web dev server proxies /api to API_INTERNAL_URL but does not read the root .env: without this, a changed
// API_PORT left the web talking to whatever else listens on 4000.
process.env.API_INTERNAL_URL ??= `http://127.0.0.1:${apiPort}`;
const portTaken = await new Promise((resolve) => {
  const socket = net.connect(apiPort, '127.0.0.1', () => (socket.destroy(), resolve(true)));
  socket.on('error', () => resolve(false));
});
if (portTaken) {
  console.error(`API portu ${apiPort} kullanımda: başka bir Project Hub örneği çalışıyor olabilir. İkinci bir örnek başlatılmadı.`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(lockFile), { recursive: true });
fs.writeFileSync(lockFile, String(process.pid));
process.on('exit', () => {
  try {
    if (fs.readFileSync(lockFile, 'utf8') === String(process.pid)) fs.rmSync(lockFile);
  } catch {
    /* already gone */
  }
});

console.log('Building server packages…');
const build = spawnSync('npx', ['tsc', '-b', 'tsconfig.json'], { cwd: root, shell: isWin, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

/**
 * Runs a Node service and restarts it only when compiled JavaScript really changed. `node --watch` also restarts on
 * Windows access-time/attribute notifications (a test or editor merely reading dist), which killed running builds
 * and AI tasks. A service that exits on its own is started again after a short pause.
 */
function service(name, entry, dirs) {
  const hashes = new Map();
  const hashOf = (file) => {
    try {
      return createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    } catch {
      return null;
    }
  };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.js')) hashes.set(abs, hashOf(abs));
    }
  };
  let child = null;
  let restarting = false;
  let timer = null;
  let respawn = null;
  const start = () => {
    clearTimeout(respawn);
    respawn = null;
    restarting = false;
    child = run(name, process.execPath, [entry], { shell: false, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    child.on('exit', () => {
      if (!restarting && !stopping) respawn = setTimeout(() => !stopping && !restarting && start(), 2000);
    });
  };
  const restart = () => {
    if (restarting || stopping) return;
    process.stdout.write(`\x1b[${colors[name]}m[${name}]\x1b[0m derlenmiş kod değişti, yeniden başlatılıyor\n`);
    // A process that already exited (crashed at start-up) never emits 'exit' again; waiting for it left the worker
    // down for hours. Start it right away instead.
    if (!child || child.exitCode !== null || child.signalCode !== null) return start();
    restarting = true;
    void stopService(child).then(() => { if (!stopping) start(); }).catch((error) => {
      restarting = false;
      console.error(`[${name}] güvenli yeniden başlatma başarısız:`, error.message);
    });
  };
  for (const dir of dirs) {
    // The long, real path: watching an 8.3 short path (e.g. EZGI~1.DEM) trips a libuv assertion on Windows.
    const abs = fs.realpathSync.native(path.join(root, dir));
    walk(abs);
    fs.watch(abs, { recursive: true }, (_event, file) => {
      if (!file || !file.endsWith('.js')) return;
      const target = path.join(abs, file);
      const h = hashOf(target);
      if (hashes.get(target) === h) return;
      hashes.set(target, h);
      clearTimeout(timer);
      timer = setTimeout(restart, 800);
    });
  }
  start();
  return { kill: () => stopService(child), owns: (candidate) => candidate === child };
}

let stopping = false;
run('tsc', 'npx', ['tsc', '-b', 'tsconfig.json', '--watch', '--preserveWatchOutput']);
const services = [
  service('api', 'apps/api/dist/main.js', ['apps/api/dist', 'packages/core/dist', 'packages/database/dist', 'packages/contracts/dist']),
  service('worker', 'apps/worker/dist/main.js', ['apps/worker/dist', 'packages/core/dist', 'packages/database/dist', 'packages/contracts/dist']),
];
// The web app is started again when it exits (a crash, a port briefly in use): without it nothing opens in the browser
// while API and worker keep running.
const web = () =>
  run('web', 'corepack', ['pnpm', '--filter', '@projecthub/web', 'run', 'dev']).on('exit', () => {
    if (!stopping) setTimeout(() => !stopping && web(), 3000);
  });
web();

const stop = async () => {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (!services.some((s) => s.owns(c))) c.kill('SIGTERM');
  await Promise.all(services.map((s) => s.kill()));
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
