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
import { canonicalValue, norm, parseOrderLine, sizeRank, sortSizes } from '@/lib/telegramParse';

const APP_URL = 'https://factory-orders-5yuc3.ondigitalocean.app';
const SESSION_HOURS = 24;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const HISTORY_LIMIT = 15;
const HISTORY_ITEMS_PER_ORDER = 6;
const TELEGRAM_MESSAGE_LIMIT = 3800;
const TIMEZONE = process.env.TELEGRAM_TIMEZONE || 'Asia/Tashkent';

const COMMANDS_HELP =
  'Доступные команды:\n' +
  '/sklad — просмотр склада\n' +
  '/add_product — добавить товар на склад\n' +
  '/new_order — выдать заказ клиенту (списание сразу)\n' +
  '/history_orders — история выданных заказов\n' +
  '/cancel — отменить текущее действие';

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
  | { type: 'pick_variant'; candidates: { variant: ProductVariant }[]; quantity: number };

// Позиция, по которой запрошено больше, чем есть; бот ждёт нового количества.
interface QtyPrompt extends VariantRef {
  requested: number;
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

interface Session {
  telegram_user_id: number;
  expires_at: string | null;
  failed_attempts: number;
  locked_until: string | null;
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
  const m = input.trim().match(/^(\d+(?:[.,]\d+)?)\s*(?:шт|штук[аи]?)?\.?$/i);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  return value > 0 ? value : null;
}

// Название позиции для сообщений: «Майка — L, Белый».
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

async function present(chatId: number, messageId: number | undefined, text: string, buttons?: InlineButton[][]) {
  if (messageId) await editMessageText(chatId, messageId, text, buttons);
  else await sendMessage(chatId, text, buttons);
}

async function getSession(sb: SupabaseClient, telegramUserId: number): Promise<Session | null> {
  const { data } = await sb.from('telegram_sessions').select('*').eq('telegram_user_id', telegramUserId).maybeSingle();
  return (data as Session) ?? null;
}

function isSessionActive(session: Session | null): boolean {
  return !!session?.expires_at && new Date(session.expires_at) > new Date();
}

async function getDraft(sb: SupabaseClient, telegramUserId: number): Promise<Draft | null> {
  const { data } = await sb.from('telegram_order_drafts').select('*').eq('telegram_user_id', telegramUserId).maybeSingle();
  return (data as Draft) ?? null;
}

async function updateDraft(sb: SupabaseClient, telegramUserId: number, patch: Record<string, unknown>) {
  await sb
    .from('telegram_order_drafts')
    .update({ ...patch, updated_at: now() })
    .eq('telegram_user_id', telegramUserId);
}

async function loadFinishedVariants(sb: SupabaseClient): Promise<ProductVariant[]> {
  const { data } = await sb.from('product_variants_view').select('*').eq('warehouse_type', 'finished_goods').limit(1000);
  return (data ?? []) as ProductVariant[];
}

async function freshStock(sb: SupabaseClient, variantId: string): Promise<number> {
  const { data } = await sb.from('product_variants').select('stock_quantity').eq('id', variantId).maybeSingle();
  return Number(data?.stock_quantity ?? 0);
}

// ---------------------------------------------------------------------------
// Вход по PIN
// ---------------------------------------------------------------------------

async function handlePinAttempt(sb: SupabaseClient, telegramUserId: number, chatId: number, text: string) {
  const session = await getSession(sb, telegramUserId);

  if (session?.locked_until && new Date(session.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(session.locked_until).getTime() - Date.now()) / 60000);
    await sendMessage(chatId, `Слишком много неверных попыток. Попробуйте снова через ${minutesLeft} мин.`);
    return;
  }

  const pin = process.env.TELEGRAM_KLADOVSHIK_PIN;
  if (!pin) {
    await sendMessage(chatId, 'Бот не настроен (не задан PIN). Обратитесь к администратору.');
    return;
  }

  if (text.trim() === pin) {
    await sb.from('telegram_sessions').upsert({
      telegram_user_id: telegramUserId,
      expires_at: new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString(),
      failed_attempts: 0,
      locked_until: null,
    });
    await sendMessage(chatId, `Добро пожаловать! Вход выполнен на 24 часа.\n\n${COMMANDS_HELP}`);
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
    await sendMessage(chatId, `Неверный PIN. Слишком много попыток — попробуйте снова через ${LOCK_MINUTES} мин.`);
  } else {
    await sendMessage(chatId, `Неверный PIN (попытка ${attempts}/${MAX_FAILED_ATTEMPTS}).`);
  }
}

// ---------------------------------------------------------------------------
// /sklad — просмотр склада: товар → цвет → размеры и остатки.
// Кнопки не зависят от черновика: всё нужное закодировано в callback_data.
// ---------------------------------------------------------------------------

interface ColorGroup {
  key: string;
  label: string;
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
      label: vs[0].color ? canonicalValue(vs[0].color, vs.map((v) => v.color), 'color') : 'Без цвета',
      variants: vs,
      total: vs.reduce((sum, v) => sum + Number(v.stock_quantity), 0),
    }))
    .sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : a.label.localeCompare(b.label, 'ru')));
}

