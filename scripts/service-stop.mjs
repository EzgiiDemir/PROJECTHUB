import { execFile } from 'node:child_process';

/** Windows SIGTERM is a hard kill. Use the private parent/child IPC channel to let jobs release their leases. */
export function stopService(child, { graceMs = 60_000, forceKill = killTree } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let deadline;
    const finished = () => { clearTimeout(deadline); child.removeListener('exit', finished); resolve(); };
    child.once('exit', finished);
    deadline = setTimeout(() => {
      Promise.resolve(forceKill(child)).catch(reject);
    }, graceMs);
    try {
      if (child.connected) child.send({ type: 'projecthub.shutdown' }, (error) => { if (error) Promise.resolve(forceKill(child)).catch(reject); });
      else child.kill('SIGTERM');
    } catch (error) {
      clearTimeout(deadline);
      child.removeListener('exit', finished);
      reject(error);
    }
  });
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32') { child.kill('SIGKILL'); return; }
  // Exact PID of the Node child we spawned, not a name/path-wide process match. Include command descendants.
  return new Promise((resolve, reject) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
    if (error && child.exitCode === null && child.signalCode === null) reject(error);
    else resolve();
  }));
}
