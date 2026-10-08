// Работник не видит деньги (Этап «без денег для работника»):
//  1) тексты, которые видит работник, на ru и uz — без «сум», «so'm», ставок, сумм, заработка;
//  2) функции базы, которые бот вызывает от имени работника, не возвращают ставки и суммы
//     (ни rate, rate_per_piece, whole_rate, price, amount, sum, total…), ни в одном ответе;
//  3) список bot_*-функций закрыт: появится новая — тест потребует решить, работнику она или мастеру.
const { createHarness } = await import('./bot_harness.mts');
const { workerKeys } = await import('../../lib/workerBot/i18n.ts');
const i18n = await import('../../lib/workerBot/i18n.ts');
const h = await createHarness();
const { db, check, finish } = h;

const MONEY = /расценк|сум|so['’ʻ]m|\bsum\b|заработ|зарплат|оплат|ставк|цен[аыуеой]|стоимост|💰|×|ish haqi|maosh|oylik|narx|\bpul\b|summa|to['’ʻ]lov/i;
const PLACEHOLDER = /\{(rate|sum|total|price|amount|earn\w*)\}/i;

// ===================== 1. Тексты работника =====================
const keys = workerKeys();
check('в проверку попадает не менее 60 ключей сообщений работника', keys.length >= 60, keys.length);
const bad: string[] = [];
for (const lang of ['ru', 'uz'] as const) {
  for (const k of keys) {
    // сырой текст без подстановки: ищем слова про деньги и «денежные» параметры
    const template = i18n.rawTemplate(lang, k);
    if (MONEY.test(template) || PLACEHOLDER.test(template)) bad.push(`${lang}:${k}`);
  }
}
check('ни один текст работника (ru и uz) не содержит денег и «денежных» параметров', bad.length === 0, bad.join(', '));
check('у работника НЕ используются сообщения с деньгами мастера (stats.item, stats.sub, currency)', !keys.includes('stats.item' as any) && !keys.includes('stats.sub' as any) && !keys.includes('currency' as any));


// Точный вид экранов работника (ru): только «модель · операция», штуки и дата — без единой цифры про деньги, даже «0».
const L = 'Футболка · Оверлок';
check('«Проверьте запись»: модель · операция, 150 шт, дата — и больше ничего', i18n.t('ru', 'add.review', { label: L, qty: 150, date: '08.10.2026' }) === '📋 Проверьте запись:\nФутболка · Оверлок\n150 шт\n📅 08.10.2026');
check('«Сохранено»: модель · операция, 150 шт и пометка про подтверждение мастером', i18n.t('ru', 'add.saved', { label: L, qty: 150 }) === '✅ Сохранено\nФутболка · Оверлок\n150 шт\n⏳ Мастер ещё должен подтвердить запись.');
check('уведомление «изменил и подтвердил»: было → стало, штуки, дата', i18n.t('ru', 'wn.adjusted', { label: L, old: 150, qty: 120, date: '08.10.2026' }) === '✏️ Мастер изменил вашу запись и подтвердил её:\nФутболка · Оверлок\n150 → 120 шт\n📅 08.10.2026');
check('уведомление «исправил»: было/стало в штуках', i18n.t('ru', 'wn.edited', { oldLabel: L, oldQty: 150, label: L, qty: 100, date: '08.10.2026' }) === '✏️ Мастер исправил вашу запись:\nБыло: Футболка · Оверлок, 150 шт\nСтало: Футболка · Оверлок, 100 шт\n📅 08.10.2026');
check('уведомления «отклонил» и «удалил»: название, штуки, дата, причина', i18n.t('ru', 'wn.rejected', { label: L, qty: 150, date: '08.10.2026', reason: 'Ошибка' }) === '🚫 Мастер отклонил вашу запись:\nФутболка · Оверлок, 150 шт\n📅 08.10.2026\nПричина: Ошибка' && i18n.t('ru', 'wn.deleted', { label: L, qty: 150, date: '08.10.2026' }) === '🗑 Мастер удалил вашу запись:\nФутболка · Оверлок, 150 шт\n📅 08.10.2026');
check('те же экраны на узбекском — без денег', !MONEY.test(i18n.t('uz', 'add.review', { label: L, qty: 150, date: '08.10.2026' })) && !MONEY.test(i18n.t('uz', 'add.saved', { label: L, qty: 150 })) && !MONEY.test(i18n.t('uz', 'wn.adjusted', { label: L, old: 150, qty: 120, date: '08.10.2026' })));

