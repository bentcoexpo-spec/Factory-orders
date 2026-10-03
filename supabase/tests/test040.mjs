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

async function main() {
  const db = await buildDb({ log: false });
  console.log('\n--- 040 применена, проверяю ---\n');
  await asUser(db, 'ceo');

  const v = (await db.query(`insert into product_variants_view (product_name, color, size, stock_quantity) values ('Журнал-товар', 'Белый', 'M', 10) returning product_id`)).rows[0];
  await db.query(`update products set price = 5000 where id = $1`, [v.product_id]);
  await db.query(`update products set price = 5500 where id = $1`, [v.product_id]);
  const client = (await db.query(`insert into clients (name, category) values ('Журнал-клиент', 'local') returning id`)).rows[0].id;
  await db.query(`insert into client_product_prices (client_id, product_id, price) values ($1, $2, 4000)`, [client, v.product_id]);
  const pay = (await db.query(`insert into client_payments_view (client_id, amount, paid_at) values ($1, 4000, '2026-01-10') returning id`, [client])).rows[0].id;
  await db.query(`update client_payments_view set amount = 4500 where id = $1`, [pay]);
  await db.query(`insert into payment_photos (payment_id, photo_path) values ($1, 'p/1.jpg')`, [pay]);
  const exp = (await db.query(`insert into expenses (title, amount, payment_kind) values ('Журнал-расход', 9000, 'credit') returning id`)).rows[0].id;
  await db.query(`insert into expense_repayments (expense_id, amount) values ($1, 3000)`, [exp]);
  await db.query(`delete from expenses where id = $1`, [exp]);
  await db.query(`delete from client_payments_view where id = $1`, [pay]);

  const rows = (await db.query(`select * from finance_audit_log_view order by created_at, id`)).rows;
  const find = (t, a) => rows.filter((r) => r.entity_type === t && r.action === a);

  check('у каждой записи есть автор-email', rows.length > 0 && rows.every((r) => r.actor_email === 'ceo@test.test'), rows.length);
  const priceChange = find('product', 'price_change');
  check('правки обычной цены: 2 записи, имя товара в записи', priceChange.length === 2 && priceChange.every((r) => r.product_name === 'Журнал-товар'), priceChange.length);
  check('у правки цены видны old и new', Number(priceChange[1].detail.old_price) === 5000 && Number(priceChange[1].detail.new_price) === 5500);
  const special = find('client_product_price', 'client_price_set')[0];
  check('особая цена: имя клиента и товара подтянуты', special.client_name === 'Журнал-клиент' && special.product_name === 'Журнал-товар', JSON.stringify([special.client_name, special.product_name]));
  const payIns = find('client_payments', 'insert')[0];
  check('оплата: имя клиента подтянуто', payIns.client_name === 'Журнал-клиент');
  const payUpd = find('client_payments', 'update')[0];
  check('правка оплаты: клиент подтянут из detail.new, old/new есть', payUpd.client_name === 'Журнал-клиент' && Number(payUpd.detail.old.amount) === 4000 && Number(payUpd.detail.new.amount) === 4500);
  const payDel = find('client_payments', 'delete')[0];
  check('удалённая оплата: клиент и сумма остались в журнале', payDel.client_name === 'Журнал-клиент' && Number(payDel.detail.amount) === 4500);
  const photoIns = find('payment_photos', 'insert')[0];
  check('фото к оплате: клиент подтянут через оплату', photoIns.client_name === 'Журнал-клиент', photoIns.client_name);
  const expIns = find('expenses', 'insert')[0];
  check('расход: название в записи', expIns.expense_title === 'Журнал-расход');
  const expDel = find('expenses', 'delete')[0];
  check('удалённый расход: название осталось из снимка', expDel.expense_title === 'Журнал-расход' && Number(expDel.detail.amount) === 9000);
  const repIns = find('expense_repayments', 'insert')[0];
  check('погашение: название расхода подтянуто, пока расход жив', repIns.expense_title === 'Журнал-расход', repIns.expense_title);
  check('каскадное удаление погашения тоже записано', find('expense_repayments', 'delete').length === 1);

  for (const role of ['kladovshik', 'zakroyshik', 'master']) {
    await asUser(db, role);
    const r = await db.query(`select * from finance_audit_log_view`);
    check(`${role}: журнал не видит`, r.rows.length === 0, r.rows.length);
  }

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
