import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVoiceAI, voiceAIConfig, parseVoiceRecognition, MAX_VOICE_BYTES } from '../src/utils/voiceAI.js';
import { transcribeTelegramVoice } from '../src/utils/voiceRecording.js';

const env = { AI_VOICE_PROVIDER: 'yandex', YANDEX_API_KEY: 'SECRET', YANDEX_FOLDER_ID: 'folder' };
const reply = (value, status = 200) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });
const phrase = (index, text) => ({ result: { audioCursors: { finalIndex: String(index) }, final: { alternatives: [{ text }], channelTag: '0' } } });
const normalized = (index, text) => ({ result: { finalRefinement: { finalIndex: String(index), normalizedText: { alternatives: [{ text }], channelTag: '0' } } } });
async function fixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-test-'));
  const file = path.join(dir, 'test.ogg');
  await fs.writeFile(file, Buffer.from('OggS-test-voice'));
  try { await fn(file); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('voice provider defaults to OpenAI; Yandex supports a separate SpeechKit key and validates configuration', () => {
  assert.equal(voiceAIConfig({}).provider, 'openai');
  assert.equal(voiceAIConfig({ ...env, YANDEX_SPEECHKIT_API_KEY: 'SPEECH-SECRET' }).apiKey, 'SPEECH-SECRET');
  assert.throws(() => voiceAIConfig({ AI_VOICE_PROVIDER: 'other' }), { code: 'VOICE_PROVIDER_INVALID' });
  assert.throws(() => voiceAIConfig({ AI_VOICE_PROVIDER: 'yandex' }), { code: 'VOICE_YANDEX_CONFIG' });
});

test('normalized final replaces raw phrase; multiple phrases remain ordered and are not duplicated', () => {
  const raw = [phrase(0, 'кофе триста пятьдесят'), phrase(1, 'такси тысяча двести'), normalized(0, 'Кофе 350.'), normalized(1, 'Такси 1200.')].map(JSON.stringify).join('\n');
  assert.equal(parseVoiceRecognition(raw), 'Кофе 350. Такси 1200.');
  assert.equal(parseVoiceRecognition(JSON.stringify([phrase(10, 'десять'), phrase(2, 'два')])) , 'два десять');
});

test('silence/partials do not become a transaction; malformed or partial JSON is rejected', () => {
  assert.equal(parseVoiceRecognition(JSON.stringify({ result: { partial: { alternatives: [{ text: 'noise' }] } } })), '');
  assert.throws(() => parseVoiceRecognition('{broken'), { code: 'VOICE_RESPONSE_INVALID' });
  assert.throws(() => parseVoiceRecognition(JSON.stringify(phrase(0, 'ok')) + '\n{broken'), { code: 'VOICE_RESPONSE_INVALID' });
});

test('Yandex uploads OGG directly, polls, reads normalized text and deletes results without using OpenAI', async () => fixture(async (file) => {
  const calls = [];
  const responses = [reply({ id: 'operation-1', done: false }), reply({ done: true }), reply([phrase(0, 'кофе'), normalized(0, 'Кофе 350.')].map(JSON.stringify).join('\n')), reply({})];
  const ai = createVoiceAI(env, { Client: class { constructor() { assert.fail('no OpenAI fallback'); } }, sleep: async () => {}, fetchImpl: async (url, options) => { calls.push({ url, options }); return responses.shift(); } });
  assert.equal(await ai.transcribe(file), 'Кофе 350.');
  assert.equal(calls.length, 4);
  assert.match(calls[0].url, /stt\.api\.cloud\.yandex\.net\/stt\/v3\/recognizeFileAsync$/);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.recognitionModel.audioFormat.containerAudio.containerAudioType, 'OGG_OPUS');
  assert.equal(Buffer.from(payload.content, 'base64').toString(), 'OggS-test-voice');
  assert.equal(calls[0].options.headers.Authorization, 'Api-Key SECRET');
  assert.equal(calls[0].options.headers['x-data-logging-enabled'], 'false');
  assert.match(calls[1].url, /operation\.api\.cloud\.yandex\.net/);
  assert.match(calls[3].url, /deleteRecognition\?operationId=operation-1$/);
  assert.equal(calls[3].options.method, 'DELETE');
}));

