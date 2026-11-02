// Патч 60: фавикон для Яндекса. Файл /favicon.ico в корне, иконка 120×120 и теги на всех публичных страницах.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const PUBLIC_PAGES = ['index.html', 'legal/offer.html', 'legal/privacy.html', 'legal/consent.html', 'legal/cookies.html'];

test('favicon.ico лежит в корне сайта и это настоящий ICO с размерами 16, 32 и 48', () => {
  const buf = fs.readFileSync(path.join(pub, 'favicon.ico'));
  assert.equal(buf.readUInt16LE(0), 0, 'зарезервированное поле');
  assert.equal(buf.readUInt16LE(2), 1, 'тип 1 = иконка');
  const count = buf.readUInt16LE(4);
  assert.equal(count, 3);
  const sizes = [];
  for (let i = 0; i < count; i++) sizes.push(buf[6 + i * 16] || 256);
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 32, 48]);
});

test('favicon-120.png — настоящий PNG 120×120', () => {
  const buf = fs.readFileSync(path.join(pub, 'images/favicon-120.png'));
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(buf.readUInt32BE(16), 120);
  assert.equal(buf.readUInt32BE(20), 120);
});

test('на главной и юридических страницах есть все теги иконок, адреса от корня, файлы существуют', () => {
  for (const page of PUBLIC_PAGES) {
    const html = fs.readFileSync(path.join(pub, page), 'utf8');
    const hrefs = [...html.matchAll(/<link rel="icon"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    for (const need of ['/favicon.ico', '/images/favicon-finnik.svg', '/images/favicon-48.png', '/images/favicon-120.png']) {
      assert.ok(hrefs.includes(need), `${page}: нет иконки ${need}`);
    }
    for (const h of hrefs) {
      assert.ok(h.startsWith('/'), `${page}: адрес иконки должен начинаться с «/»: ${h}`);
      assert.ok(fs.existsSync(path.join(pub, h)), `${page}: файл ${h} не найден`);
    }
    assert.match(html, /<link rel="icon" href="\/favicon\.ico" sizes="48x48">/, `${page}: тег для favicon.ico`);
  }
});

test('сервер отдаёт /favicon.ico как картинку с кодом 200', async () => {
  const app = express();
  app.use(express.static(pub));
  const srv = http.createServer(app).listen(0);
  const port = srv.address().port;
  try {
    const r = await new Promise((resolve, reject) => {
      http.get({ port, path: '/favicon.ico' }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], len: Buffer.concat(c).length })); }).on('error', reject);
    });
    assert.equal(r.status, 200);
    assert.match(r.type, /image\/(x-icon|vnd\.microsoft\.icon)/);
    assert.ok(r.len > 500);
  } finally { srv.close(); }
});
