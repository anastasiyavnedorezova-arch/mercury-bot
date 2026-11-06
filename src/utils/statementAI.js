import OpenAI from 'openai';
import { textAIConfig } from './textAI.js';
import { MAX_STATEMENT_BYTES, StatementInputError, statementPdfImages } from './statementPdf.js';

export function statementAIConfig(env = process.env) {
  const provider = (env.AI_STATEMENT_PROVIDER || 'openai').trim().toLowerCase();
  if (!['openai', 'yandex'].includes(provider)) throw new Error('AI_STATEMENT_PROVIDER must be openai or yandex');
  const config = textAIConfig({
    ...env,
    AI_TEXT_PROVIDER: provider,
    YANDEX_TEXT_MODEL: env.YANDEX_STATEMENT_MODEL || 'qwen3.6-35b-a3b',
  });
  if (provider === 'openai') return { ...config, model: 'gpt-4o' };
  return { ...config, options: { ...config.options, timeout: 90_000 } };
}

export function parseStatementResult(response) {
  const choice = response.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('Statement response was truncated');
  const raw = choice?.message?.content;
  if (typeof raw !== 'string') throw new Error('Statement response is missing');
  const result = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!Array.isArray(result)) throw new Error('Statement response must be an array');
  for (const tx of result) {
    if (!tx || !['income', 'expense'].includes(tx.type) || typeof tx.amount !== 'number'
      || !Number.isFinite(tx.amount) || tx.amount <= 0 || typeof tx.category !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(tx.transaction_date)
      || !Number.isFinite(Date.parse(tx.transaction_date))
      || new Date(tx.transaction_date).toISOString().slice(0, 10) !== tx.transaction_date
      || (tx.own_transfer !== undefined && typeof tx.own_transfer !== 'boolean')) {
      throw new Error('Statement contains an invalid transaction');
    }
  }
  return result;
}

export function createStatementAI(env = process.env, Client = OpenAI, renderPdf = statementPdfImages) {
  const config = statementAIConfig(env);
  const client = new Client(config.options);
  return {
    provider: config.provider,
    model: config.model,
    async analyze(base64, mimeType, prompt) {
      if (Buffer.byteLength(base64, 'base64') > MAX_STATEMENT_BYTES) {
        throw new StatementInputError('Файл слишком большой. Отправь файл до 20 МБ или скриншоты страниц 🙏');
      }
      let images;
      if (mimeType === 'application/pdf' && config.provider === 'yandex') {
        images = await renderPdf(base64);
      } else {
        if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(mimeType)) {
          throw new StatementInputError('Отправь выписку в PDF, JPG, PNG или WebP 🙏');
        }
        images = [{ base64, mimeType }];
      }
      if (!images.length) throw new Error('Statement has no pages');
      const response = await client.chat.completions.create({
        model: config.model,
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          ...images.map((image) => ({ type: 'image_url', image_url: {
            url: `data:${image.mimeType};base64,${image.base64}`,
            ...(config.provider === 'openai' ? { detail: 'high' } : {}),
          } })),
        ] }],
        max_tokens: config.provider === 'yandex' ? 8000 : 4000,
        temperature: 0,
      });
      return parseStatementResult(response);
    },
  };
}
