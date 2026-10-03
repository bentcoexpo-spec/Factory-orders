import { newDb, applyMigrations, seedTestUser, TEST_UID } from './build019.mjs';

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  ПРОВАЛ:', name);
  }
}

async function setupMaterial(db) {
  const m = await db.query(`insert into raw_materials (name) values ('Тестовая ткань') returning id`);
  const materialId = m.rows[0].id;
  const c = await db.query(`insert into raw_material_colors (material_id, color) values ($1, 'Синий') returning id`, [
    materialId,
  ]);
  const colorId = c.rows[0].id;
  await db.query(`insert into raw_material_receipts (color_id, rolls) values ($1, 20)`, [colorId]);
  return { materialId, colorId };
}

async function testLegacyBackfill() {
  console.log('\n=== Сценарий A: бэкафилл старых партий (созданных до 018) ===\n');
  const db = await newDb();
  await applyMigrations(db, { upTo: '017_cutting_batches.sql', log: false });
  await seedTestUser(db);

  const { colorId } = await setupMaterial(db);
  const issue = await db.query(
    `insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 5, 'Закройщик Иван') returning id`,
    [colorId]
  );
  const issueId = issue.rows[0].id;
  const batch = await db.query(`insert into cutting_batches (issue_id) values ($1) returning id`, [issueId]);
  const batchId = batch.rows[0].id;
  // Старая схема: cutting_batch_items ссылается на batch_id напрямую.
  await db.query(`insert into cutting_batch_items (batch_id, size, quantity) values ($1, 'M', 10), ($1, 'L', 5)`, [
    batchId,
  ]);

  await applyMigrations(db, { from: '018_cutting_batch_products.sql', upTo: '019_defect_photos.sql', log: false });

  const product = await db.query(`select id, product_name from cutting_batch_products where batch_id = $1`, [
    batchId,
  ]);
  check('старая партия получила ровно один товар-заглушку', product.rows.length === 1);
  check('товар-заглушка называется "Без названия"', product.rows[0]?.product_name === 'Без названия');

  const items = await db.query(`select batch_product_id, size, quantity from cutting_batch_items where batch_product_id = $1`, [
    product.rows[0]?.id,
  ]);
  check('обе старые позиции перевешены на товар-заглушку', items.rows.length === 2);

  const hasBatchIdColumn = await db.query(
    `select 1 from information_schema.columns where table_name = 'cutting_batch_items' and column_name = 'batch_id'`
  );
  check('старая колонка batch_id убрана из cutting_batch_items', hasBatchIdColumn.rows.length === 0);

  const view = await db.query(`select products, total_quantity from cutting_batches_view where id = $1`, [batchId]);
  check('view: total_quantity старой партии = 15', Number(view.rows[0].total_quantity) === 15);
  check(
    'view: products содержит один товар с обоими размерами',
    view.rows[0].products.length === 1 &&
      view.rows[0].products[0].product_name === 'Без названия' &&
      view.rows[0].products[0].sizes.length === 2
  );
}