async function showSkladRoot(sb: SupabaseClient, chatId: number, messageId?: number) {
  const variants = await loadFinishedVariants(sb);
  const products = new Map<string, { name: string; total: number }>();
  for (const v of variants) {
    const entry = products.get(v.product_id) ?? { name: v.product_name, total: 0 };
    entry.total += Number(v.stock_quantity);
    products.set(v.product_id, entry);
  }
  if (products.size === 0) {
    await present(chatId, messageId, 'На складе готовой продукции пока нет товаров.');
    return;
  }
  const buttons: InlineButton[][] = Array.from(products.entries())
    .sort((a, b) => a[1].name.localeCompare(b[1].name, 'ru'))
    .map(([id, p]) => [{ text: `${p.name} — ${fmt(p.total)} шт`, callback_data: `sk:p:${id}` }]);
  await present(chatId, messageId, '<b>Склад — готовая продукция</b>\nВыберите товар:', buttons);
}

async function showSkladProduct(sb: SupabaseClient, chatId: number, messageId: number | undefined, productId: string) {
  const variants = (await loadFinishedVariants(sb)).filter((v) => v.product_id === productId);
  if (variants.length === 0) {
    await present(chatId, messageId, 'Этот товар не найден на складе.', [[{ text: '← К товарам', callback_data: 'sk:b' }]]);
    return;
  }
  const groups = groupByColor(variants);
  const buttons: InlineButton[][] = groups.map((g, i) => [
    { text: `${g.label} — ${fmt(g.total)} шт`, callback_data: `sk:c:${productId}:${i}` },
  ]);
  buttons.push([{ text: '← К товарам', callback_data: 'sk:b' }]);
  await present(chatId, messageId, `<b>${escapeHtml(variants[0].product_name)}</b>\nВыберите цвет:`, buttons);
}

async function showSkladColor(
  sb: SupabaseClient,
  chatId: number,
  messageId: number | undefined,
  productId: string,
  colorIdx: number
) {
  const variants = (await loadFinishedVariants(sb)).filter((v) => v.product_id === productId);
  const group = groupByColor(variants)[colorIdx];
  if (!group) {
    await showSkladProduct(sb, chatId, messageId, productId);
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
      const size = row.size ?? 'Без размера';
      const print = row.print && row.print !== NO_PRINT ? ` (${row.print})` : '';
      return `${icon}${escapeHtml(size + print)} — ${fmt(row.stock)} шт`;
    });
  const text =
    `<b>${escapeHtml(variants[0].product_name)}, ${escapeHtml(group.label)}</b>\n` +
    lines.join('\n') +
    `\n\nВсего: ${fmt(group.total)} шт\n⚠️ — мало, ❌ — нет в наличии`;
  await present(chatId, messageId, text, [
    [{ text: '← К цветам', callback_data: `sk:p:${productId}` }],
    [{ text: '← К товарам', callback_data: 'sk:b' }],
  ]);
}

async function handleSkladCallback(sb: SupabaseClient, chatId: number, messageId: number | undefined, data: string) {
  const parts = data.split(':');
  if (parts[1] === 'b') return showSkladRoot(sb, chatId, messageId);
  if (parts[1] === 'p' && parts[2]) return showSkladProduct(sb, chatId, messageId, parts[2]);
  if (parts[1] === 'c' && parts[2] && parts[3] !== undefined) {
    return showSkladColor(sb, chatId, messageId, parts[2], Number(parts[3]));
  }
  await sendMessage(chatId, 'Неизвестный выбор.');
}

// ---------------------------------------------------------------------------
// /new_order — заказ с немедленной выдачей (как «Уход» в вебе)
// ---------------------------------------------------------------------------