// ===================== 2. Функции работника в базе =====================
const WORKER_FNS = ['bot_worker_get', 'bot_worker_begin', 'bot_worker_set_language', 'bot_worker_submit_name', 'bot_catalog', 'bot_commit_draft', 'bot_records', 'bot_change_qty', 'bot_delete_record', 'bot_rating'];
const OTHER_FNS = ['bot_staff_link', 'bot_staff_resolve', 'bot_staff_set_language', 'bot_staff_set_shop', 'bot_staff_request', 'bot_decide_worker', 'bot_as_staff', 'bot_broadcast_result', 'bot_record_notice'];
const all = (await db.query(`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'bot\\_%' order by proname`)).rows.map((r: any) => r.proname);
check('список bot_*-функций известен тесту (новая функция потребует решения: работнику или мастеру)', JSON.stringify(all) === JSON.stringify([...WORKER_FNS, ...OTHER_FNS].sort()), JSON.stringify(all));

// Статическая защита: в определениях функций работника нет денежных ключей ответа.
const defs = (await db.query(`select proname, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname = any($1)`, [[...WORKER_FNS, 'worker_json']])).rows;
const staticBad = defs.filter((d: any) => /'(rate|rate_per_piece|whole_rate|price|amount|sum|total|line_total|cost)'/i.test(d.def)).map((d: any) => d.proname);
check('в коде функций работника нет денежных ключей ответа (rate, whole_rate, total, sum, amount, price…)', staticBad.length === 0, staticBad.join(', '));
const grants = (await db.query(`select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as a, has_function_privilege('anon', p.oid, 'execute') as n, has_function_privilege('service_role', p.oid, 'execute') as s from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname = any($1)`, [WORKER_FNS])).rows;
check('функции работника вызывает только service_role (сайт и anon — нет)', grants.every((g: any) => g.s && !g.a && !g.n), JSON.stringify(grants));

// Данные: профессия, каталог с ценами, сотрудник, работник, подтверждённая и ожидающая записи.
const pSew = (await db.query(`insert into professions (name) values ('Швея') returning id`)).rows[0].id;
const mT = (await db.query(`insert into catalog_models (profession_id, name, whole_rate) values ($1, 'Футболка', 1500) returning id`, [pSew])).rows[0].id;
const oOver = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Оверлок', 120) returning id`, [mT])).rows[0].id;
await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Без ставки', 0)`, [mT]);
const e1 = (await db.query(`insert into employees (name, shop, profession_id) values ('Анвар', 'factory', $1) returning id`, [pSew])).rows[0].id;
const e2 = (await db.query(`insert into employees (name, shop, profession_id) values ('Бобур', 'factory', $1) returning id`, [pSew])).rows[0].id;
await db.query(`insert into worker_bot_users (telegram_id, chat_id, language, full_name, shop, status, employee_id) values (2001, 2001, 'ru', 'Анвар', 'factory', 'active', $1), (2002, 2002, 'ru', 'Бобур', 'factory', 'active', $2)`, [e1, e2]);
await db.query(`update worker_bot_settings set rating_enabled = true`);
await db.query(`insert into work_records (employee_id, catalog_operation_id, quantity, date, status, source) values ($1, $2, 9, public.tashkent_today(), 'confirmed', 'site'), ($3, $2, 4, public.tashkent_today(), 'confirmed', 'site')`, [e1, oOver, e2]).catch(async () => {
  // триггер вставки требует мастера/CEO — подставим CEO
  await db.query(`insert into profiles (id, email, role) values ('00000000-0000-0000-0000-0000000000c0', 'c@c.c', 'ceo') on conflict do nothing`);
});

const svc = async (sql: string, params: unknown[] = []) => {
  await db.query('reset role');
  await db.query('set role service_role');
  try {
    return (await db.query(sql, params)).rows[0]?.r ?? null;
  } finally {
    await db.query('reset role');
  }
};

