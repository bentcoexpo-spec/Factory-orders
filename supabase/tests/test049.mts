// Сквозной тест бота, часть 3а: мастер/CEO — подтверждение, работники, изделия.
const { createHarness } = await import('./bot_harness.mts');
const h = await createHarness();
const { db, UIDS, asUser, say, press, last, mark, since, check, sent } = h;

const MASTER = 1001, CEO = 1002, W1 = 2001, W2 = 2002;

// ----- данные
const pSew = (await db.query(`insert into professions (name) values ('Швея') returning id`)).rows[0].id;
const pIron = (await db.query(`insert into professions (name) values ('Утюжник') returning id`)).rows[0].id;
const mT = (await db.query(`insert into catalog_models (profession_id, name, whole_rate) values ($1, 'Футболка', 1500) returning id`, [pSew])).rows[0].id;
const oOver = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Оверлок', 120) returning id`, [mT])).rows[0].id;
const oLine = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Строчка', 80) returning id`, [mT])).rows[0].id;
const e1 = (await db.query(`insert into employees (name, shop, profession_id) values ('Алишер', 'factory', $1) returning id`, [pSew])).rows[0].id;
const e2 = (await db.query(`insert into employees (name, shop, profession_id) values ('Бахтиёр', 'factory', $1) returning id`, [pSew])).rows[0].id;
const e3 = (await db.query(`insert into employees (name, shop) values ('Без профессии-Ф', 'factory') returning id`)).rows[0].id;
const eW = (await db.query(`insert into employees (name, shop, profession_id) values ('Цеховой', 'workshop', $1) returning id`, [pSew])).rows[0].id;
await db.query(`insert into staff_bot_links (profile_id, telegram_id, chat_id, language) values ($1, $2, $2, 'ru'), ($3, $4, $4, 'uz')`, [UIDS.master, MASTER, UIDS.ceo, CEO]);
const mkW = async (tg: number, name: string, emp: string, shop: string) =>
  (await db.query(`insert into worker_bot_users (telegram_id, chat_id, language, full_name, shop, status, employee_id) values ($1, $1, 'ru', $2, $3, 'active', $4) returning id`, [tg, name, shop, emp])).rows[0].id;
const wu1 = await mkW(W1, 'Алишер', e1, 'factory');
const wu2 = await mkW(W2, 'Бахтиёр', e2, 'factory');
await mkW(2003, 'Цеховой', eW, 'workshop');

const today = (await db.query(`select public.tashkent_today()::text as d`)).rows[0].d;
const botRec = async (wu: string, emp: string, op: string, qty: number) => {
  let id = '';
  await db.transaction(async (tx: any) => {
    await tx.query(`select set_config('app.bot_write', 'on', true)`);
    id = (await tx.query(`insert into work_records (employee_id, catalog_operation_id, quantity, date, bot_user_id) values ($1, $2, $3, public.tashkent_today(), $4) returning id`, [emp, op, qty, wu])).rows[0].id;
  });
  return id;
};
const r1 = await botRec(wu1, e1, oOver, 10);
const r2 = await botRec(wu1, e1, oLine, 5);
const r3 = await botRec(wu2, e2, oOver, 7);
const r4 = await botRec(wu2, e2, oLine, 3);
const rW = await botRec(await (async () => (await db.query(`select id from worker_bot_users where telegram_id = 2003`)).rows[0].id)(), eW, oOver, 9);
void r4; void rW;
await asUser(db, 'master');

// ===================== меню =====================
await say(MASTER, '/start');
const menu = last(MASTER);
check('меню мастера: 4 кнопки + ✅ Подтверждение со счётчиком (4 ожидающих своего цеха)', menu.reply.join('|') === '📦 Изделия|👷 Работники|📊 Отчёты|⚙️ Настройки|✅ Подтверждение (4)', menu.reply.join('|'));
await say(MASTER, '📊 Отчёты');
check('«Отчёты» пока — «появится в следующем обновлении»', last(MASTER).text.includes('следующем обновлении'));
await say(MASTER, '⚙️ Настройки');
check('«Настройки» пока — то же', last(MASTER).text.includes('следующем обновлении'));

