import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { newDb, applyMigrations } from './build019.mjs';
import { UIDS, asUser } from './build_master.mjs';

// Миграция 048: разнести «Прежние операции» по профессиям и моделям без потерь.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SQL = readFileSync(`${REPO}/supabase/048_catalog_reorg.sql`, 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond, evidence) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  ПРОВАЛ:', name, evidence !== undefined ? `(${String(evidence).slice(0, 300)})` : '');
  }
}

const LIST = {
  'Швея|Футболка': ['Beyka fitbolka', 'Futbolka beyka bostirb tikish', 'Futbolka old kanal', 'Futbolka beyka zakrepka togri chok'],
  'Швея|Майка': ['Mayka beyka zakrepka + taxlash', 'Mayka elka zakrepka2 +tahlash', 'Mayka beyka kesish', 'Mayka eng ymiz beykada tikish', 'Mayka old omiz beykada tikish + taxlash'],
  'Швея|Короткие трусы (шорты)': ['Poyas shorti', 'Shorti belga rezinka tikish tugmachali', 'Shoti belga rezinka tikish', 'Shorti oeq bostirish reshma', 'Tegmachali shorti old og bostirib tikish togri chok'],
  'Швея|Боксеры': ['Bokser /korotkiy etiketka tikish', 'Bokser poya', 'Bokser/korotkiy trusi lok'],
  'Швея|Трусы с пуговицей': ['Tugmachali trusi Etiketka tilish', 'Tugmachali trusi gulfik tikish togri chok', 'Tugmachali trusi old og tayyolash overlok', 'Tugmachali trusi tag ogini overlokda tikish', 'Tygmachali trusu oyoq rashmada tikish', 'Tugmachali trusi tag ogini ulash lok'],
  'Швея|Общие операции': ['Eng tanaga ulash', 'Bokovoy engi uzun', 'Bokovoy', 'Old omiz kanal', 'Elka kanal +kesib taxlash', 'Elka ochish overlok', 'Eng rashma', 'Etak rashma', 'Etak rashma avtomat', 'Yoqa bostirish', 'Yoqa ulash', 'Yoqachi', 'Rezinka kesib tikish', 'Tygma qagash'],
  'Глажка|Футболка': ['Dazmol Futbolka'],
  'Глажка|Майка': ['Dazmol mayka'],
  'Глажка|Трусы': ['Dazmol trusi'],
  'Глажка|Общие операции': ['dazmol'],
  'Упаковка и чистка|Футболка': ['Chiska futbolka', 'Fytbolka taxlash', 'Futbolka paketga solish + shtrix kod yopishtirish', 'Futbolka 5 talk pachkalash', 'Futbolka ongiga ogirish metodan tozalash'],
  'Упаковка и чистка|Короткие трусы (шорты)': ['Chiska shorti'],
};
const ALL = Object.entries(LIST).flatMap(([k, ops]) => ops.map((o) => [k, o]));

// Строим базу «как на проде до переноса»: старые операции + записи, затем миграции 044–047.
async function build({ extra = false, spacing = false, drop = null } = {}) {
  const db = await newDb();
  await applyMigrations(db, { upTo: '043_piecework_batch_entry.sql' });
  for (const [role, uid] of Object.entries(UIDS)) {
    await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [uid, `${role}@test.test`]);
    await db.query(`insert into profiles (id, email, role) values ($1, $2, $3) on conflict (id) do update set role = excluded.role`, [uid, `${role}@test.test`, role]);
  }
  await asUser(db, 'ceo');
  await db.query('reset role');
  const e1 = (await db.query(`insert into employees (name, shop) values ('Сотр-1', 'factory') returning id`)).rows[0].id;
  const e2 = (await db.query(`insert into employees (name, shop) values ('Сотр-2', 'workshop') returning id`)).rows[0].id;
  let i = 0;
  const ids = {};
  for (const [, op] of ALL) {
    if (op === drop) continue;
    let name = op;
    if (spacing && op === 'Mayka beyka zakrepka + taxlash') name = 'Mayka beyka zakrepka+taxlash';
    if (spacing && op === 'Elka kanal +kesib taxlash') name = 'Elka  kanal +kesib taxlash';
    const rate = op === 'Bokovoy' ? 0 : 50 + (i % 7) * 10; // одна операция со ставкой 0
    const id = (await db.query(`insert into operation_types (name, rate_per_piece) values ($1, $2) returning id`, [name, rate])).rows[0].id;
    ids[op] = id;
    // записи: у каждой операции от 0 до 2
    if (i % 3 !== 0 && rate > 0) await db.query(`insert into work_records (employee_id, operation_type_id, quantity, date) values ($1, $2, $3, current_date - $4::int)`, [i % 2 ? e1 : e2, id, 5 + i, i % 10]);
    if (i % 5 === 0 && rate > 0) await db.query(`insert into work_records (employee_id, operation_type_id, quantity, date) values ($1, $2, 3, current_date)`, [e1, id]);
    i++;
  }
  if (extra) await db.query(`insert into operation_types (name, rate_per_piece) values ('Лишняя операция', 77)`);
  // ставка выросла ПОСЛЕ записей (в записях остаётся прежняя)
  await db.query(`update operation_types set rate_per_piece = rate_per_piece + 5 where rate_per_piece > 0`);
  await applyMigrations(db, { from: '044_piecework_catalog.sql', upTo: '047_staff_bot_reports_settings.sql' });
  return db;
}

