import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ProductVariant, variantLabel } from '@/lib/types';
import { sendMessage, answerCallbackQuery, InlineButton, TelegramUpdate, TelegramCallbackQuery } from '@/lib/telegram';

const APP_URL = 'https://factory-orders-5yuc3.ondigitalocean.app';
const SESSION_HOURS = 24;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

interface DraftItem {
  variantId: string;
  productName: string;
  color: string | null;
  size: string | null;
  printType: string | null;
  quantity: number;
}

type PendingState =
  | { type: 'confirm_new_client'; phone: string }
  | { type: 'pick_client'; candidates: { id: string; name: string; phone: string | null }[] }
  | { type: 'pick_variant'; candidates: { variant: ProductVariant }[]; quantity: number };

interface Draft {
  telegram_user_id: number;
  step: string;
  client_id: string | null;
  client_name: string | null;
  client_phone: string | null;
  items: DraftItem[];
  pending: PendingState | null;
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

function itemLabel(it: DraftItem): string {
  const parts = [it.size, it.color].filter(Boolean) as string[];
  if (it.printType && it.printType !== 'без печати') parts.push(it.printType);
  return parts.join(', ');
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
    await sendMessage(
      chatId,
      'Добро пожаловать! Вход выполнен на 24 часа.\n\nДоступные команды:\n/new_order — начать новый заказ'
    );
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

async function startNewOrder(sb: SupabaseClient, telegramUserId: number, chatId: number) {
  await sb.from('telegram_order_drafts').upsert({
    telegram_user_id: telegramUserId,
    step: 'awaiting_phone',
    client_id: null,
    client_name: null,
    client_phone: null,
    items: [],
    pending: null,
    updated_at: new Date().toISOString(),
  });
  await sendMessage(chatId, 'Новый заказ. Введите телефон клиента (или имя).');
}

async function handleClientSearch(sb: SupabaseClient, draft: Draft, chatId: number, query: string) {
  const q = sanitizeIlike(query);
  const { data: clients } = await sb
    .from('clients')
    .select('id, name, phone')
    .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
    .limit(10);

  if (!clients || clients.length === 0) {
    const pending: PendingState = { type: 'confirm_new_client', phone: query.trim() };
    await sb
      .from('telegram_order_drafts')
      .update({ client_phone: query.trim(), pending, updated_at: new Date().toISOString() })
      .eq('telegram_user_id', draft.telegram_user_id);

    const buttons: InlineButton[][] = [
      [{ text: 'Создать нового клиента', callback_data: 'new_client:yes' }],
      [{ text: 'Отмена', callback_data: 'new_client:no' }],
    ];
    await sendMessage(chatId, `Клиент «${query.trim()}» не найден.`, buttons);
    return;
  }

  const pending: PendingState = { type: 'pick_client', candidates: clients };
  await sb
    .from('telegram_order_drafts')
    .update({ pending, updated_at: new Date().toISOString() })
    .eq('telegram_user_id', draft.telegram_user_id);

  const buttons: InlineButton[][] = clients.map((c, i) => [
    { text: `${c.name}${c.phone ? ' — ' + c.phone : ''}`, callback_data: `pick_client:${i}` },
  ]);
  await sendMessage(chatId, 'Найдены клиенты:', buttons);
}

async function handleNewClientName(sb: SupabaseClient, draft: Draft, chatId: number, name: string) {
  const phone = draft.client_phone;
  const { data: client, error } = await sb
    .from('clients')
    .insert({ name: name.trim(), phone: phone || null })
    .select()
    .single();

  if (error || !client) {
    await sendMessage(chatId, 'Не удалось создать клиента. Попробуйте ещё раз.');
    return;
  }

  await sb
    .from('telegram_order_drafts')
    .update({
      client_id: client.id,
      client_name: client.name,
      client_phone: client.phone,
      step: 'adding_items',
      pending: null,
      updated_at: new Date().toISOString(),
    })
    .eq('telegram_user_id', draft.telegram_user_id);

  await sendMessage(
    chatId,
    `Клиент создан: ${client.name}${client.phone ? ' (' + client.phone + ')' : ''}.\n\n` + itemsHelpText()
  );
}

function itemsHelpText(): string {
  return (
    'Добавляйте товары, по одной строке на позицию:\n' +
    'Товар, цвет, размер, количество\n' +
    'Например: Майка, белый, M, 5\n' +
    '(цвет/размер можно в любом порядке или пропустить; количество — последнее число, по умолчанию 1)\n\n' +
    'Команды: /preview — просмотр заказа, /confirm — оформить, /cancel — отменить.'
  );
}

async function addItemToDraft(sb: SupabaseClient, draft: Draft, chatId: number, variant: ProductVariant, quantity: number) {
  const items = Array.isArray(draft.items) ? [...draft.items] : [];
  const existingIdx = items.findIndex((it) => it.variantId === variant.id);
  if (existingIdx >= 0) {
    items[existingIdx] = { ...items[existingIdx], quantity: items[existingIdx].quantity + quantity };
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

  await sb
    .from('telegram_order_drafts')
    .update({ items, pending: null, step: 'adding_items', updated_at: new Date().toISOString() })
    .eq('telegram_user_id', draft.telegram_user_id);

  const label = variantLabel(variant) ?? variant.product_name;
  await sendMessage(chatId, `Добавлено: ${variant.product_name} — ${label}, ${quantity} шт.\nОстаток на складе: ${variant.stock_quantity}.`);
}

async function handleAddItemLine(sb: SupabaseClient, draft: Draft, chatId: number, line: string) {
  const tokens = line
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return;

  let quantity = 1;
  let descriptorTokens = tokens;
  const last = tokens[tokens.length - 1];
  if (/^[0-9]+([.,][0-9]+)?$/.test(last)) {
    quantity = Number(last.replace(',', '.'));
    descriptorTokens = tokens.slice(0, -1);
  }

  if (descriptorTokens.length === 0) {
    await sendMessage(chatId, `Не удалось разобрать строку: «${line}» — не указано название товара.`);
    return;
  }
  if (quantity <= 0) {
    await sendMessage(chatId, `Количество должно быть больше нуля: «${line}»`);
    return;
  }

  const productQuery = descriptorTokens[0];
  const extraTokens = descriptorTokens
    .slice(1)
    .map((t) => t.toLowerCase())
    .filter(Boolean);

  const { data: variants } = await sb
    .from('product_variants_view')
    .select('*')
    .eq('warehouse_type', 'finished_goods')
    .ilike('product_name', `%${sanitizeIlike(productQuery)}%`)
    .limit(100);

  if (!variants || variants.length === 0) {
    await sendMessage(chatId, `Товар «${productQuery}» не найден: «${line}»`);
    return;
  }

  let matched = variants as ProductVariant[];
  for (const token of extraTokens) {
    const narrowed = matched.filter(
      (v) => (v.color && v.color.toLowerCase().includes(token)) || (v.size && v.size.toLowerCase().includes(token))
    );
    if (narrowed.length > 0) matched = narrowed;
  }

  if (matched.length === 1) {
    await addItemToDraft(sb, draft, chatId, matched[0], quantity);
    return;
  }

  const candidates = matched.slice(0, 10).map((v) => ({ variant: v }));
  const pending: PendingState = { type: 'pick_variant', candidates, quantity };
  await sb
    .from('telegram_order_drafts')
    .update({ pending, updated_at: new Date().toISOString() })
    .eq('telegram_user_id', draft.telegram_user_id);

  const buttons: InlineButton[][] = candidates.map((c, i) => {
    const label = variantLabel(c.variant) ?? c.variant.product_name;
    return [{ text: `${c.variant.product_name} — ${label} (остаток ${c.variant.stock_quantity})`, callback_data: `pick_variant:${i}` }];
  });
  await sendMessage(chatId, `Уточните вариант для «${line}»:`, buttons);
}

async function handleAddItems(sb: SupabaseClient, draftInitial: Draft, chatId: number, text: string) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    await handleAddItemLine(sb, draftInitial, chatId, lines[i]);
    const refreshed = await getDraft(sb, draftInitial.telegram_user_id);
    if (refreshed?.pending) {
      const remaining = lines.length - i - 1;
      if (remaining > 0) {
        await sendMessage(chatId, `Остальные строки (${remaining}) не обработаны — отправьте их заново после выбора варианта выше.`);
      }
      return;
    }
  }
}

async function previewDraft(sb: SupabaseClient, telegramUserId: number, chatId: number) {
  const draft = await getDraft(sb, telegramUserId);
  if (!draft || !draft.client_id || !draft.items || draft.items.length === 0) {
    await sendMessage(chatId, 'Черновик пуст. Начните с /new_order.');
    return;
  }

  const variantIds = draft.items.map((it) => it.variantId);
  const { data: freshVariants } = await sb.from('product_variants').select('id, stock_quantity').in('id', variantIds);
  const stockById = new Map((freshVariants ?? []).map((v: { id: string; stock_quantity: number }) => [v.id, v.stock_quantity]));

  const lines = draft.items.map((it) => {
    const label = itemLabel(it);
    const currentStock = stockById.get(it.variantId) ?? 0;
    const short = it.quantity > currentStock;
    const base = `${it.productName}${label ? ' — ' + label : ''}: ${it.quantity} шт.`;
    return short ? `⚠️ <b>${base} — не хватает, доступно только ${currentStock}</b>` : base;
  });

  const text = [
    `<b>Клиент:</b> ${draft.client_name}${draft.client_phone ? ' (' + draft.client_phone + ')' : ''}`,
    '',
    '<b>Товары:</b>',
    ...lines,
    '',
    'Команды: /confirm — оформить заказ, /cancel — отменить.',
  ].join('\n');

  await sendMessage(chatId, text);
}

async function confirmDraft(sb: SupabaseClient, telegramUserId: number, chatId: number) {
  const draft = await getDraft(sb, telegramUserId);
  if (!draft || !draft.client_id || !draft.items || draft.items.length === 0) {
    await sendMessage(chatId, 'Нечего подтверждать — черновик пуст. Начните с /new_order.');
    return;
  }

  const { data: order, error: orderError } = await sb
    .from('orders')
    .insert({ client_id: draft.client_id, status: 'new', comment: 'Создан через Telegram-бота' })
    .select()
    .single();

  if (orderError || !order) {
    await sendMessage(chatId, 'Не удалось создать заказ. Попробуйте ещё раз или используйте приложение.');
    return;
  }

  const variantIds = draft.items.map((it) => it.variantId);
  const { data: variantRows } = await sb.from('product_variants').select('id, product_id').in('id', variantIds);
  const productIdByVariant = new Map((variantRows ?? []).map((v: { id: string; product_id: string }) => [v.id, v.product_id]));
  const productIds = Array.from(new Set(Array.from(productIdByVariant.values())));
  const { data: products } = await sb.from('products').select('id, price').in('id', productIds);
  const priceByProduct = new Map((products ?? []).map((p: { id: string; price: number | null }) => [p.id, p.price ?? 0]));

  const orderItems = draft.items.map((it) => {
    const productId = productIdByVariant.get(it.variantId);
    const price = productId ? priceByProduct.get(productId) ?? 0 : 0;
    return { order_id: order.id, variant_id: it.variantId, quantity: it.quantity, price };
  });

  const { error: itemsError } = await sb.from('order_items').insert(orderItems);
  if (itemsError) {
    await sb.from('orders').delete().eq('id', order.id);
    await sendMessage(chatId, 'Не удалось сохранить позиции заказа. Заказ не создан, попробуйте ещё раз.');
    return;
  }

  await sb.from('telegram_order_drafts').delete().eq('telegram_user_id', telegramUserId);

  await sendMessage(
    chatId,
    `Заказ создан ✅\nКлиент: ${draft.client_name}\nСтатус: Новый (оставлен на потом)\n${APP_URL}/orders/${order.id}`
  );
}

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

