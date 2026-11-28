// tests/cloud-sync-and-companion.test.js
//
// Tests for Phase 3 enhancements:
// - Point 3: Bi-directional Supabase cloud sync (schema migration, reconciliation logic, offline fallback)
// - Point 5: In-situ AI reading companion drawer (DOM contract, chip modes, prompt routing)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const htmlPath = fileURLToPath(new URL('../public/index.html', import.meta.url));
const html = readFileSync(htmlPath, 'utf8');
const cssPath = fileURLToPath(new URL('../public/style.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');
const appPath = fileURLToPath(new URL('../public/app.js', import.meta.url));
const app = readFileSync(appPath, 'utf8');

const migrationPath = fileURLToPath(new URL('../supabase/migrations/20261123_cloud_sync.sql', import.meta.url));

test('Supabase cloud sync migration file exists and defines secure RLS for user_bookmarks and user_annotations', () => {
  assert.ok(existsSync(migrationPath), 'Migration 20261123_cloud_sync.sql must exist');
  const sql = readFileSync(migrationPath, 'utf8');

  // Verify user_bookmarks schema and RLS
  assert.ok(sql.includes('create table if not exists public.user_bookmarks'), 'Must create user_bookmarks');
  assert.ok(sql.includes('alter table public.user_bookmarks enable row level security;'), 'Must enable RLS on user_bookmarks');
  assert.ok(sql.includes('"user_bookmarks: read own rows"'), 'Must have read own rows policy for user_bookmarks');
  assert.ok(sql.includes('"user_bookmarks: insert own rows"'), 'Must have insert own rows policy for user_bookmarks');
  assert.ok(sql.includes('"user_bookmarks: delete own rows"'), 'Must have delete own rows policy for user_bookmarks');

  // Verify user_annotations schema and RLS
  assert.ok(sql.includes('create table if not exists public.user_annotations'), 'Must create user_annotations');
  assert.ok(sql.includes('alter table public.user_annotations enable row level security;'), 'Must enable RLS on user_annotations');
  assert.ok(sql.includes('"user_annotations: read own rows"'), 'Must have read own rows policy for user_annotations');
  assert.ok(sql.includes('"user_annotations: insert own rows"'), 'Must have insert own rows policy for user_annotations');
  assert.ok(sql.includes('"user_annotations: delete own rows"'), 'Must have delete own rows policy for user_annotations');
});

test('all AI Reading Companion DOM elements exist in index.html', () => {
  const requiredCompanionIds = [
    'openCompanionBtn',
    'navCompanion',
    'btnSelectionCompanion',
    'companionOverlay',
    'companionDrawer',
    'companionHeaderSub',
    'closeCompanionBtn',
    'companionContextText',
    'chipSimplify',
    'chipSocratic',
    'chipTerms',
    'companionResponses',
    'companionInput',
    'companionSendBtn'
  ];

  for (const id of requiredCompanionIds) {
    assert.ok(html.includes(`id="${id}"`), `element id="${id}" must exist in index.html`);
  }
  assert.match(html, /Reads the highlighted selection or active sentence/, 'companion welcome clarifies passage source and AI credits/BYOK');
});

test('the companion is reachable on phones through the drawer and an unclipped header', () => {
  assert.match(html, /id="navCompanion"[\s\S]*?Reading Companion/, 'the drawer lists Reading Companion');
  assert.match(app, /navCompanion\.addEventListener\('click'/, 'the drawer entry opens the companion');
  assert.match(app, /openCompanionDrawer\(\);/, 'the drawer entry uses the same opener as the header');
  assert.match(
    css,
    /@media \(max-width: 768px\)[\s\S]*?\.header-actions \.btn-label\s*\{\s*display:\s*none;/,
    'phone headers become icon-only so the Companion button is not pushed off screen'
  );
});

test('api/summarize handles companion modes: simplify, socratic, explain_terms, ask', async () => {
  const summarizeSrc = readFileSync(
    fileURLToPath(new URL('../api/summarize.js', import.meta.url)),
    'utf8'
  );

  // Verify mode definitions
  assert.ok(summarizeSrc.includes("'simplify'"), 'Must support simplify mode');
  assert.ok(summarizeSrc.includes("'socratic'"), 'Must support socratic mode');
  assert.ok(summarizeSrc.includes("'explain_terms'"), 'Must support explain_terms mode');
  assert.ok(summarizeSrc.includes("'ask'"), 'Must support ask mode');

  // Verify prompt tailoring
  assert.ok(summarizeSrc.includes('Explain and simplify this passage'), 'Must prompt simplification in simplify mode');
  assert.ok(summarizeSrc.includes('Socratic comprehension questions'), 'Must prompt questions in socratic mode');
  assert.ok(summarizeSrc.includes('Identify the key terms'), 'Must prompt term explanations in explain_terms mode');
  assert.ok(summarizeSrc.includes('Question: ${question'), 'Must embed user question in ask mode');
});
