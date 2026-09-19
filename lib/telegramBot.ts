import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { NO_PRINT, ProductVariant, stockStatus, variantLabel } from '@/lib/types';
import {
  sendMessage,
  editMessageText,
  removeKeyboard,
  answerCallbackQuery,
  escapeHtml,
  InlineButton,
  TelegramUpdate,
  TelegramCallbackQuery,
} from '@/lib/telegram';
import {
  canonicalValue,
  Correction,
  findSimilar,
  norm,
  parseOrderLine,
  ParseEvent,
  ParseResult,
  phoneDigits,
  phoneKey,
  sameProductName,
  sizeRank,
  sortSizes,
} from '@/lib/telegramParse';
import { both, Lang, MessageKey, Params, raw, t } from '@/lib/telegramI18n';

const APP_URL = 'https://factory-orders-5yuc3.ondigitalocean.app';
const SESSION_HOURS = 24;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const HISTORY_LIMIT = 15;
const HISTORY_ITEMS_PER_ORDER = 6;
const TELEGRAM_MESSAGE_LIMIT = 3800;
const TIMEZONE = process.env.TELEGRAM_TIMEZONE || 'Asia/Tashkent';
const NAME_PATTERN = /^\p{L}[\p{L}\p{M}\s.'’ʻ-]{1,39}$/u;
// Замок на пользователя (см. withUserLock).
const USER_LOCK_TTL_MS = 10_000;
const USER_LOCK_STEP_MS = 250;
const USER_LOCK_MAX_WAIT_MS = 7_500;

// Всё, что нужно обработчикам одного обновления: клиент базы, кто пишет,
// на каком языке отвечать и как подписывать выдачу.
interface Ctx {
  sb: SupabaseClient;
  userId: number;
  chatId: number;
  lang: Lang;
  staff: string;
}

const tr = (ctx: Ctx, key: MessageKey, params?: Params) => t(ctx.lang, key, params);
const say = (ctx: Ctx, key: MessageKey, params?: Params, buttons?: InlineButton[][]) =>
  sendMessage(ctx.chatId, tr(ctx, key, params), buttons);

// Позиция, которую бот собирает в черновике заказа.
interface DraftItem {
  variantId: string;
  productName: string;
  color: string | null;
  size: string | null;
  printType: string | null;
  quantity: number;
}

// Вариант товара, достаточный, чтобы показать его и положить в заказ.
// Остаток здесь намеренно не хранится: он всегда перечитывается из базы.
interface VariantRef {
  id: string;
  product_name: string;
  color: string | null;
  size: string | null;
  print_type: string | null;
}

interface ClientRef {
  id: string;
  name: string;
  phone: string | null;
}

// Кнопочный выбор, которого бот ждёт от пользователя. У каждого вопроса свой
// одноразовый код tok: он зашит в кнопки, и нажатие принимается, только если
// код совпал с текущим — повторное нажатие или кнопка из старого сообщения
// не может ответить на следующий вопрос.
// Где пользователь находится в пошаговом выборе варианта (товар → цвет → размер,
// как в /sklad): выбранный товар (product_id) и цвет (ключ группы цвета).
interface PickNav {
  product?: string;
  color?: string;
}

interface PickVariantPending {
  type: 'pick_variant';
  // Все варианты, подходящие под строку заказа (id). Выбор строится по ним, а
  // остатки при каждом показе читаются из базы заново.
  ids: string[];
  quantity: number;
  corrections?: Correction[];
  line: string;
  nav: PickNav;
  tok: string;
}

type PendingState =
  | { type: 'confirm_new_client'; query: string; tok: string }
  | { type: 'pick_client'; candidates: ClientRef[]; query: string; tok: string }
  | { type: 'confirm_phone_dup'; name: string; phone: string; existing: ClientRef; tok: string }
  | PickVariantPending;

// Позиция, по которой ждём подтверждения количества.
interface QtyPrompt extends VariantRef {
  requested: number;
  corrections?: Correction[];
  tok: string;
}

interface ProductFlowData {
  name?: string;
  color?: string | null;
  size?: string | null;
  qty?: number;
  // Значения, показанные кнопками на текущем шаге (индекс из callback_data).
  options?: string[];
  tok?: string;
  // Введённое значение похоже на существующее — ждём «да, это оно» / «нет, новое».
  suggest?: { kind: 'name' | 'color'; typed: string; options: string[] };
}

interface FlowData {
  qty?: QtyPrompt;
  ap?: ProductFlowData;
  // Остальные строки многострочного ввода: каждая позиция подтверждается
  // отдельно, поэтому следующая строка обрабатывается после ответа на вопрос.
  queue?: string[];
}

interface Draft {
  telegram_user_id: number;
  step: string;
  client_id: string | null;
  client_name: string | null;
  client_phone: string | null;
  items: DraftItem[];
  pending: PendingState | null;
  flow: 'order' | 'add_product';
  flow_data: FlowData | null;
}

type OnboardingStep = 'language' | 'name';

interface Session {
  telegram_user_id: number;
  expires_at: string | null;
  failed_attempts: number;
  locked_until: string | null;
  lang: Lang | null;
  staff_name: string | null;
  onboarding: OnboardingStep | null;
}

function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createClient(url, key, { auth: { persistSession: false } });
}

function sanitizeIlike(input: string): string {
  return input.replace(/[,()%]/g, ' ').trim();
}

function fmt(value: number | string): string {
  return String(Number(value));
}

