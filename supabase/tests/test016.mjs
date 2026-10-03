import { buildDb } from './build016.mjs';

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log('  ПРОВАЛ:', name);
  }
}

async function main() {
  const db = await buildDb({ log: true });
  console.log('\n--- миграция 016 применена, запускаю проверки ---\n');

  // 1. profiles.role принимает sklad_syrya, отклоняет мусор
  const roleRow = await db.query(`select role from profiles where email = 'test@example.test'`);
  check('роль zakroyshik сохранилась', roleRow.rows[0].role === 'zakroyshik');

  let rejectedBadRole = false;
  try {
    await db.query(`insert into profiles (id, email, role) values (gen_random_uuid(), 'x@x.test', 'bad_role')`);
  } catch (e) {
    rejectedBadRole = /profiles_role_check/.test(e.message) || /check constraint/.test(e.message);
  }
  check('CHECK отклоняет произвольную роль', rejectedBadRole);

  // 2. Материалы: дедупликация без учёта регистра
  const m1 = await db.query(`insert into raw_materials (name) values ('30/1-PENYE-SUPREM 8% LYC') returning id`);
  const materialId = m1.rows[0].id;
  let dupRejected = false;
  try {
    await db.query(`insert into raw_materials (name) values ('30/1-penye-suprem 8% lyc')`);
  } catch (e) {
    dupRejected = true;
  }
  check('raw_materials: дубликат по имени без учёта регистра отклонён', dupRejected);

  // 3. Цвет материала: дедупликация по (material_id, lower(color))
  const c1 = await db.query(
    `insert into raw_material_colors (material_id, color) values ($1, 'T/SINIY') returning id, stock_rolls`,
    [materialId]
  );
  const colorId = c1.rows[0].id;
  check('новый цвет стартует с остатком 0', Number(c1.rows[0].stock_rolls) === 0);

  let dupColorRejected = false;
  try {
    await db.query(`insert into raw_material_colors (material_id, color) values ($1, 't/siniy')`, [materialId]);
  } catch (e) {
    dupColorRejected = true;
  }
  check('raw_material_colors: дубликат цвета того же материала отклонён', dupColorRejected);

  // Тот же цвет у ДРУГОГО материала — не дубликат, должен пройти
  const m2 = await db.query(`insert into raw_materials (name) values ('Другой материал') returning id`);
  const otherMaterialId = m2.rows[0].id;
  const c2 = await db.query(
    `insert into raw_material_colors (material_id, color) values ($1, 'T/SINIY') returning id`,
    [otherMaterialId]
  );
  check('тот же цвет у другого материала — не дубликат', !!c2.rows[0].id);

  // 4. Приход: увеличивает остаток
  await db.query(
    `insert into raw_material_receipts (color_id, color_code, width_cm, weight_kg, rolls, truck_number, supplier_invoice_number, supplier_batch_number, supplier_name)
     values ($1, '08-77', 160, 320.5, 10, 'А123БВ', 'INV-1', 'BATCH-1', 'AYA Global Tex')`,
    [colorId]
  );
  let stock = await db.query(`select stock_rolls from raw_material_colors where id = $1`, [colorId]);
  check('после прихода +10 остаток = 10', Number(stock.rows[0].stock_rolls) === 10);

  await db.query(`insert into raw_material_receipts (color_id, rolls) values ($1, 5)`, [colorId]);
  stock = await db.query(`select stock_rolls from raw_material_colors where id = $1`, [colorId]);
  check('второй приход +5 остаток = 15', Number(stock.rows[0].stock_rolls) === 15);

  let zeroRollsRejected = false;
  try {
    await db.query(`insert into raw_material_receipts (color_id, rolls) values ($1, 0)`, [colorId]);
  } catch (e) {
    zeroRollsRejected = true;
  }
  check('приход с rolls = 0 отклонён', zeroRollsRejected);

  // created_by проставлен триггером
  const lastReceipt = await db.query(
    `select created_by from raw_material_receipts where color_id = $1 order by created_at desc limit 1`,
    [colorId]
  );
  check('created_by проставлен из auth.uid()', lastReceipt.rows[0].created_by !== null);

  // 5. Выдача: уменьшает остаток, не уходит в минус
  await db.query(`insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 6, 'Закройщик Иван')`, [
    colorId,
  ]);
  stock = await db.query(`select stock_rolls from raw_material_colors where id = $1`, [colorId]);
  check('после выдачи -6 остаток = 9', Number(stock.rows[0].stock_rolls) === 9);

  let overIssueRejected = false;
  try {
    await db.query(`insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 999, 'Кто-то')`, [
      colorId,
    ]);
  } catch (e) {
    overIssueRejected = /insufficient_stock/.test(e.message);
  }
  check('выдача больше остатка отклонена (insufficient_stock)', overIssueRejected);
  stock = await db.query(`select stock_rolls from raw_material_colors where id = $1`, [colorId]);
  check('остаток не изменился после отклонённой выдачи', Number(stock.rows[0].stock_rolls) === 9);

  let emptyTakenByRejected = false;
  try {
    await db.query(`insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 1, '   ')`, [colorId]);
  } catch (e) {
    emptyTakenByRejected = /taken_by/.test(e.message);
  }
  check('выдача без имени закройщика отклонена', emptyTakenByRejected);

  // Точный остаток можно забрать полностью (граничный случай), после — 0 и дальше нельзя
  await db.query(`insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 9, 'Закройщик Пётр')`, [
    colorId,
  ]);
  stock = await db.query(`select stock_rolls from raw_material_colors where id = $1`, [colorId]);
  check('можно забрать остаток полностью, итог 0', Number(stock.rows[0].stock_rolls) === 0);

  let issueFromEmptyRejected = false;
  try {
    await db.query(`insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 1, 'Кто-то')`, [
      colorId,
    ]);
  } catch (e) {
    issueFromEmptyRejected = /insufficient_stock/.test(e.message);
  }
  check('выдача из пустого остатка отклонена', issueFromEmptyRejected);

  // 6. Вьюхи отдают присоединённые material_name/color
  const colorsView = await db.query(`select * from raw_material_colors_view where id = $1`, [colorId]);
  check(
    'raw_material_colors_view: material_name + color корректны',
    colorsView.rows[0].material_name === '30/1-PENYE-SUPREM 8% LYC' && colorsView.rows[0].color === 'T/SINIY'
  );

  const receiptsView = await db.query(
    `select * from raw_material_receipts_view where color_id = $1 order by created_at`,
    [colorId]
  );
  check('raw_material_receipts_view: обе записи прихода видны', receiptsView.rows.length === 2);
  check(
    'raw_material_receipts_view: детали первой поставки сохранены',
    receiptsView.rows[0].color_code === '08-77' &&
      Number(receiptsView.rows[0].width_cm) === 160 &&
      receiptsView.rows[0].supplier_name === 'AYA Global Tex'
  );

  const issuesView = await db.query(`select * from raw_material_issues_view where color_id = $1 order by created_at`, [
    colorId,
  ]);
  check('raw_material_issues_view: обе выдачи видны', issuesView.rows.length === 2);
  check('raw_material_issues_view: taken_by сохранён', issuesView.rows[0].taken_by === 'Закройщик Иван');

  // 7. Остаток не может уйти в отрицательное значение напрямую (CHECK на таблице)
  let negativeStockRejected = false;
  try {
    await db.query(`update raw_material_colors set stock_rolls = -1 where id = $1`, [colorId]);
  } catch (e) {
    negativeStockRejected = true;
  }
  check('CHECK не даёт установить отрицательный остаток напрямую', negativeStockRejected);

  // 8. Существующие таблицы/структура не пострадали — выборочная проверка
  const productsStillThere = await db.query(`select to_regclass('public.products') as t`);
  check('таблица products на месте', productsStillThere.rows[0].t === 'products');
  const oldConstraintGone = await db.query(
    `select conname from pg_constraint where conname = 'profiles_role_check'`
  );
  check('новый CHECK profiles_role_check существует (старый заменён)', oldConstraintGone.rows.length === 1);

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