  const draft = await getDraft(sb, telegramUserId);
  if (!draft || !draft.pending) {
    await sendMessage(chatId, 'Нет активного выбора.');
    return;
  }

  const data = cq.data ?? '';
  const pending = draft.pending;

  if (data === 'new_client:no') {
    await sb
      .from('telegram_order_drafts')
      .update({ pending: null, client_phone: null })
      .eq('telegram_user_id', telegramUserId);
    await sendMessage(chatId, 'Ок, введите телефон клиента ещё раз.');
    return;
  }

  if (data === 'new_client:yes' && pending.type === 'confirm_new_client') {
    await sb
      .from('telegram_order_drafts')
      .update({ step: 'awaiting_new_client_name', pending: null })
      .eq('telegram_user_id', telegramUserId);
    await sendMessage(chatId, 'Введите имя нового клиента.');
    return;
  }

  if (data.startsWith('pick_client:') && pending.type === 'pick_client') {
    const idx = Number(data.split(':')[1]);
    const client = pending.candidates[idx];
    if (!client) {
      await sendMessage(chatId, 'Не удалось выбрать клиента.');
      return;
    }
    await sb
      .from('telegram_order_drafts')
      .update({
        client_id: client.id,
        client_name: client.name,
        client_phone: client.phone,
        step: 'adding_items',
        pending: null,
        updated_at: new Date().toISOString(),
      })
      .eq('telegram_user_id', telegramUserId);
    await sendMessage(
      chatId,
      `Клиент: ${client.name}${client.phone ? ' — ' + client.phone : ''}.\n\n` + itemsHelpText()
    );
    return;
  }