function now(): string {
  return new Date().toISOString();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function looksLikePhone(input: string): boolean {
  return /^[+\d\s\-()]+$/.test(input) && input.replace(/\D/g, '').length >= 5;
}

function parsePositiveNumber(input: string): number | null {
  const m = input.trim().match(/^(\d+(?:[.,]\d+)?)\s*(?:шт|штук[аи]?|ta|dona)?\.?$/i);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  return value > 0 ? value : null;
}

// Одноразовый код вопроса и разбор callback_data вида «база:код».
function newTok(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

function splitCallback(data: string): { base: string; tok: string } {
  const i = data.lastIndexOf(':');
  return { base: data.slice(0, i), tok: data.slice(i + 1) };
}

// Отпечаток состава заказа: кнопки итога («Выдать», «Отмена») действуют, только
// пока заказ выглядит так же, как в том итоге, где они были показаны.
function orderRev(draft: Draft): string {
  const s = `${draft.client_id ?? ''}|${(draft.items ?? [])
    .map((i) => `${i.variantId}:${i.quantity}`)
    .sort()
    .join(',')}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// Название позиции для сообщений: «Майка — L, Белый» (уже экранировано).
function variantTitle(v: { product_name: string; color: string | null; size: string | null; print_type?: string | null }): string {
  const label = variantLabel(v);
  return escapeHtml(v.product_name) + (label ? ' — ' + escapeHtml(label) : '');
}

function itemTitle(it: DraftItem): string {
  return variantTitle({ product_name: it.productName, color: it.color, size: it.size, print_type: it.printType });
}

function refOf(v: ProductVariant): VariantRef {
  return { id: v.id, product_name: v.product_name, color: v.color, size: v.size, print_type: v.print_type };
}

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

// Пометка «исправлено» для позиций, найденных с поправкой опечатки.
function fixNote(ctx: Ctx, corrections: Correction[] | undefined) {
  if (!corrections || corrections.length === 0) return '';
  const pairs = corrections.map((c) => `«${escapeHtml(c.from)}» → «${escapeHtml(c.to)}»`).join(', ');
  return raw(tr(ctx, 'order.fixed', { pairs: raw(pairs) }));
}

// Длинные ответы (история) режем на несколько сообщений по границам блоков —
// у Telegram лимит 4096 символов на сообщение.
async function sendBlocks(chatId: number, blocks: string[]) {
  let current = '';
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > TELEGRAM_MESSAGE_LIMIT) {
      await sendMessage(chatId, current);
      current = '';
    }
    current = current ? current + '\n\n' + block : block;
  }
  if (current) await sendMessage(chatId, current);
}

async function present(ctx: Ctx, messageId: number | undefined, text: string, buttons?: InlineButton[][]) {
  if (messageId) await editMessageText(ctx.chatId, messageId, text, buttons);
  else await sendMessage(ctx.chatId, text, buttons);
}

async function getSession(sb: SupabaseClient, telegramUserId: number): Promise<Session | null> {
  const { data } = await sb.from('telegram_sessions').select('*').eq('telegram_user_id', telegramUserId).maybeSingle();
  return (data as Session) ?? null;
}

// PIN введён и 24 часа ещё не прошли.
function isLoggedIn(session: Session | null): boolean {
  return !!session?.expires_at && new Date(session.expires_at) > new Date();
}

// После PIN нужно выбрать язык и назвать имя. Сессии, созданные до появления
// этих шагов, тоже проходят их один раз.
function onboardingStep(session: Session): OnboardingStep | null {
  if (session.onboarding) return session.onboarding;
  if (!session.lang) return 'language';
  if (!session.staff_name) return 'name';
  return null;
}

async function getDraft(sb: SupabaseClient, telegramUserId: number): Promise<Draft | null> {
  const { data } = await sb.from('telegram_order_drafts').select('*').eq('telegram_user_id', telegramUserId).maybeSingle();
  return (data as Draft) ?? null;
}

async function updateDraft(ctx: Ctx, patch: Record<string, unknown>) {
  await ctx.sb
    .from('telegram_order_drafts')
    .update({ ...patch, updated_at: now() })
    .eq('telegram_user_id', ctx.userId);
}

// Есть ли у пользователя начатое, но не завершённое действие.
function hasUnfinishedWork(draft: Draft | null): boolean {
  if (!draft) return false;
  return (
    draft.flow === 'add_product' ||
    (draft.items?.length ?? 0) > 0 ||
    !!draft.pending ||
    !!draft.flow_data?.qty ||
    !!draft.client_id
  );
}

async function loadFinishedVariants(sb: SupabaseClient): Promise<ProductVariant[]> {
  const { data } = await sb.from('product_variants_view').select('*').eq('warehouse_type', 'finished_goods').limit(1000);
  return (data ?? []) as ProductVariant[];
}

async function freshStock(sb: SupabaseClient, variantId: string): Promise<number> {
  const { data } = await sb.from('product_variants').select('stock_quantity').eq('id', variantId).maybeSingle();
  return Number(data?.stock_quantity ?? 0);
}

// Обрабатывает по одному обновлению от пользователя за раз. Иначе два быстрых
// сообщения подряд читают одно и то же состояние черновика и затирают друг
// друга. Замок — это атомарный условный UPDATE в базе (работает между
// экземплярами приложения) с TTL: если обработчик упал, замок сам истекает.
// Если базу с замком использовать нельзя (нет колонки, сбой), работаем как
// раньше, без замка, — молчание для кладовщика хуже гонки.
async function withUserLock<T>(sb: SupabaseClient, userId: number, fn: () => Promise<T>): Promise<T> {
  let acquired = false;
  const started = Date.now();
  try {
    for (;;) {
      const nowIso = new Date().toISOString();
      const { data, error } = await sb
        .from('telegram_sessions')
        .update({ busy_until: new Date(Date.now() + USER_LOCK_TTL_MS).toISOString() })
        .eq('telegram_user_id', userId)
        .or(`busy_until.is.null,busy_until.lt.${nowIso}`)
        .select('telegram_user_id');
      if (error) {
        console.error('telegram user lock unavailable', error.message);
        break;
      }
      if (data && data.length > 0) {
        acquired = true;
        break;
      }
      if (Date.now() - started >= USER_LOCK_MAX_WAIT_MS) break;
      await sleep(USER_LOCK_STEP_MS);
    }
    return await fn();
  } finally {
    if (acquired) {
      try {
        await sb.from('telegram_sessions').update({ busy_until: null }).eq('telegram_user_id', userId);
      } catch (err) {
        console.error('telegram user lock release failed', err);
      }
    }
  }
}

// Неуверенно распознанные и нераспознанные слова сохраняются, чтобы по факту
// использования донастроить словарь и допуски опечаток. Сбой записи журнала
// никогда не должен ломать сам диалог.
async function logParseEvents(ctx: Ctx, rawLine: string, events: ParseEvent[]) {
  if (events.length === 0) return;
  try {
    const { error } = await ctx.sb.from('telegram_parse_log').insert(
      events.map((e) => ({
        telegram_user_id: ctx.userId,
        staff_name: ctx.staff,
        lang: ctx.lang,
        raw_text: rawLine,
        reason: e.reason,
        token: e.token ?? null,
        detail: e.detail ?? null,
      }))
    );
    if (error) console.error('telegram parse log insert failed', error.message);
  } catch (err) {
    console.error('telegram parse log insert threw', err);
  }
}

// ---------------------------------------------------------------------------
// Вход: PIN → язык → имя (каждые 24 часа, вместе с сессией)
// ---------------------------------------------------------------------------

async function handlePinAttempt(sb: SupabaseClient, telegramUserId: number, chatId: number, text: string) {
  const session = await getSession(sb, telegramUserId);

  if (session?.locked_until && new Date(session.locked_until) > new Date()) {
    const minutes = Math.ceil((new Date(session.locked_until).getTime() - Date.now()) / 60000);
    await sendMessage(chatId, both('pin.locked', { minutes }));
    return;
  }

  const pin = process.env.TELEGRAM_KLADOVSHIK_PIN;
  if (!pin) {
    await sendMessage(chatId, both('pin.notSet'));
    return;
  }

  if (text.trim() === pin) {
    await sb.from('telegram_sessions').upsert({
      telegram_user_id: telegramUserId,
      expires_at: new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString(),
      failed_attempts: 0,
      locked_until: null,
      onboarding: 'language',
    });
    await askLanguage(chatId);
    return;
  }

  // Неверной попыткой считается только то, что похоже на PIN по форме: для
  // PIN из цифр — строка из цифр не короче PIN, иначе — одно слово той же
  // длины. Команды, слова («красный» в /add_product), строки заказа и короткие
  // ответы («5» в вопросе о количестве) при истёкшей сессии — не попытки:
  // иначе пять таких ответов подряд блокируют вход на 15 минут посреди работы.
  const looksLikePin = /^\d+$/.test(pin) ? /^\d+$/.test(text) && text.length >= pin.length : !/\s/.test(text) && text.length === pin.length;
  if (!looksLikePin) {
    const draft = await getDraft(sb, telegramUserId);
    await sendMessage(chatId, both(hasUnfinishedWork(draft) ? 'pin.expiredDraft' : 'pin.prompt'));
    return;
  }

  const attempts = (session?.failed_attempts ?? 0) + 1;
  const locked = attempts >= MAX_FAILED_ATTEMPTS;
  await sb.from('telegram_sessions').upsert({
    telegram_user_id: telegramUserId,
    expires_at: session?.expires_at ?? null,
    failed_attempts: locked ? 0 : attempts,
    locked_until: locked ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null,
  });

  if (locked) {
    await sendMessage(chatId, both('pin.wrongLocked', { minutes: LOCK_MINUTES }));
  } else {
    await sendMessage(chatId, both('pin.wrong', { attempts, max: MAX_FAILED_ATTEMPTS }));
  }
}

async function askLanguage(chatId: number) {
  await sendMessage(chatId, 'Выберите язык / Tilni tanlang:', [
    [
      { text: 'Русский', callback_data: 'lang:ru' },
      { text: "O'zbek tili", callback_data: 'lang:uz' },
    ],
  ]);
}

async function chooseLanguage(sb: SupabaseClient, session: Session, chatId: number, lang: Lang) {
  await sb.from('telegram_sessions').update({ lang, onboarding: 'name' }).eq('telegram_user_id', session.telegram_user_id);
  // Имя с прошлого входа предлагаем одной кнопкой — тот же человек входит каждый день.
  const buttons: InlineButton[][] | undefined = session.staff_name ? [[{ text: session.staff_name, callback_data: 'name:keep' }]] : undefined;
  await sendMessage(chatId, t(lang, 'name.ask'), buttons);
}

async function finishOnboarding(sb: SupabaseClient, session: Session, chatId: number, name: string) {
  await sb.from('telegram_sessions').update({ staff_name: name, onboarding: null }).eq('telegram_user_id', session.telegram_user_id);
  const lang = session.lang ?? 'ru';
  await sendMessage(chatId, t(lang, 'welcome', { name, help: raw(t(lang, 'help')) }));
  // Незавершённое действие (заказ, добавление товара), начатое до истечения
  // сессии, не теряется — бот напоминает о нём и продолжает с того же места.
  await resumeDraft({ sb, userId: session.telegram_user_id, chatId, lang, staff: name });
}

async function handleOnboardingText(sb: SupabaseClient, session: Session, chatId: number, text: string, step: OnboardingStep) {
  if (step === 'language') {
    await askLanguage(chatId);
    return;
  }
  const lang = session.lang ?? 'ru';
  const name = text.trim().replace(/\s+/g, ' ');
  if (!NAME_PATTERN.test(name)) {
    await sendMessage(chatId, t(lang, 'name.invalid'));
    return;
  }
  await finishOnboarding(sb, session, chatId, name);
}

// Повторно показывает текущий шаг незавершённого действия (с новыми кодами кнопок).
async function resumeDraft(ctx: Ctx) {
  const draft = await getDraft(ctx.sb, ctx.userId);
  if (!hasUnfinishedWork(draft) || !draft) return;
  await say(ctx, 'resume.notice');

  if (draft.flow === 'add_product') {
    await resumeAddProduct(ctx, draft);
    return;
  }

  const p = draft.pending;
  if (p?.type === 'pick_variant') return stepPick(ctx, p, draft.flow_data?.queue ?? []);
  if (p?.type === 'pick_client') return sendClientChoice(ctx, await rotatePending(ctx, p));
  if (p?.type === 'confirm_new_client') return sendNewClientConfirm(ctx, await rotatePending(ctx, p));
  if (p?.type === 'confirm_phone_dup') return sendPhoneDup(ctx, await rotatePending(ctx, p));
  if (draft.step === 'awaiting_qty' && draft.flow_data?.qty) {
    const outcome = await presentQty(ctx, draft);
    if (outcome === 'rejected') await continueOrSummary(ctx, draft.flow_data?.queue ?? []);
    return;
  }
  if (draft.step === 'awaiting_new_client_name') return say(ctx, 'order.askNewName');
  if (draft.step === 'awaiting_new_client_phone') return say(ctx, 'order.askNewPhone');
  if (draft.step === 'awaiting_client' || draft.step === 'awaiting_phone') return say(ctx, 'order.enterClient');
  await showOrderSummary(ctx);
}

async function rotatePending<T extends PendingState>(ctx: Ctx, pending: T): Promise<T> {
  const next = { ...pending, tok: newTok() };
  await updateDraft(ctx, { pending: next });
  return next;
}

// ---------------------------------------------------------------------------
// /sklad — просмотр склада: товар → цвет → размеры и остатки.
// Кнопки не зависят от черновика: всё нужное закодировано в callback_data.
// ---------------------------------------------------------------------------

interface ColorGroup {
  key: string;
  label: string | null;
  variants: ProductVariant[];
  total: number;
}

function groupByColor(variants: ProductVariant[]): ColorGroup[] {
  const groups = new Map<string, ProductVariant[]>();
  for (const v of variants) {
    const key = norm(v.color);
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  return Array.from(groups.entries())
    .map(([key, vs]) => ({
      key,
      // Одно и то же написание цвета показываем один раз («Белый» и «БЕЛЫЙ» — один цвет).
      label: vs[0].color ? canonicalValue(vs[0].color, vs.map((v) => v.color), 'color') : null,
      variants: vs,
      total: vs.reduce((sum, v) => sum + Number(v.stock_quantity), 0),
    }))
    .sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : (a.label ?? '').localeCompare(b.label ?? '', 'ru')));
}

async function showSkladRoot(ctx: Ctx, messageId?: number) {
  const variants = await loadFinishedVariants(ctx.sb);
  const products = new Map<string, { name: string; total: number }>();
  for (const v of variants) {
    const entry = products.get(v.product_id) ?? { name: v.product_name, total: 0 };
    entry.total += Number(v.stock_quantity);
    products.set(v.product_id, entry);
  }
  if (products.size === 0) {
    await present(ctx, messageId, tr(ctx, 'sklad.empty'));
    return;
  }
  const pcs = tr(ctx, 'pcs');
  const buttons: InlineButton[][] = Array.from(products.entries())
    .sort((a, b) => a[1].name.localeCompare(b[1].name, 'ru'))
    .map(([id, p]) => [{ text: `${p.name} — ${fmt(p.total)} ${pcs}`, callback_data: `sk:p:${id}` }]);
  await present(ctx, messageId, tr(ctx, 'sklad.title'), buttons);
}

async function showSkladProduct(ctx: Ctx, messageId: number | undefined, productId: string) {
  const variants = (await loadFinishedVariants(ctx.sb)).filter((v) => v.product_id === productId);
  if (variants.length === 0) {
    await present(ctx, messageId, tr(ctx, 'sklad.notFound'), [[{ text: tr(ctx, 'btn.toProducts'), callback_data: 'sk:b' }]]);
    return;
  }
  const pcs = tr(ctx, 'pcs');
  const groups = groupByColor(variants);
  const buttons: InlineButton[][] = groups.map((g, i) => [
    { text: `${g.label ?? tr(ctx, 'sklad.noColor')} — ${fmt(g.total)} ${pcs}`, callback_data: `sk:c:${productId}:${i}` },
  ]);
  buttons.push([{ text: tr(ctx, 'btn.toProducts'), callback_data: 'sk:b' }]);
  await present(ctx, messageId, tr(ctx, 'sklad.chooseColor', { product: variants[0].product_name }), buttons);
}

async function showSkladColor(ctx: Ctx, messageId: number | undefined, productId: string, colorIdx: number) {
  const variants = (await loadFinishedVariants(ctx.sb)).filter((v) => v.product_id === productId);
  const group = groupByColor(variants)[colorIdx];
  if (!group) {
    await showSkladProduct(ctx, messageId, productId);
    return;
  }
  // «Белый XL» и «БЕЛЫЙ XL» в базе — два варианта, но для просмотра это один
  // размер одного цвета, поэтому остатки одинаковых размеров суммируем.
  const bySize = new Map<string, { size: string | null; print: string | null; stock: number }>();
  for (const v of group.variants) {
    const key = `${norm(v.size)}|${v.print_type}`;
    const entry = bySize.get(key) ?? { size: v.size, print: v.print_type, stock: 0 };
    entry.stock += Number(v.stock_quantity);
    bySize.set(key, entry);
  }
  const lines = Array.from(bySize.values())
    .sort((a, b) => sizeRank(a.size) - sizeRank(b.size) || String(a.size ?? '').localeCompare(String(b.size ?? ''), 'ru'))
    .map((row) => {
      const status = stockStatus(row.stock);
      const icon = status === 'out' ? '❌ ' : status === 'low' ? '⚠️ ' : '';
      const size = row.size ?? tr(ctx, 'sklad.noSize');
      const print = row.print && row.print !== NO_PRINT ? ` (${row.print})` : '';
      return icon + tr(ctx, 'sklad.line', { size: size + print, qty: fmt(row.stock) });
    });
  const text = tr(ctx, 'sklad.color', {
    product: variants[0].product_name,
    color: group.label ?? tr(ctx, 'sklad.noColor'),
    lines: raw(lines.join('\n')),
    total: fmt(group.total),
  });
  await present(ctx, messageId, text, [
    [{ text: tr(ctx, 'btn.toColors'), callback_data: `sk:p:${productId}` }],
    [{ text: tr(ctx, 'btn.toProducts'), callback_data: 'sk:b' }],
  ]);
}

async function handleSkladCallback(ctx: Ctx, messageId: number | undefined, data: string) {
  const parts = data.split(':');
  if (parts[1] === 'b') return showSkladRoot(ctx, messageId);
  if (parts[1] === 'p' && parts[2]) return showSkladProduct(ctx, messageId, parts[2]);
  if (parts[1] === 'c' && parts[2] && parts[3] !== undefined) return showSkladColor(ctx, messageId, parts[2], Number(parts[3]));
  await say(ctx, 'unknownChoice');
}

// ---------------------------------------------------------------------------
// /new_order — заказ с немедленной выдачей (как «Уход» в вебе)
// ---------------------------------------------------------------------------

async function startNewOrder(ctx: Ctx) {
  const previous = await getDraft(ctx.sb, ctx.userId);
  const hadWork = !!previous && (previous.items?.length > 0 || previous.flow === 'add_product' || !!previous.flow_data?.qty);

  await ctx.sb.from('telegram_order_drafts').upsert({
    telegram_user_id: ctx.userId,
    step: 'awaiting_client',
    flow: 'order',
    client_id: null,
    client_name: null,
    client_phone: null,
    items: [],
    pending: null,
    flow_data: null,
    updated_at: now(),
  });
  await sendMessage(ctx.chatId, (hadWork ? tr(ctx, 'prevCancelled') : '') + tr(ctx, 'order.start'));
}

const itemsHelp = (ctx: Ctx) => raw(tr(ctx, 'order.itemsHelp'));

function clientLabel(c: { name: string; phone: string | null }) {
  return raw(`${escapeHtml(c.name)}${c.phone ? ' — ' + escapeHtml(c.phone) : ''}`);
}

async function selectClient(ctx: Ctx, client: ClientRef, created: boolean) {
  await updateDraft(ctx, {
    client_id: client.id,
    client_name: client.name,
    client_phone: client.phone,
    step: 'adding_items',
    pending: null,
  });
  await say(ctx, created ? 'order.clientCreated' : 'order.clientSelected', { client: clientLabel(client), help: itemsHelp(ctx) });
}

// Поиск по имени и по телефону. Телефон сравнивается по цифрам (последние 9),
// чтобы «+998 90 123 45 67», «901234567» и «998901234567» находили одного клиента.
// Без колонки phone_digits (миграция 014 не выполнена) ищет как раньше.
async function findClients(sb: SupabaseClient, q: string, rawQuery: string): Promise<ClientRef[]> {
  const base = `name.ilike.%${q}%,phone.ilike.%${q}%`;
  if (phoneDigits(rawQuery).length >= 4) {
    const res = await sb.from('clients').select('id, name, phone').or(`${base},phone_digits.ilike.%${phoneKey(rawQuery)}%`).limit(10);
    if (!res.error) return (res.data ?? []) as ClientRef[];
    console.error('telegram client search by digits failed, falling back', res.error.message);
  }
  const { data } = await sb.from('clients').select('id, name, phone').or(base).limit(10);
  return (data ?? []) as ClientRef[];
}

async function sendNewClientConfirm(ctx: Ctx, pending: { query: string; tok: string }) {
  await say(ctx, 'order.clientNotFound', { query: pending.query }, [
    [{ text: tr(ctx, 'order.newClientBtn'), callback_data: `new_client:yes:${pending.tok}` }],
    [{ text: tr(ctx, 'btn.cancel'), callback_data: `new_client:no:${pending.tok}` }],
  ]);
}

async function sendClientChoice(ctx: Ctx, pending: { candidates: ClientRef[]; tok: string }) {
  const buttons: InlineButton[][] = pending.candidates.map((c, i) => [
    { text: `${c.name}${c.phone ? ' — ' + c.phone : ''}`, callback_data: `pick_client:${i}:${pending.tok}` },
  ]);
  buttons.push([{ text: tr(ctx, 'order.newClientBtn'), callback_data: `new_client:yes:${pending.tok}` }]);
  await say(ctx, 'order.clientsFound', {}, buttons);
}

async function sendPhoneDup(ctx: Ctx, pending: { existing: ClientRef; tok: string }) {
  await say(ctx, 'order.phoneExists', { client: clientLabel(pending.existing) }, [
    [{ text: tr(ctx, 'order.useExistingBtn', { name: raw(pending.existing.name) }), callback_data: `dup:use:${pending.tok}` }],
    [{ text: tr(ctx, 'order.createAnywayBtn'), callback_data: `dup:new:${pending.tok}` }],
  ]);
}

async function handleClientSearch(ctx: Ctx, query: string) {
  const q = sanitizeIlike(query);
  if (!q) {
    await say(ctx, 'order.enterClient');
    return;
  }

  const clients = await findClients(ctx.sb, q, query);

  if (clients.length === 0) {
    const pending = { type: 'confirm_new_client' as const, query: query.trim(), tok: newTok() };
    await updateDraft(ctx, { pending });
    await sendNewClientConfirm(ctx, pending);
    return;
  }

  const pending = { type: 'pick_client' as const, candidates: clients, query: query.trim(), tok: newTok() };
  await updateDraft(ctx, { pending });
  await sendClientChoice(ctx, pending);
}

// Введённое похоже на телефон — дальше спрашиваем имя, иначе принимаем его за
// имя и спрашиваем телефон.
async function beginNewClient(ctx: Ctx, query: string) {
  if (looksLikePhone(query)) {
    await updateDraft(ctx, { client_phone: query, client_name: null, step: 'awaiting_new_client_name', pending: null });
    await say(ctx, 'order.askNewName');
  } else {
    await updateDraft(ctx, { client_name: query, client_phone: null, step: 'awaiting_new_client_phone', pending: null });
    await say(ctx, 'order.askNewPhone');
  }
}

async function insertClient(ctx: Ctx, name: string, phone: string | null) {
  const { data: client, error } = await ctx.sb.from('clients').insert({ name: name.trim(), phone }).select().single();
  if (error || !client) {
    await say(ctx, 'order.clientCreateFailed');
    return;
  }
  await selectClient(ctx, client, true);
}

// Перед созданием клиента проверяем, нет ли уже клиента с таким же телефоном
// (в другом формате): если есть, предлагаем использовать его, а не плодить дубль.
async function createClientAndContinue(ctx: Ctx, name: string, phone: string | null) {
  if (phone && phoneDigits(phone).length >= 7) {
    const { data, error } = await ctx.sb.from('clients').select('id, name, phone').ilike('phone_digits', `%${phoneKey(phone)}%`).limit(1);
    if (!error && data && data.length > 0) {
      const pending = { type: 'confirm_phone_dup' as const, name: name.trim(), phone, existing: data[0] as ClientRef, tok: newTok() };
      await updateDraft(ctx, { pending });
      await sendPhoneDup(ctx, pending);
      return;
    }
  }
  await insertClient(ctx, name, phone);
}

function qtyInDraft(items: DraftItem[] | null, variantId: string): number {
  return (items ?? []).find((it) => it.variantId === variantId)?.quantity ?? 0;
}

// Каждая позиция подтверждается количеством ДО добавления в заказ — так
// кладовщик успевает заметить лишний ноль. Бот показывает остаток и
// спрашивает: хватает — «На складе 50 шт. Взять 50?» с кнопкой «Взять 50»,
// не хватает — «Сколько забрать?» с кнопкой «Забрать <остаток>». Вместо
// кнопки можно написать другое число. В остаток входит то, что уже набрано
// в этом же заказе — списание произойдёт только при выдаче.
// 'wait' — бот ждёт ответа, 'rejected' — товара нет в наличии совсем.
async function proposeItem(
  ctx: Ctx,
  variant: VariantRef,
  requested: number,
  corrections?: Correction[],
  queue: string[] = []
): Promise<'wait' | 'rejected'> {
  const draft = await getDraft(ctx.sb, ctx.userId);
  if (!draft || draft.flow !== 'order') return 'rejected';
  const prompt: QtyPrompt = { ...variant, requested, corrections, tok: '' };
  return presentQty(ctx, { ...draft, flow_data: { qty: prompt, queue } });
}

// Показывает (или показывает заново) вопрос о количестве по draft.flow_data.qty.
// Каждый показ выдаёт новый код кнопок, поэтому старые кнопки перестают работать.
async function presentQty(ctx: Ctx, draft: Draft): Promise<'wait' | 'rejected'> {
  const prompt = draft.flow_data?.qty;
  if (!prompt) return 'rejected';
  const queue = draft.flow_data?.queue ?? [];

  const stock = await freshStock(ctx.sb, prompt.id);
  const already = qtyInDraft(draft.items, prompt.id);
  const available = stock - already;
  const title = raw(variantTitle(prompt));

  if (available <= 0) {
    const note = already > 0 ? tr(ctx, 'order.noStockNote', { stock: fmt(stock) }) : '';
    await say(ctx, 'order.noStock', { title, note: raw(note) });
    return 'rejected';
  }

  const tok = newTok();
  await updateDraft(ctx, { step: 'awaiting_qty', pending: null, flow_data: { qty: { ...prompt, tok }, queue } });
  const note = raw(already > 0 ? tr(ctx, 'order.qtyNote', { already: fmt(already) }) : '');
  const fix = fixNote(ctx, prompt.corrections);
  const skipRow = [{ text: tr(ctx, 'order.skipItem'), callback_data: `qty:skip:${tok}` }];

  if (prompt.requested > available) {
    await say(
      ctx,
      'order.qtyPrompt',
      { title, requested: fmt(prompt.requested), available: fmt(available), note, fix },
      [[{ text: tr(ctx, 'order.takeAll', { n: fmt(available) }), callback_data: `qty:all:${tok}` }], skipRow]
    );
  } else {
    await say(
      ctx,
      'order.qtyConfirm',
      { title, requested: fmt(prompt.requested), available: fmt(available), note, fix },
      [[{ text: tr(ctx, 'order.take', { n: fmt(prompt.requested) }), callback_data: `qty:ok:${tok}` }], skipRow]
    );
  }
  return 'wait';
}

async function addItemToDraft(ctx: Ctx, draft: Draft, variant: VariantRef, quantity: number) {
  const items = Array.isArray(draft.items) ? [...draft.items] : [];
  const idx = items.findIndex((it) => it.variantId === variant.id);
  if (idx >= 0) {
    items[idx] = { ...items[idx], quantity: items[idx].quantity + quantity };
  } else {
    items.push({
      variantId: variant.id,
      productName: variant.product_name,
      color: variant.color,
      size: variant.size,
      printType: variant.print_type,
      quantity,
    });
  }
  await updateDraft(ctx, { items, pending: null, step: 'adding_items', flow_data: null });
}

async function showOrderSummary(ctx: Ctx) {
  const draft = await getDraft(ctx.sb, ctx.userId);
  if (!draft || draft.flow !== 'order') return;
  if (!draft.items || draft.items.length === 0) {
    await say(ctx, 'order.summaryEmpty', { help: itemsHelp(ctx) });
    return;
  }
  const pcs = tr(ctx, 'pcs');
  const lines = draft.items.map((it) => `• ${itemTitle(it)} — ${fmt(it.quantity)} ${pcs}`);
  const rev = orderRev(draft);
  await say(
    ctx,
    'order.summary',
    { client: clientLabel({ name: draft.client_name ?? '', phone: draft.client_phone }), lines: raw(lines.join('\n')) },
    [
      [{ text: tr(ctx, 'order.issueBtn'), callback_data: `issue:yes:${rev}` }],
      [{ text: tr(ctx, 'btn.cancel'), callback_data: `issue:cancel:${rev}` }],
    ]
  );
}

// Текст ошибки разбора на языке пользователя.
function parseErrorText(ctx: Ctx, result: Extract<ParseResult, { kind: 'error' }>): string {
  const p = result.params;
  const list = (items: string[] | undefined) => (items && items.length > 0 ? items.join(', ') : '—');
  const params: Params = {
    line: p.line,
    tokens: (p.tokens ?? []).join(' '),
    products: list(p.products),
    product: p.productLabel ?? '',
    colors: list(p.colors),
    sizes: list(p.sizes),
  };
  const key: Record<typeof result.code, MessageKey> = {
    no_tokens: 'parse.noTokens',
    bad_quantity: 'parse.badQty',
    no_product: 'parse.noProduct',
    unrecognized: 'parse.unrecognized',
    no_variant: 'parse.noVariant',
  };
  return tr(ctx, key[result.code], params);
}

async function handleAddItems(ctx: Ctx, text: string) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  await processLines(ctx, lines, false);
}

// Пошаговый выбор варианта — та же логика, что в /sklad: товар → цвет → размеры
// с остатками. Уровни, где выбирать не из чего (один товар, один цвет),
// пропускаются, а когда остаётся единственный вариант, бот сразу задаёт вопрос о
// количестве. Навигация правит то же сообщение; каждый показ выдаёт новый код
// кнопок, поэтому старые кнопки перестают работать.
function pickScope(pool: ProductVariant[], nav: PickNav) {
  const products = new Map<string, string>();
  for (const v of pool) products.set(v.product_id, v.product_name);
  const productId = nav.product && products.has(nav.product) ? nav.product : products.size === 1 ? pool[0].product_id : undefined;
  const inProduct = productId ? pool.filter((v) => v.product_id === productId) : pool;
  const groups = groupByColor(inProduct);
  const group = nav.color !== undefined ? groups.find((g) => g.key === nav.color) : groups.length === 1 ? groups[0] : undefined;
  return { products, productId, inProduct, groups, group };
}

async function loadPickPool(ctx: Ctx, pending: PickVariantPending): Promise<ProductVariant[]> {
  const wanted = new Set(pending.ids);
  return (await loadFinishedVariants(ctx.sb)).filter((v) => wanted.has(v.id));
}

async function stepPick(ctx: Ctx, pending: PickVariantPending, queue: string[], messageId?: number) {
  const pool = await loadPickPool(ctx, pending);
  if (pool.length === 0) {
    await say(ctx, 'order.variantPickFailed');
    await continueOrSummary(ctx, queue);
    return;
  }

  const { products, productId, inProduct, groups, group } = pickScope(pool, pending.nav);
  const pcs = tr(ctx, 'pcs');
  const tok = newTok();
  const skipRow = [{ text: tr(ctx, 'order.skipItem'), callback_data: `pv:s:${tok}` }];
  const save = (nav: PickNav) => updateDraft(ctx, { pending: { ...pending, nav, tok } });

  // 1. Товар (только если строка подошла к нескольким товарам).
  if (!productId) {
    await save({});
    const buttons: InlineButton[][] = Array.from(products.entries())
      .sort((a, b) => a[1].localeCompare(b[1], 'ru'))
      .map(([id, name]) => {
        const total = pool.filter((v) => v.product_id === id).reduce((s, v) => s + Number(v.stock_quantity), 0);
        return [{ text: `${name} — ${fmt(total)} ${pcs}`, callback_data: `pv:p:${id}:${tok}` }];
      });
    buttons.push(skipRow);
    await present(ctx, messageId, tr(ctx, 'order.pickProduct', { line: pending.line }), buttons);
    return;
  }

  // 2. Цвет (только если у товара среди подходящих несколько цветов).
  if (!group) {
    await save({ product: productId });
    const buttons: InlineButton[][] = groups.map((g, i) => [
      { text: `${g.label ?? tr(ctx, 'sklad.noColor')} — ${fmt(g.total)} ${pcs}`, callback_data: `pv:c:${i}:${tok}` },
    ]);
    if (products.size > 1) buttons.push([{ text: tr(ctx, 'btn.toProducts'), callback_data: `pv:b:${tok}` }]);
    buttons.push(skipRow);
    await present(ctx, messageId, tr(ctx, 'order.pickColor', { product: inProduct[0].product_name, line: pending.line }), buttons);
    return;
  }

  // 3. Размеры выбранного цвета с остатками. Единственный вариант — сразу к количеству.
  const variants = group.variants;
  if (variants.length === 1) {
    await updateDraft(ctx, { pending: null });
    if (messageId) await removeKeyboard(ctx.chatId, messageId);
    const outcome = await proposeItem(ctx, refOf(variants[0]), pending.quantity, pending.corrections, queue);
    if (outcome === 'rejected') await continueOrSummary(ctx, queue);
    return;
  }

  await save({ product: productId, color: group.key });
  const sorted = [...variants].sort((a, b) => sizeRank(a.size) - sizeRank(b.size) || String(a.size ?? '').localeCompare(String(b.size ?? ''), 'ru'));
  const sizeKey = (v: ProductVariant) => `${norm(v.size)}|${v.print_type}`;
  const sameSize = new Map<string, number>();
  for (const v of sorted) sameSize.set(sizeKey(v), (sameSize.get(sizeKey(v)) ?? 0) + 1);
  const cells: InlineButton[] = sorted.map((v) => {
    const status = stockStatus(Number(v.stock_quantity));
    const icon = status === 'out' ? '❌ ' : status === 'low' ? '⚠️ ' : '';
    const size = v.size ?? tr(ctx, 'sklad.noSize');
    const print = v.print_type && v.print_type !== NO_PRINT ? ` (${v.print_type})` : '';
    // «Белый M» и «БЕЛЫЙ M» — два разных варианта в базе: различаем по написанию цвета.
    const dup = (sameSize.get(sizeKey(v)) ?? 0) > 1 && v.color ? ` [${v.color}]` : '';
    return { text: `${icon}${size}${print}${dup} — ${fmt(v.stock_quantity)} ${pcs}`, callback_data: `pv:v:${v.id}:${tok}` };
  });
  const buttons: InlineButton[][] = [];
  const perRow = cells.length > 4 ? 2 : 1;
  for (let i = 0; i < cells.length; i += perRow) buttons.push(cells.slice(i, i + perRow));
  if (groups.length > 1) buttons.push([{ text: tr(ctx, 'btn.toColors'), callback_data: `pv:b:${tok}` }]);
  else if (products.size > 1) buttons.push([{ text: tr(ctx, 'btn.toProducts'), callback_data: `pv:b:${tok}` }]);
  buttons.push(skipRow);
  await present(
    ctx,
    messageId,
    tr(ctx, 'order.pickSize', {
      product: inProduct[0].product_name,
      color: group.label ?? tr(ctx, 'sklad.noColor'),
      line: pending.line,
      qty: fmt(pending.quantity),
    }),
    buttons
  );
}

// Нажатия в пошаговом выборе: pv:p (товар), pv:c (цвет), pv:v (размер = вариант),
// pv:b (назад), pv:s (пропустить строку).
async function handlePickCallback(ctx: Ctx, draft: Draft, pending: PickVariantPending, base: string, messageId?: number) {
  const queue = draft.flow_data?.queue ?? [];
  const [, kind, arg] = base.split(':');

  if (kind === 's') {
    if (messageId) await removeKeyboard(ctx.chatId, messageId);
    await say(ctx, 'order.skipped');
    await continueOrSummary(ctx, queue);
    return;
  }

  const pool = await loadPickPool(ctx, pending);

  if (kind === 'v') {
    if (messageId) await removeKeyboard(ctx.chatId, messageId);
    const variant = pool.find((v) => v.id === arg);
    if (!variant) {
      await say(ctx, 'order.variantPickFailed');
      await stepPick(ctx, pending, queue);
      return;
    }
    await updateDraft(ctx, { pending: null });
    const outcome = await proposeItem(ctx, refOf(variant), pending.quantity, pending.corrections, queue);
    if (outcome === 'rejected') await continueOrSummary(ctx, queue);
    return;
  }

  const nav: PickNav = { ...pending.nav };
  const scope = pickScope(pool, nav);
  if (kind === 'p' && scope.products.has(arg)) {
    nav.product = arg;
    delete nav.color;
  } else if (kind === 'c' && scope.groups[Number(arg)]) {
    nav.color = scope.groups[Number(arg)].key;
  } else if (kind === 'b') {
    // Назад: с размеров — к цветам (если они были уровнем выбора), иначе к товарам.
    if (nav.color !== undefined && scope.groups.length > 1) delete nav.color;
    else {
      delete nav.product;
      delete nav.color;
    }
  }
  await stepPick(ctx, { ...pending, nav }, queue, messageId);
}

// Разбирает строки по очереди. Останавливается на первой строке, которой
// нужен ответ пользователя (выбор варианта или подтверждение количества),
// а остальные откладывает в очередь — они продолжатся после ответа.
// summaryAtEnd — показать итог заказа, если очередь закончилась без вопросов
// (после того как пользователь уже ответил на предыдущие).
async function processLines(ctx: Ctx, lines: string[], summaryAtEnd: boolean) {
  const variants = await loadFinishedVariants(ctx.sb);

  for (let i = 0; i < lines.length; i++) {
    const rest = lines.slice(i + 1);
    const result = parseOrderLine(lines[i], variants);
    await logParseEvents(ctx, lines[i], result.events);

    if (result.kind === 'error') {
      await sendMessage(ctx.chatId, parseErrorText(ctx, result));
    } else if (result.kind === 'exact') {
      const outcome = await proposeItem(ctx, refOf(result.variant), result.quantity, result.corrections, rest);
      if (outcome === 'wait') return;
    } else {
      const pending: PickVariantPending = {
        type: 'pick_variant',
        ids: result.all.map((v) => v.id),
        quantity: result.quantity,
        corrections: result.corrections,
        line: lines[i],
        nav: {},
        tok: newTok(),
      };
      await updateDraft(ctx, { pending, flow_data: { queue: rest } });
      await stepPick(ctx, pending, rest);
      return;
    }
  }

  if (summaryAtEnd) await showOrderSummary(ctx);
}

// Позиция разрешена (добавлена, пропущена или отклонена): берёмся за
// следующую строку очереди, а если очередь пуста — показываем итог заказа.
async function continueOrSummary(ctx: Ctx, queue: string[]) {
  await updateDraft(ctx, { step: 'adding_items', pending: null, flow_data: null });
  if (queue.length > 0) await processLines(ctx, queue, true);
  else await showOrderSummary(ctx);
}

// Ответ на вопрос о количестве: число, «Взять N» (ok — запрошенное),
// «Забрать <остаток>» (all) или «Пропустить».
async function resolveQty(ctx: Ctx, draft: Draft, choice: number | 'ok' | 'all' | 'skip') {
  const prompt = draft.flow_data?.qty;
  if (!prompt) {
    await say(ctx, 'order.noQtyPending');
    return;
  }
  const queue = draft.flow_data?.queue ?? [];

  if (choice === 'skip') {
    await say(ctx, 'order.skipped');
    await continueOrSummary(ctx, queue);
    return;
  }

  const stock = await freshStock(ctx.sb, prompt.id);
  const available = stock - qtyInDraft(draft.items, prompt.id);
  const quantity = choice === 'all' ? available : choice === 'ok' ? prompt.requested : choice;
  const title = raw(variantTitle(prompt));

  if (quantity <= 0) {
    await say(ctx, 'order.noStockLeft', { title });
    await continueOrSummary(ctx, queue);
    return;
  }
  if (quantity > available) {
    await say(ctx, 'order.qtyTooMany', { available: fmt(available) }, [
      [{ text: tr(ctx, 'order.takeAll', { n: fmt(available) }), callback_data: `qty:all:${prompt.tok}` }],
      [{ text: tr(ctx, 'order.skipItem'), callback_data: `qty:skip:${prompt.tok}` }],
    ]);
    return;
  }

  await addItemToDraft(ctx, draft, prompt, quantity);
  await say(ctx, 'order.added', { title, qty: fmt(quantity), stock: fmt(stock), fix: fixNote(ctx, prompt.corrections) });
  await continueOrSummary(ctx, queue);
}

async function restoreDraft(sb: SupabaseClient, draft: Draft) {
  await sb.from('telegram_order_drafts').upsert({
    telegram_user_id: draft.telegram_user_id,
    step: draft.step,
    flow: draft.flow,
    client_id: draft.client_id,
    client_name: draft.client_name,
    client_phone: draft.client_phone,
    items: draft.items,
    pending: draft.pending,
    flow_data: draft.flow_data,
    updated_at: now(),
  });
}

// Оформляет заказ так же, как «Уход» в вебе: создаёт заказ «Новый», кладёт
// позиции и только потом меняет статус на «Выдан» — списание остатка и
// метку issued_at делает существующий триггер базы, здесь их не дублируем.
// Вместе со статусом записывается имя кладовщика (issued_by_name).
async function issueOrder(ctx: Ctx) {
  const { sb } = ctx;
  const current = await getDraft(sb, ctx.userId);
  if (!current || current.flow !== 'order' || !current.client_id || !current.items || current.items.length === 0) {
    await say(ctx, 'order.empty');
    return;
  }
  if (current.step === 'awaiting_qty' || current.pending) {
    await say(ctx, 'order.finishChoice');
    return;
  }

  // «Забираем» черновик удалением: повторное нажатие кнопки не создаст второй заказ.
  const { data: claimed } = await sb
    .from('telegram_order_drafts')
    .delete()
    .eq('telegram_user_id', ctx.userId)
    .eq('flow', 'order')
    .select()
    .maybeSingle();
  const draft = claimed as Draft | null;
  if (!draft) {
    await say(ctx, 'order.alreadyDone');
    return;
  }

  // Остаток мог измениться, пока набирался заказ (веб, другой кладовщик).
  const variantIds = draft.items.map((it) => it.variantId);
  const { data: stockRows } = await sb.from('product_variants').select('id, stock_quantity, product_id').in('id', variantIds);
  const stockById = new Map((stockRows ?? []).map((r: { id: string; stock_quantity: number }) => [r.id, Number(r.stock_quantity)]));

  const adjustments: string[] = [];
  const reconciled: DraftItem[] = [];
  for (const it of draft.items) {
    const available = Math.max(stockById.get(it.variantId) ?? 0, 0);
    if (it.quantity <= available) {
      reconciled.push(it);
      continue;
    }
    const title = raw(itemTitle(it));
    adjustments.push(
      available > 0
        ? tr(ctx, 'order.adjReduced', { title, was: fmt(it.quantity), left: fmt(available) })
        : tr(ctx, 'order.adjRemoved', { title })
    );
    if (available > 0) reconciled.push({ ...it, quantity: available });
  }
  if (adjustments.length > 0) {
    await restoreDraft(sb, { ...draft, items: reconciled });
    await say(ctx, 'order.stockChanged', { adjustments: raw(adjustments.join('\n')) });
    await showOrderSummary(ctx);
    return;
  }

  const { data: order, error: orderError } = await sb
    .from('orders')
    .insert({ client_id: draft.client_id, status: 'new', comment: 'Выдан через Telegram-бота' })
    .select()
    .single();
  if (orderError || !order) {
    await restoreDraft(sb, draft);
    await say(ctx, 'order.createFailed');
    await showOrderSummary(ctx);
    return;
  }

  const productIdByVariant = new Map((stockRows ?? []).map((r: { id: string; product_id: string }) => [r.id, r.product_id]));
  const productIds = Array.from(new Set(Array.from(productIdByVariant.values())));
  const { data: products } = await sb.from('products').select('id, price').in('id', productIds);
  const priceByProduct = new Map((products ?? []).map((p: { id: string; price: number | null }) => [p.id, p.price ?? 0]));

  const orderItems = draft.items.map((it) => {
    const productId = productIdByVariant.get(it.variantId);
    return { order_id: order.id, variant_id: it.variantId, quantity: it.quantity, price: productId ? priceByProduct.get(productId) ?? 0 : 0 };
  });

  const { error: itemsError } = await sb.from('order_items').insert(orderItems);
  if (itemsError) {
    await sb.from('orders').delete().eq('id', order.id);
    await restoreDraft(sb, draft);
    await say(ctx, 'order.itemsFailed');
    await showOrderSummary(ctx);
    return;
  }

  // Смена статуса на «Выдан» запускает триггер списания.
  const { error: issueError } = await sb.from('orders').update({ status: 'issued', issued_by_name: ctx.staff }).eq('id', order.id);
  if (issueError) {
    await sb.from('orders').delete().eq('id', order.id);
    await restoreDraft(sb, draft);
    await say(ctx, issueError.message?.includes('insufficient_stock') ? 'order.raceFailed' : 'order.issueFailed');
    await showOrderSummary(ctx);
    return;
  }

  const { data: after } = await sb.from('product_variants').select('id, stock_quantity').in('id', variantIds);
  const remainingById = new Map((after ?? []).map((r: { id: string; stock_quantity: number }) => [r.id, Number(r.stock_quantity)]));
  const lines = draft.items.map((it) =>
    tr(ctx, 'order.issuedLine', { title: raw(itemTitle(it)), qty: fmt(it.quantity), left: fmt(remainingById.get(it.variantId) ?? 0) })
  );
  await say(ctx, 'order.issued', {
    client: draft.client_name ?? '',
    staff: ctx.staff,
    lines: raw(lines.join('\n')),
    url: `${APP_URL}/orders/${order.id}`,
  });
}

// Кнопки итога: действуют, только если состав заказа не изменился с момента
// показа этого итога. Иначе старая кнопка «Выдать» выдала бы то, чего кладовщик
// на том итоге не видел, — вместо этого бот показывает актуальный итог.
async function handleIssueCallback(ctx: Ctx, base: string, tok: string) {
  const draft = await getDraft(ctx.sb, ctx.userId);
  if (!draft || draft.flow !== 'order') {
    await say(ctx, 'order.alreadyDone');
    return;
  }
  if (orderRev(draft) !== tok) {
    await say(ctx, 'order.summaryChanged');
    await showOrderSummary(ctx);
    return;
  }
  if (base === 'issue:yes') {
    await issueOrder(ctx);
  } else {
    await ctx.sb.from('telegram_order_drafts').delete().eq('telegram_user_id', ctx.userId).eq('flow', 'order');
    await say(ctx, 'order.cancelled');
  }
}

// ---------------------------------------------------------------------------
// /add_product — добавление товара на склад: название → цвет → размер →
// количество → подтверждение
// ---------------------------------------------------------------------------

async function finishedProductNames(sb: SupabaseClient): Promise<string[]> {
  const { data: products } = await sb.from('products').select('name').eq('warehouse_type', 'finished_goods').order('name');
  return (products ?? []).map((p: { name: string }) => p.name);
}

async function sendNamePrompt(ctx: Ctx, names: string[], tok: string, prefix = '') {
  const buttons: InlineButton[][] = names.map((name, i) => [{ text: name, callback_data: `ap:n:${i}:${tok}` }]);
  await sendMessage(ctx.chatId, prefix + tr(ctx, 'ap.start'), buttons.length > 0 ? buttons : undefined);
}

async function startAddProduct(ctx: Ctx) {
  const previous = await getDraft(ctx.sb, ctx.userId);
  const hadWork = !!previous && (previous.items?.length > 0 || previous.flow === 'add_product' || !!previous.flow_data?.qty);

  const names = await finishedProductNames(ctx.sb);
  const tok = newTok();

  await ctx.sb.from('telegram_order_drafts').upsert({
    telegram_user_id: ctx.userId,
    step: 'ap_name',
    flow: 'add_product',
    client_id: null,
    client_name: null,
    client_phone: null,
    items: [],
    pending: null,
    flow_data: { ap: { options: names, tok } },
    updated_at: now(),
  });
  await sendNamePrompt(ctx, names, tok, hadWork ? tr(ctx, 'prevCancelled') : '');
}

async function loadProductVariants(sb: SupabaseClient, productName: string): Promise<{ id: string | null; variants: ProductVariant[] }> {
  const { data: products } = await sb.from('products').select('id, name');
  const product = (products ?? []).find((p: { name: string }) => norm(p.name) === norm(productName));
  const all = await loadFinishedVariants(sb);
  if (!product) return { id: null, variants: all };
  return { id: product.id, variants: all.filter((v) => v.product_id === product.id) };
}

async function askColor(ctx: Ctx, name: string) {
  const { id, variants } = await loadProductVariants(ctx.sb, name);
  const colors = Array.from(new Set(variants.map((v) => v.color).filter(Boolean) as string[]));
  const canonical = Array.from(new Map(colors.map((c) => [norm(c), canonicalValue(c, colors, 'color')])).values()).sort((a, b) =>
    a.localeCompare(b, 'ru')
  );
  const tok = newTok();
  await updateDraft(ctx, { step: 'ap_color', flow_data: { ap: { name, options: canonical, tok } } });

  const buttons: InlineButton[][] = canonical.map((c, i) => [{ text: c, callback_data: `ap:c:${i}:${tok}` }]);
  buttons.push([{ text: tr(ctx, 'ap.noColorBtn'), callback_data: `ap:c:none:${tok}` }]);
  await say(ctx, 'ap.color', { name, isNew: id ? '' : raw(tr(ctx, 'ap.new')) }, buttons);
}

async function askSize(ctx: Ctx, draft: Draft, color: string | null) {
  const ap = draft.flow_data?.ap ?? {};
  const { variants } = await loadProductVariants(ctx.sb, ap.name ?? '');
  const sizes = sortSizes(Array.from(new Set(variants.map((v) => v.size).filter(Boolean) as string[])));
  const tok = newTok();
  await updateDraft(ctx, { step: 'ap_size', flow_data: { ap: { name: ap.name, color, options: sizes, tok } } });

  const buttons: InlineButton[][] = [];
  for (let i = 0; i < sizes.length; i += 3) {
    buttons.push(sizes.slice(i, i + 3).map((s, j) => ({ text: s, callback_data: `ap:s:${i + j}:${tok}` })));
  }
  buttons.push([{ text: tr(ctx, 'ap.noSizeBtn'), callback_data: `ap:s:none:${tok}` }]);
  await say(ctx, 'ap.size', { color: color ?? tr(ctx, 'ap.noColorLabel') }, buttons);
}

async function askQuantity(ctx: Ctx, draft: Draft, size: string | null) {
  const ap = draft.flow_data?.ap ?? {};
  await updateDraft(ctx, { step: 'ap_qty', flow_data: { ap: { name: ap.name, color: ap.color, size, tok: newTok() } } });
  await say(ctx, 'ap.qty', { size: size ?? tr(ctx, 'ap.noSizeLabel') });
}

// Введённое значение похоже на существующее, но не совпадает: спрашиваем, не
// его ли имелось в виду, прежде чем создавать новый товар или цвет.
async function askSimilar(ctx: Ctx, kind: 'name' | 'color', typed: string, options: string[]) {
  const draft = await getDraft(ctx.sb, ctx.userId);
  const ap = draft?.flow_data?.ap ?? {};
  const tok = newTok();
  await updateDraft(ctx, { flow_data: { ap: { ...ap, suggest: { kind, typed, options }, tok } } });

  const buttons: InlineButton[][] = options.map((o, i) => [{ text: o, callback_data: `ap:sim:${i}:${tok}` }]);
  buttons.push([{ text: tr(ctx, 'ap.createNewBtn', { typed: raw(typed) }), callback_data: `ap:sim:new:${tok}` }]);
  await say(ctx, kind === 'name' ? 'ap.similarName' : 'ap.similarColor', { typed }, buttons);
}

// Итог перед записью на склад: видно, что именно и сколько добавится, что
// товар/цвет/размер новые и как изменится остаток уже существующего варианта.
async function askConfirm(ctx: Ctx, draft: Draft, quantity: number) {
  const ap = draft.flow_data?.ap;
  if (!ap?.name) {
    await say(ctx, 'ap.missingData');
    return;
  }
  const color = ap.color ?? null;
  const size = ap.size ?? null;
  const { id, variants } = await loadProductVariants(ctx.sb, ap.name);

  let flags = '';
  let stock = '';
  if (!id) {
    flags += tr(ctx, 'ap.flagNewProduct');
  } else {
    if (color && !variants.some((v) => norm(v.color) === norm(color))) flags += tr(ctx, 'ap.flagNewColor');
    if (size && !variants.some((v) => norm(v.size) === norm(size))) flags += tr(ctx, 'ap.flagNewSize');
    const existing = variants.find((v) => norm(v.color) === norm(color) && norm(v.size) === norm(size) && v.print_type === NO_PRINT);
    if (existing) {
      const before = Number(existing.stock_quantity);
      stock = tr(ctx, 'ap.stockChange', { before: fmt(before), after: fmt(before + quantity) });
    }
  }

  const tok = newTok();
  await updateDraft(ctx, { step: 'ap_confirm', flow_data: { ap: { name: ap.name, color, size, qty: quantity, tok } } });
  const label = variantLabel({ color, size, print_type: NO_PRINT });
  const title = raw(`${escapeHtml(ap.name)}${label ? ' — ' + escapeHtml(label) : ''}`);
  await say(ctx, 'ap.confirm', { title, qty: fmt(quantity), flags: raw(flags), stock: raw(stock) }, [
    [{ text: tr(ctx, 'ap.saveBtn'), callback_data: `ap:ok:${tok}` }],
    [{ text: tr(ctx, 'btn.cancel'), callback_data: `ap:no:${tok}` }],
  ]);
}

async function finalizeProduct(ctx: Ctx, draft: Draft) {
  const { sb } = ctx;
  const ap = draft.flow_data?.ap;
  const quantity = ap?.qty;
  if (!ap?.name || !quantity) {
    await say(ctx, 'ap.missingData');
    return;
  }
  const color = ap.color ?? null;
  const size = ap.size ?? null;

  const { data: products } = await sb.from('products').select('id, name');
  let productId: string | null = (products ?? []).find((p: { name: string }) => norm(p.name) === norm(ap.name!))?.id ?? null;

  if (!productId) {
    const { data: created, error } = await sb
      .from('products')
      .insert({ name: ap.name, price: 0, warehouse_type: 'finished_goods' })
      .select('id')
      .single();
    if (created) {
      productId = created.id;
    } else {
      // Мог создать параллельный запрос (уникальный индекс по названию) — перечитываем.
      const { data: again } = await sb.from('products').select('id, name');
      productId = (again ?? []).find((p: { name: string }) => norm(p.name) === norm(ap.name!))?.id ?? null;
      if (!productId) {
        console.error('telegram add_product: create product failed', error);
        await say(ctx, 'ap.createProductFailed');
        return;
      }
    }
  }

  const label = variantLabel({ color, size, print_type: NO_PRINT });
  const title = raw(`${escapeHtml(ap.name)}${label ? ' — ' + escapeHtml(label) : ''}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: existingRows } = await sb
      .from('product_variants')
      .select('id, color, size, print_type, stock_quantity')
      .eq('product_id', productId);
    const existing = (existingRows ?? []).find(
      (v: { color: string | null; size: string | null; print_type: string }) =>
        norm(v.color) === norm(color) && norm(v.size) === norm(size) && v.print_type === NO_PRINT
    );

    if (existing) {
      const before = Number(existing.stock_quantity);
      // Обновление «по старому значению» — чтобы параллельное списание не потерялось.
      const { data: updated } = await sb
        .from('product_variants')
        .update({ stock_quantity: before + quantity })
        .eq('id', existing.id)
        .eq('stock_quantity', existing.stock_quantity)
        .select('id');
      if (!updated || updated.length === 0) continue;

      await sb.from('telegram_order_drafts').delete().eq('telegram_user_id', ctx.userId);
      await say(ctx, 'ap.doneExisting', { title, after: fmt(before + quantity), before: fmt(before), added: fmt(quantity) });
      return;
    }

    const { error } = await sb.from('product_variants').insert({
      product_id: productId,
      color,
      size,
      print_type: NO_PRINT,
      unit: 'шт',
      stock_quantity: quantity,
    });
    if (error) {
      // Вариант могли создать между проверкой и вставкой — пробуем ещё раз как «уже был».
      if (attempt < 2) continue;
      console.error('telegram add_product: insert variant failed', error);
      await say(ctx, 'ap.saveFailed');
      return;
    }

    await sb.from('telegram_order_drafts').delete().eq('telegram_user_id', ctx.userId);
    await say(ctx, 'ap.doneNew', { title, qty: fmt(quantity) });
    return;
  }

  await say(ctx, 'ap.raced');
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function handleAddProductText(ctx: Ctx, draft: Draft, text: string) {
  if (draft.step === 'ap_name') {
    const { data: products } = await ctx.sb.from('products').select('name');
    const names = (products ?? []).map((p: { name: string }) => p.name);
    const typed = text.trim().replace(/\s+/g, ' ');
    const existing = names.find((n: string) => sameProductName(typed, n));
    if (existing) return askColor(ctx, existing);
    const created = capitalize(typed);
    const similar = findSimilar(created, names);
    if (similar.length > 0) return askSimilar(ctx, 'name', created, similar);
    return askColor(ctx, created);
  }

  if (draft.step === 'ap_color') {
    const all = await loadFinishedVariants(ctx.sb);
    const known = all.map((v) => v.color);
    const color = canonicalValue(text, known, 'color');
    const knownList = Array.from(new Set(known.filter(Boolean) as string[]));
    const exists = knownList.some((c) => norm(c) === norm(color));
    if (!exists) {
      const similar = findSimilar(color, knownList);
      if (similar.length > 0) return askSimilar(ctx, 'color', color, similar);
    }
    return askSize(ctx, draft, color);
  }

  if (draft.step === 'ap_size') {
    const all = await loadFinishedVariants(ctx.sb);
    const size = canonicalValue(text, all.map((v) => v.size), 'size');
    return askQuantity(ctx, draft, size);
  }

  if (draft.step === 'ap_qty' || draft.step === 'ap_confirm') {
    const quantity = parsePositiveNumber(text);
    if (!quantity) {
      await say(ctx, draft.step === 'ap_qty' ? 'ap.qtyInvalid' : 'ap.confirmHint');
      return;
    }
    return askConfirm(ctx, draft, quantity);
  }

  await say(ctx, 'ap.startOver');
}

async function handleAddProductCallback(ctx: Ctx, draft: Draft | null, base: string, tok: string) {
  const ap = draft?.flow_data?.ap;
  if (!draft || draft.flow !== 'add_product' || !ap || ap.tok !== tok) {
    await say(ctx, 'ap.stale');
    return;
  }
  const [, kind, rawIdx] = base.split(':');

  if (kind === 'ok' && draft.step === 'ap_confirm') return finalizeProduct(ctx, draft);
  if (kind === 'no' && draft.step === 'ap_confirm') {
    await ctx.sb.from('telegram_order_drafts').delete().eq('telegram_user_id', ctx.userId);
    await say(ctx, 'ap.cancelled');
    return;
  }

  if (kind === 'sim' && ap.suggest) {
    const chosen = rawIdx === 'new' ? ap.suggest.typed : ap.suggest.options[Number(rawIdx)];
    if (chosen === undefined) {
      await say(ctx, 'ap.pickFailed');
      return;
    }
    if (ap.suggest.kind === 'name') return askColor(ctx, chosen);
    return askSize(ctx, draft, chosen);
  }

  const picked = rawIdx === 'none' ? null : (ap.options ?? [])[Number(rawIdx)];
  if (rawIdx !== 'none' && picked === undefined) {
    await say(ctx, 'ap.pickFailed');
    return;
  }

  if (kind === 'n' && draft.step === 'ap_name' && picked) await askColor(ctx, picked);
  else if (kind === 'c' && draft.step === 'ap_color') await askSize(ctx, draft, picked);
  else if (kind === 's' && draft.step === 'ap_size') await askQuantity(ctx, draft, picked);
  else await say(ctx, 'ap.staleStep');
}

// Повторно показывает текущий шаг /add_product (после повторного входа).
async function resumeAddProduct(ctx: Ctx, draft: Draft) {
  const ap = draft.flow_data?.ap ?? {};
  if (ap.suggest) return askSimilar(ctx, ap.suggest.kind, ap.suggest.typed, ap.suggest.options);

  if (draft.step === 'ap_name') {
    const names = await finishedProductNames(ctx.sb);
    const tok = newTok();
    await updateDraft(ctx, { flow_data: { ap: { options: names, tok } } });
    return sendNamePrompt(ctx, names, tok);
  }
  if (draft.step === 'ap_color' && ap.name) return askColor(ctx, ap.name);
  if (draft.step === 'ap_size') return askSize(ctx, draft, ap.color ?? null);
  if (draft.step === 'ap_qty') return say(ctx, 'ap.qty', { size: ap.size ?? tr(ctx, 'ap.noSizeLabel') });
  if (draft.step === 'ap_confirm' && ap.qty) return askConfirm(ctx, draft, ap.qty);
  await say(ctx, 'ap.startOver');
}

// ---------------------------------------------------------------------------
// /history_orders — последние выданные заказы
// ---------------------------------------------------------------------------

interface VariantRefRow {
  color: string | null;
  size: string | null;
  print_type: string | null;
  products: { name: string } | { name: string }[] | null;
}

async function showHistory(ctx: Ctx) {
  const { data: orders, error } = await ctx.sb
    .from('orders')
    .select('id, issued_at, issued_by_name, clients(name), order_items(quantity, product_variants(color, size, print_type, products(name)))')
    .eq('status', 'issued')
    .order('issued_at', { ascending: false, nullsFirst: false })
    .limit(HISTORY_LIMIT);

  if (error) {
    console.error('telegram history failed', error);
    await say(ctx, 'history.error');
    return;
  }
  if (!orders || orders.length === 0) {
    await say(ctx, 'history.empty');
    return;
  }

  const dateFormat = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE,
  });

  const blocks = orders.map((o) => {
    const client = one(o.clients as { name: string } | { name: string }[] | null);
    const items = ((o.order_items ?? []) as { quantity: number; product_variants: unknown }[]).filter((it) => Number(it.quantity) > 0);
    const shown = items.slice(0, HISTORY_ITEMS_PER_ORDER).map((it) => {
      const v = one(it.product_variants as VariantRefRow | VariantRefRow[] | null);
      const product = one(v?.products ?? null);
      const title = variantTitle({
        product_name: product?.name ?? tr(ctx, 'history.product'),
        color: v?.color ?? null,
        size: v?.size ?? null,
        print_type: v?.print_type ?? null,
      });
      return `  • ${title} × ${fmt(it.quantity)}`;
    });
    if (items.length > shown.length) shown.push(tr(ctx, 'history.more', { n: items.length - shown.length }));
    if (shown.length === 0) shown.push(tr(ctx, 'history.noItems'));

    const when = o.issued_at ? dateFormat.format(new Date(o.issued_at)) : '—';
    const by = o.issued_by_name ? tr(ctx, 'history.by', { name: o.issued_by_name }) : '';
    return `<b>${when}</b> — ${escapeHtml(client?.name ?? tr(ctx, 'history.client'))}${by}\n${shown.join('\n')}`;
  });

  await sendBlocks(ctx.chatId, [tr(ctx, 'history.title', { n: orders.length }), ...blocks]);
}

