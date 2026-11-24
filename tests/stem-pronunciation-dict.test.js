import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');

test('index.html contains Skip Code & Raw Tables and Pronunciation Dictionary section', () => {
  assert.match(html, /id="skipCodeTablesSelect"/, 'has skipCodeTablesSelect');
  assert.match(html, /id="pronunciationDictSection"/, 'has pronunciationDictSection');
  assert.match(html, /id="dictWordInput"/, 'has dictWordInput');
  assert.match(html, /id="dictSpokenInput"/, 'has dictSpokenInput');
  assert.match(html, /id="dictAddBtn"/, 'has dictAddBtn');
  assert.match(html, /id="dictList"/, 'has dictList');
});

test('public/app.js defines STEM and pronunciation dictionary functions', () => {
  assert.match(app, /function getPronunciationDict\(/, 'getPronunciationDict defined');
  assert.match(app, /function savePronunciationDict\(/, 'savePronunciationDict defined');
  assert.match(app, /function isDenseCodeOrTable\(/, 'isDenseCodeOrTable defined');
  assert.match(app, /function normalizeForSpeech\(/, 'normalizeForSpeech defined');
  assert.match(app, /function renderPronunciationDictUI\(/, 'renderPronunciationDictUI defined');
});

test('STEM speech normalization expands common abbreviations and units', () => {
  // Extract normalizeForSpeech and isDenseCodeOrTable from app.js using Function constructor in mock environment
  const mockStorage = {
    getItem: (key) => (key === 'marginalia_skip_code_tables' ? 'off' : null),
    setItem: () => {}
  };
  const fnFactory = new Function('localStorage', `
    ${app.slice(app.indexOf('function getPronunciationDict()'), app.indexOf('function renderPronunciationDictUI()'))}
    return { normalizeForSpeech, isDenseCodeOrTable };
  `);
  const { normalizeForSpeech, isDenseCodeOrTable } = fnFactory(mockStorage);

  assert.equal(normalizeForSpeech('See Fig. 1 for architecture.'), 'See Figure 1 for architecture.');
  assert.equal(normalizeForSpeech('See Figs. 2 and 3.'), 'See Figures 2 and 3.');
  assert.equal(normalizeForSpeech('As shown in Eq. 4.'), 'As shown in Equation 4.');
  assert.equal(normalizeForSpeech('Compare Eqs. 5 and 6.'), 'Compare Equations 5 and 6.');
  assert.equal(normalizeForSpeech('Smith et al. showed that...'), 'Smith et all showed that...');
  assert.equal(normalizeForSpeech('Use methods e.g., gradient descent'), 'Use methods for example gradient descent');
  assert.equal(normalizeForSpeech('The primary metric, i.e., accuracy'), 'The primary metric, that is accuracy');
  assert.equal(normalizeForSpeech('Energy usage is 15 kWh.'), 'Energy usage is 15 kilowatt hours.');
  assert.equal(normalizeForSpeech('Frequency is 433 MHz.'), 'Frequency is 433 megahertz.');
  assert.equal(normalizeForSpeech('Resistance is 50 Ω.'), 'Resistance is 50 ohms.');
});

test('Skip Code & Raw Tables skips dense code lines and fenced code blocks when enabled', () => {
  let skipSetting = 'on';
  const mockStorage = {
    getItem: (key) => (key === 'marginalia_skip_code_tables' ? skipSetting : null),
    setItem: () => {}
  };
  const fnFactory = new Function('localStorage', `
    ${app.slice(app.indexOf('function getPronunciationDict()'), app.indexOf('function renderPronunciationDictUI()'))}
    return { normalizeForSpeech, isDenseCodeOrTable };
  `);
  const { normalizeForSpeech, isDenseCodeOrTable } = fnFactory(mockStorage);

  const codeSnippet = 'x = (a * b) + [c - d] / {e ^ f} % <g & h> | (i || j);';
  assert.equal(isDenseCodeOrTable(codeSnippet), true);
  assert.equal(normalizeForSpeech(codeSnippet), 'Code block skipped.');

  const fencedBlock = '```\nfunction test() { return 1; }\n```';
  assert.equal(isDenseCodeOrTable(fencedBlock), true);
  assert.equal(normalizeForSpeech(fencedBlock), 'Code block skipped.');

  // When disabled
  skipSetting = 'off';
  assert.notEqual(normalizeForSpeech(codeSnippet), 'Code block skipped.');
});

test('Pronunciation dictionary applies case-sensitive word-boundary substitutions', () => {
  const dictData = [
    { word: 'RSU', spokenAs: 'R S U' },
    { word: 'IEEE', spokenAs: 'I triple E' },
    { word: 'KVL', spokenAs: 'K V L' }
  ];
  const mockStorage = {
    getItem: (key) => {
      if (key === 'marginalia_pronunciation_dict') return JSON.stringify(dictData);
      return null;
    },
    setItem: () => {}
  };
  const fnFactory = new Function('localStorage', `
    ${app.slice(app.indexOf('function getPronunciationDict()'), app.indexOf('function renderPronunciationDictUI()'))}
    return { normalizeForSpeech };
  `);
  const { normalizeForSpeech } = fnFactory(mockStorage);

  assert.equal(
    normalizeForSpeech('The engineer received an RSU grant and IEEE membership using KVL.'),
    'The engineer received an R S U grant and I triple E membership using K V L.'
  );

  // Does NOT match substring or wrong case
  assert.equal(
    normalizeForSpeech('The certificate was ISSUED under rsu bylaws.'),
    'The certificate was ISSUED under rsu bylaws.'
  );
});

test('TTS speech synthesis receives normalized text while DOM remains untouched', () => {
  // Verify speakBrowser and getNeuralAudioSrc invoke normalizeForSpeech
  const speakBrowserMatch = app.match(/function speakBrowser\(text\)[\s\S]*?normalizeForSpeech\(text\)/);
  assert.ok(speakBrowserMatch, 'speakBrowser normalizes text for SpeechSynthesisUtterance');

  const getNeuralSrcMatch = app.match(/async function getNeuralAudioSrc\(text\)[\s\S]*?normalizeForSpeech\(text\)/);
  assert.ok(getNeuralSrcMatch, 'getNeuralAudioSrc normalizes text before cache lookup and synthesis');

  // Verify buildSentenceDOM does NOT call normalizeForSpeech (DOM text stays original)
  const buildSentenceDOMIdx = app.indexOf('function buildSentenceDOM(');
  const nextFnIdx = app.indexOf('function buildDiagramDOM(', buildSentenceDOMIdx);
  assert.ok(nextFnIdx > buildSentenceDOMIdx);
  const buildSentenceDOMBody = app.slice(buildSentenceDOMIdx, nextFnIdx);
  assert.ok(!buildSentenceDOMBody.includes('normalizeForSpeech'), 'buildSentenceDOM leaves DOM text untransformed for visual fidelity');
});