async function startNewOrder(sb: SupabaseClient, telegramUserId: number, chatId: number) {
  const previous = await getDraft(sb, telegramUserId);
  const hadWork = !!previous && (previous.items?.length > 0 || previous.flow === 'add_product');

  await sb.from('telegram_order_drafts').upsert({
    telegram_user_id: telegramUserId,
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
  await sendMessage(
    chatId,
    (hadWork ? 'Предыдущее незавершённое действие отменено.\n\n' : '') +
      'Новый заказ — товар выдаётся клиенту сразу, остаток спишется при выдаче.\nВведите имя или телефон клиента.'
  );
}

function itemsHelpText(): string {
  return (
    'Что нужно клиенту? Пишите свободным текстом, например:\n' +
    '<i>футболка черный xl 50 штук</i>\n' +
    'Можно несколько позиций — по одной в строке. Когда всё добавлено, нажмите «Выдать заказ» (или /confirm). Отмена — /cancel.'
  );
}

async function selectClient(
  sb: SupabaseClient,
  telegramUserId: number,
  chatId: number,
  client: { id: string; name: string; phone: string | null },
  prefix: string
) {
  await updateDraft(sb, telegramUserId, {
    client_id: client.id,
    client_name: client.name,
    client_phone: client.phone,
    step: 'adding_items',
    pending: null,
  });
  await sendMessage(
    chatId,
    `${prefix}${escapeHtml(client.name)}${client.phone ? ' — ' + escapeHtml(client.phone) : ''}.\n\n${itemsHelpText()}`
  );
}

async function handleClientSearch(sb: SupabaseClient, draft: Draft, chatId: number, query: string) {
  const q = sanitizeIlike(query);
  if (!q) {
    await sendMessage(chatId, 'Введите имя или телефон клиента.');
    return;
  }

  const { data: clients } = await sb.from('clients').select('id, name, phone').or(`name.ilike.%${q}%,phone.ilike.%${q}%`).limit(10);

  if (!clients || clients.length === 0) {
    await updateDraft(sb, draft.telegram_user_id, { pending: { type: 'confirm_new_client', query: query.trim() } });
    await sendMessage(chatId, `Клиент «${escapeHtml(query.trim())}» не найден.`, [
      [{ text: 'Создать нового клиента', callback_data: 'new_client:yes' }],
      [{ text: 'Отмена', callback_data: 'new_client:no' }],
    ]);
    return;
  }

  await updateDraft(sb, draft.telegram_user_id, { pending: { type: 'pick_client', candidates: clients, query: query.trim() } });
  const buttons: InlineButton[][] = clients.map((c, i) => [
    { text: `${c.name}${c.phone ? ' — ' + c.phone : ''}`, callback_data: `pick_client:${i}` },
  ]);
  buttons.push([{ text: 'Создать нового клиента', callback_data: 'new_client:yes' }]);
  await sendMessage(chatId, 'Найдены клиенты:', buttons);
}

// Введённое похоже на телефон — дальше спрашиваем имя, иначе принимаем его за
// имя и спрашиваем телефон.
async function beginNewClient(sb: SupabaseClient, telegramUserId: number, chatId: number, query: string) {
  if (looksLikePhone(query)) {
    await updateDraft(sb, telegramUserId, { client_phone: query, client_name: null, step: 'awaiting_new_client_name', pending: null });
    await sendMessage(chatId, 'Введите имя нового клиента.');
  } else {
    await updateDraft(sb, telegramUserId, { client_name: query, client_phone: null, step: 'awaiting_new_client_phone', pending: null });
    await sendMessage(chatId, 'Введите телефон нового клиента (или «-», чтобы пропустить).');
  }
}

async function createClientAndContinue(sb: SupabaseClient, draft: Draft, chatId: number, name: string, phone: string | null) {
  const { data: client, error } = await sb.from('clients').insert({ name: name.trim(), phone }).select().single();
  if (error || !client) {
    await sendMessage(chatId, 'Не удалось создать клиента. Попробуйте ещё раз.');
    return;
  }
  await selectClient(sb, draft.telegram_user_id, chatId, client, 'Клиент создан: ');
}

function qtyInDraft(items: DraftItem[] | null, variantId: string): number {
  return (items ?? []).find((it) => it.variantId === variantId)?.quantity ?? 0;
}

// Проверяет остаток в момент ввода позиции и либо добавляет её в заказ,
// либо спрашивает, сколько забрать. В остаток входит то, что уже набрано в
// этом же заказе — списание произойдёт только при выдаче.
async function proposeItem(
  sb: SupabaseClient,
  telegramUserId: number,
  chatId: number,
  variant: VariantRef,
  requested: number
): Promise<'added' | 'wait' | 'rejected'> {
  const draft = await getDraft(sb, telegramUserId);
  if (!draft || draft.flow !== 'order') return 'rejected';

  const stock = await freshStock(sb, variant.id);
  const already = qtyInDraft(draft.items, variant.id);
  const available = stock - already;
  const title = variantTitle(variant);

  if (available <= 0) {
    const note = already > 0 ? ` (весь остаток — ${fmt(stock)} шт — уже в этом заказе)` : '';
    await sendMessage(chatId, `❌ ${title}: нет в наличии${note}.`);
    return 'rejected';
  }

  if (requested > available) {
    const prompt: QtyPrompt = { ...variant, requested };
    await updateDraft(sb, telegramUserId, { step: 'awaiting_qty', flow_data: { qty: prompt } });
    const note = already > 0 ? ` (ещё ${fmt(already)} шт. уже добавлено в заказ)` : '';
    await sendMessage(
      chatId,
      `⚠️ ${title}: запрошено ${fmt(requested)} шт.\nВ наличии только ${fmt(available)} шт${note}. Сколько забрать?`,
      [
        [{ text: `Забрать ${fmt(available)} шт`, callback_data: 'qty:all' }],
        [{ text: 'Пропустить позицию', callback_data: 'qty:skip' }],
      ]
    );
    return 'wait';
  }

  await addItemToDraft(sb, draft, variant, requested);
  await sendMessage(chatId, `✅ Добавлено: ${title} — ${fmt(requested)} шт (остаток ${fmt(stock)}).`);
  return 'added';
}

async function addItemToDraft(sb: SupabaseClient, draft: Draft, variant: VariantRef, quantity: number) {
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
  await updateDraft(sb, draft.telegram_user_id, { items, pending: null, step: 'adding_items', flow_data: null });
}

async function showOrderSummary(sb: SupabaseClient, telegramUserId: number, chatId: number) {
  const draft = await getDraft(sb, telegramUserId);
  if (!draft || draft.flow !== 'order') return;
  if (!draft.items || draft.items.length === 0) {
    await sendMessage(chatId, 'В заказе пока нет позиций.\n\n' + itemsHelpText());
    return;
  }
  const lines = draft.items.map((it) => `• ${itemTitle(it)} — ${fmt(it.quantity)} шт`);
  const text = [
    `<b>Клиент:</b> ${escapeHtml(draft.client_name ?? '')}${draft.client_phone ? ' (' + escapeHtml(draft.client_phone) + ')' : ''}`,
    '<b>Заказ (будет выдан сразу):</b>',
    ...lines,
    '',
    'Добавьте ещё позицию текстом или нажмите «Выдать заказ».',
  ].join('\n');
  await sendMessage(chatId, text, [
    [{ text: '✅ Выдать заказ', callback_data: 'issue:yes' }],
    [{ text: 'Отмена', callback_data: 'issue:cancel' }],
  ]);
}

async function handleAddItems(sb: SupabaseClient, telegramUserId: number, chatId: number, text: string) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const variants = await loadFinishedVariants(sb);

  let addedAny = false;
  for (let i = 0; i < lines.length; i++) {
    const result = parseOrderLine(lines[i], variants);
    let waiting = false;

    if (result.kind === 'error') {
      await sendMessage(chatId, escapeHtml(result.message));
    } else if (result.kind === 'exact') {
      const outcome = await proposeItem(sb, telegramUserId, chatId, refOf(result.variant), result.quantity);
      if (outcome === 'added') addedAny = true;
      waiting = outcome === 'wait';
    } else {
      await updateDraft(sb, telegramUserId, {
        pending: { type: 'pick_variant', candidates: result.candidates.map((variant) => ({ variant })), quantity: result.quantity },
      });
      const buttons: InlineButton[][] = result.candidates.map((v, idx) => [
        {
          text: `${v.product_name} — ${variantLabel(v) ?? 'без параметров'} (остаток ${fmt(v.stock_quantity)})`,
          callback_data: `pick_variant:${idx}`,
        },
      ]);
      await sendMessage(chatId, `Уточните вариант для «${escapeHtml(lines[i])}»:${result.note ? '\n' + escapeHtml(result.note) : ''}`, buttons);
      waiting = true;
    }

    if (waiting) {
      const remaining = lines.length - i - 1;
      if (remaining > 0) {
        await sendMessage(chatId, `Остальные строки (${remaining}) не обработаны — отправьте их заново после уточнения выше.`);
      }
      return;
    }
  }

  if (addedAny) await showOrderSummary(sb, telegramUserId, chatId);
}

// Ответ на «Сколько забрать?»: число или кнопка.
async function resolveQty(sb: SupabaseClient, draft: Draft, chatId: number, choice: number | 'all' | 'skip') {
  const prompt = draft.flow_data?.qty;
  if (!prompt) {
    await sendMessage(chatId, 'Нет позиции, ожидающей количества.');
    return;
  }

  if (choice === 'skip') {
    await updateDraft(sb, draft.telegram_user_id, { step: 'adding_items', flow_data: null });
    await sendMessage(chatId, 'Позиция пропущена.');
    await showOrderSummary(sb, draft.telegram_user_id, chatId);
    return;
  }

  const stock = await freshStock(sb, prompt.id);
  const available = stock - qtyInDraft(draft.items, prompt.id);
  const quantity = choice === 'all' ? available : choice;

  if (quantity <= 0) {
    await updateDraft(sb, draft.telegram_user_id, { step: 'adding_items', flow_data: null });
    await sendMessage(chatId, `❌ ${variantTitle(prompt)}: остатка не осталось, позиция пропущена.`);
    await showOrderSummary(sb, draft.telegram_user_id, chatId);
    return;
  }
  if (quantity > available) {
    await sendMessage(
      chatId,
      `В наличии только ${fmt(available)} шт. Введите количество не больше ${fmt(available)} или нажмите «Пропустить».`,
      [
        [{ text: `Забрать ${fmt(available)} шт`, callback_data: 'qty:all' }],
        [{ text: 'Пропустить позицию', callback_data: 'qty:skip' }],
      ]
    );
    return;
  }

  await addItemToDraft(sb, draft, prompt, quantity);
  await sendMessage(chatId, `✅ Добавлено: ${variantTitle(prompt)} — ${fmt(quantity)} шт (остаток ${fmt(stock)}).`);
  await showOrderSummary(sb, draft.telegram_user_id, chatId);
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
async function issueOrder(sb: SupabaseClient, telegramUserId: number, chatId: number) {
  const current = await getDraft(sb, telegramUserId);
  if (!current || current.flow !== 'order' || !current.client_id || !current.items || current.items.length === 0) {
    await sendMessage(chatId, 'Нечего выдавать — заказ пуст. Начните с /new_order.');
    return;
  }
  if (current.step === 'awaiting_qty' || current.pending) {
    await sendMessage(chatId, 'Сначала завершите выбор выше: укажите количество или выберите вариант (или /cancel).');
    return;
  }

  // «Забираем» черновик удалением: повторное нажатие кнопки не создаст второй заказ.
  const { data: claimed } = await sb
    .from('telegram_order_drafts')
    .delete()
    .eq('telegram_user_id', telegramUserId)
    .eq('flow', 'order')
    .select()
    .maybeSingle();
  const draft = claimed as Draft | null;
  if (!draft) {
    await sendMessage(chatId, 'Этот заказ уже оформлен или отменён.');
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
    adjustments.push(
      available > 0
        ? `• ${itemTitle(it)}: было ${fmt(it.quantity)}, осталось ${fmt(available)} — количество уменьшено`
        : `• ${itemTitle(it)}: остатка нет — позиция убрана`
    );
    if (available > 0) reconciled.push({ ...it, quantity: available });
  }
  if (adjustments.length > 0) {
    await restoreDraft(sb, { ...draft, items: reconciled });
    await sendMessage(chatId, `Остаток изменился, пока вы оформляли заказ:\n${adjustments.join('\n')}\n\nЗаказ ещё НЕ выдан — проверьте и подтвердите заново.`);
    await showOrderSummary(sb, telegramUserId, chatId);
    return;
  }

  const { data: order, error: orderError } = await sb
    .from('orders')
    .insert({ client_id: draft.client_id, status: 'new', comment: 'Выдан через Telegram-бота' })
    .select()
    .single();
  if (orderError || !order) {
    await restoreDraft(sb, draft);
    await sendMessage(chatId, 'Не удалось создать заказ. Заказ сохранён — попробуйте нажать «Выдать заказ» ещё раз.');
    await showOrderSummary(sb, telegramUserId, chatId);
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
    await sendMessage(chatId, 'Не удалось сохранить позиции. Заказ не создан и не выдан — попробуйте «Выдать заказ» ещё раз.');
    await showOrderSummary(sb, telegramUserId, chatId);
    return;
  }

  // Смена статуса на «Выдан» запускает триггер списания.
  const { error: issueError } = await sb.from('orders').update({ status: 'issued' }).eq('id', order.id);
  if (issueError) {
    await sb.from('orders').delete().eq('id', order.id);
    await restoreDraft(sb, draft);
    const shortage = issueError.message?.includes('insufficient_stock');
    await sendMessage(
      chatId,
      shortage
        ? 'Остаток изменился в последний момент — заказ НЕ выдан. Проверьте позиции и нажмите «Выдать заказ» ещё раз.'
        : 'Не удалось выдать заказ. Ничего не списано — попробуйте ещё раз.'
    );
    await showOrderSummary(sb, telegramUserId, chatId);
    return;
  }

  const { data: after } = await sb.from('product_variants').select('id, stock_quantity').in('id', variantIds);
  const remainingById = new Map((after ?? []).map((r: { id: string; stock_quantity: number }) => [r.id, Number(r.stock_quantity)]));
  const lines = draft.items.map(
    (it) => `• ${itemTitle(it)} — ${fmt(it.quantity)} шт (остаток теперь ${fmt(remainingById.get(it.variantId) ?? 0)})`
  );
  await sendMessage(
    chatId,
    [
      '<b>Заказ выдан ✅</b>',
      `Клиент: ${escapeHtml(draft.client_name ?? '')}`,
      'Статус: Выдан, остаток списан.',
      ...lines,
      '',
      `${APP_URL}/orders/${order.id}`,
    ].join('\n')
  );
}

// ---------------------------------------------------------------------------
// /add_product — добавление товара на склад: название → цвет → размер → количество
// ---------------------------------------------------------------------------

async function startAddProduct(sb: SupabaseClient, telegramUserId: number, chatId: number) {
  const previous = await getDraft(sb, telegramUserId);
  const hadWork = !!previous && (previous.items?.length > 0 || previous.flow === 'add_product');

  const { data: products } = await sb.from('products').select('name').eq('warehouse_type', 'finished_goods').order('name');
  const names = (products ?? []).map((p: { name: string }) => p.name);

  await sb.from('telegram_order_drafts').upsert({
    telegram_user_id: telegramUserId,
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
  await sendMessage(
    chatId,
    (hadWork ? 'Предыдущее незавершённое действие отменено.\n\n' : '') +
      '<b>Добавление товара на склад</b> (без печати)\nШаг 1/4. Выберите товар из списка или введите название нового.',
    buttons.length > 0 ? buttons : undefined
  );
}

async function loadProductVariants(sb: SupabaseClient, productName: string): Promise<{ id: string | null; variants: ProductVariant[] }> {
  const { data: products } = await sb.from('products').select('id, name');
  const product = (products ?? []).find((p: { name: string }) => norm(p.name) === norm(productName));
  const all = await loadFinishedVariants(sb);
  if (!product) return { id: null, variants: all };
  const own = all.filter((v) => v.product_id === product.id);
  return { id: product.id, variants: own };
}

async function askColor(sb: SupabaseClient, telegramUserId: number, chatId: number, name: string) {
  const { id, variants } = await loadProductVariants(sb, name);
  const colors = Array.from(new Set(variants.map((v) => v.color).filter(Boolean) as string[]));
  const canonical = Array.from(new Map(colors.map((c) => [norm(c), canonicalValue(c, colors, 'color')])).values()).sort((a, b) =>
    a.localeCompare(b, 'ru')
  );
  await updateDraft(sb, telegramUserId, { step: 'ap_color', flow_data: { ap: { name, options: canonical } } });

  const buttons: InlineButton[][] = canonical.map((c, i) => [{ text: c, callback_data: `ap:c:${i}` }]);
  buttons.push([{ text: 'Без цвета', callback_data: 'ap:c:none' }]);
  await sendMessage(
    chatId,
    `Товар: <b>${escapeHtml(name)}</b>${id ? '' : ' (новый)'}\nШаг 2/4. Выберите цвет или введите новый.`,
    buttons
  );
}

async function askSize(sb: SupabaseClient, draft: Draft, chatId: number, color: string | null) {
  const ap = draft.flow_data?.ap ?? {};
  const { variants } = await loadProductVariants(sb, ap.name ?? '');
  const sizes = sortSizes(Array.from(new Set(variants.map((v) => v.size).filter(Boolean) as string[])));
  await updateDraft(sb, draft.telegram_user_id, { step: 'ap_size', flow_data: { ap: { ...ap, color, options: sizes } } });

  const buttons: InlineButton[][] = [];
  for (let i = 0; i < sizes.length; i += 3) {
    buttons.push(sizes.slice(i, i + 3).map((s, j) => ({ text: s, callback_data: `ap:s:${i + j}` })));
  }
  buttons.push([{ text: 'Без размера', callback_data: 'ap:s:none' }]);
  await sendMessage(chatId, `Цвет: <b>${escapeHtml(color ?? 'без цвета')}</b>\nШаг 3/4. Выберите размер или введите новый.`, buttons);
}

async function askQuantity(sb: SupabaseClient, draft: Draft, chatId: number, size: string | null) {
  const ap = draft.flow_data?.ap ?? {};
  await updateDraft(sb, draft.telegram_user_id, { step: 'ap_qty', flow_data: { ap: { ...ap, size, options: [] } } });
  await sendMessage(chatId, `Размер: <b>${escapeHtml(size ?? 'без размера')}</b>\nШаг 4/4. Введите количество (шт).`);
}

async function finalizeProduct(sb: SupabaseClient, draft: Draft, chatId: number, quantity: number) {
  const ap = draft.flow_data?.ap;
  if (!ap?.name) {
    await sendMessage(chatId, 'Не хватает данных. Начните заново: /add_product.');
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
        await sendMessage(chatId, 'Не удалось создать товар. Введите количество ещё раз или /cancel.');
        return;
      }
    }
  }

  const label = variantLabel({ color, size, print_type: NO_PRINT });
  const title = `${escapeHtml(ap.name)}${label ? ' — ' + escapeHtml(label) : ''}`;

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

      await sb.from('telegram_order_drafts').delete().eq('telegram_user_id', draft.telegram_user_id);
      await sendMessage(
        chatId,
        `Товар успешно добавлен на склад ✅\n${title}\nТакой вариант уже был, остаток стал ${fmt(before + quantity)} (было ${fmt(before)}, +${fmt(quantity)}).`
      );
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
      await sendMessage(chatId, 'Не удалось сохранить товар. Введите количество ещё раз или /cancel.');
      return;
    }

    await sb.from('telegram_order_drafts').delete().eq('telegram_user_id', draft.telegram_user_id);
    await sendMessage(chatId, `Товар успешно добавлен на склад ✅\n${title}: ${fmt(quantity)} шт.`);
    return;
  }

  await sendMessage(chatId, 'Остаток менялся во время сохранения. Введите количество ещё раз или /cancel.');
}