const snapshot = async (db) =>
  (await db.query(`
    select co.id, co.name, co.rate_per_piece::numeric as rate,
           (select count(*)::int from work_records wr where wr.catalog_operation_id = co.id) as n,
           (select coalesce(sum(wr.quantity * wr.rate_per_piece), 0) from work_records wr where wr.catalog_operation_id = co.id)::numeric as s
    from catalog_operations co order by co.name`)).rows.map((r) => ({ ...r, rate: Number(r.rate), s: Number(r.s) }));
const totals = async (db) => (await db.query(`select count(*)::int as n, coalesce(sum(quantity * rate_per_piece), 0)::numeric as s from work_records`)).rows[0];
const run = async (db) => {
  const res = await db.exec(SQL);
  return res.at(-1).rows;
};

async function main() {
  // ===================== A. Полный сценарий с «лишней» операцией =====================
  let db = await build({ extra: true, spacing: true });
  const before = await snapshot(db);
  const tBefore = await totals(db);
  const legacyBefore = (await db.query(`select co.id from catalog_operations co join catalog_models m on m.id = co.model_id where m.name = 'Прежние операции'`)).rows.length;
  check('до переноса все 48 операций в «Прежних операциях»', legacyBefore === 48, legacyBefore);
  check('до переноса есть записи', tBefore.n > 10, JSON.stringify(tBefore));

  const out = await run(db);
  const after = await snapshot(db);
  const tAfter = await totals(db);
  const byName = (arr) => Object.fromEntries(arr.map((r) => [r.name, r]));
  const bN = byName(before);
  const aN = byName(after);

  check('число записей и общая сумма не изменились', tAfter.n === tBefore.n && Number(tAfter.s) === Number(tBefore.s), JSON.stringify([tBefore, tAfter]));
  check('все прежние операции на месте с теми же id, названиями и ставками', before.every((b) => after.some((a) => a.id === b.id && a.name === b.name && a.rate === b.rate)));
  check('у каждой прежней операции то же число записей и та же сумма', before.every((b) => { const a = after.find((x) => x.id === b.id); return a.n === b.n && a.s === b.s; }));
  check('новых операций — ровно 2 (копии)', after.length === before.length + 2, [before.length, after.length]);

  const place = (await db.query(`
    select pr.name as prof, m.name as model, co.name as op, co.id
    from catalog_operations co join catalog_models m on m.id = co.model_id join professions pr on pr.id = m.profession_id
    where co.archived_at is null`)).rows;
  let allPlaced = true;
  for (const [key, op] of ALL) {
    const [prof, model] = key.split('|');
    const row = place.find((p) => p.id === bN[op === 'Mayka beyka zakrepka + taxlash' ? 'Mayka beyka zakrepka+taxlash' : op === 'Elka kanal +kesib taxlash' ? 'Elka  kanal +kesib taxlash' : op].id);
    if (!row || row.prof !== prof || row.model !== model) {
      allPlaced = false;
      console.log('   не там:', op, JSON.stringify(row));
    }
  }
  check('все 47 операций из списка лежат в нужных профессиях и моделях', allPlaced);
  check('«Лишняя операция» (вне списка) осталась в «Прежних операциях» и показана как «Не разнесено»', place.find((p) => p.op === 'Лишняя операция').model === 'Прежние операции' && out.some((r) => r['Раздел'] === 'Не разнесено' && r['Операция'] === 'Лишняя операция'));
  check('пока остались неразнесённые, «Прежние операции» и «Без профессии» не скрыты', (await db.query(`select archived_at is null as a from catalog_models where name = 'Прежние операции'`)).rows[0].a === true && (await db.query(`select archived_at is null as a from professions where name = 'Без профессии'`)).rows[0].a === true);

  // копии
  const bokserSrc = ['Bokser /korotkiy etiketka tikish', 'Bokser/korotkiy trusi lok'];
  for (const op of bokserSrc) {
    const copies = place.filter((p) => p.op === op);
    const src = copies.find((p) => p.model === 'Боксеры');
    const cp = copies.find((p) => p.model === 'Короткие трусы (шорты)');
    check(`«${op}»: исходная в «Боксерах» (тот же id), копия — в «Короткие трусы (шорты)»`, src && src.id === bN[op].id && cp && cp.id !== bN[op].id && cp.prof === 'Швея', JSON.stringify(copies));
    const cpRate = Number((await db.query(`select rate_per_piece from catalog_operations where id = $1`, [cp.id])).rows[0].rate_per_piece);
    check(`копия «${op}» — та же ставка (${bN[op].rate}), записей к ней не привязано`, cpRate === bN[op].rate && (await db.query(`select 1 from work_records where catalog_operation_id = $1`, [cp.id])).rows.length === 0);
  }

  // итоговая таблица
  const itog = Object.fromEntries(out.filter((r) => r['Раздел'] === 'Итог').map((r) => [`${r['Профессия']}|${r['Модель']}`, r['Значение']]));
  check('итог: Швея/Футболка 4, Майка 5, Короткие трусы 7 (5 + 2 копии), Боксеры 3, Трусы с пуговицей 6, Общие 14', itog['Швея|Футболка'] === '4 опер.' && itog['Швея|Майка'] === '5 опер.' && itog['Швея|Короткие трусы (шорты)'] === '7 опер.' && itog['Швея|Боксеры'] === '3 опер.' && itog['Швея|Трусы с пуговицей'] === '6 опер.' && itog['Швея|Общие операции'] === '14 опер.', JSON.stringify(itog));
  check('итог: Глажка 1+1+1+1; Упаковка и чистка: Футболка 5, Короткие трусы 1', itog['Глажка|Футболка'] === '1 опер.' && itog['Глажка|Майка'] === '1 опер.' && itog['Глажка|Трусы'] === '1 опер.' && itog['Глажка|Общие операции'] === '1 опер.' && itog['Упаковка и чистка|Футболка'] === '5 опер.' && itog['Упаковка и чистка|Короткие трусы (шорты)'] === '1 опер.');
  const zero = out.filter((r) => r['Раздел'] === 'Ставка 0');
  check('в итоге перечислены операции со ставкой 0 («Bokovoy»)', zero.length === 1 && zero[0]['Операция'] === 'Bokovoy' && zero[0]['Модель'] === 'Общие операции', JSON.stringify(zero));
  const sv = out.filter((r) => r['Раздел'] === 'Сверка');
  check('сверка «до» и «после» записана и совпадает по записям и сумме', sv.length === 2 && sv[0]['Значение'].split('·').slice(1).join() === sv[1]['Значение'].split('·').slice(1).join(), JSON.stringify(sv));

  // записи работников: метка в представлении теперь «Модель · Операция»
  const withRec = before.find((b) => b.name === 'Futbolka old kanal' && b.n > 0) ?? before.find((b) => b.n > 0 && ALL.some(([, o]) => o === 'Futbolka old kanal') && b.name === 'Futbolka old kanal');
  const probe = withRec ?? before.find((b) => b.n > 0 && b.name === 'Mayka beyka kesish');
  const lbl = (await db.query(`select operation_label from work_records_view where catalog_operation_id = $1 limit 1`, [probe.id])).rows[0];
  check('в записях работников метка теперь «Модель · Операция» (запись привязана к той же операции)', lbl && /^(Футболка|Майка) · /.test(lbl.operation_label), JSON.stringify([probe.name, lbl]));
  const rateCheck = (await db.query(`select wr.rate_per_piece::numeric as r, co.rate_per_piece::numeric as c from work_records wr join catalog_operations co on co.id = wr.catalog_operation_id limit 1`)).rows[0];
  check('в записях остались прежние ставки (в каталоге ставка выше на 5 — записи не пересчитаны)', Number(rateCheck.c) - Number(rateCheck.r) === 5, JSON.stringify(rateCheck));

  // повторный запуск
  const out2 = await run(db);
  const after2 = await snapshot(db);
  check('повторный запуск безопасен: ничего не добавилось и не сдвинулось', after2.length === after.length && (await totals(db)).n === tBefore.n && out2.filter((r) => r['Раздел'] === 'Сверка').length === 2);
  check('после повтора копий не стало больше', (await db.query(`select count(*)::int as n from catalog_operations where name in ('Bokser /korotkiy etiketka tikish', 'Bokser/korotkiy trusi lok')`)).rows[0].n === 4);

  // ===================== B. Без «лишних»: legacy скрывается =====================
  db = await build({});
  const outB = await run(db);
  check('без неразнесённых: «Прежние операции» и «Без профессии» скрыты', (await db.query(`select archived_at is not null as a from catalog_models where name = 'Прежние операции'`)).rows[0].a === true && (await db.query(`select archived_at is not null as a from professions where name = 'Без профессии'`)).rows[0].a === true);
  check('«Не разнесено» пусто', !outB.some((r) => r['Раздел'] === 'Не разнесено'));
  check('скрытая «Прежние операции» не видна в обычном каталоге (is null)', (await db.query(`select count(*)::int as n from catalog_models where name = 'Прежние операции' and archived_at is null`)).rows[0].n === 0);

  // ===================== C. Профессии и модели уже есть — используются они =====================
  db = await build({});
  await db.query(`insert into professions (name) values ('швея')`);
  const sewId = (await db.query(`select id from professions where lower(name) = 'швея'`)).rows[0].id;
  await db.query(`insert into catalog_models (profession_id, name) values ($1, 'Футболка')`, [sewId]);
  await run(db);
  check('существующие профессия «швея» и модель «Футболка» использованы, дублей нет', (await db.query(`select count(*)::int as n from professions where lower(name) = 'швея'`)).rows[0].n === 1 && (await db.query(`select count(*)::int as n from catalog_models where profession_id = $1 and name = 'Футболка'`, [sewId])).rows[0].n === 1 && (await db.query(`select count(*)::int as n from catalog_operations o join catalog_models m on m.id = o.model_id where m.profession_id = $1 and m.name = 'Футболка' and o.archived_at is null`, [sewId])).rows[0].n === 4);

  // ===================== D. Ошибки: всё или ничего =====================
  db = await build({ drop: 'Yoqachi' });
  const snapD = await snapshot(db);
  let err = '';
  try {
    await run(db);
  } catch (e) {
    err = String(e.message);
  }
  check('не найдена операция из списка — ошибка с её названием', /Не найдены операции/.test(err) && err.includes('Yoqachi'), err);
  const afterD = await snapshot(db);
  check('при ошибке НИЧЕГО не перенесено (всё или ничего)', (await db.query(`select count(*)::int as n from catalog_operations co join catalog_models m on m.id = co.model_id where m.name = 'Прежние операции'`)).rows[0].n === 46 && afterD.length === snapD.length && (await db.query(`select count(*)::int as n from professions where name in ('Швея', 'Глажка', 'Упаковка и чистка')`)).rows[0].n === 0);

  db = await build({});
  const sew2 = (await db.query(`insert into professions (name) values ('Швея') returning id`)).rows[0].id;
  const m2 = (await db.query(`insert into catalog_models (profession_id, name) values ($1, 'Футболка') returning id`, [sew2])).rows[0].id;
  await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'beyka  fitbolka', 10)`, [m2]);
  err = '';
  try {
    await run(db);
  } catch (e) {
    err = String(e.message);
  }
  check('в целевой модели уже есть такая операция — остановка с понятной ошибкой, без дублей', /уже есть операция/.test(err) && (await db.query(`select count(*)::int as n from catalog_operations co join catalog_models m on m.id = co.model_id where m.name = 'Прежние операции'`)).rows[0].n === 47);

  // ===================== E. Чистая база: ничего не делает =====================
  const clean = await newDb();
  await applyMigrations(clean, { upTo: '047_staff_bot_reports_settings.sql' });
  const outE = await run(clean);
  check('на базе без «Прежних операций» миграция ничего не делает и не падает', Array.isArray(outE) && (await clean.query(`select count(*)::int as n from professions`)).rows[0].n === 0);

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(String(e.message ?? e).slice(0, 800));
  process.exit(1);
});
