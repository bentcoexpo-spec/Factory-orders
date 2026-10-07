import type { SupabaseClient } from '@supabase/supabase-js';
import { answerCallback, editMessage, inline, replyKeyboard, sendMessage, type InlineButton } from './api';
import { clearState, getState, isDbError, rpc, setState, type StaffInfo } from './db';
import { type Lang, type MessageKey, money, t } from './i18n';
import { parseCatalogList, type ParseResult } from './catalogParse';
import { notifyWorkerDecision, notifyWorkerRecord, type NotifyTarget, type RecordChange } from './notify';
import { fmtDate, displayLabel } from './stats';

// Мастер и CEO в боте: ✅ Подтверждение, 👷 Работники, 📦 Изделия.
// 📊 Отчёты и ⚙️ Настройки — в следующей части (3б).
// Все действия идут через bot_as_staff → функции staff_* (046): они сами
// проверяют роль, цех и принадлежность записи.

interface Ctx {
  sb: SupabaseClient;
  tg: number;
  chatId: number;
  staff: StaffInfo;
  lang: Lang;
  mid?: number; // сообщение, которое редактируем (для кнопок)
}

const BTN = (text: string, data: string): InlineButton => ({ text, callback_data: data });
const CANCEL = (lang: Lang): InlineButton[] => [BTN(t(lang, 'btn.cancel'), 'x')];

async function sdo<T>(c: Pick<Ctx, 'sb' | 'tg'>, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  return rpc<T>(c.sb, 'bot_as_staff', { p_tg: c.tg, p_fn: fn, p_args: args });
}

// Показать экран: редактируем сообщение с кнопкой, если оно есть, иначе шлём новое.
async function out(c: Ctx, text: string, rows: InlineButton[][] = []) {
  if (c.mid) await editMessage(c.chatId, c.mid, text, rows);
  else await sendMessage(c.chatId, text, inline(rows));
}

// Ответ новым сообщением (после текстового ввода или итог действия).
async function say(c: Ctx, text: string, rows?: InlineButton[][]) {
  await sendMessage(c.chatId, text, rows ? inline(rows) : undefined);
}

function shopLabel(c: Ctx): string {
  return c.staff.shop ? t(c.lang, `shop.${c.staff.shop}`) : '—';
}

function errKey(err: unknown): MessageKey | null {
  if (isDbError(err, 'not_your_shop')) return 's.notYourShop';
  if (isDbError(err, 'shop_not_selected')) return 'sm.noShop';
  if (isDbError(err, 'duplicate_name')) return 'k.duplicate';
  if (isDbError(err, 'invalid_rate')) return 'k.badRate';
  if (isDbError(err, 'invalid_name')) return 'k.badName';
  if (isDbError(err, 'employee_name_taken')) return 'u.nameTaken';
  if (isDbError(err, 'already_decided')) return 'c.alreadyDecided';
  if (isDbError(err, 'record_not_found')) return 'c.notFound';
  if (isDbError(err, 'catalog_item_not_found')) return 'k.notFound';
  if (isDbError(err, 'employee_not_found')) return 'k.notFound';
  if (isDbError(err, 'not_editable')) return 'edit.locked';
  if (isDbError(err, 'invalid_quantity')) return 'add.badQty';
  if (isDbError(err, 'invalid_reason')) return 'c.badReason';
  if (isDbError(err, 'insufficient_privilege')) return 'e.denied';
  return null;
}

// true — ошибка показана пользователю; false — неизвестная (пусть обработает верхний уровень).
async function showError(c: Ctx, err: unknown): Promise<boolean> {
  const key = errKey(err);
  if (!key) return false;
  await say(c, t(c.lang, key));
  return true;
}

// ====================================================================
// Главное меню
// ====================================================================
async function pendingCount(c: Pick<Ctx, 'sb' | 'tg' | 'staff'>): Promise<number> {
  if (!c.staff.shop) return 0;
  try {
    const p = await sdo<{ count: number }>(c, 'staff_pending', {});
    return Number(p.count) || 0;
  } catch {
    return 0;
  }
}

export async function staffKeyboard(c: Pick<Ctx, 'sb' | 'tg' | 'staff' | 'lang'>) {
  const n = await pendingCount(c);
  const confirm = n > 0 ? `${t(c.lang, 'sm.confirm')} (${n})` : t(c.lang, 'sm.confirm');
  return replyKeyboard([
    [t(c.lang, 'sm.catalog'), t(c.lang, 'sm.workers')],
    [t(c.lang, 'sm.reports'), t(c.lang, 'sm.settings')],
    [confirm],
  ]);
}

export async function showStaffMenu(sb: SupabaseClient, tg: number, chatId: number, staff: StaffInfo) {
  const c: Ctx = { sb, tg, chatId, staff, lang: staff.language };
  const shop = c.staff.shop ? t(c.lang, `shop.${c.staff.shop}`) : '—';
  await sendMessage(chatId, t(c.lang, 'sm.title', { shop }), await staffKeyboard(c));
  if (staff.role === 'ceo') {
    await sendMessage(
      chatId,
      t(c.lang, 'e.shopChanged', { shop }),
      inline([
        [
          BTN(`${staff.shop === 'factory' ? '✅ ' : ''}${t(c.lang, 'shop.factory')}`, 'sh:factory'),
          BTN(`${staff.shop === 'workshop' ? '✅ ' : ''}${t(c.lang, 'shop.workshop')}`, 'sh:workshop'),
        ],
      ])
    );
  }
  if (!staff.shop) await sendMessage(chatId, t(c.lang, 'sm.noShop'));
}

// Текст кнопки меню → раздел (на любом из двух языков).
function menuAction(text: string): 'catalog' | 'workers' | 'reports' | 'settings' | 'confirm' | null {
  const keys = ['catalog', 'workers', 'reports', 'settings', 'confirm'] as const;
  for (const k of keys) {
    for (const l of ['ru', 'uz'] as const) {
      const label = t(l, `sm.${k}`);
      if (text === label || (k === 'confirm' && text.startsWith(`${label} (`))) return k;
    }
  }
  return null;
}

// ====================================================================
// Текст мастера/CEO
// ====================================================================
export async function onStaffText(sb: SupabaseClient, staff: StaffInfo, tg: number, chatId: number, text: string) {
  const c: Ctx = { sb, tg, chatId, staff, lang: staff.language };
  const action = menuAction(text);
  if (action) {
    await clearState(sb, tg);
    if (action === 'reports' || action === 'settings') return void (await say(c, t(c.lang, 'sm.soon')));
    if (!staff.shop) return void (await say(c, t(c.lang, 'sm.noShop')));
    try {
      if (action === 'confirm') return await showConfirm(c);
      if (action === 'workers') return await showWorkers(c);
      return await showCatalog(c);
    } catch (err) {
      if (await showError(c, err)) return;
      throw err;
    }
  }

  const st = await getState(sb, tg);
  if (!st) return void (await showStaffMenu(sb, tg, chatId, staff));
  try {
    await onStaffInput(c, st.state, st.data, text);
  } catch (err) {
    if (await showError(c, err)) return;
    throw err;
  }
}

