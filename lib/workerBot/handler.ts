import type { SupabaseClient } from '@supabase/supabase-js';
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from '@/lib/telegram';
import { answerCallback, editMessage, inline, type InlineButton, type Markup, sendMessage } from './api';
import {
  type BotCatalog,
  type CatalogModel,
  clearState,
  getState,
  isDbError,
  type Recipient,
  rpc,
  serviceClient,
  setState,
  type StaffInfo,
  type WorkerInfo,
  type WorkRec,
} from './db';
import { isLang, type Lang, type MessageKey, money, t, both } from './i18n';
import { displayLabel, fmtDate, formatStats, type Period, rangeFor, tashkentToday } from './stats';
import { notifyWorkerDecision, workerMenu } from './notify';
import { onStaffCallback, onStaffText, showStaffMenu } from './staff';

// Бот работников цеха (Этап 2): вход по ссылке с одобрением мастера,
// «Добавить работу», «Моя статистика», исправление сегодняшних записей.
// Мастер/директор здесь пока только принимают заявки.

const NAME_PATTERN = /^\p{L}[\p{L}\p{M}\s.'’ʻ-]{1,39}$/u;
const QTY_PATTERN = /^\d{1,5}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const idOf = (data: string, prefix: string): string | null => {
  const m = new RegExp(`^${prefix}:(${UUID})$`).exec(data);
  return m ? m[1] : null;
};

interface PrivateChat {
  id: number;
  type?: string;
}

const mainMenu = (lang: Lang): Markup => workerMenu(lang);

function langChooser(): InlineButton[][] {
  return [[{ text: t('ru', 'lang.ru'), callback_data: 'lang:ru' }, { text: t('uz', 'lang.uz'), callback_data: 'lang:uz' }]];
}
function staffLangChooser(): InlineButton[][] {
  return [[{ text: t('ru', 'lang.ru'), callback_data: 'slang:ru' }, { text: t('uz', 'lang.uz'), callback_data: 'slang:uz' }]];
}

async function getWorker(sb: SupabaseClient, tg: number): Promise<WorkerInfo | null> {
  return rpc<WorkerInfo | null>(sb, 'bot_worker_get', { p_tg: tg });
}
async function getStaff(sb: SupabaseClient, tg: number): Promise<StaffInfo | null> {
  return rpc<StaffInfo | null>(sb, 'bot_staff_resolve', { p_tg: tg });
}

// ====================================================================
// Вход
// ====================================================================
export async function handleWorkerUpdate(update: TelegramUpdate, sb: SupabaseClient = serviceClient()): Promise<void> {
  if (update.callback_query) {
    await handleCallback(sb, update.callback_query);
    return;
  }
  const msg = update.message;
  if (msg && typeof msg.text === 'string' && (msg.chat as PrivateChat).type !== 'group' && (msg.chat as PrivateChat).type !== 'supergroup') {
    await handleMessage(sb, msg);
  }
}

async function handleMessage(sb: SupabaseClient, msg: TelegramMessage) {
  const tg = msg.from.id;
  const chatId = msg.chat.id;
  const text = (msg.text ?? '').trim();

  try {
    if (text.startsWith('/')) {
      const [cmdRaw, ...rest] = text.split(/\s+/);
      const cmd = cmdRaw.split('@')[0].toLowerCase();
      const arg = rest.join(' ').trim();
      if (cmd === '/start') return await onStart(sb, tg, chatId, arg);
      if (cmd === '/link') return await onStaffLink(sb, tg, chatId, arg);
      if (cmd === '/lang') return await onLangCommand(sb, tg, chatId);
      if (cmd === '/cancel' || cmd === '/menu') {
        await clearState(sb, tg);
        return await home(sb, tg, chatId);
      }
      return await home(sb, tg, chatId);
    }

    const staff = await getStaff(sb, tg);
    if (staff) return await onStaffText(sb, staff, tg, chatId, text);
    await onWorkerText(sb, tg, chatId, text);
  } catch (err) {
    console.error('worker bot message error', err);
    await sendMessage(chatId, both('err.generic'));
  }
}

async function onStart(sb: SupabaseClient, tg: number, chatId: number, payload: string) {
  if (payload.startsWith('link_')) return onStaffLink(sb, tg, chatId, payload.slice(5));
  if (!payload) return home(sb, tg, chatId);

  const res = await rpc<{ result: string; user?: WorkerInfo }>(sb, 'bot_worker_begin', { p_tg: tg, p_chat: chatId, p_code: payload });
  const user = res.user;
  switch (res.result) {
    case 'invalid_code':
      return void (await sendMessage(chatId, both('w.badLink')));
    case 'staff':
      return void (await sendMessage(chatId, both('w.isStaff')));
    case 'rejected':
      return void (await sendMessage(chatId, both('w.rejected')));
    case 'pending':
      return void (await sendMessage(chatId, t(user?.language ?? 'ru', 'w.pending')));
    case 'already_active':
      await sendMessage(chatId, t(user?.language ?? 'ru', 'w.alreadyActive'), user?.language ? mainMenu(user.language) : undefined);
      return;
    default:
      await clearState(sb, tg);
      await sendMessage(chatId, both('lang.choose'), inline(langChooser()));
  }
}

// Привязка Telegram мастера/директора по одноразовому коду с сайта.
async function onStaffLink(sb: SupabaseClient, tg: number, chatId: number, code: string) {
  try {
    const res = await rpc<{ role: 'ceo' | 'master' }>(sb, 'bot_staff_link', { p_tg: tg, p_chat: chatId, p_code: code, p_lang: 'ru' });
    await sendMessage(chatId, t('ru', 's.linked', { role: t('ru', `role.${res.role}`) }));
    await sendMessage(chatId, both('lang.choose'), inline(staffLangChooser()));
  } catch (err) {
    if (isDbError(err, 'invalid_code')) return void (await sendMessage(chatId, both('s.badCode')));
    if (isDbError(err, 'telegram_already_linked')) return void (await sendMessage(chatId, both('s.alreadyLinked')));
    if (isDbError(err, 'telegram_is_worker')) return void (await sendMessage(chatId, both('s.isWorker')));
    throw err;
  }
}

async function onLangCommand(sb: SupabaseClient, tg: number, chatId: number) {
  const staff = await getStaff(sb, tg);
  await sendMessage(chatId, both('lang.choose'), inline(staff ? staffLangChooser() : langChooser()));
}

// «Домой»: что показать человеку, когда он просто написал боту.
async function home(sb: SupabaseClient, tg: number, chatId: number) {
  const staff = await getStaff(sb, tg);
  if (staff) return showStaffMenu(sb, tg, chatId, staff);
  const w = await getWorker(sb, tg);
  if (!w) return void (await sendMessage(chatId, both('w.noLink')));
  const lang = w.language;
  if (w.status === 'registering') {
    if (!lang) return void (await sendMessage(chatId, both('lang.choose'), inline(langChooser())));
    return void (await sendMessage(chatId, t(lang, 'w.askName')));
  }
  const l: Lang = lang ?? 'ru';
  if (w.status === 'pending') return void (await sendMessage(chatId, t(l, 'w.pending')));
  if (w.status === 'rejected') return void (await sendMessage(chatId, t(l, 'w.rejected')));
  if (w.status === 'removed') return void (await sendMessage(chatId, t(l, 'w.notActive')));
  if (!w.can_add) return void (await sendMessage(chatId, t(l, 'w.noEmployee')));
  await sendMessage(chatId, t(l, 'menu.title'), mainMenu(l));
}

// ====================================================================
// Текст работника
// ====================================================================
async function onWorkerText(sb: SupabaseClient, tg: number, chatId: number, text: string) {
  const w = await getWorker(sb, tg);
  if (!w) return void (await sendMessage(chatId, both('w.noLink')));

  if (w.status === 'registering') {
    if (!w.language) return void (await sendMessage(chatId, both('lang.choose'), inline(langChooser())));
    const lang = w.language;
    const name = text.replace(/\s+/g, ' ');
    if (!NAME_PATTERN.test(name)) return void (await sendMessage(chatId, t(lang, 'w.badName')));
    const res = await rpc<{ user: WorkerInfo; recipients: Recipient[] }>(sb, 'bot_worker_submit_name', { p_tg: tg, p_name: name });
    await sendMessage(chatId, t(lang, 'w.submitted', { name }));
    await notifyRecipients(res.recipients, res.user);
    return;
  }
  if (w.status !== 'active') return home(sb, tg, chatId);
  const lang: Lang = w.language ?? 'ru';
  if (!w.can_add) return void (await sendMessage(chatId, t(lang, 'w.noEmployee')));

  if (text === t('ru', 'menu.add') || text === t('uz', 'menu.add')) {
    await clearState(sb, tg);
    return startAdd(sb, tg, chatId, lang);
  }
  if (text === t('ru', 'menu.stats') || text === t('uz', 'menu.stats')) {
    await clearState(sb, tg);
    return void (await sendMessage(chatId, t(lang, 'stats.pick'), inline(statsButtons(lang, false))));
  }

  const st = await getState(sb, tg);
  if (st?.state === 'qty') return onQuantity(sb, tg, chatId, lang, st.data, text);
  if (st?.state === 'edit_qty') return onEditQuantity(sb, tg, chatId, lang, st.data, text);
  await sendMessage(chatId, t(lang, 'menu.title'), mainMenu(lang));
}

// ====================================================================
// Добавить работу
// ====================================================================
const cancelRow = (lang: Lang): InlineButton[] => [{ text: t(lang, 'btn.cancel'), callback_data: 'no' }];

async function loadCatalog(sb: SupabaseClient, tg: number): Promise<BotCatalog> {
  return rpc<BotCatalog>(sb, 'bot_catalog', { p_tg: tg });
}

async function startAdd(sb: SupabaseClient, tg: number, chatId: number, lang: Lang, messageId?: number) {
  const send = (text: string, buttons?: InlineButton[][]) =>
    messageId ? editMessage(chatId, messageId, text, buttons) : sendMessage(chatId, text, buttons ? inline(buttons) : undefined);

  const cat = await loadCatalog(sb, tg);
  if (cat.no_profession) return void (await send(t(lang, 'add.noProfession')));
  const wholeModels = cat.models.filter((m) => Number(m.whole_rate) > 0);
  const opModels = cat.models.filter((m) => m.ops.length > 0);
  if (wholeModels.length === 0 && opModels.length === 0) return void (await send(t(lang, 'add.emptyCatalog')));

  if (wholeModels.length === 0) return showModels(sb, tg, lang, 'o', send, cat);
  if (opModels.length === 0) return showModels(sb, tg, lang, 'w', send, cat);

  await setState(sb, tg, 'add', {});
  await send(t(lang, 'add.kind'), [
    [{ text: t(lang, 'add.kindOp'), callback_data: 'k:o' }, { text: t(lang, 'add.kindWhole'), callback_data: 'k:w' }],
    cancelRow(lang),
  ]);
}

async function showModels(
  sb: SupabaseClient,
  tg: number,
  lang: Lang,
  mode: 'o' | 'w',
  send: (text: string, buttons?: InlineButton[][]) => Promise<unknown>,
  cat: BotCatalog
) {
  const models = mode === 'w' ? cat.models.filter((m) => Number(m.whole_rate) > 0) : cat.models.filter((m) => m.ops.length > 0);
  await setState(sb, tg, 'add', { mode });
  await send(t(lang, 'add.pickModel'), [
    ...models.slice(0, 80).map((m) => [
      { text: mode === 'w' ? `${m.name} — ${money(Number(m.whole_rate), lang)}` : m.name, callback_data: `m:${m.id}` },
    ]),
    cancelRow(lang),
  ]);
}

async function onKind(sb: SupabaseClient, tg: number, chatId: number, messageId: number, lang: Lang, mode: 'o' | 'w') {
  const cat = await loadCatalog(sb, tg);
  await showModels(sb, tg, lang, mode, (text, buttons) => editMessage(chatId, messageId, text, buttons), cat);
}

async function onModel(sb: SupabaseClient, tg: number, chatId: number, messageId: number, lang: Lang, modelId: string) {
  const st = await getState(sb, tg);
  const mode = st?.state === 'add' ? (st.data.mode as 'o' | 'w' | undefined) : undefined;
  if (!mode) return void (await sendMessage(chatId, t(lang, 'err.stale')));
  const cat = await loadCatalog(sb, tg);
  const model: CatalogModel | undefined = cat.models.find((m) => m.id === modelId);
  if (!model || (mode === 'w' && !(Number(model.whole_rate) > 0)) || (mode === 'o' && model.ops.length === 0)) {
    return void (await editMessage(chatId, messageId, t(lang, 'add.gone')));
  }
  if (mode === 'w') {
    const label = `${model.name} (${t(lang, 'add.wholeSuffix')})`;
    await setState(sb, tg, 'qty', { kind: 'whole', id: model.id, label, rate: Number(model.whole_rate) });
    await editMessage(chatId, messageId, t(lang, 'add.askQty', { label }), [cancelRow(lang)]);
    return;
  }
  await setState(sb, tg, 'add', { mode, modelId: model.id });
  await editMessage(chatId, messageId, t(lang, 'add.pickOp', { model: model.name }), [
    ...model.ops.slice(0, 80).map((o) => [{ text: `${o.name} — ${money(Number(o.rate), lang)}`, callback_data: `o:${o.id}` }]),
    cancelRow(lang),
  ]);
}

async function onOperation(sb: SupabaseClient, tg: number, chatId: number, messageId: number, lang: Lang, opId: string) {
  const st = await getState(sb, tg);
  const modelId = st?.state === 'add' ? (st.data.modelId as string | undefined) : undefined;
  if (!modelId) return void (await sendMessage(chatId, t(lang, 'err.stale')));
  const cat = await loadCatalog(sb, tg);
  const model = cat.models.find((m) => m.id === modelId);
  const op = model?.ops.find((o) => o.id === opId);
  if (!model || !op) return void (await editMessage(chatId, messageId, t(lang, 'add.gone')));
  const label = `${model.name} · ${op.name}`;
  await setState(sb, tg, 'qty', { kind: 'op', id: op.id, label, rate: Number(op.rate) });
  await editMessage(chatId, messageId, t(lang, 'add.askQty', { label }), [cancelRow(lang)]);
}

async function onQuantity(sb: SupabaseClient, tg: number, chatId: number, lang: Lang, data: Record<string, unknown>, text: string) {
  const qty = QTY_PATTERN.test(text) ? Number(text) : 0;
  if (qty < 1 || qty > 99999) return void (await sendMessage(chatId, t(lang, 'add.badQty')));
  const rate = Number(data.rate);
  await setState(sb, tg, 'review', { ...data, quantity: qty });
  await sendMessage(
    chatId,
    t(lang, 'add.review', {
      label: String(data.label),
      qty,
      rate: money(rate, lang),
      total: money(qty * rate, lang),
      date: fmtDate(tashkentToday()),
    }),
    inline([[{ text: t(lang, 'add.confirm'), callback_data: 'ok' }, { text: t(lang, 'btn.cancel'), callback_data: 'no' }]])
  );
}

async function onConfirm(sb: SupabaseClient, tg: number, chatId: number, messageId: number, lang: Lang) {
  try {
    const res = await rpc<{ label: string; is_whole: boolean; quantity: number; rate: number; total: number }>(sb, 'bot_commit_draft', { p_tg: tg });
    await editMessage(
      chatId,
      messageId,
      t(lang, 'add.saved', {
        label: displayLabel(res.label, res.is_whole, lang),
        qty: res.quantity,
        rate: money(Number(res.rate), lang),
        total: money(Number(res.total), lang),
      }),
      [[{ text: t(lang, 'add.again'), callback_data: 'more' }, { text: t(lang, 'add.fix'), callback_data: 'fix' }]]
    );
  } catch (err) {
    if (isDbError(err, 'no_draft')) return void (await editMessage(chatId, messageId, t(lang, 'err.stale')));
    if (
      isDbError(err, 'wrong_profession') ||
      isDbError(err, 'rate_not_set') ||
      isDbError(err, 'catalog_item_archived') ||
      isDbError(err, 'catalog_item_not_found')
    ) {
      await clearState(sb, tg);
      return void (await editMessage(chatId, messageId, t(lang, 'add.gone')));
    }
    throw err;
  }
}

// ====================================================================
// Статистика
// ====================================================================
function statsButtons(lang: Lang, withFix: boolean): InlineButton[][] {
  const rows: InlineButton[][] = [
    [
      { text: t(lang, 'stats.today'), callback_data: 's:d' },
      { text: t(lang, 'stats.week'), callback_data: 's:w' },
      { text: t(lang, 'stats.month'), callback_data: 's:m' },
    ],
  ];
  if (withFix) rows.push([{ text: t(lang, 'stats.fix'), callback_data: 'fix' }]);
  return rows;
}

async function records(sb: SupabaseClient, tg: number, from: string, to: string): Promise<WorkRec[]> {
  return rpc<WorkRec[]>(sb, 'bot_records', { p_tg: tg, p_from: from, p_to: to });
}

async function onStats(sb: SupabaseClient, tg: number, chatId: number, messageId: number, lang: Lang, period: Period) {
  const today = tashkentToday();
  const range = rangeFor(period, today);
  const recs = await records(sb, tg, range.from, range.to);
  const prev = range.prevFrom && range.prevTo ? await records(sb, tg, range.prevFrom, range.prevTo) : null;
  const text = formatStats(
    period,
    range,
    recs.map((r) => ({ ...r, label: r.label })),
    prev,
    lang
  );
  await editMessage(chatId, messageId, text, statsButtons(lang, period === 'd'));
}

// ====================================================================
// Исправление сегодняшних записей
// ====================================================================
async function editableToday(sb: SupabaseClient, tg: number): Promise<WorkRec[]> {
  const today = tashkentToday();
  return (await records(sb, tg, today, today)).filter((r) => r.editable);
}

const recLine = (r: WorkRec, lang: Lang) => `${displayLabel(r.label, r.is_whole, lang)} — ${r.quantity} ${t(lang, 'pcs')}`;

async function onFixList(sb: SupabaseClient, tg: number, chatId: number, messageId: number | null, lang: Lang) {
  const list = await editableToday(sb, tg);
  const send = (text: string, buttons?: InlineButton[][]) =>
    messageId ? editMessage(chatId, messageId, text, buttons) : sendMessage(chatId, text, buttons ? inline(buttons) : undefined);
  if (list.length === 0) return void (await send(t(lang, 'edit.none')));
  await send(t(lang, 'edit.title'), list.slice(0, 80).map((r) => [{ text: recLine(r, lang), callback_data: `e:${r.id}` }]));
}

async function findEditable(sb: SupabaseClient, tg: number, id: string): Promise<WorkRec | null> {
  return (await editableToday(sb, tg)).find((r) => r.id === id) ?? null;
}

async function onRecordCard(sb: SupabaseClient, tg: number, chatId: number, messageId: number, lang: Lang, id: string) {
  const r = await findEditable(sb, tg, id);
  if (!r) return void (await editMessage(chatId, messageId, t(lang, 'edit.locked')));
  await editMessage(
    chatId,
    messageId,
    t(lang, 'edit.card', {
      label: displayLabel(r.label, r.is_whole, lang),
      qty: r.quantity,
      rate: money(Number(r.rate), lang),
      total: money(Number(r.total), lang),
    }),
    [
      [{ text: t(lang, 'edit.btnQty'), callback_data: `eq:${r.id}` }, { text: t(lang, 'edit.btnDel'), callback_data: `ed:${r.id}` }],
      [{ text: t(lang, 'btn.back'), callback_data: 'fix' }],
    ]
  );
}

async function onEditQtyStart(sb: SupabaseClient, tg: number, chatId: number, messageId: number, lang: Lang, id: string) {
  const r = await findEditable(sb, tg, id);
  if (!r) return void (await editMessage(chatId, messageId, t(lang, 'edit.locked')));
  const label = displayLabel(r.label, r.is_whole, lang);
  await setState(sb, tg, 'edit_qty', { id: r.id, label, qty: r.quantity });
  await editMessage(chatId, messageId, t(lang, 'edit.askQty', { label, qty: r.quantity }), [cancelRow(lang)]);
}

async function onEditQuantity(sb: SupabaseClient, tg: number, chatId: number, lang: Lang, data: Record<string, unknown>, text: string) {
  const qty = QTY_PATTERN.test(text) ? Number(text) : 0;
  if (qty < 1 || qty > 99999) return void (await sendMessage(chatId, t(lang, 'add.badQty')));
  try {
    const res = await rpc<{ label: string; quantity: number; rate: number; total: number }>(sb, 'bot_change_qty', {
      p_tg: tg,
      p_record_id: String(data.id),
      p_qty: qty,
    });
    await clearState(sb, tg);
    await sendMessage(
      chatId,
      t(lang, 'edit.updated', {
        label: String(data.label),
        qty: res.quantity,
        rate: money(Number(res.rate), lang),
        total: money(Number(res.total), lang),
      }),
      inline([[{ text: t(lang, 'add.fix'), callback_data: 'fix' }]])
    );
  } catch (err) {
    if (isDbError(err, 'not_editable')) {
      await clearState(sb, tg);
      return void (await sendMessage(chatId, t(lang, 'edit.locked')));
    }
    throw err;
  }
}

async function onDeleteAsk(sb: SupabaseClient, tg: number, chatId: number, messageId: number, lang: Lang, id: string) {
  const r = await findEditable(sb, tg, id);
  if (!r) return void (await editMessage(chatId, messageId, t(lang, 'edit.locked')));
  await editMessage(chatId, messageId, t(lang, 'edit.confirmDel', { label: displayLabel(r.label, r.is_whole, lang), qty: r.quantity }), [
    [{ text: t(lang, 'edit.yesDel'), callback_data: `edy:${r.id}` }, { text: t(lang, 'edit.no'), callback_data: `e:${r.id}` }],
  ]);
}

async function onDeleteDo(sb: SupabaseClient, tg: number, chatId: number, messageId: number, lang: Lang, id: string) {
  try {
    await rpc<null>(sb, 'bot_delete_record', { p_tg: tg, p_record_id: id });
    await editMessage(chatId, messageId, t(lang, 'edit.deleted'), [[{ text: t(lang, 'add.fix'), callback_data: 'fix' }]]);
  } catch (err) {
    if (isDbError(err, 'not_editable')) return void (await editMessage(chatId, messageId, t(lang, 'edit.locked')));
    throw err;
  }
}

// ====================================================================
// Кнопки
// ====================================================================
async function handleCallback(sb: SupabaseClient, cb: TelegramCallbackQuery) {
  const tg = cb.from.id;
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  const data = cb.data ?? '';
  if (!chatId || !messageId) {
    await answerCallback(cb.id);
    return;
  }

  try {
    const staff = await getStaff(sb, tg);
    if (staff) {
      await handleStaffCallback(sb, cb, staff, chatId, messageId, data);
      return;
    }

    // Язык выбирают и до приёма заявки.
    if (data === 'lang:ru' || data === 'lang:uz') {
      await answerCallback(cb.id);
      return await onLangPick(sb, tg, chatId, messageId, data.slice(5) as Lang);
    }

    const w = await getWorker(sb, tg);
    const lang: Lang = w?.language ?? 'ru';
    if (!w || w.status !== 'active' || !w.can_add) {
      await answerCallback(cb.id);
      return void (await sendMessage(chatId, w ? t(lang, 'w.notActive') : both('w.noLink')));
    }
    await answerCallback(cb.id);

    if (data === 'k:o' || data === 'k:w') return await onKind(sb, tg, chatId, messageId, lang, data === 'k:o' ? 'o' : 'w');
    const modelId = idOf(data, 'm');
    if (modelId) return await onModel(sb, tg, chatId, messageId, lang, modelId);
    const opId = idOf(data, 'o');
    if (opId) return await onOperation(sb, tg, chatId, messageId, lang, opId);
    if (data === 'ok') return await onConfirm(sb, tg, chatId, messageId, lang);
    if (data === 'no') {
      await clearState(sb, tg);
      return void (await editMessage(chatId, messageId, t(lang, 'add.cancelled')));
    }
    if (data === 'more') {
      await clearState(sb, tg);
      return await startAdd(sb, tg, chatId, lang);
    }
    if (data === 's:d' || data === 's:w' || data === 's:m') return await onStats(sb, tg, chatId, messageId, lang, data.slice(2) as Period);
    if (data === 'fix') {
      await clearState(sb, tg);
      return await onFixList(sb, tg, chatId, messageId, lang);
    }
    const eId = idOf(data, 'e');
    if (eId) return await onRecordCard(sb, tg, chatId, messageId, lang, eId);
    const eqId = idOf(data, 'eq');
    if (eqId) return await onEditQtyStart(sb, tg, chatId, messageId, lang, eqId);
    const edId = idOf(data, 'ed');
    if (edId) return await onDeleteAsk(sb, tg, chatId, messageId, lang, edId);
    const edyId = idOf(data, 'edy');
    if (edyId) return await onDeleteDo(sb, tg, chatId, messageId, lang, edyId);
    await sendMessage(chatId, t(lang, 'err.stale'));
  } catch (err) {
    console.error('worker bot callback error', err);
    await sendMessage(chatId, both('err.generic'));
  }
}

async function onLangPick(sb: SupabaseClient, tg: number, chatId: number, messageId: number, lang: Lang) {
  const w = await getWorker(sb, tg);
  if (!w) return void (await sendMessage(chatId, both('w.noLink')));
  await rpc<null>(sb, 'bot_worker_set_language', { p_tg: tg, p_lang: lang });
  await editMessage(chatId, messageId, t(lang, 'lang.changed'));
  if (w.status === 'registering') return void (await sendMessage(chatId, t(lang, 'w.askName')));
  if (w.status === 'active' && w.can_add) return void (await sendMessage(chatId, t(lang, 'menu.title'), mainMenu(lang)));
}

// ====================================================================
// Мастер / директор: заявки
// ====================================================================
export async function notifyRecipients(recipients: Recipient[], user: WorkerInfo) {
  for (const r of recipients) {
    const lang: Lang = isLang(r.language) ? r.language : 'ru';
    await sendMessage(
      r.chat_id,
      t(lang, 's.request', {
        name: user.full_name ?? '',
        shop: t(lang, `shop.${user.shop}`),
        profession: user.profession_name ?? t(lang, 's.noProfession'),
      }),
      inline([[{ text: t(lang, 's.approve'), callback_data: `ap:${user.id}` }, { text: t(lang, 's.reject'), callback_data: `rj:${user.id}` }]])
    );
  }
}

interface RequestInfo {
  user: WorkerInfo;
  employees: { id: string; name: string; profession_name: string | null }[];
}

function decisionError(lang: Lang, err: unknown): MessageKey | null {
  if (isDbError(err, 'already_decided')) return 's.alreadyDecided';
  if (isDbError(err, 'not_your_shop')) return 's.notYourShop';
  if (isDbError(err, 'employee_name_taken')) return 's.nameTaken';
  if (isDbError(err, 'employee_taken')) return 's.employeeTaken';
  if (isDbError(err, 'worker_not_found')) return 's.stale';
  void lang;
  return null;
}

async function handleStaffCallback(sb: SupabaseClient, cb: TelegramCallbackQuery, staff: StaffInfo, chatId: number, messageId: number, data: string) {
  const tg = cb.from.id;
  const lang = staff.language;

  if (data === 'slang:ru' || data === 'slang:uz') {
    const picked = data.slice(6) as Lang;
    await answerCallback(cb.id);
    await rpc<null>(sb, 'bot_staff_set_language', { p_tg: tg, p_lang: picked });
    await editMessage(chatId, messageId, t(picked, 'lang.changed'));
    await sendMessage(chatId, t(picked, 'sm.hello', { role: t(picked, `role.${staff.role}`) }));
    await showStaffMenu(sb, tg, chatId, { ...staff, language: picked });
    return;
  }

  const apId = idOf(data, 'ap');
  if (apId) {
    try {
      const req = await rpc<RequestInfo>(sb, 'bot_staff_request', { p_staff_tg: tg, p_user_id: apId });
      if (req.user.status !== 'pending') {
        await answerCallback(cb.id);
        return void (await editMessage(chatId, messageId, t(lang, 's.alreadyDecided')));
      }
      await setState(sb, tg, 'pick', { userId: apId, employees: req.employees.slice(0, 80).map((e) => e.id), names: req.employees.slice(0, 80).map((e) => e.name) });
      await answerCallback(cb.id);
      await editMessage(
        chatId,
        messageId,
        t(lang, 's.pickEmployee', { shop: t(lang, `shop.${req.user.shop}`), name: req.user.full_name ?? '' }),
        [
          [{ text: t(lang, 's.newEmployee', { name: req.user.full_name ?? '' }).replace(/<[^>]*>/g, ''), callback_data: 'an' }],
          ...req.employees.slice(0, 80).map((e, i) => [
            { text: e.profession_name ? `${e.name} · ${e.profession_name}` : e.name, callback_data: `ae:${i}` },
          ]),
        ]
      );
    } catch (err) {
      const key = decisionError(lang, err);
      if (!key) throw err;
      await answerCallback(cb.id, t(lang, key).replace(/<[^>]*>/g, ''));
    }
    return;
  }

  if (data === 'an' || /^ae:\d{1,3}$/.test(data)) {
    const st = await getState(sb, tg);
    const userId = st?.state === 'pick' ? String(st.data.userId) : null;
    const ids = (st?.data.employees as string[] | undefined) ?? [];
    const names = (st?.data.names as string[] | undefined) ?? [];
    const idx = data === 'an' ? -1 : Number(data.slice(3));
    if (!userId || (idx >= 0 && !ids[idx])) {
      await answerCallback(cb.id);
      return void (await editMessage(chatId, messageId, t(lang, 's.stale')));
    }
    try {
      const w = await rpc<WorkerInfo>(sb, 'bot_decide_worker', {
        p_staff_tg: tg,
        p_user_id: userId,
        p_action: 'approve',
        p_employee_id: idx >= 0 ? ids[idx] : null,
        p_new_name: null,
      });
      await clearState(sb, tg);
      await answerCallback(cb.id);
      await editMessage(chatId, messageId, t(lang, 's.approved', { name: w.full_name ?? '', employee: idx >= 0 ? names[idx] : (w.full_name ?? '') }));
      await notifyWorkerDecision('approve', w);
    } catch (err) {
      const key = decisionError(lang, err);
      if (!key) throw err;
      await answerCallback(cb.id, t(lang, key).replace(/<[^>]*>/g, ''));
      if (key === 's.alreadyDecided') await editMessage(chatId, messageId, t(lang, key));
    }
    return;
  }

  const rjId = idOf(data, 'rj');
  if (rjId) {
    try {
      const w = await rpc<WorkerInfo>(sb, 'bot_decide_worker', { p_staff_tg: tg, p_user_id: rjId, p_action: 'reject', p_employee_id: null, p_new_name: null });
      await answerCallback(cb.id);
      await editMessage(chatId, messageId, t(lang, 's.rejected', { name: w.full_name ?? '' }));
      await notifyWorkerDecision('reject', w);
    } catch (err) {
      const key = decisionError(lang, err);
      if (!key) throw err;
      await answerCallback(cb.id, t(lang, key).replace(/<[^>]*>/g, ''));
      if (key === 's.alreadyDecided') await editMessage(chatId, messageId, t(lang, key));
    }
    return;
  }

  if (await onStaffCallback(sb, cb.id, staff, tg, chatId, messageId, data)) return;
  await answerCallback(cb.id);
}
