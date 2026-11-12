import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ContainerWorkspace } from './container-workspace.js';
import type { ContainerLimits } from './process.js';

const exec = promisify(execFile);

/**
 * Forwards each published port to the app's own port on the container's loopback. Apps commonly bind 127.0.0.1
 * (Form: `next start --hostname 127.0.0.1`, `php artisan serve --host=127.0.0.1`), which Docker's port publishing
 * cannot reach; the forwarder listens on all interfaces on a separate port and connects to 127.0.0.1:<app port>.
 * It is also the container's main process: the container lives as long as the preview, and every app or service is
 * started next to it with `docker exec`, so the existing per-process health checks and exit handling stay the same.
 */
const FORWARDER = `const net=require('net');for(const pair of (process.env.PH_FORWARD||'').split(',').filter(Boolean)){const [outer,inner]=pair.split(':').map(Number);net.createServer((c)=>{const u=net.connect(inner,'127.0.0.1');c.pipe(u);u.pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());}).listen(outer,'0.0.0.0');}process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1<<30);`;

const LOOPBACK_VALUE = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/i;
const LOOPBACK_URL = /(:\/\/(?:[^/@\s]*@)?)(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/gi;

/**
 * Secrets written for a host preview point at the host's loopback (DB_HOST=127.0.0.1, DATABASE_URL=…@localhost:5432).
 * Inside the container that is the container itself, so those values are pointed at the host gateway instead.
 */
export function hostLoopbackToGateway(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) out[key] = LOOPBACK_VALUE.test(value.trim()) ? 'host.docker.internal' : value.replace(LOOPBACK_URL, '$1host.docker.internal');
  return out;
}

/** A port the forwarder listens on inside the container, chosen outside the preview port range so it never collides. */
export function forwarderPort(index: number, range: { from: number; to: number }): number {
  return range.to < 60_000 ? 60_001 + index : range.from - 1 - index;
}

/** The Docker volume a server preview of this artifact runs from (a container build fills it right away). */
export function artifactWorkspace(docker: string, image: string, artifactId: string): ContainerWorkspace {
  return new ContainerWorkspace(docker, image, `art-${artifactId}`, { 'com.projecthub.managed': 'preview-workspace', 'com.projecthub.artifact': artifactId, 'com.projecthub.created': String(Date.now()) });
}

export function previewContainerName(previewId: string): string {
  return `projecthub-preview-${previewId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 60)}`;
}

/**
 * One locked-down container per server preview: non-root, read-only root filesystem, no capabilities, CPU/memory/PID
 * limits, published only on the host's 127.0.0.1. The artifact is copied into a Docker volume (bind mounts on Docker
 * Desktop are far too slow for PHP/Node apps that touch thousands of files), so the app writes its storage/ and cache
 * folders there and never into the stored artifact. The volume belongs to the artifact, like the artifact folder host
 * previews ran in: a restarted preview (worker restart, stop and start) reuses it instead of copying every file again.
 */
export class PreviewContainer {
  readonly name: string;
  private readonly ws: ContainerWorkspace;
  /** Names are reused on restart; commands and late cleanup must target only this attempt's immutable ID. */
  private containerId: string | null = null;

  constructor(
    private readonly docker: string,
    private readonly limits: Omit<ContainerLimits, 'network'>,
    readonly previewId: string,
    readonly artifactId: string,
  ) {
    this.name = previewContainerName(previewId);
    this.ws = artifactWorkspace(docker, limits.image, artifactId);
  }