// Подтверждённая запись «с сайта» (от имени мастера), чтобы статистика и рейтинг не были пустыми.
await h.asUser(db, 'master');
await db.query(`insert into work_records (employee_id, catalog_operation_id, quantity, date) values ($1, $2, 9, public.tashkent_today()), ($3, $2, 4, public.tashkent_today())`, [e1, oOver, e2]);
await db.query('reset role');

const results: Record<string, unknown> = {};
results.get = await svc(`select public.bot_worker_get(2001) as r`);
results.catalog = await svc(`select public.bot_catalog(2001) as r`);
await db.query(`insert into worker_bot_state (telegram_id, state, data) values (2001, 'review', '{"kind":"op","id":"${oOver}","quantity":5}'::jsonb)`);
results.commit = await svc(`select public.bot_commit_draft(2001) as r`);
await db.query(`insert into worker_bot_state (telegram_id, state, data) values (2001, 'review', '{"kind":"whole","id":"${mT}","quantity":2}'::jsonb)`);
results.commitWhole = await svc(`select public.bot_commit_draft(2001) as r`);
const today = (await db.query(`select public.tashkent_today()::text as d`)).rows[0].d;
results.records = await svc(`select public.bot_records(2001, $1::date, $1::date) as r`, [today]);
const editable = (results.records as any[]).find((x) => x.editable);
results.change = await svc(`select public.bot_change_qty(2001, $1::uuid, 7) as r`, [editable.id]);
results.rating = await svc(`select public.bot_rating(2001, $1::date, $1::date) as r`, [today]);
// регистрация нового работника
const inv = (await db.query(`insert into worker_bot_invites (shop, profession_id) values ('factory', $1) returning token`, [pSew])).rows[0].token;
results.begin = await svc(`select public.bot_worker_begin(2003, 2003, $1) as r`, [inv]);
await svc(`select public.bot_worker_set_language(2003, 'uz') as r`);
results.submit = await svc(`select public.bot_worker_submit_name(2003, 'Новый Работник') as r`);
await svc(`select public.bot_delete_record(2001, $1::uuid) as r`, [editable.id]);

check('все ответы функций работника получены', Object.values(results).every((v) => v !== null), JSON.stringify(Object.entries(results).filter(([, v]) => v === null).map(([k]) => k)));
check('рейтинг в тесте реально считается (иначе проверка пустая)', (results.rating as any)?.place >= 1, JSON.stringify(results.rating));

const BANNED_KEY = /rate|price|amount|sum|total|cost|earn|salary|money|pay/i;
function keysOf(v: unknown, path = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => keysOf(x, path));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => [`${path}${k}`, ...keysOf(x, `${path}${k}.`)]);
  return [];
}
for (const [name, res] of Object.entries(results)) {
  const bad2 = keysOf(res).filter((k) => BANNED_KEY.test(k.split('.').pop() as string));
  check(`ответ «${name}»: нет ключей со ставкой/суммой`, bad2.length === 0, bad2.join(', '));
}
const cat = results.catalog as any;
check('каталог: у модели только has_whole (признак), у операций только id и название; операция со ставкой 0 не показана', cat.models[0].has_whole === true && !('whole_rate' in cat.models[0]) && cat.models[0].ops.length === 1 && JSON.stringify(Object.keys(cat.models[0].ops[0]).sort()) === '["id","name"]');
check('записи: у каждой только id, дата, название, штуки, статус, признак правки', (results.records as any[]).every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['date', 'editable', 'id', 'is_whole', 'label', 'quantity', 'status'])));
check('рейтинг: ровно place, participants, profession_name', JSON.stringify(Object.keys(results.rating as any).sort()) === '["participants","place","profession_name"]');

// ===================== 3. Деньги в базе на месте (мастер/CEO видят, расчёт не тронут) =====================
const rec = (await db.query(`select rate_per_piece::numeric as r from work_records where catalog_operation_id = $1 and source = 'site' limit 1`, [oOver])).rows[0];
check('снимок ставки в записи на месте (120) — расчёт не тронут', rec && Number(rec.r) === 120);
const whole = (await db.query(`select rate_per_piece::numeric as r from work_records where model_id = $1 limit 1`, [mT])).rows[0];
check('цена целого изделия в записи на месте (1500)', whole && Number(whole.r) === 1500);

finish();
