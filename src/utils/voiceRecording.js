import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { downloadTelegramMedia } from './telegramDownload.js';
import { MAX_VOICE_BYTES } from './voiceAI.js';

export async function transcribeTelegramVoice(url, voiceAI, { download = downloadTelegramMedia } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finnik-voice-'));
  try {
    const file = path.join(directory, 'voice.ogg');
    await download(url, file, { maxBytes: MAX_VOICE_BYTES });
    return await voiceAI.transcribe(file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