// ===================== ✅ Подтверждение =====================
await say(MASTER, '✅ Подтверждение (4)');
let scr = last(MASTER);
check('выбор дня: «Ждут подтверждения: 4» и кнопка дня', scr.text.includes('Ждут подтверждения: 4') && scr.buttons.includes(`cd:${today}`) && scr.labels[0].includes('— 4'), JSON.stringify(scr));
await press(MASTER, `cd:${today}`);
scr = last(MASTER);
check('день: группировка по работникам с суммами и строками «операция — штук = сумма»', scr.text.includes('👷 <b>Алишер</b> — 💰 1.600 сум') && scr.text.includes('• Футболка · Оверлок — 10 шт = 1.200 сум') && scr.text.includes('• Футболка · Строчка — 5 шт = 400 сум') && scr.text.includes('👷 <b>Бахтиёр</b> — 💰 1.080 сум') && scr.text.includes('Всего: 2.680 сум'), scr.text);
check('день: «Подтвердить всё», по работнику и «записи»', scr.buttons.includes(`ca:${today}`) && scr.buttons.includes(`cw:${e1}:${today}`) && scr.buttons.includes(`cv:${e1}:${today}`));
check('чужой цех в списке не показан', !scr.text.includes('Цеховой'));

await press(MASTER, `cv:${e1}:${today}`);
scr = last(MASTER);
check('записи работника: кнопка на каждую запись', scr.buttons.includes(`cr:${r1}:${today}`) && scr.buttons.includes(`cr:${r2}:${today}`));
await press(MASTER, `cr:${r1}:${today}`);
scr = last(MASTER);
check('карточка записи: ✅ подтвердить, ✏️ количество, 🚫 отклонить', scr.buttons.includes(`cc:${r1}:${today}`) && scr.buttons.includes(`cq:${r1}:${today}`) && scr.buttons.includes(`cx:${r1}:${today}`) && scr.labels.some((l) => l.startsWith('🚫')) && scr.labels.some((l) => l.startsWith('✏️')));

// изменить количество
await press(MASTER, `cq:${r1}:${today}`);
check('вопрос о новом количестве', last(MASTER).text.includes('Новое количество') && last(MASTER).text.includes('сейчас 10 шт'));
await say(MASTER, 'abc');
check('неверное количество — подсказка, состояние сохраняется', last(MASTER).text.includes('Нужно целое число'));
let m = mark();
await say(MASTER, '8');
check('мастеру: «Изменено и подтверждено: 10 → 8»', since(m, MASTER).some((s) => s.text.includes('10 → 8')));
const wMsg = since(m, W1).at(-1)!;
check('работнику пришло сообщение: мастер изменил количество, 8 × 120 = 960', wMsg && wMsg.text.includes('изменил вашу запись') && wMsg.text.includes('10 → 8 шт') && wMsg.text.includes('960 сум'), wMsg?.text);
check('в базе: confirmed, 8, исходное 10', await (async () => { const r = (await db.query(`select status, quantity, quantity_original from work_records where id = $1`, [r1])).rows[0]; return r.status === 'confirmed' && r.quantity === 8 && r.quantity_original === 10; })());
check('после действия показан обновлённый список дня', since(m, MASTER).some((s) => s.text.includes('Подтверждение') && s.text.includes('Алишер')));
check('клавиатура мастера освежена: счётчик стал 3', since(m, MASTER).some((s) => s.reply.includes('✅ Подтверждение (3)')), JSON.stringify(since(m, MASTER).map((s) => s.reply)));

