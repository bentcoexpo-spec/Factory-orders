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
  console.log('\n--- 034 применена, проверяю ---\n');

  await asUser(db, 'ceo');

  // С 036_pricing_and_receipts.sql цена через product_variants_view
  // больше не задаётся (ни при insert, ни при update) — заводим вариант
  // без цены, затем ставим цену напрямую в products ("Финансы → Цены").
  const variant = await db.query(
    `insert into product_variants_view (product_name, color, size, stock_quantity) values ('Тест-товар-034', 'Синий', 'M', 100) returning id, product_id`
  );
  const variantId = variant.rows[0].id;
  await db.query(`update products set price = 1000 where id = $1`, [variant.rows[0].product_id]);

  const client = await db.query(
    `insert into clients (name, phone, category) values ('Тест-клиент-034', '+998900000034', 'expo') returning id`
  );
  const clientId = client.rows[0].id;

  let badCategoryRejected = false;
  try {
    await db.query(`insert into clients (name, category) values ('Плохая категория-034', 'vip')`);
  } catch (e) {
    badCategoryRejected = /clients_category_check/.test(e.message);
  }
  check('неизвестная категория клиента отклоняется', badCategoryRejected);

  async function makeOrder(qty) {
    const res = await db.query(`select create_order($1, null, $2) as id`, [
      clientId,
      JSON.stringify([{ variant_id: variantId, quantity: qty }]),
    ]);
    return res.rows[0].id;
  }

  const order1 = await makeOrder(3);
  await db.query(`update orders_view set status = 'issued' where id = $1`, [order1]);
  const order2 = await makeOrder(2);
  await db.query(`update orders_view set status = 'issued' where id = $1`, [order2]);
  await db.query(`update orders_view set status = 'returned' where id = $1`, [order2]);

  const debtAfterOrders = await db.query(`select issued_total, paid_total, debt from client_debt_view where id = $1`, [
    clientId,
  ]);
  check('в долг клиента входит только оставшийся "issued" заказ (3000)', Number(debtAfterOrders.rows[0].issued_total) === 3000, debtAfterOrders.rows[0].issued_total);
  check('долг без оплат равен сумме выданного', Number(debtAfterOrders.rows[0].debt) === 3000, debtAfterOrders.rows[0].debt);

  const payment = await db.query(
    `insert into client_payments_view (client_id, amount, comment) values ($1, 1200, 'наличные') returning id, created_by`,
    [clientId]
  );
  check('оплата создаётся и created_by проставляется', !!payment.rows[0].created_by);

  let badAmountRejected = false;
  try {
    await db.query(`insert into client_payments_view (client_id, amount) values ($1, 0)`, [clientId]);
  } catch (e) {
    badAmountRejected = /invalid_amount/.test(e.message);
  }
  check('оплата с нулевой/отрицательной суммой отклоняется', badAmountRejected);

  const debtAfterPayment = await db.query(`select debt from client_debt_view where id = $1`, [clientId]);
  check('долг уменьшился на сумму оплаты (3000 - 1200 = 1800)', Number(debtAfterPayment.rows[0].debt) === 1800, debtAfterPayment.rows[0].debt);

  // --- Кладовщик не должен видеть/писать вообще ничего из этого. ---
  await asUser(db, 'kladovshik');

  const kladClients = await db.query(`select count(*)::int as n from clients`);
  check('кладовщик не видит таблицу clients напрямую', kladClients.rows[0].n === 0);

  const kladDebt = await db.query(`select count(*)::int as n from client_debt_view`);
  check('кладовщик не видит client_debt_view', kladDebt.rows[0].n === 0);

  const kladPayments = await db.query(`select count(*)::int as n from client_payments_view`);
  check('кладовщик не видит client_payments_view', kladPayments.rows[0].n === 0);

  let kladInsertRejected = false;
  try {
    await db.query(`insert into client_payments_view (client_id, amount) values ($1, 500)`, [clientId]);
  } catch (e) {
    kladInsertRejected = /insufficient_privilege/.test(e.message);
  }
  check('кладовщик не может внести оплату', kladInsertRejected);

  await asUser(db, 'ceo');
  const stillThere = await db.query(`select count(*)::int as n from client_payments where client_id = $1`, [clientId]);
  check('...и правда ничего не записалось', stillThere.rows[0].n === 1);

  // У view нет своей RLS — базовая таблица уже отдаёт кладовщику 0 строк,
  // поэтому DELETE ... WHERE id = $1 просто не находит, что удалять (не
  // бросает ошибку, INSTEAD OF-триггер не срабатывает вовсе) — тот же
  // эффект, что и с UPDATE чужого цеха в employees.
  await asUser(db, 'kladovshik');
  await db.query(`delete from client_payments_view where id = $1`, [payment.rows[0].id]);
  await asUser(db, 'ceo');
  const stillThereAfterKladDelete = await db.query(`select count(*)::int as n from client_payments where id = $1`, [
    payment.rows[0].id,
  ]);
  check('...DELETE от кладовщика ничего не удалил (0 строк ему видно)', stillThereAfterKladDelete.rows[0].n === 1);

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.log('FATAL', e.message);
  process.exit(1);
});
