// Tests for parseEpubArchive in public/app.js — the EPUB pipeline behind the Open button.
// The functions are pulled straight out of the shipped file (it is a classic DOM script and cannot
// be imported directly), and DOMParser comes from jsdom so the real block-extraction code runs.
// Fixtures are built in-memory with JSZip, the same library the page loads from the CDN.

import test from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';
import JSZip from 'jszip';

import { extractFunction, appSource } from './helpers/extract-function.mjs';

globalThis.DOMParser = new JSDOM('').window.DOMParser;

for (const name of [
  'normalizeZipPath', 'safeDecodeURIComponent', 'buildZipKeyIndex', 'findZipKey',
  'decodeEpubText', 'parseHtmlToBlocks', 'splitIntoSentences', 'decodeTextRobustly',
  'garbageTextRatio', 'parseEpubArchive'
]) {
  globalThis[name] = extractFunction(name);
}

// EPUB_CONTENT_EXT is a top-level const, not a function, so it is lifted from the source
const extDecl = appSource().match(/const EPUB_CONTENT_EXT = (\/.+\/i);/);
assert.ok(extDecl, 'EPUB_CONTENT_EXT is present in public/app.js');
globalThis.EPUB_CONTENT_EXT = new Function(`return ${extDecl[1]}`)();

const CONTAINER_XML = `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">test</dc:identifier></metadata>
  <manifest><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;

const CHAPTER_ONE = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head>
<body><p>The wind. The fire.</p></body></html>`;

function makeEpub(extraFiles = {}, chapterContent = CHAPTER_ONE) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', CONTAINER_XML);
  zip.file('EPUB/content.opf', OPF);
  zip.file('EPUB/chapter1.xhtml', chapterContent);
  for (const [path, content] of Object.entries(extraFiles)) zip.file(path, content);
  return zip;
}

// Deterministic binary noise: sequential-ish bytes that decode with ~11% C0 control
// characters, which is what AES-encrypted XHTML looks like after charset decoding.
function encryptedBytes() {
  return Uint8Array.from({ length: 1024 }, (_, i) => (i * 37 + 11) % 256);
}

test('a normal EPUB becomes readable pages', async () => {
  const result = await parseEpubArchive(makeEpub());
  const text = result.pages.flat().join(' ');
  assert.ok(result.pages.length > 0, 'pages were produced');
  assert.match(text, /The wind\./);
  assert.equal(result.chapters[0].title, 'One');
});

test('an LCP-licensed EPUB with encrypted chapters is reported as DRM-protected', async () => {
  const zip = makeEpub(
    { 'META-INF/license.lcpl': '{"license":{"id":"x"}}' },
    encryptedBytes()
  );
  await assert.rejects(parseEpubArchive(zip), /DRM-protected/);
});

test('encrypted chapters without a license file are still reported as DRM-protected', async () => {
  const zip = makeEpub({}, encryptedBytes());
  await assert.rejects(parseEpubArchive(zip), /DRM-protected/);
});

test('encrypted chapters never render as mojibake pages', async () => {
  // Before DRM detection, noise chapters produced hundreds of garbage "sentences"
  const zip = makeEpub({}, encryptedBytes());
  await assert.rejects(parseEpubArchive(zip), (err) => {
    assert.doesNotMatch(err.message, /pages/);
    return true;
  });
});

test('an image-only EPUB reports that there is no readable text', async () => {
  const zip = makeEpub({}, `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Scan</title></head>
<body><img src="missing-scan-page.jpg" alt=""/></body></html>`);
  await assert.rejects(parseEpubArchive(zip), /only images/);
});