// отклонить
await press(MASTER, `cx:${r2}:${today}`);
check('просьба написать причину', last(MASTER).text.includes('причину отклонения'));
await say(MASTER, 'x'.repeat(201));
check('причина длиннее 200 символов отклонена', last(MASTER).text.includes('от 1 до 200'));
m = mark();
await say(MASTER, 'Не из этой смены');
const rejMsg = since(m, W1).at(-1)!;
check('работнику: отклонено + причина', rejMsg && rejMsg.text.includes('отклонил вашу запись') && rejMsg.text.includes('Не из этой смены') && rejMsg.text.includes('Футболка · Строчка'), rejMsg?.text);
check('в базе: rejected с причиной, в оплату не идёт', await (async () => { const r = (await db.query(`select status, reject_reason from work_records where id = $1`, [r2])).rows[0]; const v = (await db.query(`select 1 from work_records_view where id = $1`, [r2])).rows.length; return r.status === 'rejected' && r.reject_reason === 'Не из этой смены' && v === 0; })());

// подтвердить всё по работнику
m = mark();
await press(MASTER, `cw:${e2}:${today}`);
check('«подтвердить всё» по работнику: «Подтверждено записей: 2 на 1.080 сум»', since(m, MASTER).some((s) => s.text.includes('Подтверждено записей: 2 на 1.080 сум')), JSON.stringify(since(m, MASTER).map((s) => s.text)));
check('рядовое подтверждение работнику не шлёт сообщений', since(m, W2).length === 0);
await say(MASTER, '✅ Подтверждение');
check('ожидающих больше нет: «Нет записей, ожидающих подтверждения»', last(MASTER).text.includes('Нет записей, ожидающих подтверждения'));
check('запись другого цеха осталась pending', (await db.query(`select status from work_records where employee_id = $1`, [eW])).rows[0].status === 'pending');

// журнал: adjust + reject (подтверждение само не пишется)
check('журнал: «изменил количество при подтверждении» и «отклонил» записаны, via = bot', await (async () => { const a = (await db.query(`select action, via, actor_name from work_record_audit order by created_at`)).rows; return a.length === 2 && a[0].action === 'adjust' && a[1].action === 'reject' && a.every((x: any) => x.via === 'bot' && x.actor_name === 'master@test.test'); })());

// ===================== 👷 Работники =====================
await say(MASTER, '👷 Работники');
scr = last(MASTER);
check('работники: «Все (3)», профессии с числом людей, «Профессия не указана (1)», «Добавить работника»', scr.labels.includes('👷 Все (3)') && scr.labels.includes('👷 Швея (2)') && scr.labels.includes('👷 Утюжник (0)') && scr.labels.includes('⚠️ Профессия не указана (1)') && scr.labels.includes('➕ Добавить работника'), JSON.stringify(scr.labels));
await press(MASTER, 'ul:none');
scr = last(MASTER);
check('«Профессия не указана»: один сотрудник', scr.buttons.length === 2 && scr.buttons[0] === `uc:${e3}` && scr.labels[0].startsWith('Без профессии-Ф'), JSON.stringify(scr));
await press(MASTER, `uc:${e3}`);
check('карточка без профессии: предупреждение, что вносить работу в боте нельзя', last(MASTER).text.includes('Профессия: не указана') && last(MASTER).text.includes('не сможет вносить работу'));
await press(MASTER, 'ul:all');
scr = last(MASTER);
check('«Все»: сотрудники цеха с итогом за месяц и меткой 🔗 у работающих через бот', scr.labels.length >= 3 && scr.labels.some((l) => l.startsWith('Алишер') && l.includes('💰 960 сум') && l.endsWith('🔗')) && !scr.labels.some((l) => l.includes('Цеховой')), JSON.stringify(scr.labels));
await press(MASTER, `uc:${e1}`);
scr = last(MASTER);
check('карточка: имя, профессия, итог за месяц (подтверждённое), ждёт, штук, в боте', scr.text.includes('Алишер') && scr.text.includes('Профессия: Швея') && scr.text.includes('За месяц: 960 сум') && scr.text.includes('Работает через бот') && scr.buttons.includes(`un:${e1}`) && scr.buttons.includes(`us:${e1}`) && scr.buttons.includes(`up:${e1}`) && scr.buttons.includes(`ux:${e1}`), scr.text);

