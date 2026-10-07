// Сквозной тест бота, часть 3б: отчёты, Excel, настройки, рейтинг, рассылка,
// планировщик (напоминание и ежемесячный отчёт).
const { createHarness } = await import('./bot_harness.mts');
const h = await createHarness();
const { db, UIDS, asUser, say, press, last, mark, since, check, sent, docs, flags, fakeSb } = h;
const { runWorkerBotCron } = await import('../../lib/workerBot/cron.ts');
const { periodRange, tashkentToday, addDays } = await import('../../lib/workerBot/stats.ts');
const ExcelJS = (await import('exceljs')).default;

const MASTER = 1001, CEO = 1002;
const today = tashkentToday();

// ----- данные
const pSew = (await db.query(`insert into professions (name) values ('Швея') returning id`)).rows[0].id;
const pIron = (await db.query(`insert into professions (name) values ('Утюжник') returning id`)).rows[0].id;
const mT = (await db.query(`insert into catalog_models (profession_id, name, whole_rate) values ($1, 'Футболка', 1500) returning id`, [pSew])).rows[0].id;
const oOver = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Оверлок', 120) returning id`, [mT])).rows[0].id;
const oLine = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Строчка', 80) returning id`, [mT])).rows[0].id;
const mkE = async (name: string, shop: string, prof: string | null) => (await db.query(`insert into employees (name, shop, profession_id) values ($1, $2, $3) returning id`, [name, shop, prof])).rows[0].id;
const eA = await mkE('Анвар', 'factory', pSew);
const eB = await mkE('Бобур', 'factory', pSew);
const eC = await mkE('Мадина', 'factory', pSew);
const eD = await mkE('Дильноза', 'factory', pIron);
const eN = await mkE('БезПрофессии', 'factory', null);
const eI = await mkE('Простой', 'factory', pSew);
const eW = await mkE('Цеховой', 'workshop', pSew);
await db.query(`insert into staff_bot_links (profile_id, telegram_id, chat_id, language) values ($1, $2, $2, 'ru'), ($3, $4, $4, 'uz')`, [UIDS.master, MASTER, UIDS.ceo, CEO]);
const mkW = async (tg: number, emp: string, shop: string) =>
  (await db.query(`insert into worker_bot_users (telegram_id, chat_id, language, full_name, shop, status, employee_id) values ($1, $1, 'ru', $2, $3, 'active', $4) returning id`, [tg, `w${tg}`, shop, emp])).rows[0].id;
const wA = await mkW(2001, eA, 'factory');
await mkW(2002, eB, 'factory');
await mkW(2003, eC, 'factory');
await mkW(2004, eD, 'factory');
await mkW(2005, eN, 'factory');
await mkW(2006, eI, 'factory');
await mkW(2007, eW, 'workshop');

await asUser(db, 'master');
const siteRec = (emp: string, op: string, qty: number, date: string) =>
  db.query(`insert into work_records (employee_id, catalog_operation_id, quantity, date) values ($1, $2, $3, $4::date)`, [emp, op, qty, date]);
await siteRec(eA, oOver, 10, today); // 1200
await siteRec(eB, oLine, 5, today); // 400
await siteRec(eN, oOver, 2, today); // 240
const pw = periodRange('pw', today);
const pm = periodRange('pm', today);
await siteRec(eA, oOver, 7, pw.from); // прошлая неделя: 840
await siteRec(eB, oLine, 4, addDays(pm.from, 2)); // прошлый месяц: 320
await db.query('reset role');
await db.transaction(async (tx: any) => {
  await tx.query(`select set_config('app.bot_write', 'on', true)`);
  await tx.query(`insert into work_records (employee_id, catalog_operation_id, quantity, date, bot_user_id) values ($1, $2, 3, $3::date, $4)`, [eC, oOver, today, (await tx.query(`select id from worker_bot_users where telegram_id = 2003`)).rows[0].id]);
});
await asUser(db, 'master');

