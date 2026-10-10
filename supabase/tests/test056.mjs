import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { newDb, applyMigrations } from './build019.mjs';
import { UIDS, asUser } from './build_master.mjs';

// Миграция 052: замена каталога списком мастера (6 изделий, 96 операций), перенос ставок
// по утверждённой таблице, архив старого, записи и суммы — без изменений.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SQL = readFileSync(`${REPO}/supabase/052_catalog_master_list.sql`, 'utf8');
const LIST_SQL = readFileSync(`${REPO}/supabase/maintenance/052_new_catalog_list.sql`, 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond, evidence) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  ПРОВАЛ:', name, evidence !== undefined ? `(${String(evidence).slice(0, 400)})` : '');
  }
}

// План из самой миграции: (№ изделия, изделие, №, операция, старая профессия, старое изделие, старая операция)
const PLAN = [...SQL.matchAll(/^\s+\((\d+), '([^']+)', (\d+), '([^']+)', (null|'[^']*'), (null|'[^']*'), (null|'[^']*')\)/gm)].map((m) => ({
  mo: Number(m[1]), model: m[2], oo: Number(m[3]), op: m[4],
  oldProf: m[5] === 'null' ? null : m[5].slice(1, -1), oldModel: m[6] === 'null' ? null : m[6].slice(1, -1), oldOp: m[7] === 'null' ? null : m[7].slice(1, -1).replace(/''/g, "'"),
}));

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

// Ставки старых операций в тестовой базе: проверенные владельцем — как в таблице (150 / 250 / 0),
// остальные — разные, чтобы перенос было видно.
const FIXED = {
  'Futbolka old kanal': 150, 'Old omiz kanal': 150,
  'Tugmachali trusi gulfik tikish togri chok': 250, 'Tegmachali shorti old og bostirib tikish togri chok': 250,
  'Bokovoy': 0, 'Tugmachali trusi tag ogini ulash lok': 0, 'Mayka eng ymiz beykada tikish': 0, 'Mayka old omiz beykada tikish + taxlash': 0, 'dazmol': 0,
};
const ALL = Object.entries(LIST).flatMap(([k, ops]) => ops.map((o) => [k, o]));
const rateOf = (op, i) => (op in FIXED ? FIXED[op] : 100 + i * 7);

async function build({ tweak } = {}) {
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
  for (const [, op] of ALL) {
    const rate = rateOf(op, i);
    const id = (await db.query(`insert into operation_types (name, rate_per_piece) values ($1, $2) returning id`, [op, rate])).rows[0].id;
    if (rate > 0 && i % 2 === 0) await db.query(`insert into work_records (employee_id, operation_type_id, quantity, date) values ($1, $2, $3, current_date - $4::int)`, [i % 4 ? e1 : e2, id, 3 + i, i % 9]);
    i++;
  }
  await applyMigrations(db, { from: '044_piecework_catalog.sql', upTo: '051_bot_shop_switch.sql' });
  if (tweak) await tweak(db);
  return { db, e1, e2 };
}
const totals = async (db) => (await db.query(`select count(*)::int as n, coalesce(sum(quantity * rate_per_piece), 0)::numeric as s from work_records`)).rows[0];
const oldOps = async (db) => (await db.query(`select co.id, co.name, co.rate_per_piece::numeric as rate, co.model_id, (select count(*)::int from work_records wr where wr.catalog_operation_id = co.id) as n from catalog_operations co order by co.id`)).rows;
const run = async (db) => (await db.exec(SQL)).at(-1).rows;

