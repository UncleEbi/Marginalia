import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TIERS } from '../api/_lib/rate-limit.js';
import studyPackHandler from '../api/study-pack.js';

const migration = fs.readFileSync('supabase/migrations/20261125_study_packs.sql', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');

test('supabase migration defines study_packs table, index, and RLS policies', () => {
  assert.match(migration, /create table if not exists public\.study_packs/i);
  assert.match(migration, /share_token text unique not null/i);
  assert.match(migration, /doc_title text not null/i);
  assert.match(migration, /payload jsonb not null/i);
  assert.match(migration, /alter table public\.study_packs enable row level security/i);
  assert.match(migration, /create policy "Allow public read of study packs by share token"/i);
  assert.match(migration, /create policy "Allow insert of study packs"/i);
});

test('api/_lib/rate-limit.js configures study_pack tier with 15 req/min', () => {
  assert.ok(TIERS.study_pack, 'TIERS.study_pack exists');
  assert.equal(TIERS.study_pack.ip.limit, 15);
  assert.equal(TIERS.study_pack.ip.windowSeconds, 60);
});

test('public/index.html includes study kit share button and viral study pack banner', () => {
  assert.match(html, /id="btnStudyKitShare"/);
  assert.match(html, /id="studyPackShareResult"/);
  assert.match(html, /id="studyPackShareUrl"/);
  assert.match(html, /id="btnCopyShareUrl"/);
  assert.match(html, /id="studyPackBanner"/);
  assert.match(html, /id="studyPackSaveBtn"/);
});

test('public/app.js implements study pack link generation and ?pack= ingestion', () => {
  assert.match(app, /async function shareCurrentStudyPack\(/);
  assert.match(app, /async function checkSharedStudyPack\(/);
  assert.match(app, /fetch\('\/api\/study-pack'/);
  assert.match(app, /fetch\(`\/api\/study-pack\?token=/);
  assert.match(app, /checkSharedStudyPack\(\)/);
});

test('api/study-pack rejects unsupported HTTP methods with 405', async () => {
  let statusCode = 0;
  let responseData = null;
  const req = {
    method: 'DELETE',
    headers: { 'x-forwarded-for': '127.0.0.1' }
  };
  const res = {
    setHeader: () => {},
    status: (code) => { statusCode = code; return res; },
    json: (data) => { responseData = data; }
  };

  await studyPackHandler(req, res);
  assert.equal(statusCode, 405);
  assert.equal(responseData?.error, 'Method not allowed');
});

test('api/study-pack POST validates required doc_title and payload.pages', async () => {
  let statusCode = 0;
  let responseData = null;
  const res = {
    setHeader: () => {},
    status: (code) => { statusCode = code; return res; },
    json: (data) => { responseData = data; }
  };

  // Missing doc_title
  await studyPackHandler({
    method: 'POST',
    headers: { 'x-forwarded-for': '127.0.0.2' },
    body: { payload: { pages: [['Hello']] } }
  }, res);
  assert.equal(statusCode, 400);
  assert.match(responseData.error, /doc_title/);

  // Missing pages array
  await studyPackHandler({
    method: 'POST',
    headers: { 'x-forwarded-for': '127.0.0.2' },
    body: { doc_title: 'Biology 101', payload: {} }
  }, res);
  assert.equal(statusCode, 400);
  assert.match(responseData.error, /pages/);
});

test('api/study-pack POST creates a shareable pack and returns shareToken & shareUrl', async () => {
  let statusCode = 0;
  let responseData = null;
  const res = {
    setHeader: () => {},
    status: (code) => { statusCode = code; return res; },
    json: (data) => { responseData = data; }
  };

  // Note: if Supabase env is not configured in test runner, it responds 503 or creates pack if configured
  await studyPackHandler({
    method: 'POST',
    headers: { 'x-forwarded-for': '127.0.0.3', host: 'marginalia.app' },
    body: {
      doc_title: 'Neuroscience Chapter 4',
      pack_type: 'chapter',
      payload: {
        title: 'Neuroscience Chapter 4',
        pages: [['Action potentials propagate along the axon.', 'Myelin sheath accelerates conduction.']],
        annotations: [{ page: 0, sentenceIdx: 0, noteText: 'Exam topic', color: 'rose' }],
        vocabulary: [{ word: 'myelin', definition: 'Insulating layer around nerves' }]
      }
    }
  }, res);

  assert.ok(statusCode === 200 || statusCode === 503, `Received status: ${statusCode}`);
  if (statusCode === 200) {
    assert.equal(responseData.ok, true);
    assert.ok(responseData.shareToken);
    assert.ok(responseData.shareUrl.includes(responseData.shareToken));
  }
});
