// Explicit paid smoke test with synthetic messages; no database connection.
// node --env-file=/etc/finnik-stage.env tools/yandex-text-smoke.mjs
import { createTextAI } from '../src/utils/textAI.js';
import { getSystemPrompt } from '../src/prompts/system_prompt.js';
import { todayStr } from '../src/utils/dateTz.js';

if (process.env.AI_TEXT_PROVIDER !== 'yandex') {
  console.error('Set AI_TEXT_PROVIDER=yandex before running the smoke test.');
  process.exitCode = 1;
} else {
  try {
    const ai = createTextAI();
    console.log(`provider=${ai.provider}; model=${ai.model}; synthetic inputs only`);
    for (const input of ['купила молоко за 125 рублей и хлеб за 60 рублей', 'получила зарплату 85000 рублей']) {
      const start = Date.now();
      const result = await ai.complete({
        messages: [
          { role: 'system', content: getSystemPrompt([]) },
          { role: 'user', content: `Сегодня ${todayStr()}.\nСообщение пользователя: ${input}` },
        ],
        temperature: 0, max_tokens: 1500,
      });
      const raw = result.choices?.[0]?.message?.content?.trim() || '';
      const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      if (!parsed || typeof parsed !== 'object') throw new Error('Expected JSON object or array');
      console.log(JSON.stringify({ input, result: parsed, milliseconds: Date.now() - start, usage: result.usage }));
    }
  } catch (error) {
    // SDK errors may include response details: never print the whole error or headers.
    console.error(`Yandex smoke test failed; status=${Number(error.status) || 'n/a'}; type=${error.name || 'Error'}`);
    process.exitCode = 1;
  }
}
