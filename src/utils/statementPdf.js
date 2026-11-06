// Local rendering only: a PDF is never uploaded to a file-storage service.
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFile = promisify(execFileCallback);
export const MAX_STATEMENT_PDF_PAGES = 10;
export const MAX_STATEMENT_BYTES = 20 * 1024 * 1024;

export class StatementInputError extends Error {
  constructor(userMessage) {
    super('Statement input could not be processed');
    this.name = 'StatementInputError';
    this.userMessage = userMessage;
  }
}

export function parsePdfPageCount(info) {
  const count = Number(/^Pages:\s+(\d+)\s*$/m.exec(info)?.[1]);
  if (!Number.isSafeInteger(count) || count < 1) throw new StatementInputError('Не смог прочитать PDF. Попробуй отправить скриншоты страниц 🙏');
  if (count > MAX_STATEMENT_PDF_PAGES) throw new StatementInputError(`В PDF больше ${MAX_STATEMENT_PDF_PAGES} страниц. Раздели его на файлы до ${MAX_STATEMENT_PDF_PAGES} страниц или отправь скриншоты 🙏`);
  return count;
}

export async function statementPdfImages(base64, { run = execFile } = {}) {
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > MAX_STATEMENT_BYTES) throw new StatementInputError('Файл слишком большой. Отправь файл до 20 МБ или скриншоты страниц 🙏');
  if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new StatementInputError('Не смог прочитать PDF. Попробуй отправить скриншоты страниц 🙏');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finnik-statement-'));
  try {
    const input = path.join(dir, 'input.pdf');
    await fs.writeFile(input, buffer, { mode: 0o600 });
    const options = { timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } };
    const info = await run('pdfinfo', [input], options);
    const pages = parsePdfPageCount(info.stdout);
    await run('pdftoppm', ['-f', '1', '-l', String(pages), '-scale-to', '1800', '-png', input, path.join(dir, 'page')], options);
    const files = (await fs.readdir(dir)).filter((name) => /^page-\d+\.png$/.test(name))
      .sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]));
    if (files.length !== pages) throw new Error('Incomplete PDF rendering');
    const images = [];
    let bytes = 0;
    for (const file of files) {
      const image = await fs.readFile(path.join(dir, file));
      bytes += image.length;
      if (bytes > MAX_STATEMENT_BYTES) throw new StatementInputError('Страницы PDF получились слишком большими. Раздели файл на части или отправь скриншоты 🙏');
      images.push({ mimeType: 'image/png', base64: image.toString('base64') });
    }
    return images;
  } catch (err) {
    if (err instanceof StatementInputError) throw err;
    // Poppler stderr can contain document contents: do not propagate it into logs.
    const failure = new Error(err.code === 'ENOENT' ? 'PDF rendering tools are not installed' : 'PDF rendering failed');
    failure.name = 'StatementPdfError';
    throw failure;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
