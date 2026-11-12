import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SEEDED_MARKER = '.projecthub-seeded';

/**
 * A build workspace that lives in a Docker volume instead of a bind-mounted host folder. On Docker Desktop (Windows,
 * macOS) every file of a bind mount crosses the VM boundary one by one: Form's composer install did not finish in
 * 8 minutes and unzip timed out. Here the workspace goes into the volume as one tar stream, all commands work on the
 * VM's own disk, and the result comes back as one tar stream before the artifact is made. On Linux it also keeps the
 * container from writing into the host tree directly.
 *
 * Only `chown` runs as root (no project code, no network, minimal capabilities) so the project's UID 1000 can write.
 */
export class ContainerWorkspace {
  private seeded = false;
  readonly volume: string;

  /** False until the first container command copied the workspace in (a build without commands never does). */
  get isSeeded(): boolean {
    return this.seeded;
  }

  constructor(
    private readonly docker: string,
    private readonly image: string,
    id: string,
    private readonly labels: Record<string, string> = {},
  ) {
    this.volume = `projecthub-ws-${id.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 60)}`;
  }

  private helper(): string {
    return `${this.volume}-io-${Date.now().toString(36)}`;
  }

  private labelArgs(): string[] {
    return Object.entries({ 'com.projecthub.managed': 'build-workspace', ...this.labels }).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
  }

