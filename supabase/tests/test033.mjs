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
  console.log('\n--- 033 применена, проверяю ---\n');

  // --- Кладовщик: может переименовать товар, но не цену/тип склада. ---
  await asUser(db, 'kladovshik');
  const v1 = await db.query(
    `insert into product_variants_view (product_name, color, size, stock_quantity) values ('Футболка-033', 'Белый', 'M', 10) returning id, product_id`
  );
  const v1Id = v1.rows[0].id;
  const productId = v1.rows[0].product_id;

  const v2 = await db.query(
    `insert into product_variants_view (product_name, color, size, stock_quantity) values ('Футболка-033', 'Белый', 'L', 5) returning id`
  );
  const v2Id = v2.rows[0].id;

  const rename1 = await db.query(
    `update product_variants_view set product_name = 'Футболка Премиум-033' where id = $1 returning product_name`,
    [v1Id]
  );
  check('кладовщик может переименовать товар', rename1.rows[0].product_name === 'Футболка Премиум-033');

  const v2After = await db.query(`select product_name from product_variants_view where id = $1`, [v2Id]);
  check(
    'переименование через один вариант меняет имя у ВСЕХ вариантов товара',
    v2After.rows[0].product_name === 'Футболка Премиум-033'
  );

  let kladovshikPriceRejected = false;
  try {
    await db.query(`update product_variants_view set price = 999 where id = $1`, [v1Id]);
  } catch (e) {
    kladovshikPriceRejected = true;
  }
  // Цена у кладовщика всегда null и на select, и в NEW при update (сама
  // view её маскирует) — поэтому не "insufficient_privilege", а просто
  // тихо игнорируется (new.price === old.price === null). Проверяем, что
  // цена в базе не поменялась, а не факт ошибки (смотрим от лица CEO —
  // у кладовщика нет прямого select на products).
  await asUser(db, 'ceo');
  const priceAfter = await db.query(`select price from products where id = $1`, [productId]);
  check('кладовщик не может выставить цену через это же обновление', Number(priceAfter.rows[0].price) === 0, priceAfter.rows[0].price);
  await asUser(db, 'kladovshik');

  let kladovshikColorRejected = false;
  try {
    await db.query(`update product_variants_view set color = 'Красный', product_name = 'Взлом-033' where id = $1`, [v1Id]);
  } catch (e) {
    kladovshikColorRejected = /insufficient_privilege/.test(e.message);
  }
  check('кладовщик не может поменять цвет заодно с названием (единая проверка полей)', kladovshikColorRejected);

  let emptyNameRejected = false;
  try {
    await db.query(`update product_variants_view set product_name = '   ' where id = $1`, [v1Id]);
  } catch (e) {
    emptyNameRejected = /product_name_required/.test(e.message);
  }
  check('пустое название отклоняется', emptyNameRejected);

  // --- Конфликт имён: переименование в уже существующее чужое название. ---
  await db.query(
    `insert into product_variants_view (product_name, color, size, stock_quantity) values ('Штаны-033', 'Чёрный', 'M', 1)`
  );
  let duplicateRejected = false;
  try {
    await db.query(`update product_variants_view set product_name = 'Штаны-033' where id = $1`, [v1Id]);
  } catch (e) {
    duplicateRejected = /duplicate key|unique/i.test(e.message);
  }
  check('переименование в уже существующее название отклоняется (уникальный индекс)', duplicateRejected);

  // --- CEO: может переименовать и поменять тип склада, как раньше, но
  // НЕ цену через этот путь — с 036_pricing_and_receipts.sql цена
  // меняется только напрямую через products ("Финансы → Цены").
  await asUser(db, 'ceo');
  const rename2 = await db.query(
    `update product_variants_view set product_name = 'Футболка CEO-033' where id = $1 returning product_name`,
    [v1Id]
  );
  check('CEO может переименовать товар', rename2.rows[0].product_name === 'Футболка CEO-033');

  let ceoPriceViaVariantRejected = false;
  try {
    await db.query(`update product_variants_view set price = 15000 where id = $1`, [v1Id]);
  } catch (e) {
    ceoPriceViaVariantRejected = /price_set_only_in_finance/.test(e.message);
  }
  check('CEO больше не может менять цену через product_variants_view (только "Цены")', ceoPriceViaVariantRejected);

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.log('FATAL', e.message);
  process.exit(1);
});
