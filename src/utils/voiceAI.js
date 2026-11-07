import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import OpenAI from 'openai';

export const MAX_VOICE_BYTES = 20 * 1024 * 1024;
export const MAX_YANDEX_VOICE_SECONDS = 600;
const STT = 'https://stt.api.cloud.yandex.net/stt/v3';
const OPERATIONS = 'https://operation.api.cloud.yandex.net/operations';

export class VoiceError extends Error {
  constructor(code) { super('Voice recognition failed'); this.name = 'VoiceError'; this.code = code; }
}

export function voiceAIConfig(env = process.env) {
  const provider = (env.AI_VOICE_PROVIDER || 'openai').trim().toLowerCase();
  if (provider === 'openai') return { provider, apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL || 'https://api.openai.com/v1' };
  if (provider !== 'yandex') throw new VoiceError('VOICE_PROVIDER_INVALID');
  const apiKey = (env.YANDEX_SPEECHKIT_API_KEY || env.YANDEX_API_KEY || '').trim();
  const folder = (env.YANDEX_FOLDER_ID || '').trim();
  if (!apiKey || !/^[a-zA-Z0-9_-]+$/.test(folder)) throw new VoiceError('VOICE_YANDEX_CONFIG');
  return { provider, apiKey, folder };
}

// SpeechKit's result stream may include both raw finals and normalized
// refinements. Replace the same indexed phrase instead of recording it twice.
export function parseVoiceRecognition(raw) {
  if (raw.length > 4 * 1024 * 1024) throw new VoiceError('VOICE_RESPONSE_SIZE');
  let events;
  try {
    try { const parsed = JSON.parse(raw); events = Array.isArray(parsed) ? parsed : [parsed]; }
    catch { events = raw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  } catch { throw new VoiceError('VOICE_RESPONSE_INVALID'); }
  const segments = new Map();
  let sequential = 0;
  for (const event of events) {
    const value = event.result || event;
    if (event.error || value.error) throw new VoiceError('VOICE_RECOGNITION_ERROR');
    const refined = value.finalRefinement;
    const final = refined?.normalizedText || value.final;
    if (!final) continue;
    const text = final.alternatives?.[0]?.text;
    if (typeof text !== 'string') throw new VoiceError('VOICE_RESPONSE_INVALID');
    const index = Number(refined?.finalIndex ?? value.audioCursors?.finalIndex ?? sequential++);
    if (!Number.isSafeInteger(index) || index < 0) throw new VoiceError('VOICE_RESPONSE_INVALID');
    const channel = final.channelTag || '0';
    const key = `${channel}:${index}`;
    if (refined || !segments.get(key)?.refined) segments.set(key, { index, text: text.trim(), refined: Boolean(refined) });
  }
  const text = [...segments.values()].sort((a, b) => a.index - b.index).map((s) => s.text).filter(Boolean).join(' ');
  if (text.length > 20000) throw new VoiceError('VOICE_RESPONSE_SIZE');
  return text;
}

export function createVoiceAI(env = process.env, {
  Client = OpenAI, fetchImpl = fetch, sleep = delay, now = Date.now,
  timeoutMs = 120000, cleanupWarning = () => console.warn('[voice] VOICE_REMOTE_CLEANUP_FAILED'),
} = {}) {
  const config = voiceAIConfig(env);
  if (config.provider === 'openai') {
    const client = new Client({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: 60000, maxRetries: 0 });
    return { provider: 'openai', async transcribe(path) {
      const stream = createReadStream(path);
      try {
        const result = await client.audio.transcriptions.create({ file: stream, model: 'whisper-1', language: 'ru' });
        if (typeof result.text !== 'string') throw new VoiceError('VOICE_RESPONSE_INVALID');
        return result.text.trim();
      } finally { stream.destroy(); }
    } };
  }
  const headers = { Authorization: `Api-Key ${config.apiKey}`, 'x-folder-id': config.folder, 'x-data-logging-enabled': 'false' };
  return { provider: 'yandex', async transcribe(path) {
    const info = await fs.stat(path);
    if (!info.size || info.size > MAX_VOICE_BYTES) throw new VoiceError('VOICE_FILE_SIZE');
    const audio = await fs.readFile(path);
    if (audio.subarray(0, 4).toString() !== 'OggS') throw new VoiceError('VOICE_FORMAT');
    const deadline = now() + timeoutMs;
    const request = async (url, options = {}) => {
      const remaining = deadline - now();
      if (remaining <= 0) throw new VoiceError('VOICE_TIMEOUT');
      try {
        const response = await fetchImpl(url, { ...options, headers: { ...headers, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(remaining, 30000))) });
        if (!response.ok) {
          await response.body?.cancel();
          throw new VoiceError(`VOICE_YANDEX_HTTP_${response.status}`);
        }
        return await response.text();
      } catch (err) {
        if (err instanceof VoiceError) throw err;
        throw new VoiceError(err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'VOICE_TIMEOUT' : 'VOICE_NETWORK');
      }
    };
    const json = async (url, options) => {
      try { return JSON.parse(await request(url, options)); }
      catch (err) { if (err instanceof VoiceError) throw err; throw new VoiceError('VOICE_RESPONSE_INVALID'); }
    };
    let operationId;
    try {
      const operation = await json(`${STT}/recognizeFileAsync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        content: audio.toString('base64'),
        recognitionModel: { model: 'general', audioFormat: { containerAudio: { containerAudioType: 'OGG_OPUS' } },
          languageRestriction: { restrictionType: 'WHITELIST', languageCode: ['ru-RU'] },
          textNormalization: { textNormalization: 'TEXT_NORMALIZATION_ENABLED', literatureText: false } },
      }) });
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(operation.id || '')) throw new VoiceError('VOICE_OPERATION_INVALID');
      operationId = operation.id;
      let status = operation;
      for (let poll = 0; !status.done; poll++) {
        if (poll >= 120 || now() >= deadline) throw new VoiceError('VOICE_TIMEOUT');
        await sleep(Math.min(1000, Math.max(0, deadline - now())));
        status = await json(`${OPERATIONS}/${operationId}`);
      }
      if (status.error) throw new VoiceError('VOICE_RECOGNITION_ERROR');
      return parseVoiceRecognition(await request(`${STT}/getRecognition?operationId=${operationId}`));
    } finally {
      if (operationId) {
        try {
          const response = await fetchImpl(`${STT}/deleteRecognition?operationId=${operationId}`, { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
          await response.body?.cancel();
          if (!response.ok) cleanupWarning();
        } catch { cleanupWarning(); }
      }
    }
  } };
}
