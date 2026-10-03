import { buildDb } from './build019.mjs';

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  ПРОВАЛ:', name);
  }
}

async function main() {
  const db = await buildDb({ log: true });
  console.log('\n--- миграция 020 применена, проверяю ---\n');

  const m = await db.query(`insert into raw_materials (name) values ('Тестовая ткань') returning id`);
  const materialId = m.rows[0].id;
  const c = await db.query(`insert into raw_material_colors (material_id, color) values ($1, 'Синий') returning id`, [
    materialId,
  ]);
  const colorId = c.rows[0].id;
  await db.query(
    `insert into raw_material_receipts (color_id, color_code, width_cm, weight_kg, rolls, supplier_name) values ($1, '08-77', 160, 300, 20, 'AYA Global Tex')`,
    [colorId]
  );
  const issue = await db.query(
    `insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 5, 'Закройщик Иван') returning id`,
    [colorId]
  );
  const batch = await db.query(`insert into cutting_batches (issue_id, shop) values ($1, 'factory') returning id, batch_number`, [
    issue.rows[0].id,
  ]);
  const batchId = batch.rows[0].id;
  const product = await db.query(
    `insert into cutting_batch_products (batch_id, product_name) values ($1, 'Футболка') returning id`,
    [batchId]
  );
  await db.query(`insert into cutting_batch_items (batch_product_id, size, quantity) values ($1, 'M', 10)`, [
    product.rows[0].id,
  ]);

  // 1. Фото и с материалом, и с партией одновременно — оба поля независимы
  const both = await db.query(
    `insert into defect_photos (color_id, batch_id, photo_path) values ($1, $2, 'defects/both.jpg') returning id`,
    [colorId, batchId]
  );
  check('можно указать и материал, и партию сразу', !!both.rows[0].id);

  // 2. Только партия, без материала
  const onlyBatch = await db.query(
    `insert into defect_photos (batch_id, photo_path) values ($1, 'defects/batch-only.jpg') returning id`,
    [batchId]
  );
  check('можно указать только партию, без материала', !!onlyBatch.rows[0].id);

  // 3. Ничего не указано — по-прежнему работает
  const neither = await db.query(
    `insert into defect_photos (photo_path) values ('defects/neither.jpg') returning id`
  );
  check('можно не указывать ничего', !!neither.rows[0].id);

  // 4. view отдаёт batch_number там, где партия привязана, и null там, где нет
  const view = await db.query(`select id, batch_id, batch_number, material_name, color from defect_photos_view order by created_at`);
  const rowBoth = view.rows.find((r) => r.id === both.rows[0].id);
  const rowBatchOnly = view.rows.find((r) => r.id === onlyBatch.rows[0].id);
  const rowNeither = view.rows.find((r) => r.id === neither.rows[0].id);

  check('view: фото с обоими тегами отдаёт material_name/color и batch_number', rowBoth.material_name === 'Тестовая ткань' && rowBoth.color === 'Синий' && Number(rowBoth.batch_number) === Number(batch.rows[0].batch_number));
  check('view: фото только с партией отдаёт batch_number, но не материал', rowBatchOnly.batch_number != null && rowBatchOnly.material_name === null);
  check('view: фото без тегов отдаёт null и там, и там', rowNeither.batch_number === null && rowNeither.material_name === null);

  // 5. Разворачивание "по требованию" через существующие вьюхи работает
  const receipts = await db.query(`select * from raw_material_receipts_view where color_id = $1`, [colorId]);
  check('материал: raw_material_receipts_view отдаёт поставку с полными деталями', receipts.rows.length === 1 && receipts.rows[0].color_code === '08-77' && receipts.rows[0].supplier_name === 'AYA Global Tex');

  const batchDetail = await db.query(`select * from cutting_batches_view where id = $1`, [batchId]);
  check('партия: cutting_batches_view отдаёт товары/размеры', batchDetail.rows[0].products.length === 1 && batchDetail.rows[0].products[0].product_name === 'Футболка');

  // 6. Ссылка на несуществующую партию отклоняется (FK)
  let badBatchRejected = false;
  try {
    await db.query(`insert into defect_photos (batch_id, photo_path) values ('00000000-0000-0000-0000-000000000099', 'defects/bad.jpg')`);
  } catch (e) {
    badBatchRejected = true;
  }
  check('FK: несуществующий batch_id отклонён', badBatchRejected);

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
