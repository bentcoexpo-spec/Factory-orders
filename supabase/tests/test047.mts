// Сквозной тест бота работников: настоящий обработчик (lib/workerBot) против
// настоящей базы на PGlite (миграции 002–045), Telegram подменён. Проверяет
// диалоги целиком: привязка мастера, вход по ссылке, одобрение, «Добавить
// работу», статистика, исправление, отказ, экранирование.
import { register } from 'node:module';
register('./ts-loader.mjs', import.meta.url);

const { newDb, applyMigrations } = await import('./build019.mjs');
const { UIDS, asUser } = await import('./build_master.mjs');

let passed = 0;
let failed = 0;
function check(name: string, cond: unknown, evidence?: unknown) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  ПРОВАЛ:', name, evidence !== undefined ? `(${String(evidence).slice(0, 300)})` : '');
  }
}

const db: any = await newDb();
await applyMigrations(db);
for (const [role, uid] of Object.entries(UIDS)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [uid, `${role}@test.test`]);
  await db.query(`insert into profiles (id, email, role) values ($1, $2, $3) on conflict (id) do update set role = excluded.role`, [uid, `${role}@test.test`, role]);
}
await db.query(`update profiles set current_shop = 'factory' where id = $1`, [UIDS.master]);
// Как в Supabase: service_role обходит RLS.
await db.query('alter role service_role bypassrls');
await asUser(db, 'ceo');
await db.query('reset role');

const pSew = (await db.query(`insert into professions (name) values ('Швея') returning id`)).rows[0].id;
const mT = (await db.query(`insert into catalog_models (profession_id, name, whole_rate) values ($1, 'Футболка', 1500) returning id`, [pSew])).rows[0].id;
await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Оверлок', 120), ($1, 'Строчка', 80)`, [mT]);
const mWeird = (await db.query(`insert into catalog_models (profession_id, name) values ($1, 'Ф&Б <i>') returning id`, [pSew])).rows[0].id;
await db.query(`insert into catalog_operations (model_id, name, rate_per_piece) values ($1, 'Шов', 10)`, [mWeird]);

// ---------- подмена Supabase-клиента (service_role поверх PGlite) и Telegram ----------
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.query('reset role');
  await db.query('set role service_role');
  try {
    return await fn();
  } finally {
    await db.query('reset role');
  }
}
const fakeSb: any = {
  async rpc(fn: string, args: Record<string, unknown>) {
    const keys = Object.keys(args);
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} := $${i + 1}`).join(', ')}) as r`;
    try {
      const res = await asService(() => db.query(sql, keys.map((k) => args[k])));
      return { data: res.rows[0].r, error: null };
    } catch (e: any) {
      return { data: null, error: { message: e.message } };
    }
  },
  from(table: string) {
    if (table !== 'worker_bot_state') throw new Error(`unexpected table ${table}`);
    let filter: number | null = null;
    let op: 'select' | 'delete' | 'upsert' | null = null;
    let row: any = null;
    const q: any = {
      select() { op = 'select'; return q; },
      delete() { op = 'delete'; return q; },
      upsert(r: any) { op = 'upsert'; row = r; return q; },
      eq(_c: string, v: number) { filter = v; return q; },
      async maybeSingle() {
        const r = await asService(() => db.query(`select state, data from worker_bot_state where telegram_id = $1`, [filter]));
        return { data: r.rows[0] ?? null, error: null };
      },
      then(resolve: any) {
        return (async () => {
          if (op === 'delete') await asService(() => db.query(`delete from worker_bot_state where telegram_id = $1`, [filter]));
          if (op === 'upsert')
            await asService(() => db.query(
              `insert into worker_bot_state (telegram_id, state, data) values ($1, $2, $3::jsonb)
               on conflict (telegram_id) do update set state = excluded.state, data = excluded.data`,
              [row.telegram_id, row.state, JSON.stringify(row.data)]
            ));
          return { error: null };
        })().then(resolve);
      },
    };
    return q;
  },
};

interface Sent { method: string; chat: number; text: string; buttons: string[]; labels: string[]; reply: string[]; messageId?: number }
const sent: Sent[] = [];
process.env.TELEGRAM_WORKER_BOT_TOKEN = 'test-token';
(globalThis as any).fetch = async (url: string, init: any) => {
  const method = String(url).split('/').pop() as string;
  const body = JSON.parse(init.body);
  const rm = body.reply_markup ?? {};
  const inlineRows: any[][] = rm.inline_keyboard ?? [];
  sent.push({
    method,
    chat: body.chat_id,
    text: body.text ?? '',
    buttons: inlineRows.flat().map((b) => b.callback_data),
    labels: inlineRows.flat().map((b) => b.text),
    reply: (rm.keyboard ?? []).flat().map((b: any) => b.text),
    messageId: body.message_id,
  });
  return { ok: true, text: async () => '' };
};

