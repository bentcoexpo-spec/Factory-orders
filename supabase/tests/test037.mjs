import { buildDb, asUser } from './build_master.mjs';

let passed = 0;
let failed = 0;
function check(name, cond, evidence) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  ПРОВАЛ:', name, evidence ? `(${evidence})` : '');
  }
}

async function main() {
  const db = await buildDb({ log: true });
  console.log('\n--- 037 применена, проверяю ---\n');

  await asUser(db, 'ceo');

  // Подготовка: материал+цвет с остатком в рулонах.
  const mat = await db.query(`insert into raw_materials (name) values ('Тест-037 материал') returning id`);
  const color = await db.query(
    `insert into raw_material_colors (material_id, color) values ($1, 'Красный') returning id`,
    [mat.rows[0].id]
  );
  const colorId = color.rows[0].id;
  await db.query(
    `insert into raw_material_receipts (color_id, rolls) values ($1, 20)`,
    [colorId]
  );

  // 1. create_cutting_request — товар с разбивкой по размерам + товар без.
  const req = await db.query(
    `select create_cutting_request($1, $2, $3, $4::jsonb) as id`,
    [
      colorId,
      5,
      'Срочно к пятнице',
      JSON.stringify([
        { product_name: 'Футболка', rows: [{ size: 'M', quantity: 10 }, { size: 'L', quantity: 5 }] },
        { product_name: 'Шорты', rows: [{ quantity: 8 }] },
      ]),
    ]
  );
  const requestId = req.rows[0].id;
  check('create_cutting_request вернул id', !!requestId);

  const view1 = await db.query(`select * from cutting_requests_view where id = $1`, [requestId]);
  const row1 = view1.rows[0];
  check('статус новой заявки — new', row1.status === 'new', row1.status);
  check('material_name/color подтянулись', row1.material_name === 'Тест-037 материал' && row1.color === 'Красный');
  check('rolls_hint сохранён', row1.rolls_hint === 5, row1.rolls_hint);
  check('план: 2 товара', row1.products.length === 2, JSON.stringify(row1.products));
  check('план: общее количество 23', Number(row1.plan_total) === 23, row1.plan_total);
  const shorts = row1.products.find((p) => p.product_name === 'Шорты');
  check('товар без разбивки — одна строка без size', shorts.sizes.length === 1 && shorts.sizes[0].size === null, JSON.stringify(shorts));

  // 2. Смешивать строку без размера с другими строками у одного товара нельзя.
  let ambiguousRejected = false;
  try {
    await db.query(`select create_cutting_request($1, null, null, $2::jsonb)`, [
      colorId,
      JSON.stringify([{ product_name: 'Брак-тест', rows: [{ quantity: 5 }, { size: 'M', quantity: 3 }] }]),
    ]);
  } catch (e) {
    ambiguousRejected = /ambiguous_row/.test(e.message);
  }
  check('строка без размера вместе с другими строками отклонена', ambiguousRejected);

  // 3. Заявка не видна кладовщику/мастеру напрямую через view (security_invoker).
  await asUser(db, 'kladovshik');
  const kladRows = await db.query(`select * from cutting_requests_view`);
  check('кладовщик не видит ни одной заявки через view (security_invoker)', kladRows.rows.length === 0, kladRows.rows.length);

  // 4. Закройщик видит заявку (select staff policy).
  await asUser(db, 'zakroyshik');
  const zRows = await db.query(`select * from cutting_requests_view where id = $1`, [requestId]);
  check('закройщик видит заявку', zRows.rows.length === 1);

  // Закройщику нельзя создавать/менять/отменять заявки.
  let zCreateRejected = false;
  try {
    await db.query(`select create_cutting_request($1, null, null, $2::jsonb)`, [
      colorId,
      JSON.stringify([{ product_name: 'X', rows: [{ quantity: 1 }] }]),
    ]);
  } catch (e) {
    zCreateRejected = /insufficient_privilege/.test(e.message);
  }
  check('закройщик не может создать заявку', zCreateRejected);

  let zCancelRejected = false;
  try {
    await db.query(`select cancel_cutting_request($1)`, [requestId]);
  } catch (e) {
    zCancelRejected = /insufficient_privilege/.test(e.message);
  }
  check('закройщик не может отменить заявку', zCancelRejected);

  // 5. Закройщик берёт материал и отчитывается о партии по этой заявке —
  //    статус заявки должен сам перейти в in_progress.
  const issue = await db.query(
    `insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 3, 'Тест') returning id`,
    [colorId]
  );
  const batch = await db.query(
    `select * from create_cutting_batch($1, $2::jsonb, 'factory', $3)`,
    [
      issue.rows[0].id,
      JSON.stringify([{ product_name: 'Футболка', sizes: [{ size: 'M', quantity: 7 }, { size: 'XL', quantity: 2 }] }]),
      requestId,
    ]
  );
  check('партия создана и привязана к заявке', !!batch.rows[0].out_batch_id);

  await asUser(db, 'ceo');
  const view2 = await db.query(`select * from cutting_requests_view where id = $1`, [requestId]);
  const row2 = view2.rows[0];
  check('заявка перешла в in_progress после первой партии', row2.status === 'in_progress', row2.status);
  const tshirt2 = row2.products.find((p) => p.product_name === 'Футболка');
  check('факт по "Футболке" — 9 (7+2, по названию, без привязки к размеру плана)', Number(tshirt2.fact_total) === 9, tshirt2.fact_total);
  const shorts2 = row2.products.find((p) => p.product_name === 'Шорты');
  check('факт по "Шортам" — 0 (ещё не кроили)', Number(shorts2.fact_total) === 0, shorts2.fact_total);

  // 6. Редактирование заявки, пока не done/cancelled — полная замена плана.
  await db.query(
    `select update_cutting_request($1, $2, $3, $4, $5::jsonb)`,
    [requestId, colorId, 10, 'Обновлённый план', JSON.stringify([{ product_name: 'Футболка', rows: [{ quantity: 50 }] }])]
  );
  const view3 = await db.query(`select * from cutting_requests_view where id = $1`, [requestId]);
  const row3 = view3.rows[0];
  check('после редактирования остался один товар в плане', row3.products.length === 1, JSON.stringify(row3.products));
  check('rolls_hint обновлён', row3.rolls_hint === 10, row3.rolls_hint);
  check('факт по-прежнему виден после замены плана (9)', Number(row3.products[0].fact_total) === 9, row3.products[0].fact_total);

  // 7. complete_cutting_request — статус done, дальше заблокировано.
  await db.query(`select complete_cutting_request($1)`, [requestId]);
  const view4 = await db.query(`select status from cutting_requests_view where id = $1`, [requestId]);
  check('заявка завершена CEO вручную', view4.rows[0].status === 'done', view4.rows[0].status);

  let lockedAfterDone = false;
  try {
    await db.query(`select update_cutting_request($1, $2, null, null, $3::jsonb)`, [
      requestId,
      colorId,
      JSON.stringify([{ product_name: 'X', rows: [{ quantity: 1 }] }]),
    ]);
  } catch (e) {
    lockedAfterDone = /cutting_request_locked/.test(e.message);
  }
  check('редактирование завершённой заявки отклонено', lockedAfterDone);

  let cancelAfterDoneRejected = false;
  try {
    await db.query(`select cancel_cutting_request($1)`, [requestId]);
  } catch (e) {
    cancelAfterDoneRejected = /cutting_request_locked/.test(e.message);
  }
  check('отмена завершённой заявки отклонена', cancelAfterDoneRejected);

  // Нельзя привязать новую партию к уже завершённой заявке.
  await asUser(db, 'zakroyshik');
  const issue2 = await db.query(
    `insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 2, 'Тест2') returning id`,
    [colorId]
  );
  let batchToLockedRejected = false;
  try {
    await db.query(`select * from create_cutting_batch($1, $2::jsonb, 'factory', $3)`, [
      issue2.rows[0].id,
      JSON.stringify([{ product_name: 'Футболка', sizes: [{ size: 'M', quantity: 1 }] }]),
      requestId,
    ]);
  } catch (e) {
    batchToLockedRejected = /cutting_request_locked/.test(e.message);
  }
  check('нельзя привязать партию к завершённой заявке', batchToLockedRejected);

  // 8. Отдельная заявка — отмена из статуса "new".
  await asUser(db, 'ceo');
  const req2 = await db.query(`select create_cutting_request($1, null, null, $2::jsonb) as id`, [
    colorId,
    JSON.stringify([{ product_name: 'Отменяемая', rows: [{ quantity: 1 }] }]),
  ]);
  await db.query(`select cancel_cutting_request($1)`, [req2.rows[0].id]);
  const view5 = await db.query(`select status from cutting_requests_view where id = $1`, [req2.rows[0].id]);
  check('заявка отменена из статуса new', view5.rows[0].status === 'cancelled', view5.rows[0].status);

  // 9. cutting_batches_view по-прежнему с security_invoker (явно переустановлен в 037).
  const reloptions = await db.query(
    `select reloptions from pg_class where relname = 'cutting_batches_view'`
  );
  const opts = reloptions.rows[0].reloptions ?? [];
  check(
    'cutting_batches_view сохранила security_invoker=true после пересоздания в 037',
    opts.some((o) => o === 'security_invoker=true'),
    JSON.stringify(opts)
  );

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
