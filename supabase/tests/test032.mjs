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
  console.log('\n--- 032 применена, проверяю ---\n');

  await asUser(db, 'kladovshik');

  const variant = await db.query(
    `insert into product_variants_view (product_name, color, size, stock_quantity) values ('Тест-товар-032', 'Синий', 'M', 50) returning id`
  );
  const variantId = variant.rows[0].id;

  const client = await db.query(
    `insert into clients_view (name, phone) values ('Тест-клиент-032', '+998900000002') returning id`
  );

  async function makeOrder() {
    const res = await db.query(`select create_order($1, null, $2) as id`, [
      client.rows[0].id,
      JSON.stringify([{ variant_id: variantId, quantity: 5 }]),
    ]);
    return res.rows[0].id;
  }

  // 1. Возврат из статуса "new" (ещё не выдан) запрещён.
  const freshOrderId = await makeOrder();
  let earlyReturnRejected = false;
  try {
    await db.query(`update orders_view set status = 'returned' where id = $1`, [freshOrderId]);
  } catch (e) {
    earlyReturnRejected = /can_only_return_issued/.test(e.message);
  }
  check('нельзя вернуть заказ, который ещё не выдан', earlyReturnRejected);

  // 2. Обычный путь: new -> issued (списывает остаток) -> returned
  //    (возвращает остаток).
  const orderId = await makeOrder();
  await db.query(`update orders_view set status = 'issued' where id = $1`, [orderId]);
  const stockAfterIssue = await db.query(`select stock_quantity from product_variants_view where id = $1`, [variantId]);
  check('остаток списан при выдаче', Number(stockAfterIssue.rows[0].stock_quantity) === 45, stockAfterIssue.rows[0].stock_quantity);

  await db.query(`update orders_view set status = 'returned' where id = $1`, [orderId]);
  const stockAfterReturn = await db.query(`select stock_quantity from product_variants_view where id = $1`, [variantId]);
  check(
    'остаток вернулся на склад после возврата',
    Number(stockAfterReturn.rows[0].stock_quantity) === 50,
    stockAfterReturn.rows[0].stock_quantity
  );

  const asKladovshik = await db.query(`select status, stock_deducted, returned_at, returned_by_email from orders_view where id = $1`, [
    orderId,
  ]);
  check('статус стал "returned"', asKladovshik.rows[0].status === 'returned');
  check('stock_deducted сброшен в false', asKladovshik.rows[0].stock_deducted === false);
  check('кладовщик НЕ видит returned_at', asKladovshik.rows[0].returned_at === null);
  check('кладовщик НЕ видит returned_by_email', asKladovshik.rows[0].returned_by_email === null);

  // 3. Кладовщик больше не видит этот заказ как активную выдачу.
  const kladIssuedList = await db.query(`select id from orders_view where status = 'issued'`);
  check(
    'возвращённого заказа нет среди "issued" у кладовщика',
    !kladIssuedList.rows.some((r) => r.id === orderId)
  );

  // 4. Повторный возврат уже возвращённого заказа запрещён (защита от
  //    двойного клика / гонки).
  let doubleReturnRejected = false;
  try {
    await db.query(`update orders_view set status = 'returned' where id = $1`, [orderId]);
  } catch (e) {
    doubleReturnRejected = /can_only_return_issued/.test(e.message);
  }
  check('повторный возврат уже возвращённого заказа запрещён', doubleReturnRejected);

  // 5. CEO видит returned_at/returned_by_email и заказ в объединённом
  //    списке issued+returned.
  await asUser(db, 'ceo');
  const asCeo = await db.query(`select status, returned_at, returned_by_email from orders_view where id = $1`, [orderId]);
  check('CEO видит returned_at', asCeo.rows[0].returned_at !== null);
  check('CEO видит returned_by_email', asCeo.rows[0].returned_by_email === 'kladovshik@test.test');

  const ceoIssuedOrReturned = await db.query(`select id from orders_view where status in ('issued', 'returned')`);
  check(
    'CEO видит возвращённый заказ в объединённом списке issued+returned',
    ceoIssuedOrReturned.rows.some((r) => r.id === orderId)
  );

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.log('FATAL', e.message);
  process.exit(1);
});