test('403 is reported safely and never triggers hidden OpenAI fallback', async () => fixture(async (file) => {
  const ai = createVoiceAI(env, { Client: class { constructor() { assert.fail(); } }, fetchImpl: async () => reply({ message: 'SECRET raw response' }, 403) });
  await assert.rejects(ai.transcribe(file), (err) => err.code === 'VOICE_YANDEX_HTTP_403' && !String(err).includes('SECRET'));
}));

test('operation failure deletes remote result and propagates safe error', async () => fixture(async (file) => {
  const calls = [];
  const responses = [reply({ id: 'op', done: true, error: { message: 'SECRET' } }), reply({})];
  const ai = createVoiceAI(env, { fetchImpl: async (url) => { calls.push(url); return responses.shift(); } });
  await assert.rejects(ai.transcribe(file), { code: 'VOICE_RECOGNITION_ERROR' });
  assert.match(calls[1], /deleteRecognition/);
}));

test('polling has a total deadline and still attempts remote cleanup', async () => fixture(async (file) => {
  let clock = 0;
  const calls = [];
  const ai = createVoiceAI(env, { now: () => clock, timeoutMs: 1000, sleep: async () => { clock = 1001; }, fetchImpl: async (url) => { calls.push(url); return reply({ id: 'op', done: false }); } });
  await assert.rejects(ai.transcribe(file), { code: 'VOICE_TIMEOUT' });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /deleteRecognition/);
}));

test('remote cleanup error does not discard successful transcription but raises safe diagnostic', async () => fixture(async (file) => {
  let warned = false;
  const responses = [reply({ id: 'op', done: true }), reply(phrase(0, 'Продукты 1250')), reply({}, 503)];
  const ai = createVoiceAI(env, { fetchImpl: async () => responses.shift(), cleanupWarning: () => { warned = true; } });
  assert.equal(await ai.transcribe(file), 'Продукты 1250');
  assert.equal(warned, true);
}));

test('empty, oversized and non-OGG files are rejected before calling Yandex', async () => fixture(async (file) => {
  const ai = createVoiceAI(env, { fetchImpl: async () => assert.fail('invalid input must not upload') });
  await fs.writeFile(file, 'not an ogg');
  await assert.rejects(ai.transcribe(file), { code: 'VOICE_FORMAT' });
  await fs.writeFile(file, '');
  await assert.rejects(ai.transcribe(file), { code: 'VOICE_FILE_SIZE' });
  await fs.truncate(file, MAX_VOICE_BYTES + 1);
  await assert.rejects(ai.transcribe(file), { code: 'VOICE_FILE_SIZE' });
}));

test('OpenAI remains available with the selected relay and Whisper model', async () => fixture(async (file) => {
  let options, parameters;
  class Client { constructor(opts) { options = opts; this.audio = { transcriptions: { create: async (args) => { parameters = args; return { text: '  кофе 350  ' }; } } }; } }
  const ai = createVoiceAI({ OPENAI_API_KEY: 'OPENAI-KEY', OPENAI_BASE_URL: 'https://relay.example/openai/v1' }, { Client });
  assert.equal(await ai.transcribe(file), 'кофе 350');
  assert.equal(options.baseURL, 'https://relay.example/openai/v1');
  assert.equal(parameters.model, 'whisper-1');
  assert.equal(parameters.file.destroyed, true);
}));

test('Telegram local files are removed on success and provider failure', async () => {
  for (const fail of [false, true]) {
    let file;
    const promise = transcribeTelegramVoice('https://telegram.example/SECRET', {
      transcribe: async (p) => { file = p; assert.equal((await fs.readFile(p)).toString(), 'audio'); if (fail) throw new Error('provider failure'); return 'кофе 350'; },
    }, { download: async (_, p) => fs.writeFile(p, 'audio') });
    if (fail) await assert.rejects(promise); else assert.equal(await promise, 'кофе 350');
    await assert.rejects(fs.stat(path.dirname(file)), { code: 'ENOENT' });
  }
});

test('partial Telegram downloads are cleaned up before surfacing the error', async () => {
  let file;
  await assert.rejects(transcribeTelegramVoice('url', { transcribe: async () => assert.fail() }, { download: async (_, p) => { file = p; await fs.writeFile(p, 'partial'); throw new Error('download failed'); } }));
  await assert.rejects(fs.stat(path.dirname(file)), { code: 'ENOENT' });
});