async function handleAddProductText(sb: SupabaseClient, draft: Draft, chatId: number, text: string) {
  const ap = draft.flow_data?.ap ?? {};

  if (draft.step === 'ap_name') {
    const { data: products } = await sb.from('products').select('name');
    const names = (products ?? []).map((p: { name: string }) => p.name);
    const typed = text.trim().replace(/\s+/g, ' ');
    const existing = names.find((n: string) => norm(n) === norm(typed));
    await askColor(sb, draft.telegram_user_id, chatId, existing ?? typed.charAt(0).toUpperCase() + typed.slice(1));
  } else if (draft.step === 'ap_color') {
    const { variants } = await loadProductVariants(sb, ap.name ?? '');
    const all = await loadFinishedVariants(sb);
    const color = canonicalValue(text, [...variants, ...all].map((v) => v.color), 'color');
    await askSize(sb, draft, chatId, color);
  } else if (draft.step === 'ap_size') {
    const all = await loadFinishedVariants(sb);
    const size = canonicalValue(text, all.map((v) => v.size), 'size');
    await askQuantity(sb, draft, chatId, size);
  } else if (draft.step === 'ap_qty') {
    const quantity = parsePositiveNumber(text);
    if (!quantity) {
      await sendMessage(chatId, 'Введите количество числом больше нуля, например: 20');
      return;
    }
    await finalizeProduct(sb, draft, chatId, quantity);
  } else {
    await sendMessage(chatId, 'Наберите /add_product, чтобы начать.');
  }
}

