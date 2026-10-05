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
  console.log('\n--- 028/029 применены, проверяю ---\n');

  // 1. Бакет: лимиты применились
  await db.query('reset role');
  await db.query(`update profiles set current_shop = 'factory' where id = $1`, [UIDS.master]);
  const bucket = await db.query(`select file_size_limit, allowed_mime_types from storage.buckets where id='defect-photos'`);
  check('бакет: file_size_limit = 100МБ', Number(bucket.rows[0].file_size_limit) === 104857600);
  check('бакет: allowed_mime_types содержит image/* и video/*', JSON.stringify(bucket.rows[0].allowed_mime_types) === JSON.stringify(['image/*', 'video/*']), JSON.stringify(bucket.rows[0].allowed_mime_types));

  await asUser(db, 'zakroyshik');

  // 2. Запись только с фото (старый сценарий) всё ещё работает
  const onlyPhoto = await db.query(`insert into defect_photos (photo_path) values ('defects/p1.jpg') returning id`);
  check('только фото — создаётся', !!onlyPhoto.rows[0].id);

  // 3. Запись только с видео
  const onlyVideo = await db.query(`insert into defect_photos (video_path) values ('defects/v1.mp4') returning id`);
  check('только видео — создаётся', !!onlyVideo.rows[0].id);

  // 4. Запись с обоими + весом
  const both = await db.query(`insert into defect_photos (photo_path, video_path, weight_kg) values ('defects/p2.jpg', 'defects/v2.mp4', 3.5) returning id`);
  check('фото + видео + вес — создаётся', !!both.rows[0].id);

  // 5. Запись без единого медиафайла отклонена
  let noMediaRejected = false;
  try {
    await db.query(`insert into defect_photos (weight_kg) values (2.0)`);
  } catch (e) {
    noMediaRejected = /defect_photos_has_media_check|check constraint/i.test(e.message);
  }
  check('запись без фото и без видео отклонена', noMediaRejected);

  // 6. Отрицательный вес отклонён
  let negWeightRejected = false;
  try {
    await db.query(`insert into defect_photos (photo_path, weight_kg) values ('defects/p3.jpg', -1)`);
  } catch (e) {
    negWeightRejected = true;
  }
  check('отрицательный вес брака отклонён', negWeightRejected);

  // 7. view отдаёт все новые поля
  const view = await db.query(`select * from defect_photos_view where id = $1`, [both.rows[0].id]);
  check('view: photo_path/video_path/weight_kg присутствуют', view.rows[0].photo_path === 'defects/p2.jpg' && view.rows[0].video_path === 'defects/v2.mp4' && Number(view.rows[0].weight_kg) === 3.5);

  // ---------------------------------------------------------------
  // 8. Каскадное удаление сотрудника
  // ---------------------------------------------------------------
  await asUser(db, 'master');
  const emp = await db.query(`insert into employees (name) values ('Удаляемый Сотрудник') returning id`);
  const empId = emp.rows[0].id;
  const profP = await db.query(`insert into professions (name) values ('Проф-029') returning id`);
  const modP = await db.query(`insert into catalog_models (profession_id, name) values ($1, 'Мод-029') returning id`, [profP.rows[0].id]);
  const op = await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Тест-операция', 5) returning id`, [modP.rows[0].id]);
  await db.query(`insert into work_records (employee_id, catalog_operation_id, quantity, date) values ($1, $2, 10, current_date)`, [empId, op.rows[0].id]);
  await db.query(`insert into work_records (employee_id, catalog_operation_id, quantity, date) values ($1, $2, 5, current_date)`, [empId, op.rows[0].id]);
  const today = new Date().toISOString().slice(0, 10);
  await db.query(`insert into attendance (employee_id, date) values ($1, $2)`, [empId, today]);

  const beforeWr = await db.query(`select count(*)::int as n from work_records where employee_id=$1`, [empId]);
  const beforeAtt = await db.query(`select count(*)::int as n from attendance where employee_id=$1`, [empId]);
  check('до удаления: 2 записи сделки', beforeWr.rows[0].n === 2);
  check('до удаления: 1 запись явки', beforeAtt.rows[0].n === 1);

  await db.query(`delete from employees where id=$1`, [empId]);

  const afterEmp = await db.query(`select count(*)::int as n from employees where id=$1`, [empId]);
  const afterWr = await db.query(`select count(*)::int as n from work_records where employee_id=$1`, [empId]);
  const afterAtt = await db.query(`select count(*)::int as n from attendance where employee_id=$1`, [empId]);
  check('после удаления: сотрудник исчез', afterEmp.rows[0].n === 0);
  check('после удаления: записи сделки исчезли каскадом', afterWr.rows[0].n === 0);
  check('после удаления: явка исчезла каскадом', afterAtt.rows[0].n === 0);

  // операция каталога НЕ должна пострадать (это справочник, не история сотрудника)
  const opStill = await db.query(`select count(*)::int as n from catalog_operations where id=$1`, [op.rows[0].id]);
  check('тип операции остался (это общий справочник, не история сотрудника)', opStill.rows[0].n === 1);

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.log('FATAL', e.message);
  process.exit(1);
});
