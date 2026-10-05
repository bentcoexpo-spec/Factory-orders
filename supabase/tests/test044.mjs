import { newDb, applyMigrations } from './build019.mjs';
import { UIDS, asUser } from './build_master.mjs';

let passed = 0;
let failed = 0;
function check(name, cond, evidence) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  ПРОВАЛ:', name, evidence !== undefined ? `(${evidence})` : '');
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
async function seedUsers(db) {
  for (const [role, uid] of Object.entries(UIDS)) {
    await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [uid, `${role}@test.test`]);
    await db.query(`insert into profiles (id, email, role) values ($1, $2, $3) on conflict (id) do update set role = excluded.role`, [uid, `${role}@test.test`, role]);
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
  // ====== 1. Переход со старых данных: ставка в записи = текущая ставка операции ======
  const db = await newDb();
  await applyMigrations(db, { upTo: '042_variant_archive_and_sizes.sql' });
  await seedUsers(db);
  await asUser(db, 'ceo');
  await db.query('reset role'); // суперпользователь, но auth.uid() = CEO — как при вводе из SQL Editor
  const empOld = (await db.query(`insert into employees (name, shop) values ('Старый-044', 'factory') returning id`)).rows[0].id;
  const opOld = (await db.query(`insert into operation_types (name, rate_per_piece) values ('Старая операция', 150) returning id`)).rows[0].id;
  const opZero = (await db.query(`insert into operation_types (name, rate_per_piece) values ('Bokovoy-044', 0) returning id`)).rows[0].id;
  await db.query(`insert into work_records (employee_id, operation_type_id, quantity) values ($1, $2, 10)`, [empOld, opOld]);
  const viewBefore = (await db.query(`select rate_per_piece, line_total from work_records_view`)).rows[0];
  check('до 043: ставка берётся из операции «на лету» (1500)', Number(viewBefore.line_total) === 1500);
  // доказываем исходную проблему: смена ставки меняет старую запись
  await db.query(`update operation_types set rate_per_piece = 200 where id = $1`, [opOld]);
  check('до 043: смена ставки пересчитывала старую запись (проблема, которую чиним)', Number((await db.query(`select line_total from work_records_view`)).rows[0].line_total) === 2000);
  await db.query(`update operation_types set rate_per_piece = 150 where id = $1`, [opOld]);

  await applyMigrations(db, { from: '043_piecework_batch_entry.sql', upTo: '043_piecework_batch_entry.sql' });
  await db.query('reset role');
  const stored = (await db.query(`select rate_per_piece from work_records`)).rows[0];
  check('после 043: у старой записи ставка = текущая ставка операции (150), данные на экране не изменились', Number(stored.rate_per_piece) === 150);
  await db.query(`update operation_types set rate_per_piece = 999 where id = $1`, [opOld]);
  const afterChange = (await db.query(`select rate_per_piece, line_total from work_records_view`)).rows[0];
  check('после 043: смена ставки операции НЕ пересчитывает старую запись (150, итог 1500)', Number(afterChange.rate_per_piece) === 150 && Number(afterChange.line_total) === 1500, JSON.stringify(afterChange));
  await db.query(`update operation_types set rate_per_piece = 150 where id = $1`, [opOld]);

  // ====== 2. Ставка в момент записи ======
  const shopEmp = (s) => `insert into employees (name, shop) values ('Сотр-${s}', '${s}') returning id`;
  const empF = (await db.query(shopEmp('factory'))).rows[0].id;
  const empW = (await db.query(shopEmp('workshop'))).rows[0].id;
  const op1 = (await db.query(`insert into operation_types (name, rate_per_piece) values ('Оверлок-044', 100) returning id`)).rows[0].id;
  const op2 = (await db.query(`insert into operation_types (name, rate_per_piece) values ('Строчка-044', 50) returning id`)).rows[0].id;
  await db.query(`update profiles set current_shop = 'factory' where id = $1`, [UIDS.master]);

  await as(db, 'master');
  const direct = (await db.query(`insert into work_records (employee_id, operation_type_id, quantity, rate_per_piece) values ($1, $2, 5, 1) returning id, rate_per_piece`, [empF, op1])).rows[0];
  check('ставка в записи берётся из операции (100), присланная клиентом (1) игнорируется', Number(direct.rate_per_piece) === 100, direct.rate_per_piece);
  await admin(db, `update operation_types set rate_per_piece = 120 where id = $1`, [op1]);
  const rec1 = (await db.query(`select rate_per_piece, line_total from work_records_view where id = $1`, [direct.id])).rows[0];
  check('операции повысили ставку до 120 — старая запись осталась по 100 (итог 500)', Number(rec1.rate_per_piece) === 100 && Number(rec1.line_total) === 500, JSON.stringify(rec1));
  const direct2 = (await db.query(`insert into work_records (employee_id, operation_type_id, quantity) values ($1, $2, 5) returning id, rate_per_piece`, [empF, op1])).rows[0];
  check('новая запись после смены ставки — по новой ставке (120)', Number(direct2.rate_per_piece) === 120);

  // правка: количество — ставка остаётся; операция — берётся заново
  await db.query(`update work_records set quantity = 7 where id = $1`, [direct.id]);
  check('правка количества: ставка остаётся прежней (100)', Number((await db.query(`select rate_per_piece from work_records where id = $1`, [direct.id])).rows[0].rate_per_piece) === 100);
  await db.query(`update work_records set rate_per_piece = 1 where id = $1`, [direct.id]);
  check('присланная при правке ставка игнорируется', Number((await db.query(`select rate_per_piece from work_records where id = $1`, [direct.id])).rows[0].rate_per_piece) === 100);
  await db.query(`update work_records set operation_type_id = $1 where id = $2`, [op2, direct.id]);
  check('правка операции: ставка берётся у новой операции (50)', Number((await db.query(`select rate_per_piece from work_records where id = $1`, [direct.id])).rows[0].rate_per_piece) === 50);

  // ====== 3. Ставка не задана ======
  check('прямая вставка с операцией без ставки отклонена («Сначала укажите ставку»)', await fails(db, `insert into work_records (employee_id, operation_type_id, quantity) values ($1, $2, 1)`, [empF, opZero], /operation_rate_not_set.*Сначала укажите ставку/));
  check('смена операции записи на операцию без ставки отклонена', await fails(db, `update work_records set operation_type_id = $1 where id = $2`, [opZero, direct.id], /operation_rate_not_set/));

  // ====== 4. create_work_records: всё или ничего ======
  const cnt = async () => Number((await admin(db, `select count(*)::int as n from work_records`)).rows[0].n);
  const before = await cnt();
  const ok = await db.query(`select public.create_work_records($1, current_date, $2::jsonb) as n`, [empF, JSON.stringify([{ operation_type_id: op1, quantity: 10 }, { operation_type_id: op2, quantity: 20, batch_id: null }, { operation_type_id: op1, quantity: 3 }])]);
  check('3 строки сохранены одним вызовом', ok.rows[0].n === 3 && (await cnt()) === before + 3);
  const lines = (await db.query(`select operation_name, quantity, rate_per_piece, line_total from work_records_view where employee_id = $1 and date = current_date order by quantity`, [empF])).rows;
  check('в строках зафиксированы ставки и суммы (одна операция дважды за день допустима)', lines.filter((l) => l.operation_name === 'Оверлок-044').length >= 2 && lines.some((l) => Number(l.quantity) === 20 && Number(l.line_total) === 1000), JSON.stringify(lines));

  const n1 = await cnt();
  check('одна из строк с операцией без ставки — не сохраняется НИ ОДНА', (await fails(db, `select public.create_work_records($1, current_date, $2::jsonb)`, [empF, JSON.stringify([{ operation_type_id: op1, quantity: 1 }, { operation_type_id: opZero, quantity: 1 }, { operation_type_id: op2, quantity: 1 }])], /operation_rate_not_set/)) && (await cnt()) === n1);
  check('нецелое количество в последней строке — не сохраняется ни одна', (await fails(db, `select public.create_work_records($1, current_date, $2::jsonb)`, [empF, JSON.stringify([{ operation_type_id: op1, quantity: 4 }, { operation_type_id: op2, quantity: 1.5 }])], /invalid_quantity/)) && (await cnt()) === n1);
  check('нулевое/отрицательное количество отклонено', await fails(db, `select public.create_work_records($1, current_date, $2::jsonb)`, [empF, JSON.stringify([{ operation_type_id: op1, quantity: 0 }])], /invalid_quantity/));
  check('пустой список строк отклонён', await fails(db, `select public.create_work_records($1, current_date, '[]'::jsonb)`, [empF], /rows_required/));
  check('строка без операции отклонена', await fails(db, `select public.create_work_records($1, current_date, $2::jsonb)`, [empF, JSON.stringify([{ quantity: 2 }])], /operation_required/));
  check('без сотрудника / без даты отклонено', (await fails(db, `select public.create_work_records(null, current_date, $1::jsonb)`, [JSON.stringify([{ operation_type_id: op1, quantity: 1 }])], /employee_required/)) && (await fails(db, `select public.create_work_records($1, null, $2::jsonb)`, [empF, JSON.stringify([{ operation_type_id: op1, quantity: 1 }])], /date_required/)));
  check('несуществующая партия отклонена, ничего не сохранено', (await fails(db, `select public.create_work_records($1, current_date, $2::jsonb)`, [empF, JSON.stringify([{ operation_type_id: op1, quantity: 1, batch_id: '00000000-0000-0000-0000-000000000099' }])], /batch_not_found/)) && (await cnt()) === n1);

  // ====== 5. Цеха ======
  check('мастер «Фабрики» не может внести запись сотруднику «Цеха»', (await fails(db, `select public.create_work_records($1, current_date, $2::jsonb)`, [empW, JSON.stringify([{ operation_type_id: op1, quantity: 1 }])], /employee_not_in_shop/)) && (await cnt()) === n1);
  // партии двух цехов (сырьё заводит закройщик)
  await as(db, 'zakroyshik');
  await admin(db, `insert into raw_materials (name) values ('Ткань-044')`);
  const colorId = (await admin(db, `insert into raw_material_colors (material_id, color) select id, 'Серый' from raw_materials where name = 'Ткань-044' returning id`)).rows[0].id;
  await admin(db, `insert into raw_material_receipts (color_id, rolls) values ($1, 30)`, [colorId]);
  const mkBatch = async (shop) => {
    await as(db, 'zakroyshik');
    const issue = (await db.query(`insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 1, 'Т') returning id`, [colorId])).rows[0].id;
    const b = (await db.query(`select * from create_cutting_batch($1, $2::jsonb, $3)`, [issue, JSON.stringify([{ product_name: 'Футболка-044', sizes: [{ size: 'M', quantity: 5 }] }]), shop])).rows[0].out_batch_id;
    return b;
  };
  const bF = await mkBatch('factory');
  const bW = await mkBatch('workshop');
  await as(db, 'master');
  const withBatch = await db.query(`select public.create_work_records($1, current_date, $2::jsonb) as n`, [empF, JSON.stringify([{ operation_type_id: op1, quantity: 2, batch_id: bF }, { operation_type_id: op2, quantity: 2 }])]);
  check('партия своего цеха на одной из строк (у другой нет партии) — сохранено', withBatch.rows[0].n === 2 && Number((await db.query(`select count(*)::int as n from work_records_view where batch_id = $1`, [bF])).rows[0].n) === 1);
  const n2 = await cnt();
  check('партия чужого цеха отклонена, ничего не сохранено', (await fails(db, `select public.create_work_records($1, current_date, $2::jsonb)`, [empF, JSON.stringify([{ operation_type_id: op1, quantity: 1 }, { operation_type_id: op1, quantity: 1, batch_id: bW }])], /batch_not_in_shop/)) && (await cnt()) === n2);

  await admin(db, `update profiles set current_shop = 'workshop' where id = $1`, [UIDS.master]);
  check('после смены цеха мастер «Цеха» вносит своему сотруднику', (await db.query(`select public.create_work_records($1, current_date, $2::jsonb) as n`, [empW, JSON.stringify([{ operation_type_id: op1, quantity: 1 }])])).rows[0].n === 1);
  check('…но уже не сотруднику «Фабрики»', await fails(db, `select public.create_work_records($1, current_date, $2::jsonb)`, [empF, JSON.stringify([{ operation_type_id: op1, quantity: 1 }])], /employee_not_in_shop/));
  const seen = (await db.query(`select distinct employee_name from work_records_view`)).rows.map((r) => r.employee_name);
  check('мастер «Цеха» видит в записях только сотрудников своего цеха', seen.length === 1 && seen[0] === 'Сотр-workshop', JSON.stringify(seen));
  check('и не может править/удалять записи чужого цеха', (await db.query(`delete from work_records where employee_id = $1 returning id`, [empF])).rows.length === 0 && (await db.query(`update work_records set quantity = 99 where employee_id = $1 returning id`, [empF])).rows.length === 0);
  await admin(db, `update profiles set current_shop = null where id = $1`, [UIDS.master]);
  check('мастер без выбранного цеха не может вносить', await fails(db, `select public.create_work_records($1, current_date, $2::jsonb)`, [empF, JSON.stringify([{ operation_type_id: op1, quantity: 1 }])], /employee_not_in_shop/));
  await admin(db, `update profiles set current_shop = 'factory' where id = $1`, [UIDS.master]);

  // правка и удаление своих записей
  const mine = (await db.query(`select id from work_records where employee_id = $1 limit 1`, [empF])).rows[0].id;
  await db.query(`update work_records set quantity = 11 where id = $1`, [mine]);
  check('мастер правит запись своего цеха', Number((await db.query(`select quantity from work_records where id = $1`, [mine])).rows[0].quantity) === 11);
  await db.query(`delete from work_records where id = $1`, [mine]);
  check('мастер удаляет запись своего цеха', (await db.query(`select 1 from work_records where id = $1`, [mine])).rows.length === 0);

  // ====== 6. Права других ролей ======
  await as(db, 'ceo');
  check('CEO может вносить записи любому цеху', (await db.query(`select public.create_work_records($1, current_date, $2::jsonb) as n`, [empW, JSON.stringify([{ operation_type_id: op1, quantity: 1 }])])).rows[0].n === 1);
  for (const role of ['kladovshik', 'zakroyshik']) {
    await as(db, role);
    check(`${role}: пакетное сохранение отказано`, await fails(db, `select public.create_work_records($1, current_date, $2::jsonb)`, [empF, JSON.stringify([{ operation_type_id: op1, quantity: 1 }])], /insufficient_privilege/));
    check(`${role}: записей сделки не видит`, (await db.query(`select * from work_records_view`)).rows.length === 0);
  }

  // ====== 7. view по-прежнему под security_invoker ======
  await db.query('reset role');
  const opts = (await db.query(`select reloptions from pg_class where relname = 'work_records_view'`)).rows[0].reloptions ?? [];
  check('work_records_view сохранила security_invoker=true', opts.includes('security_invoker=true'), JSON.stringify(opts));

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