// имя
await press(MASTER, `un:${e1}`);
await say(MASTER, 'А');
check('слишком короткое имя отклонено', last(MASTER).text.includes('от 2 до 60'));
await say(MASTER, 'Бахтиёр');
check('занятое имя — понятный отказ', last(MASTER).text.includes('уже есть'));
await say(MASTER, 'Алишер К.');
check('имя изменено в Табеле и в боте', (await db.query(`select name from employees where id = $1`, [e1])).rows[0].name === 'Алишер К.' && (await db.query(`select full_name from worker_bot_users where id = $1`, [wu1])).rows[0].full_name === 'Алишер К.');

// профессия
await press(MASTER, `up:${e1}`);
scr = last(MASTER);
check('выбор профессии: текущая отмечена ✅, есть «не указана»', scr.labels.some((l) => l === '✅ Швея') && scr.labels.includes('⚠️ Профессия не указана'), JSON.stringify(scr.labels));
await press(MASTER, `upi:${scr.labels.indexOf('Утюжник')}`);
check('профессия изменена', (await db.query(`select profession_id from employees where id = $1`, [e1])).rows[0].profession_id === pIron && last(MASTER).text.includes('Утюжник'));
await press(MASTER, `up:${e1}`);
scr = last(MASTER);
await press(MASTER, `upi:${scr.labels.findIndex((l) => l.includes('Швея'))}`);
check('профессию вернули на «Швея»', (await db.query(`select profession_id from employees where id = $1`, [e1])).rows[0].profession_id === pSew);

// исправить запись работника
await press(MASTER, `us:${e1}`);
scr = last(MASTER);
check('записи работника за месяц: ✅ подтверждённая и 🚫 отклонённая', scr.labels.some((l) => l.startsWith('✅') && l.includes('Футболка · Оверлок — 8')) && scr.labels.some((l) => l.startsWith('🚫')), JSON.stringify(scr.labels));
await press(MASTER, `ur:${r1}`);
scr = last(MASTER);
check('карточка подтверждённой записи: статус, «Количество» и «Удалить»', scr.text.includes('✅ Подтверждена') && scr.buttons.includes(`uq:${r1}`) && scr.buttons.includes(`ud:${r1}`), scr.text);
await press(MASTER, `uq:${r1}`);
m = mark();
await say(MASTER, '12');
check('исправлено: 12 шт = 1.440 сум', since(m, MASTER).some((s) => s.text.includes('Исправлено') && s.text.includes('12 шт = 1.440 сум')));
check('работнику: «Мастер исправил вашу запись» (было 8, стало 12)', since(m, W1).some((s) => s.text.includes('исправил вашу запись') && s.text.includes('8 шт') && s.text.includes('12 шт')), JSON.stringify(since(m, W1).map((s) => s.text)));
check('правка подтверждённой записи записана в журнал: было 8 → стало 12, через бота', await (async () => { const a = (await db.query(`select before, after, via from work_record_audit where action = 'edit'`)).rows; return a.length === 1 && a[0].before.quantity === 8 && a[0].after.quantity === 12 && a[0].via === 'bot'; })());
await press(MASTER, `ur:${r1}`);
await press(MASTER, `ud:${r1}`);
check('удаление спрашивает подтверждение', last(MASTER).buttons.includes(`udy:${r1}`) && last(MASTER).text.includes('Удалить запись'));
m = mark();
await press(MASTER, `udy:${r1}`);
check('запись удалена; работнику: «Мастер удалил вашу запись»; в журнале — удаление', (await db.query(`select 1 from work_records where id = $1`, [r1])).rows.length === 0 && since(m, W1).some((s) => s.text.includes('удалил вашу запись')) && (await db.query(`select count(*)::int as n from work_record_audit where action = 'delete'`)).rows[0].n === 1);

