import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Probe on the execution worker, not the API host (which may be another machine). */
export async function assertTerminalRuntime(binary: string, probe = async () => {
  const { stdout } = await exec(binary, ['info', '--format', '{{.OSType}}'], { timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true });
  if (stdout.trim() !== 'linux') throw new Error('Linux container engine required');
}): Promise<void> {
  try {
    await probe();
  } catch {
    throw new Error('İzole terminal başlatılamadı: worker Docker motoruna erişemiyor. Docker Desktop/Linux motorunu başlatın veya sunucudaki Docker bağlantısını düzeltin, ardından yeniden deneyin. Güvenlik nedeniyle komutlar host üzerinde çalıştırılmaz.');
  }
}
