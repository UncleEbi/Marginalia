// Contract tests for the pdf.js upgrade.
//
// pdf.js is loaded from a CDN as an ES module (v4+ has no UMD build), and pdf.js throws
// "The API version ... does not match the Worker version ..." if the API and worker files are not
// the exact same version. These tests check the pin, the wiring, and that the CDN still serves the
// files the page asks for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const html = read('public/index.html');
const pkg = JSON.parse(read('package.json'));

const versionInHtml = html.match(/const PDFJS_VERSION = '([^']+)'/)?.[1];
const baseTemplate = html.match(/const PDFJS_BASE = `([^`]+)`/)?.[1];
const pdfjsBase = baseTemplate?.replace('${PDFJS_VERSION}', versionInHtml);

test('index.html pins a pdf.js version', () => {
  assert.ok(versionInHtml, 'PDFJS_VERSION constant is present in index.html');
  assert.match(versionInHtml, /^\d+\.\d+\.\d+$/, 'version looks like a real release');
});

test('the pinned CDN version matches the pdfjs-dist devDependency', () => {
  assert.equal(pkg.devDependencies['pdfjs-dist'], versionInHtml);
});

test('the pinned base URL is well formed and derived from the version', () => {
  assert.ok(baseTemplate, 'PDFJS_BASE constant is present');
  assert.match(pdfjsBase, /^https:\/\//, 'base is https');
  assert.ok(pdfjsBase.includes(versionInHtml), 'base URL carries the pinned version');
});

test('no leftover UMD loader or second version pin', () => {
  // Match script tags only: the explanatory comment may mention the old file names.
  assert.doesNotMatch(html, /src="[^"]*pdf\.min\.js"/, 'the pre-v4 UMD script tag is gone');
  assert.doesNotMatch(html, /src="[^"]*pdf\.worker\.min\.js"/, 'the pre-v4 worker script tag is gone');
  assert.doesNotMatch(html, /cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js/, 'no leftover cdnjs pdf.js URLs');

  const pins = [...html.matchAll(/pdfjs-dist@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  assert.deepEqual(pins, [], 'only the PDFJS_VERSION constant pins a version (no hard-coded URLs)');
});

test('API, worker and standard font data all come from the same base', () => {
  assert.match(html, /import\(`\$\{PDFJS_BASE\}\/build\/pdf\.min\.mjs`\)/);
  assert.match(html, /workerSrc = `\$\{PDFJS_BASE\}\/build\/pdf\.worker\.min\.mjs`/);
  assert.match(html, /standardFontDataUrl: `\$\{PDFJS_BASE\}\/standard_fonts\/`/);
});

test('index.html exposes the engine to the classic app.js and handles load failure', () => {
  assert.match(html, /window\.pdfjsLib = pdfjsLib/);
  assert.match(html, /window\.extractPdfTexts = \(lib, data\) =>/, 'exposes the extraction helper with the font-data option bound');
  assert.match(html, /window\.__resolvePdfjs\(null\)/, 'a failed import resolves the promise so the app can report it');
});

test('CDN serves the ESM API and worker at the pinned version', async () => {
  const [api, worker] = await Promise.all([
    fetch(`${pdfjsBase}/build/pdf.min.mjs`, { signal: AbortSignal.timeout(30000) }),
    fetch(`${pdfjsBase}/build/pdf.worker.min.mjs`, { signal: AbortSignal.timeout(30000) })
  ]);

  assert.equal(api.status, 200, 'pdf.min.mjs is available');
  assert.equal(worker.status, 200, 'pdf.worker.min.mjs is available');

  const [apiText, workerText] = await Promise.all([api.text(), worker.text()]);
  // Both files must carry the pinned version, otherwise pdf.js aborts with a version mismatch
  assert.ok(apiText.includes(versionInHtml), 'API bundle reports the pinned version');
  assert.ok(workerText.includes(versionInHtml), 'worker bundle reports the pinned version');
});

test('CDN serves the standard font data the app points pdf.js at', async () => {
  const res = await fetch(`${pdfjsBase}/standard_fonts/LiberationSans-Regular.ttf`, {
    signal: AbortSignal.timeout(30000)
  });
  assert.equal(res.status, 200, 'standard font data is available');
  assert.ok(Number(res.headers.get('content-length') || 0) > 1000, 'font file has content');
});

test('the old UMD build really is gone upstream (why the loader uses modules)', async () => {
  const res = await fetch(`${pdfjsBase}/build/pdf.min.js`, { signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 404, 'pdf.min.js no longer exists for this version');
});