// ссылка-приглашение
await press(MASTER, 'ua');
scr = last(MASTER);
check('«Добавить работника»: выбор профессии', scr.buttons.includes(`ui:${pSew}`) && scr.buttons.includes(`ui:${pIron}`));
await press(MASTER, `ui:${pSew}`);
scr = last(MASTER);
const token = /start=([0-9a-f]{32})/.exec(scr.text)?.[1];
check('ссылка https://t.me/<бот>?start=<токен> показана, есть «Новый код»', !!token && scr.text.includes('https://t.me/workers_bot?start=') && scr.buttons.includes(`uin:${pSew}`), scr.text);
await press(MASTER, `ui:${pSew}`);
check('повторный запрос показывает ту же ссылку', last(MASTER).text.includes(String(token)));
await press(MASTER, `uin:${pSew}`);
check('«Новый код»: другой токен, старая ссылка выключена', !last(MASTER).text.includes(String(token)) && last(MASTER).text.includes('Новый код создан') && (await db.query(`select active from worker_bot_invites where token = $1`, [token])).rows[0].active === false);

// снять с бота
await press(MASTER, `ux:${e2}`);
check('снять с бота — с подтверждением', last(MASTER).text.includes('Снять «Бахтиёр» с бота') && last(MASTER).buttons.includes(`uxy:${e2}`));
m = mark();
await press(MASTER, `uxy:${e2}`);
check('работник снят с бота и получил сообщение; запись о нём в Табеле осталась', (await db.query(`select status from worker_bot_users where id = $1`, [wu2])).rows[0].status === 'removed' && since(m, W2).some((s) => s.text.includes('отключены от бота')) && (await db.query(`select 1 from employees where id = $1`, [e2])).rows.length === 1);

// ===================== 📦 Изделия =====================
await say(MASTER, '📦 Изделия');
scr = last(MASTER);
check('изделия: по профессиям — модели/операции/целые; пустая профессия с ⚠️', scr.labels.some((l) => l === '📦 Швея: моделей 1, опер. 2, целых 1') && scr.labels.some((l) => l === '⚠️ Утюжник: каталог пуст'), JSON.stringify(scr.labels));
await press(MASTER, `kp:${pIron}`);
check('профессия без моделей: предупреждение', last(MASTER).text.includes('нет моделей') && last(MASTER).buttons.includes(`ka:${pIron}`) && last(MASTER).buttons.includes(`kb:${pIron}`));
await press(MASTER, `kp:${pSew}`);
await press(MASTER, `km:${mT}`);
scr = last(MASTER);
check('модель: пронумерованная таблица операций с ценой, цена целого, кнопки-номера', scr.text.includes('1. Оверлок — 120 сум') && scr.text.includes('2. Строчка — 80 сум') && scr.text.includes('Целое изделие: 1.500 сум') && scr.labels.slice(0, 2).join() === '1,2' && scr.buttons[0] === `ko:${oOver}`, scr.text);
await press(MASTER, `ko:${oOver}`);
check('операция: изменить название, цену, удалить', last(MASTER).text.includes('Оверлок') && last(MASTER).buttons.includes(`kor:${oOver}`) && last(MASTER).buttons.includes(`kop:${oOver}`) && last(MASTER).buttons.includes(`kod:${oOver}`));
await press(MASTER, `kop:${oOver}`);
await say(MASTER, 'много');
check('нечисловая цена отклонена', last(MASTER).text.includes('Нужна цена'));
await say(MASTER, '0');
check('цена 0 отклонена', last(MASTER).text.includes('Нужна цена'));
await say(MASTER, '1 500');
check('цена изменена (формат «1 500»)', Number((await db.query(`select rate_per_piece from catalog_operations where id = $1`, [oOver])).rows[0].rate_per_piece) === 1500);
check('после изменения показана модель с новой ценой', last(MASTER).text.includes('1. Оверлок — 1.500 сум'));
await press(MASTER, `ko:${oOver}`);
await press(MASTER, `kop:${oOver}`);
await say(MASTER, '120');
await press(MASTER, `ko:${oOver}`);
await press(MASTER, `kor:${oOver}`);
await say(MASTER, 'Оверлок-2');
check('операция переименована', (await db.query(`select name from catalog_operations where id = $1`, [oOver])).rows[0].name === 'Оверлок-2');
// добавить операцию
await press(MASTER, `kao:${mT}`);
await say(MASTER, 'Подгиб 90');
check('операция добавлена одной строкой «название цена»', Number((await db.query(`select rate_per_piece from catalog_operations where model_id = $1 and name = 'Подгиб'`, [mT])).rows[0].rate_per_piece) === 90);
await press(MASTER, `kao:${mT}`);
await say(MASTER, 'Манжета');
check('только название — спрашивает цену', last(MASTER).text.includes('Цена за штуку для «Манжета»'));
await say(MASTER, '60');
check('операция с отдельно введённой ценой добавлена', (await db.query(`select 1 from catalog_operations where model_id = $1 and name = 'Манжета'`, [mT])).rows.length === 1);
// целое изделие
await press(MASTER, `kw:${mT}`);
await say(MASTER, '1 800');
check('цена целого изменена', Number((await db.query(`select whole_rate from catalog_models where id = $1`, [mT])).rows[0].whole_rate) === 1800);
await press(MASTER, `kw:${mT}`);
await say(MASTER, '0');
check('0 убирает цену целого', (await db.query(`select whole_rate from catalog_models where id = $1`, [mT])).rows[0].whole_rate === null);
// удалить операцию: Манжета — записей нет → удалена; Строчка — есть → архив
const manzheta = (await db.query(`select id from catalog_operations where name = 'Манжета'`)).rows[0].id;
await press(MASTER, `ko:${manzheta}`);
await press(MASTER, `kod:${manzheta}`);
await press(MASTER, `kody:${manzheta}`);
check('удаление операции без записей — «Удалено»', last(MASTER).text.includes('Удалено') && (await db.query(`select 1 from catalog_operations where id = $1`, [manzheta])).rows.length === 0);
await press(MASTER, `km:${mT}`);
await press(MASTER, `ko:${oLine}`);
await press(MASTER, `kod:${oLine}`);
await press(MASTER, `kody:${oLine}`);
check('удаление операции с записями — «Скрыто» (архив), записи целы', last(MASTER).text.includes('Скрыто') && (await db.query(`select archived_at is not null as a from catalog_operations where id = $1`, [oLine])).rows[0].a === true && (await db.query(`select 1 from work_records where catalog_operation_id = $1`, [oLine])).rows.length > 0);
// модель
await press(MASTER, `kp:${pIron}`);
await press(MASTER, `ka:${pIron}`);
await say(MASTER, 'Майка');
check('модель добавлена, открыт её экран', (await db.query(`select 1 from catalog_models where name = 'Майка' and profession_id = $1`, [pIron])).rows.length === 1 && last(MASTER).text.includes('Майка') && last(MASTER).text.includes('Операций пока нет'));
await press(MASTER, `kp:${pIron}`);
await press(MASTER, `ka:${pIron}`);
await say(MASTER, 'майка');
check('дубль модели — понятный отказ', last(MASTER).text.includes('уже есть'));

