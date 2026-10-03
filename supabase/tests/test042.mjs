import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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

// Запрос supabase/maintenance/check_small_amounts.sql находит подозрительные
// суммы (< 1000 сум) во всех денежных местах, включая выданные чеки, и не
// цепляет нормальные суммы.
async function main() {
  const sql = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../maintenance/check_small_amounts.sql'), 'utf8');
  const db = await buildDb({ log: false });
  console.log('\n--- запрос подозрительных сумм ---\n');
  await asUser(db, 'ceo');

  const v = (await db.query(`insert into product_variants_view (product_name, color, size, stock_quantity) values ('Майка', 'Белый', 'M', 100) returning id, product_id`)).rows[0];
  await db.query(`update products set price = 14 where id = $1`, [v.product_id]);
  const ok = (await db.query(`insert into product_variants_view (product_name, color, size, stock_quantity) values ('Нормальный', 'Чёрный', 'L', 100) returning id, product_id`)).rows[0];
  await db.query(`update products set price = 14000 where id = $1`, [ok.product_id]);
  const client = (await db.query(`insert into clients (name) values ('Клиент-И') returning id`)).rows[0].id;
  await db.query(`insert into client_product_prices (client_id, product_id, price) values ($1, $2, 37)`, [client, ok.product_id]);
  await db.query(`insert into client_payments_view (client_id, amount) values ($1, 5), ($1, 5000000)`, [client]);
  const exp = (await db.query(`insert into expenses (title, amount, payment_kind) values ('Мелкий', 25, 'credit') returning id`)).rows[0].id;
  await db.query(`insert into expenses (title, amount, payment_kind) values ('Нормальный расход', 90000, 'paid')`);
  await db.query(`insert into expense_repayments (expense_id, amount) values ($1, 10)`, [exp]);

  // выданный чек с Майкой по 14 (цена из каталога) + нормальный выданный чек
  const bad = (await db.query(`select create_order($1, null, $2) as id`, [client, JSON.stringify([{ variant_id: v.id, quantity: 3 }])])).rows[0].id;
  await db.query(`update orders_view set status = 'issued' where id = $1`, [bad]);
  const good = (await db.query(`select create_order($1, null, $2) as id`, [client, JSON.stringify([{ variant_id: ok.id, quantity: 1 }])])).rows[0].id;
  await db.query(`update orders_view set status = 'issued' where id = $1`, [good]);
  // непроведённый (new) заказ с мелкой ценой в чеки не попадает
  await db.query(`select create_order($1, null, $2)`, [client, JSON.stringify([{ variant_id: v.id, quantity: 1 }])]);

  const rows = (await db.query(sql)).rows;
  const byKind = (k) => rows.filter((r) => r['Что'] === k);
  check('обычная цена: найдена только «Майка» = 14', byKind('Обычная цена товара').length === 1 && byKind('Обычная цена товара')[0]['Название / товар'] === 'Майка' && Number(byKind('Обычная цена товара')[0]['Сумма, сум']) === 14);
  check('особая цена 37 найдена', byKind('Особая цена клиента').length === 1 && Number(byKind('Особая цена клиента')[0]['Сумма, сум']) === 37);
  check('оплата 5 найдена, 5.000.000 — нет', byKind('Оплата клиента').length === 1 && Number(byKind('Оплата клиента')[0]['Сумма, сум']) === 5);
  check('расход 25 найден, 90.000 — нет', byKind('Расход').length === 1 && Number(byKind('Расход')[0]['Сумма, сум']) === 25);
  check('погашение 10 найдено', byKind('Погашение расхода').length === 1 && Number(byKind('Погашение расхода')[0]['Сумма, сум']) === 10);
  const receipts = byKind('ЧЕК: цена строки');
  const maika = receipts.find((r) => /Майка/.test(r['Название / товар']));
  const special = receipts.find((r) => /Нормальный/.test(r['Название / товар']));
  check('в выданных чеках найдены 2 строки: Майка по 14 и товар по особой цене 37 (заказ «новый» не считается)', receipts.length === 2 && !!maika && !!special, receipts.length);
  check('Майка: видны клиент, количество и итог чека', maika && Number(maika['Сумма, сум']) === 14 && maika['Клиент'] === 'Клиент-И' && /3.00 шт/.test(maika['Дата / детали']) && /42/.test(maika['Дата / детали']));
  check('особая цена 37 попала в чек — запрос это показывает', special && Number(special['Сумма, сум']) === 37);
  const totals = byKind('ЧЕК: сумма заказа');
  check('суммы заказов меньше 1000: 37 и 42', totals.length === 2 && totals.map((t) => Number(t['Сумма, сум'])).sort((x, y) => x - y).join() === '37,42', JSON.stringify(totals.map((t) => t['Сумма, сум'])));

  // запрос только читает
  const after = (await db.query(`select (select count(*) from products) + (select count(*) from client_payments) + (select count(*) from expenses) as n`)).rows[0].n;
  check('запрос ничего не изменил (только чтение)', Number(after) > 0 && !/\b(insert|update|delete|drop|alter|truncate)\b/i.test(sql.replace(/--.*$/gm, '')));

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
