import { buildDb, asUser } from './build_master.mjs';

let passed = 0;
let failed = 0;
function check(name, cond, evidence) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  ПРОВАЛ:', name, evidence !== undefined ? `(${evidence})` : '');
  }
}
const BIG = 5000000000; // 5.000.000.000
const MAX = 9999999999; // 9.999.999.999 — предел numeric(12, 2)

async function main() {
  const db = await buildDb({ log: false });
  console.log('\n--- 041 применена, проверяю большие суммы и журнал цены в чеке ---\n');
  await asUser(db, 'ceo');

  // ---- большие суммы сохраняются точно, без обрезания и округления
  const v = (await db.query(`insert into product_variants_view (product_name, color, size, stock_quantity) values ('Большой', 'Б', 'M', 1000) returning id, product_id`)).rows[0];
  await db.query(`update products set price = $1 where id = $2`, [BIG, v.product_id]);
  check('обычная цена 5.000.000.000 хранится точно', Number((await db.query(`select price from products where id = $1`, [v.product_id])).rows[0].price) === BIG);

  const client = (await db.query(`insert into clients (name, category) values ('Крупный', 'expo') returning id`)).rows[0].id;
  await db.query(`insert into client_product_prices (client_id, product_id, price) values ($1, $2, $3)`, [client, v.product_id, MAX]);
  check('особая цена 9.999.999.999 хранится точно', Number((await db.query(`select price from client_product_prices where client_id = $1`, [client])).rows[0].price) === MAX);

  const order = (await db.query(`select create_order($1, null, $2) as id`, [client, JSON.stringify([{ variant_id: v.id, quantity: 1 }])])).rows[0].id;
  check('цена в заказе — особая 9.999.999.999, сумма заказа без обрезания', Number((await db.query(`select total from orders where id = $1`, [order])).rows[0].total) === MAX);
  await db.query(`update orders_view set status = 'issued' where id = $1`, [order]);

  const order2 = (await db.query(`select create_order($1, null, $2) as id`, [client, JSON.stringify([{ variant_id: v.id, quantity: 1 }])])).rows[0].id;
  await db.query(`update orders_view set status = 'issued' where id = $1`, [order2]);
  const debt = (await db.query(`select issued_total, debt from client_debt_view where id = $1`, [client])).rows[0];
  check('долг по двум чекам по ~10 млрд = 19.999.999.998 (сумма больше одного поля — без ошибки)', Number(debt.issued_total) === 2 * MAX && Number(debt.debt) === 2 * MAX, JSON.stringify(debt));

  const pay = (await db.query(`insert into client_payments_view (client_id, amount) values ($1, $2) returning id`, [client, MAX])).rows[0].id;
  check('оплата 9.999.999.999 хранится точно', Number((await db.query(`select amount from client_payments where id = $1`, [pay])).rows[0].amount) === MAX);
  const exp = (await db.query(`insert into expenses (title, amount, payment_kind) values ('Станки', $1, 'credit') returning id`, [BIG])).rows[0].id;
  await db.query(`insert into expense_repayments (expense_id, amount) values ($1, $2)`, [exp, 1234567890]);
  const ev = (await db.query(`select amount, repaid_total, debt_left from expenses_view where id = $1`, [exp])).rows[0];
  check('расход 5.000.000.000, погашение 1.234.567.890, остаток 3.765.432.110', Number(ev.amount) === BIG && Number(ev.repaid_total) === 1234567890 && Number(ev.debt_left) === 3765432110, JSON.stringify(ev));

  const today = (await db.query(`select to_char(current_date, 'YYYY-MM-DD') as d`)).rows[0].d;
  const sum = (await db.query(`select finance_summary($1, $2, 'all') as s`, [today.slice(0, 8) + '01', today])).rows[0].s;
  check('Сводка: Продали 19.999.999.998 без потери точности', Number(sum.sold) === 2 * MAX, sum.sold);
  check('Сводка: Получили 9.999.999.999', Number(sum.received) === MAX, sum.received);

  // ---- предел поля: больше 9.999.999.999 база честно отклоняет, а не обрезает
  let overflow = false;
  try {
    await db.query(`insert into expenses (title, amount, payment_kind) values ('Слишком много', 10000000000, 'paid')`);
  } catch (e) {
    overflow = /numeric field overflow|out of range/i.test(e.message);
  }
  check('сумма 10.000.000.000 отклоняется базой ошибкой, а не обрезается', overflow);

  // итог заказа тоже numeric(12, 2): 2 × 9.999.999.999 не помещается — заказ отклоняется целиком
  const before = (await db.query(`select count(*)::int as n from orders`)).rows[0].n;
  let orderOverflow = false;
  try {
    await db.query(`select create_order($1, null, $2)`, [client, JSON.stringify([{ variant_id: v.id, quantity: 2 }])]);
  } catch (e) {
    orderOverflow = /numeric field overflow/i.test(e.message);
  }
  check('заказ с итогом больше 9.999.999.999 отклоняется целиком (ошибка, не обрезание)', orderOverflow);
  check('и не оставляет заказа-сироты', (await db.query(`select count(*)::int as n from orders`)).rows[0].n === before);

  // ---- правка цены в чеке: сумма, долг и журнал
  await db.query(`update products set price = null where id = $1`, [v.product_id]);
  await db.query(`delete from client_product_prices where client_id = $1`, [client]);
  const order3 = (await db.query(`select create_order($1, null, $2) as id`, [client, JSON.stringify([{ variant_id: v.id, quantity: 2 }])])).rows[0].id;
  const itemId = (await db.query(`select id from order_items where order_id = $1`, [order3])).rows[0].id;
  await db.query(`update order_items set price = 14 where id = $1`, [itemId]);
  await db.query(`update order_items set price = 14000 where id = $1`, [itemId]);
  check('после правки цены сумма заказа пересчиталась (2 × 14.000)', Number((await db.query(`select total from orders where id = $1`, [order3])).rows[0].total) === 28000);

  const log = (await db.query(`select action, entity_type, actor_email, client_name, product_name, detail from finance_audit_log_view where entity_type = 'order_items'`)).rows.sort((a, b) => Number(a.detail.new.price) - Number(b.detail.new.price));
  check('в журнале 2 правки цены строки заказа', log.length === 2 && log.every((r) => r.action === 'update'), log.length);
  check('в записи: клиент, товар, автор', log[1].client_name === 'Крупный' && log[1].product_name === 'Большой' && log[1].actor_email === 'ceo@test.test', JSON.stringify(log[1]));
  check('в записи: было 14, стало 14000', Number(log[1].detail.old.price) === 14 && Number(log[1].detail.new.price) === 14000);

  await db.query(`update order_items set quantity = 3 where id = $1`, [itemId]);
  check('правка количества (не цены) в журнал не попадает', (await db.query(`select count(*)::int as n from finance_audit_log where entity_type = 'order_items'`)).rows[0].n === 2);

  // ---- другие роли не меняют цену в чеке и не видят журнал
  for (const role of ['kladovshik', 'zakroyshik', 'master']) {
    await asUser(db, role);
    let changed = false;
    try {
      const r = await db.query(`update order_items set price = 1 where id = $1 returning id`, [itemId]);
      changed = r.rows.length > 0;
    } catch (e) {
      changed = false;
    }
    check(`${role}: цену в чеке изменить нельзя`, !changed);
    check(`${role}: журнал цен не видит`, (await db.query(`select * from finance_audit_log_view`)).rows.length === 0);
  }

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
