// Сквозной тест: мастер переключает цех в боте, уведомления о новых записях приходят мастерам
// из ОБОИХ цехов с пометкой цеха, подтвердить можно прямо из уведомления.
const { createHarness } = await import('./bot_harness.mts');
const h = await createHarness();
const { db, UIDS, asUser, say, press, last, mark, since, check, sent } = h;

const M1 = 1001, CEO = 1002, M2 = 1003, WF = 2001, WW = 2002;
const M2ID = '00000000-0000-0000-0000-0000000000b2';

await db.query(`insert into auth.users (id, email) values ($1, 'master2@test.test')`, [M2ID]);
await db.query(`insert into profiles (id, email, role, current_shop) values ($1, 'master2@test.test', 'master', 'workshop')`, [M2ID]);
const pSew = (await db.query(`insert into professions (name) values ('Швея') returning id`)).rows[0].id;
const mT = (await db.query(`insert into catalog_models (profession_id, name) values ($1, 'Футболка') returning id`, [pSew])).rows[0].id;
const oOver = (await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Оверлок', 120) returning id`, [mT])).rows[0].id;
const eF = (await db.query(`insert into employees (name, shop, profession_id) values ('Фабричный', 'factory', $1) returning id`, [pSew])).rows[0].id;
const eW = (await db.query(`insert into employees (name, shop, profession_id) values ('Цеховой', 'workshop', $1) returning id`, [pSew])).rows[0].id;
await db.query(`insert into staff_bot_links (profile_id, telegram_id, chat_id, language) values ($1, $2, $2, 'ru'), ($3, $4, $4, 'uz'), ($5, $6, $6, 'ru')`, [UIDS.master, M1, M2ID, M2, UIDS.ceo, CEO]);
const mkW = async (tg: number, emp: string, shop: string) =>
  (await db.query(`insert into worker_bot_users (telegram_id, chat_id, language, full_name, shop, status, employee_id) values ($1, $1, 'ru', $2, $3, 'active', $4) returning id`, [tg, `w${tg}`, shop, emp])).rows[0].id;
await mkW(WF, eF, 'factory');
await mkW(WW, eW, 'workshop');
await asUser(db, 'master');
const shopOf = async (id: string) => (await db.query('reset role').then(() => db.query(`select current_shop from profiles where id = $1`, [id]))).rows[0].current_shop;

// работник вносит запись (ru): добавить работу → модель → операция → количество → подтвердить
async function addWork(tg: number, qty: number) {
  await say(tg, '➕ Добавить работу');
  await press(tg, last(tg).buttons.find((b: string) => b.startsWith('m:'))!);
  await press(tg, last(tg).buttons.find((b: string) => b.startsWith('o:'))!);
  await say(tg, String(qty));
  await press(tg, 'ok');
}
const idFrom = (data: string) => data.split(':')[1];

// ===================== Переключение цеха =====================
await say(M1, '/menu');
check('меню мастера: кнопка «🏭 Цех: Фабрика» внизу', last(M1).reply.at(-1) === '🏭 Цех: Фабрика' && last(M1).reply.length === 6, JSON.stringify(last(M1).reply));
let m = mark();
await say(M1, '🏭 Цех: Фабрика');
check('нажатие переключает на «Цех»: profiles.current_shop = workshop (как на сайте)', (await shopOf(UIDS.master)) === 'workshop');
check('сообщение «Выбран цех: 🧵 Цех. На сайте он тоже переключился» и новое меню с кнопкой «🧵 Цех: Цех»', since(m, M1).some((s) => s.text.includes('Выбран цех: 🧵 Цех') && s.text.includes('На сайте')) && last(M1).reply.at(-1) === '🧵 Цех: Цех' && last(M1).text.includes('🧵 Цех'), JSON.stringify(since(m, M1).map((s) => s.text)));
await say(M1, '🧵 Цех: Цех');
check('второе нажатие возвращает «Фабрику»', (await shopOf(UIDS.master)) === 'factory' && last(M1).reply.at(-1) === '🏭 Цех: Фабрика');
await asUser(db, 'master');
await db.query(`select public.set_my_shop('workshop')`);
await say(M1, '/menu');
check('переключили на сайте (set_my_shop) — бот в меню показывает «🧵 Цех: Цех»', last(M1).reply.at(-1) === '🧵 Цех: Цех');
await db.query(`select public.set_my_shop('factory')`);
await say(M1, '/menu');
// узбекский мастер «Цеха»
await say(M2, '/menu');
check('мастер на узбекском: «🧵 Sex: Sex»', last(M2).reply.at(-1) === '🧵 Sex: Sex', JSON.stringify(last(M2).reply));
await say(M2, '🧵 Sex: Sex');
check('переключил на «Фабрику» (на узбекском), профиль обновлён', (await shopOf(M2ID)) === 'factory' && sent.some((s) => s.chat === M2 && s.text.includes('Sex tanlandi: 🏭 Fabrika')) && last(M2).reply.at(-1) === '🏭 Sex: Fabrika');
await say(M2, '🏭 Sex: Fabrika');
check('и обратно на «Цех»', (await shopOf(M2ID)) === 'workshop');
await say(CEO, '/menu');
check('у CEO та же кнопка; переключение — выбор CEO в боте, профиль CEO не меняется', last(CEO).reply.at(-1) === '🏭 Цех: Фабрика');
await say(CEO, '🏭 Цех: Фабрика');
check('CEO переключился на «Цех»; в ответе нет слов про сайт', last(CEO).reply.at(-1) === '🧵 Цех: Цех' && sent.some((s) => s.chat === CEO && s.text.includes('Выбран цех: 🧵 Цех') && !s.text.includes('На сайте')) && (await shopOf(UIDS.ceo)) === null);

// ===================== Уведомления о новых записях (оба цеха) =====================
// M1 работает в «Фабрике», M2 — в «Цехе». Работник «Цеха» вносит запись.
m = mark();
await addWork(WW, 150);
const nM1 = since(m, M1).find((s) => s.text.includes('Новая запись'));
const nM2 = since(m, M2).find((s) => s.text.includes('Yangi yozuv'));
check('мастер «Фабрики» получил уведомление о записи «Цеха» с пометкой «🧵 Цех»', !!nM1 && nM1.text.includes('🧵 Цех') && nM1.text.includes('Цеховой') && nM1.text.includes('Футболка · Оверлок') && nM1.text.includes('150 шт × 120 сум = 💰 <b>18.000 сум</b>'), nM1?.text);
check('мастер «Цеха» (uz) — на узбекском, тоже с пометкой цеха', !!nM2 && nM2.text.includes('🧵 Sex') && nM2.text.includes('150 dona'), nM2?.text);
check('CEO уведомление не получает', !since(m, CEO).some((s) => s.text.includes('Новая запись') || s.text.includes('Yangi yozuv')));
check('у уведомления три кнопки: подтвердить, количество, отклонить', nM1!.buttons.length === 3 && nM1!.buttons[0].startsWith('nc:') && nM1!.buttons[1].startsWith('nq:') && nM1!.buttons[2].startsWith('nx:'));
check('работнику денег не показали (ни в ответе, ни в кнопках)', since(m, WW).every((s) => !/сум|💰|×/.test(s.text) && s.labels.every((l: string) => !/сум|💰/.test(l))));
const recId = idFrom(nM1!.buttons[0]);

// подтвердить прямо из уведомления, не переключаясь
check('мастер «Фабрики» сейчас в «Фабрике» (цех не менялся)', (await shopOf(UIDS.master)) === 'factory');
m = mark();
await press(M1, nM1!.buttons[0]);
check('запись «Цеха» подтверждена из уведомления мастером «Фабрики»', (await db.query(`select status from work_records where id = $1`, [recId])).rows[0].status === 'confirmed');
check('уведомление превратилось в «Подтверждено · 🧵 Цех» (кнопки убраны)', since(m, M1).some((s) => s.method === 'editMessageText' && s.text.includes('Подтверждено · 🧵 Цех') && s.buttons.length === 0), JSON.stringify(since(m, M1).map((s) => s.text)));
check('цех мастера по-прежнему «Фабрика»', (await shopOf(UIDS.master)) === 'factory');
m = mark();
await press(M2, nM2!.buttons[0]);
check('второй мастер нажал то же — «уже обработана» (на узбекском)', since(m, M2).some((s) => s.text.includes("ko'rib chiqilgan")), JSON.stringify(since(m, M2).map((s) => s.text)));
check('работнику о простом подтверждении сообщений нет', since(m, WW).length === 0);

// запись «Фабрики»: изменить количество из уведомления
m = mark();
await addWork(WF, 40);
const nF = since(m, M1).find((s) => s.text.includes('Новая запись'))!;
check('уведомление о записи «Фабрики» помечено «🏭 Фабрика»', nF.text.includes('🏭 Фабрика') && nF.text.includes('Фабричный'), nF.text);
const recF = idFrom(nF.buttons[0]);
await press(M1, nF.buttons[1]);
check('«Количество»: просьба написать число', last(M1).text.includes('новое количество'));
m = mark();
await say(M1, '35');
check('запись подтверждена с количеством 35 (было 40)', await (async () => { const r = (await db.query(`select status, quantity, quantity_original from work_records where id = $1`, [recF])).rows[0]; return r.status === 'confirmed' && r.quantity === 35 && r.quantity_original === 40; })());
check('уведомление обновлено: «Изменено и подтверждено · 🏭 Фабрика»; работнику — сообщение без денег', sent.some((s) => s.chat === M1 && s.text.includes('Изменено и подтверждено · 🏭 Фабрика') && s.text.includes('40 → 35 шт')) && since(m, WF).some((s) => s.text.includes('изменил вашу запись') && s.text.includes('40 → 35 шт') && !/сум|💰/.test(s.text)));

// отклонить запись «Цеха» (мастер в «Фабрике»)
m = mark();
await addWork(WW, 12);
const nW2 = since(m, M1).find((s) => s.text.includes('Новая запись'))!;
const recW2 = idFrom(nW2.buttons[2]);
await press(M1, nW2.buttons[2]);
check('«Отклонить»: просьба написать причину', last(M1).text.includes('причину отклонения'));
m = mark();
await say(M1, 'Не из этой смены');
check('запись отклонена с причиной; работнику «Цеха» — сообщение с причиной', (await db.query(`select status, reject_reason from work_records where id = $1`, [recW2])).rows[0].reject_reason === 'Не из этой смены' && since(m, WW).some((s) => s.text.includes('отклонил') && s.text.includes('Не из этой смены')));
check('в журнале: отклонение из бота, мастером «Фабрики»', (await db.query(`select count(*)::int as n from work_record_audit where action = 'reject' and via = 'bot'`)).rows[0].n >= 1);

// ===================== Выбранный цех определяет списки =====================
await addWork(WW, 7); // ожидающая запись «Цеха»
await say(M1, '/menu');
check('мастер в «Фабрике»: на подтверждении нет записей «Цеха»; счётчик 0', last(M1).reply.some((r: string) => r === '✅ Подтверждение'), JSON.stringify(last(M1).reply));
await say(M1, '✅ Подтверждение');
check('«Подтверждение» в «Фабрике»: «Нет записей» — запись «Цеха» не показана', last(M1).text.includes('Нет записей'));
await say(M1, '🏭 Цех: Фабрика');
check('после переключения на «Цех» счётчик в меню — 1', last(M1).reply.some((r: string) => r === '✅ Подтверждение (1)'), JSON.stringify(last(M1).reply));
await say(M1, '✅ Подтверждение (1)');
check('и список показывает запись «Цеха» (Цеховой)', last(M1).text.includes('Ждут подтверждения: 1'));
await say(M1, '👷 Работники');
await press(M1, 'ul:all');
check('«Работники» в «Цехе»: только Цеховой', last(M1).labels.some((l: string) => l.startsWith('Цеховой')) && !last(M1).labels.some((l: string) => l.startsWith('Фабричный')));
await say(M1, '🧵 Цех: Цех');
await say(M1, '👷 Работники');
await press(M1, 'ul:all');
check('вернулись в «Фабрику»: только Фабричный', last(M1).labels.some((l: string) => l.startsWith('Фабричный')) && !last(M1).labels.some((l: string) => l.startsWith('Цеховой')));

h.finish();
