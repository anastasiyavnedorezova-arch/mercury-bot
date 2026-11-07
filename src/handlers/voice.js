import { handleMessage } from './message.js';
import { supabase } from '../db.js';
import { reserveAi, denyAi } from '../utils/aiLimit.js';
import { replyIfQuota } from '../utils/openaiErrors.js';
import { telegramFileUrl } from '../utils/endpoints.js';
import { createVoiceAI, MAX_VOICE_BYTES, MAX_YANDEX_VOICE_SECONDS } from '../utils/voiceAI.js';
import { transcribeTelegramVoice } from '../utils/voiceRecording.js';

export async function handleVoiceMessage(bot, msg) {
  const chatId = msg.chat.id;
  let provider;

  try {
    const voiceAI = createVoiceAI();
    provider = voiceAI.provider;
    if (msg.voice.file_size > MAX_VOICE_BYTES) {
      await bot.sendMessage(chatId, 'Голосовое слишком большое. Отправь запись до 20 МБ или напиши текстом 🙏');
      return;
    }
    if (provider === 'yandex' && msg.voice.duration > MAX_YANDEX_VOICE_SECONDS) {
      await bot.sendMessage(chatId, 'Голосовое длиннее 10 минут. Раздели его на несколько сообщений или напиши текстом 🙏');
      return;
    }
    const gate = await reserveAi(supabase, msg.from.id, 'voice');
    if (!gate.ok) { await denyAi(bot, chatId, gate); return; }

    await bot.sendChatAction(chatId, 'typing');

    const fileId = msg.voice.file_id;
    const file = await bot.getFile(fileId);
    const fileUrl = telegramFileUrl(file.file_path);

    const text = await transcribeTelegramVoice(fileUrl, voiceAI);

    if (!text) {
      await bot.sendMessage(chatId,
        'Не смог распознать голосовое. Попробуй ещё раз или напиши текстом 🤔');
      return;
    }

    await bot.sendMessage(chatId, `🎤 Распознал: "${text}"`);

    await handleMessage(bot, { ...msg, text, fromVoice: true });

  } catch (err) {
    console.error('[voice] Error:', { provider, code: /^[A-Z0-9_]+$/.test(err?.code || '') ? err.code : 'VOICE_ERROR', status: typeof err?.status === 'number' ? err.status : undefined });
    if (provider === 'openai' && await replyIfQuota(err, bot, chatId)) return;
    await bot.sendMessage(chatId,
      'Не смог обработать голосовое. Попробуй написать текстом 🤔');
  }
}
