// Патч 64: подтверждение прав на сайт в Google Search Console (мета-тег на главной).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

test('на главной в <head> один мета-тег google-site-verification с нужным кодом', () => {
  const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  const tags = head.match(/<meta name="google-site-verification"[^>]*>/g) || [];
  assert.equal(tags.length, 1);
  assert.match(tags[0], /content="G0PQT3urdUJzlK4PAkAyp8SIaBRuPiT47XFwt8I6X6g"/);
});