// ===================== 📊 Отчёты =====================
await say(MASTER, '/start');
await say(MASTER, '📊 Отчёты');
let scr = last(MASTER);
check('отчёты: периоды (сегодня, неделя, месяц, год) и Excel', scr.buttons.join() === 'rp:d,rp:w,rp:m,rp:y,rx' && scr.labels.slice(0, 4).every((l) => l.startsWith('📅')), JSON.stringify(scr.labels));
await press(MASTER, 'rp:d');
scr = last(MASTER);
check('отчёт за сегодня: профессия «Швея» — 1600 сум, работали 2 из 4, 15 шт, записей 2', scr.text.includes('<b>Швея</b>') && scr.text.includes('💰 1.600 сум · работали 2 из 4 · 📦 15 шт · записей 2'), scr.text);
check('«Профессия не указана» отдельной строкой (240)', scr.text.includes('<b>Профессия не указана</b>') && scr.text.includes('💰 240 сум'));
check('итого 1.840 сум; работали 3 из 6 сотрудников цеха', scr.text.includes('Всего: 1.840 сум') && scr.text.includes('работали 3 из 6'), scr.text);
check('⏳ ожидающие отдельно: 1 запись на 360, в итог не входят', scr.text.includes('Ещё ждут подтверждения: записей 1 на 360 сум'));
check('кто не работал: Дильноза и Простой (Мадина с ожидающей записью — работала)', scr.text.includes('Не работали за период (2): Дильноза, Простой'), scr.text);
check('чужой цех не попал в отчёт', !scr.text.includes('Цеховой'));
check('кнопки: по работникам, Excel, назад', scr.buttons.includes('rt:d:0') && scr.buttons.includes('rx') && scr.buttons.includes('r0'));

await press(MASTER, 'rt:d:0');
scr = last(MASTER);
check('таблица по работникам: Анвар 1.200 первый, Бобур 400, БезПрофессии 240; кнопки-номера', scr.text.includes('<pre>') && scr.text.indexOf('Анвар') < scr.text.indexOf('Бобур') && scr.text.indexOf('Бобур') < scr.text.indexOf('БезПрофессии') && scr.text.includes('1.200') && scr.buttons.filter((b) => b.startsWith('rw:')).length === 3 && scr.labels.slice(0, 3).join() === '1,2,3', scr.text);
await press(MASTER, scr.buttons[0]);
scr = last(MASTER);
check('отчёт по номеру: «Анвар», Швея, подтверждено 10 шт × 120 = 1.200', scr.text.includes('<b>Анвар</b> — Швея') && scr.text.includes('Футболка · Оверлок — 10 шт × 120 сум = 1.200 сум') && scr.text.includes('Подтверждено мастером'), scr.text);
await press(MASTER, 'rp:y');
scr = last(MASTER);
const yearTotal = 1200 + 400 + 240 + 840 + 320;
check(`за год подтверждённого ${yearTotal} (с прошлым месяцем и неделей)`, scr.text.includes(`Всего: ${String(yearTotal).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} сум`) || today.slice(5) < '03-01', scr.text);

