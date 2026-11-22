// tests/setup/no-open-handles.mjs
//
// `node --test` runs each test file in its own process. If something a test started is still holding
// that process's event loop when the file's tests finish (a setInterval, an open server or socket, a
// worker), the process never exits and `npm test` sits there forever with green assertions already
// printed. That is how a leaked jsdom timer hid inside app-runtime-contract for a while.
//
// This module is preloaded into every test process by the `test` script (`--import`). It snapshots the
// process's active resources around every test, so a leak can be pinned on the test that introduced
// it. Once the file's tests are done it arms a timer that does not keep the process alive by itself
// (`unref`):
//
//   - clean run      -> the loop empties, Node exits, the timer is discarded, cost is zero
//   - leaked handle  -> the handle holds the loop open, the timer fires, the run fails (exit 1) and
//                       names the test and the handle
//
// Deliberately NOT `--test-force-exit`: that would hide the leak by exiting anyway. A leaked handle
// has to fail the suite, not be papered over.

import { after, afterEach, beforeEach } from 'node:test';
import { writeSync } from 'node:fs';

// Long enough that the runner's own reporting and asynchronous cleanup have finished; short enough
// that a stall turns into a failure instead of a hung terminal.
const GRACE_MS = 5_000;

// Only the per-file child processes need the guard. The runner process itself owns IPC channels to
// its children, so arming a watchdog there could fire on the runner's own bookkeeping.
const isTestChild = Boolean(process.env.NODE_TEST_CONTEXT);

// Every child process has stdio pipes; they never explain a stall by themselves.
const IGNORED_RESOURCES = new Set(['PipeWrap', 'TTYWrap']);

function activeCounts() {
  const info = typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo()
    : [];
  const counts = new Map();
  for (const name of info) {
    if (IGNORED_RESOURCES.has(name)) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

// Resource kinds a test started and left behind, as "Timeout x1, TCPServerWrap x1".
function addedSince(before, now) {
  const added = [];
  for (const [name, count] of now) {
    const delta = count - (before.get(name) || 0);
    if (delta > 0) added.push(`${name} x${delta}`);
  }
  return added;
}

function describe(counts) {
  const list = [...counts].map(([name, count]) => `${name} x${count}`);
  return list.length ? list.join(', ') : 'none reported (a native or promise-level handle)';
}

const baseline = activeCounts();
const suspects = []; // { test, added } in the order the tests ran

if (isTestChild) {
  let beforeTest = baseline;

  beforeEach(() => {
    beforeTest = activeCounts();
  });

  afterEach((t) => {
    const now = activeCounts();
    const added = addedSince(beforeTest, now);
    if (added.length) suspects.push({ test: t.name, added: added.join(', ') });
    beforeTest = now;
  });
}

// The test that introduced a handle which is still open at shutdown. Walking back from the newest
// suspect keeps the blame on the test that created the surviving handle rather than a later one.
function culprit(remaining) {
  for (let i = suspects.length - 1; i >= 0; i--) {
    const kindStillOpen = suspects[i].added
      .split(', ')
      .some((entry) => remaining.has(entry.replace(/ x\d+$/, '')));
    if (kindStillOpen) return suspects[i];
  }
  return null;
}

function testFile() {
  const file = process.argv.find((arg) => arg.endsWith('.test.js') || arg.endsWith('.test.mjs'));
  return file || 'this test file';
}

function blame(remaining) {
  const suspect = culprit(remaining);
  if (suspect) {
    return [
      `  Test: "${suspect.test}" (left behind ${suspect.added})`,
      '  That test is the one to fix: clear what it starts, usually in an `after` hook.'
    ];
  }
  if (baseline.size) {
    return [
      `  Test: none — ${describe(baseline)} were already open before the first test ran,`,
      '  so the handle comes from importing a module at the top of the file.'
    ];
  }
  return [
    '  Test: could not be attributed — no test added a handle that the snapshot can see',
    '  (the resource may be native or promise-level). Bisect with `node --test --test-name-pattern`.'
  ];
}

if (isTestChild) {
  after(() => {
    const guard = setTimeout(() => {
      const remaining = activeCounts();
      writeSync(2, [
        '',
        '✖ Test process will not exit: a test left a handle open.',
        `  File: ${testFile()}`,
        ...blame(remaining),
        `  Still open: ${describe(remaining)}`,
        '  Every assertion may already have passed — the handle is keeping Node alive.',
        `  Reproduce in isolation: node --test ${testFile()}`,
        '',
        ''
      ].join('\n'));
      process.exit(1);
    }, GRACE_MS);
    guard.unref();
  });
}
