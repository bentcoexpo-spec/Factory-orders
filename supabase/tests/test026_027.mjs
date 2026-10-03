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
  await db.query('reset role');
  await db.query(`update profiles set current_shop = 'factory' where id = $1`, [UIDS.master]);
  await asUser(db, 'zakroyshik');
  console.log('\n--- 026/027 применены, проверяю ---\n');

  await asUser(db, 'zakroyshik');
  const m = await db.query(`insert into raw_materials (name) values ('Ткань-026') returning id`);
  const c = await db.query(`insert into raw_material_colors (material_id, color) values ($1, 'Оранжевый') returning id`, [m.rows[0].id]);
  const colorId = c.rows[0].id;
  await db.query(`insert into raw_material_receipts (color_id, rolls) values ($1, 30)`, [colorId]);

  // 1. width/weight CHECK
  let negRejected = false;
  try {
    await db.query(`insert into raw_material_receipts (color_id, rolls, width_cm) values ($1, 1, -1)`, [colorId]);
  } catch (e) {
    negRejected = true;
  }
  check('CHECK-1: отрицательный width_cm отклонён', negRejected);

  // 2. RLS policy text: zakroyshik больше не "for all" на cutting_batch_items/products/raw_material_colors
  const cbiPolicies = await db.query(`select polname, polcmd from pg_policy where polrelid='cutting_batch_items'::regclass`);
  const hasZakForAll = cbiPolicies.rows.some((p) => p.polcmd === '*');
  check('RLS-1: у zakroyshik больше нет "for all" на cutting_batch_items', !hasZakForAll, JSON.stringify(cbiPolicies.rows));

  const colorsPolicies = await db.query(`select polname, polcmd from pg_policy where polrelid='raw_material_colors'::regclass`);
  const hasColorsForAll = colorsPolicies.rows.some((p) => p.polcmd === '*');
  check('RLS-2: у zakroyshik больше нет "for all" на raw_material_colors', !hasColorsForAll, JSON.stringify(colorsPolicies.rows));

  // 3. create_cutting_batch: атомарное создание, счастливый путь
  const issue1 = await db.query(`insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 5, 'Закройщик') returning id`, [colorId]);
  const rpcResult = await db.query(
    `select * from create_cutting_batch($1, $2, 'factory')`,
    [issue1.rows[0].id, JSON.stringify([
      { product_name: 'Футболка', sizes: [{ size: 'M', quantity: 10 }, { size: 'L', quantity: 5 }] },
      { product_name: 'Майка', sizes: [{ size: 'M', quantity: 3 }] },
    ])]
  );
  check('RPC-1: create_cutting_batch вернул id и номер', rpcResult.rows.length === 1 && !!rpcResult.rows[0].out_batch_id);
  const batchId1 = rpcResult.rows[0].out_batch_id;
  const itemCount = await db.query(
    `select count(*)::int as n from cutting_batch_items cbi join cutting_batch_products cbp on cbp.id=cbi.batch_product_id where cbp.batch_id=$1`,
    [batchId1]
  );
  check('RPC-2: создались все 3 размерные строки (2 у Футболки + 1 у Майки)', itemCount.rows[0].n === 3);

  // 4. create_cutting_batch: пустой список товаров отклонён, ничего не создаётся
  const issue2 = await db.query(`insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 5, 'Закройщик') returning id`, [colorId]);
  let emptyProductsRejected = false;
  try {
    await db.query(`select * from create_cutting_batch($1, $2, 'factory')`, [issue2.rows[0].id, JSON.stringify([])]);
  } catch (e) {
    emptyProductsRejected = /batch_must_have_products/.test(e.message);
  }
  check('RPC-3: пустой список товаров отклонён', emptyProductsRejected);
  const orphanCheck1 = await db.query(`select count(*)::int as n from cutting_batches where issue_id=$1`, [issue2.rows[0].id]);
  check('RPC-4: после отклонения партия НЕ создалась (issue снова свободна)', orphanCheck1.rows[0].n === 0);

  // 5. create_cutting_batch: товар без единого размера — вся операция откатывается целиком
  const issue3 = await db.query(`insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 5, 'Закройщик') returning id`, [colorId]);
  let noSizesRejected = false;
  try {
    await db.query(`select * from create_cutting_batch($1, $2, 'factory')`, [issue3.rows[0].id, JSON.stringify([
      { product_name: 'Футболка', sizes: [{ size: 'M', quantity: 10 }] },
      { product_name: 'Без размеров', sizes: [] },
    ])]);
  } catch (e) {
    noSizesRejected = /product_must_have_sizes/.test(e.message);
  }
  check('RPC-5: товар без размеров отклонён', noSizesRejected);
  const orphanCheck2 = await db.query(`select count(*)::int as n from cutting_batches where issue_id=$1`, [issue3.rows[0].id]);
  check('RPC-6: ВСЯ операция откатилась — партия не создалась, даже с первым валидным товаром', orphanCheck2.rows[0].n === 0);
  const orphanProducts = await db.query(`select count(*)::int as n from cutting_batch_products where product_name='Футболка' and batch_id not in (select id from cutting_batches)`);
  // (проверка косвенная — просто факт, что cutting_batches пуста для этого issue, уже доказывает атомарность)

  // 6. Ручная вставка "пустой" партии (в обход RPC, как будто кто-то её всё же создал руками)
  //    не должна проходить приёмку — проверка защиты в триггере.
  const issue4 = await db.query(`insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 5, 'Закройщик') returning id`, [colorId]);
  const manualEmptyBatch = await db.query(`insert into cutting_batches (issue_id, shop) values ($1, 'factory') returning id`, [issue4.rows[0].id]);
  await asUser(db, 'master');
  let emptyAcceptRejected = false;
  try {
    await db.query(`update cutting_batches set status='in_sewing' where id=$1`, [manualEmptyBatch.rows[0].id]);
  } catch (e) {
    emptyAcceptRejected = /batch_has_no_items/.test(e.message);
  }
  check('GUARD-1: партию без единого товара теперь нельзя принять (triggер-защита сработала)', emptyAcceptRejected);

  // 7. Приёмка нормальной партии всё ещё работает как раньше (не сломали счастливый путь)
  await asUser(db, 'zakroyshik');
  const issue5 = await db.query(`insert into raw_material_issues (color_id, rolls, taken_by) values ($1, 5, 'Закройщик') returning id`, [colorId]);
  const rpc5 = await db.query(`select * from create_cutting_batch($1, $2, 'factory')`, [issue5.rows[0].id, JSON.stringify([
    { product_name: 'Футболка', sizes: [{ size: 'M', quantity: 10 }] },
  ])]);
  const batchId5 = rpc5.rows[0].out_batch_id;
  const items5 = await db.query(`select cbi.id from cutting_batch_items cbi join cutting_batch_products cbp on cbp.id=cbi.batch_product_id where cbp.batch_id=$1`, [batchId5]);
  await asUser(db, 'master');
  await db.query(`update cutting_batch_items_view set confirmed_quantity=10 where id=$1`, [items5.rows[0].id]);
  const acceptOk = await db.query(`update cutting_batches set status='in_sewing' where id=$1 returning status`, [batchId5]);
  check('GUARD-2: нормальная (непустая) партия по-прежнему успешно принимается', acceptOk.rows[0].status === 'in_sewing');

  // ---------------------------------------------------------------
  // 8. create_order: атомарное создание заказа
  // ---------------------------------------------------------------
  await asUser(db, 'ceo');
  const client = await db.query(`insert into clients (name, phone) values ('Аудит-клиент', '+998900000000') returning id`);
  const prod = await db.query(`insert into products (name, price) values ('Тест-товар', 15000) returning id`);
  const variant = await db.query(`insert into product_variants (product_id, color, size, stock_quantity) values ($1, 'Синий', 'M', 50) returning id`, [prod.rows[0].id]);

  const orderResult = await db.query(
    `select create_order($1, $2, $3) as order_id`,
    [client.rows[0].id, 'тестовый заказ', JSON.stringify([{ variant_id: variant.rows[0].id, quantity: 3 }])]
  );
  const orderId = orderResult.rows[0].order_id;
  check('ORDER-1: create_order вернул id заказа', !!orderId);
  const orderRow = await db.query(`select total from orders where id=$1`, [orderId]);
  check('ORDER-2: total пересчитан триггером = 3 * 15000 = 45000', Number(orderRow.rows[0].total) === 45000);
  const itemsRow = await db.query(`select count(*)::int as n from order_items where order_id=$1`, [orderId]);
  check('ORDER-3: order_items создан', itemsRow.rows[0].n === 1);

  // 9. create_order: пустой список позиций отклонён, заказ НЕ создаётся (нет сироты)
  let emptyItemsRejected = false;
  try {
    await db.query(`select create_order($1, $2, $3)`, [client.rows[0].id, null, JSON.stringify([])]);
  } catch (e) {
    emptyItemsRejected = /order_must_have_items/.test(e.message);
  }
  check('ORDER-4: заказ без единой позиции отклонён', emptyItemsRejected);
  const ordersCountBefore = await db.query(`select count(*)::int as n from orders where client_id=$1`, [client.rows[0].id]);
  check('ORDER-5: после отклонения — заказов-сирот не осталось (было и осталось ровно 1)', ordersCountBefore.rows[0].n === 1);

  // 10. create_order: несуществующий вариант — вся операция откатывается, заказ не создаётся
  let badVariantRejected = false;
  try {
    await db.query(`select create_order($1, $2, $3)`, [
      client.rows[0].id,
      null,
      JSON.stringify([
        { variant_id: variant.rows[0].id, quantity: 1 },
        { variant_id: '00000000-0000-0000-0000-000000000099', quantity: 1 },
      ]),
    ]);
  } catch (e) {
    badVariantRejected = /invalid_variant/.test(e.message);
  }
  check('ORDER-6: несуществующий вариант во втором пункте отклонён', badVariantRejected);
  const ordersCountAfter = await db.query(`select count(*)::int as n from orders where client_id=$1`, [client.rows[0].id]);
  check('ORDER-7: вся операция откатилась целиком — валидная первая позиция НЕ создала сироту', ordersCountAfter.rows[0].n === 1);

  // 11. create_order: кладовщик не может продиктовать свою цену
  await asUser(db, 'kladovshik');
  const orderKl = await db.query(
    `select create_order($1, $2, $3) as order_id`,
    [client.rows[0].id, null, JSON.stringify([{ variant_id: variant.rows[0].id, quantity: 2, price: 999999 }])]
  );
  await asUser(db, 'ceo');
  const itemKl = await db.query(`select price from order_items where order_id=$1`, [orderKl.rows[0].order_id]);
  check('ORDER-8: кладовщик прислал price=999999, но записалась настоящая цена товара (15000)', Number(itemKl.rows[0].price) === 15000);

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.log('FATAL', e.stack);
  process.exit(1);
});