  if (data.startsWith('pick_variant:') && pending.type === 'pick_variant') {
    const idx = Number(data.split(':')[1]);
    const candidate = pending.candidates[idx];
    if (!candidate) {
      await sendMessage(chatId, 'Не удалось выбрать вариант.');
      return;
    }
    await addItemToDraft(sb, draft, chatId, candidate.variant, pending.quantity);
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
    const cmd = text.split(/\s+/)[0];
    if (cmd === '/start') {
      await sendMessage(chatId, 'Доступные команды:\n/new_order — начать новый заказ');
      return;
    }
    if (cmd === '/new_order') {
      await startNewOrder(sb, telegramUserId, chatId);
      return;
    }
    if (cmd === '/cancel') {
      await sb.from('telegram_order_drafts').delete().eq('telegram_user_id', telegramUserId);
      await sendMessage(chatId, 'Черновик заказа отменён.');
      return;
    }
    if (cmd === '/preview') {
      await previewDraft(sb, telegramUserId, chatId);
      return;
    }
    if (cmd === '/confirm') {
      await confirmDraft(sb, telegramUserId, chatId);
      return;
    }
    await sendMessage(chatId, 'Неизвестная команда. Доступно: /new_order, /preview, /confirm, /cancel.');
    return;
  }

  const draft = await getDraft(sb, telegramUserId);
  if (!draft) {
    await sendMessage(chatId, 'Нет активного заказа. Наберите /new_order, чтобы начать.');
    return;
  }
  if (draft.pending) {
    await sendMessage(chatId, 'Сначала выберите вариант из списка выше (или /cancel).');
    return;
  }

  if (draft.step === 'awaiting_phone') {
    await handleClientSearch(sb, draft, chatId, text);
  } else if (draft.step === 'awaiting_new_client_name') {
    await handleNewClientName(sb, draft, chatId, text);
  } else if (draft.step === 'adding_items') {
    await handleAddItems(sb, draft, chatId, text);
  } else {
    await sendMessage(chatId, 'Наберите /new_order, чтобы начать заказ.');
  }
}
