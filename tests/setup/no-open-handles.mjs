// tests/setup/no-open-handles.mjs
//
// `node --test` runs each test file in its own process. If something a test started is still holding
// that process's event loop when the file's tests finish (a setInterval, an open server or socket, a
// worker), the process never exits and `npm test` sits there forever with green assertions already
// printed. That is how a leaked jsdom timer hid inside app-runtime-contract for a while.
//
// This module is preloaded into every test process by the `test` script (`--import`). Once the file's
// tests are done it arms a timer that does not keep the process alive by itself (`unref`):
//
//   - clean run      -> the loop empties, Node exits, the timer is discarded, cost is zero
//   - leaked handle  -> the handle holds the loop open, the timer fires, the run fails (exit 1)
//
// Deliberately NOT `--test-force-exit`: that would hide the leak by exiting anyway. A leaked handle
// has to fail the suite, not be papered over.

import { after } from 'node:test';
import { writeSync } from 'node:fs';

// Long enough that the runner's own reporting and asynchronous cleanup have finished; short enough
// that a stall turns into a failure instead of a hung terminal.
const GRACE_MS = 5_000;

// Only the per-file child processes need the guard. The runner process itself owns IPC channels to
// its children, so arming a watchdog there could fire on the runner's own bookkeeping.
const isTestChild = Boolean(process.env.NODE_TEST_CONTEXT);

function describeOpenResources() {
  const info = typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo()
    : [];
  const counts = new Map();
  for (const name of info) counts.set(name, (counts.get(name) || 0) + 1);
  // Every child process has stdio pipes; they never explain a stall by themselves.
  counts.delete('PipeWrap');
  counts.delete('TTYWrap');
  const list = [...counts].map(([name, count]) => `${name} x${count}`);
  return list.length ? list.join(', ') : 'none reported (a native or promise-level handle)';
}

function testFile() {
  const file = process.argv.find((arg) => arg.endsWith('.test.js') || arg.endsWith('.test.mjs'));
  return file || 'this test file';
}

if (isTestChild) {
  after(() => {
    const guard = setTimeout(() => {
      writeSync(2, [
        '',
        '✖ Test process will not exit: a test left a handle open.',
        `  File: ${testFile()}`,
        `  Open resources: ${describeOpenResources()}`,
        '  Every assertion may already have passed — the handle is keeping Node alive.',
        '  Close timers/sockets/servers/workers in an `after` hook (see tests/app-runtime-contract.test.js).',
        `  Reproduce in isolation: node --test ${testFile()}`,
        '',
        ''
      ].join('\n'));
      process.exit(1);
    }, GRACE_MS);
    guard.unref();
  });
}