  /**
   * Copies the host folder into a fresh volume once, owned by UID 1000. The folder goes in as one tar stream unpacked
   * by UID 1000 itself: `docker cp` took 22 minutes for Form's preview artifact (tens of thousands of vendor and
   * node_modules files) where the stream takes a few, and no recursive chown is needed afterwards. Every file gets the
   * execute bits, as `docker cp` from Windows gives them (Windows files carry no mode of their own).
   */
  async seed(hostDir: string): Promise<void> {
    if (this.seeded) return;
    await exec(this.docker, ['volume', 'create', ...this.labelArgs(), this.volume], { windowsHide: true });
    await this.asRoot(['chown', '1000:1000', '/workspace']);
    const tar = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
    const unpack = `tar -xf - -C /workspace --no-same-owner${process.platform === 'win32' ? ' && chmod -R a+x /workspace' : ''}`;
    await pipeProcesses(
      [tar, ['-cf', '-', '-C', hostDir, '.']],
      [this.docker, ['run', '--rm', '-i', '--pull', 'never', '--network', 'none', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', ...this.ioLabels(), '--entrypoint', 'sh', '--mount', this.mount(), this.image, '-c', unpack]],
      'Çalışma alanı container\'a kopyalanamadı',
    );
    this.seeded = true;
  }

  /**
   * Fills this (fresh) volume from another workspace volume inside Docker, without the round trip through the host
   * disk: the 128 000 files of Form's preview artifact took over 10 minutes to stream in from Windows, a copy between
   * volumes takes seconds. `remove` (relative paths, e.g. what pruneArtifact took out of the stored artifact) is deleted
   * from the copy, and the completion marker is written last, as after seed().
   */
  async seedFrom(source: ContainerWorkspace, remove: string[]): Promise<void> {
    // `docker run --mount` would silently create an empty source volume and mark an empty copy complete.
    if (!source.isSeeded) throw new Error('Kaynak çalışma alanı container\'a hiç kopyalanmamış');
    await exec(this.docker, ['volume', 'create', ...this.labelArgs(), this.volume], { windowsHide: true });
    await this.asRoot(['chown', '1000:1000', '/workspace']);
    const script = `cp -a /from/. /workspace/ && cd /workspace && xargs -0 -r rm -rf -- && touch /workspace/${SEEDED_MARKER}`;
    const child = spawn(this.docker, ['run', '--rm', '-i', '--pull', 'never', '--network', 'none', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', ...this.ioLabels(), '--entrypoint', 'sh', '--mount', `type=volume,source=${source.volume},target=/from,readonly`, '--mount', this.mount(), this.image, '-c', script], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (d: Buffer) => (errors = (errors + d.toString()).slice(-2000)));
    child.stdin.on('error', () => undefined);
    // Paths go in NUL-separated on stdin: no argument-length limit, no quoting of unusual file names.
    child.stdin.end(remove.map((p) => p.replace(/\\/g, '/').replace(/^\/+/, '')).filter((p) => p && !p.split('/').includes('..')).join('\0'));
    const timer = setTimeout(() => child.kill(), 30 * 60_000);
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve).on('error', () => resolve(-1)));
    clearTimeout(timer);
    if (code !== 0) throw new Error(`Çalışma alanı kopyalanamadı (çıkış ${code}): ${errors.trim().split('\n').slice(-3).join(' ')}`);
    this.seeded = true;
  }

  /** Labels of short-lived copy containers, so a worker killed mid-copy does not leave them behind for good. */
  private ioLabels(): string[] {
    return ['--label', 'com.projecthub.managed=workspace-io', '--label', `com.projecthub.io-started=${Date.now()}`];
  }

  /** Writes (or deletes) single files of the workspace, e.g. the AI's pending edits between check runs. */
  async sync(hostDir: string, files: { rel: string; deleted: boolean }[]): Promise<void> {
    if (!this.seeded || !files.length) return;
    const name = this.helper();
    await exec(this.docker, ['create', '--name', name, '--label', 'com.projecthub.managed=workspace-io', '--label', `com.projecthub.io-started=${Date.now()}`, '--network', 'none', '--mount', `type=volume,source=${this.volume},target=/workspace`, this.image, 'true'], { windowsHide: true });
    try {
      for (const f of files.filter((x) => !x.deleted)) {
        const target = `/workspace/${f.rel.replace(/\\/g, '/')}`;
        await exec(this.docker, ['cp', path.join(hostDir, f.rel), `${name}:${target}`], { windowsHide: true });
      }
    } finally {
      await exec(this.docker, ['rm', '-f', name], { windowsHide: true }).catch(() => undefined);
    }
    const deleted = files.filter((x) => x.deleted).map((x) => `/workspace/${x.rel.replace(/\\/g, '/')}`);
    if (deleted.length) await this.asRoot(['rm', '-rf', '--', ...deleted]);
    await this.chown();
  }

  /** Replaces the host folder with the volume's content (dependencies, build output, prepared artifact). */
  async copyBack(hostDir: string): Promise<void> {
    if (!this.seeded) return;
    await fs.rm(hostDir, { recursive: true, force: true, maxRetries: 3 });
    await fs.mkdir(hostDir, { recursive: true });
    if (process.platform === 'win32') return this.copyBackDereferenced(hostDir);
    const name = this.helper();
    await exec(this.docker, ['create', '--name', name, '--label', 'com.projecthub.managed=workspace-io', '--label', `com.projecthub.io-started=${Date.now()}`, '--network', 'none', '--mount', `type=volume,source=${this.volume},target=/workspace`, this.image, 'true'], { windowsHide: true });
    try {
      await exec(this.docker, ['cp', `${name}:/workspace/.`, hostDir], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60_000 });
    } finally {
      await exec(this.docker, ['rm', '-f', name], { windowsHide: true }).catch(() => undefined);
    }
  }

  /**
   * Windows cannot create symlinks without Developer Mode / admin rights ("A required privilege is not held"), and
   * node_modules/.bin is full of them. The volume is streamed as a tar whose links are replaced by the files they
   * point to; links that leave /workspace or point nowhere are dropped first, so nothing outside the project's own
   * tree can be pulled into the artifact. The host's tar.exe (bsdtar) handles paths beyond MAX_PATH.
   */
  private copyBackDereferenced(hostDir: string): Promise<void> {
    const script = 'cd /workspace && find . -type l | while IFS= read -r l; do t=$(readlink -f "$l" 2>/dev/null); case "$t" in /workspace/*) [ -e "$l" ] || rm -f "$l" ;; *) rm -f "$l" ;; esac; done; exec tar -chf - .';
    const tar = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
    return pipeProcesses(
      [this.docker, ['run', '--rm', '--pull', 'never', '--network', 'none', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', ...this.ioLabels(), '--entrypoint', 'sh', '--mount', this.mount(), this.image, '-c', script]],
      [tar, ['-xf', '-', '-C', hostDir]],
      'Çalışma alanı container\'dan geri alınamadı',
    );
  }

  async remove(): Promise<void> {
    await exec(this.docker, ['volume', 'rm', '-f', this.volume], { windowsHide: true }).catch(() => undefined);
    this.seeded = false;
  }

  /**
   * A volume that was seeded completely before (marker written last) is used as is: restarting a preview after a
   * worker restart must not copy tens of thousands of artifact files again. A half-copied volume has no marker.
   */
  async reuseIfComplete(): Promise<boolean> {
    try {
      await exec(this.docker, ['run', '--rm', '--pull', 'never', '--network', 'none', '--user', '1000:1000', '--cap-drop', 'ALL', '--entrypoint', 'test', '--mount', this.mount(), this.image, '-f', `/workspace/${SEEDED_MARKER}`], { windowsHide: true, timeout: 60_000 });
      this.seeded = true;
      return true;
    } catch {
      return false;
    }
  }

  async markComplete(): Promise<void> {
    await exec(this.docker, ['run', '--rm', '--pull', 'never', '--network', 'none', '--user', '1000:1000', '--cap-drop', 'ALL', '--entrypoint', 'touch', '--mount', this.mount(), this.image, `/workspace/${SEEDED_MARKER}`], { windowsHide: true, timeout: 60_000 });
  }

  /** Mount option for runContainerCommand. */
  mount(): string {
    return `type=volume,source=${this.volume},target=/workspace`;
  }

  private chown(): Promise<void> {
    return this.asRoot(['chown', '-R', '1000:1000', '/workspace']);
  }

  private async asRoot(cmd: string[]): Promise<void> {
    await exec(
      this.docker,
      ['run', '--rm', '--pull', 'never', '--network', 'none', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges:true', '--entrypoint', cmd[0]!, '--mount', `type=volume,source=${this.volume},target=/workspace`, this.image, ...cmd.slice(1)],
      { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
  }
}

/** Runs `producer | consumer` (a tar stream) and fails with both sides' last error lines; 30 minutes at most. */
function pipeProcesses(producer: [string, string[]], consumer: [string, string[]], failure: string): Promise<void> {
  const from = spawn(producer[0], producer[1], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const to = spawn(consumer[0], consumer[1], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  from.stdout.pipe(to.stdin);
  to.stdin.on('error', () => undefined);
  let errors = '';
  from.stderr.on('data', (d: Buffer) => (errors = (errors + d.toString()).slice(-2000)));
  to.stderr.on('data', (d: Buffer) => (errors = (errors + d.toString()).slice(-2000)));
  const timer = setTimeout(() => {
    errors += '\nzaman aşımı (30 dk)';
    from.kill();
    to.kill();
  }, 30 * 60_000);
  const exited = (p: ReturnType<typeof spawn>) => new Promise<number | null>((resolve) => p.on('close', resolve).on('error', () => resolve(-1)));
  return Promise.all([exited(from), exited(to)]).then(([a, b]) => {
    clearTimeout(timer);
    if (a !== 0 || b !== 0) throw new Error(`${failure} (çıkış ${a}/${b}): ${errors.trim().split('\n').slice(-3).join(' ')}`);
  });
}

/** Workspace volumes this hub created, with the build or AI task they belong to. */
export async function listWorkspaceVolumes(docker = process.env.DOCKER_BINARY || 'docker'): Promise<{ name: string; buildId: string | null; taskId: string | null }[]> {
  try {
    const { stdout } = await exec(docker, ['volume', 'ls', '--filter', 'label=com.projecthub.managed=build-workspace', '--format', '{{.Name}}\t{{.Label "com.projecthub.build"}}\t{{.Label "com.projecthub.ai-task"}}'], { windowsHide: true, timeout: 15_000 });
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, buildId, taskId] = line.split('\t');
        return { name: name!, buildId: buildId || null, taskId: taskId || null };
      });
  } catch {
    return [];
  }
}

export async function removeWorkspaceVolume(name: string, docker = process.env.DOCKER_BINARY || 'docker'): Promise<void> {
  await exec(docker, ['volume', 'rm', '-f', name], { windowsHide: true, timeout: 30_000 }).catch(() => undefined);
}

/**
 * Copy helpers (`docker create` + `docker cp`) left behind when a worker was killed mid-copy. A copy never takes longer
 * than its 30-minute timeout, so helpers older than an hour belong to no running job.
 */
export async function removeStaleWorkspaceHelpers(docker = process.env.DOCKER_BINARY || 'docker', now = Date.now()): Promise<number> {
  try {
    const { stdout } = await exec(docker, ['ps', '-a', '--filter', 'label=com.projecthub.managed=workspace-io', '--format', '{{.ID}}\t{{.Label "com.projecthub.io-started"}}'], { windowsHide: true, timeout: 15_000 });
    const stale = stdout
      .split(/\r?\n/)
      .map((l) => l.trim().split('\t'))
      .filter(([id, started]) => id && now - Number(started || 0) > 60 * 60_000)
      .map(([id]) => id!);
    for (const id of stale) await exec(docker, ['rm', '-f', id], { windowsHide: true, timeout: 30_000 }).catch(() => undefined);
    return stale.length;
  } catch {
    return 0;
  }
}