  /** Copies the artifact in (unless a complete copy exists) and starts the container with every port published. */
  async start(artifactDir: string, ports: number[], range: { from: number; to: number }, options: { signal?: AbortSignal; assertCurrent?: () => Promise<void> } = {}): Promise<void> {
    const checkpoint = async () => {
      options.signal?.throwIfAborted();
      await options.assertCurrent?.();
      options.signal?.throwIfAborted();
    };
    await checkpoint();
    // Resolve the old name once, then fence again before removing that exact instance. A delayed `rm <name>`
    // could otherwise resolve to the replacement worker's container when Docker eventually processes it.
    const previous = await exec(this.docker, ['inspect', '--format', '{{.Id}}', this.name], { windowsHide: true, timeout: 15_000 })
      .then(({ stdout }) => stdout.trim()).catch(() => '');
    await checkpoint();
    if (/^[a-f0-9]{64}$/i.test(previous)) await removePreviewContainer(previous, this.docker);
    await checkpoint();
    if (!(await this.ws.reuseIfComplete())) {
      await checkpoint();
      await this.ws.remove();
      await checkpoint();
      await this.ws.seed(artifactDir);
      await checkpoint();
      await this.ws.markComplete();
    }
    await checkpoint();
    const publish = ports.flatMap((p, i) => ['--publish', `127.0.0.1:${p}:${forwarderPort(i, range)}`]);
    const forward = ports.map((p, i) => `${forwarderPort(i, range)}:${p}`).join(',');
    const { stdout } = await exec(
      this.docker,
      [
        'run', '--detach',
        '--name', this.name,
        '--label', 'com.projecthub.managed=preview',
        '--label', `com.projecthub.preview=${this.previewId}`,
        '--init',
        '--pull', 'never',
        '--network', 'bridge',
        // Databases and services the project's secrets point at on this machine (see hostLoopbackToGateway).
        '--add-host', 'host.docker.internal:host-gateway',
        '--cpus', String(this.limits.cpus),
        '--memory', `${this.limits.memoryMb}m`,
        '--pids-limit', String(this.limits.pids),
        '--read-only',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true',
        '--user', '1000:1000',
        '--tmpfs', '/tmp:rw,nosuid,size=268435456',
        '--mount', this.ws.mount(),
        '--workdir', '/workspace',
        '--env', `PH_FORWARD=${forward}`,
        '--env', 'HOME=/tmp',
        ...publish,
        '--entrypoint', 'node',
        this.limits.image,
        '-e', FORWARDER,
      ],
      { windowsHide: true, timeout: 120_000 },
    );
    const id = stdout.trim();
    if (!/^[a-f0-9]{64}$/i.test(id)) throw new Error('Docker geçerli container kimliği döndürmedi');
    this.containerId = id;
    try {
      await checkpoint();
    } catch (error) {
      await this.remove();
      throw error;
    }
  }

  /** `docker exec` arguments for one app/service command; values of `envNames` come from the Docker client's env. */
  execArgs(command: string, envNames: string[]): string[] {
    if (!this.containerId) throw new Error('Ön izleme container başlangıcı tamamlanmadı');
    return ['exec', '--workdir', '/workspace', ...envNames.sort().flatMap((k) => ['--env', k]), this.containerId, '/bin/sh', '-lc', command];
  }

  async remove(): Promise<void> {
    const id = this.containerId;
    this.containerId = null;
    if (id) await removePreviewContainer(id, this.docker);
  }

  /** The artifact's volume: removed once no starting or ready preview uses the artifact any more. */
  async removeVolume(): Promise<void> {
    await this.ws.remove();
  }
}

export async function removePreviewContainer(nameOrId: string, docker = process.env.DOCKER_BINARY || 'docker'): Promise<void> {
  await exec(docker, ['rm', '-f', nameOrId], { windowsHide: true, timeout: 60_000 }).catch(() => undefined);
}

/** Preview containers (by preview) and artifact volumes (by artifact) this hub created. */
export async function listPreviewResources(docker = process.env.DOCKER_BINARY || 'docker'): Promise<{ containers: { name: string; previewId: string }[]; volumes: { name: string; artifactId: string; createdAt: number }[] }> {
  const rows = async (args: string[]) => {
    try {
      const { stdout } = await exec(docker, args, { windowsHide: true, timeout: 15_000 });
      return stdout
        .split(/\r?\n/)
        .map((l) => l.trim().split('\t'))
        .filter((r) => r.length >= 2 && !!r[0] && !!r[1])
        .map(([name, id, created]) => ({ name: name!, id: id!, createdAt: Number(created) || 0 }));
    } catch {
      return [];
    }
  };
  return {
    containers: (await rows(['ps', '-a', '--filter', 'label=com.projecthub.managed=preview', '--format', '{{.Names}}\t{{.Label "com.projecthub.preview"}}'])).map((r) => ({ name: r.name, previewId: r.id })),
    volumes: (await rows(['volume', 'ls', '--filter', 'label=com.projecthub.managed=preview-workspace', '--format', '{{.Name}}\t{{.Label "com.projecthub.artifact"}}\t{{.Label "com.projecthub.created"}}'])).map((r) => ({ name: r.name, artifactId: r.id, createdAt: r.createdAt })),
  };
}

export async function removePreviewVolume(name: string, docker = process.env.DOCKER_BINARY || 'docker'): Promise<void> {
  await exec(docker, ['volume', 'rm', '-f', name], { windowsHide: true, timeout: 30_000 }).catch(() => undefined);
}
