// tests/cloud-sync-and-companion.test.js
//
// Tests for Phase 3 enhancements:
// - Point 3: Bi-directional Supabase cloud sync (schema migration, reconciliation logic, offline fallback)
// - Point 5: In-situ AI reading companion drawer (DOM contract, chip modes, prompt routing)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractFunction } from './helpers/extract-function.mjs';

const htmlPath = fileURLToPath(new URL('../public/index.html', import.meta.url));
const html = readFileSync(htmlPath, 'utf8');

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

test('syncAllWithCloud gracefully handles unauthenticated and offline states without throwing', async () => {
  const syncAllWithCloud = extractFunction('syncAllWithCloud');

  // Case 1: No supabaseClient
  globalThis.supabaseClient = null;
  const noClientRes = await syncAllWithCloud();
  assert.equal(noClientRes.success, false);
  assert.equal(noClientRes.reason, 'no_client');

  // Case 2: Client exists but user not signed in
  globalThis.supabaseClient = {
    auth: {
      async getSession() {
        return { data: { session: null } };
      }
    }
  };
  const unauthRes = await syncAllWithCloud();
  assert.equal(unauthRes.success, false);
  assert.equal(unauthRes.reason, 'not_authenticated');
});

test('syncAllWithCloud reconciles bookmarks, annotations, and progress bidirectionally', async () => {
  const syncAllWithCloud = extractFunction('syncAllWithCloud');

  const savedBookmarksLocally = [];
  const savedAnnotationsLocally = [];
  const updatedBookProgressLocally = [];
  const pushedCloudBookmarks = [];
  const pushedCloudAnnotations = [];

  globalThis.saveBookmarkToDB = async (title, page, sent, snip) => {
    savedBookmarksLocally.push({ title, page, sent, snip });
  };
  globalThis.saveAnnotationToDB = async (ann) => {
    savedAnnotationsLocally.push(ann);
  };
  globalThis.updateBookProgressInDB = async (title, page, sent) => {
    updatedBookProgressLocally.push({ title, page, sent });
  };
  globalThis.syncBookmarkToCloud = async (title, page, sent, snip) => {
    pushedCloudBookmarks.push({ title, page, sent, snip });
  };
  globalThis.syncAnnotationToCloud = async (ann) => {
    pushedCloudAnnotations.push(ann);
  };
  globalThis.refreshCurrentDocAnnotations = async () => {};
  globalThis.renderPage = () => {};
  globalThis.currentDocName = 'TestBook';
  globalThis.isPlaying = false;
  globalThis.currentPage = 0;
  globalThis.currentSentenceIdx = 0;

  // Local state
  globalThis.getAllBooksFromShelf = async () => [
    { title: 'TestBook', currentPage: 1, currentSentenceIdx: 2, updatedAt: 1000 }
  ];
  globalThis.getBookmarksFromDB = async () => [
    { bookTitle: 'TestBook', page: 1, sentenceIdx: 2, snippet: 'Local bookmark' }
  ];
  globalThis.getAnnotationsFromDB = async () => [
    { bookTitle: 'TestBook', page: 1, sentenceIdx: 2, text: 'Local quote', noteText: 'Local note', color: 'amber' }
  ];

  // Remote Supabase mock
  globalThis.supabaseClient = {
    auth: {
      async getSession() {
        return { data: { session: { user: { id: 'mock-user-123' } } } };
      }
    },
    from(tableName) {
      if (tableName === 'user_books') {
        return {
          select() {
            return {
              eq() {
                // Remote book is newer (timestamp 2000 > 1000) at page 4
                return {
                  data: [
                    { title: 'TestBook', current_page: 4, current_sentence: 10, updated_at: new Date(2000).toISOString() }
                  ]
                };
              }
            };
          },
          async upsert() {}
        };
      }
      if (tableName === 'user_bookmarks') {
        return {
          select() {
            return {
              eq() {
                // Remote has bookmark on page 5
                return {
                  data: [
                    { book_title: 'TestBook', page: 5, sentence_idx: 1, snippet: 'Remote bookmark' }
                  ]
                };
              }
            };
          },
          async upsert() {}
        };
      }
      if (tableName === 'user_annotations') {
        return {
          select() {
            return {
              eq() {
                // Remote has annotation on page 6
                return {
                  data: [
                    { book_title: 'TestBook', page: 6, sentence_idx: 0, text: 'Remote quote', type: 'highlight', color: 'mint', note_text: '' }
                  ]
                };
              }
            };
          },
          async upsert() {}
        };
      }
      return { select: () => ({ eq: () => ({ data: [] }) }), upsert: async () => {} };
    }
  };

  const res = await syncAllWithCloud();
  assert.equal(res.success, true);

  // 1. Remote book was newer -> local progress was updated to page 4
  assert.equal(updatedBookProgressLocally.length, 1);
  assert.equal(updatedBookProgressLocally[0].page, 4);

  // 2. Remote bookmark on page 5 was missing locally -> saved locally
  assert.ok(savedBookmarksLocally.some(b => b.page === 5));
  // Local bookmark on page 1 was pushed to cloud
  assert.ok(pushedCloudBookmarks.some(b => b.page === 1));

  // 3. Remote annotation on page 6 was missing locally -> saved locally
  assert.ok(savedAnnotationsLocally.some(a => a.page === 6));
  // Local annotation on page 1 was pushed to cloud
  assert.ok(pushedCloudAnnotations.some(a => a.page === 1));
});