async function testMultiProductBatch() {
  console.log('\n=== Сценарий B: новая партия с несколькими товарами ===\n');
  const db = await newDb();
  await applyMigrations(db, { log: true });
  await seedTestUser(db);

  const { colorId } = await setupMaterial(db);
  const issue = await db.query(
    `insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 8, 'Закройщик Иван') returning id`,
    [colorId]
  );
  const issueId = issue.rows[0].id;

  const batch = await db.query(`insert into cutting_batches (issue_id, shop) values ($1, 'factory') returning id, batch_number`, [
    issueId,
  ]);
  const batchId = batch.rows[0].id;
  check('batch_number присвоен', Number(batch.rows[0].batch_number) >= 1);

  const p1 = await db.query(
    `insert into cutting_batch_products (batch_id, product_name) values ($1, 'Футболка') returning id`,
    [batchId]
  );
  const p2 = await db.query(
    `insert into cutting_batch_products (batch_id, product_name) values ($1, 'Футболка длинный рукав') returning id`,
    [batchId]
  );

  await db.query(`insert into cutting_batch_items (batch_product_id, size, quantity) values ($1, 'M', 10), ($1, 'L', 15)`, [
    p1.rows[0].id,
  ]);
  await db.query(`insert into cutting_batch_items (batch_product_id, size, quantity) values ($1, 'M', 7)`, [
    p2.rows[0].id,
  ]);

  let dupProductRejected = false;
  try {
    await db.query(`insert into cutting_batch_products (batch_id, product_name) values ($1, 'футболка')`, [batchId]);
  } catch (e) {
    dupProductRejected = true;
  }
  check('дубликат названия товара (без учёта регистра) в одной партии отклонён', dupProductRejected);

  const view = await db.query(`select * from cutting_batches_view where id = $1`, [batchId]);
  const row = view.rows[0];
  check('view: total_quantity по всей партии = 32', Number(row.total_quantity) === 32);
  check('view: два товара в products', row.products.length === 2);
  const shirt = row.products.find((p) => p.product_name === 'Футболка');
  const longSleeve = row.products.find((p) => p.product_name === 'Футболка длинный рукав');
  check('view: подытог "Футболка" = 25', Number(shirt?.total_quantity) === 25);
  check('view: подытог "Футболка длинный рукав" = 7', Number(longSleeve?.total_quantity) === 7);
  check(
    'view: размеры "Футболки" верны',
    shirt.sizes.find((s) => s.size === 'M')?.quantity === 10 && shirt.sizes.find((s) => s.size === 'L')?.quantity === 15
  );

  // Удаление одного товара не должно затрагивать другой (cascade только внутри своей ветки)
  await db.query(`delete from cutting_batch_products where id = $1`, [p2.rows[0].id]);
  const afterDelete = await db.query(`select products from cutting_batches_view where id = $1`, [batchId]);
  check('после удаления одного товара остался только второй', afterDelete.rows[0].products.length === 1);
  const orphanItems = await db.query(`select count(*)::int as n from cutting_batch_items where batch_product_id = $1`, [
    p2.rows[0].id,
  ]);
  check('позиции удалённого товара удалены каскадом', orphanItems.rows[0].n === 0);
}

async function testDefectPhotos() {
  console.log('\n=== Сценарий C: "Брак" — таблица и вьюха ===\n');
  const db = await newDb();
  await applyMigrations(db, { log: false });
  await seedTestUser(db);

  const bucket = await db.query(`select public from storage.buckets where id = 'defect-photos'`);
  check('бакет defect-photos создан', bucket.rows.length === 1);
  check('бакет приватный (public = false)', bucket.rows[0].public === false);

  const { colorId } = await setupMaterial(db);

  const withColor = await db.query(
    `insert into defect_photos (color_id, photo_path) values ($1, 'defects/1.jpg') returning id, created_by, created_at`,
    [colorId]
  );
  check('created_by проставлен автоматически', withColor.rows[0].created_by === TEST_UID);
  check('created_at проставлен автоматически', !!withColor.rows[0].created_at);

  const withoutColor = await db.query(
    `insert into defect_photos (photo_path) values ('defects/2.jpg') returning id`
  );

  const view = await db.query(`select * from defect_photos_view order by created_at`);
  check('оба фото видны во вьюхе', view.rows.length === 2);
  const rowWithColor = view.rows.find((r) => r.id === withColor.rows[0].id);
  const rowWithoutColor = view.rows.find((r) => r.id === withoutColor.rows[0].id);
  check(
    'фото с привязкой отдаёт материал/цвет',
    rowWithColor.material_name === 'Тестовая ткань' && rowWithColor.color === 'Синий'
  );
  check(
    'фото без привязки отдаёт null вместо материала/цвета (не падает)',
    rowWithoutColor.material_name === null && rowWithoutColor.color === null
  );

  await db.query(`delete from defect_photos where id = $1`, [withColor.rows[0].id]);
  const afterDelete = await db.query(`select count(*)::int as n from defect_photos`);
  check('удаление записи о браке работает', afterDelete.rows[0].n === 1);
}

async function main() {
  await testLegacyBackfill();
  await testMultiProductBatch();
  await testDefectPhotos();
  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
