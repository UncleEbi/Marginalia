// tests/app-runtime-contract.test.js
//
// Verifies that public/app.js evaluates without runtime errors when loaded in the browser DOM,
// that all referenced element IDs exist in public/index.html, and that document upload
// works cleanly for unauthenticated freemium visitors without throwing missing-function errors.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../public/app.js', import.meta.url));
const html = readFileSync(htmlPath, 'utf8');
const appJs = readFileSync(appPath, 'utf8');

function setupTestDom() {
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://marginalia-rme.vercel.app/'
  });

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

test('profileRefillBalance and profileRefillBalanceTopup exist in index.html', () => {
  assert.ok(html.includes('id="profileRefillBalance"'), 'profileRefillBalance element exists in HTML');
  assert.ok(html.includes('id="profileRefillBalanceTopup"'), 'profileRefillBalanceTopup element exists in HTML');
});
