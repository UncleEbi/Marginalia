// tests/helpers/leaks-a-handle.fixture.mjs
//
// Deliberately broken test file, used by tests/no-open-handles.test.js to prove the preloaded guard
// still catches a leaked handle. Never run by `npm test`'s discovery (only `*.test.js` is discovered);
// it is run explicitly, with the guard preloaded.
//
// Expected outcome: the first and last tests are clean, the middle one leaves a timer behind, so the
// guard should fail the process and blame "the test that leaks a timer".

import { test } from 'node:test';

test('clears the timer it starts', () => {
  const timer = setInterval(() => {}, 1_000);
  clearInterval(timer);
});

test('the test that leaks a timer', () => {
  setInterval(() => {}, 1_000);
});

test('a later clean test', () => {});