// ---------------------------------------------------------------------------
// Маршрутизация
// ---------------------------------------------------------------------------

async function handleCallbackQuery(sb: SupabaseClient, cq: TelegramCallbackQuery) {
  const userId = cq.from.id;
  const chatId = cq.message?.chat.id;
  if (!chatId) return;

  await answerCallbackQuery(cq.id);

  const session = await getSession(sb, userId);
  if (!session || !isLoggedIn(session)) {
    await sendMessage(chatId, both('sessionExpired'));
    return;
  }

  const data = cq.data ?? '';

  // Вход: выбор языка и «то же имя, что вчера».
  const step = onboardingStep(session);
  if (step) {
    if (step === 'language' && (data === 'lang:ru' || data === 'lang:uz')) {
      await chooseLanguage(sb, session, chatId, data === 'lang:ru' ? 'ru' : 'uz');
    } else if (step === 'name' && data === 'name:keep' && session.staff_name) {
      await finishOnboarding(sb, session, chatId, session.staff_name);
    } else if (step === 'language') {
      await askLanguage(chatId);
    } else {
      await sendMessage(chatId, t(session.lang ?? 'ru', 'name.ask'));
    }
    return;
  }
  if (data.startsWith('lang:') || data.startsWith('name:')) return; // устаревшая кнопка входа

  const ctx: Ctx = { sb, userId, chatId, lang: session.lang!, staff: session.staff_name! };
  await withUserLock(sb, userId, () => routeCallback(ctx, cq));
}

