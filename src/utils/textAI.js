// Text-only provider selection. Voice and statement images keep their own clients.
import OpenAI from 'openai';

export const YANDEX_TEXT_BASE_URL = 'https://ai.api.cloud.yandex.net/v1';

export function textAIConfig(env = process.env) {
  const provider = (env.AI_TEXT_PROVIDER || 'openai').trim().toLowerCase();
  if (provider === 'openai') {
    return {
      provider,
      model: 'gpt-4o-mini',
      options: { apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL || 'https://api.openai.com/v1' },
    };
  }
  if (provider !== 'yandex') throw new Error('AI_TEXT_PROVIDER must be openai or yandex');
  const apiKey = (env.YANDEX_API_KEY || '').trim();
  const folder = (env.YANDEX_FOLDER_ID || '').trim();
  if (!apiKey) throw new Error('YANDEX_API_KEY is required for Yandex text AI');
  if (!/^[a-zA-Z0-9_-]+$/.test(folder)) throw new Error('YANDEX_FOLDER_ID is required and must be a folder identifier');
  const modelName = (env.YANDEX_TEXT_MODEL || 'aliceai-llm-flash').trim();
  if (!/^[a-zA-Z0-9_.-]+$/.test(modelName)) throw new Error('YANDEX_TEXT_MODEL must be a model name, not a URI');
  return {
    provider,
    model: `gpt://${folder}/${modelName}`,
    options: {
      apiKey,
      baseURL: YANDEX_TEXT_BASE_URL,
      project: folder,
      timeout: 30_000,
      maxRetries: 0,
      defaultHeaders: { 'x-data-logging-enabled': 'false' },
    },
  };
}

export function createTextAI(env = process.env, Client = OpenAI) {
  const config = textAIConfig(env);
  const client = new Client(config.options);
  return {
    provider: config.provider,
    model: config.model,
    complete: (params) => client.chat.completions.create({ ...params, model: config.model }),
  };
}
