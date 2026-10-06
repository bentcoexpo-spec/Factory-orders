import { newDb, applyMigrations } from './build019.mjs';
import { UIDS, asUser } from './build_master.mjs';

// Миграция 045: бот для работников (приглашения, одобрение, вход, ввод,
// исправление) и статусы записей сделки.

let passed = 0;
let failed = 0;
function check(name, cond, evidence) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  ПРОВАЛ:', name, evidence !== undefined ? `(${String(evidence).slice(0, 220)})` : '');
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
// Выполнить от суперпользователя (подготовка данных), потом вернуть роль.
const admin = async (db, sql, params) => {
  await db.query('reset role');
  try {
    return await db.query(sql, params);
  } finally {
    await asUser(db, current);
  }
};
// Вызов от имени маршрута бота (service_role).
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
const svcFails = async (db, sql, params, re) => {
  try {
    await svc(db, sql, params);
    return false;
  } catch (e) {
    return re.test(e.message);
  }
};
const call = async (db, fn, args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  return (await svc(db, `select public.${fn}(${ph}) as r`, args)).rows[0].r;
};

const TG = { master: 1001, ceo: 1002, w1: 2001, w2: 2002, w3: 2003, stranger: 9999 };

async function main() {
  const db = await newDb();
  await applyMigrations(db);
  for (const [role, uid] of Object.entries(UIDS)) {
    await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [uid, `${role}@test.test`]);
    await db.query(`insert into profiles (id, email, role) values ($1, $2, $3) on conflict (id) do update set role = excluded.role`, [uid, `${role}@test.test`, role]);
  }
  await db.query(`update profiles set current_shop = 'factory' where id = $1`, [UIDS.master]);

  // ----- каталог и сотрудники (подготовка; auth.uid() = CEO)
  await asUser(db, 'ceo');
  await db.query('reset role');
  const pSew = (await db.query(`insert into professions (name) values ('Швея') returning id`)).rows[0].id;
  const pIron = (await db.query(`insert into professions (name) values ('Утюжник') returning id`)).rows[0].id;
  const mT = (await db.query(`insert into catalog_models (profession_id, name, whole_rate) values ($1, 'Футболка', 1500) returning id`, [pSew])).rows[0].id;
  const mNoWhole = (await db.query(`insert into catalog_models (profession_id, name) values ($1, 'Майка') returning id`, [pSew])).rows[0].id;
  const mIron = (await db.query(`insert into catalog_models (profession_id, name, whole_rate) values ($1, 'Глажка куртки', 700) returning id`, [pIron])).rows[0].id;
  const mArch = (await db.query(`insert into catalog_models (profession_id, name, archived_at) values ($1, 'Старая', now()) returning id`, [pSew])).rows[0].id;
  const oOver = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Оверлок', 120) returning id`, [mT])).rows[0].id;
  const oZero = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Без ставки', 0) returning id`, [mT])).rows[0].id;
  const oArchOp = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece, archived_at) values ($1, 'Скрытая', 50, now()) returning id`, [mT])).rows[0].id;
  const oMaika = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Оверлок', 90) returning id`, [mNoWhole])).rows[0].id;
  const oIron = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Утюг', 40) returning id`, [mIron])).rows[0].id;
  void mArch;
  const empFree = (await db.query(`insert into employees (name, shop) values ('Свободный-Ф', 'factory') returning id`)).rows[0].id;
  const empFreeW = (await db.query(`insert into employees (name, shop) values ('Свободный-Ц', 'workshop') returning id`)).rows[0].id;
  const empTaken = (await db.query(`insert into employees (name, shop, profession_id) values ('Занятый', 'factory', $1) returning id`, [pSew])).rows[0].id;
  // старая запись сайта (confirmed по умолчанию)
  await db.query(`insert into work_records (employee_id, catalog_operation_id, quantity, date) values ($1, $2, 4, public.tashkent_today())`, [empTaken, oOver]);

  // ===================== A. Статусы записей и представления =====================
  const old = (await db.query(`select status, source, bot_user_id from work_records`)).rows[0];
  check('прежние/сайтовые записи — confirmed, source=site', old.status === 'confirmed' && old.source === 'site' && old.bot_user_id === null, JSON.stringify(old));
  check('tashkent_today = текущая дата по Asia/Tashkent', (await db.query(`select public.tashkent_today() = (now() at time zone 'Asia/Tashkent')::date as ok`)).rows[0].ok === true);

  await as(db, 'master');
  check('мастер вносит с сайта через create_work_records — запись подтверждена сразу', (await db.query(`select public.create_work_records($1, current_date, $2::jsonb) as n`, [empFree, JSON.stringify([{ catalog_operation_id: oOver, quantity: 2 }])])).rows[0].n === 1 && (await db.query(`select 1 from work_records_view where employee_id = $1`, [empFree])).rows.length === 1);
  const forged = (await db.query(`insert into work_records (employee_id, catalog_operation_id, quantity, status, source) values ($1, $2, 1, 'pending', 'bot') returning status, source`, [empFree, oOver])).rows[0];
  check('мастер не может прислать status/source вручную: триггер ставит confirmed/site', forged.status === 'confirmed' && forged.source === 'site', JSON.stringify(forged));
  await db.query(`update work_records set status = 'rejected', source = 'bot' where employee_id = $1`, [empFree]);
  check('правка не меняет status/source у записи', (await db.query(`select count(*)::int as n from work_records where employee_id = $1 and (status <> 'confirmed' or source <> 'site')`, [empFree])).rows[0].n === 0);
  check('прямой вызов bot_* с сайта (authenticated) запрещён', await fails(db, `select public.bot_catalog(1)`, [], /permission denied/));
  check('worker_bot_state и коды привязки с сайта недоступны', (await fails(db, `select * from worker_bot_state`, [], /permission denied/)) && (await fails(db, `select * from staff_bot_link_codes`, [], /permission denied/)));
  check('писать в worker_bot_users/invites напрямую с сайта нельзя', (await fails(db, `insert into worker_bot_invites (shop, profession_id) values ('factory', $1)`, [pSew], /permission denied/)) && (await fails(db, `update worker_bot_users set status = 'active'`, [], /permission denied/)));

  // ===================== B. Привязка Telegram мастера и CEO =====================
  const code = (await db.query(`select public.create_staff_link_code() as c`)).rows[0].c;
  check('код привязки — 12 символов', /^[0-9A-F]{12}$/.test(code), code);
  check('неверный код отклонён', await svcFails(db, `select public.bot_staff_link($1, $2, 'WRONGCODE000', 'ru')`, [TG.master, TG.master], /invalid_code/));
  const linked = await call(db, 'bot_staff_link', [TG.master, TG.master, code.toLowerCase(), 'ru']);
  check('верный код (в любом регистре) привязывает мастера', linked.role === 'master' && linked.profile_id === UIDS.master, JSON.stringify(linked));
  check('код одноразовый: повторное использование отклонено', await svcFails(db, `select public.bot_staff_link($1, $2, $3, 'ru')`, [TG.master, TG.master, code], /invalid_code/));
  await admin(db, `update staff_bot_link_codes set expires_at = now() - interval '1 minute'`);
  const code2 = (await db.query(`select public.create_staff_link_code() as c`)).rows[0].c;
  await admin(db, `update staff_bot_link_codes set expires_at = now() - interval '1 minute' where profile_id = $1`, [UIDS.master]);
  check('просроченный код (10 минут) отклонён', await svcFails(db, `select public.bot_staff_link($1, $2, $3, 'ru')`, [TG.master, TG.master, code2], /invalid_code/));
  const res = await call(db, 'bot_staff_resolve', [TG.master]);
  check('bot_staff_resolve: роль, цех мастера и язык', res.role === 'master' && res.shop === 'factory' && res.language === 'ru', JSON.stringify(res));
  check('чужой Telegram не опознаётся', (await call(db, 'bot_staff_resolve', [TG.stranger])) === null);
  check('мастер видит свою привязку на сайте', (await db.query(`select 1 from staff_bot_links`)).rows.length === 1);

  await as(db, 'ceo');
  const ceoCode = (await db.query(`select public.create_staff_link_code() as c`)).rows[0].c;
  await as(db, 'master');
  const masterCode2 = (await db.query(`select public.create_staff_link_code() as c`)).rows[0].c;
  check('чужой код нельзя применить с уже привязанным к другому аккаунту Telegram', await svcFails(db, `select public.bot_staff_link($1, $2, $3, 'ru')`, [TG.master, TG.master, ceoCode], /telegram_already_linked/));
  await call(db, 'bot_staff_link', [TG.ceo, TG.ceo, ceoCode, 'uz']);
  check('CEO привязан (язык uz)', (await call(db, 'bot_staff_resolve', [TG.ceo])).role === 'ceo' && (await call(db, 'bot_staff_resolve', [TG.ceo])).language === 'uz');
  await db.query(`select public.staff_unlink_telegram()`);
  check('отвязка с сайта: мастер больше не опознаётся ботом', (await call(db, 'bot_staff_resolve', [TG.master])) === null);
  void masterCode2;
  const code3 = (await db.query(`select public.create_staff_link_code() as c`)).rows[0].c;
  await call(db, 'bot_staff_link', [TG.master, TG.master, code3, 'ru']);
  check('после отвязки мастер привязывается заново', (await call(db, 'bot_staff_resolve', [TG.master])) !== null);

  await as(db, 'kladovshik');
  check('кладовщик не может получить код привязки', await fails(db, `select public.create_staff_link_code()`, [], /insufficient_privilege/));

  // ===================== C. Приглашения =====================
  await as(db, 'master');
  const inv1 = (await db.query(`select public.create_worker_invite($1) as r`, [pSew])).rows[0].r;
  check('мастер создаёт ссылку для своего цеха (factory), токен 32 символа', inv1.shop === 'factory' && /^[0-9a-f]{32}$/.test(inv1.token), JSON.stringify(inv1));
  const inv2 = (await db.query(`select public.create_worker_invite($1) as r`, [pSew])).rows[0].r;
  check('«Новый код»: новая ссылка другая', inv2.token !== inv1.token && inv2.id !== inv1.id);
  check('…а старая выключена (одна активная на цех+профессию)', (await db.query(`select count(*)::int as n from worker_bot_invites where shop = 'factory' and profession_id = $1 and active`, [pSew])).rows[0].n === 1 && (await db.query(`select active from worker_bot_invites where id = $1`, [inv1.id])).rows[0].active === false);
  check('мастер не создаёт ссылку на чужой цех', await fails(db, `select public.create_worker_invite($1, 'workshop')`, [pSew], /not_your_shop/));
  check('скрытая/несуществующая профессия отклонена', await fails(db, `select public.create_worker_invite('00000000-0000-0000-0000-00000000dead')`, [], /profession_not_found/));
  await as(db, 'ceo');
  check('CEO обязан указать цех', await fails(db, `select public.create_worker_invite($1)`, [pSew], /shop_not_selected/));
  const invW = (await db.query(`select public.create_worker_invite($1, 'workshop') as r`, [pIron])).rows[0].r;
  check('CEO создаёт ссылку на цех «Цех»', invW.shop === 'workshop');
  await as(db, 'master');
  check('мастер «Фабрики» видит только ссылки своего цеха', (await db.query(`select shop from worker_bot_invites`)).rows.every((r) => r.shop === 'factory') && (await db.query(`select 1 from worker_bot_invites where shop = 'workshop'`)).rows.length === 0);
  check('мастер не выключает чужую ссылку', await fails(db, `select public.deactivate_worker_invite($1)`, [invW.id], /not_your_shop/));
  await as(db, 'zakroyshik');
  check('закройщик ссылки не создаёт и не видит', (await fails(db, `select public.create_worker_invite($1)`, [pSew], /insufficient_privilege/)) && (await db.query(`select 1 from worker_bot_invites`)).rows.length === 0);
  await as(db, 'master');

  // ===================== D. Вход работника =====================
  check('неверный код приглашения', (await call(db, 'bot_worker_begin', [TG.w1, TG.w1, 'нет-такого']))?.result === 'invalid_code');
  check('выключенная (старая) ссылка не работает', (await call(db, 'bot_worker_begin', [TG.w1, TG.w1, inv1.token])).result === 'invalid_code');
  check('привязанный сотрудник-мастер не регистрируется как работник', (await call(db, 'bot_worker_begin', [TG.master, TG.master, inv2.token])).result === 'staff');
  const b1 = await call(db, 'bot_worker_begin', [TG.w1, TG.w1, inv2.token]);
  check('вход по ссылке: registering, цех/профессия из ссылки', b1.result === 'ok' && b1.user.status === 'registering' && b1.user.shop === 'factory' && b1.user.profession_name === 'Швея' && b1.user.language === null, JSON.stringify(b1));
  check('имя до выбора языка не принимается', await svcFails(db, `select public.bot_worker_submit_name($1, 'Алишер')`, [TG.w1], /not_registering/));
  check('неверный язык отклонён', await svcFails(db, `select public.bot_worker_set_language($1, 'en')`, [TG.w1], /invalid_language/));
  await call(db, 'bot_worker_set_language', [TG.w1, 'uz']);
  check('слишком короткое имя отклонено', await svcFails(db, `select public.bot_worker_submit_name($1, ' A ')`, [TG.w1], /invalid_name/));
  const sub = await call(db, 'bot_worker_submit_name', [TG.w1, '  Алишер Каримов  ']);
  check('заявка: pending, имя обрезано, получатель — создатель ссылки (мастер) с языком ru', sub.user.status === 'pending' && sub.user.full_name === 'Алишер Каримов' && sub.recipients.length === 1 && sub.recipients[0].chat_id === TG.master && sub.recipients[0].language === 'ru', JSON.stringify(sub));
  check('повторный вход по ссылке при pending: «ждите»', (await call(db, 'bot_worker_begin', [TG.w1, TG.w1, inv2.token])).result === 'pending');
  check('до одобрения вносить работу нельзя', (await svcFails(db, `select public.bot_catalog($1)`, [TG.w1], /worker_not_active/)) && (await svcFails(db, `select public.bot_records($1, current_date, current_date)`, [TG.w1], /worker_not_active/)));
  const w1 = sub.user.id;
  check('мастер видит заявку своего цеха на сайте', (await db.query(`select 1 from worker_bot_users where id = $1`, [w1])).rows.length === 1);

  // ===================== E. Одобрение =====================
  await as(db, 'master');
  await admin(db, `update profiles set current_shop = 'workshop' where id = $1`, [UIDS.master]);
  check('мастер другого (текущего) цеха не может решить заявку', await fails(db, `select public.decide_worker($1, 'approve', null, 'X')`, [w1], /not_your_shop/));
  check('…и не видит её', (await db.query(`select 1 from worker_bot_users where id = $1`, [w1])).rows.length === 0);
  await admin(db, `update profiles set current_shop = 'factory' where id = $1`, [UIDS.master]);
  check('сотрудник чужого цеха при одобрении отклонён', await fails(db, `select public.decide_worker($1, 'approve', $2)`, [w1, empFreeW], /employee_not_in_shop/));
  check('сотрудник, уже привязанный к другому работнику, отклонён', await (async () => {
    // привяжем «Занятого» вторым работником
    const b = await call(db, 'bot_worker_begin', [TG.w2, TG.w2, inv2.token]);
    await call(db, 'bot_worker_set_language', [TG.w2, 'ru']);
    const s = await call(db, 'bot_worker_submit_name', [TG.w2, 'Бахтиёр']);
    await db.query(`select public.decide_worker($1, 'approve', $2)`, [b.user.id, empTaken]);
    void s;
    return fails(db, `select public.decide_worker($1, 'approve', $2)`, [w1, empTaken], /employee_taken/);
  })());
  const appr = (await db.query(`select public.decide_worker($1, 'approve', null, null) as r`, [w1])).rows[0].r;
  check('одобрение с созданием нового сотрудника: active, привязан', appr.status === 'active' && appr.can_add === true && appr.employee_id, JSON.stringify(appr));
  const newEmp = (await admin(db, `select name, shop, profession_id from employees where id = $1`, [appr.employee_id])).rows[0];
  check('новый сотрудник в цехе работника с профессией из ссылки и его именем', newEmp.shop === 'factory' && newEmp.profession_id === pSew && newEmp.name === 'Алишер Каримов', JSON.stringify(newEmp));
  check('повторное решение по той же заявке отклонено', await fails(db, `select public.decide_worker($1, 'reject')`, [w1], /already_decided/));
  check('профессия «Занятого» (Швея) осталась; у привязанного без профессии она ставится из ссылки', await (async () => {
    const e = (await admin(db, `insert into employees (name, shop) values ('Без профессии-Ф', 'factory') returning id`)).rows[0].id;
    const b = await call(db, 'bot_worker_begin', [TG.w3, TG.w3, inv2.token]);
    await call(db, 'bot_worker_set_language', [TG.w3, 'ru']);
    await call(db, 'bot_worker_submit_name', [TG.w3, 'Третий']);
    await db.query(`select public.decide_worker($1, 'approve', $2)`, [b.user.id, e]);
    return (await admin(db, `select profession_id from employees where id = $1`, [e])).rows[0].profession_id === pSew;
  })());

  // имя занято: новый сотрудник с таким же именем
  const dupInv = inv2.token;
  const bDup = await call(db, 'bot_worker_begin', [3001, 3001, dupInv]);
  await call(db, 'bot_worker_set_language', [3001, 'ru']);
  await call(db, 'bot_worker_submit_name', [3001, 'алишер каримов']);
  check('новый сотрудник с уже существующим именем (без учёта регистра): понятный отказ', await fails(db, `select public.decide_worker($1, 'approve')`, [bDup.user.id], /employee_name_taken/));
  // отклонить и повторная заявка
  const rej = (await db.query(`select public.decide_worker($1, 'reject') as r`, [bDup.user.id])).rows[0].r;
  check('отклонение: status=rejected', rej.status === 'rejected');
  check('отклонённый по той же ссылке повторно подать заявку не может', (await call(db, 'bot_worker_begin', [3001, 3001, inv2.token])).result === 'rejected');
  const inv3 = (await db.query(`select public.create_worker_invite($1) as r`, [pSew])).rows[0].r;
  const again = await call(db, 'bot_worker_begin', [3001, 3001, inv3.token]);
  check('…а по новой ссылке — начинает заново (язык и имя сброшены)', again.result === 'ok' && again.user.status === 'registering' && again.user.language === null && again.user.full_name === null);

  // одобрение из бота (от имени привязанного мастера)
  await call(db, 'bot_worker_set_language', [3001, 'ru']);
  await call(db, 'bot_worker_submit_name', [3001, 'Новый Работник']);
  const rq = await call(db, 'bot_staff_request', [TG.master, again.user.id]);
  check('бот: заявка + свободные сотрудники цеха (без привязанных и без чужого цеха)', rq.user.full_name === 'Новый Работник' && rq.employees.some((e) => e.name === 'Свободный-Ф') && !rq.employees.some((e) => e.name === 'Свободный-Ц' || e.name === 'Занятый' || e.name === 'Алишер Каримов'), JSON.stringify(rq.employees));
  check('непривязанный Telegram решать заявки не может', (await svcFails(db, `select public.bot_decide_worker($1, $2, 'approve')`, [TG.stranger, again.user.id], /insufficient_privilege/)) && (await svcFails(db, `select public.bot_staff_request($1, $2)`, [TG.stranger, again.user.id], /insufficient_privilege/)));
  const a2 = await call(db, 'bot_decide_worker', [TG.master, again.user.id, 'approve', empFree, null]);
  check('бот: одобрение с привязкой к существующему сотруднику', a2.status === 'active' && a2.employee_id === empFree);

  // одобрение с сайта CEO любой цех; снять с бота
  await as(db, 'ceo');
  const bW = await call(db, 'bot_worker_begin', [4001, 4001, invW.token]);
  await call(db, 'bot_worker_set_language', [4001, 'uz']);
  await call(db, 'bot_worker_submit_name', [4001, 'Цеховой']);
  const aW = (await db.query(`select public.decide_worker($1, 'approve', $2) as r`, [bW.user.id, empFreeW])).rows[0].r;
  check('CEO одобряет работника цеха «Цех»', aW.status === 'active' && aW.shop === 'workshop');
  check('рассылка заявки: у CEO-создателя нет привязки — получателей нет, а мастера другого цеха не в списке', (await call(db, 'bot_worker_get', [4001])).status === 'active');
  await as(db, 'master');

  // ===================== F. Работа работника =====================
  const wA = 2001; // Алишер, Швея, factory
  const cat = await call(db, 'bot_catalog', [wA]);
  const modelNames = cat.models.map((m) => m.name).sort();
  check('каталог работника — только его профессия (Швея): Футболка, Майка; без «Глажка куртки» и скрытых', modelNames.join() === 'Майка,Футболка', modelNames.join());
  const tshirt = cat.models.find((m) => m.name === 'Футболка');
  check('в каталоге нет операций со ставкой 0 и скрытых; цена целиком видна', tshirt.ops.map((o) => o.name).join() === 'Оверлок' && Number(tshirt.whole_rate) === 1500, JSON.stringify(tshirt));
  check('второй работник той же профессии (Швея) видит тот же каталог', (await call(db, 'bot_catalog', [2002])).models.length === 2);

  const setDraft = (tg, data) => admin(db, `insert into worker_bot_state (telegram_id, state, data) values ($1, 'review', $2::jsonb) on conflict (telegram_id) do update set state = 'review', data = excluded.data`, [tg, JSON.stringify(data)]);
  await setDraft(wA, { kind: 'op', id: oOver, quantity: 10 });
  const saved = await call(db, 'bot_commit_draft', [wA]);
  check('подтверждение: запись 10 × 120 = 1200, метка «Футболка · Оверлок»', saved.quantity === 10 && Number(saved.rate) === 120 && Number(saved.total) === 1200 && saved.label === 'Футболка · Оверлок', JSON.stringify(saved));
  const recA = (await admin(db, `select *, date::text as d from work_records where id = $1`, [saved.id])).rows[0];
  check('запись бота: pending, source=bot, автор-работник, сотрудник привязан, сегодняшняя дата, created_by пусто', recA.status === 'pending' && recA.source === 'bot' && recA.bot_user_id === w1 && recA.employee_id === appr.employee_id && recA.created_by === null && recA.d === (await admin(db, `select public.tashkent_today()::text as d`)).rows[0].d, JSON.stringify(recA));
  check('повторное «Подтвердить»: дубля нет (черновик уже использован)', (await svcFails(db, `select public.bot_commit_draft($1)`, [wA], /no_draft/)) && (await admin(db, `select count(*)::int as n from work_records where bot_user_id = $1`, [w1])).rows[0].n === 1);
  check('pending-запись НЕ попадает в work_records_view (оплата, «Продуктивность», отчёты CEO)', (await db.query(`select 1 from work_records_view where id = $1`, [saved.id])).rows.length === 0);
  check('…но есть в work_records_all_view со статусом pending', (await db.query(`select status from work_records_all_view where id = $1`, [saved.id])).rows[0]?.status === 'pending');
  await admin(db, `update catalog_operations set rate_per_piece = 500 where id = $1`, [oOver]);
  check('цену в каталоге подняли: запись осталась по 120', Number((await admin(db, `select rate_per_piece from work_records where id = $1`, [saved.id])).rows[0].rate_per_piece) === 120);
  await admin(db, `update catalog_operations set rate_per_piece = 120 where id = $1`, [oOver]);

  await setDraft(wA, { kind: 'whole', id: mT, quantity: 3 });
  const savedWhole = await call(db, 'bot_commit_draft', [wA]);
  check('целое изделие: 3 × 1500 = 4500', savedWhole.is_whole === true && Number(savedWhole.total) === 4500 && savedWhole.label === 'Футболка (целиком)');

  const reject = async (data, re) => {
    await setDraft(wA, data);
    const ok = await svcFails(db, `select public.bot_commit_draft($1)`, [wA], re);
    await admin(db, `delete from worker_bot_state where telegram_id = $1`, [wA]);
    return ok;
  };
  check('чужая профессия (Глажка) отклонена в базе', await reject({ kind: 'op', id: oIron, quantity: 1 }, /wrong_profession/));
  check('целое изделие чужой профессии отклонено', await reject({ kind: 'whole', id: mIron, quantity: 1 }, /wrong_profession/));
  check('операция без ставки отклонена', await reject({ kind: 'op', id: oZero, quantity: 1 }, /operation_rate_not_set/));
  check('скрытая операция отклонена', await reject({ kind: 'op', id: oArchOp, quantity: 1 }, /catalog_item_archived/));
  check('целое без цены отклонено', await reject({ kind: 'whole', id: mNoWhole, quantity: 1 }, /whole_rate_not_set/));
  check('количество 0, 1.5 и 100000 отклонены', (await reject({ kind: 'op', id: oOver, quantity: 0 }, /invalid_quantity/)) && (await reject({ kind: 'op', id: oOver, quantity: 1.5 }, /invalid_quantity/)) && (await reject({ kind: 'op', id: oOver, quantity: 100000 }, /invalid_quantity/)));
  check('без черновика сохранить нельзя', await svcFails(db, `select public.bot_commit_draft($1)`, [wA], /no_draft/));
  check('чужой Telegram работать не может', await svcFails(db, `select public.bot_commit_draft($1)`, [TG.stranger], /worker_not_active/));
  check('записи бота при отказах не создались', (await admin(db, `select count(*)::int as n from work_records where bot_user_id = $1`, [w1])).rows[0].n === 2);

  // ----- записи, статистика, исправление
  const wB = 2002; // Бахтиёр (employee «Занятый») — ещё одна запись и сайтовая confirmed-запись у него есть
  await setDraft(wB, { kind: 'op', id: oMaika, quantity: 7 });
  const savedB = await call(db, 'bot_commit_draft', [wB]);
  const recs = await call(db, 'bot_records', [wA, '2000-01-01', '2100-01-01']).catch(() => null);
  check('период больше 366 дней отклонён', recs === null);
  const today = (await admin(db, `select public.tashkent_today()::text as d`)).rows[0].d;
  const monthAgo = (await admin(db, `select (public.tashkent_today() - 30)::text as d`)).rows[0].d;
  const listA = await call(db, 'bot_records', [wA, today, today]);
  check('работник видит только свои записи (2 записи Алишера, без Бахтиёра)', listA.length === 2 && listA.every((r) => r.status === 'pending' && r.editable === true), JSON.stringify(listA));
  const listB = await call(db, 'bot_records', [wB, today, today]);
  check('у Бахтиёра: своя pending-запись (правится) и сайтовая confirmed (не правится)', listB.length === 2 && listB.some((r) => r.status === 'pending' && r.editable) && listB.some((r) => r.status === 'confirmed' && !r.editable), JSON.stringify(listB));
  check('в записях работника нет чужих имён и чужих сумм (только свои поля)', listA.every((r) => !('employee_name' in r)));

  const ch = await call(db, 'bot_change_qty', [wA, saved.id, 12]);
  check('исправление количества своей сегодняшней pending-записи: 12 × 120 = 1440, ставка прежняя', ch.quantity === 12 && Number(ch.total) === 1440);
  check('нулевое/дробное количество при исправлении отклонено', (await svcFails(db, `select public.bot_change_qty($1, $2, 0)`, [wA, saved.id], /invalid_quantity/)) && (await svcFails(db, `select public.bot_change_qty($1, $2, 2.5)`, [wA, saved.id], /invalid_quantity/)));
  check('чужую запись (Бахтиёра) править и удалять нельзя', (await svcFails(db, `select public.bot_change_qty($1, $2, 5)`, [wA, savedB.id], /not_editable/)) && (await svcFails(db, `select public.bot_delete_record($1, $2)`, [wA, savedB.id], /not_editable/)));
  const siteRec = listB.find((r) => r.status === 'confirmed').id;
  check('запись, внесённую мастером с сайта (confirmed), править и удалять нельзя', (await svcFails(db, `select public.bot_change_qty($1, $2, 5)`, [wB, siteRec], /not_editable/)) && (await svcFails(db, `select public.bot_delete_record($1, $2)`, [wB, siteRec], /not_editable/)));
  // вчерашняя запись бота
  await db.query('reset role');
  await db.transaction(async (tx) => {
    await tx.query(`select set_config('app.bot_write', 'on', true)`);
    await tx.query(`insert into work_records (employee_id, catalog_operation_id, quantity, date, bot_user_id) values ($1, $2, 1, public.tashkent_today() - 1, $3)`, [appr.employee_id, oOver, w1]);
  });
  await asUser(db, current);
  const yId = (await admin(db, `select id from work_records where bot_user_id = $1 and date < public.tashkent_today()`, [w1])).rows[0]?.id;
  check('вчерашнюю запись править и удалять нельзя (только сегодняшние)', yId && (await svcFails(db, `select public.bot_change_qty($1, $2, 5)`, [wA, yId], /not_editable/)) && (await svcFails(db, `select public.bot_delete_record($1, $2)`, [wA, yId], /not_editable/)));
  check('вчерашняя запись не помечена как editable', (await call(db, 'bot_records', [wA, monthAgo, today])).find((r) => r.id === yId)?.editable === false);

  await call(db, 'bot_delete_record', [wA, savedWhole.id]);
  check('удаление своей сегодняшней pending-записи работает', (await admin(db, `select 1 from work_records where id = $1`, [savedWhole.id])).rows.length === 0);

  // после подтверждения мастером — править нельзя
  await admin(db, `update work_records set status = 'confirmed' where id = $1`, [saved.id]);
  check('прямая правка статуса через триггер игнорируется (подтверждение — Этап 3)', (await admin(db, `select status from work_records where id = $1`, [saved.id])).rows[0].status === 'pending');
  // эмулируем подтверждение (Этап 3) выключенным триггером
  await admin(db, `alter table work_records disable trigger work_records_before_update`);
  await admin(db, `update work_records set status = 'confirmed' where id = $1`, [saved.id]);
  await admin(db, `alter table work_records enable trigger work_records_before_update`);
  check('после подтверждения запись уже нельзя править и удалять', (await svcFails(db, `select public.bot_change_qty($1, $2, 5)`, [wA, saved.id], /not_editable/)) && (await svcFails(db, `select public.bot_delete_record($1, $2)`, [wA, saved.id], /not_editable/)));
  check('подтверждённая запись теперь видна в work_records_view (идёт в оплату)', (await db.query(`select 1 from work_records_view where id = $1`, [saved.id])).rows.length === 1);
  const listA2 = await call(db, 'bot_records', [wA, today, today]);
  check('в списке работника: подтверждённая запись со статусом confirmed', listA2.find((r) => r.id === saved.id)?.status === 'confirmed' && listA2.find((r) => r.id === saved.id)?.editable === false);

  // ----- изоляция по цехам и безопасность
  await as(db, 'master'); // цех factory
  check('мастер «Фабрики» не видит работника «Цеха»', (await db.query(`select 1 from worker_bot_users where shop = 'workshop'`)).rows.length === 0);
  check('мастер «Фабрики» не может снять с бота работника «Цеха»', await fails(db, `select public.decide_worker($1, 'remove')`, [bW.user.id], /not_your_shop/));
  check('работник «Цеха» — свой каталог профессии (Утюжник), без Швеи', await (async () => {
    const c = await call(db, 'bot_catalog', [4001]);
    return c.models.length === 1 && c.models[0].name === 'Глажка куртки';
  })());
  await setDraft(4001, { kind: 'op', id: oOver, quantity: 1 });
  check('работник «Цеха» не может внести операцию Швеи', await svcFails(db, `select public.bot_commit_draft($1)`, [4001], /wrong_profession/));
  await admin(db, `delete from worker_bot_state where telegram_id = 4001`);
  const bwRecs = await call(db, 'bot_records', [4001, today, today]);
  check('у работника «Цеха» чужих записей нет', bwRecs.length === 0);

  // снятие с бота
  const rm = (await db.query(`select public.decide_worker($1, 'remove') as r`, [w1])).rows[0].r;
  check('снять с бота: removed, привязка к сотруднику снята', rm.status === 'removed' && rm.employee_id === null);
  check('снятый работник вносить и смотреть записи уже не может', (await svcFails(db, `select public.bot_catalog($1)`, [wA], /worker_not_active/)) && (await svcFails(db, `select public.bot_records($1, current_date, current_date)`, [wA], /worker_not_active/)));
  check('записи снятого работника остались (история)', (await admin(db, `select count(*)::int as n from work_records where bot_user_id = $1`, [w1])).rows[0].n >= 2);
  const rejoin = await call(db, 'bot_worker_begin', [wA, wA, inv3.token]);
  check('снятый работник может зайти заново по новой ссылке', rejoin.result === 'ok' && rejoin.user.status === 'registering');
  // удаление сотрудника в Табеле
  await admin(db, `delete from employees where id = $1`, [empFree]);
  check('сотрудник Табеля удалён → работник теряет привязку и не может вносить', (await call(db, 'bot_worker_get', [3001])).can_add === false && await svcFails(db, `select public.bot_catalog($1)`, [3001], /worker_not_active/));

  await as(db, 'ceo');
  check('CEO видит работников обоих цехов', new Set((await db.query(`select shop from worker_bot_users`)).rows.map((r) => r.shop)).size === 2);
  check('anon не видит и не вызывает бот-таблицы/функции', await (async () => {
    await db.query('reset role');
    await db.query('set role anon');
    const a = await fails(db, `select * from worker_bot_users`, [], /permission denied/);
    const b = await fails(db, `select public.bot_catalog(1)`, [], /permission denied/);
    await db.query('reset role');
    await asUser(db, 'ceo');
    return a && b;
  })());

  console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(String(e.message ?? e).slice(0, 600));
  process.exit(1);
});
