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
  console.log('\n--- 030 применена, проверяю ---\n');

  await asUser(db, 'kladovshik');

  // 1. Кладовщик создаёт новый вариант (опечатка) и сразу его удаляет —
  //    остаток 0, ни прихода, ни заказов -> должно пройти.
  const v1 = await db.query(
    `insert into product_variants_view (product_name, color, size, stock_quantity) values ('Тест-товар-030', 'ОпечаткаЦвет', 'M', 0) returning id`
  );
  const v1Id = v1.rows[0].id;
  let deleteOkNoHistory = false;
  try {
    await db.query(`delete from product_variants_view where id = $1`, [v1Id]);
    const check1 = await db.query(`select count(*)::int as n from product_variants where id = $1`, [v1Id]);
    deleteOkNoHistory = check1.rows[0].n === 0;
  } catch (e) {
    deleteOkNoHistory = false;
  }
  check('кладовщик может удалить вариант без истории и с остатком 0', deleteOkNoHistory);

  // 2. Вариант с ненулевым остатком (создан сразу с остатком, без прихода) — нельзя.
  const v2 = await db.query(
    `insert into product_variants_view (product_name, color, size, stock_quantity) values ('Тест-товар-030', 'ЦветСОстатком', 'L', 25) returning id`
  );
  const v2Id = v2.rows[0].id;
  let stockBlockRejected = false;
  try {
    await db.query(`delete from product_variants_view where id = $1`, [v2Id]);
  } catch (e) {
    stockBlockRejected = /variant_has_stock/.test(e.message);
  }
  check('вариант с ненулевым остатком (без единого прихода!) удалить нельзя', stockBlockRejected);
  await asUser(db, 'ceo');
  const stillExists2 = await db.query(`select count(*)::int as n from product_variants where id = $1`, [v2Id]);
  check('...и он действительно остался в базе', stillExists2.rows[0].n === 1);
  await asUser(db, 'kladovshik');

  // 3. Вариант с приходом (stock_receipts), но остаток уже 0 (весь ушёл) — нельзя.
  const v3 = await db.query(
    `insert into product_variants_view (product_name, color, size, stock_quantity) values ('Тест-товар-030', 'ЦветСПриходом', 'S', 0) returning id`
  );
  const v3Id = v3.rows[0].id;
  await db.query(`insert into stock_receipts (variant_id, packs, units_per_pack, loose_units) values ($1, 0, 0, 10)`, [v3Id]);
  await db.query(`update product_variants_view set stock_quantity = 0 where id = $1`, [v3Id]);
  let receiptBlockRejected = false;
  try {
    await db.query(`delete from product_variants_view where id = $1`, [v3Id]);
  } catch (e) {
    receiptBlockRejected = /variant_has_receipts/.test(e.message);
  }
  check('вариант с приходом в истории (даже если остаток сейчас 0) удалить нельзя', receiptBlockRejected);

  // 4. Вариант, участвовавший в заказе — нельзя, даже с нулевым остатком.
  const v4 = await db.query(
    `insert into product_variants_view (product_name, color, size, stock_quantity) values ('Тест-товар-030', 'ЦветВЗаказе', 'XL', 0) returning id`
  );
  const v4Id = v4.rows[0].id;
  const client = await db.query(
    `insert into clients_view (name, phone) values ('Тест-клиент-030', '+998900000001') returning id`
  );
  const orderId = await db.query(`select create_order($1, null, $2) as id`, [
    client.rows[0].id,
    JSON.stringify([{ variant_id: v4Id, quantity: 1 }]),
  ]);
  let orderBlockRejected = false;
  try {
    await db.query(`delete from product_variants_view where id = $1`, [v4Id]);
  } catch (e) {
    orderBlockRejected = /variant_has_orders/.test(e.message);
  }
  check('вариант, участвовавший в заказе, удалить нельзя', orderBlockRejected);

  // 5. CEO по-прежнему может удалить что угодно, включая варианты с историей.
  await asUser(db, 'ceo');
  let ceoDeleteWithHistoryWorked = false;
  try {
    const vCeo = await db.query(
      `insert into product_variants_view (product_name, color, size, stock_quantity) values ('Тест-товар-030', 'CeoЦвет', 'M', 999) returning id`
    );
    await db.query(`delete from product_variants_view where id = $1`, [vCeo.rows[0].id]);
    const stillExists = await db.query(`select count(*)::int as n from product_variants where id = $1`, [vCeo.rows[0].id]);
    ceoDeleteWithHistoryWorked = stillExists.rows[0].n === 0;
  } catch (e) {
    ceoDeleteWithHistoryWorked = false;
  }
  check('CEO по-прежнему может удалить вариант без ограничений (даже с ненулевым остатком)', ceoDeleteWithHistoryWorked);

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.log('FATAL', e.message);
  process.exit(1);
});