async function onStaffInput(c: Ctx, state: string, d: Record<string, unknown>, text: string) {
  const s = (k: string) => String(d[k] ?? '');
  switch (state) {
    case 'adj':
      return adjustDo(c, s('id'), s('date'), text);
    case 'rej':
      return rejectDo(c, s('id'), s('date'), text);
    case 'u_name':
      return renameDo(c, s('employeeId'), text);
    case 'u_rec_qty':
      return recordQtyDo(c, s('id'), s('employeeId'), text);
    case 'k_model_name':
      return modelAddDo(c, s('profId'), text);
    case 'k_op_add':
      return opAddDo(c, s('modelId'), text);
    case 'k_op_rate':
      return opAddRateDo(c, s('modelId'), s('name'), text);
    case 'k_rate':
      return opRateDo(c, s('id'), s('modelId'), text);
    case 'k_whole':
      return wholeDo(c, s('id'), text);
    case 'k_rename_model':
      return renameModelDo(c, s('id'), text);
    case 'k_rename_op':
      return renameOpDo(c, s('id'), s('modelId'), text);
    case 'k_list':
      return listPreview(c, s('profId'), s('modelId') || null, text);
    default:
      return showStaffMenu(c.sb, c.tg, c.chatId, c.staff);
  }
}

// ====================================================================
// Кнопки мастера/CEO (то, что не относится к заявкам на вход)
// ====================================================================
export async function onStaffCallback(
  sb: SupabaseClient,
  cbId: string,
  staff: StaffInfo,
  tg: number,
  chatId: number,
  messageId: number,
  data: string
): Promise<boolean> {
  const c: Ctx = { sb, tg, chatId, staff, lang: staff.language, mid: messageId };
  const [cmd, ...rest] = data.split(':');
  const a = rest[0];
  const b = rest[1];

  const known = [
    'x', 'sh', 'cb', 'cd', 'ca', 'cw', 'cv', 'cr', 'cc', 'cq', 'cx',
    'ul', 'uc', 'un', 'us', 'ur', 'uq', 'ud', 'udy', 'up', 'upi', 'ux', 'uxy', 'ua', 'ui', 'uin',
    'kp', 'km', 'ko', 'ka', 'kb', 'kbm', 'kbs', 'kao', 'kw', 'kr', 'kd', 'kdy', 'kor', 'kop', 'kod', 'kody', 'k0',
  ];
  if (!known.includes(cmd)) return false;
  await answerCallback(cbId);

  try {
    if (cmd !== 'sh' && cmd !== 'x' && !staff.shop && ['cb', 'cd', 'ca', 'cw', 'cv', 'cr', 'cc', 'ul', 'ua', 'ui', 'uin'].includes(cmd)) {
      return void (await say(c, t(c.lang, 'sm.noShop'))), true;
    }
    switch (cmd) {
      case 'x':
        await clearState(sb, tg);
        await editMessage(chatId, messageId, t(c.lang, 'e.cancelled'));
        return true;
      case 'sh': {
        if (staff.role !== 'ceo' || (a !== 'factory' && a !== 'workshop')) return true;
        await rpc<null>(sb, 'bot_staff_set_shop', { p_tg: tg, p_shop: a });
        c.staff = { ...staff, shop: a };
        await editMessage(chatId, messageId, t(c.lang, 'e.shopChanged', { shop: t(c.lang, `shop.${a}`) }), [
          [
            BTN(`${a === 'factory' ? '✅ ' : ''}${t(c.lang, 'shop.factory')}`, 'sh:factory'),
            BTN(`${a === 'workshop' ? '✅ ' : ''}${t(c.lang, 'shop.workshop')}`, 'sh:workshop'),
          ],
        ]);
        await sendMessage(chatId, t(c.lang, 'sm.title', { shop: t(c.lang, `shop.${a}`) }), await staffKeyboard({ ...c, staff: c.staff }));
        return true;
      }
      // --- ✅ Подтверждение
      case 'cb': await showConfirm(c); return true;
      case 'cd': await showDay(c, a); return true;
      case 'ca': await confirmDo(c, { date: a }, a); return true;
      case 'cw': await confirmDo(c, { employee_id: a, date: b }, b); return true;
      case 'cv': await showWorkerDay(c, a, b); return true;
      case 'cr': await showRecord(c, a, b); return true;
      case 'cc': await confirmDo(c, { ids: [a] }, b); return true;
      case 'cq': await adjustAsk(c, a, b); return true;
      case 'cx': await rejectAsk(c, a, b); return true;
      // --- 👷 Работники
      case 'ul': await (a === 'back' ? showWorkers(c) : showWorkerList(c, a)); return true;
      case 'uc': await showWorkerCard(c, a); return true;
      case 'un': await renameAsk(c, a); return true;
      case 'us': await showWorkerRecords(c, a); return true;
      case 'ur': await showWorkerRecord(c, a); return true;
      case 'uq': await recordQtyAsk(c, a); return true;
      case 'ud': await recordDeleteAsk(c, a); return true;
      case 'udy': await recordDeleteDo(c, a); return true;
      case 'up': await professionPick(c, a); return true;
      case 'upi': await professionSet(c, a); return true;
      case 'ux': await removeAsk(c, a); return true;
      case 'uxy': await removeDo(c, a); return true;
      case 'ua': await invitePick(c); return true;
      case 'ui': await inviteShow(c, a, false); return true;
      case 'uin': await inviteShow(c, a, true); return true;
      // --- 📦 Изделия
      case 'k0': await showCatalog(c); return true;
      case 'kp': await showProfession(c, a); return true;
      case 'km': await showModel(c, a); return true;
      case 'ko': await showOperation(c, a); return true;
      case 'ka': await modelAddAsk(c, a); return true;
      case 'kb': await listAsk(c, a, null); return true;
      case 'kbm': await listAskInModel(c, a); return true;
      case 'kbs': await listApply(c); return true;
      case 'kao': await opAddAsk(c, a); return true;
      case 'kw': await wholeAsk(c, a); return true;
      case 'kr': await renameModelAsk(c, a); return true;
      case 'kd': await modelDeleteAsk(c, a); return true;
      case 'kdy': await modelDeleteDo(c, a); return true;
      case 'kor': await renameOpAsk(c, a); return true;
      case 'kop': await opRateAsk(c, a); return true;
      case 'kod': await opDeleteAsk(c, a); return true;
      case 'kody': await opDeleteDo(c, a); return true;
      default:
        return true;
    }
  } catch (err) {
    if (await showError(c, err)) return true;
    throw err;
  }
}