async function handleAddProductCallback(sb: SupabaseClient, telegramUserId: number, chatId: number, data: string) {
  const draft = await getDraft(sb, telegramUserId);
  if (!draft || draft.flow !== 'add_product') {
    await sendMessage(chatId, 'Это действие уже неактуально. Начните заново: /add_product.');
    return;
  }
  const [, kind, raw] = data.split(':');
  const ap = draft.flow_data?.ap ?? {};
  const picked = raw === 'none' ? null : (ap.options ?? [])[Number(raw)];
  if (raw !== 'none' && picked === undefined) {
    await sendMessage(chatId, 'Не удалось выбрать. Начните заново: /add_product.');
    return;
  }

  if (kind === 'n' && draft.step === 'ap_name' && picked) await askColor(sb, telegramUserId, chatId, picked);
  else if (kind === 'c' && draft.step === 'ap_color') await askSize(sb, draft, chatId, picked);
  else if (kind === 's' && draft.step === 'ap_size') await askQuantity(sb, draft, chatId, picked);
  else await sendMessage(chatId, 'Это действие уже неактуально. Продолжите текущий шаг или /cancel.');
}

// ---------------------------------------------------------------------------
// /history_orders — последние выданные заказы
// ---------------------------------------------------------------------------

async function showHistory(sb: SupabaseClient, chatId: number) {
  const { data: orders, error } = await sb
    .from('orders')
    .select('id, issued_at, clients(name), order_items(quantity, product_variants(color, size, print_type, products(name)))')
    .eq('status', 'issued')
    .order('issued_at', { ascending: false, nullsFirst: false })
    .limit(HISTORY_LIMIT);

  if (error) {
    console.error('telegram history failed', error);
    await sendMessage(chatId, 'Не удалось загрузить историю. Попробуйте ещё раз.');
    return;
  }
  if (!orders || orders.length === 0) {
    await sendMessage(chatId, 'Выданных заказов пока нет.');
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
        product_name: product?.name ?? 'Товар',
        color: v?.color ?? null,
        size: v?.size ?? null,
        print_type: v?.print_type ?? null,
      });
      return `  • ${title} × ${fmt(it.quantity)}`;
    });
    if (items.length > shown.length) shown.push(`  …и ещё ${items.length - shown.length} поз.`);
    if (shown.length === 0) shown.push('  (позиции не выданы)');

    const when = o.issued_at ? dateFormat.format(new Date(o.issued_at)) : '—';
    return `<b>${when}</b> — ${escapeHtml(client?.name ?? 'Клиент')}\n${shown.join('\n')}`;
  });

  await sendBlocks(chatId, [`<b>Последние выданные заказы</b> (${orders.length})`, ...blocks]);
}

