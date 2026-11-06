import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

class TelegramDownloadError extends Error {
  constructor(code, retryable) {
    super('Telegram media download failed');
    this.name = 'TelegramDownloadError';
    this.code = code;
    this.retryable = retryable;
  }
}

// Do not log URLs: Telegram download URLs contain the bot token.
export async function downloadTelegramMedia(url, destPath, {
  fetchImpl = fetch, pause = delay, timeoutMs = 30_000, maxBytes = 20 * 1024 * 1024,
} = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        throw new TelegramDownloadError(`TELEGRAM_HTTP_${response.status}`, [429, 500, 502, 503, 504].includes(response.status));
      }
      if (!response.body || Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw new TelegramDownloadError('TELEGRAM_FILE_SIZE', false);
      }
      let bytes = 0;
      const limit = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(bytes > maxBytes ? new TelegramDownloadError('TELEGRAM_FILE_SIZE', false) : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(destPath, { flags: 'w', mode: 0o600 }));
      if (bytes === 0) throw new TelegramDownloadError('TELEGRAM_EMPTY_FILE', true);
      return;
    } catch (err) {
      await fs.rm(destPath, { force: true });
      const retryable = err instanceof TelegramDownloadError ? err.retryable : true;
      if (attempt === 0 && retryable) { await pause(500); continue; }
      if (err instanceof TelegramDownloadError) throw err;
      throw new TelegramDownloadError('TELEGRAM_DOWNLOAD_NETWORK', true);
    }
  }
}
