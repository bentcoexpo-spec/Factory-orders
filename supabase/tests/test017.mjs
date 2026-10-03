import { buildDb } from './build017.mjs';

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
  console.log('\n--- миграции 016 (переименована в zakroyshik) + 017 применены, проверяю ---\n');

  // 0. Переименование роли прошло насквозь
  const role = await db.query(`select role from profiles where email = 'test@example.test'`);
  check('роль называется zakroyshik', role.rows[0].role === 'zakroyshik');
  let oldRoleRejected = false;
  try {
    await db.query(`insert into profiles (id, email, role) values (gen_random_uuid(), 'x@x.test', 'sklad_syrya')`);
  } catch (e) {
    oldRoleRejected = true;
  }
  check('старое имя роли sklad_syrya больше не проходит CHECK', oldRoleRejected);

  // Готовим материал/цвет/приход/выдачу — на этом стоит вся цепочка "Партии"
  const m = await db.query(`insert into raw_materials (name) values ('Тестовая ткань') returning id`);
  const materialId = m.rows[0].id;
  const c = await db.query(`insert into raw_material_colors (material_id, color) values ($1, 'Синий') returning id`, [
    materialId,
  ]);
  const colorId = c.rows[0].id;
  await db.query(`insert into raw_material_receipts (color_id, rolls) values ($1, 20)`, [colorId]);

  const issue1 = await db.query(
    `insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 5, 'Закройщик Иван') returning id`,
    [colorId]
  );
  const issueId1 = issue1.rows[0].id;
  const issue2 = await db.query(
    `insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 3, 'Закройщик Иван') returning id`,
    [colorId]
  );
  const issueId2 = issue2.rows[0].id;

  // 1. Обе выдачи видны как "ожидающие отчёта"
  let pending = await db.query(`select id from raw_material_issues_pending_view order by created_at`);
  check('обе свежие выдачи в списке ожидающих', pending.rows.length === 2);

  // 2. Создаём партию по первой выдаче
  const batch1 = await db.query(`insert into cutting_batches (issue_id) values ($1) returning id, batch_number`, [
    issueId1,
  ]);
  const batchId1 = batch1.rows[0].id;
  check('batch_number присвоен автоматически', Number(batch1.rows[0].batch_number) >= 1);

  await db.query(
    `insert into cutting_batch_items (batch_id, size, quantity) values ($1, 'M', 10), ($1, 'L', 15)`,
    [batchId1]
  );

  // 3. После отчёта первая выдача пропадает из "ожидающих", вторая остаётся
  pending = await db.query(`select id from raw_material_issues_pending_view order by created_at`);
  check('после отчёта осталась только вторая выдача', pending.rows.length === 1 && pending.rows[0].id === issueId2);

  // 4. Повторный отчёт по той же выдаче отклоняется (unique issue_id + явная проверка в триггере)
  let dupBatchRejected = false;
  try {
    await db.query(`insert into cutting_batches (issue_id) values ($1)`, [issueId1]);
  } catch (e) {
    dupBatchRejected = /issue_already_reported|duplicate key/.test(e.message);
  }
  check('вторая партия по уже отчитанной выдаче отклонена', dupBatchRejected);

  // 5. Дубликат размера в одной партии отклонён (case-insensitive)
  let dupSizeRejected = false;
  try {
    await db.query(`insert into cutting_batch_items (batch_id, size, quantity) values ($1, 'm', 3)`, [batchId1]);
  } catch (e) {
    dupSizeRejected = true;
  }
  check('дубликат размера (без учёта регистра) в одной партии отклонён', dupSizeRejected);

  // 6. created_by проставлен
  const batchRow = await db.query(`select created_by from cutting_batches where id = $1`, [batchId1]);
  check('created_by партии проставлен из auth.uid()', batchRow.rows[0].created_by !== null);

  // 7. cutting_batches_view отдаёт агрегированный результат
  const view1 = await db.query(`select * from cutting_batches_view where id = $1`, [batchId1]);
  const row = view1.rows[0];
  check('view: материал/цвет из выдачи подтянуты', row.material_name === 'Тестовая ткань' && row.color === 'Синий');
  check('view: rolls_taken/taken_by из выдачи', Number(row.rolls_taken) === 5 && row.taken_by === 'Закройщик Иван');
  check('view: total_quantity = 25', Number(row.total_quantity) === 25);
  const sizes = row.sizes;
  check(
    'view: sizes содержит оба размера с правильным количеством',
    Array.isArray(sizes) &&
      sizes.length === 2 &&
      sizes.find((s) => s.size === 'M')?.quantity === 10 &&
      sizes.find((s) => s.size === 'L')?.quantity === 15
  );

  // 8. Партия без единого размера (0 позиций) — total_quantity = 0, sizes = []
  const batch2 = await db.query(`insert into cutting_batches (issue_id) values ($1) returning id`, [issueId2]);
  const view2 = await db.query(`select total_quantity, sizes from cutting_batches_view where id = $1`, [
    batch2.rows[0].id,
  ]);
  check('партия без размеров: total_quantity = 0', Number(view2.rows[0].total_quantity) === 0);
  check('партия без размеров: sizes = []', Array.isArray(view2.rows[0].sizes) && view2.rows[0].sizes.length === 0);

  // 9. Раскрой не трогает остаток сырья (списание было раньше, на "Взять для цеха")
  const stock = await db.query(`select stock_rolls from raw_material_colors where id = $1`, [colorId]);
  check('остаток сырья не менялся созданием партий (20 - 5 - 3 = 12)', Number(stock.rows[0].stock_rolls) === 12);

  // 10. Удаление партии по каскаду убирает её позиции (проверка FK on delete cascade)
  await db.query(`delete from cutting_batches where id = $1`, [batchId1]);
  const orphanItems = await db.query(`select count(*)::int as n from cutting_batch_items where batch_id = $1`, [
    batchId1,
  ]);
  check('удаление партии каскадно удаляет её позиции по размерам', orphanItems.rows[0].n === 0);
  pending = await db.query(`select id from raw_material_issues_pending_view where id = $1`, [issueId1]);
  check('после удаления партии выдача снова "ожидающая"', pending.rows.length === 1);

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
