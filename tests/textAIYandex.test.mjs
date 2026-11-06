import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { textAIConfig, createTextAI, YANDEX_TEXT_BASE_URL } from '../src/utils/textAI.js';

const yandex = {
  AI_TEXT_PROVIDER: 'yandex', YANDEX_API_KEY: 'test-yandex-secret',
  YANDEX_FOLDER_ID: 'test-folder', OPENAI_API_KEY: 'test-openai-secret',
  OPENAI_BASE_URL: 'https://relay.example/openai/v1',
};

test('default keeps OpenAI and the existing relay', () => {
  const c = textAIConfig({ OPENAI_API_KEY: 'test', OPENAI_BASE_URL: 'https://relay.example/openai/v1' });
  assert.equal(c.provider, 'openai');
  assert.equal(c.model, 'gpt-4o-mini');
  assert.equal(c.options.baseURL, 'https://relay.example/openai/v1');
  assert.equal(c.options.apiKey, 'test');
});

test('Yandex does not inherit OpenAI credentials or the relay URL', () => {
  const c = textAIConfig(yandex);
  assert.equal(c.options.baseURL, YANDEX_TEXT_BASE_URL);
  assert.equal(c.options.apiKey, yandex.YANDEX_API_KEY);
  assert.equal(c.options.project, yandex.YANDEX_FOLDER_ID);
  assert.equal(c.options.defaultHeaders['x-data-logging-enabled'], 'false');
  assert.equal(c.options.maxRetries, 0);
  assert.equal(c.model, 'gpt://test-folder/aliceai-llm-flash');
  assert.equal(textAIConfig({ ...yandex, YANDEX_TEXT_MODEL: 'qwen3.6-35b-a3b' }).model, 'gpt://test-folder/qwen3.6-35b-a3b');
});

test('invalid Yandex configuration fails without falling back to OpenAI', () => {
  assert.throws(() => textAIConfig({ ...yandex, YANDEX_API_KEY: '' }), /YANDEX_API_KEY/);
  assert.throws(() => textAIConfig({ ...yandex, YANDEX_FOLDER_ID: '' }), /YANDEX_FOLDER_ID/);
  assert.throws(() => textAIConfig({ ...yandex, YANDEX_TEXT_MODEL: 'gpt://another/model' }), /YANDEX_TEXT_MODEL/);
  assert.throws(() => textAIConfig({ ...yandex, AI_TEXT_PROVIDER: 'typo' }), /AI_TEXT_PROVIDER/);
});

test('real SDK request uses Yandex host, folder, privacy header and selected model', async () => {
  let request;
  class MockTransport extends OpenAI {
    constructor(options) {
      super({ ...options, fetch: async (url, init) => {
        request = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"amount":250}' } }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      } });
    }
  }
  const ai = createTextAI(yandex, MockTransport);
  const r = await ai.complete({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'кофе 250' }], temperature: 0, max_tokens: 100 });
  assert.equal(request.url, `${YANDEX_TEXT_BASE_URL}/chat/completions`);
  assert.equal(request.headers.get('authorization'), 'Bearer test-yandex-secret');
  assert.equal(request.headers.get('openai-project'), 'test-folder');
  assert.equal(request.headers.get('x-data-logging-enabled'), 'false');
  assert.equal(request.body.model, ai.model);
  assert.equal(request.body.temperature, 0);
  assert.equal(request.body.max_tokens, 100);
  assert.equal(JSON.parse(r.choices[0].message.content).amount, 250);
});

test('Yandex network failure does not trigger an OpenAI request or hidden retries', async () => {
  let calls = 0;
  class BrokenTransport extends OpenAI {
    constructor(options) {
      super({ ...options, fetch: async () => { calls++; throw new Error('test network failure'); } });
    }
  }
  const ai = createTextAI(yandex, BrokenTransport);
  await assert.rejects(ai.complete({ messages: [{ role: 'user', content: 'test' }] }));
  assert.equal(calls, 1);
});