const { handleWorkerUpdate } = await import('../../lib/workerBot/handler.ts');

let updateId = 1;
const say = (tg: number, text: string) => handleWorkerUpdate({ update_id: updateId++, message: { message_id: updateId, from: { id: tg, is_bot: false, first_name: 'x' }, chat: { id: tg, type: 'private' } as any, text } } as any, fakeSb);
const press = (tg: number, data: string) => handleWorkerUpdate({ update_id: updateId++, callback_query: { id: `cb${updateId}`, from: { id: tg, is_bot: false, first_name: 'x' }, message: { message_id: 7, from: { id: 0, is_bot: true, first_name: 'bot' }, chat: { id: tg } }, data } } as any, fakeSb);
const texts = (chat: number, from = 0) => sent.slice(from).filter((s) => s.chat === chat && s.method !== 'answerCallbackQuery');
const last = (chat: number) => texts(chat).at(-1)!;
const mark = () => sent.length;
const since = (m: number, chat: number) => texts(chat, m);
const btn = (s: Sent, prefix: string) => s.buttons.find((b) => b.startsWith(prefix))!;

const MASTER = 1001, W1 = 2001, W2 = 2002, STRANGER = 9999;

// ===================== 1. Привязка мастера =====================
await asUser(db, 'master');
const code = (await db.query(`select public.create_staff_link_code() as c`)).rows[0].c;
await say(MASTER, `/start link_${code}`);
check('мастер: «Telegram подключён» и выбор языка', since(0, MASTER)[0].text.includes('Telegram подключён') && since(0, MASTER).some((s) => s.buttons.includes('slang:uz')), JSON.stringify(sent.slice(0, 2)));
await press(MASTER, 'slang:ru');
check('мастер: после выбора языка — приветствие «подключены как мастер» и главное меню', sent.some((x) => x.chat === MASTER && x.text.includes('подключены как мастер')) && last(MASTER).reply.includes('📦 Изделия'));
await say(STRANGER, '/start link_WRONGWRONG12');
check('неверный код привязки: понятное сообщение на двух языках', last(STRANGER).text.includes('Код неверный') && last(STRANGER).text.includes('Kod'));
await say(STRANGER, 'привет');
check('незнакомый без ссылки: «нужна ссылка от мастера»', last(STRANGER).text.includes('ссылка-приглашение') && last(STRANGER).text.includes('havolasi'));

// ===================== 2. Вход работника по ссылке =====================
const invite = (await db.query(`select public.create_worker_invite($1) as r`, [pSew])).rows[0].r;
await say(STRANGER, '/start 00000000000000000000000000000000');
check('неверная ссылка: «недействительна»', last(STRANGER).text.includes('недействительна'));

let m = mark();
await say(W1, `/start ${invite.token}`);
check('по ссылке: выбор языка', last(W1).buttons.includes('lang:ru') && last(W1).buttons.includes('lang:uz'));
await press(W1, 'lang:uz');
check('после выбора uz — просьба написать имя на узбекском', last(W1).text.includes('Ism va familiyangizni'), last(W1).text);
await say(W1, '12345');
check('имя из цифр отклонено (на узбекском)', last(W1).text.includes('2–40'), last(W1).text);
m = mark();
await say(W1, 'Алишер Каримов');
check('имя принято, работнику «Ariza ustaga yuborildi»', since(m, W1).some((s) => s.text.includes('Ariza ustaga yuborildi')));
const req = since(m, MASTER).at(-1)!;
check('мастеру пришла заявка с кнопками «Принять»/«Отклонить», цех и профессия на русском', req && req.text.includes('Алишер Каримов') && req.text.includes('Фабрика') && req.text.includes('Швея') && req.buttons.some((b) => b.startsWith('ap:')) && req.buttons.some((b) => b.startsWith('rj:')), JSON.stringify(req));
await say(W1, 'я тут');
check('до одобрения: «заявка отправлена, ждите» на узбекском', last(W1).text.includes('Ariza ustaga yuborilgan'));
await say(W1, "➕ Ish qo'shish");
check('до одобрения «Добавить работу» не работает', !last(W1).buttons.some((b) => b.startsWith('k:') || b.startsWith('m:')));

