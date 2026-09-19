import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { NO_PRINT, ProductVariant, stockStatus, variantLabel } from '@/lib/types';
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  escapeHtml,
  InlineButton,
  TelegramUpdate,
  TelegramCallbackQuery,
} from '@/lib/telegram';
import {
  canonicalValue,
  Correction,
  norm,
  parseOrderLine,
  ParseEvent,
  ParseResult,
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

// Кнопочный выбор, которого бот ждёт от пользователя.
type PendingState =
  | { type: 'confirm_new_client'; query: string }
  | { type: 'pick_client'; candidates: { id: string; name: string; phone: string | null }[]; query: string }
  | { type: 'pick_variant'; candidates: { variant: ProductVariant }[]; quantity: number; corrections?: Correction[] };

// Позиция, по которой запрошено больше, чем есть; бот ждёт нового количества.
interface QtyPrompt extends VariantRef {
  requested: number;
  corrections?: Correction[];
}

interface ProductFlowData {
  name?: string;
  color?: string | null;
  size?: string | null;
  // Значения, показанные кнопками на текущем шаге (индекс из callback_data).
  options?: string[];
}

interface FlowData {
  qty?: QtyPrompt;
  ap?: ProductFlowData;
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

function looksLikePhone(input: string): boolean {
  return /^[+\d\s\-()]+$/.test(input) && input.replace(/\D/g, '').length >= 5;
}

function parsePositiveNumber(input: string): number | null {
  const m = input.trim().match(/^(\d+(?:[.,]\d+)?)\s*(?:шт|штук[аи]?|ta|dona)?\.?$/i);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  return value > 0 ? value : null;
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

async function loadFinishedVariants(sb: SupabaseClient): Promise<ProductVariant[]> {
  const { data } = await sb.from('product_variants_view').select('*').eq('warehouse_type', 'finished_goods').limit(1000);
  return (data ?? []) as ProductVariant[];
}

async function freshStock(sb: SupabaseClient, variantId: string): Promise<number> {
  const { data } = await sb.from('product_variants').select('stock_quantity').eq('id', variantId).maybeSingle();
  return Number(data?.stock_quantity ?? 0);
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

  // /start и любые команды до входа просто просят PIN и не считаются неверной попыткой.
  if (text.startsWith('/')) {
    await sendMessage(chatId, both('pin.prompt'));
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
  const hadWork = !!previous && (previous.items?.length > 0 || previous.flow === 'add_product');

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

async function selectClient(ctx: Ctx, client: { id: string; name: string; phone: string | null }, created: boolean) {
  await updateDraft(ctx, {
    client_id: client.id,
    client_name: client.name,
    client_phone: client.phone,
    step: 'adding_items',
    pending: null,
  });
  await say(ctx, created ? 'order.clientCreated' : 'order.clientSelected', { client: clientLabel(client), help: itemsHelp(ctx) });
}

async function handleClientSearch(ctx: Ctx, query: string) {
  const q = sanitizeIlike(query);
  if (!q) {
    await say(ctx, 'order.enterClient');
    return;
  }

  const { data: clients } = await ctx.sb.from('clients').select('id, name, phone').or(`name.ilike.%${q}%,phone.ilike.%${q}%`).limit(10);

  if (!clients || clients.length === 0) {
    await updateDraft(ctx, { pending: { type: 'confirm_new_client', query: query.trim() } });
    await say(ctx, 'order.clientNotFound', { query: query.trim() }, [
      [{ text: tr(ctx, 'order.newClientBtn'), callback_data: 'new_client:yes' }],
      [{ text: tr(ctx, 'btn.cancel'), callback_data: 'new_client:no' }],
    ]);
    return;
  }

  await updateDraft(ctx, { pending: { type: 'pick_client', candidates: clients, query: query.trim() } });
  const buttons: InlineButton[][] = clients.map((c, i) => [
    { text: `${c.name}${c.phone ? ' — ' + c.phone : ''}`, callback_data: `pick_client:${i}` },
  ]);
  buttons.push([{ text: tr(ctx, 'order.newClientBtn'), callback_data: 'new_client:yes' }]);
  await say(ctx, 'order.clientsFound', {}, buttons);
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

async function createClientAndContinue(ctx: Ctx, name: string, phone: string | null) {
  const { data: client, error } = await ctx.sb.from('clients').insert({ name: name.trim(), phone }).select().single();
  if (error || !client) {
    await say(ctx, 'order.clientCreateFailed');
    return;
  }
  await selectClient(ctx, client, true);
}

function qtyInDraft(items: DraftItem[] | null, variantId: string): number {
  return (items ?? []).find((it) => it.variantId === variantId)?.quantity ?? 0;
}

// Проверяет остаток в момент ввода позиции и либо добавляет её в заказ,
// либо спрашивает, сколько забрать. В остаток входит то, что уже набрано в
// этом же заказе — списание произойдёт только при выдаче.
async function proposeItem(
  ctx: Ctx,
  variant: VariantRef,
  requested: number,
  corrections?: Correction[]
): Promise<'added' | 'wait' | 'rejected'> {
  const draft = await getDraft(ctx.sb, ctx.userId);
  if (!draft || draft.flow !== 'order') return 'rejected';

  const stock = await freshStock(ctx.sb, variant.id);
  const already = qtyInDraft(draft.items, variant.id);
  const available = stock - already;
  const title = raw(variantTitle(variant));

  if (available <= 0) {
    const note = already > 0 ? tr(ctx, 'order.noStockNote', { stock: fmt(stock) }) : '';
    await say(ctx, 'order.noStock', { title, note: raw(note) });
    return 'rejected';
  }

  if (requested > available) {
    const prompt: QtyPrompt = { ...variant, requested, corrections };
    await updateDraft(ctx, { step: 'awaiting_qty', flow_data: { qty: prompt } });
    const note = already > 0 ? tr(ctx, 'order.qtyNote', { already: fmt(already) }) : '';
    await say(
      ctx,
      'order.qtyPrompt',
      { title, requested: fmt(requested), available: fmt(available), note: raw(note), fix: fixNote(ctx, corrections) },
      [
        [{ text: tr(ctx, 'order.takeAll', { n: fmt(available) }), callback_data: 'qty:all' }],
        [{ text: tr(ctx, 'order.skipItem'), callback_data: 'qty:skip' }],
      ]
    );
    return 'wait';
  }

  await addItemToDraft(ctx, draft, variant, requested);
  await say(ctx, 'order.added', { title, qty: fmt(requested), stock: fmt(stock), fix: fixNote(ctx, corrections) });
  return 'added';
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
  await say(
    ctx,
    'order.summary',
    { client: clientLabel({ name: draft.client_name ?? '', phone: draft.client_phone }), lines: raw(lines.join('\n')) },
    [
      [{ text: tr(ctx, 'order.issueBtn'), callback_data: 'issue:yes' }],
      [{ text: tr(ctx, 'btn.cancel'), callback_data: 'issue:cancel' }],
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
  const variants = await loadFinishedVariants(ctx.sb);

  let addedAny = false;
  for (let i = 0; i < lines.length; i++) {
    const result = parseOrderLine(lines[i], variants);
    await logParseEvents(ctx, lines[i], result.events);
    let waiting = false;

    if (result.kind === 'error') {
      await sendMessage(ctx.chatId, parseErrorText(ctx, result));
    } else if (result.kind === 'exact') {
      const outcome = await proposeItem(ctx, refOf(result.variant), result.quantity, result.corrections);
      if (outcome === 'added') addedAny = true;
      waiting = outcome === 'wait';
    } else {
      await updateDraft(ctx, {
        pending: {
          type: 'pick_variant',
          candidates: result.candidates.map((variant) => ({ variant })),
          quantity: result.quantity,
          corrections: result.corrections,
        },
      });
      const buttons: InlineButton[][] = result.candidates.map((v, idx) => [
        { text: `${v.product_name} — ${variantLabel(v) ?? '—'} (${fmt(v.stock_quantity)} ${tr(ctx, 'pcs')})`, callback_data: `pick_variant:${idx}` },
      ]);
      const note = result.truncated ? raw(tr(ctx, 'order.truncated', result.truncated)) : '';
      await say(ctx, 'order.pickVariant', { line: lines[i], note }, buttons);
      waiting = true;
    }

    if (waiting) {
      const remaining = lines.length - i - 1;
      if (remaining > 0) await say(ctx, 'order.restLines', { n: remaining });
      return;
    }
  }

  if (addedAny) await showOrderSummary(ctx);
}

// Ответ на «Сколько забрать?»: число или кнопка.
async function resolveQty(ctx: Ctx, draft: Draft, choice: number | 'all' | 'skip') {
  const prompt = draft.flow_data?.qty;
  if (!prompt) {
    await say(ctx, 'order.noQtyPending');
    return;
  }

  if (choice === 'skip') {
    await updateDraft(ctx, { step: 'adding_items', flow_data: null });
    await say(ctx, 'order.skipped');
    await showOrderSummary(ctx);
    return;
  }

  const stock = await freshStock(ctx.sb, prompt.id);
  const available = stock - qtyInDraft(draft.items, prompt.id);
  const quantity = choice === 'all' ? available : choice;
  const title = raw(variantTitle(prompt));

  if (quantity <= 0) {
    await updateDraft(ctx, { step: 'adding_items', flow_data: null });
    await say(ctx, 'order.noStockLeft', { title });
    await showOrderSummary(ctx);
    return;
  }
  if (quantity > available) {
    await say(ctx, 'order.qtyTooMany', { available: fmt(available) }, [
      [{ text: tr(ctx, 'order.takeAll', { n: fmt(available) }), callback_data: 'qty:all' }],
      [{ text: tr(ctx, 'order.skipItem'), callback_data: 'qty:skip' }],
    ]);
    return;
  }

  await addItemToDraft(ctx, draft, prompt, quantity);
  await say(ctx, 'order.added', { title, qty: fmt(quantity), stock: fmt(stock), fix: fixNote(ctx, prompt.corrections) });
  await showOrderSummary(ctx);
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

// ---------------------------------------------------------------------------
// /add_product — добавление товара на склад: название → цвет → размер → количество
// ---------------------------------------------------------------------------

async function startAddProduct(ctx: Ctx) {
  const previous = await getDraft(ctx.sb, ctx.userId);
  const hadWork = !!previous && (previous.items?.length > 0 || previous.flow === 'add_product');

  const { data: products } = await ctx.sb.from('products').select('name').eq('warehouse_type', 'finished_goods').order('name');
  const names = (products ?? []).map((p: { name: string }) => p.name);

  await ctx.sb.from('telegram_order_drafts').upsert({
    telegram_user_id: ctx.userId,
    step: 'ap_name',
    flow: 'add_product',
    client_id: null,
    client_name: null,
    client_phone: null,
    items: [],
    pending: null,
    flow_data: { ap: { options: names } },
    updated_at: now(),
  });

  const buttons: InlineButton[][] = names.map((name, i) => [{ text: name, callback_data: `ap:n:${i}` }]);
  await sendMessage(ctx.chatId, (hadWork ? tr(ctx, 'prevCancelled') : '') + tr(ctx, 'ap.start'), buttons.length > 0 ? buttons : undefined);
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
  await updateDraft(ctx, { step: 'ap_color', flow_data: { ap: { name, options: canonical } } });

  const buttons: InlineButton[][] = canonical.map((c, i) => [{ text: c, callback_data: `ap:c:${i}` }]);
  buttons.push([{ text: tr(ctx, 'ap.noColorBtn'), callback_data: 'ap:c:none' }]);
  await say(ctx, 'ap.color', { name, isNew: id ? '' : raw(tr(ctx, 'ap.new')) }, buttons);
}

async function askSize(ctx: Ctx, draft: Draft, color: string | null) {
  const ap = draft.flow_data?.ap ?? {};
  const { variants } = await loadProductVariants(ctx.sb, ap.name ?? '');
  const sizes = sortSizes(Array.from(new Set(variants.map((v) => v.size).filter(Boolean) as string[])));
  await updateDraft(ctx, { step: 'ap_size', flow_data: { ap: { ...ap, color, options: sizes } } });

  const buttons: InlineButton[][] = [];
  for (let i = 0; i < sizes.length; i += 3) {
    buttons.push(sizes.slice(i, i + 3).map((s, j) => ({ text: s, callback_data: `ap:s:${i + j}` })));
  }
  buttons.push([{ text: tr(ctx, 'ap.noSizeBtn'), callback_data: 'ap:s:none' }]);
  await say(ctx, 'ap.size', { color: color ?? tr(ctx, 'ap.noColorLabel') }, buttons);
}

async function askQuantity(ctx: Ctx, draft: Draft, size: string | null) {
  const ap = draft.flow_data?.ap ?? {};
  await updateDraft(ctx, { step: 'ap_qty', flow_data: { ap: { ...ap, size, options: [] } } });
  await say(ctx, 'ap.qty', { size: size ?? tr(ctx, 'ap.noSizeLabel') });
}

async function finalizeProduct(ctx: Ctx, draft: Draft, quantity: number) {
  const { sb } = ctx;
  const ap = draft.flow_data?.ap;
  if (!ap?.name) {
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

async function handleAddProductText(ctx: Ctx, draft: Draft, text: string) {
  const ap = draft.flow_data?.ap ?? {};

  if (draft.step === 'ap_name') {
    const { data: products } = await ctx.sb.from('products').select('name');
    const names = (products ?? []).map((p: { name: string }) => p.name);
    const typed = text.trim().replace(/\s+/g, ' ');
    const existing = names.find((n: string) => sameProductName(typed, n));
    await askColor(ctx, existing ?? typed.charAt(0).toUpperCase() + typed.slice(1));
  } else if (draft.step === 'ap_color') {
    const { variants } = await loadProductVariants(ctx.sb, ap.name ?? '');
    const all = await loadFinishedVariants(ctx.sb);
    const color = canonicalValue(text, [...variants, ...all].map((v) => v.color), 'color');
    await askSize(ctx, draft, color);
  } else if (draft.step === 'ap_size') {
    const all = await loadFinishedVariants(ctx.sb);
    const size = canonicalValue(text, all.map((v) => v.size), 'size');
    await askQuantity(ctx, draft, size);
  } else if (draft.step === 'ap_qty') {
    const quantity = parsePositiveNumber(text);
    if (!quantity) {
      await say(ctx, 'ap.qtyInvalid');
      return;
    }
    await finalizeProduct(ctx, draft, quantity);
  } else {
    await say(ctx, 'ap.startOver');
  }
}

async function handleAddProductCallback(ctx: Ctx, data: string) {
  const draft = await getDraft(ctx.sb, ctx.userId);
  if (!draft || draft.flow !== 'add_product') {
    await say(ctx, 'ap.stale');
    return;
  }
  const [, kind, rawIdx] = data.split(':');
  const ap = draft.flow_data?.ap ?? {};
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
  const messageId = cq.message?.message_id;

  // Эти кнопки не требуют черновика заказа.
  if (data.startsWith('sk:')) {
    await handleSkladCallback(ctx, messageId, data);
    return;
  }
  if (data.startsWith('ap:')) {
    await handleAddProductCallback(ctx, data);
    return;
  }
  if (data === 'issue:yes') {
    await issueOrder(ctx);
    return;
  }
  if (data === 'issue:cancel') {
    await sb.from('telegram_order_drafts').delete().eq('telegram_user_id', userId).eq('flow', 'order');
    await say(ctx, 'order.cancelled');
    return;
  }

  const draft = await getDraft(sb, userId);

  if (data.startsWith('qty:')) {
    if (!draft || draft.flow !== 'order' || draft.step !== 'awaiting_qty') {
      await say(ctx, 'staleAction');
      return;
    }
    await resolveQty(ctx, draft, data === 'qty:all' ? 'all' : 'skip');
    return;
  }

  if (!draft || draft.flow !== 'order' || !draft.pending) {
    await say(ctx, 'noActiveChoice');
    return;
  }
  const pending = draft.pending;

  if (data === 'new_client:no') {
    await updateDraft(ctx, { pending: null, client_phone: null, client_name: null, step: 'awaiting_client' });
    await say(ctx, 'order.reenterClient');
    return;
  }

  if (data === 'new_client:yes' && (pending.type === 'confirm_new_client' || pending.type === 'pick_client')) {
    await beginNewClient(ctx, pending.query);
    return;
  }

  if (data.startsWith('pick_client:') && pending.type === 'pick_client') {
    const client = pending.candidates[Number(data.split(':')[1])];
    if (!client) {
      await say(ctx, 'order.clientPickFailed');
      return;
    }
    await selectClient(ctx, client, false);
    return;
  }

  if (data.startsWith('pick_variant:') && pending.type === 'pick_variant') {
    const candidate = pending.candidates[Number(data.split(':')[1])];
    if (!candidate) {
      await say(ctx, 'order.variantPickFailed');
      return;
    }
    await updateDraft(ctx, { pending: null });
    const outcome = await proposeItem(ctx, refOf(candidate.variant), pending.quantity, pending.corrections);
    if (outcome === 'added') await showOrderSummary(ctx);
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
