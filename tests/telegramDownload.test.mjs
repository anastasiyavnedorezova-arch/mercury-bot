import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadTelegramMedia } from '../src/utils/telegramDownload.js';

async function fixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finnik-download-test-'));
  try { await fn(path.join(dir, 'photo.jpg')); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
const url = 'https://relay.example/file/botSECRET/photo.jpg';

test('download retries one transient network failure and saves the complete file', () => fixture(async (dest) => {
  let attempts = 0; let pauses = 0;
  await downloadTelegramMedia(url, dest, { pause: async () => pauses++, fetchImpl: async (received, options) => {
    assert.equal(received, url); assert.ok(options.signal); assert.equal(options.redirect, 'error');
    if (++attempts === 1) throw new Error('TLS failure with SECRET');
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } });
  } });
  assert.equal(attempts, 2); assert.equal(pauses, 1);
  assert.deepEqual([...await fs.readFile(dest)], [1, 2, 3]);
}));

test('404 body is not saved or sent to the image model', () => fixture(async (dest) => {
  let calls = 0;
  await assert.rejects(downloadTelegramMedia(url, dest, { fetchImpl: async () => { calls++; return new Response('error', { status: 404 }); } }),
    (e) => e.code === 'TELEGRAM_HTTP_404' && !e.message.includes('SECRET'));
  assert.equal(calls, 1); await assert.rejects(fs.access(dest));
}));

test('stream failure removes the partial file before retry', () => fixture(async (dest) => {
  let calls = 0;
  await downloadTelegramMedia(url, dest, { pause: async () => { await assert.rejects(fs.access(dest)); }, fetchImpl: async () => {
    if (++calls === 1) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([9])); controller.error(new Error('broken')); } }));
    return new Response(new Uint8Array([1, 2]));
  } });
  assert.equal(calls, 2); assert.deepEqual([...await fs.readFile(dest)], [1, 2]);
}));

test('oversized stream is rejected and partial files are removed', () => fixture(async (dest) => {
  await assert.rejects(downloadTelegramMedia(url, dest, { maxBytes: 2, fetchImpl: async () => new Response(new Uint8Array([1, 2, 3])) }),
    (e) => e.code === 'TELEGRAM_FILE_SIZE');
  await assert.rejects(fs.access(dest));
}));

test('network retry is bounded and errors never expose the token or URL', () => fixture(async (dest) => {
  let calls = 0;
  await assert.rejects(downloadTelegramMedia(url, dest, { pause: async () => {}, fetchImpl: async () => { calls++; throw new Error(url); } }),
    (e) => e.code === 'TELEGRAM_DOWNLOAD_NETWORK' && !String(e).includes('SECRET') && !String(e).includes('relay.example'));
  assert.equal(calls, 2); await assert.rejects(fs.access(dest));
}));