// список одним сообщением
await press(MASTER, `kp:${pIron}`);
await press(MASTER, `kb:${pIron}`);
check('подсказка формата списка', last(MASTER).text.includes('Строка без числа — модель'));
await say(MASTER, 'Майка\nОверлок 90\nПодгиб 150\nШорты\nКарман 200\nПояс 5\nМанжета\n120');
scr = last(MASTER);
check('предпросмотр: 2 новых модели? нет — «Шорты» и «Манжета» новые (2), новых операций 4, пропущено 0; предупреждение о цене <100 и непонятной строке', scr.text.includes('Новых моделей: 2') && scr.text.includes('Новых операций: 4') && scr.text.includes('Пропущено как уже существующих: 0') && scr.text.includes('Очень малые цены') && scr.text.includes('Пояс — 5') && scr.text.includes('Не понял строки') && scr.text.includes('120'), scr.text);
check('в базе пока ничего не сохранено', (await db.query(`select count(*)::int as n from catalog_models where name in ('Шорты', 'Манжета')`)).rows[0].n === 0 && scr.buttons.includes('kbs'));
await press(MASTER, 'kbs');
check('«Сохранить»: всё созданное', last(MASTER).text.includes('Сохранено: новых моделей 2, новых операций 4') && (await db.query(`select count(*)::int as n from catalog_operations o join catalog_models m on m.id = o.model_id where m.name in ('Майка','Шорты')`)).rows[0].n === 4);
await press(MASTER, `kb:${pIron}`);
await say(MASTER, 'Майка\nОверлок 90\nПодгиб 150');
check('повторная загрузка того же: «Нечего сохранять», пропущено 2, кнопки «Сохранить» нет', last(MASTER).text.includes('Пропущено как уже существующих: 2') && last(MASTER).text.includes('Нечего сохранять') && !last(MASTER).buttons.includes('kbs'), last(MASTER).text);
// список в модель
const maika = (await db.query(`select id from catalog_models where name = 'Майка'`)).rows[0].id;
await press(MASTER, `km:${maika}`);
await press(MASTER, `kbm:${maika}`);
await say(MASTER, 'Резинка 70\nПетля 55');
check('список операций в выбранную модель: 2 новых операции (+⚠️ малая цена у Петли)', last(MASTER).text.includes('Новых моделей: 0') && last(MASTER).text.includes('Новых операций: 2') && last(MASTER).text.includes('Петля'), last(MASTER).text);
await press(MASTER, 'kbs');
check('сохранено в модель «Майка»', (await db.query(`select count(*)::int as n from catalog_operations where model_id = $1 and name in ('Резинка','Петля')`, [maika])).rows[0].n === 2);
// удалить модель
await press(MASTER, `km:${maika}`);
await press(MASTER, `kd:${maika}`);
check('удаление модели спрашивает подтверждение', last(MASTER).text.includes('Удалить модель «Майка» вместе с её операциями'));
await press(MASTER, `kdy:${maika}`);
check('модель без записей удалена', (await db.query(`select 1 from catalog_models where id = $1`, [maika])).rows.length === 0 && last(MASTER).text.includes('Удалено'));

