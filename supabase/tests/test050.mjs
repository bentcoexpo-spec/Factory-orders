import { newDb, applyMigrations } from './build019.mjs';
import { UIDS, asUser } from './build_master.mjs';

// Миграция 047: настройки по цехам, отчёты, рейтинг внутри профессии,
// рассылка (лимит 3 в день), выбор «что пора слать» для планировщика.

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
let current = 'ceo';
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
const site = async (db, fn, p) => (await db.query(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(p)])).rows[0].r;
const siteFails = (db, fn, p, re) => fails(db, `select public.${fn}($1::jsonb)`, [JSON.stringify(p)], re);
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
const bot = async (db, tg, fn, p = {}) =>
  (await svc(db, `select public.bot_as_staff($1, $2, $3::jsonb) as r`, [tg, fn, JSON.stringify(p)])).rows[0].r;
const due = async (db, iso) => (await svc(db, `select public.cron_worker_bot_due($1::timestamptz) as r`, [iso])).rows[0].r;

async function main() {
  const db = await newDb();
  await applyMigrations(db);
  await db.query('alter role service_role bypassrls');
  for (const [role, uid] of Object.entries(UIDS)) {
    await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [uid, `${role}@test.test`]);
    await db.query(`insert into profiles (id, email, role) values ($1, $2, $3) on conflict (id) do update set role = excluded.role`, [uid, `${role}@test.test`, role]);
  }
  await db.query(`update profiles set current_shop = 'factory' where id = $1`, [UIDS.master]);
  await asUser(db, 'ceo');
  await db.query('reset role');

  // ----- данные
  const pSew = (await db.query(`insert into professions (name) values ('Швея') returning id`)).rows[0].id;
  const pIron = (await db.query(`insert into professions (name) values ('Утюжник') returning id`)).rows[0].id;
  const mT = (await db.query(`insert into catalog_models (profession_id, name, whole_rate) values ($1, 'Футболка', 1500) returning id`, [pSew])).rows[0].id;
  const oOver = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Оверлок', 100) returning id`, [mT])).rows[0].id;
  const mI = (await db.query(`insert into catalog_models (profession_id, name) values ($1, 'Глажка') returning id`, [pIron])).rows[0].id;
  const oIron = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Утюг', 50) returning id`, [mI])).rows[0].id;
  const mkE = async (name, shop, prof) => (await db.query(`insert into employees (name, shop, profession_id) values ($1, $2, $3) returning id`, [name, shop, prof])).rows[0].id;
  const eA = await mkE('Анвар', 'factory', pSew);
  const eB = await mkE('Бобур', 'factory', pSew);
  const eC = await mkE('Мадина', 'factory', pSew);
  const eD = await mkE('Дильноза', 'factory', pIron);
  const eN = await mkE('БезПрофессии', 'factory', null);
  const eI = await mkE('Простой', 'factory', pSew); // никого не вносил
  const eW = await mkE('Цеховой', 'workshop', pSew);
  await db.query(`insert into staff_bot_links (profile_id, telegram_id, chat_id, language) values ($1, 1001, 1001, 'ru'), ($2, 1002, 1002, 'uz')`, [UIDS.master, UIDS.ceo]);
  const mkW = async (tg, emp, shop) =>
    (await db.query(`insert into worker_bot_users (telegram_id, chat_id, language, full_name, shop, status, employee_id) values ($1, $1, 'ru', $2, $3, 'active', $4) returning id`, [tg, `w${tg}`, shop, emp])).rows[0].id;
  const wA = await mkW(2001, eA, 'factory');
  await mkW(2002, eB, 'factory');
  await mkW(2003, eC, 'factory');
  await mkW(2004, eD, 'factory');
  await mkW(2005, eN, 'factory');
  await mkW(2006, eW, 'workshop');

  // записи: подтверждённые «с сайта» (мастер) на разные даты + бота
  await as(db, 'master');
  const site1 = async (emp, op, qty, date) => db.query(`insert into work_records (employee_id, catalog_operation_id, quantity, date) values ($1, $2, $3, $4::date)`, [emp, op, qty, date]);
  await site1(eA, oOver, 10, '2026-10-05'); // 1000
  await site1(eA, oOver, 5, '2026-10-06'); // 500
  await site1(eB, oOver, 20, '2026-10-05'); // 2000
  await site1(eC, oOver, 5, '2026-10-05'); // 500
  await site1(eD, oIron, 8, '2026-10-06'); // 400
  await site1(eN, oOver, 3, '2026-10-06'); // 300
  await site1(eA, oOver, 99, '2026-09-20'); // вне периода
  await db.query('reset role');
  const botRec = async (wu, emp, op, qty, date) => {
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('app.bot_write', 'on', true)`);
      await tx.query(`insert into work_records (employee_id, catalog_operation_id, quantity, date, bot_user_id) values ($1, $2, $3, $4::date, $5)`, [emp, op, qty, date, wu]);
    });
  };
  await botRec(wA, eA, oOver, 2, '2026-10-06'); // pending 200
  await botRec(wA, eA, oOver, 1, '2026-10-06'); // станет rejected
  await db.query(`update work_records set status = 'rejected', reject_reason = 'x' where id = (select id from work_records where bot_user_id = $1 and quantity = 1)`, [wA]).catch(() => null);
  await db.transaction(async (tx) => {
    await tx.query(`select set_config('app.record_decision', 'on', true)`);
    await tx.query(`update work_records set status = 'rejected', reject_reason = 'x' where bot_user_id = $1 and quantity = 1`, [wA]);
  });
  await botRec(wA, eW, oOver, 4, '2026-10-06').catch(() => null);
  await as(db, 'master');

  // ===================== A. Настройки =====================
  const s0 = await site(db, 'staff_settings_get', {});
  check('настройки по умолчанию: напоминание выкл, 20:00, воскресенье выходной, рейтинг выкл, ежемесячный Excel вкл', s0.reminder_enabled === false && s0.reminder_time === '20:00' && JSON.stringify(s0.days_off) === '[7]' && s0.rating_enabled === false && s0.monthly_excel_enabled === true && s0.shop === 'factory', JSON.stringify(s0));
  check('мастер не читает и не меняет настройки чужого цеха', (await siteFails(db, 'staff_settings_get', { shop: 'workshop' }, /not_your_shop/)) && (await siteFails(db, 'staff_settings_set', { shop: 'workshop', rating_enabled: true }, /not_your_shop/)));
  const s1 = await site(db, 'staff_settings_set', { reminder_enabled: true, reminder_time: '21:30', days_off: [6, 7, 7] });
  check('изменение: время, выходные (без дублей), включение', s1.reminder_enabled === true && s1.reminder_time === '21:30' && JSON.stringify(s1.days_off) === '[6,7]', JSON.stringify(s1));
  check('неверное время и дни отклонены', (await siteFails(db, 'staff_settings_set', { reminder_time: '25:99' }, /invalid_time/)) && (await siteFails(db, 'staff_settings_set', { days_off: [0] }, /invalid_days/)) && (await siteFails(db, 'staff_settings_set', { days_off: [8] }, /invalid_days/)));
  await site(db, 'staff_settings_set', { reminder_time: '00:00' });
  check('напоминание включено ПОСЛЕ его времени — сегодняшнее пропускается', (await admin(db, `select reminder_last_date = public.tashkent_today() as ok from worker_bot_settings where shop = 'factory'`)).rows[0].ok === true);
  await admin(db, `update worker_bot_settings set reminder_last_date = null`);
  await site(db, 'staff_settings_set', { reminder_time: '23:59' });
  check('время ещё впереди — сегодняшнее напоминание не пропускается', (await admin(db, `select reminder_last_date is null as ok from worker_bot_settings where shop = 'factory'`)).rows[0].ok === true);
  const ceoSet = await bot(db, 1002, 'staff_settings_get', { shop: 'workshop' });
  check('CEO читает настройки любого цеха; настройки цехов независимы', ceoSet.shop === 'workshop' && ceoSet.reminder_enabled === false);
  await site(db, 'staff_settings_set', { reminder_enabled: false, reminder_time: '20:00', days_off: [7] });

  // ===================== B. Отчёт =====================
  const rep = await site(db, 'staff_report', { from: '2026-10-05', to: '2026-10-11' });
  check('итого за период: 4700 сум (только подтверждённые), 40+... штук, 6 записей', Number(rep.total.sum) === 4700 && Number(rep.total.records) === 6 && rep.total.workers === 5 && rep.total.employees === 6, JSON.stringify(rep.total));
  check('ожидающие — отдельно (200 сум, 1 запись) и в сумму не входят', rep.pending.count === 1 && Number(rep.pending.sum) === 200);
  const pr = Object.fromEntries(rep.professions.map((x) => [x.name ?? 'none', x]));
  check('по профессиям: Швея 4000 сум / 3 работали из 4 / 38 шт / 4 записи', Number(pr['Швея'].sum) === 4000 && pr['Швея'].workers === 3 && pr['Швея'].employees === 4 && Number(pr['Швея'].qty) === 40 && Number(pr['Швея'].records) === 4, JSON.stringify(pr['Швея']));
  check('Утюжник 400; без профессии — отдельная группа (300)', Number(pr['Утюжник'].sum) === 400 && Number(pr['none'].sum) === 300 && pr['none'].id === null);
  check('таблица по работникам по убыванию суммы: Бобур 2000 первый', rep.workers[0].name === 'Бобур' && Number(rep.workers[0].sum) === 2000 && rep.workers.length === 5);
  check('«не работал»: только «Простой» (ожидающая запись считается работой, отклонённая — нет)', rep.idle.length === 1 && rep.idle[0].name === 'Простой', JSON.stringify(rep.idle));
  check('чужой цех в отчёт не попал', !rep.workers.some((w) => w.name === 'Цеховой'));
  check('период больше 400 дней и перевёрнутый — отказ', (await siteFails(db, 'staff_report', { from: '2020-01-01', to: '2026-01-01' }, /invalid_period/)) && (await siteFails(db, 'staff_report', { from: '2026-10-05', to: '2026-10-01' }, /invalid_period/)));
  const repWeek = await site(db, 'staff_report', { from: '2026-10-06', to: '2026-10-06' });
  check('день 06.10: 1200 сум (500 + 400 + 300)', Number(repWeek.total.sum) === 1200, JSON.stringify(repWeek.total));
  const ceoRep = await bot(db, 1002, 'staff_report', { shop: 'workshop', from: '2026-10-01', to: '2026-10-31' });
  check('CEO: отчёт цеха «Цех»', ceoRep.shop === 'workshop' && ceoRep.total.employees === 1 && Number(ceoRep.total.sum) === 0);
  await as(db, 'kladovshik');
  check('кладовщик отчётов не получает', await siteFails(db, 'staff_report', { from: '2026-10-05', to: '2026-10-11' }, /insufficient_privilege/));
  await as(db, 'master');

  // ===================== C. Отчёт по человеку =====================
  const person = await site(db, 'staff_report_person', { employee_id: eA, from: '2026-10-05', to: '2026-10-11' });
  const gA = person.groups;
  check('человек: 2 дня, группы «Футболка · Оверлок» по статусам (подтверждено 15 шт, ждёт 2, отклонено 1)', person.days === 2 && gA.find((g) => g.status === 'confirmed' && Number(g.qty) === 15) && gA.find((g) => g.status === 'pending' && Number(g.qty) === 2) && gA.find((g) => g.status === 'rejected' && Number(g.qty) === 1), JSON.stringify(person));
  check('отчёт по человеку из чужого цеха недоступен', await siteFails(db, 'staff_report_person', { employee_id: eW, from: '2026-10-05', to: '2026-10-11' }, /not_your_shop/));

  // ===================== D. Строки для Excel =====================
  const rowsAll = await site(db, 'staff_report_rows', { from: '2026-10-05', to: '2026-10-11' });
  check('Excel: только подтверждённые записи цеха (6), не усечено', rowsAll.rows.length === 6 && rowsAll.truncated === false && rowsAll.rows.every((r) => r.employee !== 'Цеховой'));
  check('Excel: у строки дата, работник, профессия, операция, штуки, ставка, сумма', rowsAll.rows[0].date === '2026-10-05' && rowsAll.rows.some((r) => r.employee === 'Бобур' && Number(r.total) === 2000 && r.label === 'Футболка · Оверлок' && r.profession === 'Швея'));
  const rowsSew = await site(db, 'staff_report_rows', { from: '2026-10-05', to: '2026-10-11', profession_id: pSew });
  const rowsNone = await site(db, 'staff_report_rows', { from: '2026-10-05', to: '2026-10-11', profession_id: 'none' });
  check('Excel по профессии: Швея — 4 записи; без профессии — 1', rowsSew.rows.length === 4 && rowsNone.rows.length === 1 && rowsNone.rows[0].employee === 'БезПрофессии');
  check('Excel за период без записей — пусто', (await site(db, 'staff_report_rows', { from: '2026-08-01', to: '2026-08-31' })).rows.length === 0);
  check('cron_report_rows недоступна с сайта', await fails(db, `select public.cron_report_rows('factory', '2026-10-01', '2026-10-31')`, [], /permission denied/));

  // ===================== E. Рейтинг =====================
  const ratingOf = async (tg, from = '2026-10-05', to = '2026-10-11') => (await svc(db, `select public.bot_rating($1, $2::date, $3::date) as r`, [tg, from, to])).rows[0].r;
  check('рейтинг выключен — null', (await ratingOf(2001)) === null);
  await site(db, 'staff_settings_set', { rating_enabled: true });
  const rA = await ratingOf(2001);
  const rB = await ratingOf(2002);
  const rC = await ratingOf(2003);
  check('Швеи цеха: Бобур 2000 — 1-й, Анвар 1500 — 2-й, Мадина 500 — 3-й, из 3', rB.place === 1 && rA.place === 2 && rC.place === 3 && rA.total === 3 && rA.profession_name === 'Швея', JSON.stringify([rA, rB, rC]));
  check('рейтинг отдаёт только место, число участников и профессию — без имён и сумм', JSON.stringify(Object.keys(rA).sort()) === JSON.stringify(['place', 'profession_name', 'total']));
  const rD = await ratingOf(2004);
  check('Утюжник — отдельно: 1-й из 1 (профессии не смешиваются)', rD.place === 1 && rD.total === 1);
  check('без профессии рейтинга нет; без подтверждённых записей за период — нет', (await ratingOf(2005)) === null && (await ratingOf(2001, '2026-08-01', '2026-08-31')) === null);
  await admin(db, `insert into work_records (employee_id, catalog_operation_id, quantity, date, status) values ($1, $2, 15, '2026-10-06', 'confirmed')`, [eC, oOver]);
  const rC2 = await ratingOf(2003);
  const rA2 = await ratingOf(2001);
  check('равные суммы (Мадина 2000 = Бобур 2000) — одно место (1-е), Анвар — 3-й', rC2.place === 1 && (await ratingOf(2002)).place === 1 && rA2.place === 3, JSON.stringify([rC2, rA2]));
  check('сотрудник другого цеха в рейтинг не попадает (отдельное место в своём цехе)', (await ratingOf(2006)) === null);
  await site(db, 'staff_settings_set', { rating_enabled: false });
  check('рейтинг снова выключен — null', (await ratingOf(2001)) === null);
  check('вызов bot_rating с сайта запрещён', await fails(db, `select public.bot_rating(2001, '2026-10-05', '2026-10-11')`, [], /permission denied/));

  // ===================== F. Рассылка =====================
  const prep = await site(db, 'staff_broadcast_prepare', {});
  check('рассылка: получатели — активные работники цеха (5), осталось 3', prep.recipients === 5 && prep.left === 3 && prep.used === 0, JSON.stringify(prep));
  const b1 = await site(db, 'staff_broadcast_commit', { text: '  Завтра выходной  ' });
  check('рассылка: слот занят, получатели с chat_id и языком', b1.recipients.length === 5 && b1.left === 2 && b1.recipients[0].chat_id && b1.recipients[0].language === 'ru');
  check('текст сохранён обрезанным', (await admin(db, `select body from worker_bot_broadcasts where id = $1`, [b1.id])).rows[0].body === 'Завтра выходной');
  await svc(db, `select public.bot_broadcast_result($1, 4, 1)`, [b1.id]);
  check('итог доставки записан (4 доставлено, 1 нет)', (await admin(db, `select sent, failed from worker_bot_broadcasts where id = $1`, [b1.id])).rows[0].sent === 4);
  check('пустой и слишком длинный текст отклонены (слот при этом не занимается)', (await siteFails(db, 'staff_broadcast_commit', { text: '   ' }, /invalid_text/)) && (await siteFails(db, 'staff_broadcast_commit', { text: 'я'.repeat(1001) }, /invalid_text/)) && (await site(db, 'staff_broadcast_prepare', {})).left === 2);
  await site(db, 'staff_broadcast_commit', { text: 'Второе' });
  await bot(db, 1001, 'staff_broadcast_commit', { text: 'Третье' });
  check('четвёртая за день — отказ «не больше 3», счётчик общий у мастера и бота', await siteFails(db, 'staff_broadcast_commit', { text: 'Четвёртое' }, /broadcast_limit/));
  const ceoPrep = await bot(db, 1002, 'staff_broadcast_prepare', { shop: 'workshop' });
  check('у другого цеха свой счётчик: у «Цеха» осталось 3, получатель 1', ceoPrep.left === 3 && ceoPrep.recipients === 1);
  await admin(db, `update worker_bot_broadcasts set created_at = created_at - interval '1 day'`);
  check('на следующий день лимит обновляется', (await site(db, 'staff_broadcast_prepare', {})).left === 3);
  await admin(db, `update worker_bot_users set status = 'removed' where telegram_id = 2005`);
  check('снятые с бота работники рассылку не получают', (await site(db, 'staff_broadcast_prepare', {})).recipients === 4);
  await admin(db, `update worker_bot_users set status = 'active' where telegram_id = 2005`);

  // ===================== G. Планировщик =====================
  await admin(db, `delete from work_records where date >= '2026-10-06'`);
  await admin(db, `update worker_bot_settings set reminder_last_date = null, monthly_last_period = null, monthly_excel_enabled = false`);
  await site(db, 'staff_settings_set', { reminder_enabled: true, reminder_time: '20:00', days_off: [7] });
  await admin(db, `update worker_bot_settings set reminder_last_date = null where shop = 'factory'`);
  // сегодня (06.10) вторник; пришла запись только у Анвара (бот) и ожидает
  await db.query('reset role');
  await botRec(wA, eA, oOver, 3, '2026-10-06');
  await as(db, 'master');

  check('до 20:00 по Ташкенту (19:30) — не пора', (await due(db, '2026-10-06T14:30:00Z')).reminders.length === 0);
  const d1 = await due(db, '2026-10-06T15:30:00Z'); // 20:30 Ташкент, вторник
  check('в 20:30: напоминание цеху «Фабрика» — тем, кто не внёс (Бобур, Мадина, Дильноза; без «БезПрофессии», он не может вносить, и без Анвара)', d1.reminders.length === 1 && d1.reminders[0].shop === 'factory' && d1.reminders[0].workers.length === 3 && d1.reminders[0].workers.every((w) => [2002, 2003, 2004].includes(w.chat_id)), JSON.stringify(d1));
  check('мастеру цеха — получатели и число ожидающих (1)', d1.reminders[0].masters.length === 1 && d1.reminders[0].masters[0].chat_id === 1001 && d1.reminders[0].pending === 1);
  check('«Цех» (напоминание выключено) — не в списке', !d1.reminders.some((r) => r.shop === 'workshop'));
  check('повторный запуск того же дня — ничего (занято в базе)', (await due(db, '2026-10-06T15:45:00Z')).reminders.length === 0);
  await admin(db, `update worker_bot_settings set reminder_last_date = null where shop = 'factory'`);
  check('позже чем через 3 часа после времени (23:30) — уже не шлём', (await due(db, '2026-10-06T18:30:00Z')).reminders.length === 0);
  check('воскресенье — выходной: не шлём', (await due(db, '2026-10-11T15:30:00Z')).reminders.length === 0);
  await site(db, 'staff_settings_set', { days_off: [] });
  await admin(db, `update worker_bot_settings set reminder_last_date = null where shop = 'factory'`);
  check('убрали выходные — в воскресенье шлёт', (await due(db, '2026-10-11T15:30:00Z')).reminders.length === 1);
  await site(db, 'staff_settings_set', { days_off: [7], reminder_time: '22:00' });
  await admin(db, `update worker_bot_settings set reminder_last_date = null where shop = 'factory'`);
  check('время 22:00: в 22:30 шлёт (окно не обрезается полуночью)', (await due(db, '2026-10-06T17:30:00Z')).reminders.length === 1);
  await admin(db, `update worker_bot_settings set reminder_last_date = null where shop = 'factory'`);
  await db.query('reset role');
  await db.query(`update work_records set status = 'rejected', reject_reason = 'x' where date = '2026-10-06'`).catch(() => null);
  await db.transaction(async (tx) => {
    await tx.query(`select set_config('app.record_decision', 'on', true)`);
    await tx.query(`update work_records set status = 'rejected', reject_reason = 'x' where date = '2026-10-06'`);
  });
  await as(db, 'master');
  const d2 = await due(db, '2026-10-06T17:30:00Z');
  check('у кого запись отклонена — считается «не внёс» (Анвар в списке)', d2.reminders.length === 1 && d2.reminders[0].workers.some((w) => w.chat_id === 2001) && d2.reminders[0].pending === 0, JSON.stringify(d2));

  // ежемесячный отчёт
  await admin(db, `update worker_bot_settings set monthly_excel_enabled = true, monthly_last_period = null, reminder_enabled = false`);
  check('31 октября и 1-го в 08:30 — ещё не пора', ((await due(db, '2026-10-31T10:00:00Z')).monthly.length === 0) && ((await due(db, '2026-11-01T03:30:00Z')).monthly.length === 0));
  const m1 = await due(db, '2026-11-01T04:30:00Z'); // 09:30 Ташкент
  check('1 ноября в 09:30: отчёт за октябрь для обоих цехов, период 01–31.10', m1.monthly.length === 2 && m1.monthly.every((x) => x.from === '2026-10-01' && x.to === '2026-10-31'), JSON.stringify(m1));
  const mf = m1.monthly.find((x) => x.shop === 'factory');
  const mw = m1.monthly.find((x) => x.shop === 'workshop');
  check('получатели «Фабрики»: мастер цеха и CEO', mf.recipients.length === 2 && mf.recipients.some((r) => r.role === 'master' && r.chat_id === 1001) && mf.recipients.some((r) => r.role === 'ceo' && r.chat_id === 1002));
  check('получатели «Цеха»: только CEO (мастер работает в другом цехе)', mw.recipients.length === 1 && mw.recipients[0].role === 'ceo');
  check('повтор — ничего', (await due(db, '2026-11-01T05:00:00Z')).monthly.length === 0);
  await svc(db, `select public.cron_release_monthly('factory')`);
  check('после release отправку можно повторить (только «Фабрика»)', (await due(db, '2026-11-01T06:00:00Z')).monthly.map((x) => x.shop).join() === 'factory');
  await admin(db, `update worker_bot_settings set monthly_last_period = null`);
  check('простой планировщика: 3 ноября догоняет, 4-го — уже нет', ((await due(db, '2026-11-03T10:00:00Z')).monthly.length === 2) && ((await (async () => { await admin(db, `update worker_bot_settings set monthly_last_period = null`); return due(db, '2026-11-04T10:00:00Z'); })()).monthly.length === 0));
  await admin(db, `update worker_bot_settings set monthly_last_period = null, monthly_excel_enabled = false where shop = 'factory'`);
  check('выключили ежемесячный Excel у «Фабрики» — шлёт только «Цеху»', (await due(db, '2026-11-01T04:30:00Z')).monthly.map((x) => x.shop).join() === 'workshop');

  // ===================== H. Права =====================
  check('планировщик с сайта недоступен', await fails(db, `select public.cron_worker_bot_due()`, [], /permission denied/));
  check('таблицы настроек и рассылок с сайта недоступны', (await fails(db, `select * from worker_bot_settings`, [], /permission denied/)) && (await fails(db, `select * from worker_bot_broadcasts`, [], /permission denied/)));
  const profs = await site(db, 'staff_professions', {});
  check('список профессий для настроек: число сотрудников и моделей', profs.find((x) => x.name === 'Швея').employees === 5 && profs.find((x) => x.name === 'Швея').models === 1);
  void oIron;

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(String(e.message ?? e).slice(0, 800));
  process.exit(1);
});