async function routeCallback(ctx: Ctx, cq: TelegramCallbackQuery) {
  const { sb, userId } = ctx;
  const data = cq.data ?? '';
  const messageId = cq.message?.message_id;

  // Навигация по складу ничего не меняет и не привязана к вопросам.
  if (data.startsWith('sk:')) {
    await handleSkladCallback(ctx, messageId, data);
    return;
  }

  // Остальные кнопки — ответы на вопросы бота. Нажатую кнопку сразу убираем с
  // экрана, а принимается ответ, только если код вопроса совпал с текущим.
  const { base, tok } = splitCallback(data);
  // Навигация по выбору варианта правит то же сообщение, там кнопки не убираем.
  if (messageId && !base.startsWith('pv:')) await removeKeyboard(ctx.chatId, messageId);

  if (base === 'issue:yes' || base === 'issue:cancel') {
    await handleIssueCallback(ctx, base, tok);
    return;
  }

  const draft = await getDraft(sb, userId);

  if (base.startsWith('ap:')) {
    await handleAddProductCallback(ctx, draft, base, tok);
    return;
  }

  if (base.startsWith('qty:')) {
    if (!draft || draft.flow !== 'order' || draft.step !== 'awaiting_qty' || draft.flow_data?.qty?.tok !== tok) {
      await say(ctx, 'staleAction');
      return;
    }
    await resolveQty(ctx, draft, base === 'qty:all' ? 'all' : base === 'qty:ok' ? 'ok' : 'skip');
    return;
  }

  if (!draft || draft.flow !== 'order' || !draft.pending) {
    await say(ctx, 'noActiveChoice');
    return;
  }
  const pending = draft.pending;
  if (pending.tok !== tok) {
    await say(ctx, 'staleAction');
    return;
  }

  if (base === 'new_client:no') {
    await updateDraft(ctx, { pending: null, client_phone: null, client_name: null, step: 'awaiting_client' });
    await say(ctx, 'order.reenterClient');
    return;
  }

  if (base === 'new_client:yes' && (pending.type === 'confirm_new_client' || pending.type === 'pick_client')) {
    await beginNewClient(ctx, pending.query);
    return;
  }

  if (base.startsWith('pick_client:') && pending.type === 'pick_client') {
    const client = pending.candidates[Number(base.split(':')[1])];
    if (!client) {
      await say(ctx, 'order.clientPickFailed');
      return;
    }
    await selectClient(ctx, client, false);
    return;
  }

  if (pending.type === 'confirm_phone_dup' && (base === 'dup:use' || base === 'dup:new')) {
    if (base === 'dup:use') await selectClient(ctx, pending.existing, false);
    else await insertClient(ctx, pending.name, pending.phone);
    return;
  }

  if (base.startsWith('pv:') && pending.type === 'pick_variant') {
    await handlePickCallback(ctx, draft, pending, base, messageId);
    return;
  }

  // Кнопки прежнего плоского списка (до обновления бота) — устарели.
  if (base.startsWith('pick_variant:')) {
    await say(ctx, 'staleAction');
    return;
  }

  await say(ctx, 'unknownChoice');
}

