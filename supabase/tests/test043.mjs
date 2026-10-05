import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildDb, asUser as asUserRaw } from './build_master.mjs';

let currentRole = 'ceo';
const asUser = async (db, role) => {
  currentRole = role;
  await asUserRaw(db, role);
};
// Прямое чтение таблиц (ей кладовщик не доступен) — от имени администратора базы, затем роль возвращается.
const admin = async (db, sql, params) => {
  await db.query('reset role');
  try {
    return await db.query(sql, params);
  } finally {
    await asUserRaw(db, currentRole);
  }
};

let passed = 0;
let failed = 0;
function check(name, cond, evidence) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  ПРОВАЛ:', name, evidence !== undefined ? `(${evidence})` : '');
  }
}
async function fails(db, sql, params, re) {
  try {
    await db.query(sql, params);
    return false;
  } catch (e) {
    return re.test(e.message);
  }
}
const adminFails = async (sql, params, re) => {
  try {
    await admin(globalThis.__db, sql, params);
    return false;
  } catch (e) {
    return re.test(e.message);
  }
};
const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(resolve(here, '../maintenance', f), 'utf8');

async function main() {
  const db = await buildDb({ log: false });
  globalThis.__db = db;
  console.log('\n--- 042: архив вариантов и размеры ---\n');

  // ================= canonical_size =================
  await db.query('reset role');
  const cs = async (s) => (await db.query(`select public.canonical_size($1) as c`, [s])).rows[0].c;
  check('XXL остаётся XXL', (await cs('XXL')) === 'XXL');
  check('2XL → XXL', (await cs('2XL')) === 'XXL');
  check('XXXL остаётся XXXL', (await cs('XXXL')) === 'XXXL');
  check('3XL → XXXL', (await cs('3XL')) === 'XXXL');
  check('XXXXL → 4XL (с четырёх — цифрой)', (await cs('XXXXL')) === '4XL');
  check('4XL остаётся 4XL', (await cs('4XL')) === '4XL');
  check('XXXXXL → 5XL, 5XL остаётся', (await cs('XXXXXL')) === '5XL' && (await cs('5XL')) === '5XL');
  check('xxl (строчные) → XXL', (await cs('xxl')) === 'XXL');
  check('«2 xl» с пробелом → XXL', (await cs('2 xl')) === 'XXL');
  check('кириллица ХХЛ → XXL', (await cs('ХХЛ')) === 'XXL');
  check('XL, L, M, S, XS, XXS, 42, NULL не меняются', (await Promise.all(['XL', 'L', 'M', 'S', 'XS', 'XXS', '42'].map(cs))).join() === 'XL,L,M,S,XS,XXS,42' && (await cs(null)) === null);

  await asUser(db, 'ceo');

  // ================= триггер размера =================
  const a = (await db.query(`insert into product_variants_view (product_name, color, size, stock_quantity) values ('Футболка-043', 'Белый', '2XL', 0) returning id, size`)).rows[0];
  check('при создании «2XL» хранится как XXL (и возвращается так же)', a.size === 'XXL', a.size);
  check('создать «XXL» и «2XL» одного товара/цвета нельзя — это один размер', await fails(db, `insert into product_variants_view (product_name, color, size, stock_quantity) values ('Футболка-043', 'Белый', 'XXL', 0)`, [], /duplicate key|unique/i));
  check('«3XL» хранится как XXXL, а «XXXL» после него — дубль', (await db.query(`insert into product_variants_view (product_name, color, size) values ('Футболка-043', 'Белый', '3XL') returning size`)).rows[0].size === 'XXXL' && (await fails(db, `insert into product_variants_view (product_name, color, size) values ('Футболка-043', 'Белый', 'XXXL')`, [], /duplicate key|unique/i)));
  // прямой insert в таблицу (как делает бот под service_role) тоже приводится
  const direct = (await db.query(`insert into product_variants (product_id, color, size, print_type, unit, stock_quantity) select product_id, 'Чёрный', '2XL', 'без печати', 'шт', 5 from product_variants where id = $1 returning size`, [a.id])).rows[0];
  check('прямой insert в таблицу (бот) тоже даёт XXL', direct.size === 'XXL', direct.size);
  const x4 = (await db.query(`insert into product_variants_view (product_name, color, size) values ('Футболка-043', 'Белый', 'XXXXL') returning size`)).rows[0];
  check('«XXXXL» хранится как 4XL', x4.size === '4XL', x4.size);

  // ================= удаление варианта =================
  const mk = async (color, size, stock = 0) => (await db.query(`insert into product_variants_view (product_name, color, size, stock_quantity) values ('Склад-043', $1, $2, $3) returning id`, [color, size, stock])).rows[0].id;
  const client = (await db.query(`insert into clients (name) values ('Клиент-043') returning id`)).rows[0].id;
  const exists = async (id) => (await admin(db, `select archived_at from product_variants where id = $1`, [id])).rows;
  const visible = async (id) => (await db.query(`select 1 from product_variants_view where id = $1`, [id])).rows.length;

  for (const role of ['ceo', 'kladovshik']) {
    await asUser(db, role);
    const label = role === 'ceo' ? 'CEO' : 'кладовщик';

    const stocked = await mk(`С остатком ${role}`, 'M', 7);
    check(`${label}: остаток > 0 — «Сначала обнулите остаток»`, await fails(db, `delete from product_variants_view where id = $1`, [stocked], /variant_has_stock.*Сначала обнулите остаток/));
    check(`${label}: и вариант остался на месте`, (await visible(stocked)) === 1);

    const clean = await mk(`Чистый ${role}`, 'M', 0);
    await db.query(`delete from product_variants_view where id = $1`, [clean]);
    check(`${label}: остаток 0, истории нет — удалён полностью`, (await exists(clean)).length === 0);

    // с приходом
    const withReceipt = await mk(`Приход ${role}`, 'L', 0);
    await db.query(`insert into stock_receipts (variant_id, packs, units_per_pack, loose_units) values ($1, 0, 0, 10)`, [withReceipt]);
    await db.query(`update product_variants_view set stock_quantity = 0 where id = $1`, [withReceipt]);
    await db.query(`delete from product_variants_view where id = $1`, [withReceipt]);
    const r1 = await exists(withReceipt);
    check(`${label}: остаток 0 + приход — архивирован, не удалён`, r1.length === 1 && r1[0].archived_at !== null);
    check(`${label}: скрыт из product_variants_view (Склад/Приход/заказ/бот)`, (await visible(withReceipt)) === 0);
    check(`${label}: приход остался в таблице`, (await admin(db, `select count(*)::int as n from stock_receipts where variant_id = $1`, [withReceipt])).rows[0].n === 1);

    // с заказом
    await asUser(db, 'ceo');
    const withOrder = await mk(`Заказ ${role}`, 'S', 20);
    const order = (await db.query(`select create_order($1, null, $2) as id`, [client, JSON.stringify([{ variant_id: withOrder, quantity: 20 }])])).rows[0].id;
    await db.query(`update orders_view set status = 'issued' where id = $1`, [order]);
    await asUser(db, role);
        await asUser(db, 'ceo');
    await db.query(`update product_variants set stock_quantity = 0 where id = $1`, [withOrder]);
    await asUser(db, role);
    await db.query(`delete from product_variants_view where id = $1`, [withOrder]);
    check(`${label}: остаток 0 + заказ — архивирован`, (await exists(withOrder))[0]?.archived_at !== null);

    // история и чеки целы
    await asUser(db, 'ceo');
    const line = (await db.query(`select product_name, quantity from order_items_view where variant_id = $1`, [withOrder])).rows;
    check(`${label}: в заказе имя товара и количество на месте (order_items_view)`, line.length === 1 && line[0].product_name === 'Склад-043' && Number(line[0].quantity) === 20, JSON.stringify(line));
    const receipt = (await db.query(`select product_name, size from finance_receipt_items_view where order_id = $1`, [order])).rows;
    check(`${label}: выданный чек не изменился (finance_receipt_items_view)`, receipt.length === 1 && receipt[0].product_name === 'Склад-043' && receipt[0].size === 'S', JSON.stringify(receipt));
    const rcpt = (await db.query(`select product_name from stock_receipts_view where variant_id = $1`, [withReceipt])).rows;
    check(`${label}: история прихода читается (stock_receipts_view)`, rcpt.length === 1 && rcpt[0].product_name === 'Склад-043', JSON.stringify(rcpt));

    // возврат скрытого
    await asUser(db, role);
    const back = (await db.query(`insert into product_variants_view (product_name, color, size, stock_quantity) values ('Склад-043', $1, 'L', 12) returning id`, [`Приход ${role}`])).rows[0].id;
    check(`${label}: добавили тот же товар/цвет/размер — вернулся тот же вариант, дубля нет`, back === withReceipt && (await admin(db, `select count(*)::int as n from product_variants where product_id = (select product_id from product_variants where id = $1) and color = $2 and size = 'L'`, [withReceipt, `Приход ${role}`])).rows[0].n === 1);
    const restored = (await admin(db, `select archived_at, stock_quantity from product_variants where id = $1`, [withReceipt])).rows[0];
    check(`${label}: вариант снова виден и с новым остатком 12`, restored.archived_at === null && Number(restored.stock_quantity) === 12 && (await visible(withReceipt)) === 1);
    check(`${label}: его старый приход по-прежнему привязан`, (await admin(db, `select count(*)::int as n from stock_receipts where variant_id = $1`, [withReceipt])).rows[0].n === 1);
    // возврат под другим написанием размера: «XXL» = «2XL»
    await db.query(`delete from product_variants_view where id = $1`, [back]).catch(() => {});
  }

  // ===== возврат архивного через «другое написание» размера
  await asUser(db, 'ceo');
  const big = await mk('Большой', '2XL', 0); // хранится как XXL
  await db.query(`insert into stock_receipts (variant_id, packs, units_per_pack, loose_units) values ($1, 0, 0, 3)`, [big]);
  await db.query(`update product_variants set stock_quantity = 0 where id = $1`, [big]);
  await db.query(`delete from product_variants_view where id = $1`, [big]);
  const big2 = (await db.query(`insert into product_variants_view (product_name, color, size, stock_quantity) values ('Склад-043', 'Большой', 'XXL', 4) returning id`)).rows[0].id;
  check('скрытый «XXL» (создан как 2XL) возвращается при добавлении «XXL» — тот же id', big2 === big);

  // ===== защита в базе: архивный вариант нельзя заказать / принять
  await asUser(db, 'ceo');
  const arch = await mk('Для защиты', 'M', 0);
  await db.query(`insert into stock_receipts (variant_id, packs, units_per_pack, loose_units) values ($1, 0, 0, 1)`, [arch]);
  await db.query(`update product_variants set stock_quantity = 0 where id = $1`, [arch]);
  await db.query(`delete from product_variants_view where id = $1`, [arch]);
  check('create_order отказывает для архивного варианта', await fails(db, `select create_order($1, null, $2)`, [client, JSON.stringify([{ variant_id: arch, quantity: 1 }])], /invalid_variant/));
  check('приход по архивному варианту отказывает', await fails(db, `insert into stock_receipts (variant_id, packs, units_per_pack, loose_units) values ($1, 0, 0, 5)`, [arch], /variant_archived/));

  // ===== другие роли и прямой доступ
  for (const role of ['zakroyshik', 'master']) {
    await asUser(db, role);
    check(`${role}: удалить вариант нельзя`, await fails(db, `delete from product_variants_view where id = $1`, [arch], /insufficient_privilege/) || (await db.query(`select 1 from product_variants_view`)).rows.length === 0);
  }
  await asUser(db, 'kladovshik');
  const directDel = await db.query(`delete from product_variants where id = $1 returning id`, [arch]).then((r) => r.rows.length, () => 0);
  check('кладовщик не может удалить вариант прямо из таблицы (в обход правил)', directDel === 0);

  // ================= список дублей и объединение =================
  await asUser(db, 'ceo');
  await db.query('reset role');
  // создаём старые «грязные» дубли минуя триггер (как они жили до миграции)
  await db.query(`alter table product_variants disable trigger product_variants_canonical_size_trg`);
  const pid = (await db.query(`insert into products (name, price) values ('Дубли-043', 1000) returning id`)).rows[0].id;
  const mkv = async (color, size, stock) => (await db.query(`insert into product_variants (product_id, color, size, print_type, unit, stock_quantity) values ($1, $2, $3, 'без печати', 'шт', $4) returning id`, [pid, color, size, stock])).rows[0].id;
  const xxl = await mkv('Синий', 'XXL', 10);
  const x2 = await mkv('Синий', '2XL', 5);
  const xxxl = await mkv('Синий', 'XXXL', 3);
  const x3 = await mkv('Синий', '3XL', 0);
  const lone = await mkv('Красный', 'XXL', 9); // без пары — дублем не считается
  const g4a = await mkv('Зелёный', 'XXXXL', 2);
  const g4b = await mkv('Зелёный', '4XL', 1);
  await db.query(`alter table product_variants enable trigger product_variants_canonical_size_trg`);
  const ord = (await db.query(`insert into orders (client_id, status, total) values ($1, 'issued', 0) returning id`, [client])).rows[0].id;
  await db.query(`insert into order_items (order_id, variant_id, quantity, price) values ($1, $2, 4, 1000), ($1, $3, 6, 1000)`, [ord, xxl, x2]);
  await db.query(`insert into stock_receipts (variant_id, packs, units_per_pack, loose_units) values ($1, 0, 0, 2), ($2, 0, 0, 7)`, [xxl, x2]);

  const list = (await db.query(read('list_duplicate_sizes.sql'))).rows;
  const ours = list.filter((r) => r['Товар'] === 'Дубли-043');
  check('список дублей: 6 вариантов в 3 группах (XXL+2XL, XXXL+3XL, XXXXL+4XL), одинокий «Красный XXL» не попал', ours.length === 6 && !ours.some((r) => r['Цвет'] === 'Красный') && new Set(ours.map((r) => r['Группа №'])).size === 3, JSON.stringify(ours.map((r) => [r['Группа №'], r['Цвет'], r['Размер (как записан)'], r['Это размер']])));
  check('«Это размер» в списке: XXL, XXXL, 4XL', [...new Set(ours.map((r) => r['Это размер']))].sort().join() === '4XL,XXL,XXXL');
  const rowOf = (size) => ours.find((r) => r['Размер (как записан)'] === size && r['Цвет'] === 'Синий');
  check('в списке видны остаток, приходы и строки заказов каждого варианта', Number(rowOf('XXL')['Остаток']) === 12 && Number(rowOf('XXL')['Приходов']) === 1 && Number(rowOf('XXL')['Строк в заказах']) === 1 && rowOf('XXL')['История'] === 'есть' && Number(rowOf('XXXL')['Приходов']) === 0 && rowOf('XXXL')['История'] === 'нет', JSON.stringify(rowOf('XXL')));
  check('список ничего не меняет (только select)', !/\b(insert|update|delete|drop|alter|truncate)\b/i.test(read('list_duplicate_sizes.sql').replace(/--.*$/gm, '')));

  await db.exec(read('merge_duplicate_sizes.sql').split('-- ПРЕДПРОСМОТР')[0]); // создаёт только функцию
  const mergeFile = read('merge_duplicate_sizes.sql');
  const previewSql = mergeFile.slice(mergeFile.lastIndexOf('with v as (')).replace(/;\s*$/, '');
  const preview = (await db.query(previewSql)).rows.filter((r) => r['Товар'] === 'Дубли-043');
  check('предпросмотр: 3 пары к объединению, каждая — суммарный остаток и готовая команда', preview.length === 3 && preview.every((r) => /merge_variants/.test(r['Команда'])), JSON.stringify(preview.map((r) => [r['Оставить (размер)'], r['Убрать (размер)'], r['Станет']])));
  const pXL = preview.find((r) => r['Оставить (размер)'] === 'XXL');
  check('предпросмотр: оставляется вариант, уже записанный как XXL (убирается 2XL); станет 24', pXL && pXL['Убрать (размер)'] === '2XL' && Number(pXL['Станет']) === 24, JSON.stringify(pXL));
  const p4 = preview.find((r) => r['Оставить (размер)'] === '4XL');
  check('предпросмотр: для четвёртого размера оставляется 4XL (убирается XXXXL)', p4 && p4['Убрать (размер)'] === 'XXXXL' && Number(p4['Станет']) === 3, JSON.stringify(p4));

  const before = (await db.query(`select (select sum(stock_quantity) from product_variants where product_id = $1) as s, (select count(*) from stock_receipts where variant_id in ($2,$3,$4,$5)) as r, (select count(*) from order_items where variant_id in ($2,$3,$4,$5)) as l`, [pid, xxl, x2, xxxl, x3])).rows[0];
  const res = (await admin(db, `select public.merge_variants($1, $2) as r`, [xxl, x2])).rows[0].r;
  check('объединение 2XL → XXL: остаток 24 (12 + 12), приходов 2, строк заказов 2', Number(res.stock) === 24 && res.receipts === 2 && res.order_lines === 2, JSON.stringify(res));
  check('«2XL» удалён, «XXL» остался и содержит всё; размер записан как XXL', (await exists(x2)).length === 0 && (await exists(xxl)).length === 1 && res.size === 'XXL');
  check('чек остался: обе строки теперь на XXL, количество 4 и 6, цены не тронуты', (await db.query(`select count(*)::int as n, sum(quantity) as q, min(price) as p from order_items where variant_id = $1`, [xxl])).rows.map((r) => `${r.n}/${r.q}/${r.p}`)[0] === '2/10.00/1000.00');
  await admin(db, `select public.merge_variants($1, $2)`, [xxxl, x3]);
  check('вторая пара: XXXL (остаток 3) + 3XL (0) → один вариант XXXL, остаток 3', (await exists(x3)).length === 0 && Number((await admin(db, `select stock_quantity from product_variants where id = $1`, [xxxl])).rows[0].stock_quantity) === 3);
  await admin(db, `select public.merge_variants($1, $2)`, [g4b, g4a]);
  check('третья пара: XXXXL (2) + 4XL (1) → один вариант 4XL, остаток 3', (await exists(g4a)).length === 0 && Number((await admin(db, `select stock_quantity from product_variants where id = $1`, [g4b])).rows[0].stock_quantity) === 3);
  check('всего остаток по товару не изменился (до = после)', Number((await db.query(`select sum(stock_quantity) as s from product_variants where product_id = $1`, [pid])).rows[0].s) === Number(before.s));
  check('после объединения дублей в списке нет', (await db.query(read('list_duplicate_sizes.sql'))).rows.filter((r) => r['Товар'] === 'Дубли-043').length === 0);

  check('объединить НЕ дубли (разные цвета) нельзя', await adminFails(`select public.merge_variants($1, $2)`, [xxl, lone], /merge_not_duplicates/));
  check('объединить с самим собой нельзя', await adminFails(`select public.merge_variants($1, $1)`, [xxl], /merge_same_variant/));
  // функция недоступна приложению
  await asUser(db, 'ceo');
  check('merge_variants недоступна приложению (CEO через сайт)', await fails(db, `select public.merge_variants($1, $2)`, [xxl, xxxl], /permission denied/));

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