// ===================== CEO =====================
await say(CEO, '/menu');
const ceoMsgs = since(0, CEO);
check('CEO: меню на узбекском и переключатель цеха', ceoMsgs.some((s) => s.reply.includes('📦 Buyumlar') && s.reply.includes('👷 Ishchilar')) && ceoMsgs.some((s) => s.buttons.includes('sh:factory') && s.buttons.includes('sh:workshop')), JSON.stringify(ceoMsgs.map((s) => s.reply.concat(s.buttons))));
await press(CEO, 'sh:workshop');
check('CEO выбрал цех «Цех»: меню показывает 1 ожидающую запись', last(CEO).reply.includes('✅ Tasdiqlash (1)'), JSON.stringify(last(CEO)));
await say(CEO, '✅ Tasdiqlash (1)');
check('CEO видит ожидающие цеха «Цех» (на узбекском)', last(CEO).text.includes('Tasdiqlashni kutmoqda: 1'), last(CEO).text);
await press(CEO, `cd:${today}`);
check('день цеха «Цех»: работник Цеховой', last(CEO).text.includes('Цеховой') && !last(CEO).text.includes('Алишер'));
await press(CEO, `ca:${today}`);
check('CEO подтвердил запись цеха', (await db.query(`select status from work_records where employee_id = $1`, [eW])).rows[0].status === 'confirmed' && sent.some((s) => s.chat === CEO && s.text.includes('Tasdiqlangan yozuvlar: 1')));

// ===================== значки у работника =====================
await say(W1, '/menu');
check('меню работника с значками', last(W1).reply.join('|') === '➕ Добавить работу|📊 Моя статистика', last(W1).reply.join('|'));
await say(W1, '➕ Добавить работу');
check('у работника значки: заголовок «📦 Выберите модель», кнопка «❌ Отмена» (целых изделий в каталоге уже нет — выбор вида пропущен)', last(W1).text.startsWith('📦 Выберите модель') && last(W1).labels.includes('❌ Отмена'), JSON.stringify(last(W1)));
await say(W1, '📊 Моя статистика');
check('периоды со значком 📅', last(W1).labels.every((l) => l.startsWith('📅')), JSON.stringify(last(W1).labels));

h.finish();
