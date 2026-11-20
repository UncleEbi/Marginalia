// The reading path answers /api/tts and /api/summarize with these two gates:
//   429 { error: 'TEMP_LOCKOUT' | other, retryAfter }  + Retry-After header
//   403 { error: 'EMAIL_VERIFICATION_REQUIRED' }
// They used to surface as raw codes in an alert. These tests pin the translation: a readable reason,
// a wait taken from the server, and a next step (countdown, or the sign-in form for verification).

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFunction } from './helpers/extract-function.mjs';

const explainAiRefusal = extractFunction('explainAiRefusal');
const retryAfterSeconds = extractFunction('retryAfterSeconds');

async function withGlobals(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }
}

function stubs() {
  const seen = { countdowns: [], alerts: [], authModal: { style: {} }, badgeUpdates: 0 };
  return {
    seen,
    globals: {
      showReaderCountdown: (seconds, reason, onReady) => seen.countdowns.push({ seconds, reason, onReady }),
      showAuthAlert: (msg, type) => seen.alerts.push({ msg, type }),
      updateAuthBadge: () => { seen.badgeUpdates += 1; },
      authModal: seen.authModal
    }
  };
}

test('a TEMP_LOCKOUT becomes a protection notice plus the server wait, never the raw code', async () => {
  const { seen, globals } = stubs();
  await withGlobals(globals, async () => {
    assert.equal(explainAiRefusal(429, 'TEMP_LOCKOUT', 900), true, 'handled');
  });
  assert.equal(seen.countdowns.length, 1);
  assert.equal(seen.countdowns[0].seconds, 900, 'the countdown uses the server value');
  assert.match(seen.countdowns[0].reason, /paused for your protection/);
  assert.doesNotMatch(seen.countdowns[0].reason, /TEMP_LOCKOUT/);
});

test('a plain 429 still gets a counted-down reason without the code', async () => {
  const { seen, globals } = stubs();
  await withGlobals(globals, async () => {
    assert.equal(explainAiRefusal(429, '', 30), true);
  });
  assert.equal(seen.countdowns[0].seconds, 30);
  assert.match(seen.countdowns[0].reason, /Too many AI requests/);
  assert.equal(seen.alerts.length, 0);
});

test('the verification gate opens the sign-in form and says what to do next', async () => {
  const { seen, globals } = stubs();
  await withGlobals(globals, async () => {
    assert.equal(explainAiRefusal(403, 'EMAIL_VERIFICATION_REQUIRED', 30), true);
  });
  assert.equal(seen.authModal.style.display, 'flex', 'the reader gets somewhere to act');
  assert.equal(seen.badgeUpdates, 1);
  assert.equal(seen.alerts.length, 1);
  assert.match(seen.alerts[0].msg, /Confirm your email address/);
  assert.match(seen.alerts[0].msg, /sign in again/);
  assert.doesNotMatch(seen.alerts[0].msg, /EMAIL_VERIFICATION_REQUIRED/);
  assert.equal(seen.countdowns.length, 0, 'a 403 is not a wait');
});

test('other statuses and codes are left to the existing handling', async () => {
  const { seen, globals } = stubs();
  await withGlobals(globals, async () => {
    assert.equal(explainAiRefusal(500, 'OpenAI Vision error', 30), false);
    assert.equal(explainAiRefusal(403, 'SOMETHING_ELSE', 30), false);
    assert.equal(explainAiRefusal(undefined, undefined, 30), false);
  });
  assert.equal(seen.countdowns.length, 0);
  assert.equal(seen.alerts.length, 0);
  assert.equal(seen.authModal.style.display, undefined, 'the modal is not opened for anything else');
});

test('the wait comes from the body, then the Retry-After header, then 30 seconds', async () => {
  const headers = (value) => ({ headers: { get: (name) => (name === 'Retry-After' ? value : null) } });
  assert.equal(retryAfterSeconds(headers('120'), { retryAfter: 45 }), 45, 'the JSON body wins');
  assert.equal(retryAfterSeconds(headers('120'), {}), 120, 'then the header');
  assert.equal(retryAfterSeconds(headers(null), null), 30, 'then a safe default');
});
