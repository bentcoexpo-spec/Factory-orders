import { newDb, applyMigrations } from './build019.mjs';
import { UIDS, asUser } from './build_master.mjs';

// Миграция 051: переключение цеха мастером в боте, уведомления о новых записях из обоих
// цехов и действия над одной записью из уведомления (any_shop).

let passed = 0;
let failed = 0;
function check(name, cond, evidence) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  ПРОВАЛ:', name, evidence !== undefined ? `(${String(evidence).slice(0, 260)})` : '');
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
let current = 'master';
const as = async (db, role) => {
  current = role;
  await asUser(db, role);
};
const admin = async (db, sql, params) => {
  await db.query('reset role');
  try {
    return await db.query(sql, params);
  } finally {
    await asUser(db, current);
  }
};
const svc = async (db, sql, params) => {
  await db.query('reset role');
  await db.query('set role service_role');
  try {
    return await db.query(sql, params);
  } finally {
    await db.query('reset role');
    await asUser(db, current);
  }
};
const bot = async (db, tg, fn, p = {}) => (await svc(db, `select public.bot_as_staff($1, $2, $3::jsonb) as r`, [tg, fn, JSON.stringify(p)])).rows[0].r;
const botFails = async (db, tg, fn, p, re) => {
  try {
    await bot(db, tg, fn, p);
    return false;
  } catch (e) {
    return re.test(e.message);
  }
};

