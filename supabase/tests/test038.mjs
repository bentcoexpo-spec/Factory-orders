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
async function rejects(db, sql, params, re) {
  try {
    await db.query(sql, params);
    return false;
  } catch (e) {
    return re.test(e.message);
  }
}

async function main() {
  const db = await buildDb({ log: false });
  console.log('\n--- 038 применена, проверяю ---\n');

  await asUser(db, 'ceo');

  // --- Подготовка: товар с ценой, два клиента разных рынков, один без категории.
  const v = await db.query(
    `insert into product_variants_view (product_name, color, size, stock_quantity) values ('Тест-038', 'Белый', 'M', 1000) returning id, product_id`
  );
  await db.query(`update products set price = 1000 where id = $1`, [v.rows[0].product_id]);
  const local = (await db.query(`insert into clients (name, category) values ('Локальный', 'local') returning id`)).rows[0].id;
  const expo = (await db.query(`insert into clients (name, category) values ('Экспортный', 'expo') returning id`)).rows[0].id;
  const nocat = (await db.query(`insert into clients (name) values ('Без категории') returning id`)).rows[0].id;

  async function issue(clientId, qty) {
    const id = (
      await db.query(`select create_order($1, null, $2) as id`, [
        clientId,
        JSON.stringify([{ variant_id: v.rows[0].id, quantity: qty }]),
      ])
    ).rows[0].id;
    await db.query(`update orders_view set status = 'issued' where id = $1`, [id]);
    return id;
  }
  await issue(local, 10); // 10 000
  await issue(expo, 5); // 5 000
  await issue(nocat, 2); // 2 000
  const returned = await issue(local, 1);
  await db.query(`update orders_view set status = 'returned' where id = $1`, [returned]);

  // --- Оплаты: дата вручную, правка, фото, аудит.
  const pay = await db.query(
    `insert into client_payments_view (client_id, amount, comment, paid_at) values ($1, 4000, 'нал', '2020-01-15') returning id, paid_at`,
    [local]
  );
  const payId = pay.rows[0].id;
  const payRow = (await db.query(`select * from client_payments_view where id = $1`, [payId])).rows[0];
  check('оплата сохранила введённую вручную дату', String(payRow.paid_at).includes('2020-01-15') || payRow.paid_at?.toISOString?.().startsWith('2020-01-15'), payRow.paid_at);
  check('view оплат отдаёт имя и категорию клиента', payRow.client_name === 'Локальный' && payRow.client_category === 'local');

  const payDefault = await db.query(
    `insert into client_payments_view (client_id, amount) values ($1, 1000) returning id`,
    [local]
  );
  const defRow = (await db.query(`select paid_at from client_payments_view where id = $1`, [payDefault.rows[0].id])).rows[0];
  check('без даты подставляется сегодня', !!defRow.paid_at);

  await db.query(`update client_payments_view set amount = 4500, comment = 'нал+', paid_at = '2020-01-16' where id = $1`, [payId]);
  const edited = (await db.query(`select amount, updated_at from client_payments_view where id = $1`, [payId])).rows[0];
  check('правка оплаты сохранилась и проставила updated_at', Number(edited.amount) === 4500 && !!edited.updated_at, JSON.stringify(edited));
  check(
    'смена клиента в оплате запрещена',
    await rejects(db, `update client_payments_view set client_id = $1 where id = $2`, [expo, payId], /payment_client_immutable/)
  );

  await db.query(`insert into payment_photos (payment_id, photo_path) values ($1, 'payments/x/1.jpg')`, [payId]);
  await db.query(`insert into payment_photos (payment_id, photo_path) values ($1, 'payments/x/2.jpg')`, [payId]);
  const cnt = (await db.query(`select photo_count from client_payments_view where id = $1`, [payId])).rows[0];
  check('у оплаты несколько фото (photo_count = 2)', cnt.photo_count === 2, cnt.photo_count);

  // --- Расходы: оплатили сразу и в долг, погашения частями.
  const paidExp = (
    await db.query(
      `insert into expenses (title, amount, spent_at, payment_kind, market) values ('Нитки', 2000, current_date, 'paid', 'local') returning id`
    )
  ).rows[0].id;
  const creditExp = (
    await db.query(
      `insert into expenses (title, amount, spent_at, payment_kind, supplier, market) values ('Ткань', 9000, current_date, 'credit', 'ООО Ткани', 'expo') returning id`
    )
  ).rows[0].id;
  const generalExp = (
    await db.query(
      `insert into expenses (title, amount, spent_at, payment_kind) values ('Аренда', 3000, current_date, 'paid') returning id`
    )
  ).rows[0].id;

  check(
    'погашение у расхода «оплатили сразу» запрещено',
    await rejects(db, `insert into expense_repayments (expense_id, amount) values ($1, 100)`, [paidExp], /expense_not_credit/)
  );
  await db.query(`insert into expense_repayments (expense_id, amount) values ($1, 3000)`, [creditExp]);
  await db.query(`insert into expense_repayments (expense_id, amount) values ($1, 1000)`, [creditExp]);
  const ev = (await db.query(`select repaid_total, debt_left from expenses_view where id = $1`, [creditExp])).rows[0];
  check('погашено 4000, осталось 5000', Number(ev.repaid_total) === 4000 && Number(ev.debt_left) === 5000, JSON.stringify(ev));
  check(
    'погашение больше остатка отклонено',
    await rejects(db, `insert into expense_repayments (expense_id, amount) values ($1, 5001)`, [creditExp], /repayment_exceeds_debt/)
  );
  check(
    'уменьшить сумму расхода ниже погашенного нельзя',
    await rejects(db, `update expenses set amount = 3000 where id = $1`, [creditExp], /expense_amount_below_repaid/)
  );
  check(
    'перевести расход с погашениями в «оплатили сразу» нельзя',
    await rejects(db, `update expenses set payment_kind = 'paid' where id = $1`, [creditExp], /expense_has_repayments/)
  );
  check(
    'расход с нулевой суммой отклонён',
    await rejects(db, `insert into expenses (title, amount, payment_kind) values ('X', 0, 'paid')`, [], /expenses_amount_check/)
  );
  check(
    'неизвестный рынок расхода отклонён',
    await rejects(db, `insert into expenses (title, amount, payment_kind, market) values ('X', 1, 'paid', 'moon')`, [], /expenses_market_check/)
  );
  await db.query(`insert into expense_photos (expense_id, photo_path) values ($1, 'expenses/x/1.jpg')`, [creditExp]);

  // --- Сводка: все периоды = сегодняшний месяц для расходов, 2020-01 для оплаты.
  const today = (await db.query(`select to_char(current_date, 'YYYY-MM-DD') as d`)).rows[0].d;
  const monthStart = today.slice(0, 8) + '01';

  const sumAll = (await db.query(`select finance_summary($1, $2, 'all') as s`, [monthStart, today])).rows[0].s;
  check('Продали (все) = 10000+5000+2000, возврат не считается', Number(sumAll.sold) === 17000, sumAll.sold);
  check('Получили за текущий месяц (все) = 1000 (оплата 2020 вне периода)', Number(sumAll.received) === 1000, sumAll.received);
  // Потратили: paid 2000 + 3000 + погашения 4000 = 9000
  check('Потратили (все) = 2000+3000 оплачено + 4000 погашено = 9000', Number(sumAll.spent) === 9000, sumAll.spent);
  check('Осталось = Получили − Потратили', Number(sumAll.left) === Number(sumAll.received) - Number(sumAll.spent), sumAll.left);
  check('Нам должны (все): 10000−(4500+1000) + 5000 + 2000 = 11500', Number(sumAll.owed_to_us) === 11500, sumAll.owed_to_us);
  check('Мы должны (все) = 5000', Number(sumAll.we_owe) === 5000, sumAll.we_owe);
  check('в месячном ряду 12 месяцев', sumAll.months.length === 12, sumAll.months.length);
  check('топ должников отсортирован по убыванию', sumAll.top_debtors.length >= 2 && Number(sumAll.top_debtors[0].debt) >= Number(sumAll.top_debtors[1].debt));

  const sumLocal = (await db.query(`select finance_summary($1, $2, 'local') as s`, [monthStart, today])).rows[0].s;
  check('Продали (внутренний рынок) = 10000', Number(sumLocal.sold) === 10000, sumLocal.sold);
  check('Потратили (внутренний) = только расход с меткой local = 2000', Number(sumLocal.spent) === 2000, sumLocal.spent);
  check('Мы должны (внутренний) = 0 — долговой расход с меткой expo', Number(sumLocal.we_owe) === 0, sumLocal.we_owe);

  const sumExpo = (await db.query(`select finance_summary($1, $2, 'expo') as s`, [monthStart, today])).rows[0].s;
  check('Продали (экспорт) = 5000', Number(sumExpo.sold) === 5000, sumExpo.sold);
  check('Потратили (экспорт) = погашения 4000', Number(sumExpo.spent) === 4000, sumExpo.spent);
  check('Мы должны (экспорт) = 5000', Number(sumExpo.we_owe) === 5000, sumExpo.we_owe);

  const sum2020 = (await db.query(`select finance_summary('2020-01-01', '2020-01-31', 'all') as s`)).rows[0].s;
  check('период 2020-01: получили 4500 (отредактированная оплата)', Number(sum2020.received) === 4500, sum2020.received);
  check('период 2020-01: продали 0', Number(sum2020.sold) === 0, sum2020.sold);

  check(
    'неизвестный рынок в сводке отклонён',
    await rejects(db, `select finance_summary($1, $2, 'moon')`, [monthStart, today], /invalid_market/)
  );

  // --- Чеки с категорией.
  const rec = (await db.query(`select client_category, status, total from finance_receipts_view order by total`)).rows;
  check('в чеках 4 записи: 3 выдано + 1 возврат', rec.length === 4, rec.length);
  check('в чеках есть и возврат', rec.some((r) => r.status === 'returned'));
  const items = (await db.query(`select product_name, quantity, price, line_total, client_category from finance_receipt_items_view where client_category = 'expo'`)).rows;
  check('детализация чека: товар/кол-во/цена/сумма по строке', items.length === 1 && Number(items[0].line_total) === 5000, JSON.stringify(items));

  // --- Аудит: всё записано, у удаления — снимок строки.
  await db.query(`delete from expense_repayments where expense_id = $1 and amount = 1000`, [creditExp]);
  await db.query(`delete from client_payments_view where id = $1`, [payDefault.rows[0].id]);
  await db.query(`delete from expenses where id = $1`, [creditExp]); // каскад: погашения + фото

  const log = (await db.query(`select entity_type, action, actor from finance_audit_log where entity_type in ('client_payments','expenses','expense_repayments','payment_photos','expense_photos')`)).rows;
  const has = (t, a) => log.some((r) => r.entity_type === t && r.action === a);
  check('аудит: оплата создана/изменена/удалена', has('client_payments', 'insert') && has('client_payments', 'update') && has('client_payments', 'delete'));
  check('аудит: расход создан и удалён', has('expenses', 'insert') && has('expenses', 'delete'));
  check('аудит: погашения созданы и удалены (в т.ч. каскадом)', has('expense_repayments', 'insert') && has('expense_repayments', 'delete'));
  check('аудит: фото добавлены/удалены', has('payment_photos', 'insert') && has('expense_photos', 'insert') && has('expense_photos', 'delete'));
  check('аудит: у записей есть автор', log.every((r) => !!r.actor));
  const upd = (await db.query(`select detail from finance_audit_log where entity_type = 'client_payments' and action = 'update' limit 1`)).rows[0];
  check('аудит правки хранит old и new', upd.detail.old && upd.detail.new && Number(upd.detail.old.amount) === 4000 && Number(upd.detail.new.amount) === 4500, JSON.stringify(upd.detail));
  const del = (await db.query(`select detail from finance_audit_log where entity_type = 'expenses' and action = 'delete' limit 1`)).rows[0];
  check('аудит удаления хранит снимок строки', del.detail.title === 'Ткань' && Number(del.detail.amount) === 9000, JSON.stringify(del.detail));

  // --- Доступ других ролей.
  for (const role of ['kladovshik', 'zakroyshik', 'master']) {
    await asUser(db, role);
    const rows = await Promise.all([
      db.query(`select * from expenses_view`),
      db.query(`select * from client_payments_view`),
      db.query(`select * from finance_receipts_view`),
      db.query(`select * from finance_receipt_items_view`),
      db.query(`select * from expense_photos`),
      db.query(`select * from payment_photos`),
      db.query(`select * from finance_audit_log`),
    ]);
    check(`${role}: не видит ни одной финансовой строки (RLS + security_invoker)`, rows.every((r) => r.rows.length === 0), rows.map((r) => r.rows.length).join(','));
    check(`${role}: сводку получить не может`, await rejects(db, `select finance_summary($1, $2, 'all')`, [monthStart, today], /insufficient_privilege/));
    check(`${role}: создать расход не может`, await rejects(db, `insert into expenses (title, amount, payment_kind) values ('X', 1, 'paid')`, [], /insufficient_privilege|row-level security/));
    check(`${role}: добавить оплату не может`, await rejects(db, `insert into client_payments_view (client_id, amount) values ($1, 1)`, [local], /insufficient_privilege|row-level security/));
  }

  // --- Хранилище: бакет приватный, лимит, политика только для CEO.
  await db.query('reset role');
  const bucket = (await db.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'finance-receipts'`)).rows[0];
  check('бакет finance-receipts приватный, 10 МБ, только изображения', bucket && bucket.public === false && Number(bucket.file_size_limit) === 10485760 && bucket.allowed_mime_types[0] === 'image/*', JSON.stringify(bucket));
  const pol = (await db.query(`select qual from pg_policies where policyname = 'finance_receipts_storage_ceo'`)).rows[0];
  check('политика хранилища ограничена ролью ceo', pol && /ceo/.test(pol.qual), pol?.qual);

  const reloptions = (await db.query(`select relname, reloptions from pg_class where relname in ('client_payments_view','expenses_view','finance_receipts_view','finance_receipt_items_view')`)).rows;
  check('все 4 view с security_invoker=true', reloptions.length === 4 && reloptions.every((r) => (r.reloptions ?? []).includes('security_invoker=true')), JSON.stringify(reloptions));

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