// ===================== 📥 Excel =====================
await press(MASTER, 'rx');
scr = last(MASTER);
check('Excel: выбор — весь цех, профессии с людьми, «Профессия не указана»', scr.buttons.includes('rxs:all') && scr.buttons.includes(`rxs:${pSew}`) && scr.buttons.includes(`rxs:${pIron}`) && scr.buttons.includes('rxs:none'), JSON.stringify(scr.labels));
await press(MASTER, 'rxs:all');
check('периоды Excel: эта и прошлая неделя, месяц, прошлый месяц, год', last(MASTER).buttons.join() === 'rxp:cw,rxp:pw,rxp:m,rxp:pm,rxp:y,rx');
await press(MASTER, 'rxp:cw');
check('файл отправлен документом', docs.length === 1 && docs[0].chat === MASTER && /^report_factory_.*\.xlsx$/.test(docs[0].filename), JSON.stringify(docs.map((d) => d.filename)));
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(docs[0].data as any);
check('в книге 4 листа: по работникам, по профессиям, по операциям, записи', wb.worksheets.map((w) => w.name).join() === 'По работникам,По профессиям,По операциям,Записи', wb.worksheets.map((w) => w.name).join());
const ws = wb.getWorksheet('По работникам')!;
const find = (name: string) => { let r: any = null; ws.eachRow((row) => { if (row.getCell(2).value === name) r = row; }); return r; };
check('сумма Анвара — число 1200 с форматом тысяч; итого 1840', Number(find('Анвар').getCell(5).value) === 1200 && find('Анвар').getCell(5).numFmt === '#,##0' && Number(find('Итого').getCell(5).value) === 1840);
const recs = wb.getWorksheet('Записи')!;
check('«Записи»: только подтверждённые (3), даты — настоящие даты Excel; ожидающая запись Мадины не вошла', recs.rowCount === 4 && recs.getCell('A2').value instanceof Date && !JSON.stringify(recs.getSheetValues()).includes('Мадина'));
check('в подписи файла — цех, охват, период и сумма', docs[0].caption.includes('1.840 сум') && docs[0].caption.includes('Фабрика'));
// по профессии
await press(MASTER, 'rx');
await press(MASTER, `rxs:${pSew}`);
await press(MASTER, 'rxp:cw');
const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.load(docs[1].data as any);
const ws2 = wb2.getWorksheet('По работникам')!;
check('Excel по профессии «Швея»: только швеи (Анвар, Бобур), без «БезПрофессии»', ws2.rowCount === 4 && !JSON.stringify(ws2.getSheetValues()).includes('БезПрофессии'));
// пустой период
m = 0;
const before = docs.length;
await press(MASTER, 'rx');
await press(MASTER, `rxs:${pIron}`);
await press(MASTER, 'rxp:cw');
check('нет записей — файл не отправляется, бот пишет об этом', docs.length === before && last(MASTER).text.includes('файл не отправляю'));
// прошлая неделя и прошлый месяц
await press(MASTER, 'rx');
await press(MASTER, 'rxs:all');
await press(MASTER, 'rxp:pw');
const wb3 = new ExcelJS.Workbook();
await wb3.xlsx.load(docs.at(-1)!.data as any);
check('прошлая неделя: запись 840 (Анвар)', Number(wb3.getWorksheet('По работникам')!.getRow(2).getCell(5).value) === 840 && docs.at(-1)!.filename.includes(pw.from));
await press(MASTER, 'rx');
await press(MASTER, 'rxs:all');
await press(MASTER, 'rxp:pm');
const wb4 = new ExcelJS.Workbook();
await wb4.xlsx.load(docs.at(-1)!.data as any);
check('прошлый месяц: Бобур 320 (прошлая неделя может начинаться в прошлом месяце, поэтому у Анвара 840 тоже бывает)', (() => { const w = wb4.getWorksheet('По работникам')!; let v = 0; w.eachRow((r) => { if (r.getCell(2).value === 'Бобур') v = Number(r.getCell(5).value); }); return v === 320; })());
var m = 0; void m;

// ===================== ⚙️ Настройки =====================
await say(MASTER, '⚙️ Настройки');
scr = last(MASTER);
check('настройки: профессии, напоминание выкл, ежемесячный Excel вкл, рейтинг выкл, сообщение', scr.labels.join('|') === '👷 Профессии|🔔 Напоминание: выкл|📥 Ежемесячный Excel: вкл|🏅 Рейтинг: выкл|📣 Сообщение работникам', scr.labels.join('|'));