// ====================================================================
// ✅ Подтверждение
// ====================================================================
interface PendingRec {
  id: string;
  employee_id: string;
  employee_name: string;
  label: string;
  is_whole: boolean;
  quantity: number;
  rate: number;
  total: number;
  date: string;
}
interface Pending {
  shop: string;
  count: number;
  days: { date: string; count: number }[];
  records: PendingRec[];
}

async function showConfirm(c: Ctx) {
  const p = await sdo<Pending>(c, 'staff_pending', {});
  if (p.count === 0) return out(c, t(c.lang, 'c.none'));
  await out(
    c,
    t(c.lang, 'c.pickDay', { shop: shopLabel(c), count: p.count }),
    p.days.map((d) => [BTN(t(c.lang, 'c.dayBtn', { date: fmtDate(String(d.date)), count: d.count }), `cd:${String(d.date).slice(0, 10)}`)])
  );
}

function recLine(c: Ctx, r: PendingRec): string {
  return t(c.lang, 'c.line', { label: displayLabel(r.label, r.is_whole, c.lang), qty: r.quantity, sum: money(Number(r.total), c.lang) });
}

async function showDay(c: Ctx, date: string) {
  const p = await sdo<Pending>(c, 'staff_pending', { date });
  if (p.records.length === 0) return showConfirm(c);

  const byWorker = new Map<string, { name: string; recs: PendingRec[] }>();
  for (const r of p.records) {
    const g = byWorker.get(r.employee_id) ?? { name: r.employee_name, recs: [] };
    g.recs.push(r);
    byWorker.set(r.employee_id, g);
  }
  const sumOf = (list: PendingRec[]) => list.reduce((s, r) => s + Number(r.total), 0);

  const build = (compact: boolean) => {
    const lines: string[] = [t(c.lang, 'c.dayTitle', { date: fmtDate(date), shop: shopLabel(c) }), ''];
    for (const g of byWorker.values()) {
      lines.push(t(c.lang, 'c.worker', { name: g.name, sum: money(sumOf(g.recs), c.lang) }));
      if (!compact) g.recs.forEach((r) => lines.push(recLine(c, r)));
      lines.push('');
    }
    lines.push(t(c.lang, 'c.total', { sum: money(sumOf(p.records), c.lang), n: p.records.length }));
    return lines.join('\n');
  };
  let text = build(false);
  if (text.length > 3600) text = build(true);

  const rows: InlineButton[][] = [[BTN(t(c.lang, 'c.confirmAll', { n: p.records.length }), `ca:${date}`)]];
  for (const [empId, g] of Array.from(byWorker.entries()).slice(0, 25)) {
    rows.push([
      BTN(t(c.lang, 'c.confirmWorker', { name: g.name }), `cw:${empId}:${date}`),
      BTN(t(c.lang, 'c.openWorker', { name: g.name, n: g.recs.length }), `cv:${empId}:${date}`),
    ]);
  }
  rows.push([BTN(t(c.lang, 'btn.back'), 'cb')]);
  await out(c, text, rows);
}

async function showWorkerDay(c: Ctx, empId: string, date: string) {
  const p = await sdo<Pending>(c, 'staff_pending', { date });
  const recs = p.records.filter((r) => r.employee_id === empId);
  if (recs.length === 0) return showDay(c, date);
  const name = recs[0].employee_name;
  const text = [
    t(c.lang, 'c.workerTitle', { name, date: fmtDate(date) }),
    '',
    ...recs.map((r) => recLine(c, r)),
    '',
    t(c.lang, 'c.total', { sum: money(recs.reduce((s, r) => s + Number(r.total), 0), c.lang), n: recs.length }),
  ].join('\n');
  const rows: InlineButton[][] = [[BTN(t(c.lang, 'c.confirmAll', { n: recs.length }), `cw:${empId}:${date}`)]];
  for (const r of recs.slice(0, 40)) {
    rows.push([BTN(`${displayLabel(r.label, r.is_whole, c.lang)} — ${r.quantity}`, `cr:${r.id}:${date}`)]);
  }
  rows.push([BTN(t(c.lang, 'btn.back'), `cd:${date}`)]);
  await out(c, text, rows);
}

async function showRecord(c: Ctx, id: string, date: string) {
  const p = await sdo<Pending>(c, 'staff_pending', { date });
  const r = p.records.find((x) => x.id === id);
  if (!r) return showDay(c, date);
  await out(
    c,
    t(c.lang, 'c.record', {
      label: displayLabel(r.label, r.is_whole, c.lang),
      name: r.employee_name,
      qty: r.quantity,
      rate: money(Number(r.rate), c.lang),
      sum: money(Number(r.total), c.lang),
      date: fmtDate(date),
    }),
    [
      [BTN(t(c.lang, 'c.btnConfirm'), `cc:${r.id}:${date}`)],
      [BTN(t(c.lang, 'c.btnQty'), `cq:${r.id}:${date}`), BTN(t(c.lang, 'c.btnReject'), `cx:${r.id}:${date}`)],
      [BTN(t(c.lang, 'btn.back'), `cv:${r.employee_id}:${date}`)],
    ]
  );
}

async function confirmDo(c: Ctx, args: Record<string, unknown>, date: string) {
  const res = await sdo<{ confirmed: number; total: number }>(c, 'staff_confirm', args);
  await sendMessage(
    c.chatId,
    t(c.lang, 'c.done', { n: res.confirmed, sum: money(Number(res.total), c.lang) }),
    await staffKeyboard(c)
  );
  await showDay(c, date);
}

async function adjustAsk(c: Ctx, id: string, date: string) {
  const p = await sdo<Pending>(c, 'staff_pending', { date });
  const r = p.records.find((x) => x.id === id);
  if (!r) return showDay(c, date);
  await setState(c.sb, c.tg, 'adj', { id, date });
  await out(
    c,
    t(c.lang, 'c.askQty', { label: displayLabel(r.label, r.is_whole, c.lang), qty: r.quantity }),
    [CANCEL(c.lang)]
  );
}

async function adjustDo(c: Ctx, id: string, date: string, text: string) {
  const qty = /^\d{1,5}$/.test(text.trim()) ? Number(text.trim()) : 0;
  if (qty < 1 || qty > 99999) return void (await say(c, t(c.lang, 'add.badQty')));
  const res = await sdo<{ label: string; is_whole: boolean; old_quantity: number; quantity: number; notify: NotifyTarget | null } & RecordChange>(c, 'staff_adjust', { id, quantity: qty });
  await clearState(c.sb, c.tg);
  await sendMessage(
    c.chatId,
    t(c.lang, 'c.adjusted', { label: displayLabel(res.label, res.is_whole, c.lang), old: res.old_quantity, qty: res.quantity }),
    await staffKeyboard(c)
  );
  await notifyWorkerRecord('adjusted', res.notify, res);
  await showDay({ ...c, mid: undefined }, date);
}