interface VariantRefRow {
  color: string | null;
  size: string | null;
  print_type: string | null;
  products: { name: string } | { name: string }[] | null;
}

// ---------------------------------------------------------------------------
// Маршрутизация
// ---------------------------------------------------------------------------

async function handleCallbackQuery(sb: SupabaseClient, cq: TelegramCallbackQuery) {
  const telegramUserId = cq.from.id;
  const chatId = cq.message?.chat.id;
  if (!chatId) return;

  await answerCallbackQuery(cq.id);

  const session = await getSession(sb, telegramUserId);
  if (!isSessionActive(session)) {
    await sendMessage(chatId, 'Сессия истекла. Введите PIN заново.');
    return;
  }

  const data = cq.data ?? '';

  // Эти кнопки не требуют черновика заказа.
  if (data.startsWith('sk:')) {
    await handleSkladCallback(sb, chatId, cq.message?.message_id, data);
    return;
  }
  if (data.startsWith('ap:')) {
    await handleAddProductCallback(sb, telegramUserId, chatId, data);
    return;
  }
  if (data === 'issue:yes') {
    await issueOrder(sb, telegramUserId, chatId);
    return;
  }
  if (data === 'issue:cancel') {
    await sb.from('telegram_order_drafts').delete().eq('telegram_user_id', telegramUserId).eq('flow', 'order');
    await sendMessage(chatId, 'Заказ отменён, ничего не списано.');
    return;
  }

  const draft = await getDraft(sb, telegramUserId);

  if (data.startsWith('qty:')) {
    if (!draft || draft.flow !== 'order' || draft.step !== 'awaiting_qty') {
      await sendMessage(chatId, 'Это действие уже неактуально.');
      return;
    }
    await resolveQty(sb, draft, chatId, data === 'qty:all' ? 'all' : 'skip');
    return;
  }

  if (!draft || draft.flow !== 'order' || !draft.pending) {
    await sendMessage(chatId, 'Нет активного выбора.');
    return;
  }
  const pending = draft.pending;

  if (data === 'new_client:no') {
    await updateDraft(sb, telegramUserId, { pending: null, client_phone: null, client_name: null, step: 'awaiting_client' });
    await sendMessage(chatId, 'Ок, введите имя или телефон клиента ещё раз.');
    return;
  }

  if (data === 'new_client:yes' && (pending.type === 'confirm_new_client' || pending.type === 'pick_client')) {
    await beginNewClient(sb, telegramUserId, chatId, pending.query);
    return;
  }

  if (data.startsWith('pick_client:') && pending.type === 'pick_client') {
    const client = pending.candidates[Number(data.split(':')[1])];
    if (!client) {
      await sendMessage(chatId, 'Не удалось выбрать клиента.');
      return;
    }
    await selectClient(sb, telegramUserId, chatId, client, 'Клиент: ');
    return;
  }

  if (data.startsWith('pick_variant:') && pending.type === 'pick_variant') {
    const candidate = pending.candidates[Number(data.split(':')[1])];
    if (!candidate) {
      await sendMessage(chatId, 'Не удалось выбрать вариант.');
      return;
    }
    await updateDraft(sb, telegramUserId, { pending: null });
    const outcome = await proposeItem(sb, telegramUserId, chatId, refOf(candidate.variant), pending.quantity);
    if (outcome === 'added') await showOrderSummary(sb, telegramUserId, chatId);
    return;
  }

  await sendMessage(chatId, 'Неизвестный выбор.');
}