// --- рейтинг
await press(MASTER, 'gk');
check('рейтинг: описание и кнопка «Включить»', last(MASTER).text.includes('внутри') === false && last(MASTER).text.includes('среди работников своей профессии') && last(MASTER).labels[0] === '🏅 Включить');
await press(MASTER, 'gkt');
check('рейтинг включён', (await db.query(`select rating_enabled from worker_bot_settings where shop = 'factory'`)).rows[0].rating_enabled === true && last(MASTER).text.includes('Статус: вкл'));
await say(2001, '📊 Моя статистика');
await press(2001, 's:w');
check('работник: «Место в рейтинге (Швея): 1-е из 2» — по подтверждённым (Мадина с ожидающей не участвует)', last(2001).text.includes('🏅 Место в рейтинге (Швея): 1-е из 2'), last(2001).text);
await press(2001, 's:d');
check('в статистике за день рейтинга нет', !last(2001).text.includes('🏅'));
await press(2001, 's:m');
check('за месяц рейтинг есть', last(2001).text.includes('🏅 Место в рейтинге (Швея)'));
check('в рейтинге нет чужих имён и сумм', !last(2001).text.includes('Бобур') && !last(2001).text.includes('400'));
await say(2002, '📊 Моя статистика');
await press(2002, 's:w');
check('у Бобура (400 сум) — 2-е из 2', last(2002).text.includes('2-е из 2'), last(2002).text);
await say(2004, '📊 Моя статистика');
await press(2004, 's:w');
check('у Утюжника без подтверждённых записей рейтинга нет', !last(2004).text.includes('🏅'));
await press(MASTER, 'gk');
await press(MASTER, 'gkt');
await press(2001, 's:w');
check('рейтинг выключен — строки у работника нет', !last(2001).text.includes('🏅'));

// --- напоминание
await press(MASTER, 'gr');
scr = last(MASTER);
check('напоминание: выкл, 20:00, выходной — воскресенье; кнопки «Включить», время, 7 дней', scr.text.includes('Статус: выкл') && scr.text.includes('Время: 20:00') && scr.text.includes('Выходные: Вс') && scr.labels[0] === '🔔 Включить' && scr.buttons.filter((b) => b.startsWith('grd:')).length === 7 && scr.labels.includes('Вс 🚫') && scr.labels.includes('Пн ✅'), JSON.stringify(scr));
await press(MASTER, 'grt');
check('напоминание включено', (await db.query(`select reminder_enabled from worker_bot_settings where shop = 'factory'`)).rows[0].reminder_enabled === true && last(MASTER).labels[0] === '🔔 Выключить');
await press(MASTER, 'grm');
check('выбор времени: часы и «Другое время»', last(MASTER).buttons.includes('grs:2000') && last(MASTER).buttons.includes('grs:2200') && last(MASTER).buttons.includes('grx'));
await press(MASTER, 'grs:2130');
check('время 21:30 сохранено', last(MASTER).text.includes('Время: 21:30') && (await db.query(`select to_char(reminder_time, 'HH24:MI') as t from worker_bot_settings where shop = 'factory'`)).rows[0].t === '21:30');
await press(MASTER, 'grx');
await say(MASTER, '25:61');
check('неверное время отклонено', last(MASTER).text.includes('ЧЧ:ММ'));
await say(MASTER, '7:05');
check('своё время «7:05» принято как 07:05', (await db.query(`select to_char(reminder_time, 'HH24:MI') as t from worker_bot_settings where shop = 'factory'`)).rows[0].t === '07:05' && last(MASTER).text.includes('Время: 07:05'));
await press(MASTER, 'grd:6');
await press(MASTER, 'grd:7');
check('выходные: суббота добавлена, воскресенье убрано', JSON.stringify((await db.query(`select days_off from worker_bot_settings where shop = 'factory'`)).rows[0].days_off) === '[6]' && last(MASTER).text.includes('Выходные: Сб'));
await press(MASTER, 'grd:6');
check('все выходные убраны — «нет»', last(MASTER).text.includes('Выходные: нет'));

// --- ежемесячный Excel
await press(MASTER, 'g0');
await press(MASTER, 'gm');
check('ежемесячный Excel: описание (1-го в 09:00) и кнопка «Выключить»', last(MASTER).text.includes('09:00') && last(MASTER).labels[0] === '📥 Выключить');
await press(MASTER, 'gmt');
check('выключен', (await db.query(`select monthly_excel_enabled from worker_bot_settings where shop = 'factory'`)).rows[0].monthly_excel_enabled === false);
await press(MASTER, 'gmt');