async function rejectAsk(c: Ctx, id: string, date: string) {
  await setState(c.sb, c.tg, 'rej', { id, date });
  await out(c, t(c.lang, 'c.askReason'), [CANCEL(c.lang)]);
}

async function rejectDo(c: Ctx, id: string, date: string, text: string) {
  const reason = text.trim();
  if (reason.length < 1 || reason.length > 200) return void (await say(c, t(c.lang, 'c.badReason')));
  const res = await sdo<{ label: string; is_whole: boolean; quantity: number; notify: NotifyTarget | null } & RecordChange>(c, 'staff_reject', { id, reason });
  await clearState(c.sb, c.tg);
  await sendMessage(
    c.chatId,
    t(c.lang, 'c.rejected', { label: displayLabel(res.label, res.is_whole, c.lang), qty: res.quantity }),
    await staffKeyboard(c)
  );
  await notifyWorkerRecord('rejected', res.notify, res);
  await showDay({ ...c, mid: undefined }, date);
}

// ====================================================================
// 👷 Работники
// ====================================================================
interface WorkersInfo {
  total: number;
  none: number;
  professions: { id: string; name: string; count: number }[];
}
interface WorkerItem {
  id: string;
  name: string;
  profession_id: string | null;
  profession_name: string | null;
  in_bot: boolean;
  month_total: number;
}
interface WorkerCard {
  id: string;
  name: string;
  profession_id: string | null;
  profession_name: string | null;
  in_bot: boolean;
  month_total: number;
  month_pending: number;
  month_qty: number;
}
interface RecItem {
  id: string;
  date: string;
  label: string;
  is_whole: boolean;
  quantity: number;
  rate: number;
  total: number;
  status: 'pending' | 'confirmed' | 'rejected';
  reject_reason: string | null;
}

async function showWorkers(c: Ctx) {
  const w = await sdo<WorkersInfo>(c, 'staff_workers', {});
  const rows: InlineButton[][] = [[BTN(t(c.lang, 'u.all', { n: w.total }), 'ul:all')]];
  for (const p of w.professions) rows.push([BTN(t(c.lang, 'u.prof', { name: p.name, n: p.count }), `ul:${p.id}`)]);
  rows.push([BTN(t(c.lang, 'u.none', { n: w.none }), 'ul:none')]);
  rows.push([BTN(t(c.lang, 'u.add'), 'ua')]);
  await out(c, t(c.lang, 'u.title', { shop: shopLabel(c) }), rows);
}

async function showWorkerList(c: Ctx, filter: string) {
  const list = await sdo<WorkerItem[]>(c, 'staff_workers_list', { profession_id: filter });
  let title = t(c.lang, 'u.all', { n: list.length });
  if (filter === 'none') title = t(c.lang, 'u.none', { n: list.length });
  else if (filter !== 'all') {
    const w = await sdo<WorkersInfo>(c, 'staff_workers', {});
    title = t(c.lang, 'u.prof', { name: w.professions.find((p) => p.id === filter)?.name ?? '', n: list.length });
  }
  const text = t(c.lang, 'u.listTitle', { title: title.replace(/^[^\p{L}⚠]+/u, ''), shop: shopLabel(c) });
  const rows: InlineButton[][] = list
    .slice(0, 60)
    .map((e) => [BTN(`${t(c.lang, 'u.itemBtn', { name: e.name, sum: money(Number(e.month_total), c.lang) })}${e.in_bot ? ' 🔗' : ''}`, `uc:${e.id}`)]);
  if (list.length === 0) rows.push([]);
  rows.push([BTN(t(c.lang, 'btn.back'), 'ul:back')]);
  await out(c, list.length === 0 ? `${text}\n${t(c.lang, 'u.listEmpty')}` : text, rows.filter((r) => r.length > 0));
}

async function showWorkerCard(c: Ctx, id: string) {
  const w = await sdo<WorkerCard>(c, 'staff_worker_card', { employee_id: id });
  const lines = [
    t(c.lang, 'u.card', {
      name: w.name,
      profession: w.profession_name ?? t(c.lang, 'u.professionNone'),
      sum: money(Number(w.month_total), c.lang),
      pending: money(Number(w.month_pending), c.lang),
      qty: Number(w.month_qty),
      bot: w.in_bot ? t(c.lang, 'u.inBotYes') : t(c.lang, 'u.inBotNo'),
    }),
  ];
  if (!w.profession_id) lines.push('', t(c.lang, 'u.noProfWarn'));
  const rows: InlineButton[][] = [
    [BTN(t(c.lang, 'u.btnName'), `un:${id}`), BTN(t(c.lang, 'u.btnRecords'), `us:${id}`)],
    [BTN(t(c.lang, 'u.btnProf'), `up:${id}`)],
  ];
  if (w.in_bot) rows.push([BTN(t(c.lang, 'u.btnRemove'), `ux:${id}`)]);
  rows.push([BTN(t(c.lang, 'btn.back'), w.profession_id ? `ul:${w.profession_id}` : 'ul:none')]);
  await out(c, lines.join('\n'), rows);
}

async function renameAsk(c: Ctx, id: string) {
  const w = await sdo<WorkerCard>(c, 'staff_worker_card', { employee_id: id });
  await setState(c.sb, c.tg, 'u_name', { employeeId: id });
  await out(c, t(c.lang, 'u.askName', { name: w.name }), [CANCEL(c.lang)]);
}

async function renameDo(c: Ctx, id: string, text: string) {
  const name = text.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 60) return void (await say(c, t(c.lang, 'u.badName')));
  await sdo(c, 'staff_rename_employee', { employee_id: id, name });
  await clearState(c.sb, c.tg);
  await say(c, t(c.lang, 'u.renamed', { name }));
  await showWorkerCard({ ...c, mid: undefined }, id);
}

async function professionPick(c: Ctx, id: string) {
  const [w, card] = await Promise.all([sdo<WorkersInfo>(c, 'staff_workers', {}), sdo<WorkerCard>(c, 'staff_worker_card', { employee_id: id })]);
  await setState(c.sb, c.tg, 'u_prof', { employeeId: id, profs: w.professions.map((p) => p.id) });
  const rows = w.professions.map((p, i) => [BTN(`${p.id === card.profession_id ? '✅ ' : ''}${p.name}`, `upi:${i}`)]);
  rows.push([BTN(t(c.lang, 'u.noneBtn'), 'upi:n')]);
  rows.push([BTN(t(c.lang, 'btn.back'), `uc:${id}`)]);
  await out(c, t(c.lang, 'u.pickProf', { name: card.name }), rows);
}

