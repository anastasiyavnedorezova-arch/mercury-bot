// Сверка названий системных категорий в базе со списком в коде (справочник слов, инструкции для ИИ). Ничего не меняет.
//   node --env-file=/etc/finnik-stage.env tools/check-categories.mjs
//   node --env-file=/etc/finnik-prod.env tools/check-categories.mjs
// «missingInDb» — категория есть в коде, но нет в базе: записи в неё уйдут в «Остальное».
// «notInCode» — категория есть в базе, но ИИ о ней не знает (сообщи, добавим).
import { supabase } from '../src/db.js';
import { compareWithDb } from '../src/utils/categoryHints.js';

const { data, error } = await supabase.from('categories').select('name').is('user_id', null).eq('is_active', true);
if (error) { console.error('Не смог прочитать категории:', error.message); process.exit(1); }
const res = compareWithDb((data ?? []).map((r) => r.name));
console.log(`Системных категорий в базе: ${(data ?? []).length}`);
console.log('missingInDb:', res.missingInDb.length ? res.missingInDb.join(', ') : '— (всё на месте)');
console.log('notInCode:  ', res.notInCode.length ? res.notInCode.join(', ') : '— (всё известно)');
process.exit(res.missingInDb.length ? 2 : 0);