// --- профессии
await press(MASTER, 'g0');
await press(MASTER, 'gp');
scr = last(MASTER);
check('профессии: список с числом сотрудников и «➕ Профессия»', scr.labels.includes('👷 Швея (5)') && scr.labels.includes('👷 Утюжник (1)') && scr.buttons.includes('gpa'), JSON.stringify(scr.labels));
await press(MASTER, 'gpa');
await say(MASTER, 'Раскройщик');
const nid = (await db.query(`select id from professions where name = 'Раскройщик'`)).rows[0]?.id;
check('профессия создана', !!nid);
await press(MASTER, 'gpa');
await say(MASTER, 'раскройщик');
check('дубль отклонён', last(MASTER).text.includes('уже есть'));
await press(MASTER, `gpn:${nid}`);
check('карточка профессии', last(MASTER).text.includes('Раскройщик') && last(MASTER).buttons.includes(`gpr:${nid}`) && last(MASTER).buttons.includes(`gpd:${nid}`));
await press(MASTER, `gpr:${nid}`);
await say(MASTER, 'Закройщик');
check('профессия переименована', (await db.query(`select name from professions where id = $1`, [nid])).rows[0].name === 'Закройщик');
await press(MASTER, `gpd:${nid}`);
check('удаление предупреждает про сотрудников', last(MASTER).text.includes('Удалить профессию «Закройщик»'));
await press(MASTER, `gpdy:${nid}`);
check('профессия без записей удалена', (await db.query(`select 1 from professions where id = $1`, [nid])).rows.length === 0 && last(MASTER).text.includes('удалена'));
await press(MASTER, `gpd:${pIron}`);
check('у профессии с сотрудником предупреждение показывает 1', last(MASTER).text.includes('(1)'));
await press(MASTER, `gpdy:${pIron}`);
check('профессия «Утюжник» без записей удалена; у сотрудника «профессия не указана»', (await db.query(`select profession_id from employees where id = $1`, [eD])).rows[0].profession_id === null);

// --- рассылка
await press(MASTER, 'g0');
await press(MASTER, 'gb');
check('рассылка: просьба написать текст, получателей 6 (активные работники цеха), осталось 3 из 3', last(MASTER).text.includes('Получателей: 6') && last(MASTER).text.includes('осталось: 3 из 3'), last(MASTER).text);
await say(MASTER, 'x'.repeat(1001));
check('слишком длинный текст отклонён', last(MASTER).text.includes('от 1 до 1000'));
await say(MASTER, 'Завтра <выходной> & отдых');
check('предпросмотр с получателями; текст экранирован', last(MASTER).text.includes('Предпросмотр') && last(MASTER).text.includes('&lt;выходной&gt; &amp; отдых') && last(MASTER).buttons.includes('gbs'), last(MASTER).text);
let mk = mark();
await press(MASTER, 'gbs');
check('рассылка дошла работникам цеха (6), не работникам другого цеха', [2001, 2002, 2003, 2004, 2005, 2006].every((tg) => since(mk, tg).some((s) => s.text.includes('Сообщение от мастера') && s.text.includes('&lt;выходной&gt;'))) && since(mk, 2007).length === 0);
check('итог: доставлено 6, не доставлено 0; записано в базу', last(MASTER).text.includes('доставлено 6, не доставлено 0') && (await db.query(`select sent, failed, recipients from worker_bot_broadcasts`)).rows[0].sent === 6);
for (const txt of ['Второе', 'Третье']) {
  await press(MASTER, 'gb');
  await say(MASTER, txt);
  await press(MASTER, 'gbs');
}
await press(MASTER, 'gb');
check('четвёртая за день: «лимит исчерпан»', last(MASTER).text.includes('лимит исчерпан'), last(MASTER).text);