export async function handleUpdate(update: TelegramUpdate) {
  let sb: SupabaseClient;
  try {
    sb = serviceClient();
  } catch (err) {
    console.error('telegramBot: service client unavailable', err);
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chatId) await sendMessage(chatId, both('notConfigured'));
    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(sb, update.callback_query);
    return;
  }

  const message = update.message;
  if (!message || typeof message.text !== 'string') return;

  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text.trim();

  const session = await getSession(sb, userId);
  if (!session || !isLoggedIn(session)) {
    await handlePinAttempt(sb, userId, chatId, text);
    return;
  }

  const step = onboardingStep(session);
  if (step) {
    await handleOnboardingText(sb, session, chatId, text, step);
    return;
  }

  const ctx: Ctx = { sb, userId, chatId, lang: session.lang!, staff: session.staff_name! };
  await withUserLock(sb, userId, () => routeMessage(ctx, text));
}

async function routeMessage(ctx: Ctx, text: string) {
  const { sb, userId } = ctx;

  if (text.startsWith('/')) {
    // В группах Telegram дописывает имя бота: /sklad@my_bot.
    const cmd = text.split(/\s+/)[0].split('@')[0];
    if (cmd === '/start') {
      await say(ctx, 'help');
    } else if (cmd === '/sklad') {
      await showSkladRoot(ctx);
    } else if (cmd === '/add_product') {
      await startAddProduct(ctx);
    } else if (cmd === '/new_order') {
      await startNewOrder(ctx);
    } else if (cmd === '/history_orders') {
      await showHistory(ctx);
    } else if (cmd === '/confirm') {
      await issueOrder(ctx);
    } else if (cmd === '/cancel') {
      await sb.from('telegram_order_drafts').delete().eq('telegram_user_id', userId);
      await say(ctx, 'cancelled');
    } else {
      await say(ctx, 'unknownCommand', { help: raw(tr(ctx, 'help')) });
    }
    return;
  }

  const draft = await getDraft(sb, userId);
  if (!draft) {
    await say(ctx, 'noActiveAction', { help: raw(tr(ctx, 'help')) });
    return;
  }

  if (draft.flow === 'add_product') {
    await handleAddProductText(ctx, draft, text);
    return;
  }

  if (draft.pending) {
    await say(ctx, 'pickFirst');
    return;
  }

  // 'awaiting_phone' — прежнее название шага из миграции 011.
  if (draft.step === 'awaiting_client' || draft.step === 'awaiting_phone') {
    await handleClientSearch(ctx, text);
  } else if (draft.step === 'awaiting_new_client_name') {
    await createClientAndContinue(ctx, text, draft.client_phone);
  } else if (draft.step === 'awaiting_new_client_phone') {
    const phone = text.trim() === '-' ? null : text.trim();
    await createClientAndContinue(ctx, draft.client_name ?? '', phone);
  } else if (draft.step === 'awaiting_qty') {
    const quantity = parsePositiveNumber(text);
    if (quantity === null) {
      await say(ctx, 'order.qtyNotNumber');
      return;
    }
    await resolveQty(ctx, draft, quantity);
  } else if (draft.step === 'adding_items') {
    await handleAddItems(ctx, text);
  } else {
    await say(ctx, 'startOrder');
  }
}
