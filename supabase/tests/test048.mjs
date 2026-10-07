import { newDb, applyMigrations } from './build019.mjs';
import { UIDS, asUser } from './build_master.mjs';

// Миграция 046: подтверждение записей, журнал правок, функции staff_*,
// вызов от имени мастера/CEO из бота (bot_as_staff).

let passed = 0;
let failed = 0;
function check(name, cond, evidence) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  ПРОВАЛ:', name, evidence !== undefined ? `(${String(evidence).slice(0, 240)})` : '');
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
// Сайт: вызов staff_* от вошедшего пользователя.
const site = async (db, fn, p) => (await db.query(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(p)])).rows[0].r;
const siteFails = (db, fn, p, re) => fails(db, `select public.${fn}($1::jsonb)`, [JSON.stringify(p)], re);
// Бот: bot_as_staff от service_role.
const bot = async (db, tg, fn, p = {}) => {
  await db.query('reset role');
  await db.query('set role service_role');
  try {
    return (await db.query(`select public.bot_as_staff($1, $2, $3::jsonb) as r`, [tg, fn, JSON.stringify(p)])).rows[0].r;
  } finally {
    await db.query('reset role');
    await asUser(db, current);
  }
};
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
  await db.query(`update profiles set current_shop = 'factory' where id = $1`, [UIDS.master]);
  await asUser(db, 'ceo');
  await db.query('reset role');

  // ----- данные
  const pSew = (await db.query(`insert into professions (name) values ('Швея') returning id`)).rows[0].id;
  const pIron = (await db.query(`insert into professions (name) values ('Утюжник') returning id`)).rows[0].id;
  const mT = (await db.query(`insert into catalog_models (profession_id, name, whole_rate) values ($1, 'Футболка', 1500) returning id`, [pSew])).rows[0].id;
  const oOver = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Оверлок', 120) returning id`, [mT])).rows[0].id;
  const oLine = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Строчка', 80) returning id`, [mT])).rows[0].id;
  const eF1 = (await db.query(`insert into employees (name, shop, profession_id) values ('Алишер', 'factory', $1) returning id`, [pSew])).rows[0].id;
  const eF2 = (await db.query(`insert into employees (name, shop, profession_id) values ('Бахтиёр', 'factory', $1) returning id`, [pSew])).rows[0].id;
  const eF3 = (await db.query(`insert into employees (name, shop) values ('Без профессии-Ф', 'factory') returning id`)).rows[0].id;
  const eW1 = (await db.query(`insert into employees (name, shop, profession_id) values ('Цеховой', 'workshop', $1) returning id`, [pSew])).rows[0].id;

  // привязки Telegram: мастер и CEO
  await db.query(`insert into staff_bot_links (profile_id, telegram_id, chat_id, language) values ($1, 1001, 1001, 'ru'), ($2, 1002, 1002, 'uz')`, [UIDS.master, UIDS.ceo]);
  // работники в боте
  const mkWorker = async (tg, name, emp, shop) =>
    (await db.query(`insert into worker_bot_users (telegram_id, chat_id, language, full_name, shop, status, employee_id) values ($1, $1, 'ru', $2, $3, 'active', $4) returning id`, [tg, name, shop, emp])).rows[0].id;
  const wu1 = await mkWorker(2001, 'Алишер', eF1, 'factory');
  const wu2 = await mkWorker(2002, 'Бахтиёр', eF2, 'factory');
  const wuW = await mkWorker(2003, 'Цеховой', eW1, 'workshop');

  // записи из бота (pending) — через флаг, как в bot_commit_draft
  const botRec = async (wu, emp, op, qty, dateExpr = 'public.tashkent_today()') => {
    await db.query('reset role');
    let id;
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('app.bot_write', 'on', true)`);
      id = (await tx.query(`insert into work_records (employee_id, catalog_operation_id, quantity, date, bot_user_id) values ($1, $2, $3, ${dateExpr}, $4) returning id`, [emp, op, qty, wu])).rows[0].id;
    });
    await asUser(db, current);
    return id;
  };
  await as(db, 'master');
  const r1 = await botRec(wu1, eF1, oOver, 10);
  const r2 = await botRec(wu1, eF1, oLine, 5);
  const r3 = await botRec(wu2, eF2, oOver, 7);
  const r4 = await botRec(wu1, eF1, oOver, 3, 'public.tashkent_today() - 1');
  const rW = await botRec(wuW, eW1, oOver, 9);
  check('записи бота — pending', (await admin(db, `select count(*)::int as n from work_records where status = 'pending'`)).rows[0].n === 5);

  // ===================== A. Подтверждение (сайт) =====================
  const pend = await site(db, 'staff_pending', { date: (await admin(db, `select public.tashkent_today()::text as d`)).rows[0].d });
  check('staff_pending: мастер видит ожидающие ТОЛЬКО своего цеха (4 из 5), по дням и записи дня', pend.count === 4 && pend.days.length === 2 && pend.records.length === 3 && pend.shop === 'factory', JSON.stringify(pend).slice(0, 200));
  check('записи сгруппированы по работникам (по имени), есть метка, количество, сумма', pend.records[0].employee_name === 'Алишер' && pend.records[0].label === 'Футболка · Оверлок' && Number(pend.records[0].total) === 1200 && pend.records.at(-1).employee_name === 'Бахтиёр');
  check('мастер не запрашивает чужой цех', await siteFails(db, 'staff_pending', { shop: 'workshop' }, /not_your_shop/));

  const cf = await site(db, 'staff_confirm', { ids: [r1] });
  check('подтвердить одну запись: confirmed=1, сумма 1200', cf.confirmed === 1 && Number(cf.total) === 1200);
  const rec1 = (await admin(db, `select status, decided_by, decided_at is not null as dt from work_records where id = $1`, [r1])).rows[0];
  check('запись стала confirmed, записаны кто и когда', rec1.status === 'confirmed' && rec1.decided_by === UIDS.master && rec1.dt === true);
  check('подтверждённая запись теперь в work_records_view (идёт в оплату)', (await db.query(`select 1 from work_records_view where id = $1`, [r1])).rows.length === 1);
  check('повторное подтверждение той же записи ничего не делает', (await site(db, 'staff_confirm', { ids: [r1] })).confirmed === 0);
  check('ids с записью чужого цеха: не подтверждается (молча пропущена)', (await site(db, 'staff_confirm', { ids: [rW] })).confirmed === 0 && (await admin(db, `select status from work_records where id = $1`, [rW])).rows[0].status === 'pending');

  // изменить количество при подтверждении
  const adj = await site(db, 'staff_adjust', { id: r2, quantity: 4 });
  check('изменить количество и подтвердить: 5→4, ставка прежняя, 4 × 80 = 320', adj.old_quantity === 5 && adj.quantity === 4 && Number(adj.total) === 320 && adj.notify.chat_id === 2001, JSON.stringify(adj));
  const rec2 = (await admin(db, `select status, quantity, quantity_original from work_records where id = $1`, [r2])).rows[0];
  check('запись confirmed с количеством 4, исходное 5 сохранено', rec2.status === 'confirmed' && rec2.quantity === 4 && rec2.quantity_original === 5);
  check('нулевое/дробное количество отклонено', (await siteFails(db, 'staff_adjust', { id: r3, quantity: 0 }, /invalid_quantity/)) && (await siteFails(db, 'staff_adjust', { id: r3, quantity: 2.5 }, /invalid_quantity/)));
  check('уже решённую запись менять нельзя', await siteFails(db, 'staff_adjust', { id: r2, quantity: 9 }, /already_decided/));

  // отклонить
  check('отклонение без причины отказано', await siteFails(db, 'staff_reject', { id: r3, reason: '  ' }, /invalid_reason/));
  const rej = await site(db, 'staff_reject', { id: r3, reason: 'Не из этой смены' });
  check('отклонение: статус rejected, причина сохранена, для работника есть уведомление', rej.reason === 'Не из этой смены' && rej.notify.chat_id === 2002);
  check('отклонённая запись не попадает в work_records_view', (await db.query(`select 1 from work_records_view where id = $1`, [r3])).rows.length === 0);
  check('чужую запись (другой цех) отклонить нельзя', await siteFails(db, 'staff_reject', { id: rW, reason: 'x' }, /not_your_shop/));

  // подтвердить всё по работнику / по цеху
  const r5 = await botRec(wu1, eF1, oOver, 2);
  const r6 = await botRec(wu2, eF2, oLine, 6);
  const allW = await site(db, 'staff_confirm', { employee_id: eF1 });
  check('«подтвердить всё» по работнику: подтверждены его ожидающие (r4 вчера + r5), чужие нет', allW.confirmed === 2 && (await admin(db, `select status from work_records where id = $1`, [r6])).rows[0].status === 'pending');
  const allShop = await site(db, 'staff_confirm', {});
  check('«подтвердить всё» по цеху: остальное подтверждено, запись другого цеха — нет', allShop.confirmed === 1 && (await admin(db, `select status from work_records where id = $1`, [rW])).rows[0].status === 'pending');

  // ===================== B. Журнал правок =====================
  check('подтверждение само по себе в журнал не пишется (только правка с изменением количества)', (await admin(db, `select count(*)::int as n from work_record_audit`)).rows[0].n === 2); // adjust + reject
  const au0 = (await admin(db, `select action, actor_name, via, employee_name, shop, reason from work_record_audit order by created_at`)).rows;
  check('журнал: «исправил количество при подтверждении» и «отклонил» с причиной, кто и откуда', au0[0].action === 'adjust' && au0[1].action === 'reject' && au0[1].reason === 'Не из этой смены' && au0[0].actor_name === 'master@test.test' && au0[0].via === 'site' && au0[0].shop === 'factory');

  const ed = await site(db, 'staff_edit_record', { id: r1, quantity: 12 });
  check('правка подтверждённой записи: 10→12, ставка прежняя, работнику (из бота) — уведомление', ed.old_quantity === 10 && ed.quantity === 12 && Number(ed.total) === 1440 && ed.changed === true && ed.notify.chat_id === 2001, JSON.stringify(ed));
  const au1 = (await admin(db, `select action, before, after, actor_name from work_record_audit where action = 'edit'`)).rows;
  check('журнал правки: что было (10, 1200) и что стало (12, 1440), кто', au1.length === 1 && au1[0].before.quantity === 10 && Number(au1[0].before.total) === 1200 && au1[0].after.quantity === 12 && Number(au1[0].after.total) === 1440 && au1[0].actor_name === 'master@test.test', JSON.stringify(au1[0]));
  const ed2 = await site(db, 'staff_edit_record', { id: r1, catalog_operation_id: oLine });
  check('правка операции: ставка берётся у новой (80), журнал фиксирует смену', Number(ed2.rate) === 80 && (await admin(db, `select count(*)::int as n from work_record_audit where action = 'edit'`)).rows[0].n === 2);
  await site(db, 'staff_edit_record', { id: r1, quantity: 12 }); // без изменений
  check('правка без изменений в журнал не пишется', (await admin(db, `select count(*)::int as n from work_record_audit where action = 'edit'`)).rows[0].n === 2);
  check('правка записи другого цеха отказана', await siteFails(db, 'staff_edit_record', { id: rW, quantity: 1 }, /not_your_shop/));
  check('отклонённую запись править нельзя', await siteFails(db, 'staff_edit_record', { id: r3, quantity: 1 }, /not_editable/));

  const del = await site(db, 'staff_delete_record', { id: r1 });
  check('удаление подтверждённой записи: уведомление работнику, запись удалена', del.notify.chat_id === 2001 && (await admin(db, `select 1 from work_records where id = $1`, [r1])).rows.length === 0);
  const au2 = (await admin(db, `select action, before, after from work_record_audit where action = 'delete'`)).rows;
  check('журнал удаления: что было (метка, количество, сумма), после — пусто', au2.length === 1 && au2[0].before.label === 'Футболка · Строчка' && au2[0].before.quantity === 12 && au2[0].after === null, JSON.stringify(au2[0]));
  const delPending = await botRec(wu2, eF2, oOver, 1);
  await site(db, 'staff_delete_record', { id: delPending });
  check('удаление ожидающей записи в журнал не пишется', (await admin(db, `select count(*)::int as n from work_record_audit where action = 'delete'`)).rows[0].n === 1);

  // прямая правка через таблицу (в обход функций) тоже попадает в журнал
  await db.query(`update work_records set quantity = quantity + 1 where id = $1`, [r2]);
  check('прямой UPDATE подтверждённой записи через таблицу тоже пишется в журнал (триггер)', (await admin(db, `select count(*)::int as n from work_record_audit where action = 'edit'`)).rows[0].n === 3);
  await db.query(`delete from work_records where id = $1`, [r5]);
  check('и прямой DELETE подтверждённой записи — тоже', (await admin(db, `select count(*)::int as n from work_record_audit where action = 'delete'`)).rows[0].n === 2);
  // статус нельзя поменять прямым UPDATE
  const r8 = await botRec(wu2, eF2, oOver, 1);
  await db.query(`update work_records set status = 'confirmed' where id = $1`, [r8]);
  check('статус прямым UPDATE не меняется (только функциями)', (await admin(db, `select status from work_records where id = $1`, [r8])).rows[0].status === 'pending');

  // доступ к журналу
  check('мастер журнал не видит и не пишет в него', (await db.query(`select 1 from work_record_audit`)).rows.length === 0 && (await fails(db, `insert into work_record_audit (action) values ('edit')`, [], /permission denied/)));
  await as(db, 'ceo');
  check('CEO видит журнал целиком', (await db.query(`select count(*)::int as n from work_record_audit`)).rows[0].n >= 6);
  await as(db, 'kladovshik');
  check('кладовщик: журнал, staff_* и бот-функции недоступны', (await db.query(`select 1 from work_record_audit`)).rows.length === 0 && (await siteFails(db, 'staff_pending', { shop: 'factory' }, /insufficient_privilege/)) && (await fails(db, `select public.bot_as_staff(1,'staff_pending','{}')`, [], /permission denied/)));
  await as(db, 'master');

  // ===================== C. Работники =====================
  const ws = await site(db, 'staff_workers', {});
  check('профессии с числом людей, «без профессии» отдельно (1), всего 3', ws.total === 3 && ws.none === 1 && ws.professions.find((x) => x.name === 'Швея').count === 2 && ws.professions.find((x) => x.name === 'Утюжник').count === 0, JSON.stringify(ws));
  const wl = await site(db, 'staff_workers_list', { profession_id: 'all' });
  check('«Все»: сотрудники цеха (без чужого цеха), с меткой «в боте» и итогом за месяц', wl.length === 3 && !wl.some((x) => x.name === 'Цеховой') && wl.find((x) => x.name === 'Алишер').in_bot === true && wl.find((x) => x.name === 'Без профессии-Ф').in_bot === false);
  const wn = await site(db, 'staff_workers_list', { profession_id: 'none' });
  check('«Профессия не указана»: один сотрудник', wn.length === 1 && wn[0].name === 'Без профессии-Ф');
  const wp = await site(db, 'staff_workers_list', { profession_id: pSew });
  check('по профессии «Швея»: двое', wp.length === 2);
  const wa = wl.find((x) => x.name === 'Алишер');
  check('итог за месяц — только подтверждённое (не pending, не rejected)', Number(wa.month_total) >= 0 && Number(wl.find((x) => x.name === 'Бахтиёр').month_total) >= 0);
  const card = await site(db, 'staff_worker_card', { employee_id: eF2 });
  check('карточка: имя, профессия, в боте, итоги', card.name === 'Бахтиёр' && card.profession_name === 'Швея' && card.in_bot === true && 'month_total' in card && 'month_pending' in card, JSON.stringify(card));
  check('карточка чужого цеха недоступна', await siteFails(db, 'staff_worker_card', { employee_id: eW1 }, /not_your_shop/));

  await site(db, 'staff_rename_employee', { employee_id: eF3, name: '  Дильшод  ' });
  check('переименование: имя обрезано, в Табеле обновилось', (await admin(db, `select name from employees where id = $1`, [eF3])).rows[0].name === 'Дильшод');
  check('имя занято — отказ; слишком короткое — отказ', (await siteFails(db, 'staff_rename_employee', { employee_id: eF3, name: 'алишер' }, /employee_name_taken/)) && (await siteFails(db, 'staff_rename_employee', { employee_id: eF3, name: 'Д' }, /invalid_name/)));
  await site(db, 'staff_rename_employee', { employee_id: eF1, name: 'Алишер К.' });
  check('переименование сотрудника в боте обновляет и имя в боте', (await admin(db, `select full_name from worker_bot_users where id = $1`, [wu1])).rows[0].full_name === 'Алишер К.');
  await site(db, 'staff_set_profession', { employee_id: eF3, profession_id: pIron });
  check('смена профессии', (await admin(db, `select profession_id from employees where id = $1`, [eF3])).rows[0].profession_id === pIron);
  await site(db, 'staff_set_profession', { employee_id: eF3, profession_id: null });
  check('профессию можно снять («не указана»)', (await admin(db, `select profession_id from employees where id = $1`, [eF3])).rows[0].profession_id === null);
  check('чужой цех/скрытая профессия отказаны', (await siteFails(db, 'staff_set_profession', { employee_id: eW1, profession_id: pIron }, /not_your_shop/)) && (await siteFails(db, 'staff_set_profession', { employee_id: eF3, profession_id: '00000000-0000-0000-0000-00000000dead' }, /profession_not_found/)));

  // работник без профессии не может вносить работу
  await db.query('reset role');
  const wu3 = await mkWorker(2004, 'Без профессии', eF3, 'factory');
  await db.query('set role service_role');
  check('работник без профессии: каталог пуст с пометкой no_profession', (await db.query(`select public.bot_catalog(2004) as r`)).rows[0].r.no_profession === true);
  await db.query('reset role');
  await db.query(`update professions set archived_at = now() where id = $1`, [pIron]);
  await db.query(`update employees set profession_id = $1 where id = $2`, [pIron, eF3]);
  await db.query('set role service_role');
  check('скрытая (архивная) профессия — тоже «нельзя вносить»', (await db.query(`select public.bot_catalog(2004) as r`)).rows[0].r.no_profession === true);
  await db.query('reset role');
  await db.query(`update professions set archived_at = null where id = $1`, [pIron]);
  await db.query(`update employees set profession_id = null where id = $1`, [eF3]);
  await as(db, 'master');
  void wu3;

  const eF4 = (await admin(db, `insert into employees (name, shop) values ('Не в боте', 'factory') returning id`)).rows[0].id;
  const rm = await site(db, 'staff_remove_worker', { employee_id: eF4 }).catch((e) => e.message);
  check('снять с бота того, кто не в боте — отказ', /already_decided/.test(String(rm)));
  const rm2 = await site(db, 'staff_remove_worker', { employee_id: eF2 });
  check('снять с бота: removed, сообщение уйдёт на chat_id', rm2.status === 'removed' && rm2.chat_id === 2002);
  const inv = await site(db, 'staff_invite', { profession_id: pSew });
  check('ссылка: создаётся для цеха мастера, повторный запрос возвращает ту же', inv.shop === 'factory' && inv.created === true && (await site(db, 'staff_invite', { profession_id: pSew })).token === inv.token);
  const inv2 = await site(db, 'staff_invite', { profession_id: pSew, regenerate: true });
  check('«Новый код»: другая ссылка, старая выключена', inv2.token !== inv.token && (await admin(db, `select active from worker_bot_invites where id = $1`, [inv.id])).rows[0].active === false);

  // ===================== D. Каталог =====================
  const ov = await site(db, 'staff_catalog_overview', {});
  const ovSew = ov.find((x) => x.name === 'Швея');
  check('обзор: моделей 1, операций 2, целых 1; у «Утюжника» пусто', ovSew.models === 1 && ovSew.operations === 2 && ovSew.whole === 1 && ov.find((x) => x.name === 'Утюжник').models === 0);
  const mod = await site(db, 'staff_catalog_model', { model_id: mT });
  check('модель: операции с ценой по названию', mod.name === 'Футболка' && mod.ops.length === 2 && mod.ops[0].name === 'Оверлок' && Number(mod.ops[0].rate) === 120 && Number(mod.whole_rate) === 1500, JSON.stringify(mod));
  const nm = await site(db, 'staff_catalog_set', { action: 'add_model', profession_id: pIron, name: '  Майка  ' });
  check('добавить модель (название обрезано)', nm.result === 'ok' && (await admin(db, `select name from catalog_models where id = $1`, [nm.id])).rows[0].name === 'Майка');
  check('дубль модели в профессии отклонён', await siteFails(db, 'staff_catalog_set', { action: 'add_model', profession_id: pIron, name: 'майка' }, /duplicate_name/));
  const no = await site(db, 'staff_catalog_set', { action: 'add_op', model_id: nm.id, name: 'Подгиб', rate: 150 });
  check('добавить операцию с ценой', no.result === 'ok');
  check('цена 0, отрицательная, слишком большая и пустое название отклонены', (await siteFails(db, 'staff_catalog_set', { action: 'add_op', model_id: nm.id, name: 'Х', rate: 0 }, /invalid_rate/)) && (await siteFails(db, 'staff_catalog_set', { action: 'add_op', model_id: nm.id, name: 'Х', rate: 100000000 }, /invalid_rate/)) && (await siteFails(db, 'staff_catalog_set', { action: 'add_op', model_id: nm.id, name: '  ', rate: 5 }, /invalid_name/)));
  await site(db, 'staff_catalog_set', { action: 'set_rate', id: no.id, rate: 175 });
  await site(db, 'staff_catalog_set', { action: 'rename_op', id: no.id, name: 'Подгибка' });
  await site(db, 'staff_catalog_set', { action: 'set_whole_rate', id: nm.id, rate: 900 });
  check('цена, название операции и цена целого изменены', (await admin(db, `select rate_per_piece, name from catalog_operations where id = $1`, [no.id])).rows[0].name === 'Подгибка' && Number((await admin(db, `select whole_rate from catalog_models where id = $1`, [nm.id])).rows[0].whole_rate) === 900);
  await site(db, 'staff_catalog_set', { action: 'set_whole_rate', id: nm.id, rate: null });
  check('цену целого можно убрать', (await admin(db, `select whole_rate from catalog_models where id = $1`, [nm.id])).rows[0].whole_rate === null);
  check('удаление операции без записей — удалена; с записями — в архив', (await site(db, 'staff_catalog_set', { action: 'delete_op', id: no.id })).result === 'deleted' && (await site(db, 'staff_catalog_set', { action: 'delete_op', id: oLine })).result === 'archived');

  // список одним сообщением
  const bulkIn = { profession_id: pIron, apply: false, groups: [
    { model: 'Майка', ops: [{ name: 'Оверлок', rate: 90 }, { name: 'Подгиб', rate: 150 }] },
    { model: 'Шорты', ops: [{ name: 'Карман', rate: 200 }, { name: 'карман', rate: 210 }, { name: 'Пояс', rate: 300 }] },
  ] };
  const dry = await site(db, 'staff_catalog_bulk', bulkIn);
  check('предпросмотр списка: новых моделей 1, существующих 1, новых операций 4, пропущено 1 (дубль в списке); в базе пока ничего', dry.new_models === 1 && dry.existing_models === 1 && dry.new_ops === 4 && dry.skipped === 1 && dry.applied === false && (await admin(db, `select count(*)::int as n from catalog_models where name = 'Шорты'`)).rows[0].n === 0, JSON.stringify(dry));
  const done = await site(db, 'staff_catalog_bulk', { ...bulkIn, apply: true });
  check('применение: те же счётчики и всё создано', done.applied === true && done.new_ops === 4 && (await admin(db, `select count(*)::int as n from catalog_operations o join catalog_models m on m.id = o.model_id where m.name in ('Майка','Шорты') and o.archived_at is null`)).rows[0].n === 4, JSON.stringify(done));
  const again = await site(db, 'staff_catalog_bulk', { ...bulkIn, apply: true });
  check('повторная загрузка того же списка: всё пропущено как существующее, дублей нет', again.new_models === 0 && again.new_ops === 0 && again.skipped === 5 && again.skipped_list.length === 5, JSON.stringify(again));
  const toModel = await site(db, 'staff_catalog_bulk', { profession_id: pIron, model_id: nm.id, apply: true, groups: [{ model: null, ops: [{ name: 'Манжета', rate: 60 }] }] });
  check('операции без модели идут в выбранную модель', toModel.new_ops === 1);
  check('операция без модели и без выбранной модели — отказ; пустой список — отказ', (await siteFails(db, 'staff_catalog_bulk', { profession_id: pIron, apply: false, groups: [{ model: null, ops: [{ name: 'Х', rate: 5 }] }] }, /model_required/)) && (await siteFails(db, 'staff_catalog_bulk', { profession_id: pIron, apply: false, groups: [] }, /empty_list/)));
  check('профессия: создать, переименовать, удалить', await (async () => {
    const pr = await site(db, 'staff_catalog_set', { action: 'add_profession', name: 'Раскрой' });
    await site(db, 'staff_catalog_set', { action: 'rename_profession', id: pr.id, name: 'Раскройщик' });
    const del = await site(db, 'staff_catalog_set', { action: 'delete_profession', id: pr.id });
    return del.result === 'deleted';
  })());


  // ----- перенос операции и модели (049)
  const mDst = await site(db, 'staff_catalog_set', { action: 'add_model', profession_id: pSew, name: 'Приёмник' });
  const mvOp = await site(db, 'staff_catalog_set', { action: 'add_op', model_id: mT, name: 'Переносимая', rate: 70 });
  const recMv = await botRec(wu1, eF1, mvOp.id, 3);
  await site(db, 'staff_catalog_set', { action: 'move_op', id: mvOp.id, model_id: mDst.id });
  check('move_op: операция в другой модели, тот же id, ставка и запись на месте', (await admin(db, `select model_id, rate_per_piece::numeric as r from catalog_operations where id = $1`, [mvOp.id])).rows[0].model_id === mDst.id && Number((await admin(db, `select rate_per_piece from work_records where id = $1`, [recMv])).rows[0].rate_per_piece) === 70);
  await site(db, 'staff_catalog_set', { action: 'add_op', model_id: mT, name: 'Переносимая', rate: 5 });
  check('move_op в модель с такой же операцией — отказ «уже есть»', await siteFails(db, 'staff_catalog_set', { action: 'move_op', id: (await admin(db, `select id from catalog_operations where model_id = $1 and name = 'Переносимая'`, [mT])).rows[0].id, model_id: mDst.id }, /duplicate_name/));
  check('move_op в несуществующую/скрытую модель — отказ', await siteFails(db, 'staff_catalog_set', { action: 'move_op', id: mvOp.id, model_id: '00000000-0000-0000-0000-00000000dead' }, /catalog_item_not_found/));
  await site(db, 'staff_catalog_set', { action: 'move_model', id: mDst.id, profession_id: pIron });
  check('move_model: модель в другой профессии', (await admin(db, `select profession_id from catalog_models where id = $1`, [mDst.id])).rows[0].profession_id === pIron);
  check('move_model в скрытую профессию — отказ', await siteFails(db, 'staff_catalog_set', { action: 'move_model', id: mDst.id, profession_id: '00000000-0000-0000-0000-00000000dead' }, /profession_not_found/));
  const allM = await site(db, 'staff_catalog_all', {});
  check('staff_catalog_all: модели с профессией и числом операций', allM.some((x) => x.name === 'Футболка' && x.profession_name === 'Швея') && allM.some((x) => x.name === 'Приёмник' && x.profession_name === 'Утюжник'));
  await as(db, 'kladovshik');
  check('кладовщику перенос и список моделей недоступны', (await siteFails(db, 'staff_catalog_set', { action: 'move_op', id: mvOp.id, model_id: mT }, /insufficient_privilege/)) && (await siteFails(db, 'staff_catalog_all', {}, /insufficient_privilege/)));
  await as(db, 'master');

  // ===================== E. Бот: bot_as_staff =====================
  check('привязанный мастер: staff_pending из бота — только его цех', (await bot(db, 1001, 'staff_pending')).shop === 'factory');
  check('мастер не может выбрать чужой цех через бота', await botFails(db, 1001, 'staff_pending', { shop: 'workshop' }, /not_your_shop/));
  const ceoF = await bot(db, 1002, 'staff_pending');
  check('CEO без выбранного цеха по умолчанию — Фабрика', ceoF.shop === 'factory');
  await db.query('reset role');
  await db.query('set role service_role');
  await db.query(`select public.bot_staff_set_shop(1002, 'workshop')`);
  await db.query(`select public.bot_staff_set_shop(1001, 'workshop')`);
  await db.query('reset role');
  await as(db, 'master');
  const ceoW = await bot(db, 1002, 'staff_pending');
  check('CEO переключил цех в боте: видит «Цех» (1 ожидающая запись)', ceoW.shop === 'workshop' && ceoW.count === 1);
  check('мастер переключить цех в боте не может (его цех — из профиля)', (await bot(db, 1001, 'staff_pending')).shop === 'factory');
  const resolved = await (async () => {
    await db.query('reset role');
    await db.query('set role service_role');
    try {
      return (await db.query(`select public.bot_staff_resolve(1002) as r`)).rows[0].r;
    } finally {
      await db.query('reset role');
      await as(db, 'master');
    }
  })();
  check('resolve: у CEO shop = выбранный', resolved.shop === 'workshop' && resolved.role === 'ceo');
  const cfBot = await bot(db, 1002, 'staff_confirm', { shop: 'workshop' });
  check('CEO подтверждает записи цеха «Цех» из бота', cfBot.confirmed === 1);
  check('неизвестная/служебная функция через бота недоступна', (await botFails(db, 1001, 'create_worker_invite', {}, /unknown_function/)) && (await botFails(db, 1001, 'staff_nope', {}, /unknown_function/)) && (await botFails(db, 1001, '_actor', {}, /unknown_function/)));
  check('непривязанный Telegram — отказ', await botFails(db, 7777, 'staff_pending', {}, /insufficient_privilege/));
  check('вызов bot_as_staff с сайта (authenticated) запрещён', await fails(db, `select public.bot_as_staff(1001, 'staff_pending', '{}')`, [], /permission denied/));
  const viaBot = await (async () => {
    const r7 = await botRec(wu1, eF1, oOver, 20);
    await db.query('reset role');
    await db.query(`update profiles set current_shop = 'factory' where id = $1`, [UIDS.master]);
    await as(db, 'master');
    await bot(db, 1001, 'staff_confirm', { ids: [r7] });
    await bot(db, 1001, 'staff_edit_record', { id: r7, quantity: 21 });
    return (await admin(db, `select via, actor_name from work_record_audit where record_id = $1 and action = 'edit'`, [r7])).rows[0];
  })();
  check('правка из бота пишется в журнал с via = bot и именем мастера', viaBot && viaBot.via === 'bot' && viaBot.actor_name === 'master@test.test', JSON.stringify(viaBot));
  check('после вызова из бота актёр не «залипает» в сессии', ((await admin(db, `select coalesce(current_setting('app.staff_actor', true), '') as a`)).rows[0].a) === '');

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(String(e.message ?? e).slice(0, 700));
  process.exit(1);
});