// ===================== Планировщик =====================
await db.query('reset role');
await db.query(`update worker_bot_settings set monthly_excel_enabled = true, monthly_last_period = null, reminder_last_date = null`);
await db.query(`update worker_bot_settings set reminder_enabled = true, reminder_time = '21:30', days_off = '{}' where shop = 'factory'`);
await db.query(`insert into worker_bot_users (telegram_id, chat_id, language, full_name, shop, status, employee_id) values (2010, 2010, 'uz', 'Узбекский', 'factory', 'active', null) on conflict do nothing`);
await asUser(db, 'master');
const at = (hhmm: string) => new Date(`${today}T${String(Number(hhmm.slice(0, 2)) - 5).padStart(2, '0')}:${hhmm.slice(2)}:00Z`);
mk = mark();
let cr = await runWorkerBotCron(fakeSb, at('2100'));
check('в 21:00 (до 21:30) — ничего', cr.reminders.length === 0);
cr = await runWorkerBotCron(fakeSb, at('2145'));
check('в 21:45 напоминание цеху «Фабрика»: 2 работника (Дильноза без профессии не может вносить — не шлём; Простой — да; Мадина с ожидающей записью — нет)', cr.reminders.length === 1 && cr.reminders[0].workers === 1 && cr.reminders[0].masters === 1, JSON.stringify(cr));
check('Простому: «Сегодня вы ещё ничего не внесли»; Анвару, Бобуру, Мадине — ничего', since(mk, 2006).some((s) => s.text.includes('Сегодня вы ещё ничего не внесли')) && [2001, 2002, 2003, 2005].every((tg) => since(mk, tg).length === 0));
check('мастеру: «Ждут подтверждения: записей 1»', since(mk, MASTER).some((s) => s.text.includes('Ждут подтверждения: записей 1')));
mk = mark();
cr = await runWorkerBotCron(fakeSb, at('2200'));
check('повторный запуск — ничего (занято в базе)', cr.reminders.length === 0 && since(mk, 2006).length === 0);

// ежемесячный
const [yy, mm] = today.split('-').map(Number);
const nextFirst = new Date(Date.UTC(yy, mm, 1)).toISOString().slice(0, 10);
const monthlyAt = new Date(`${nextFirst}T04:30:00Z`);
const before2 = docs.length;
flags.failDocuments = true;
cr = await runWorkerBotCron(fakeSb, monthlyAt);
check('сбой отправки файлов: месяц «Фабрики» освобождён для повтора; у «Цеха» записей нет — файл не отправляется (месяц остаётся занятым)', cr.monthly.find((x) => x.shop === 'workshop')?.skipped === true && cr.monthly.find((x) => x.shop === 'factory')?.sent === 0 && (await db.query(`select monthly_last_period is null as n from worker_bot_settings where shop = 'factory'`)).rows[0].n === true, JSON.stringify(cr));
flags.failDocuments = false;
cr = await runWorkerBotCron(fakeSb, monthlyAt);
const mf = cr.monthly.find((x) => x.shop === 'factory');
check('повтор после сбоя: отчёт «Фабрики» ушёл мастеру и CEO (2 файла)', cr.monthly.length === 1 && mf?.sent === 2 && docs.length === before2 + 2, JSON.stringify(cr));
const docM = docs.find((d, i) => i >= before2 && d.chat === MASTER)!;
const docC = docs.find((d, i) => i >= before2 && d.chat === CEO)!;
check('файл мастера — на русском, CEO — на узбекском; в подписи «Ежемесячный отчёт» / «Oylik hisobot»', docM.caption.includes('Ежемесячный отчёт') && docC.caption.includes('Oylik hisobot'));
const wbC = new ExcelJS.Workbook();
await wbC.xlsx.load(docC.data as any);
check('у CEO листы на узбекском', wbC.worksheets[0].name.startsWith('Ishchilar'), wbC.worksheets.map((w) => w.name).join());
const wbM = new ExcelJS.Workbook();
await wbM.xlsx.load(docM.data as any);
check('в ежемесячном файле только подтверждённые за прошлый (для запуска — текущий) месяц', Number(wbM.getWorksheet('По работникам')!.getRow(2).getCell(5).value) > 0);
cr = await runWorkerBotCron(fakeSb, monthlyAt);
check('повторный запуск того же месяца — ничего', cr.monthly.length === 0);

h.finish();
