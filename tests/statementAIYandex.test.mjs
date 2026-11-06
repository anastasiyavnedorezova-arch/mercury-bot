import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import { createStatementAI, statementAIConfig, parseStatementResult } from '../src/utils/statementAI.js';
import { statementPdfImages, parsePdfPageCount, StatementInputError } from '../src/utils/statementPdf.js';

const env = { AI_STATEMENT_PROVIDER: 'yandex', YANDEX_API_KEY: 'test-key', YANDEX_FOLDER_ID: 'test-folder',
  AI_TEXT_PROVIDER: 'openai', OPENAI_API_KEY: 'other-key', OPENAI_BASE_URL: 'https://relay.example/openai/v1' };
const tx = (extra = {}) => ({ amount: 1290.5, type: 'expense', transaction_date: '2026-11-02', category: 'Продукты', own_transfer: false, ...extra });
const result = (data, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content: JSON.stringify(data) } }] });
function transport(handler) {
  return class extends OpenAI {
    constructor(options) {
      super({ ...options, fetch: async (url, init) => {
        const data = await handler(String(url), new Headers(init.headers), JSON.parse(init.body));
        return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
      } });
    }
  };
}

test('statement provider is independent of text provider and defaults to GPT-4o', () => {
  assert.equal(statementAIConfig({ AI_TEXT_PROVIDER: 'yandex', OPENAI_API_KEY: 'test' }).model, 'gpt-4o');
  assert.equal(statementAIConfig(env).model, 'gpt://test-folder/qwen3.6-35b-a3b');
  assert.equal(statementAIConfig({ ...env, YANDEX_TEXT_MODEL: 'aliceai-llm-flash' }).model, 'gpt://test-folder/qwen3.6-35b-a3b');
  assert.throws(() => statementAIConfig({ ...env, AI_STATEMENT_PROVIDER: 'typo' }), /AI_STATEMENT_PROVIDER/);
});

test('image request goes directly to Yandex with no logging and returns transfer markers', async () => {
  const ai = createStatementAI(env, transport((url, headers, body) => {
    assert.equal(url, 'https://ai.api.cloud.yandex.net/v1/chat/completions');
    assert.equal(headers.get('authorization'), 'Bearer test-key');
    assert.equal(headers.get('x-data-logging-enabled'), 'false');
    assert.equal(headers.get('openai-project'), 'test-folder');
    assert.equal(body.model, 'gpt://test-folder/qwen3.6-35b-a3b');
    assert.equal(body.reasoning_effort, 'none');
    assert.deepEqual(body.messages[0].content, [
      { type: 'text', text: 'parse statement' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,cG5n' } },
    ]);
    return result([tx(), tx({ type: 'income', amount: 10000, own_transfer: true })]);
  }));
  const rows = await ai.analyze('cG5n', 'image/png', 'parse statement');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].own_transfer, true);
});

test('PDF pages are sent together, in order; raw PDF does not reach Yandex', async () => {
  const ai = createStatementAI(env, transport((url, headers, body) => {
    const images = body.messages[0].content.slice(1);
    assert.deepEqual(images.map((x) => x.image_url.url), ['data:image/png;base64,cDE=', 'data:image/png;base64,cDI=']);
    return result([tx()]);
  }), async (data) => {
    assert.equal(data, 'JVBERi0x');
    return [{ mimeType: 'image/png', base64: 'cDE=' }, { mimeType: 'image/png', base64: 'cDI=' }];
  });
  await ai.analyze('JVBERi0x', 'application/pdf', 'test');
});

test('malformed, non-array, truncated or invalid responses are rejected before saving', () => {
  assert.deepEqual(parseStatementResult(result([])), []);
  assert.throws(() => parseStatementResult(result({ transactions: [tx()] })), /array/);
  assert.throws(() => parseStatementResult(result([tx()], 'length')), /truncated/);
  assert.throws(() => parseStatementResult(result([tx()], 'length')), (e) => e.code === 'STATEMENT_TRUNCATED');
  for (const bad of [{ amount: -1 }, { amount: '100' }, { type: 'goal' }, { transaction_date: '2026-02-30' }, { own_transfer: 'true' }]) {
    assert.throws(() => parseStatementResult(result([tx(bad)])), /invalid transaction/);
  }
});

test('PDF page count: reject empty/unknown/too many pages instead of dropping pages', () => {
  assert.equal(parsePdfPageCount('Title: test\nPages: 2\n'), 2);
  for (const info of ['Pages: 0', 'Pages: 11', 'Pages: unknown']) {
    assert.throws(() => parsePdfPageCount(info), StatementInputError);
  }
});

test('PDF rendering keeps page order and deletes temporary documents', async () => {
  let directory;
  const run = async (command, args, options) => {
    assert.equal(options.env.LC_ALL, 'C');
    if (command === 'pdfinfo') {
      directory = path.dirname(args[0]);
      assert.match((await fs.readFile(args[0])).toString(), /^%PDF-/);
      return { stdout: 'Pages: 2\n' };
    }
    assert.equal(command, 'pdftoppm');
    assert.ok(args.includes('1800'));
    await fs.writeFile(path.join(directory, 'page-2.png'), 'two');
    await fs.writeFile(path.join(directory, 'page-1.png'), 'one');
    return { stdout: '' };
  };
  const images = await statementPdfImages(Buffer.from('%PDF-test').toString('base64'), { run });
  assert.deepEqual(images.map((x) => Buffer.from(x.base64, 'base64').toString()), ['one', 'two']);
  await assert.rejects(fs.access(directory));
});

test('PDF errors also delete temporary files and do not expose document stderr', async () => {
  let directory;
  await assert.rejects(statementPdfImages(Buffer.from('%PDF-test').toString('base64'), { run: async (command, args) => {
    directory = path.dirname(args[0]);
    throw new Error('private document text');
  } }), (error) => error.message === 'PDF rendering failed');
  await assert.rejects(fs.access(directory));
  await assert.rejects(statementPdfImages(Buffer.from('<html>not a PDF').toString('base64')), StatementInputError);
});

test('Yandex failure is not retried via OpenAI', async () => {
  let calls = 0;
  class Broken extends OpenAI {
    constructor(options) { super({ ...options, fetch: async () => { calls++; throw new Error('network'); } }); }
  }
  await assert.rejects(createStatementAI(env, Broken).analyze('cG5n', 'image/png', 'test'));
  assert.equal(calls, 1);
});
