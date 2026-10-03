import { buildDb, asUser, UIDS } from './build_master.mjs';

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
  console.log('\n--- 031 применена, проверяю ---\n');

  await asUser(db, 'zakroyshik');
  const mat = await db.query(`insert into raw_materials (name) values ('Тест-ткань-031') returning id`);
  const color = await db.query(
    `insert into raw_material_colors (material_id, color) values ($1, 'Синий') returning id`,
    [mat.rows[0].id]
  );
  await db.query(`insert into raw_material_receipts (color_id, rolls) values ($1, 100)`, [color.rows[0].id]);

  async function makeBatch(shop) {
    const issue = await db.query(
      `insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 1, 'тест') returning id`,
      [color.rows[0].id]
    );
    const res = await db.query(
      `select * from create_cutting_batch($1, $2, $3)`,
      [issue.rows[0].id, JSON.stringify([{ product_name: 'Футболка', sizes: [{ size: 'M', quantity: 5 }] }]), shop]
    );
    return res.rows[0].out_batch_id;
  }

  const factoryBatchId = await makeBatch('factory');
  const workshopBatchId = await makeBatch('workshop');

  let invalidShopRejected = false;
  try {
    const issue = await db.query(
      `insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 1, 'тест') returning id`,
      [color.rows[0].id]
    );
    await db.query(`select * from create_cutting_batch($1, $2, $3)`, [
      issue.rows[0].id,
      JSON.stringify([{ product_name: 'X', sizes: [{ size: 'M', quantity: 1 }] }]),
      'moon_base',
    ]);
  } catch (e) {
    invalidShopRejected = /invalid_shop/.test(e.message);
  }
  check('create_cutting_batch отклоняет неизвестный цех', invalidShopRejected);

  await asUser(db, 'master');
  const noShopEmployees = await db.query(`select count(*)::int as n from employees`);
  check('мастер без выбранного цеха не видит сотрудников', noShopEmployees.rows[0].n === 0);
  const noShopBatches = await db.query(`select count(*)::int as n from cutting_batches_view`);
  check('мастер без выбранного цеха не видит партий (через view)', noShopBatches.rows[0].n === 0);

  await db.query(`select set_my_shop('factory')`);
  const emp1 = await db.query(`insert into employees (name, shop) values ('Иванов-031', 'factory') returning id`);
  check('мастер может завести сотрудника в своём цехе', !!emp1.rows[0]?.id);

  let wrongShopEmployeeRejected = false;
  try {
    await db.query(`insert into employees (name, shop) values ('Чужой-031', 'workshop')`);
  } catch (e) {
    wrongShopEmployeeRejected = true;
  }
  check('мастер НЕ может завести сотрудника в чужом цехе', wrongShopEmployeeRejected);

  const factoryEmployees = await db.query(`select count(*)::int as n from employees where name = 'Иванов-031'`);
  check('...и видит только что заведённого сотрудника своего цеха', factoryEmployees.rows[0].n === 1);

  const batchesVisibleFactory = await db.query(`select id from cutting_batches_view`);
  check(
    'мастер "Фабрики" видит через VIEW только фабричную партию',
    batchesVisibleFactory.rows.length === 1 && batchesVisibleFactory.rows[0].id === factoryBatchId
  );

  const attendanceOk = await db.query(
    `insert into attendance (employee_id, date) values ($1, current_date) returning id`,
    [emp1.rows[0].id]
  );
  check('мастер может отметить явку своему сотруднику', !!attendanceOk.rows[0]?.id);

  const opType = await db.query(
    `insert into operation_types (name, rate_per_piece) values ('Оверлок-031', 100) returning id`
  );
  const workRecordOk = await db.query(
    `insert into work_records (employee_id, operation_type_id, quantity) values ($1, $2, 3) returning id`,
    [emp1.rows[0].id, opType.rows[0].id]
  );
  check('мастер может завести сделку своему сотруднику', !!workRecordOk.rows[0]?.id);

  const attendanceViaView = await db.query(`select count(*)::int as n from attendance_view`);
  check('мастер "Фабрики" видит явку через attendance_view (1 запись)', attendanceViaView.rows[0].n === 1);
  const workRecordsViaView = await db.query(`select count(*)::int as n from work_records_view`);
  check('мастер "Фабрики" видит сделку через work_records_view (1 запись)', workRecordsViaView.rows[0].n === 1);

  await db.query(`select set_my_shop('workshop')`);
  const workshopEmployees = await db.query(`select count(*)::int as n from employees`);
  check('после переключения на "Цех" мастер не видит сотрудника "Фабрики"', workshopEmployees.rows[0].n === 0);

  const batchesVisibleWorkshop = await db.query(`select id from cutting_batches_view`);
  check(
    'мастер "Цеха" видит через VIEW только партию своего цеха',
    batchesVisibleWorkshop.rows.length === 1 && batchesVisibleWorkshop.rows[0].id === workshopBatchId
  );

  const attendanceViaViewWorkshop = await db.query(`select count(*)::int as n from attendance_view`);
  check('мастер "Цеха" НЕ видит явку сотрудника "Фабрики" через attendance_view', attendanceViaViewWorkshop.rows[0].n === 0);
  const workRecordsViaViewWorkshop = await db.query(`select count(*)::int as n from work_records_view`);
  check('мастер "Цеха" НЕ видит сделку сотрудника "Фабрики" через work_records_view', workRecordsViaViewWorkshop.rows[0].n === 0);

  await db.query(`update employees set name = 'Хакнуто' where id = $1`, [emp1.rows[0].id]);
  await asUser(db, 'ceo');
  const stillOriginalName = await db.query(`select name from employees where id = $1`, [emp1.rows[0].id]);
  check('...имя сотрудника "Фабрики" не изменилось (проверено от лица CEO)', stillOriginalName.rows[0]?.name === 'Иванов-031');
  await asUser(db, 'master');

  await asUser(db, 'zakroyshik');
  let zakroyshikSetShopRejected = false;
  try {
    await db.query(`select set_my_shop('factory')`);
  } catch (e) {
    zakroyshikSetShopRejected = /insufficient_privilege/.test(e.message);
  }
  check('закройщик не может звать set_my_shop', zakroyshikSetShopRejected);

  await asUser(db, 'ceo');
  const ceoBatches = await db.query(`select shop from cutting_batches_view where id in ($1, $2)`, [
    factoryBatchId,
    workshopBatchId,
  ]);
  check('CEO видит обе партии (обоих цехов) сразу через view', ceoBatches.rows.length === 2);
  const ceoEmployees = await db.query(`select count(*)::int as n from employees where name = 'Иванов-031'`);
  check('CEO видит сотрудника любого цеха', ceoEmployees.rows[0].n === 1);

  const workshopItem = await db.query(
    `select cbi.id from cutting_batch_items cbi
     join cutting_batch_products cbp on cbp.id = cbi.batch_product_id
     where cbp.batch_id = $1 limit 1`,
    [workshopBatchId]
  );
  await asUser(db, 'master');
  await db.query(`select set_my_shop('factory')`);
  // С security_invoker=true на cutting_batch_items_view RLS теперь сам
  // не даёт мастеру "Фабрики" увидеть строку из "Цеха" — UPDATE просто
  // не находит, что менять (0 строк, без исключения; INSTEAD OF-триггер
  // не срабатывает вовсе). Раньше (без invoker) защищала только ручная
  // проверка внутри триггера — теперь защищает и RLS тоже, двойная
  // страховка. Проверяем результат, а не факт исключения.
  await db.query(`update cutting_batch_items_view set confirmed_quantity = 999 where id = $1`, [
    workshopItem.rows[0].id,
  ]);
  await asUser(db, 'ceo');
  const workshopItemAfter = await db.query(`select confirmed_quantity from cutting_batch_items where id = $1`, [
    workshopItem.rows[0].id,
  ]);
  check(
    'мастер "Фабрики" не смог подтвердить размер партии "Цеха" — значение не изменилось',
    workshopItemAfter.rows[0].confirmed_quantity === null,
    workshopItemAfter.rows[0].confirmed_quantity
  );
  await asUser(db, 'master');

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.log('FATAL', e.message);
  process.exit(1);
});
