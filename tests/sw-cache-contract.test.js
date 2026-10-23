// Contract tests for the service worker's caching policy.
//
// The EPUB parser lives in app.js, so installed phones only receive parser fixes if the service
// worker actually revalidates app.js. It used to serve the app shell cache-first forever, which
// froze phones on whatever app.js they first downloaded — these tests keep that from returning.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sw = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');

test('cache VERSION has moved past the versions that cached the shell cache-first', () => {
  const version = sw.match(/const VERSION = '([^']+)'/)?.[1];
  assert.ok(version, 'VERSION is present');
  assert.ok(!['marginalia-v1', 'marginalia-v2', 'marginalia-v3'].includes(version),
    `VERSION ${version} is a fresh cache generation`);
});

test('the app shell revalidates on every load instead of serving cache-first', () => {
  assert.match(sw, /NETWORK_FIRST_PATHS/, 'a network-first path list exists');
  for (const path of ['/index.html', '/app.js', '/style.css']) {
    assert.ok(sw.includes(`'${path}'`), `${path} is in the network-first list`);
  }
  // The network-first branch must try the network before consulting the cache
  const branch = sw.match(/if \(isNavigation \|\| NETWORK_FIRST_PATHS\.has\(url\.pathname\)\) \{([\s\S]*?)\n    \}/);
  assert.ok(branch, 'network-first branch handles shell paths');
  assert.ok(branch[1].indexOf('fetch(req)') < branch[1].indexOf('caches.match'),
    'fetch happens before the cache fallback');
});

test('the shell is still pre-cached so the app works offline', () => {
  assert.match(sw, /const SHELL = \[/);
  for (const asset of ['./index.html', './app.js', './style.css']) {
    assert.ok(sw.includes(asset), `${asset} is pre-cached on install`);
  }
  assert.match(sw, /self\.skipWaiting\(\)/, 'updates activate without waiting');
  assert.match(sw, /self\.clients\.claim\(\)/, 'the new worker takes over open pages');
});