export async function handleUpdate(update: TelegramUpdate) {
  let sb: SupabaseClient;
  try {
    sb = serviceClient();
  } catch (err) {
    console.error('telegramBot: service client unavailable', err);
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chatId) await sendMessage(chatId, 'Бот временно не настроен. Обратитесь к администратору.');
    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(sb, update.callback_query);
    return;
  }

  const message = update.message;
  if (!message || typeof message.text !== 'string') return;

  const telegramUserId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text.trim();

  const session = await getSession(sb, telegramUserId);
  if (!isSessionActive(session)) {
    await handlePinAttempt(sb, telegramUserId, chatId, text);
    return;
  }

  if (text.startsWith('/')) {
    // В группах Telegram дописывает имя бота: /sklad@my_bot.
    const cmd = text.split(/\s+/)[0].split('@')[0];
    if (cmd === '/start') {
      await sendMessage(chatId, COMMANDS_HELP);
    } else if (cmd === '/sklad') {
      await showSkladRoot(sb, chatId);
    } else if (cmd === '/add_product') {
      await startAddProduct(sb, telegramUserId, chatId);
    } else if (cmd === '/new_order') {
      await startNewOrder(sb, telegramUserId, chatId);
    } else if (cmd === '/history_orders') {
      await showHistory(sb, chatId);
    } else if (cmd === '/confirm') {
      await issueOrder(sb, telegramUserId, chatId);
    } else if (cmd === '/cancel') {
      await sb.from('telegram_order_drafts').delete().eq('telegram_user_id', telegramUserId);
      await sendMessage(chatId, 'Текущее действие отменено, ничего не списано.');
    } else {
      await sendMessage(chatId, `Неизвестная команда.\n\n${COMMANDS_HELP}`);
    }
    return;
  }

  const draft = await getDraft(sb, telegramUserId);
  if (!draft) {
    await sendMessage(chatId, `Нет активного действия.\n\n${COMMANDS_HELP}`);
    return;
  }

  if (draft.flow === 'add_product') {
    await handleAddProductText(sb, draft, chatId, text);
    return;
  }

  if (draft.pending) {
    await sendMessage(chatId, 'Сначала выберите вариант из списка выше (или /cancel).');
    return;
  }

  // 'awaiting_phone' — прежнее название шага из миграции 011.
  if (draft.step === 'awaiting_client' || draft.step === 'awaiting_phone') {
    await handleClientSearch(sb, draft, chatId, text);
  } else if (draft.step === 'awaiting_new_client_name') {
    await createClientAndContinue(sb, draft, chatId, text, draft.client_phone);
  } else if (draft.step === 'awaiting_new_client_phone') {
    const phone = text.trim() === '-' ? null : text.trim();
    await createClientAndContinue(sb, draft, chatId, draft.client_name ?? '', phone);
  } else if (draft.step === 'awaiting_qty') {
    const quantity = parsePositiveNumber(text);
    if (quantity === null) {
      await sendMessage(chatId, 'Введите число (сколько забрать) или нажмите кнопку «Пропустить позицию».');
      return;
    }
    await resolveQty(sb, draft, chatId, quantity);
  } else if (draft.step === 'adding_items') {
    await handleAddItems(sb, telegramUserId, chatId, text);
  } else {
    await sendMessage(chatId, 'Наберите /new_order, чтобы начать заказ.');
  }
}