async function professionSet(c: Ctx, idx: string) {
  const st = await getState(c.sb, c.tg);
  if (st?.state !== 'u_prof') return void (await say(c, t(c.lang, 'err.stale')));
  const empId = String(st.data.employeeId);
  const profs = (st.data.profs as string[]) ?? [];
  const profId = idx === 'n' ? null : (profs[Number(idx)] ?? undefined);
  if (profId === undefined) return void (await say(c, t(c.lang, 'err.stale')));
  const res = await sdo<{ profession_name: string | null }>(c, 'staff_set_profession', { employee_id: empId, profession_id: profId });
  await clearState(c.sb, c.tg);
  await say(c, t(c.lang, 'u.profSet', { profession: res.profession_name ?? t(c.lang, 'u.professionNone') }));
  await showWorkerCard({ ...c, mid: undefined }, empId);
}

async function removeAsk(c: Ctx, id: string) {
  const w = await sdo<WorkerCard>(c, 'staff_worker_card', { employee_id: id });
  await out(c, t(c.lang, 'u.removeAsk', { name: w.name }), [
    [BTN(t(c.lang, 'edit.yesDel'), `uxy:${id}`), BTN(t(c.lang, 'edit.no'), `uc:${id}`)],
  ]);
}

async function removeDo(c: Ctx, id: string) {
  const w = await sdo<WorkerCard>(c, 'staff_worker_card', { employee_id: id });
  const res = await sdo<{ chat_id: number; language: Lang | null }>(c, 'staff_remove_worker', { employee_id: id });
  await out(c, t(c.lang, 'u.removed', { name: w.name }), [[BTN(t(c.lang, 'btn.back'), `uc:${id}`)]]);
  await notifyWorkerDecision('remove', { chat_id: res.chat_id, language: res.language });
}

// --- записи работника (исправить/удалить)
function statusText(c: Ctx, r: RecItem): string {
  if (r.status === 'confirmed') return t(c.lang, 'u.statusConfirmed');
  if (r.status === 'pending') return t(c.lang, 'u.statusPending');
  return t(c.lang, 'u.statusRejected', { reason: r.reject_reason ?? '' });
}
const statusIcon = (s: RecItem['status']) => (s === 'confirmed' ? '✅' : s === 'pending' ? '⏳' : '🚫');

async function showWorkerRecords(c: Ctx, empId: string) {
  const [w, recs] = await Promise.all([
    sdo<WorkerCard>(c, 'staff_worker_card', { employee_id: empId }),
    sdo<RecItem[]>(c, 'staff_records', { employee_id: empId }),
  ]);
  await setState(c.sb, c.tg, 'u_recs', { employeeId: empId });
  if (recs.length === 0) {
    return out(c, `${t(c.lang, 'u.recordsTitle', { name: w.name })}\n${t(c.lang, 'u.recordsEmpty')}`, [[BTN(t(c.lang, 'btn.back'), `uc:${empId}`)]]);
  }
  const rows = recs.slice(0, 20).map((r) => [
    BTN(
      t(c.lang, 'u.recBtn', {
        icon: statusIcon(r.status),
        date: fmtDate(String(r.date).slice(0, 10)).slice(0, 5),
        label: displayLabel(r.label, r.is_whole, c.lang),
        qty: r.quantity,
      }),
      `ur:${r.id}`
    ),
  ]);
  rows.push([BTN(t(c.lang, 'btn.back'), `uc:${empId}`)]);
  await out(c, t(c.lang, 'u.recordsTitle', { name: w.name }), rows);
}

async function ctxEmployee(c: Ctx): Promise<string | null> {
  const st = await getState(c.sb, c.tg);
  if (!st || !(st.state === 'u_recs' || st.state === 'u_rec_qty')) return null;
  return String(st.data.employeeId);
}

async function findRec(c: Ctx, empId: string, id: string): Promise<RecItem | null> {
  const recs = await sdo<RecItem[]>(c, 'staff_records', { employee_id: empId });
  return recs.find((r) => r.id === id) ?? null;
}

async function showWorkerRecord(c: Ctx, id: string) {
  const empId = await ctxEmployee(c);
  if (!empId) return void (await say(c, t(c.lang, 'err.stale')));
  const [w, r] = await Promise.all([sdo<WorkerCard>(c, 'staff_worker_card', { employee_id: empId }), findRec(c, empId, id)]);
  if (!r) return showWorkerRecords(c, empId);
  const rows: InlineButton[][] = [];
  if (r.status !== 'rejected') {
    rows.push([BTN(t(c.lang, 'c.btnQty'), `uq:${id}`), BTN(t(c.lang, 'k.btnDelete'), `ud:${id}`)]);
  }
  rows.push([BTN(t(c.lang, 'btn.back'), `us:${empId}`)]);
  await out(
    c,
    t(c.lang, 'u.recCard', {
      label: displayLabel(r.label, r.is_whole, c.lang),
      name: w.name,
      qty: r.quantity,
      rate: money(Number(r.rate), c.lang),
      sum: money(Number(r.total), c.lang),
      date: fmtDate(String(r.date).slice(0, 10)),
      status: statusText(c, r),
    }),
    rows
  );
}

async function recordQtyAsk(c: Ctx, id: string) {
  const empId = await ctxEmployee(c);
  if (!empId) return void (await say(c, t(c.lang, 'err.stale')));
  const r = await findRec(c, empId, id);
  if (!r) return showWorkerRecords(c, empId);
  await setState(c.sb, c.tg, 'u_rec_qty', { id, employeeId: empId });
  await out(c, t(c.lang, 'u.recAskQty', { label: displayLabel(r.label, r.is_whole, c.lang), qty: r.quantity }), [CANCEL(c.lang)]);
}

async function recordQtyDo(c: Ctx, id: string, empId: string, text: string) {
  const qty = /^\d{1,5}$/.test(text.trim()) ? Number(text.trim()) : 0;
  if (qty < 1 || qty > 99999) return void (await say(c, t(c.lang, 'add.badQty')));
  const res = await sdo<{ label: string; is_whole: boolean; quantity: number; total: number; notify: NotifyTarget | null } & RecordChange>(c, 'staff_edit_record', { id, quantity: qty });
  await setState(c.sb, c.tg, 'u_recs', { employeeId: empId });
  await say(c, t(c.lang, 'u.recUpdated', { label: displayLabel(res.label, res.is_whole, c.lang), qty: res.quantity, sum: money(Number(res.total), c.lang) }));
  await notifyWorkerRecord('edited', res.notify, res);
  await showWorkerRecords({ ...c, mid: undefined }, empId);
}

