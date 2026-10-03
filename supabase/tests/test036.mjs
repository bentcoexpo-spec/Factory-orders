import { buildDb, asUser } from './build_master.mjs';
import { newDb, applyMigrations } from './build019.mjs';
import { UIDS } from './build_master.mjs';

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
  console.log('\n--- 036 применена, проверяю ---\n');

  await asUser(db, 'ceo');

  // 1. Новый товар через product_variants_view — без цены (NULL, не 0).
  const v1 = await db.query(
    `insert into product_variants_view (product_name, color, size, stock_quantity) values ('Тест-036', 'Белый', 'M', 10) returning id, product_id`
  );
  const product1Id = v1.rows[0].product_id;
  const p1 = await db.query(`select price from products where id = $1`, [product1Id]);
  check('новый товар создаётся без цены (NULL, не 0)', p1.rows[0].price === null, p1.rows[0].price);

  // 2. На "Складе" цену больше не поменять.
  let priceViaVariantRejected = false;
  try {
    await db.query(`update product_variants_view set price = 999 where id = $1`, [v1.rows[0].id]);
  } catch (e) {
    priceViaVariantRejected = /price_set_only_in_finance/.test(e.message);
  }
  check('CEO не может поменять цену через product_variants_view (только через "Цены")', priceViaVariantRejected);

  // 3. Прямое обновление products.price работает и логируется.
  await db.query(`update products set price = 5000 where id = $1`, [product1Id]);
  const p1after = await db.query(`select price from products where id = $1`, [product1Id]);
  check('цена товара меняется напрямую через products', Number(p1after.rows[0].price) === 5000);

  const auditProduct = await db.query(
    `select action, detail from finance_audit_log where entity_type = 'product' and entity_id = $1`,
    [product1Id]
  );
  check('изменение цены товара попало в finance_audit_log', auditProduct.rows.length === 1, auditProduct.rows.length);
  check(
    'в записи лога — старая и новая цена',
    auditProduct.rows[0]?.detail?.old_price === null && Number(auditProduct.rows[0]?.detail?.new_price) === 5000
  );

  // 4. Клиент и особая цена.
  const client = await db.query(`insert into clients (name) values ('Клиент-036') returning id`);
  const clientId = client.rows[0].id;

  const cpp = await db.query(
    `insert into client_product_prices (client_id, product_id, price) values ($1, $2, 3000) returning id, created_by`,
    [clientId, product1Id]
  );
  check('особая цена клиента создаётся, created_by проставлен', !!cpp.rows[0].created_by);

  let duplicateSpecialPriceRejected = false;
  try {
    await db.query(`insert into client_product_prices (client_id, product_id, price) values ($1, $2, 3500)`, [
      clientId,
      product1Id,
    ]);
  } catch (e) {
    duplicateSpecialPriceRejected = /unique|duplicate/i.test(e.message);
  }
  check('вторую особую цену на ту же пару клиент+товар завести нельзя', duplicateSpecialPriceRejected);

  // 5. resolve_item_price: особая цена клиента побеждает обычную.
  const resolved1 = await db.query(`select preview_item_price($1, $2) as price`, [clientId, product1Id]);
  check('resolve_item_price отдаёт особую цену клиента (3000), а не обычную (5000)', Number(resolved1.rows[0].price) === 3000);

  const otherClient = await db.query(`insert into clients (name) values ('Другой клиент-036') returning id`);
  const resolved2 = await db.query(`select preview_item_price($1, $2) as price`, [otherClient.rows[0].id, product1Id]);
  check('у другого клиента без особой цены — обычная цена товара (5000)', Number(resolved2.rows[0].price) === 5000);

  const noProductResolved = await db.query(`select preview_item_price($1, gen_random_uuid()) as price`, [clientId]);
  check('у несуществующего товара resolve_item_price отдаёт NULL', noProductResolved.rows[0].price === null);

  // 6. create_order использует resolve_item_price, а не присланную клиентом цену.
  const variantForOrder = await db.query(
    `insert into product_variants_view (product_name, color, size, stock_quantity) values ('Тест-036-Б', 'Чёрный', 'L', 50) returning id, product_id`
  );
  await db.query(`update products set price = 1000 where id = $1`, [variantForOrder.rows[0].product_id]);
  const orderRes = await db.query(`select create_order($1, null, $2) as id`, [
    clientId,
    JSON.stringify([
      // Присылаем "price": 99999 — не должно быть учтено вообще, create_order
      // его даже не читает теперь.
      { variant_id: variantForOrder.rows[0].id, quantity: 2, price: 99999 },
    ]),
  ]);
  const itemCheck = await db.query(`select price from order_items where order_id = $1`, [orderRes.rows[0].id]);
  check(
    'create_order игнорирует присланную цену, берёт из resolve_item_price (1000)',
    Number(itemCheck.rows[0].price) === 1000,
    itemCheck.rows[0].price
  );

  // 7. Товар без цены → позиция заказа без цены ("без цены" в чеке).
  const unpricedVariant = await db.query(
    `insert into product_variants_view (product_name, color, size, stock_quantity) values ('Тест-036-БезЦены', 'Серый', 'S', 20) returning id`
  );
  const orderUnpriced = await db.query(`select create_order($1, null, $2) as id`, [
    clientId,
    JSON.stringify([{ variant_id: unpricedVariant.rows[0].id, quantity: 1 }]),
  ]);
  const unpricedItem = await db.query(`select price from order_items where order_id = $1`, [orderUnpriced.rows[0].id]);
  check('заказ на товар без цены создаёт позицию с price = NULL ("без цены")', unpricedItem.rows[0].price === null);

  // 8. Кладовщик не видит/не пишет ничего из этого.
  await asUser(db, 'kladovshik');

  const kladClientPrices = await db.query(`select count(*)::int as n from client_product_prices`);
  check('кладовщик не видит client_product_prices', kladClientPrices.rows[0].n === 0);

  const kladAudit = await db.query(`select count(*)::int as n from finance_audit_log`);
  check('кладовщик не видит finance_audit_log', kladAudit.rows[0].n === 0);

  let kladInsertPriceRejected = false;
  try {
    await db.query(`insert into client_product_prices (client_id, product_id, price) values ($1, $2, 1)`, [
      clientId,
      product1Id,
    ]);
  } catch (e) {
    kladInsertPriceRejected = true;
  }
  check('кладовщик не может завести особую цену клиента', kladInsertPriceRejected);

  // Кладовщик по-прежнему не видит цену при создании заказа — order_items_view
  // маскирует её, но сам заказ через create_order создаётся нормально с верной
  // ценой на сервере (кладовщик её просто не видит).
  const kladOrder = await db.query(`select create_order($1, null, $2) as id`, [
    clientId,
    JSON.stringify([{ variant_id: variantForOrder.rows[0].id, quantity: 1 }]),
  ]);
  check('кладовщик может создать заказ (цена подставляется сама)', !!kladOrder.rows[0]?.id);

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.log('FATAL', e.message);
  process.exit(1);
});
