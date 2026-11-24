import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { JSDOM } from 'jsdom';
import JSZip from 'jszip';

import { extractFunction, appSource } from './helpers/extract-function.mjs';

const dom = new JSDOM('');
globalThis.DOMParser = dom.window.DOMParser;
after(() => dom.window.close());

for (const name of [
  'normalizeZipPath', 'safeDecodeURIComponent', 'buildZipKeyIndex', 'findZipKey',
  'decodeEpubText', 'parseHtmlToBlocks', 'splitIntoSentences', 'decodeTextRobustly',
  'cleanMojibake', 'repairMojibake', 'garbageTextRatio', 'parseEpubArchive'
]) {
  globalThis[name] = extractFunction(name);
}

const extDecl = appSource().match(/const EPUB_CONTENT_EXT = (\/.+\/i);/);
assert.ok(extDecl);
globalThis.EPUB_CONTENT_EXT = new Function(`return ${extDecl[1]}`)();

const manifest = JSON.parse(fs.readFileSync('public/manifest.webmanifest', 'utf8'));
const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/style.css', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');

test('manifest.webmanifest allows portrait and landscape rotation on phones', () => {
  assert.equal(manifest.orientation, 'any');
});

test('style.css supports phone landscape orientation and horizontal safe-area insets', () => {
  assert.match(css, /--safe-left:\s*env\(safe-area-inset-left/);
  assert.match(css, /--safe-right:\s*env\(safe-area-inset-right/);
  assert.match(css, /@media \(orientation: landscape\) and \(max-height: 540px\)/);
  assert.match(css, /@media \(max-width: 768px\) and \(orientation: portrait\)/);
});

test('app.js handles orientation changes without locking screen orientation', () => {
  assert.doesNotMatch(app, /orientation\.lock\(/);
  assert.match(app, /function handleViewportOrientationChange\(/);
  assert.match(app, /screen\.orientation\.addEventListener\('change', handleViewportOrientationChange\)/);
});

test('reader header and side drawer expose visible chapter display and selector', () => {
  assert.match(html, /id="readerChapterBtn"/);
  assert.match(html, /id="readerChapterLabel"/);
  assert.match(html, /id="navChapters"/);
  assert.match(app, /function openJumpModal\(initialTab = 'chapters'\)/);
  assert.match(app, /updateReaderChapterIndicator\(idx, currentCh\)/);
  assert.match(app, /readerChapterLabel\.textContent = `\$\{currentCh\.title\} · Pg \$\{idx \+ 1\}\/\$\{bookPages\.length\}`/);
});

test('parseEpubArchive reads chapter titles from EPUB 3 nav TOC when XHTML titles are generic', async () => {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Book Title</dc:title></metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
    </package>`);
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?>
    <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
      <body>
        <nav epub:type="toc">
          <ol>
            <li><a href="ch1.xhtml">Chapter 1: Foundations</a></li>
            <li><a href="ch2.xhtml">Chapter 2: Advanced Systems</a></li>
          </ol>
        </nav>
      </body>
    </html>`);
  zip.file('OEBPS/ch1.xhtml', `<html><head><title>Book Title</title></head><body><p>First chapter text here.</p></body></html>`);
  zip.file('OEBPS/ch2.xhtml', `<html><head><title>Book Title</title></head><body><p>Second chapter text here.</p></body></html>`);

  const result = await parseEpubArchive(zip);
  assert.equal(result.chapters.length, 2);
  assert.equal(result.chapters[0].title, 'Chapter 1: Foundations');
  assert.equal(result.chapters[0].pageIndex, 0);
  assert.equal(result.chapters[1].title, 'Chapter 2: Advanced Systems');
  assert.equal(result.chapters[1].pageIndex, 1);
});

test('parseEpubArchive reads chapter titles from EPUB 2 toc.ncx', async () => {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`);
  zip.file('content.opf', `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Textbook</dc:title></metadata>
      <manifest>
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        <item id="c1" href="part1.html" media-type="application/xhtml+xml"/>
        <item id="c2" href="part2.html" media-type="application/xhtml+xml"/>
      </manifest>
      <spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine>
    </package>`);
  zip.file('toc.ncx', `<?xml version="1.0" encoding="utf-8"?>
    <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
      <navMap>
        <navPoint id="np1" playOrder="1">
          <navLabel><text>1. Introduction</text></navLabel>
          <content src="part1.html"/>
        </navPoint>
        <navPoint id="np2" playOrder="2">
          <navLabel><text>2. Thermodynamics</text></navLabel>
          <content src="part2.html#top"/>
        </navPoint>
      </navMap>
    </ncx>`);
  zip.file('part1.html', `<html><head><title>Unknown</title></head><body><p>Energy cannot be created or destroyed.</p></body></html>`);
  zip.file('part2.html', `<html><head><title>Unknown</title></head><body><p>Entropy tends to increase over time.</p></body></html>`);

  const result = await parseEpubArchive(zip);
  assert.equal(result.chapters.length, 2);
  assert.equal(result.chapters[0].title, '1. Introduction');
  assert.equal(result.chapters[1].title, '2. Thermodynamics');
});