async function recordDeleteAsk(c: Ctx, id: string) {
  const empId = await ctxEmployee(c);
  if (!empId) return void (await say(c, t(c.lang, 'err.stale')));
  const r = await findRec(c, empId, id);
  if (!r) return showWorkerRecords(c, empId);
  await out(c, t(c.lang, 'u.recDeleteAsk', { label: displayLabel(r.label, r.is_whole, c.lang), qty: r.quantity }), [
    [BTN(t(c.lang, 'edit.yesDel'), `udy:${id}`), BTN(t(c.lang, 'edit.no'), `ur:${id}`)],
  ]);
}

async function recordDeleteDo(c: Ctx, id: string) {
  const empId = await ctxEmployee(c);
  if (!empId) return void (await say(c, t(c.lang, 'err.stale')));
  const res = await sdo<{ notify: NotifyTarget | null } & RecordChange>(c, 'staff_delete_record', { id });
  await out(c, t(c.lang, 'u.recDeleted'), [[BTN(t(c.lang, 'btn.back'), `us:${empId}`)]]);
  await notifyWorkerRecord('deleted', res.notify, res);
}

// --- ➕ Добавить работника: профессия → ссылка
async function invitePick(c: Ctx) {
  const w = await sdo<WorkersInfo>(c, 'staff_workers', {});
  if (w.professions.length === 0) return out(c, t(c.lang, 'u.noProfessions'), [[BTN(t(c.lang, 'btn.back'), 'ul:back')]]);
  const rows = w.professions.map((p) => [BTN(`👷 ${p.name}`, `ui:${p.id}`)]);
  rows.push([BTN(t(c.lang, 'btn.back'), 'ul:back')]);
  await out(c, t(c.lang, 'u.invitePick'), rows);
}

async function inviteShow(c: Ctx, profId: string, regenerate: boolean) {
  const inv = await sdo<{ token: string; created: boolean }>(c, 'staff_invite', { profession_id: profId, regenerate });
  const w = await sdo<WorkersInfo>(c, 'staff_workers', {});
  const username = process.env.TELEGRAM_WORKER_BOT_USERNAME?.replace(/^@/, '');
  const prof = w.professions.find((p) => p.id === profId)?.name ?? '';
  const text = username
    ? t(c.lang, 'u.invite', { profession: prof, shop: shopLabel(c), link: `https://t.me/${username}?start=${inv.token}` })
    : `${t(c.lang, 'u.invite', { profession: prof, shop: shopLabel(c), link: '' })}\n${t(c.lang, 'u.inviteNoBot', { token: inv.token })}`;
  await out(c, regenerate ? `${t(c.lang, 'u.inviteNewDone')}\n\n${text}` : text, [
    [BTN(t(c.lang, 'u.inviteNew'), `uin:${profId}`)],
    [BTN(t(c.lang, 'btn.back'), 'ua')],
  ]);
}

// ====================================================================
// 📦 Изделия
// ====================================================================
interface ProfOverview {
  id: string;
  name: string;
  models: number;
  operations: number;
  whole: number;
}
interface ModelsInfo {
  profession: { id: string; name: string } | null;
  models: { id: string; name: string; whole_rate: number | null; ops: number }[];
}
interface ModelInfo {
  id: string;
  name: string;
  whole_rate: number | null;
  profession_id: string;
  profession_name: string;
  ops: { id: string; name: string; rate: number }[];
}

async function showCatalog(c: Ctx) {
  const ov = await sdo<ProfOverview[]>(c, 'staff_catalog_overview', {});
  if (ov.length === 0) return out(c, `${t(c.lang, 'k.title')}\n\n${t(c.lang, 'u.noProfessions')}`);
  const rows = ov.map((p) => [
    BTN(
      p.models === 0 && p.operations === 0
        ? t(c.lang, 'k.profBtnEmpty', { name: p.name })
        : t(c.lang, 'k.profBtn', { name: p.name, models: p.models, ops: p.operations, whole: p.whole }),
      `kp:${p.id}`
    ),
  ]);
  await out(c, t(c.lang, 'k.title'), rows);
}

async function showProfession(c: Ctx, profId: string) {
  const m = await sdo<ModelsInfo>(c, 'staff_catalog_models', { profession_id: profId });
  if (!m.profession) return showCatalog(c);
  const lines = [t(c.lang, 'k.profTitle', { name: m.profession.name, models: m.models.length })];
  if (m.models.length === 0) lines.push('', t(c.lang, 'k.noModels'));
  const rows: InlineButton[][] = m.models.slice(0, 60).map((x) => [BTN(t(c.lang, 'k.modelBtn', { name: x.name, ops: x.ops }), `km:${x.id}`)]);
  rows.push([BTN(t(c.lang, 'k.addModel'), `ka:${profId}`), BTN(t(c.lang, 'k.addList'), `kb:${profId}`)]);
  rows.push([BTN(t(c.lang, 'btn.back'), 'k0')]);
  await out(c, lines.join('\n'), rows);
}

async function showModel(c: Ctx, modelId: string) {
  const m = await sdo<ModelInfo>(c, 'staff_catalog_model', { model_id: modelId });
  await setState(c.sb, c.tg, 'k_ctx', { profId: m.profession_id, modelId: m.id });
  const table = m.ops.length === 0 ? t(c.lang, 'k.noOps') : m.ops.map((o, i) => `${i + 1}. ${o.name} — ${money(Number(o.rate), c.lang)}`).join('\n');
  const rows: InlineButton[][] = [];
  const nums = m.ops.slice(0, 40).map((o, i) => BTN(String(i + 1), `ko:${o.id}`));
  for (let i = 0; i < nums.length; i += 8) rows.push(nums.slice(i, i + 8));
  rows.push([BTN(t(c.lang, 'k.btnAddOp'), `kao:${m.id}`), BTN(t(c.lang, 'k.addList'), `kbm:${m.id}`)]);
  rows.push([BTN(t(c.lang, 'k.btnWhole'), `kw:${m.id}`), BTN(t(c.lang, 'k.btnRenameModel'), `kr:${m.id}`)]);
  rows.push([BTN(t(c.lang, 'k.btnDeleteModel'), `kd:${m.id}`)]);
  rows.push([BTN(t(c.lang, 'btn.back'), `kp:${m.profession_id}`)]);
  await out(
    c,
    t(c.lang, 'k.model', {
      name: m.name,
      profession: m.profession_name,
      whole: m.whole_rate ? money(Number(m.whole_rate), c.lang) : t(c.lang, 'k.wholeNone'),
      table,
    }),
    rows
  );
}

async function modelCtx(c: Ctx): Promise<{ profId: string; modelId: string } | null> {
  const st = await getState(c.sb, c.tg);
  if (st?.state !== 'k_ctx') return null;
  return { profId: String(st.data.profId), modelId: String(st.data.modelId) };
}

