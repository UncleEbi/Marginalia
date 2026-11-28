import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

test('public/index.html includes pageViewToggleBtn and pageViewDrawer elements', () => {
  const html = read('public/index.html');
  assert.match(html, /id="pageViewToggleBtn"/, 'pageViewToggleBtn exists');
  assert.match(html, /📄 Page View/, 'Page View label exists');
  assert.match(html, /id="pageViewDrawer"/, 'pageViewDrawer exists');
  assert.match(html, /id="pageViewCanvas"/, 'pageViewCanvas exists');
  assert.match(html, /id="pageViewAutoFollow"/, 'pageViewAutoFollow checkbox exists');
  assert.match(html, /id="pageViewPrevBtn"/, 'pageViewPrevBtn exists');
  assert.match(html, /id="pageViewNextBtn"/, 'pageViewNextBtn exists');
  assert.match(html, /id="pageViewZoomInBtn"/, 'pageViewZoomInBtn exists');
  assert.match(html, /id="pageViewZoomOutBtn"/, 'pageViewZoomOutBtn exists');
  assert.match(html, /id="pageViewCloseBtn"/, 'pageViewCloseBtn exists');
});

test('public/style.css includes responsive drawer styles (desktop right drawer & mobile bottom sheet)', () => {
  const css = read('public/style.css');
  assert.match(css, /\.page-view-drawer/, '.page-view-drawer class defined');
  assert.match(css, /#pageViewCanvas/, '#pageViewCanvas styled');
  assert.match(css, /@media\s*\(max-width:\s*768px\)/, 'mobile media query exists');
  assert.match(css, /height:\s*65vh/, 'mobile bottom sheet height defined');
});

test('public/app.js handles original PDF binary storage and drawer visibility', () => {
  const app = read('public/app.js');
  assert.match(app, /currentPdfBinary/, 'currentPdfBinary state variable exists');
  assert.match(app, /pageViewToggleBtn\.style\.display\s*=\s*'inline-flex'/, 'shows button when PDF binary is present');
  assert.match(app, /pageViewToggleBtn\.style\.display\s*=\s*'none'/, 'hides button when no PDF binary is present');
  assert.match(app, /savePdfBinaryToDB\(title, options\.originalPdf\)/, 'stores the PDF binary away from the shelf record');
  assert.match(app, /createObjectStore\("pdf_binaries"/, 'a dedicated pdf_binaries store holds the binaries');
  assert.match(app, /getPdfBinaryFromDB\(b\.title\)/, 'the binary is loaded only when the book is opened');
});

test('public/app.js renders high-DPI canvas and cancels in-flight render tasks', () => {
  const app = read('public/app.js');
  assert.match(app, /window\.devicePixelRatio/, 'uses window.devicePixelRatio for high-DPI canvas');
  assert.match(app, /pageViewRenderTask\.cancel\(\)/, 'cancels in-flight render task');
  assert.match(app, /pageViewCanvas\.width\s*=\s*0/, 'resets canvas width to 0 on drawer close for memory release');
  assert.match(app, /pageViewCanvas\.height\s*=\s*0/, 'resets canvas height to 0 on drawer close for memory release');
});

test('public/app.js auto-follows audio on page turns without pausing playback', () => {
  const app = read('public/app.js');
  const renderPageIdx = app.indexOf('function renderPage(idx)');
  assert.ok(renderPageIdx > -1, 'renderPage exists');
  const renderPageBody = app.slice(renderPageIdx, renderPageIdx + 1200);

  assert.match(renderPageBody, /pageViewAutoFollow && pageViewAutoFollow\.checked/, 'checks auto-follow state on page turn');
  assert.match(renderPageBody, /renderOriginalPdfPage/, 're-renders original PDF page on page turn');

  // Verify non-blocking: openPageViewDrawer and closePageViewDrawer do NOT call stopAudio()
  const openDrawerIdx = app.indexOf('function openPageViewDrawer()');
  const openDrawerBody = app.slice(openDrawerIdx, openDrawerIdx + 400);
  assert.doesNotMatch(openDrawerBody, /stopAudio\(\)/, 'openPageViewDrawer does not stop audio');

  const closeDrawerIdx = app.indexOf('function closePageViewDrawer()');
  const closeDrawerBody = app.slice(closeDrawerIdx, closeDrawerIdx + 500);
  assert.doesNotMatch(closeDrawerBody, /stopAudio\(\)/, 'closePageViewDrawer does not stop audio');
});