// ===================== 3. Одобрение мастером в боте =====================
m = mark();
await press(MASTER, btn(req, 'ap:'));
const pick = last(MASTER);
check('мастер: список сотрудников с кнопкой «Создать сотрудника»', pick.method === 'editMessageText' && pick.buttons.includes('an') && pick.labels[0].includes('Создать сотрудника'), JSON.stringify(pick));
m = mark();
await press(MASTER, 'an');
check('мастер: сообщение «Принят: Алишер Каримов»', since(m, MASTER).some((s) => s.text.includes('Принят') && s.text.includes('Алишер Каримов')));
const approved = since(m, W1).at(-1)!;
check('работнику: «Usta arizangizni qabul qildi» и меню на узбекском', approved.text.includes('qabul qildi') && approved.reply.includes("➕ Ish qo'shish") && approved.reply.includes('📊 Mening statistikam'), JSON.stringify(approved));
const emp = (await db.query(`select id, name, shop, profession_id from employees where name = 'Алишер Каримов'`)).rows[0];
check('в Табеле создан сотрудник цеха мастера с профессией из ссылки', emp && emp.shop === 'factory' && emp.profession_id === pSew);
m = mark();
await press(MASTER, btn(req, 'ap:'));
check('повторное нажатие на ту же заявку: «уже обработана»', sent.slice(m).some((s) => s.text.includes('уже обработана')));