async function showOperation(c: Ctx, opId: string) {
  const ctx = await modelCtx(c);
  if (!ctx) return void (await say(c, t(c.lang, 'err.stale')));
  const m = await sdo<ModelInfo>(c, 'staff_catalog_model', { model_id: ctx.modelId });
  const op = m.ops.find((o) => o.id === opId);
  if (!op) return showModel(c, ctx.modelId);
  await out(c, t(c.lang, 'k.op', { name: op.name, model: m.name, rate: money(Number(op.rate), c.lang) }), [
    [BTN(t(c.lang, 'k.btnRename'), `kor:${opId}`), BTN(t(c.lang, 'k.btnRate'), `kop:${opId}`)],
    [BTN(t(c.lang, 'k.btnDelete'), `kod:${opId}`)],
    [BTN(t(c.lang, 'btn.back'), `km:${m.id}`)],
  ]);
}

async function opName(c: Ctx, modelId: string, opId: string): Promise<string | null> {
  const m = await sdo<ModelInfo>(c, 'staff_catalog_model', { model_id: modelId });
  return m.ops.find((o) => o.id === opId)?.name ?? null;
}

const SMALL_BACK = (c: Ctx, data: string): InlineButton[] => [BTN(t(c.lang, 'btn.back'), data)];

async function backToModel(c: Ctx, modelId: string) {
  await showModel({ ...c, mid: undefined }, modelId);
}

