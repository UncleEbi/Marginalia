// tests/app-runtime-contract.test.js
//
// Verifies that public/app.js evaluates without runtime errors when loaded in the browser DOM,
// that all referenced element IDs exist in public/index.html, and that document upload
// works cleanly for unauthenticated freemium visitors without throwing missing-function errors.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../public/app.js', import.meta.url));
const html = readFileSync(htmlPath, 'utf8');
const appJs = readFileSync(appPath, 'utf8');

// app.js starts a 1s progress interval at load. jsdom runs timers on Node's event loop, so every
// window created here has to be closed or `node --test` never exits after the assertions pass.
const openDoms = [];
after(() => {
  for (const dom of openDoms) dom.window.close();
});

function setupTestDom() {
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://marginalia-rme.vercel.app/'
  });
  openDoms.push(dom);

  dom.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  dom.window.speechSynthesis = {
    getVoices: () => [],
    speak: () => {},
    cancel: () => {},
    pause: () => {},
    resume: () => {},
    addEventListener: () => {}
  };
  dom.window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  dom.window.Audio = function () {
    return {
      play: async () => {},
      pause: () => {},
      addEventListener: () => {}
    };
  };
  dom.window.indexedDB = {
    open: () => ({
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null
    })
  };
  dom.window.navigator.serviceWorker = {
    register: async () => ({ update: async () => {} }),
    addEventListener: () => {}
  };
  dom.window.supabase = {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } })
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null })
          })
        })
      })
    })
  };
  dom.window.JSZip = {
    loadAsync: async () => ({ files: {} })
  };
  dom.window.mammoth = {
    convertToHtml: async () => ({ value: '' }),
    images: { imgElement: () => {} }
  };
  return dom;
}

test('app.js initializes and executes on index.html DOM without errors', () => {
  const dom = setupTestDom();
  assert.doesNotThrow(() => {
    dom.window.eval(appJs);
  }, 'app.js evaluates without ReferenceError or TypeError');
});

test('unauthenticated file upload executes freemium processing without error or alert', async () => {
  const dom = setupTestDom();
  let alertMessage = null;
  dom.window.alert = (msg) => { alertMessage = msg; };

  dom.window.eval(appJs);

  const fileInput = dom.window.document.getElementById('fileInput');
  assert.ok(fileInput, 'fileInput exists in DOM');

  const fakeFile = {
    name: 'chapter1.txt',
    arrayBuffer: async () => new TextEncoder().encode('Call me Ishmael. Some years ago never mind how long precisely.').buffer
  };
  Object.defineProperty(fileInput, 'files', {
    value: [fakeFile],
    configurable: true
  });

  fileInput.dispatchEvent(new dom.window.Event('change'));
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(alertMessage, null, `no alert triggered during upload, got: ${alertMessage}`);
  assert.equal(dom.window.document.getElementById('docTitle').textContent, 'chapter1.txt');
});

test('the shelf renders local data before it reconciles with the cloud', () => {
  assert.doesNotMatch(appJs, /await restoreProgressFromCloud\(\)/, 'nothing may await the cloud pull');

  const start = appJs.indexOf('async function showShelfModal');
  const end = appJs.indexOf('navRecentList.addEventListener');
  assert.ok(start > -1 && end > start, 'showShelfModal is discoverable in app.js');
  const shelfBody = appJs.slice(start, end);

  assert.ok(
    shelfBody.indexOf("shelfModal.style.display = 'flex'") < shelfBody.indexOf('restoreProgressFromCloud()'),
    'the cloud pull starts only after the shelf is visible'
  );
  assert.ok(shelfBody.includes('skipCloudSync'), 'the re-render after a sync cannot start another pull');
});

test('the shelf backup controls and storage note exist in index.html', () => {
  const dom = setupTestDom();
  for (const id of ['exportLibraryBtn', 'importLibraryBtn', 'importLibraryInput', 'shelfStorageNote']) {
    assert.ok(dom.window.document.getElementById(id), `${id} exists in the shelf modal`);
  }
});

test('app.js evaluates when the browser refuses persistent storage', () => {
  const dom = setupTestDom();
  Object.defineProperty(dom.window.navigator, 'storage', {
    configurable: true,
    value: {
      persist: async () => false,
      estimate: async () => ({ usage: 5 * 1024 * 1024 })
    }
  });

  assert.doesNotThrow(() => { dom.window.eval(appJs); });
});

test('profileRefillBalance and profileRefillBalanceTopup exist in index.html', () => {
  assert.ok(html.includes('id="profileRefillBalance"'), 'profileRefillBalance element exists in HTML');
  assert.ok(html.includes('id="profileRefillBalanceTopup"'), 'profileRefillBalanceTopup element exists in HTML');
});

test('openProfileModal falls back gracefully when topup columns are missing', async () => {
  const dom = setupTestDom();
  let queryCount = 0;
  dom.window.supabase = {
    createClient: () => ({
      auth: {
        getSession: async () => ({
          data: {
            session: {
              user: { id: 'test-user-id', email: 'test@example.com' }
            }
          }
        }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } })
      },
      from: () => ({
        select: (cols) => ({
          eq: () => ({
            maybeSingle: async () => {
              queryCount++;
              if (cols.includes('topup_neural_chars')) {
                return {
                  data: null,
                  error: { message: "column 'topup_neural_chars' does not exist", code: '42703' }
                };
              }
              return {
                data: {
                  neural_chars_remaining: 3500,
                  summary_credits_remaining: 2,
                  tier: 'free'
                },
                error: null
              };
            }
          })
        })
      })
    })
  };

  dom.window.eval(appJs);
  const navProfileItem = dom.window.document.getElementById('navProfileItem');
  navProfileItem.dispatchEvent(new dom.window.Event('click'));
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(queryCount >= 2, 'second fallback query was executed after column error');
  assert.equal(dom.window.document.getElementById('profileModalTier').textContent, '⚡ Free Trial Account');
  assert.equal(dom.window.document.getElementById('profileNeuralCount').textContent, '3,500 / 5,000 Chars');
});