async function main() {
  const db = await newDb();
  await applyMigrations(db);
  await db.query('alter role service_role bypassrls');
  for (const [role, uid] of Object.entries(UIDS)) {
    await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [uid, `${role}@test.test`]);
    await db.query(`insert into profiles (id, email, role) values ($1, $2, $3) on conflict (id) do update set role = excluded.role`, [uid, `${role}@test.test`, role]);
  }
  // второй мастер (работает в «Цехе»)
  const M2 = '00000000-0000-0000-0000-0000000000b2';
  await db.query(`insert into auth.users (id, email) values ($1, 'master2@test.test')`, [M2]);
  await db.query(`insert into profiles (id, email, role, current_shop) values ($1, 'master2@test.test', 'master', 'workshop')`, [M2]);
  await db.query(`update profiles set current_shop = 'factory' where id = $1`, [UIDS.master]);
  await asUser(db, 'ceo');
  await db.query('reset role');

  const pSew = (await db.query(`insert into professions (name) values ('Швея') returning id`)).rows[0].id;
  const mT = (await db.query(`insert into catalog_models (profession_id, name) values ($1, 'Футболка') returning id`, [pSew])).rows[0].id;
  const oOver = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Оверлок', 120) returning id`, [mT])).rows[0].id;
  const eF = (await db.query(`insert into employees (name, shop, profession_id) values ('Фабричный', 'factory', $1) returning id`, [pSew])).rows[0].id;
  const eW = (await db.query(`insert into employees (name, shop, profession_id) values ('Цеховой', 'workshop', $1) returning id`, [pSew])).rows[0].id;
  await db.query(`insert into staff_bot_links (profile_id, telegram_id, chat_id, language) values ($1, 1001, 1001, 'ru'), ($2, 1003, 1003, 'uz'), ($3, 1002, 1002, 'ru')`, [UIDS.master, M2, UIDS.ceo]);
  const mkW = async (tg, emp, shop) => (await db.query(`insert into worker_bot_users (telegram_id, chat_id, language, full_name, shop, status, employee_id) values ($1, $1, 'ru', $2, $3, 'active', $4) returning id`, [tg, `w${tg}`, shop, emp])).rows[0].id;
  const wF = await mkW(2001, eF, 'factory');
  const wW = await mkW(2002, eW, 'workshop');
  const botRec = async (wu, emp, qty) => {
    let id;
    await db.query('reset role');
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('app.bot_write', 'on', true)`);
      id = (await tx.query(`insert into work_records (employee_id, catalog_operation_id, quantity, date, bot_user_id) values ($1, $2, $3, public.tashkent_today(), $4) returning id`, [emp, oOver, qty, wu])).rows[0].id;
    });
    await asUser(db, current);
    return id;
  };
  await as(db, 'master');
  const rF = await botRec(wF, eF, 10);
  const rW = await botRec(wW, eW, 20);
  const rW2 = await botRec(wW, eW, 30);
  const rW3 = await botRec(wW, eW, 40);

  // ===================== Переключение цеха =====================
  const shopOf = async (id) => (await admin(db, `select current_shop from profiles where id = $1`, [id])).rows[0].current_shop;
  check('мастер сейчас в «Фабрике»; список ожидающих — только её (1 запись)', (await bot(db, 1001, 'staff_pending')).shop === 'factory' && (await bot(db, 1001, 'staff_pending')).count === 1);
  await svc(db, `select public.bot_staff_set_shop(1001, 'workshop')`);
  check('переключил в боте — profiles.current_shop = workshop (на сайте тоже)', (await shopOf(UIDS.master)) === 'workshop');
  const p2 = await bot(db, 1001, 'staff_pending');
  check('теперь ожидающие — только цеха «Цех» (3 записи)', p2.shop === 'workshop' && p2.count === 3);
  check('на сайте тот же ответ (staff_pending от вошедшего мастера)', (await db.query(`select public.staff_pending('{}'::jsonb) as r`)).rows[0].r.shop === 'workshop');
  // переключили на сайте (set_my_shop) — бот видит
  await db.query(`select public.set_my_shop('factory')`);
  check('переключил на сайте — бот видит «Фабрика»', (await bot(db, 1001, 'staff_pending')).shop === 'factory' && (await shopOf(UIDS.master)) === 'factory');
  const rs = (await svc(db, `select public.bot_staff_resolve(1001) as r`)).rows[0].r;
  check('bot_staff_resolve отдаёт выбранный цех мастера', rs.shop === 'factory');
  check('у второго мастера свой цех — не затронут', (await shopOf(M2)) === 'workshop');
  await svc(db, `select public.bot_staff_set_shop(1002, 'workshop')`);
  check('CEO переключает своё (в боте), профиль CEO не трогается', (await bot(db, 1002, 'staff_pending')).shop === 'workshop' && (await shopOf(UIDS.ceo)) === null);
  check('неверный цех и непривязанный Telegram — отказ', (await fails(db, `select public.bot_staff_set_shop(1001, 'moon')`, [], /permission denied/)) === true && await (async () => { try { await svc(db, `select public.bot_staff_set_shop(1001, 'moon')`); return false; } catch (e) { return /invalid_shop/.test(e.message); } })() && await (async () => { try { await svc(db, `select public.bot_staff_set_shop(7777, 'factory')`); return false; } catch (e) { return /insufficient_privilege/.test(e.message); } })());
  check('сайт и anon переключать через bot_staff_set_shop не могут', await fails(db, `select public.bot_staff_set_shop(1001, 'workshop')`, [], /permission denied/));

  // ===================== Защита: списки только выбранного цеха =====================
  check('мастер в «Фабрике» не видит работников «Цеха» (staff_workers_list) и не просит чужой цех явно', !(await bot(db, 1001, 'staff_workers_list', { profession_id: 'all' })).some((w) => w.name === 'Цеховой') && await botFails(db, 1001, 'staff_pending', { shop: 'workshop' }, /not_your_shop/));
  check('флаг any_shop списки НЕ расширяет (staff_pending, staff_report, staff_workers_list)', (await bot(db, 1001, 'staff_pending', { any_shop: true })).shop === 'factory' && (await bot(db, 1001, 'staff_pending', { any_shop: true })).count === 1 && (await bot(db, 1001, 'staff_report', { from: '2026-01-01', to: '2026-12-31', any_shop: true })).shop === 'factory');

  // ===================== Действия над одной записью (из уведомления) =====================
  const c0 = await bot(db, 1001, 'staff_confirm', { ids: [rW] });
  check('без any_shop запись другого цеха не подтверждается (как раньше)', c0.confirmed === 0 && (await admin(db, `select status from work_records where id = $1`, [rW])).rows[0].status === 'pending');
  check('adjust и reject чужого цеха без any_shop — отказ', (await botFails(db, 1001, 'staff_adjust', { id: rW, quantity: 5 }, /not_your_shop/)) && (await botFails(db, 1001, 'staff_reject', { id: rW, reason: 'x' }, /not_your_shop/)));
  const bulk = await bot(db, 1001, 'staff_confirm', { date: (await admin(db, `select public.tashkent_today()::text as d`)).rows[0].d, any_shop: true });
  check('any_shop не расширяет массовое подтверждение: «подтвердить всё за день» берёт только выбранный цех (запись «Фабрики»), записи «Цеха» остаются', bulk.confirmed === 1 && (await admin(db, `select status from work_records where id = $1`, [rW])).rows[0].status === 'pending' && (await admin(db, `select status from work_records where id = $1`, [rF])).rows[0].status === 'confirmed');
  check('any_shop с несколькими id — отказ (только одна запись из уведомления)', await botFails(db, 1001, 'staff_confirm', { ids: [rW, rW2], any_shop: true }, /any_shop_single/));
  const c1 = await bot(db, 1001, 'staff_confirm', { ids: [rW], any_shop: true });
  check('с any_shop мастер «Фабрики» подтверждает запись «Цеха» из уведомления', c1.confirmed === 1 && (await admin(db, `select status, decided_by from work_records where id = $1`, [rW])).rows[0].decided_by === UIDS.master);
  check('staff_confirm возвращает, что подтверждено: работник, операция, цех', c1.items.length === 1 && c1.items[0].employee_name === 'Цеховой' && c1.items[0].shop === 'workshop' && c1.items[0].label === 'Футболка · Оверлок', JSON.stringify(c1.items));
  const a1 = await bot(db, 1001, 'staff_adjust', { id: rW2, quantity: 25, any_shop: true });
  check('изменить количество чужого цеха из уведомления: 30 → 25, работнику уйдёт сообщение', a1.old_quantity === 30 && a1.quantity === 25 && a1.notify.chat_id === 2002);
  const r1 = await bot(db, 1001, 'staff_reject', { id: rW3, reason: 'Ошибка', any_shop: true });
  check('отклонить запись чужого цеха из уведомления — с причиной', r1.reason === 'Ошибка' && (await admin(db, `select status from work_records where id = $1`, [rW3])).rows[0].status === 'rejected');
  check('повторное решение — «уже обработана»', await botFails(db, 1001, 'staff_adjust', { id: rW, quantity: 1, any_shop: true }, /already_decided/));
  check('действия с any_shop пишутся в журнал (кто, из бота)', (await admin(db, `select count(*)::int as n from work_record_audit where via = 'bot' and actor_name = 'master@test.test'`)).rows[0].n === 2);
  // any_shop — только для мастера и CEO: другие роли (кладовщик, закройщик) не могут ни подтвердить, ни изменить, ни отклонить
  const rGuard = await botRec(wW, eW, 5);
  for (const role of ['kladovshik', 'zakroyshik']) {
    await as(db, role);
    const q = (fn, p) => fails(db, `select public.${fn}($1::jsonb)`, [JSON.stringify(p)], /insufficient_privilege/);
    check(`${role}: staff_confirm с any_shop и реальной записью — отказ`, await q('staff_confirm', { ids: [rGuard], any_shop: true }));
    check(`${role}: staff_adjust с any_shop — отказ`, await q('staff_adjust', { id: rGuard, quantity: 1, any_shop: true }));
    check(`${role}: staff_reject с any_shop — отказ`, await q('staff_reject', { id: rGuard, reason: 'x', any_shop: true }));
    check(`${role}: без any_shop — тоже отказ (staff_edit_record, staff_delete_record)`, (await q('staff_edit_record', { id: rGuard, quantity: 1 })) && (await q('staff_delete_record', { id: rGuard })));
  }
  await db.query('reset role');
  await db.query('set role anon');
  check('anon не может вызвать staff_confirm / bot_as_staff / bot_staff_set_shop', (await fails(db, `select public.staff_confirm('{"ids":[],"any_shop":true}'::jsonb)`, [], /permission denied/)) && (await fails(db, `select public.bot_as_staff(1001, 'staff_confirm', '{}')`, [], /permission denied/)) && (await fails(db, `select public.bot_staff_set_shop(1001, 'factory')`, [], /permission denied/)));
  await db.query('reset role');
  await as(db, 'master');
  check('после попыток запись осталась ожидающей, ничего не изменилось', (await admin(db, `select status, quantity from work_records where id = $1`, [rGuard])).rows[0].status === 'pending');
  const grantRows = (await admin(db, `select p.proname, has_function_privilege('public', p.oid, 'execute') as pub, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('service_role', p.oid, 'execute') as svc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('bot_staff_set_shop', 'bot_record_notice', 'bot_as_staff')`)).rows;
  check('bot_staff_set_shop, bot_record_notice, bot_as_staff: execute только у service_role (public/anon/authenticated — нет)', grantRows.length === 3 && grantRows.every((g) => g.svc && !g.pub && !g.anon && !g.auth), JSON.stringify(grantRows));
  await as(db, 'kladovshik');
  check('кладовщик не может ни подтверждать, ни ставить any_shop', await fails(db, `select public.staff_confirm('{"ids":[],"any_shop":true}'::jsonb)`, [], /insufficient_privilege/));
  await as(db, 'master');

  // ===================== Уведомление о новой записи =====================
  const rN = await botRec(wW, eW, 150);
  const n = (await svc(db, `select public.bot_record_notice($1) as r`, [rN])).rows[0].r;
  check('уведомление: цех работника (workshop), имя, операция, 150 шт, ставка 120, сумма 18000', n.shop === 'workshop' && n.employee_name === 'Цеховой' && n.label === 'Футболка · Оверлок' && n.quantity === 150 && Number(n.rate) === 120 && Number(n.total) === 18000, JSON.stringify(n));
  check('получатели — ВСЕ мастера, привязанные к боту, из обоих цехов (2); CEO не в списке', n.recipients.length === 2 && n.recipients.some((x) => x.chat_id === 1001) && n.recipients.some((x) => x.chat_id === 1003 && x.language === 'uz') && !n.recipients.some((x) => x.chat_id === 1002), JSON.stringify(n.recipients));
  const rF2 = await botRec(wF, eF, 3);
  const nF = (await svc(db, `select public.bot_record_notice($1) as r`, [rF2])).rows[0].r;
  check('и для записи «Фабрики» получатели те же (мастер «Цеха» тоже получает)', nF.shop === 'factory' && nF.recipients.length === 2);
  check('по уже решённой записи уведомления нет (null)', (await svc(db, `select public.bot_record_notice($1) as r`, [rW])).rows[0].r === null && (await svc(db, `select public.bot_record_notice($1) as r`, ['00000000-0000-0000-0000-00000000dead'])).rows[0].r === null);
  check('bot_record_notice — только service_role (с сайта недоступна)', await fails(db, `select public.bot_record_notice($1)`, [rN], /permission denied/));
  check('мастер, не привязанный к боту, получателем не бывает', await (async () => { await admin(db, `delete from staff_bot_links where telegram_id = 1003`); const x = (await svc(db, `select public.bot_record_notice($1) as r`, [rN])).rows[0].r; return x.recipients.length === 1; })());

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(String(e.message ?? e).slice(0, 800));
  process.exit(1);
});
