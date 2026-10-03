import { buildDb, asUser, UIDS } from './build_master.mjs';

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
  console.log('\n--- миграции 021-025 применены, проверяю ---\n');

  await db.query('reset role');
  await db.query(`update profiles set current_shop = 'factory' where id = $1`, [UIDS.master]);
  // Роль
  const roleRow = await db.query(`select role from profiles where id = $1`, [UIDS.master]);
  check('роль master назначена', roleRow.rows[0].role === 'master');
  let badRoleRejected = false;
  try {
    await db.query(`insert into profiles (id, email, role) values (gen_random_uuid(), 'x@x.test', 'foreman')`);
  } catch (e) {
    badRoleRejected = true;
  }
  check('CHECK отклоняет произвольную роль', badRoleRejected);

  // --- Готовим партию как закройщик (уже существующий поток) ---
  await asUser(db, 'zakroyshik');
  const m = await db.query(`insert into raw_materials (name) values ('Тестовая ткань') returning id`);
  const c = await db.query(`insert into raw_material_colors (material_id, color) values ($1, 'Синий') returning id`, [
    m.rows[0].id,
  ]);
  await db.query(`insert into raw_material_receipts (color_id, rolls) values ($1, 20)`, [c.rows[0].id]);
  const issue = await db.query(
    `insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 5, 'Закройщик Иван') returning id`,
    [c.rows[0].id]
  );
  const batch = await db.query(`insert into cutting_batches (issue_id, shop) values ($1, 'factory') returning id, batch_number`, [
    issue.rows[0].id,
  ]);
  const batchId = batch.rows[0].id;
  const product = await db.query(
    `insert into cutting_batch_products (batch_id, product_name) values ($1, 'Футболка') returning id`,
    [batchId]
  );
  const itemM = await db.query(
    `insert into cutting_batch_items (batch_product_id, size, quantity) values ($1, 'M', 10) returning id`,
    [product.rows[0].id]
  );
  const itemL = await db.query(
    `insert into cutting_batch_items (batch_product_id, size, quantity) values ($1, 'L', 15) returning id`,
    [product.rows[0].id]
  );

  // --- Мастер: приёмка кроя ---
  await asUser(db, 'master');

  const viewAsMaster = await db.query(`select * from cutting_batches_view where id = $1`, [batchId]);
  check('мастер видит партию через cutting_batches_view (джойны читаемы)', viewAsMaster.rows.length === 1);
  check('статус только что созданной партии = cut', viewAsMaster.rows[0].status === 'cut');

  // Попытка перескочить сразу в "sewn" — запрещена
  let skipRejected = false;
  try {
    await db.query(`update cutting_batches set status = 'sewn' where id = $1`, [batchId]);
  } catch (e) {
    skipRejected = /invalid_status_transition/.test(e.message);
  }
  check('переход cut -> sewn напрямую отклонён', skipRejected);

  // Переход в in_sewing без подтверждения размеров — запрещён
  let earlyRejected = false;
  try {
    await db.query(`update cutting_batches set status = 'in_sewing' where id = $1`, [batchId]);
  } catch (e) {
    earlyRejected = /not_all_sizes_confirmed/.test(e.message);
  }
  check('переход cut -> in_sewing без подтверждения размеров отклонён', earlyRejected);

  // Мастер не может поменять size/quantity через view
  let tamperRejected = false;
  try {
    await db.query(`update cutting_batch_items_view set quantity = 999, confirmed_quantity = 10 where id = $1`, [
      itemM.rows[0].id,
    ]);
  } catch (e) {
    tamperRejected = /insufficient_privilege/.test(e.message);
  }
  check('мастер не может поменять заявленное quantity через view', tamperRejected);
  const unchanged = await db.query(`select quantity, confirmed_quantity from cutting_batch_items where id = $1`, [
    itemM.rows[0].id,
  ]);
  check('quantity осталось прежним после отклонённой попытки', Number(unchanged.rows[0].quantity) === 10);
  check('confirmed_quantity не проставился при отклонённой попытке', unchanged.rows[0].confirmed_quantity === null);

  // Подтверждаем "как есть" одну строку, с расхождением — другую
  await db.query(`update cutting_batch_items_view set confirmed_quantity = 10 where id = $1`, [itemM.rows[0].id]);
  await db.query(`update cutting_batch_items_view set confirmed_quantity = 13 where id = $1`, [itemL.rows[0].id]);

  const afterConfirm = await db.query(`select size, quantity, confirmed_quantity from cutting_batch_items where batch_product_id = $1 order by size`, [product.rows[0].id]);
  check('L подтверждено с расхождением (15 заявлено, 13 подтверждено)', Number(afterConfirm.rows[0].confirmed_quantity) === 13 && Number(afterConfirm.rows[0].quantity) === 15);

  // Теперь переход cut -> in_sewing должен пройти
  const confirmed = await db.query(`update cutting_batches set status = 'in_sewing' where id = $1 returning status, confirmed_by, confirmed_at`, [batchId]);
  check('переход cut -> in_sewing прошёл', confirmed.rows[0].status === 'in_sewing');
  check('confirmed_by проставлен', confirmed.rows[0].confirmed_by === UIDS.master);
  check('confirmed_at проставлен', !!confirmed.rows[0].confirmed_at);

  // Повторное "no-op" обновление (тот же статус) отклоняется
  let noopRejected = false;
  try {
    await db.query(`update cutting_batches set status = 'in_sewing' where id = $1`, [batchId]);
  } catch (e) {
    noopRejected = /no_status_change/.test(e.message);
  }
  check('повторное обновление тем же статусом отклонено', noopRejected);

  // --- Отчёт о готовом ---
  let earlySewnRejected = false;
  try {
    await db.query(`update cutting_batches set status = 'sewn' where id = $1`, [batchId]);
  } catch (e) {
    earlySewnRejected = /not_all_sizes_sewn/.test(e.message);
  }
  check('переход in_sewing -> sewn без sewn_quantity отклонён', earlySewnRejected);

  await db.query(`update cutting_batch_items_view set sewn_quantity = 9, sewn_defect_quantity = 1 where id = $1`, [
    itemM.rows[0].id,
  ]);
  await db.query(`update cutting_batch_items_view set sewn_quantity = 13, sewn_defect_quantity = 0 where id = $1`, [
    itemL.rows[0].id,
  ]);

  const sewn = await db.query(`update cutting_batches set status = 'sewn' where id = $1 returning status, sewn_by, sewn_at`, [batchId]);
  check('переход in_sewing -> sewn прошёл', sewn.rows[0].status === 'sewn');
  check('sewn_by проставлен', sewn.rows[0].sewn_by === UIDS.master);

  const finalView = await db.query(`select products from cutting_batches_view where id = $1`, [batchId]);
  const sizes = finalView.rows[0].products[0].sizes;
  const sizeM = sizes.find((s) => s.size === 'M');
  check(
    'view: у размера M видны quantity/confirmed_quantity/sewn_quantity/sewn_defect_quantity',
    Number(sizeM.quantity) === 10 && Number(sizeM.confirmed_quantity) === 10 && Number(sizeM.sewn_quantity) === 9 && Number(sizeM.sewn_defect_quantity) === 1
  );

  // Фото брака от мастера, привязанное к партии
  const photo = await db.query(
    `insert into defect_photos (batch_id, color_id, photo_path) values ($1, $2, 'defects/master1.jpg') returning id, created_by`,
    [batchId, c.rows[0].id]
  );
  check('мастер может прикрепить фото брака к партии', photo.rows[0].created_by === UIDS.master);

  // --- Табель ---
  const emp1 = await db.query(`insert into employees (name) values ('Иван Петров') returning id`);
  let dupEmployeeRejected = false;
  try {
    await db.query(`insert into employees (name) values ('иван петров')`);
  } catch (e) {
    dupEmployeeRejected = true;
  }
  check('дубликат имени сотрудника (без учёта регистра) отклонён', dupEmployeeRejected);

  const today = new Date().toISOString().slice(0, 10);
  const att = await db.query(`insert into attendance (employee_id, date) values ($1, $2) returning marked_by`, [
    emp1.rows[0].id,
    today,
  ]);
  check('marked_by проставлен автоматически', att.rows[0].marked_by === UIDS.master);

  let dupAttendanceRejected = false;
  try {
    await db.query(`insert into attendance (employee_id, date) values ($1, $2)`, [emp1.rows[0].id, today]);
  } catch (e) {
    dupAttendanceRejected = true;
  }
  check('вторая отметка того же сотрудника в тот же день отклонена', dupAttendanceRejected);

  await db.query(`delete from attendance where employee_id = $1 and date = $2`, [emp1.rows[0].id, today]);
  const afterUnmark = await db.query(`select count(*)::int as n from attendance where employee_id = $1 and date = $2`, [
    emp1.rows[0].id,
    today,
  ]);
  check('"не пришёл" удаляет строку явки', afterUnmark.rows[0].n === 0);

  const attView = await db.query(`insert into attendance (employee_id, date) values ($1, $2) returning id`, [
    emp1.rows[0].id,
    today,
  ]).then(() => db.query(`select * from attendance_view where employee_id = $1`, [emp1.rows[0].id]));
  check('attendance_view отдаёт имя сотрудника', attView.rows[0].employee_name === 'Иван Петров');

  // --- Сделка ---
  const op1 = await db.query(`insert into operation_types (name, rate_per_piece) values ('Оверлок', 15.5) returning id`);
  let dupOpRejected = false;
  try {
    await db.query(`insert into operation_types (name, rate_per_piece) values ('оверлок', 5)`);
  } catch (e) {
    dupOpRejected = true;
  }
  check('дубликат названия операции (без учёта регистра) отклонён', dupOpRejected);

  await db.query(`update operation_types set rate_per_piece = 20 where id = $1`, [op1.rows[0].id]);
  const rateCheck = await db.query(`select rate_per_piece from operation_types where id = $1`, [op1.rows[0].id]);
  check('ставку можно поменять', Number(rateCheck.rows[0].rate_per_piece) === 20);

  const wr1 = await db.query(
    `insert into work_records (employee_id, operation_type_id, quantity, date) values ($1, $2, 30, $3) returning id, created_by`,
    [emp1.rows[0].id, op1.rows[0].id, today]
  );
  check('created_by у записи работы проставлен', wr1.rows[0].created_by === UIDS.master);

  // Тот же сотрудник, другая операция, тот же день — разрешено
  const op2 = await db.query(`insert into operation_types (name, rate_per_piece) values ('Утюжка', 5) returning id`);
  await db.query(`insert into work_records (employee_id, operation_type_id, quantity, date, batch_id) values ($1, $2, 12, $3, $4)`, [
    emp1.rows[0].id,
    op2.rows[0].id,
    today,
    batchId,
  ]);

  const dayRecords = await db.query(`select * from work_records_view where employee_id = $1 and date = $2 order by created_at`, [
    emp1.rows[0].id,
    today,
  ]);
  check('у сотрудника две записи за день с разными операциями', dayRecords.rows.length === 2);
  check('line_total первой записи = 30 * 20 = 600', Number(dayRecords.rows[0].line_total) === 600);
  check('line_total второй записи = 12 * 5 = 60', Number(dayRecords.rows[1].line_total) === 60);
  check('вторая запись отдаёт номер привязанной партии', Number(dayRecords.rows[1].batch_number) === Number(batch.rows[0].batch_number));

  const dayTotal = dayRecords.rows.reduce((sum, r) => sum + Number(r.line_total), 0);
  check('дневной итог сотрудника = 660', dayTotal === 660);

  let zeroQtyRejected = false;
  try {
    await db.query(`insert into work_records (employee_id, operation_type_id, quantity, date) values ($1, $2, 0, $3)`, [
      emp1.rows[0].id,
      op1.rows[0].id,
      today,
    ]);
  } catch (e) {
    zeroQtyRejected = true;
  }
  check('запись с quantity = 0 отклонена', zeroQtyRejected);

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
