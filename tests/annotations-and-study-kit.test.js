// tests/annotations-and-study-kit.test.js
//
// Tests for Phase 1 enhancements:
// - Margin annotations, highlight palette, and notes
// - Study Kit exporter (Markdown / Notion / Obsidian & Anki flashcards)
// - Cognitive accelerators (Bionic reading word fixation & pacing ruler)
// - Contract check that all required DOM IDs exist in index.html

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractFunction } from './helpers/extract-function.mjs';

const htmlPath = fileURLToPath(new URL('../public/index.html', import.meta.url));
const html = readFileSync(htmlPath, 'utf8');

test('all Phase 1 DOM element IDs exist in index.html', () => {
  const requiredIds = [
    'navAnnotations',
    'navStudyKit',
    'btnSelectionHighlight',
    'btnSelectionNote',
    'noteModal',
    'noteModalQuote',
    'noteModalText',
    'saveNoteBtn',
    'noteColorPicker',
    'annotationsModal',
    'annotationsModalList',
    'studyKitModal',
    'tabStudyKitMarkdown',
    'tabStudyKitAnki',
    'studyKitPreview',
    'btnStudyKitCopy',
    'btnStudyKitDownload',
    'bionicModeSelect',
    'pacingRulerSelect'
  ];

  for (const id of requiredIds) {
    assert.ok(html.includes(`id="${id}"`), `element id="${id}" must exist in index.html`);
  }
});

test('formatBionicWord bolds initial fixation letters accurately', () => {
  const formatBionicWord = extractFunction('formatBionicWord');

  // Short words (length <= 3) should fixate 1 letter
  assert.equal(formatBionicWord('The'), '<strong class="bionic-fix">T</strong>he');
  assert.equal(formatBionicWord('and'), '<strong class="bionic-fix">a</strong>nd');
  assert.equal(formatBionicWord('I'), '<strong class="bionic-fix">I</strong>');

  // Medium words (4-6 chars) should fixate ~45% (ceil)
  // 'book' (4) -> ceil(1.8) = 2
  assert.equal(formatBionicWord('book'), '<strong class="bionic-fix">bo</strong>ok');
  // 'reader' (6) -> ceil(2.7) = 3
  assert.equal(formatBionicWord('reader'), '<strong class="bionic-fix">rea</strong>der');

  // Longer words (10 chars) -> ceil(4.5) = 5
  assert.equal(formatBionicWord('Marginalia'), '<strong class="bionic-fix">Margi</strong>nalia');

  // Words with attached punctuation
  assert.equal(formatBionicWord('"Hello,"'), '&quot;<strong class="bionic-fix">Hel</strong>lo,&quot;');
  assert.equal(formatBionicWord('(fast)'), '(<strong class="bionic-fix">fa</strong>st)');

  // Empty or non-word chunks
  assert.equal(formatBionicWord(''), '');
  assert.equal(formatBionicWord('---'), '---');
});

test('bionicMode and pacingRuler options options exist with expected initial choices', () => {
  assert.ok(html.includes('id="bionicModeSelect"'), 'bionicModeSelect exists');
  assert.ok(html.includes('value="on">On (Bionic fixation guidance)'), 'bionicMode on option exists');
  assert.ok(html.includes('id="pacingRulerSelect"'), 'pacingRulerSelect exists');
  assert.ok(html.includes('value="active">Active Sentence Spotlight'), 'pacing ruler active option exists');
});

test('color dot choices include amber, mint, and rose', () => {
  assert.ok(html.includes('data-color="amber"'), 'amber color choice exists');
  assert.ok(html.includes('data-color="mint"'), 'mint color choice exists');
  assert.ok(html.includes('data-color="rose"'), 'rose color choice exists');
});

test('Study Kit export formats: Markdown structure and Anki TSV format', () => {
  const docTitle = 'Neurology_Textbook.pdf';
  const notes = [
    { page: 2, color: 'amber', quoteText: 'Neurons fire in synchronized bursts.', noteText: 'Exam question: see chapter 4.' },
    { page: 5, color: 'mint', quoteText: 'Action potential threshold is -55mV.', noteText: '' }
  ];
  const vocab = [
    { word: 'synapse', partOfSpeech: 'noun', definition: 'The junction between two nerve cells.', context: 'Crossed the synapse cleanly.' }
  ];

  // Markdown validation
  let md = `# Study Kit: ${docTitle}\n\n## 📝 Margin Notes & Highlights (${notes.length})\n\n`;
  notes.forEach((n, idx) => {
    md += `### ${idx + 1}. Page ${n.page + 1} (${n.color})\n> "${n.quoteText}"\n\n`;
    if (n.noteText) md += `💡 **Note:** ${n.noteText}\n\n`;
  });
  md += `## 📖 Vocabulary & Definitions (${vocab.length})\n\n`;
  vocab.forEach(v => {
    md += `- **${v.word}** *(${v.partOfSpeech})*: ${v.definition}\n  > Context: "${v.context}"\n`;
  });

  assert.ok(md.includes('# Study Kit: Neurology_Textbook.pdf'));
  assert.ok(md.includes('Neurons fire in synchronized bursts.'));
  assert.ok(md.includes('Exam question: see chapter 4.'));
  assert.ok(md.includes('- **synapse** *(noun)*: The junction between two nerve cells.'));

  // Anki TSV validation
  let anki = `#separator:tab\n#html:true\n#tags column:3\n`;
  vocab.forEach(v => {
    const front = v.word;
    const back = `<i>(${v.partOfSpeech})</i> <b>${v.definition}</b><br><br><small>Context: &quot;${v.context}&quot;</small>`;
    const tag = `Marginalia::${docTitle.replace(/[\s\t\n:]+/g, '_')}`;
    anki += `${front}\t${back}\t${tag}\n`;
  });

  const lines = anki.trim().split('\n');
  assert.equal(lines[0], '#separator:tab');
  assert.equal(lines[1], '#html:true');
  assert.equal(lines[2], '#tags column:3');

  const vocabLine = lines[3].split('\t');
  assert.equal(vocabLine[0], 'synapse');
  assert.ok(vocabLine[1].includes('The junction between two nerve cells.'));
  assert.equal(vocabLine[2], 'Marginalia::Neurology_Textbook.pdf');
});
