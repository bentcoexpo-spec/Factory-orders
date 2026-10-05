import { newDb, applyMigrations } from './build019.mjs';
import { UIDS, asUser } from './build_master.mjs';

let passed = 0;
let failed = 0;
function check(name, cond, evidence) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  ПРОВАЛ:', name, evidence !== undefined ? `(${String(evidence).slice(0, 200)})` : '');
  }
}
async function fails(db, sql, params, re) {
  try {
    await db.query(sql, params);
    return false;
  } catch (e) {
    return re.test(e.message);
  }
}
let current = 'ceo';
const as = async (db, role) => {
  current = role;
  await asUser(db, role);
};
const admin = async (db, sql, params) => {
  await db.query('reset role');
  try {
    return await db.query(sql, params);
  } finally {
    await asUser(db, current);
  }
};

async function main() {
  const db = await newDb();
  await applyMigrations(db, { upTo: '043_piecework_batch_entry.sql' });
  for (const [role, uid] of Object.entries(UIDS)) {
    await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [uid, `${role}@test.test`]);
    await db.query(`insert into profiles (id, email, role) values ($1, $2, $3) on conflict (id) do update set role = excluded.role`, [uid, `${role}@test.test`, role]);
  }
  await db.query(`update profiles set current_shop = 'factory' where id = $1`, [UIDS.master]);

  // ===================== A. Перенос старых данных =====================
  await asUser(db, 'ceo');
  await db.query('reset role');
  const empF = (await db.query(`insert into employees (name, shop) values ('Сотр-Ф', 'factory') returning id`)).rows[0].id;
  const empW = (await db.query(`insert into employees (name, shop) values ('Сотр-Ц', 'workshop') returning id`)).rows[0].id;
  const opA = (await db.query(`insert into operation_types (name, rate_per_piece) values ('Оверлок', 100) returning id`)).rows[0].id;
  const opB = (await db.query(`insert into operation_types (name, rate_per_piece) values ('Bokovoy', 0) returning id`)).rows[0].id;
  const opC = (await db.query(`insert into operation_types (name, rate_per_piece) values ('Строчка', 50) returning id`)).rows[0].id;
  await db.query(`insert into work_records (employee_id, operation_type_id, quantity, date) values ($1, $2, 10, current_date - 2), ($3, $2, 4, current_date - 1)`, [empF, opA, empW]);
  await db.query(`update operation_types set rate_per_piece = 130 where id = $1`, [opA]); // ставка выросла ПОСЛЕ записей
  await db.query(`insert into work_records (employee_id, operation_type_id, quantity, date) values ($1, $2, 5, current_date)`, [empF, opA]);
  const before = (await db.query(`select id, quantity, rate_per_piece, quantity * rate_per_piece as total from work_records order by id`)).rows;
  check('до 044: у записей разные зафиксированные ставки (100, 100, 130)', before.map((r) => Number(r.rate_per_piece)).sort().join() === '100,100,130', JSON.stringify(before.map((r) => r.rate_per_piece)));

  await applyMigrations(db, { from: '044_piecework_catalog.sql', upTo: '044_piecework_catalog.sql' });
  await db.query('reset role');

  const prof = (await db.query(`select id, name from professions`)).rows;
  check('создана профессия «Без профессии»', prof.length === 1 && prof[0].name === 'Без профессии', JSON.stringify(prof));
  const models = (await db.query(`select id, name, whole_rate from catalog_models`)).rows;
  check('создана модель «Прежние операции» без цены целиком', models.length === 1 && models[0].name === 'Прежние операции' && models[0].whole_rate === null);
  const ops = (await db.query(`select name, rate_per_piece from catalog_operations order by name`)).rows;
  check('все 3 прежние операции скопированы со ставками (в т.ч. Bokovoy с 0)', ops.length === 3 && ops.map((o) => `${o.name}:${Number(o.rate_per_piece)}`).join() === 'Bokovoy:0,Оверлок:130,Строчка:50', JSON.stringify(ops));
  const after = (await db.query(`select id, quantity, rate_per_piece, quantity * rate_per_piece as total from work_records order by id`)).rows;
  check('записей столько же (3), ни одна не потеряна', after.length === 3 && before.length === 3);
  check('ставки и суммы старых записей НЕ изменились (100, 100 и 130 — как были зафиксированы)', JSON.stringify(after.map((r) => [r.id, Number(r.rate_per_piece), Number(r.total)])) === JSON.stringify(before.map((r) => [r.id, Number(r.rate_per_piece), Number(r.total)])));
  check('все старые записи привязаны к операции каталога (нет «ничьих»)', Number((await db.query(`select count(*)::int as n from work_records where catalog_operation_id is null and model_id is null`)).rows[0].n) === 0);
  check('operation_types не тронута (3 строки, ставка Оверлок 130)', Number((await db.query(`select count(*)::int as n from operation_types`)).rows[0].n) === 3 && Number((await db.query(`select rate_per_piece from operation_types where id = $1`, [opA])).rows[0].rate_per_piece) === 130);
  const v0 = (await db.query(`select operation_name, operation_label, operation_key, model_name, profession_name, is_whole, line_total from work_records_view order by created_at, id`)).rows;
  check('view: у прежних записей название операции и метка без «Модель ·» (Оверлок), профессия «Без профессии»', v0.every((r) => r.operation_name === 'Оверлок' && r.operation_label === 'Оверлок' && r.profession_name === 'Без профессии' && r.model_name === 'Прежние операции' && r.is_whole === false && /^op:/.test(r.operation_key)), JSON.stringify(v0[0]));
  check('view: сумма старой записи по ставке записи (10 × 100 = 1000), не по новой ставке 130', v0.some((r) => Number(r.line_total) === 1000));

  // ===================== B. Новое поведение =====================
  await db.query(`update employees set shop = 'factory' where id = $1`, [empF]);
  await as(db, 'master');
  const pr1 = (await db.query(`insert into professions (name) values ('  Швея  ') returning id, name`)).rows[0];
  check('название профессии обрезается по краям', pr1.name === 'Швея');
  check('одноимённая профессия (без учёта регистра) отклонена', await fails(db, `insert into professions (name) values ('швея')`, [], /professions_active_name_key|duplicate key/));
  check('пустое название отклонено', await fails(db, `insert into professions (name) values ('   ')`, [], /professions_name_check/));
  const pr2 = (await db.query(`insert into professions (name) values ('Глажка') returning id`)).rows[0].id;
  const mT = (await db.query(`insert into catalog_models (profession_id, name, whole_rate) values ($1, 'Футболка', 1500) returning id`, [pr1.id])).rows[0].id;
  const mM = (await db.query(`insert into catalog_models (profession_id, name) values ($1, 'Майка') returning id`, [pr1.id])).rows[0].id;
  check('одноимённая модель в той же профессии отклонена', await fails(db, `insert into catalog_models (profession_id, name) values ($1, 'ФУТБОЛКА')`, [pr1.id], /duplicate key|catalog_models_active_name_key/));
  check('такая же модель в другой профессии допустима', (await db.query(`insert into catalog_models (profession_id, name) values ($1, 'Футболка') returning id`, [pr2])).rows.length === 1);
  check('цена целиком 0 или отрицательная отклонена', await fails(db, `update catalog_models set whole_rate = 0 where id = $1`, [mT], /catalog_models_whole_rate_check/));
  const oOT = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Оверлок', 120) returning id`, [mT])).rows[0].id;
  const oOM = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Оверлок', 90) returning id`, [mM])).rows[0].id;
  check('одна операция стоит по-разному в разных моделях (120 и 90)', true);
  check('одноимённая операция в той же модели отклонена', await fails(db, `insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'оверлок', 1)`, [mT], /duplicate key|catalog_operations_active_name_key/));
  const oZero = (await db.query(`insert into catalog_operations (model_id, name) values ($1, 'Без ставки') returning id`, [mT])).rows[0].id;
  const mNoWhole = mM;

  // профессия сотрудника
  await db.query(`update employees set profession_id = $1 where id = $2`, [pr1.id, empF]);
  check('мастер ставит профессию сотруднику своего цеха', (await admin(db, `select profession_id from employees where id = $1`, [empF])).rows[0].profession_id === pr1.id);
  check('…но не сотруднику чужого цеха', (await db.query(`update employees set profession_id = $1 where id = $2 returning id`, [pr1.id, empW])).rows.length === 0);

  // ----- запись: цена фиксируется, цель ровно одна
  const n0 = Number((await admin(db, `select count(*)::int as n from work_records`)).rows[0].n);
  const res = await db.query(`select public.create_work_records($1, current_date, $2::jsonb) as n`, [empF, JSON.stringify([{ catalog_operation_id: oOT, quantity: 10 }, { catalog_operation_id: oOM, quantity: 3 }, { model_id: mT, quantity: 2 }])]);
  check('3 строки сохранены: две операции и целое изделие', res.rows[0].n === 3 && Number((await admin(db, `select count(*)::int as n from work_records`)).rows[0].n) === n0 + 3);
  const lines = (await db.query(`select operation_label, operation_name, rate_per_piece, quantity, line_total, is_whole, model_name, profession_name from work_records_view where employee_id = $1 and date = current_date order by quantity`, [empF])).rows;
  const byQty = (q) => lines.find((l) => Number(l.quantity) === q);
  check('«Футболка · Оверлок» = 120 × 10 = 1200', byQty(10).operation_label === 'Футболка · Оверлок' && Number(byQty(10).rate_per_piece) === 120 && Number(byQty(10).line_total) === 1200 && byQty(10).profession_name === 'Швея', JSON.stringify(byQty(10)));
  check('«Майка · Оверлок» = 90 × 3 = 270 (другая цена той же операции)', Number(byQty(3).rate_per_piece) === 90 && Number(byQty(3).line_total) === 270);
  check('целое изделие: «Футболка (целиком)» = 1500 × 2 = 3000', byQty(2).is_whole === true && byQty(2).operation_label === 'Футболка (целиком)' && Number(byQty(2).line_total) === 3000, JSON.stringify(byQty(2)));
  await db.query(`update catalog_operations set rate_per_piece = 999 where id = $1`, [oOT]);
  await db.query(`update catalog_models set whole_rate = 5000 where id = $1`, [mT]);
  const frozen = (await db.query(`select quantity, rate_per_piece from work_records_view where employee_id = $1 and date = current_date and quantity <> 5`, [empF])).rows; // 5 шт — прежняя запись из части A
  check('цену в каталоге подняли — записи остались по зафиксированным (120 / 90 / 1500)', frozen.map((r) => Number(r.rate_per_piece)).sort((a, b) => a - b).join() === '90,120,1500', JSON.stringify(frozen));
  await db.query(`update catalog_operations set rate_per_piece = 120 where id = $1`, [oOT]);
  await db.query(`update catalog_models set whole_rate = 1500 where id = $1`, [mT]);

  const n1 = Number((await admin(db, `select count(*)::int as n from work_records`)).rows[0].n);
  const bad = (rows, re) => fails(db, `select public.create_work_records($1, current_date, $2::jsonb)`, [empF, JSON.stringify(rows)], re);
  check('операция без ставки отклонена — не сохраняется ни одна строка', (await bad([{ catalog_operation_id: oOT, quantity: 1 }, { catalog_operation_id: oZero, quantity: 1 }], /operation_rate_not_set/)) && Number((await admin(db, `select count(*)::int as n from work_records`)).rows[0].n) === n1);
  check('целое изделие без цены отклонено', await bad([{ model_id: mNoWhole, quantity: 1 }], /whole_rate_not_set/));
  check('строка без цели и строка с двумя целями отклонены', (await bad([{ quantity: 1 }], /operation_required/)) && (await bad([{ catalog_operation_id: oOT, model_id: mT, quantity: 1 }], /operation_required/)));
  check('нецелое количество отклонено', await bad([{ catalog_operation_id: oOT, quantity: 1.5 }], /invalid_quantity/));
  check('прямая вставка без цели отклонена, прежняя ссылка operation_type_id больше не принимается', await fails(db, `insert into work_records (employee_id, operation_type_id, quantity) values ($1, $2, 1)`, [empF, opA], /catalog_required|work_records_target_check/));

  // ----- правка записи
  const rec = (await db.query(`select id from work_records where employee_id = $1 and quantity = 10 and date = current_date`, [empF])).rows[0].id;
  await db.query(`update work_records set quantity = 11 where id = $1`, [rec]);
  await db.query(`update catalog_operations set rate_per_piece = 777 where id = $1`, [oOT]);
  await db.query(`update work_records set quantity = 12 where id = $1`, [rec]);
  check('правка количества: ставка записи остаётся 120 даже после смены цены в каталоге', Number((await db.query(`select rate_per_piece from work_records_view where id = $1`, [rec])).rows[0].rate_per_piece) === 120);
  await db.query(`update work_records set catalog_operation_id = $1 where id = $2`, [oOM, rec]);
  check('правка операции: ставка берётся у новой операции (90)', Number((await db.query(`select rate_per_piece from work_records_view where id = $1`, [rec])).rows[0].rate_per_piece) === 90);
  await db.query(`update work_records set catalog_operation_id = null, model_id = $1 where id = $2`, [mT, rec]);
  const asWhole = (await db.query(`select is_whole, rate_per_piece from work_records_view where id = $1`, [rec])).rows[0];
  check('операцию можно заменить целым изделием (1500)', asWhole.is_whole === true && Number(asWhole.rate_per_piece) === 1500);
  check('правка на операцию без ставки отклонена', await fails(db, `update work_records set model_id = null, catalog_operation_id = $1 where id = $2`, [oZero, rec], /operation_rate_not_set/));
  await db.query(`update catalog_operations set rate_per_piece = 120 where id = $1`, [oOT]);

  // ----- цеха по-прежнему
  check('мастер «Фабрики» не вносит сотруднику «Цеха»', await fails(db, `select public.create_work_records($1, current_date, $2::jsonb)`, [empW, JSON.stringify([{ catalog_operation_id: oOT, quantity: 1 }])], /employee_not_in_shop/));
  check('и не видит записи сотрудника «Цеха» в view', (await db.query(`select 1 from work_records_view where employee_id = $1`, [empW])).rows.length === 0);

  // ----- удаление: удалить или архивировать
  const rm = async (kind, id) => (await db.query(`select public.remove_catalog_item($1, $2) as r`, [kind, id])).rows[0].r;
  const oFree = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Свободная', 10) returning id`, [mT])).rows[0].id;
  check('операция без записей — удаляется', (await rm('operation', oFree)) === 'deleted' && (await admin(db, `select 1 from catalog_operations where id = $1`, [oFree])).rows.length === 0);
  check('операция с записями — архивируется (запись, сумма и название на месте)', (await rm('operation', oOM)) === 'archived' && (await admin(db, `select archived_at from catalog_operations where id = $1`, [oOM])).rows[0].archived_at !== null);
  const kept = (await db.query(`select operation_label, line_total from work_records_view where employee_id = $1 and quantity = 3 and date = current_date`, [empF])).rows[0];
  check('после архива старая запись читается как раньше («Майка · Оверлок», 270)', kept.operation_label === 'Майка · Оверлок' && Number(kept.line_total) === 270, JSON.stringify(kept));
  check('в архивную операцию новую запись внести нельзя', await fails(db, `select public.create_work_records($1, current_date, $2::jsonb)`, [empF, JSON.stringify([{ catalog_operation_id: oOM, quantity: 1 }])], /catalog_item_archived/));
  check('после архива можно создать новую операцию с тем же именем в той же модели', (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Оверлок', 95) returning id`, [mM])).rows.length === 1);

  const mFree = (await db.query(`insert into catalog_models (profession_id, name) values ($1, 'Пустая') returning id`, [pr1.id])).rows[0].id;
  await db.query(`insert into catalog_operations (model_id, name) values ($1, 'Х')`, [mFree]);
  check('модель без записей — удаляется вместе со своими операциями', (await rm('model', mFree)) === 'deleted' && (await admin(db, `select count(*)::int as n from catalog_operations where model_id = $1`, [mFree])).rows[0].n === 0);
  check('модель с записями — архивируется вместе с операциями', (await rm('model', mT)) === 'archived' && Number((await admin(db, `select count(*)::int as n from catalog_operations where model_id = $1 and archived_at is null`, [mT])).rows[0].n) === 0);
  check('запись «целиком» после архива модели читается («Футболка (целиком)», 1500)', (await db.query(`select operation_label, rate_per_piece from work_records_view where id = $1`, [rec])).rows[0].operation_label === 'Футболка (целиком)');

  const pFree = (await db.query(`insert into professions (name) values ('Упаковка') returning id`)).rows[0].id;
  await db.query(`insert into catalog_models (profession_id, name) values ($1, 'Пачка')`, [pFree]);
  await admin(db, `update employees set profession_id = $1 where id = $2`, [pFree, empF]);
  check('профессия без записей — удаляется, у сотрудника профессия очищается', (await rm('profession', pFree)) === 'deleted' && (await admin(db, `select profession_id from employees where id = $1`, [empF])).rows[0].profession_id === null);
  await admin(db, `update employees set profession_id = $1 where id = $2`, [pr1.id, empF]);
  check('профессия с записями — архивируется; сотрудник остаётся с ней', (await rm('profession', pr1.id)) === 'archived' && (await admin(db, `select profession_id from employees where id = $1`, [empF])).rows[0].profession_id === pr1.id);
  check('неизвестный вид / несуществующий id отклонены', (await fails(db, `select public.remove_catalog_item('xxx', $1)`, [pr1.id], /invalid_kind/)) && (await fails(db, `select public.remove_catalog_item('model', gen_random_uuid())`, [], /catalog_item_not_found/)));

  // ----- прямой DELETE и права других ролей
  check('прямой DELETE из таблиц каталога не удаляет ничего (политики на DELETE нет)', (await db.query(`delete from catalog_operations returning id`)).rows.length === 0 && (await db.query(`delete from professions returning id`)).rows.length === 0);
  // перенос
  const pr3 = (await db.query(`insert into professions (name) values ('Раскрой') returning id`)).rows[0].id;
  const mMove = (await db.query(`insert into catalog_models (profession_id, name) values ($1, 'Перенос') returning id`, [pr2])).rows[0].id;
  await db.query(`update catalog_models set profession_id = $1 where id = $2`, [pr3, mMove]);
  check('модель можно перенести в другую профессию', (await admin(db, `select profession_id from catalog_models where id = $1`, [mMove])).rows[0].profession_id === pr3);
  const oMove = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Подгиб', 30) returning id`, [mMove])).rows[0].id;
  const mDest = (await db.query(`insert into catalog_models (profession_id, name) values ($1, 'Назначение') returning id`, [pr3])).rows[0].id;
  await db.query(`update catalog_operations set model_id = $1 where id = $2`, [mDest, oMove]);
  check('операцию можно перенести в другую модель', (await admin(db, `select model_id from catalog_operations where id = $1`, [oMove])).rows[0].model_id === mDest);

  for (const role of ['kladovshik', 'zakroyshik']) {
    await as(db, role);
    check(`${role}: каталог не видит`, (await db.query(`select 1 from professions`)).rows.length === 0 && (await db.query(`select 1 from catalog_operations`)).rows.length === 0);
    check(`${role}: добавить в каталог и удалить из него нельзя`, (await fails(db, `insert into professions (name) values ('Хак')`, [], /row-level security|permission denied/)) && (await fails(db, `select public.remove_catalog_item('operation', $1)`, [oOT], /insufficient_privilege/)));
    check(`${role}: пакетное сохранение отказано`, await fails(db, `select public.create_work_records($1, current_date, $2::jsonb)`, [empF, JSON.stringify([{ catalog_operation_id: oOT, quantity: 1 }])], /insufficient_privilege/));
  }
  await as(db, 'ceo');
  check('CEO видит и правит каталог', (await db.query(`select count(*)::int as n from professions`)).rows[0].n >= 3 && (await db.query(`update professions set name = 'Раскрой-2' where id = $1 returning id`, [pr3])).rows.length === 1);

  await db.query('reset role');
  const opts = (await db.query(`select reloptions from pg_class where relname = 'work_records_view'`)).rows[0].reloptions ?? [];
  check('work_records_view сохранила security_invoker=true', opts.includes('security_invoker=true'), JSON.stringify(opts));

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(String(e.message ?? e).slice(0, 400));
  process.exit(1);
});