async function main() {
  check('план в миграции: 6 изделий, 96 операций, 48 со ставкой из старых', PLAN.length === 96 && new Set(PLAN.map((p) => p.model)).size === 6 && PLAN.filter((p) => p.oldOp).length === 48, PLAN.length);
  check('B07 (Old omiz kanal → Футболка олд умиз канал) не используется, взят B06', PLAN.find((p) => p.op === 'Футболка олд умиз канал').oldOp === 'Futbolka old kanal');
  check('B17 и B18 — обе от «gulfik tikish togri chok»', PLAN.filter((p) => p.oldOp === 'Tugmachali trusi gulfik tikish togri chok').map((p) => p.op).sort().join() === ['Тугмачали труси гулфик бостириш тогри чок', 'Тугмачали труси гулфик таерлаш тугри чок'].sort().join());
  check('названия без двойных пробелов и пробелов по краям', PLAN.every((p) => p.op === p.op.trim().replace(/\s+/g, ' ')));

  // ===================== A. Основной сценарий =====================
  const { db } = await build();
  const tBefore = await totals(db);
  const before = await oldOps(db);
  const rateByOld = Object.fromEntries((await db.query(`select o.name, o.rate_per_piece::numeric as r from catalog_operations o where o.archived_at is null`)).rows.map((r) => [r.name, Number(r.r)]));
  check('до: 49 старых операций (47 + 2 копии), есть записи', before.length === 49 && tBefore.n > 5, before.length);

  const out = await run(db);
  const tAfter = await totals(db);
  check('число записей и общая сумма не изменились', tAfter.n === tBefore.n && Number(tAfter.s) === Number(tBefore.s), JSON.stringify([tBefore, tAfter]));
  const afterOld = (await db.query(`select id, name, rate_per_piece::numeric as rate, archived_at is not null as arch, (select count(*)::int from work_records wr where wr.catalog_operation_id = co.id) as n from catalog_operations co where id = any($1)`, [before.map((b) => b.id)])).rows;
  check('все 49 старых операций — в архиве, названия, ставки и записи прежние', afterOld.length === 49 && afterOld.every((a) => { const b = before.find((x) => x.id === a.id); return a.arch && a.name === b.name && Number(a.rate) === Number(b.rate) && a.n === b.n; }));
  check('старые модели и профессии — в архиве; активна одна профессия «Общая»', (await db.query(`select count(*)::int as n from catalog_models where archived_at is null and name in ('Футболка','Майка','Боксеры','Трусы','Общие операции','Короткие трусы (шорты)','Трусы с пуговицей') and profession_id <> (select id from professions where name = 'Общая')`)).rows[0].n === 0 && (await db.query(`select string_agg(name, ',') as s from professions where archived_at is null`)).rows[0].s === 'Общая');

  const list = (await db.exec(LIST_SQL)).at(-1).rows;
  check('новый каталог: 96 операций', list.length === 96, list.length);
  check('изделия по порядку мастера: Футболка, Тугмачали труси, Короткий труси, Боксер, Майка, Без рукава', [...new Set(list.map((r) => r['Изделие']))].join('|') === 'Футболка|Тугмачали труси|Короткий труси|Боксер|Майка|Без рукава');
  check('операции и их порядок — ровно как в списке мастера', list.every((r, i) => r['Операция'] === PLAN[i].op && r['№'] === PLAN[i].oo && r['Изделие'] === PLAN[i].model), JSON.stringify(list.slice(0, 3)));
  const counts = Object.fromEntries([...new Set(list.map((r) => r['Изделие']))].map((m) => [m, list.filter((r) => r['Изделие'] === m).length]));
  check('по изделиям: 28 / 15 / 11 / 10 / 12 / 20', JSON.stringify(Object.values(counts)) === '[28,15,11,10,12,20]', JSON.stringify(counts));

  let rateOk = true;
  for (const [i, p] of PLAN.entries()) {
    const expected = p.oldOp ? rateByOld[p.oldOp] : 0;
    if (Number(list[i]['Ставка, сум']) !== expected) {
      rateOk = false;
      console.log('   ставка не та:', p.op, list[i]['Ставка, сум'], '≠', expected, p.oldOp);
    }
  }
  check('каждая из 96 ставок = ставка старой операции по таблице (48) или 0 (48)', rateOk);
  check('проверенные цифры: «Футболка олд умиз канал» 150, обе «гулфик … чок» 250', Number(list.find((r) => r['Операция'] === 'Футболка олд умиз канал')['Ставка, сум']) === 150 && list.filter((r) => /гулфик (таерлаш тугри|бостириш тогри) чок/.test(r['Операция'])).every((r) => Number(r['Ставка, сум']) === 250));

  const itog = out.filter((r) => r['Раздел'] === 'Итог');
  const zero = out.filter((r) => r['Раздел'] === 'Ставка 0');
  const expZero = PLAN.filter((p) => !p.oldOp || rateByOld[p.oldOp] === 0).length;
  check('итог: 6 изделий с числом операций и «с ценой»', itog.length === 6 && itog[0]['Изделие'] === 'Футболка' && itog[0]['Значение'].startsWith('28 опер.'), JSON.stringify(itog));
  check(`список «Ставка 0» — полный (${expZero} = 48 без пары + 5 пар со старой ставкой 0)`, zero.length === expZero && expZero === 53, `${zero.length} vs ${expZero}`);
  const sv = out.filter((r) => r['Раздел'] === 'Сверка');
  check('сверка: «до» и «после» — те же записи и сумма', sv.length === 2 && sv[0]['Значение'].split('·').slice(1).join() === sv[1]['Значение'].split('·').slice(1).join(), JSON.stringify(sv));

  check('все сотрудники (оба цеха) — профессия «Общая»', (await db.query(`select count(*)::int as n from employees where profession_id is distinct from (select id from professions where name = 'Общая')`)).rows[0].n === 0);
  const newEmp = (await db.query(`insert into employees (name, shop) values ('Новенький', 'workshop') returning (select name from professions where id = profession_id) as p`)).rows[0];
  check('новый сотрудник без профессии получает «Общая» автоматически', newEmp.p === 'Общая');
  check('старые ссылки-приглашения отключены', (await db.query(`select count(*)::int as n from worker_bot_invites where active`)).rows[0].n === 0);
  const lbl = (await db.query(`select operation_label from work_records_all_view limit 1`)).rows[0];
  check('старые записи видны со старыми названиями (история цела)', lbl && /Futbolka|Mayka|Bokser|Tugmachali|Chiska|Dazmol|Yoqa|Eng|Etak|Elka|Shorti|Shoti|Poyas|Tegmachali|Rezinka|Bokovoy|Fytbolka|Tygm|Beyka/i.test(lbl.operation_label), JSON.stringify(lbl));

  // бот работника и мастера — порядок как у мастера
  await db.query(`insert into worker_bot_users (telegram_id, chat_id, language, full_name, shop, status, employee_id) values (2001, 2001, 'ru', 'w', 'factory', 'active', (select id from employees where name = 'Сотр-1'))`);
  await db.query('set role service_role');
  const cat = (await db.query(`select public.bot_catalog(2001) as r`)).rows[0].r;
  await db.query('reset role');
  check('бот работника: все 6 изделий в порядке мастера', cat.models.map((m) => m.name).join('|') === 'Футболка|Тугмачали труси|Короткий труси|Боксер|Майка|Без рукава', JSON.stringify(cat.models.map((m) => m.name)));
  const priced = PLAN.filter((p) => p.model === 'Футболка' && p.oldOp && rateByOld[p.oldOp] > 0).map((p) => p.op);
  check('бот работника: операции Футболки — только с ценой, в порядке мастера', JSON.stringify(cat.models[0].ops.map((o) => o.name)) === JSON.stringify(priced), JSON.stringify(cat.models[0].ops.map((o) => o.name)));
  await db.query(`insert into staff_bot_links (profile_id, telegram_id, chat_id) values ($1, 1001, 1001)`, [UIDS.master]);
  await db.query(`update profiles set current_shop = 'factory' where id = $1`, [UIDS.master]);
  const futId = (await db.query(`select id from catalog_models where name = 'Футболка' and archived_at is null`)).rows[0].id;
  const genId = (await db.query(`select id from professions where name = 'Общая'`)).rows[0].id;
  await db.query('set role service_role');
  const fut = (await db.query(`select public.bot_as_staff(1001, 'staff_catalog_model', jsonb_build_object('model_id', $1::uuid)) as r`, [futId])).rows[0].r;
  const ms = (await db.query(`select public.bot_as_staff(1001, 'staff_catalog_models', jsonb_build_object('profession_id', $1::uuid)) as r`, [genId])).rows[0].r;
  await db.query('reset role');
  check('бот мастера: «Изделия» — в порядке мастера, Футболка — все 28 операций по порядку', ms.models.map((m) => m.name).join('|') === 'Футболка|Тугмачали труси|Короткий труси|Боксер|Майка|Без рукава' && JSON.stringify(fut.ops.map((o) => o.name)) === JSON.stringify(PLAN.filter((p) => p.model === 'Футболка').map((p) => p.op)));

  // повторный запуск
  const out2 = await run(db);
  check('повторный запуск ничего не меняет (96 операций, одна «Общая»)', (await db.query(`select count(*)::int as n from catalog_operations where archived_at is null`)).rows[0].n === 96 && (await db.query(`select count(*)::int as n from professions`)).rows[0].n === 5 && out2.filter((r) => r['Раздел'] === 'Сверка').length === 2);

  // ===================== B. Защита: ставка изменилась после проверки =====================
  const b2 = await build({ tweak: (d) => d.query(`update catalog_operations set rate_per_piece = 160 where name = 'Futbolka old kanal'`) });
  let err = '';
  try { await run(b2.db); } catch (e) { err = String(e.message); }
  check('ставка отличается от проверенной (160 вместо 150) — откат, ничего не изменено', /отличаются от проверенной таблицы/.test(err) && (await b2.db.query(`select count(*)::int as n from professions where name = 'Общая'`)).rows[0].n === 0 && (await b2.db.query(`select count(*)::int as n from catalog_operations where archived_at is null`)).rows[0].n === 49, err);

  // ===================== C. Защита: старой операции нет =====================
  const b3 = await build({ tweak: (d) => d.query(`update catalog_operations set archived_at = now() where name = 'Etak rashma'`) });
  err = '';
  try { await run(b3.db); } catch (e) { err = String(e.message); }
  check('старая операция не найдена — откат со списком (Etak rashma)', /Не найдены старые операции/.test(err) && err.includes('Etak rashma') && (await b3.db.query(`select count(*)::int as n from professions where name = 'Общая'`)).rows[0].n === 0, err);

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(String(e.message ?? e).slice(0, 800));
  process.exit(1);
});