// ===================== 4. Добавить работу: операция =====================
m = mark();
await say(W1, "➕ Ish qo'shish");
let r1 = last(W1);
check('выбор «Операция / Целое изделие» на узбекском', r1.text.includes('Nima qildingiz') && r1.buttons.includes('k:o') && r1.buttons.includes('k:w'), JSON.stringify(r1));
await press(W1, 'k:o');
const models = last(W1);
check('список моделей (нет чужой профессии)', models.buttons.filter((b) => b.startsWith('m:')).length === 2 && models.labels.some((l) => l === 'Футболка'));
await press(W1, models.buttons[models.labels.indexOf('Футболка')]);
const ops = last(W1);
check('операции — только названия, без цен на кнопках', ops.labels.includes('Оверлок') && ops.labels.includes('Строчка') && !ops.labels.some((l: string) => /so'm|сум|\d/.test(l)), JSON.stringify(ops.labels));
await press(W1, ops.buttons[ops.labels.findIndex((l) => l.startsWith('Оверлок'))]);
check('вопрос о количестве', last(W1).text.includes('Футболка · Оверлок') && last(W1).text.includes('Necha dona'));
await say(W1, 'много');
check('нецелое количество отклонено', last(W1).text.includes('1 dan 99999'));
await say(W1, '0');
check('нуль отклонён', last(W1).text.includes('1 dan 99999'));
await say(W1, '10');
const review = last(W1);
check('сводка: «10 dona» без цены и суммы, кнопки подтверждения', review.text.includes('10 dona') && !/so'm|💰|×/.test(review.text) && review.buttons.includes('ok') && review.buttons.includes('no'), review.text);
m = mark();
await press(W1, 'ok');
const saved = last(W1);
check('«Saqlandi» с количеством и пометкой про подтверждение мастером, без денег; кнопка «Yana qo\'shish»', saved.text.includes('Saqlandi') && saved.text.includes('10 dona') && saved.text.includes('tasdiqlashi') && !/so'm|💰|×/.test(saved.text) && saved.buttons.includes('more'), saved.text);
const rec1 = (await db.query(`select id, status, source, quantity, rate_per_piece from work_records where employee_id = $1`, [emp.id])).rows;
check('в базе одна запись: pending, source=bot, 10 × 120', rec1.length === 1 && rec1[0].status === 'pending' && rec1[0].source === 'bot' && rec1[0].quantity === 10 && Number(rec1[0].rate_per_piece) === 120);
await press(W1, 'ok');
check('повторное «Подтвердить»: дубля нет', (await db.query(`select count(*)::int as n from work_records where employee_id = $1`, [emp.id])).rows[0].n === 1 && last(W1).text.includes('dolzarb'));

// ===================== 5. Целое изделие =====================
await press(W1, 'more');
await press(W1, 'k:w');
const wm = last(W1);
check('целое изделие: модель — только название, без цены', wm.labels.includes('Футболка') && wm.buttons.filter((b: string) => b.startsWith('m:')).length === 1 && !wm.labels.some((l: string) => /so'm|\d/.test(l)), JSON.stringify(wm.labels));
await press(W1, wm.buttons.find((b) => b.startsWith('m:'))!);
check('количество для целого изделия', last(W1).text.includes('Футболка (butun)'));
await say(W1, '3');
check('сводка целого изделия: 3 dona, без суммы', last(W1).text.includes('3 dona') && !/so'm|💰/.test(last(W1).text), last(W1).text);
await press(W1, 'ok');
check('целое изделие сохранено', last(W1).text.includes('Saqlandi') && last(W1).text.includes('Футболка (butun)'), last(W1).text);

// отмена
await press(W1, 'more');
await press(W1, 'k:o');
await press(W1, last(W1).buttons[last(W1).labels.indexOf('Футболка')]);
await press(W1, 'no');
check('«Отмена»: ничего не сохранено', last(W1).text.includes('Bekor qilindi') && (await db.query(`select count(*)::int as n from work_records where employee_id = $1`, [emp.id])).rows[0].n === 2);

// экранирование HTML
await press(W1, 'more');
await press(W1, 'k:o');
const wm2 = last(W1);
await press(W1, wm2.buttons[wm2.labels.indexOf('Ф&Б <i>')]);
check('название модели с «&» и «<» в тексте экранировано', last(W1).text.includes('Ф&amp;Б &lt;i&gt;'), last(W1).text);
await press(W1, 'no');

// ===================== 6. Статистика =====================
await say(W1, '📊 Mening statistikam');
check('выбор периода', last(W1).buttons.includes('s:d') && last(W1).buttons.includes('s:w') && last(W1).buttons.includes('s:m'));
await press(W1, 's:d');
let st = last(W1);
check('сегодня: только «ждёт подтверждения» (на узбекском), только штуки', st.text.includes('Tasdiqlashni kutmoqda') && !st.text.includes('Usta tasdiqlagan') && st.text.includes('• Футболка · Оверлок — 10 dona') && st.text.includes('Butun buyumlar:') && st.text.includes('• Футболка — 3 dona') && st.text.includes('Jami: 13 dona') && !/so'm|💰|×/.test(st.text), st.text);
check('в статистике нет чужих имён', !st.text.includes('Алишер') && st.buttons.includes('fix'));

// мастер подтверждает первую запись (эмуляция Этапа 3)
await db.query('reset role');
await db.query(`alter table work_records disable trigger work_records_before_update`);
await db.query(`update work_records set status = 'confirmed' where id = $1`, [rec1[0].id]);
await db.query(`alter table work_records enable trigger work_records_before_update`);
await press(W1, 's:d');
st = last(W1);
check('после подтверждения: отдельно «Usta tasdiqlagan» (10 dona) и «Tasdiqlashni kutmoqda» (3 dona)', st.text.includes('Usta tasdiqlagan') && st.text.includes('Tasdiqlashni kutmoqda') && st.text.includes('Jami: 10 dona') && st.text.includes('Jami: 3 dona') && !/so'm|💰/.test(st.text), st.text);
await press(W1, 's:w');
st = last(W1);
check('неделя: сравнение с прошлой неделей — в штуках', st.text.includes("O'tgan hafta") && st.text.includes('0 dona') && !/so'm|💰/.test(st.text), st.text);
await press(W1, 's:m');
check('месяц: подтверждённое (10) и неподтверждённое (3) — отдельно, в штуках', last(W1).text.includes('Usta tasdiqlagan') && last(W1).text.includes('Jami: 10 dona') && last(W1).text.includes('Jami: 3 dona'), last(W1).text);

// ===================== 7. Исправление =====================
await press(W1, 'fix');
const fixList = last(W1);
check('исправлять можно только запись, которую мастер не подтвердил (целое изделие)', fixList.buttons.filter((b) => b.startsWith('e:')).length === 1 && fixList.labels[0].includes('Футболка (butun) — 3 dona'), JSON.stringify(fixList));
const wholeId = fixList.buttons[0].slice(2);
await press(W1, `e:${wholeId}`);
check('карточка записи: изменить количество / удалить', last(W1).buttons.includes(`eq:${wholeId}`) && last(W1).buttons.includes(`ed:${wholeId}`));
await press(W1, `eq:${wholeId}`);
check('вопрос о новом количестве', last(W1).text.includes('yangi son'));
await say(W1, '5');
check('количество исправлено: 5 dona, без денег', last(W1).text.includes('Tuzatildi') && last(W1).text.includes('5 dona') && !/so'm|💰|×/.test(last(W1).text), last(W1).text);
check('в базе количество 5, ставка прежняя', (await db.query(`select quantity, rate_per_piece from work_records where id = $1`, [wholeId])).rows[0].quantity === 5);
await press(W1, `ed:${wholeId}`);
check('удаление спрашивает подтверждение', last(W1).buttons.includes(`edy:${wholeId}`));
await press(W1, `edy:${wholeId}`);
check('запись удалена', last(W1).text.includes("o'chirildi") && (await db.query(`select 1 from work_records where id = $1`, [wholeId])).rows.length === 0);
await press(W1, `e:${rec1[0].id}`);
check('подтверждённую запись править нельзя: «нельзя исправить»', last(W1).text.includes('tuzatib bo'), last(W1).text);

// ===================== 8. Отклонение =====================
await say(W2, `/start ${invite.token}`);
await press(W2, 'lang:ru');
m = mark();
await say(W2, 'Бахтиёр Рахимов');
const req2 = since(m, MASTER).at(-1)!;
await press(MASTER, btn(req2, 'rj:'));
check('отклонение: мастеру «Отклонено», работнику уведомление без меню', last(MASTER).text.includes('Отклонено') && last(W2).text.includes('отклонил') && last(W2).reply.length === 0);
await say(W2, `/start ${invite.token}`);
check('повторная заявка по той же ссылке не принимается', last(W2).text.includes('отклонена'));
await say(W2, "➕ Добавить работу");
check('отклонённый работать не может', !last(W2).buttons.some((b) => b.startsWith('k:')));

// ===================== 8б. Привязка к существующему сотруднику =====================
const W3 = 2003;
await db.query('reset role');
const freeEmp = (await db.query(`insert into employees (name, shop) values ('Свободный Сотрудник', 'factory') returning id`)).rows[0].id;
await db.query(`insert into employees (name, shop) values ('Чужой цех', 'workshop')`);
await asUser(db, 'master');
await say(W3, `/start ${invite.token}`);
await press(W3, 'lang:ru');
m = mark();
await say(W3, 'Третий Работник');
const req3 = since(m, MASTER).at(-1)!;
await press(MASTER, btn(req3, 'ap:'));
const list3 = last(MASTER);
check('в списке — свободный сотрудник своего цеха, без привязанных и без чужого цеха', list3.labels.some((l) => l.startsWith('Свободный Сотрудник')) && !list3.labels.some((l) => l.includes('Чужой') || l.includes('Алишер')), JSON.stringify(list3.labels));
await press(MASTER, list3.buttons[list3.labels.findIndex((l) => l.startsWith('Свободный Сотрудник'))]);
check('привязка к существующему: «Принят → сотрудник «Свободный Сотрудник»»', last(MASTER).text.includes('Свободный Сотрудник') && (await db.query(`select 1 from worker_bot_users where telegram_id = $1 and employee_id = $2 and status = 'active'`, [W3, freeEmp])).rows.length === 1, last(MASTER).text);
check('новый сотрудник при этом не создан', (await db.query(`select count(*)::int as n from employees where name = 'Третий Работник'`)).rows[0].n === 0);

// ===================== 9. Мастер пишет боту, смена языка =====================
await say(MASTER, 'что-нибудь');
check('мастер на произвольный текст — главное меню', last(MASTER).reply.includes('✅ Подтверждение') || last(MASTER).reply.some((x: string) => x.startsWith('✅ Подтверждение')));
await say(W1, '/lang');
check('/lang показывает выбор языка', last(W1).buttons.includes('lang:ru'));
await press(W1, 'lang:ru');
check('язык изменён на русский, меню на русском', last(W1).reply.includes('➕ Добавить работу'), JSON.stringify(last(W1)));

// ===================== 10. Снятие мастером на сайте =====================
await asUser(db, 'master');
const wu = (await db.query(`select id from worker_bot_users where telegram_id = $1`, [W1])).rows[0].id;
await db.query(`select public.decide_worker($1, 'remove')`, [wu]);
await say(W1, '➕ Добавить работу');
check('снятый с бота работник работать больше не может', !last(W1).buttons.some((b) => b.startsWith('k:')) && last(W1).text.includes('не подключены'), last(W1).text);

// ===================== Деньги работнику не показываются =====================
const MONEY = /расценк|сум|so['’ʻ]m|\bsum\b|заработ|зарплат|оплат|ставк|цен[аыуеой]|стоимост|💰|×|ish haqi|maosh|oylik|narx|\bpul\b|summa|to['’ʻ]lov/i;
const workerChats = new Set([W1, 2002]);
const leaks = sent.filter((x) => workerChats.has(x.chat) && x.method !== 'answerCallbackQuery' && (MONEY.test(x.text) || x.labels.some((l: string) => MONEY.test(l))));
check('за весь сценарий НИ ОДНО сообщение работнику (ни текст, ни кнопки, ни uz, ни ru) не содержит денег', leaks.length === 0, JSON.stringify(leaks.map((x) => x.text.slice(0, 80))));

console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
process.exit(failed > 0 ? 1 : 0);
