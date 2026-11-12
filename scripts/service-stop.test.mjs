import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { stopService } from './service-stop.mjs';

function child() {
  const process = new EventEmitter();
  Object.assign(process, { pid: 123, exitCode: null, signalCode: null, connected: true });
  return process;
}
test('requests graceful IPC shutdown instead of killing a live service', async () => {
  const process = child();
  process.send = (message, callback) => { assert.equal(message.type, 'projecthub.shutdown'); callback(null); queueMicrotask(() => process.emit('exit')); };
  process.kill = () => assert.fail('unexpected hard kill');
  await stopService(process, { forceKill: () => assert.fail('unexpected tree kill') });
});
test('uses the exact child for fallback only after its grace deadline', async () => {
  const process = child();
  let forced = false;
  process.send = (_message, callback) => callback(null);
  await stopService(process, { graceMs: 5, forceKill: (target) => { assert.equal(target, process); forced = true; process.emit('exit'); } });
  assert.equal(forced, true);
});
test('does not signal an already exited service', async () => {
  const process = child();
  process.exitCode = 0;
  process.send = () => assert.fail('must not signal exited PID');
  await stopService(process);
});
