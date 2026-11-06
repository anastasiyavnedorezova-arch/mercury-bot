// Paid manual smoke test with the synthetic fixture only; never saves to the database.
// node --env-file=/etc/finnik-stage.env tools/yandex-statement-smoke.mjs /tmp/statement-test.png
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createStatementAI } from '../src/utils/statementAI.js';
import { refineStatementItem } from '../src/utils/categoryHints.js';
import { getStatementPrompt, applyStatementCorrectionsDetailed } from '../src/handlers/fileUpload.js';

try {
  assert.equal(process.env.AI_STATEMENT_PROVIDER, 'yandex', 'Enable Yandex statements first');
  const file = process.argv[2];
  assert.ok(file && /\.(png|pdf)$/i.test(file), 'Pass synthetic PNG or PDF fixture path');
  const ai = createStatementAI();
  const start = Date.now();
  const rows = (await ai.analyze((await fs.readFile(file)).toString('base64'), /\.pdf$/i.test(file) ? 'application/pdf' : 'image/png', getStatementPrompt()))
    .map(refineStatementItem).map((r) => ({ ...r, ownTransfer: r.own_transfer === true }));
  console.log(JSON.stringify({ provider: ai.provider, model: ai.model, milliseconds: Date.now() - start, rows }));
  assert.equal(rows.length, 6, 'All six synthetic operations should be recognized');
  for (const [amount, type, date] of [[1290.5, 'expense', '2026-11-02'], [85000, 'income', '2026-11-02'], [10000, 'income', '2026-11-03'], [2500, 'expense', '2026-11-03'], [8000, 'income', '2026-11-04'], [1999, 'expense', '2026-11-04']]) {
    assert.equal(rows.filter((r) => r.amount === amount && r.type === type && r.transaction_date === date).length, 1);
  }
  assert.equal(rows.find((r) => r.amount === 10000).ownTransfer, true);
  assert.equal(rows.filter((r) => r.ownTransfer).length, 1);
  assert.equal(rows.find((r) => r.amount === 1290.5).category, 'Продукты');
  assert.equal(rows.find((r) => r.amount === 85000).category, 'Зарплата');
  assert.equal(rows.find((r) => r.amount === 2500).category, 'Налоги и штрафы');
  assert.equal(rows.find((r) => r.amount === 1999).category, 'Красота и уход за собой');
  assert.equal(rows.find((r) => r.amount === 8000).category, 'Другие доходы');
  const removed = rows.findIndex((r) => r.amount === 1290.5) + 1;
  const corrected = applyStatementCorrectionsDetailed(rows, { remove: [removed] });
  assert.equal(corrected.updated.filter((r) => !r.ownTransfer).length, 4);
  console.log('PASS: dates, amounts, types, categories, own-transfer exclusion and correction; no records saved');
} catch (err) {
  console.error(`Statement smoke test failed; type=${err.name}; status=${Number(err.status) || 'n/a'}${err.name === 'AssertionError' ? '; ' + err.message : ''}`);
  process.exitCode = 1;
}
