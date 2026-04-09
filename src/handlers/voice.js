import fs from 'fs';
import path from 'path';
import https from 'https';
import OpenAI from 'openai';
import { handleMessage } from './message.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

export async function handleVoiceMessage(bot, msg) {
  const chatId = msg.chat.id;

  try {
    await bot.sendChatAction(chatId, 'typing');

    const fileId = msg.voice.file_id;
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const tmpPath = path.join('/tmp', `voice_${Date.now()}.ogg`);
    await downloadFile(fileUrl, tmpPath);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'ru',
    });

    fs.unlink(tmpPath, () => {});

    const text = transcription.text.trim();

    if (!text) {
      await bot.sendMessage(chatId,
        'Не смог распознать голосовое. Попробуй ещё раз или напиши текстом 🤔');
      return;
    }

    await bot.sendMessage(chatId, `🎤 Распознал: "${text}"`);

    await handleMessage(bot, { ...msg, text });

  } catch (err) {
    console.error('[voice] Error:', err.message);
    await bot.sendMessage(chatId,
      'Не смог обработать голосовое. Попробуй написать текстом 🤔');
  }
}
