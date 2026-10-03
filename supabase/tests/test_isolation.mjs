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
async function rows(db, sql, params) {
  try {
    return (await db.query(sql, params)).rows;
  } catch (e) {
    return { error: e.message };
  }
}
const empty = (r) => Array.isArray(r) && r.length === 0;
const deniedOrEmpty = (r) => empty(r) || (r && r.error && /permission denied|row-level security|insufficient_privilege/.test(r.error));

async function main() {
  const db = await buildDb({ log: false });
  console.log('\n--- сквозная проверка изоляции ролей ---\n');

  // ---------- данные от CEO: цены, клиенты, заказы, финансы ----------
  await asUser(db, 'ceo');
  const v = await db.query(`insert into product_variants_view (product_name, color, size, stock_quantity) values ('Изол-товар', 'Белый', 'M', 100) returning id, product_id`);
  await db.query(`update products set price = 7777 where id = $1`, [v.rows[0].product_id]);
  const client = (await db.query(`insert into clients (name, phone, category) values ('Изол-клиент', '+998901112233', 'local') returning id`)).rows[0].id;
  await db.query(`insert into client_product_prices (client_id, product_id, price) values ($1, $2, 6666)`, [client, v.rows[0].product_id]);
  const order = (await db.query(`select create_order($1, 'секрет-коммент', $2) as id`, [client, JSON.stringify([{ variant_id: v.rows[0].id, quantity: 4 }])])).rows[0].id;
  await db.query(`update orders_view set status = 'issued' where id = $1`, [order]);
  const pay = (await db.query(`insert into client_payments_view (client_id, amount) values ($1, 5000) returning id`, [client])).rows[0].id;
  await db.query(`insert into payment_photos (payment_id, photo_path) values ($1, 'p/1.jpg')`, [pay]);
  const exp = (await db.query(`insert into expenses (title, amount, payment_kind) values ('Изол-расход', 3000, 'credit') returning id`)).rows[0].id;
  await db.query(`insert into expense_repayments (expense_id, amount) values ($1, 1000)`, [exp]);
  await db.query(`insert into expense_photos (expense_id, photo_path) values ($1, 'e/1.jpg')`, [exp]);

  // CEO сам всё видит (контроль, что тест не пустой по ошибке).
  const ceoSees = await Promise.all([
    db.query(`select * from client_debt_view where id = $1`, [client]),
    db.query(`select * from finance_receipts_view`),
    db.query(`select * from expenses_view`),
    db.query(`select * from finance_audit_log`),
    db.query(`select price from order_items_view where order_id = $1`, [order]),
  ]);
  check('контроль: CEO видит долг, чеки, расходы, журнал', ceoSees.slice(0, 4).every((r) => r.rows.length > 0));
  check('контроль: CEO видит цену позиции 6666 (особая цена клиента)', Number(ceoSees[4].rows[0].price) === 6666, ceoSees[4].rows[0]?.price);

  // ---------- кладовщик: работает с заказами, но без денег ----------
  await asUser(db, 'kladovshik');
  const kOrder = await rows(db, `select total, client_phone, client_email, has_unpriced_item from orders_view where id = $1`, [order]);
  check('кладовщик видит заказ, но total/телефон/email/has_unpriced_item = NULL', kOrder.length === 1 && kOrder[0].total === null && kOrder[0].client_phone === null && kOrder[0].client_email === null && kOrder[0].has_unpriced_item === null, JSON.stringify(kOrder));
  const kItems = await rows(db, `select price from order_items_view where order_id = $1`, [order]);
  check('кладовщик видит позиции заказа, но price = NULL', kItems.length === 1 && kItems[0].price === null, JSON.stringify(kItems));
  const kVariants = await rows(db, `select price from product_variants_view where id = $1`, [v.rows[0].id]);
  check('кладовщик видит товар на складе, но price = NULL', kVariants.length === 1 && kVariants[0].price === null, JSON.stringify(kVariants));
  check('кладовщик не читает products напрямую (цена)', deniedOrEmpty(await rows(db, `select price from products`)));
  check('кладовщик не читает order_items напрямую (цена)', deniedOrEmpty(await rows(db, `select price from order_items`)));
  check('кладовщик не читает orders напрямую (сумма)', deniedOrEmpty(await rows(db, `select total from orders`)));
  check('кладовщик не читает client_product_prices (особые цены)', deniedOrEmpty(await rows(db, `select * from client_product_prices`)));
  check('кладовщик не читает client_product_prices_view', deniedOrEmpty(await rows(db, `select * from client_product_prices_view`)));
  await rows(db, `update product_variants_view set price = 1 where id = $1`, [v.rows[0].id]);
  await asUser(db, 'ceo');
  check('цена товара осталась 7777 (кладовщик её не изменил)', Number((await db.query(`select price from products where id = $1`, [v.rows[0].product_id])).rows[0].price) === 7777);

  // ---------- закройщик и мастер: сырьё/цех, но не заказы, цены, деньги ----------
  const moneyQueries = [
    [`select * from products`, 'products (цены)'],
    [`select * from product_variants_view`, 'product_variants_view'],
    [`select * from orders_view`, 'orders_view'],
    [`select * from order_items_view`, 'order_items_view'],
    [`select * from clients_view`, 'clients_view'],
    [`select * from client_product_prices`, 'client_product_prices'],
    [`select * from client_product_prices_view`, 'client_product_prices_view'],
    [`select * from client_debt_view`, 'client_debt_view'],
    [`select * from client_payments`, 'client_payments'],
    [`select * from client_payments_view`, 'client_payments_view'],
    [`select * from payment_photos`, 'payment_photos'],
    [`select * from expenses`, 'expenses'],
    [`select * from expenses_view`, 'expenses_view'],
    [`select * from expense_repayments`, 'expense_repayments'],
    [`select * from expense_photos`, 'expense_photos'],
    [`select * from finance_receipts_view`, 'finance_receipts_view'],
    [`select * from finance_receipt_items_view`, 'finance_receipt_items_view'],
    [`select * from finance_audit_log`, 'finance_audit_log'],
    [`select * from finance_audit_log_view`, 'finance_audit_log_view'],
  ];
  for (const role of ['zakroyshik', 'master']) {
    await asUser(db, role);
    for (const [sql, label] of moneyQueries) {
      const r = await rows(db, sql);
      const ok = deniedOrEmpty(r);
      check(`${role}: ${label} — ни одной строки`, ok, Array.isArray(r) ? r.length : r.error);
    }
    check(`${role}: Сводку получить не может`, deniedOrEmpty(await rows(db, `select finance_summary(current_date, current_date, 'all')`)));
  }

  // ---------- мастер: свой цех, чужой цех не виден ----------
  await asUser(db, 'zakroyshik');
  const mat = (await db.query(`insert into raw_materials (name) values ('Изол-ткань') returning id`)).rows[0].id;
  const col = (await db.query(`insert into raw_material_colors (material_id, color) values ($1, 'Зелёный') returning id`, [mat])).rows[0].id;
  await asUser(db, 'ceo');
  await db.query(`insert into raw_material_receipts (color_id, rolls) values ($1, 50)`, [col]);
  await asUser(db, 'zakroyshik');
  async function batchIn(shop, name) {
    const issue = (await db.query(`insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 1, 'Т') returning id`, [col])).rows[0].id;
    return (await db.query(`select * from create_cutting_batch($1, $2::jsonb, $3)`, [issue, JSON.stringify([{ product_name: name, sizes: [{ size: 'M', quantity: 5 }] }]), shop])).rows[0].out_batch_id;
  }
  const bFactory = await batchIn('factory', 'Фабричный');
  const bWorkshop = await batchIn('workshop', 'Цеховой');

  await asUser(db, 'ceo');
  const empF = (await db.query(`insert into employees (name, shop) values ('Сотр-Фабрика', 'factory') returning id`)).rows[0].id;
  const empW = (await db.query(`insert into employees (name, shop) values ('Сотр-Цех', 'workshop') returning id`)).rows[0].id;
  const op = (await db.query(`insert into operation_types (name, rate_per_piece) values ('Строчка', 100) returning id`)).rows[0].id;
  await db.query(`insert into attendance (employee_id, date) values ($1, current_date), ($2, current_date)`, [empF, empW]);
  await db.query(`insert into work_records (employee_id, operation_type_id, quantity) values ($1, $3, 1), ($2, $3, 2)`, [empF, empW, op]);

  // Мастер без выбранного цеха — не видит ничего цехового.
  await asUser(db, 'master');
  const noShop = await Promise.all([
    db.query(`select * from cutting_batches_view`),
    db.query(`select * from employees`),
    db.query(`select * from attendance_view`),
    db.query(`select * from work_records_view`),
  ]);
  check('мастер без выбранного цеха не видит партий/сотрудников/явки/сделки', noShop.every((r) => r.rows.length === 0), noShop.map((r) => r.rows.length).join(','));

  for (const [shop, ownBatch, otherBatch, ownEmp, otherEmp] of [
    ['factory', bFactory, bWorkshop, 'Сотр-Фабрика', 'Сотр-Цех'],
    ['workshop', bWorkshop, bFactory, 'Сотр-Цех', 'Сотр-Фабрика'],
  ]) {
    await asUser(db, 'master');
    await db.query(`select set_my_shop($1)`, [shop]);
    const batches = (await db.query(`select id, shop from cutting_batches_view`)).rows;
    check(`мастер «${shop}»: через cutting_batches_view видит только свою партию`, batches.length === 1 && batches[0].id === ownBatch && batches[0].shop === shop, JSON.stringify(batches));
    check(`мастер «${shop}»: чужую партию по id не получить (view)`, (await db.query(`select 1 from cutting_batches_view where id = $1`, [otherBatch])).rows.length === 0);
    check(`мастер «${shop}»: чужую партию по id не получить (таблица)`, (await db.query(`select 1 from cutting_batches where id = $1`, [otherBatch])).rows.length === 0);
    check(`мастер «${shop}»: размеры чужой партии не видны`, (await db.query(`select 1 from cutting_batch_items_view v join cutting_batch_products p on p.id = v.batch_product_id where p.batch_id = $1`, [otherBatch])).rows.length === 0);
    const emps = (await db.query(`select name from employees`)).rows.map((r) => r.name);
    check(`мастер «${shop}»: видит только своих сотрудников`, emps.length === 1 && emps[0] === ownEmp, JSON.stringify(emps));
    const att = (await db.query(`select employee_name from attendance_view`)).rows.map((r) => r.employee_name);
    check(`мастер «${shop}»: явка только своего цеха`, att.length === 1 && att[0] === ownEmp, JSON.stringify(att));
    const wr = (await db.query(`select employee_name from work_records_view`)).rows.map((r) => r.employee_name);
    check(`мастер «${shop}»: сделка только своего цеха`, wr.length === 1 && wr[0] === ownEmp, JSON.stringify(wr));
    const otherName = otherEmp;
    check(`мастер «${shop}»: сотрудник чужого цеха («${otherName}») не виден нигде`, ![...emps, ...att, ...wr].includes(otherName));
    // Попытка записи в чужой цех.
    let wrote = true;
    try {
      const r = await db.query(`insert into employees (name, shop) values ('Подсадной', $1) returning id`, [shop === 'factory' ? 'workshop' : 'factory']);
      wrote = r.rows.length > 0;
    } catch (e) {
      wrote = false;
    }
    check(`мастер «${shop}»: сотрудника в чужой цех завести нельзя`, !wrote);
    // Попытка подтвердить крой чужой партии.
    let changed = false;
    try {
      const r = await db.query(`update cutting_batches set status = 'in_sewing' where id = $1 returning id`, [otherBatch]);
      changed = r.rows.length > 0;
    } catch (e) {
      changed = false;
    }
    check(`мастер «${shop}»: принять крой чужой партии нельзя`, !changed);
  }

  // ---------- функции цены: напрямую их не вызвать никому, кроме CEO ----------
  for (const role of ['kladovshik', 'zakroyshik', 'master']) {
    await asUser(db, role);
    const direct = await rows(db, `select resolve_item_price($1, $2) as p`, [client, v.rows[0].product_id]);
    check(`${role}: resolve_item_price напрямую не вызвать (цена не утекает)`, !Array.isArray(direct) && /permission denied/.test(direct.error), JSON.stringify(direct));
    const preview = await rows(db, `select preview_item_price($1, $2) as p`, [client, v.rows[0].product_id]);
    check(`${role}: preview_item_price отклонён`, !Array.isArray(preview) && /insufficient_privilege|permission denied/.test(preview.error), JSON.stringify(preview));
  }
  await asUser(db, 'ceo');
  const ceoPrev = await db.query(`select preview_item_price($1, $2) as p`, [client, v.rows[0].product_id]);
  check('CEO: preview_item_price отдаёт особую цену клиента (6666)', Number(ceoPrev.rows[0].p) === 6666, ceoPrev.rows[0].p);
  const ceoBase = await db.query(`select preview_item_price(null, $1) as p`, [v.rows[0].product_id]);
  check('CEO: без клиента — обычная цена (7777)', Number(ceoBase.rows[0].p) === 7777, ceoBase.rows[0].p);
  // но кладовщик по-прежнему может создать заказ — цена подставляется внутри create_order
  await asUser(db, 'kladovshik');
  const kCreate = await rows(db, `select create_order($1, null, $2) as id`, [client, JSON.stringify([{ variant_id: v.rows[0].id, quantity: 1 }])]);
  check('кладовщик создаёт заказ (цена подставляется на сервере)', Array.isArray(kCreate) && !!kCreate[0].id, JSON.stringify(kCreate));
  await asUser(db, 'ceo');
  const kPrice = await db.query(`select price from order_items where order_id = $1`, [kCreate[0].id]);
  check('и в заказ кладовщика попала особая цена клиента 6666', Number(kPrice.rows[0].price) === 6666, kPrice.rows[0]?.price);

  // ---------- бот (service_role, без auth.uid()) продолжает работать ----------
  await db.query('reset role');
  await db.exec(`create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;`);
  const botVariants = await db.query(`select count(*)::int as n from product_variants_view`);
  check('сервисный ключ (бот): product_variants_view читается', botVariants.rows[0].n > 0, botVariants.rows[0].n);
  const botPrice = await db.query(`select resolve_item_price($1, $2) as p`, [client, v.rows[0].product_id]);
  check('сервисный ключ (бот): resolve_item_price отдаёт цену клиента', Number(botPrice.rows[0].p) === 6666, botPrice.rows[0].p);

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