function parseRate(text: string): number | null {
  const m = /^\s*(\d{1,3}(?:[ .]\d{3})+|\d+)\s*(?:сум|so'm|som|sum)?\s*$/i.exec(text);
  if (!m) return null;
  return Number(m[1].replace(/[ .]/g, ''));
}

// --- модель
async function modelAddAsk(c: Ctx, profId: string) {
  await setState(c.sb, c.tg, 'k_model_name', { profId });
  await out(c, t(c.lang, 'k.askModelName'), [CANCEL(c.lang)]);
}
async function modelAddDo(c: Ctx, profId: string, text: string) {
  const res = await sdo<{ id: string }>(c, 'staff_catalog_set', { action: 'add_model', profession_id: profId, name: text });
  await clearState(c.sb, c.tg);
  await say(c, t(c.lang, 'k.saved'));
  await backToModel(c, res.id);
}
async function renameModelAsk(c: Ctx, id: string) {
  const m = await sdo<ModelInfo>(c, 'staff_catalog_model', { model_id: id });
  await setState(c.sb, c.tg, 'k_rename_model', { id });
  await out(c, t(c.lang, 'k.askRename', { name: m.name }), [CANCEL(c.lang)]);
}
async function renameModelDo(c: Ctx, id: string, text: string) {
  await sdo(c, 'staff_catalog_set', { action: 'rename_model', id, name: text });
  await clearState(c.sb, c.tg);
  await say(c, t(c.lang, 'k.saved'));
  await backToModel(c, id);
}
async function wholeAsk(c: Ctx, id: string) {
  const m = await sdo<ModelInfo>(c, 'staff_catalog_model', { model_id: id });
  await setState(c.sb, c.tg, 'k_whole', { id });
  await out(c, t(c.lang, 'k.askWhole', { name: m.name, rate: m.whole_rate ? money(Number(m.whole_rate), c.lang) : t(c.lang, 'k.wholeNone') }), [CANCEL(c.lang)]);
}
async function wholeDo(c: Ctx, id: string, text: string) {
  const rate = parseRate(text);
  if (rate === null) return void (await say(c, t(c.lang, 'k.badRate')));
  await sdo(c, 'staff_catalog_set', { action: 'set_whole_rate', id, rate: rate === 0 ? null : rate });
  await clearState(c.sb, c.tg);
  await say(c, t(c.lang, 'k.saved'));
  await backToModel(c, id);
}
async function modelDeleteAsk(c: Ctx, id: string) {
  const m = await sdo<ModelInfo>(c, 'staff_catalog_model', { model_id: id });
  await out(c, t(c.lang, 'k.deleteModelAsk', { name: m.name }), [
    [BTN(t(c.lang, 'edit.yesDel'), `kdy:${id}`), BTN(t(c.lang, 'edit.no'), `km:${id}`)],
  ]);
}
async function modelDeleteDo(c: Ctx, id: string) {
  const m = await sdo<ModelInfo>(c, 'staff_catalog_model', { model_id: id });
  const res = await sdo<{ result: string }>(c, 'staff_catalog_set', { action: 'delete_model', id });
  await out(c, t(c.lang, res.result === 'archived' ? 'k.archived' : 'k.deleted'), [SMALL_BACK(c, `kp:${m.profession_id}`)]);
}

// --- операция
async function opAddAsk(c: Ctx, modelId: string) {
  await setState(c.sb, c.tg, 'k_op_add', { modelId });
  await out(c, t(c.lang, 'k.askOp'), [CANCEL(c.lang)]);
}
async function opAddDo(c: Ctx, modelId: string, text: string) {
  const parsed = parseCatalogList(text, true);
  if (parsed.errors.length === 0 && parsed.groups.length === 1 && parsed.groups[0].model === null) {
    const m = await sdo<ModelInfo>(c, 'staff_catalog_model', { model_id: modelId });
    const res = await sdo<{ new_ops: number; skipped: number }>(c, 'staff_catalog_bulk', {
      profession_id: m.profession_id,
      model_id: modelId,
      apply: true,
      groups: parsed.groups,
    });
    await clearState(c.sb, c.tg);
    await say(c, res.new_ops > 0 ? t(c.lang, 'k.saved') : t(c.lang, 'k.duplicate'));
    return backToModel(c, modelId);
  }
  // только название — спрашиваем цену
  const single = text.trim().replace(/\s+/g, ' ');
  if (parsed.errors.length === 0 && parsed.groups.length === 1 && parsed.groups[0].model && parsed.groups[0].ops.length === 0 && !single.includes('\n')) {
    if (single.length > 60) return void (await say(c, t(c.lang, 'k.badName')));
    await setState(c.sb, c.tg, 'k_op_rate', { modelId, name: single });
    return void (await say(c, t(c.lang, 'k.askOpRate', { name: single }), [CANCEL(c.lang)]));
  }
  await say(c, t(c.lang, 'k.askOp'), [CANCEL(c.lang)]);
}
async function opAddRateDo(c: Ctx, modelId: string, name: string, text: string) {
  const rate = parseRate(text);
  if (rate === null || rate <= 0) return void (await say(c, t(c.lang, 'k.badRate')));
  await sdo(c, 'staff_catalog_set', { action: 'add_op', model_id: modelId, name, rate });
  await clearState(c.sb, c.tg);
  await say(c, t(c.lang, 'k.saved'));
  await backToModel(c, modelId);
}
async function renameOpAsk(c: Ctx, opId: string) {
  const ctx = await modelCtx(c);
  if (!ctx) return void (await say(c, t(c.lang, 'err.stale')));
  const name = await opName(c, ctx.modelId, opId);
  if (!name) return showModel(c, ctx.modelId);
  await setState(c.sb, c.tg, 'k_rename_op', { id: opId, modelId: ctx.modelId });
  await out(c, t(c.lang, 'k.askRename', { name }), [CANCEL(c.lang)]);
}
async function renameOpDo(c: Ctx, id: string, modelId: string, text: string) {
  await sdo(c, 'staff_catalog_set', { action: 'rename_op', id, name: text });
  await clearState(c.sb, c.tg);
  await say(c, t(c.lang, 'k.saved'));
  await backToModel(c, modelId);
}
async function opRateAsk(c: Ctx, opId: string) {
  const ctx = await modelCtx(c);
  if (!ctx) return void (await say(c, t(c.lang, 'err.stale')));
  const m = await sdo<ModelInfo>(c, 'staff_catalog_model', { model_id: ctx.modelId });
  const op = m.ops.find((o) => o.id === opId);
  if (!op) return showModel(c, ctx.modelId);
  await setState(c.sb, c.tg, 'k_rate', { id: opId, modelId: ctx.modelId });
  await out(c, t(c.lang, 'k.askRate', { name: op.name, rate: money(Number(op.rate), c.lang) }), [CANCEL(c.lang)]);
}
async function opRateDo(c: Ctx, id: string, modelId: string, text: string) {
  const rate = parseRate(text);
  if (rate === null || rate <= 0) return void (await say(c, t(c.lang, 'k.badRate')));
  await sdo(c, 'staff_catalog_set', { action: 'set_rate', id, rate });
  await clearState(c.sb, c.tg);
  await say(c, t(c.lang, 'k.saved'));
  await backToModel(c, modelId);
}
async function opDeleteAsk(c: Ctx, opId: string) {
  const ctx = await modelCtx(c);
  if (!ctx) return void (await say(c, t(c.lang, 'err.stale')));
  const name = await opName(c, ctx.modelId, opId);
  if (!name) return showModel(c, ctx.modelId);
  await out(c, t(c.lang, 'k.deleteAsk', { name }), [[BTN(t(c.lang, 'edit.yesDel'), `kody:${opId}`), BTN(t(c.lang, 'edit.no'), `ko:${opId}`)]]);
}
async function opDeleteDo(c: Ctx, opId: string) {
  const ctx = await modelCtx(c);
  if (!ctx) return void (await say(c, t(c.lang, 'err.stale')));
  const res = await sdo<{ result: string }>(c, 'staff_catalog_set', { action: 'delete_op', id: opId });
  await out(c, t(c.lang, res.result === 'archived' ? 'k.archived' : 'k.deleted'), [SMALL_BACK(c, `km:${ctx.modelId}`)]);
}

// --- список одним сообщением
async function listAsk(c: Ctx, profId: string, modelId: string | null) {
  await setState(c.sb, c.tg, 'k_list', { profId, modelId: modelId ?? '' });
  await out(c, t(c.lang, 'k.askList'), [CANCEL(c.lang)]);
}
async function listAskInModel(c: Ctx, modelId: string) {
  const m = await sdo<ModelInfo>(c, 'staff_catalog_model', { model_id: modelId });
  await setState(c.sb, c.tg, 'k_list', { profId: m.profession_id, modelId });
  await out(c, t(c.lang, 'k.askListInModel', { model: m.name }), [CANCEL(c.lang)]);
}

const WHY: Record<string, MessageKey> = {
  noModel: 'k.whyNoModel',
  noPrice: 'k.whyNoPrice',
  bigPrice: 'k.whyBigPrice',
  long: 'k.whyLong',
};

function errorLines(c: Ctx, p: ParseResult): string {
  return p.errors
    .slice(0, 10)
    .map((e) => t(c.lang, 'k.errLine', { n: e.n, text: e.text.slice(0, 40), why: t(c.lang, WHY[e.why]) }))
    .join('\n');
}

async function listPreview(c: Ctx, profId: string, modelId: string | null, text: string) {
  const parsed = parseCatalogList(text, !!modelId);
  const parts: string[] = [];
  let canSave = false;
  let preview: { new_models: number; new_ops: number; skipped: number; skipped_list: { model: string; name: string }[] } | null = null;

  if (parsed.groups.length > 0) {
    preview = await sdo(c, 'staff_catalog_bulk', { profession_id: profId, model_id: modelId, apply: false, groups: parsed.groups });
  }
  if (!preview || (preview.new_models === 0 && preview.new_ops === 0)) {
    if (!preview) parts.push(t(c.lang, 'k.previewNothing'));
    else {
      parts.push(t(c.lang, 'k.preview', { newModels: preview.new_models, newOps: preview.new_ops, skipped: preview.skipped }));
    }
  } else {
    canSave = true;
    parts.push(t(c.lang, 'k.preview', { newModels: preview.new_models, newOps: preview.new_ops, skipped: preview.skipped }));
  }
  if (preview && preview.skipped > 0) {
    parts.push(preview.skipped_list.slice(0, 10).map((s) => t(c.lang, 'k.previewSkipped', { model: s.model, name: s.name })).join('\n'));
  }
  if (parsed.smallPrices.length > 0) parts.push(t(c.lang, 'k.previewSmall', { names: parsed.smallPrices.slice(0, 5).join('; ') }));
  if (parsed.errors.length > 0) parts.push(t(c.lang, 'k.previewErrors', { lines: errorLines(c, parsed) }));
  if (preview && preview.new_models === 0 && preview.new_ops === 0 && parsed.errors.length === 0) parts.push(t(c.lang, 'k.previewNothing'));

  if (canSave) await setState(c.sb, c.tg, 'k_list_ok', { profId, modelId: modelId ?? '', groups: parsed.groups });
  else await setState(c.sb, c.tg, 'k_list', { profId, modelId: modelId ?? '' });

  await say(c, parts.join('\n\n'), [canSave ? [BTN(t(c.lang, 'k.btnSave'), 'kbs'), ...CANCEL(c.lang)] : CANCEL(c.lang)]);
}

async function listApply(c: Ctx) {
  const st = await getState(c.sb, c.tg);
  if (st?.state !== 'k_list_ok') return void (await out(c, t(c.lang, 'k.listStale')));
  const profId = String(st.data.profId);
  const modelId = String(st.data.modelId || '') || null;
  const res = await sdo<{ new_models: number; new_ops: number }>(c, 'staff_catalog_bulk', {
    profession_id: profId,
    model_id: modelId,
    apply: true,
    groups: st.data.groups,
  });
  await clearState(c.sb, c.tg);
  await out(c, t(c.lang, 'k.listSaved', { newModels: res.new_models, newOps: res.new_ops }), [SMALL_BACK(c, modelId ? `km:${modelId}` : `kp:${profId}`)]);
}

