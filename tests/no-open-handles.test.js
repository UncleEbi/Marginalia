// tests/no-open-handles.test.js
//
// The handle guard (tests/setup/no-open-handles.mjs) only arms itself inside `node --test` child
// processes. If Node ever changes how those children are flagged, the guard would go quiet and the
// suite would go back to hanging silently instead of failing. These tests make that loud.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const guard = fileURLToPath(new URL('./setup/no-open-handles.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./helpers/leaks-a-handle.fixture.mjs', import.meta.url));
const guardUrl = pathToFileURL(guard).href;

test('the guard recognises a test child process, so it arms itself', () => {
  // This file is already running inside a `node --test` child; that is exactly the signal the guard
  // keys off. An empty value means Node no longer flags children this way and the guard is inert.
  assert.ok(
    process.env.NODE_TEST_CONTEXT,
    'NODE_TEST_CONTEXT is not set in the test child, so tests/setup/no-open-handles.mjs never arms'
  );
});

test('the guard fails a leaking test file and names the leaking test', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // let the nested run be a plain runner, not a child of this one
  // Shorten the grace period for this fixture only, so the proof runs fast; production keeps 5s.
  env.NO_OPEN_HANDLES_GRACE_MS = '500';

  const run = spawnSync(
    process.execPath,
    ['--test', '--import', guardUrl, fixture],
    { env, encoding: 'utf8', timeout: 15_000 }
  );

  const output = `${run.stdout || ''}${run.stderr || ''}`;
  assert.equal(run.status, 1, `a leaked handle must fail the run, got status ${run.status}:\n${output}`);
  assert.match(output, /will not exit/, `expected the guard's failure message:\n${output}`);
  assert.match(output, /Test: "the test that leaks a timer"/, `expected the guard to blame the leaking test:\n${output}`);
  assert.match(output, /Timeout x1/, `expected the guard to name the handle:\n${output}`);
});
