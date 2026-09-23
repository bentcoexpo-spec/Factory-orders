import type { SupabaseClient } from '@supabase/supabase-js';
import { stockStatus, variantLabel } from '@/lib/types';
import { escapeHtml } from '@/lib/telegram';

// Ежедневный итог для CEO: сколько пришло за день, сколько выдано, что сейчас
// «мало» / «нет в наличии». Запускается планировщиком (Scheduled Job на
// DigitalOcean) каждые 15 минут; само приложение решает, пора ли слать, и
// гарантирует «один раз в день» (см. runDailySummary).

export const SUMMARY_HOUR = 20;
const LINE_CAP = 12;
const LINE_CAP_SHORT = 5;
const MESSAGE_LIMIT = 3800;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

// Календарные поля момента времени в заданном часовом поясе.
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) map[part.type] = part.value;
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), hour: Number(map.hour) % 24, minute: Number(map.minute) };
}

export function dayKey(p: ZonedParts): string {
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// Момент (UTC), в который в заданном поясе наступила полночь «сегодняшнего» дня.
export function localDayStart(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  const offsetMs = localAsUtc - Math.floor(date.getTime() / 60000) * 60000;
  return new Date(Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0) - offsetMs);
}

export interface SummaryLine {
  name: string;
  qty: number;
}

export interface SummaryData {
  arrivals: SummaryLine[];
  arrivedByReceipts: number;
  arrivedByBot: number;
  issued: SummaryLine[];
  issuedOrders: number;
  out: string[];
  low: string[];
}

interface VariantRow {
  id: string;
  product_name: string;
  color: string | null;
  size: string | null;
  print_type: string | null;
  stock_quantity: number | string;
}

function addTo(map: Map<string, number>, name: string, qty: number) {
  map.set(name, (map.get(name) ?? 0) + qty);
}

function toLines(map: Map<string, number>): SummaryLine[] {
  return Array.from(map.entries())
    .map(([name, qty]) => ({ name, qty }))
    .filter((l) => l.qty !== 0)
    .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, 'ru'));
}

// Читает данные итога: только готовая продукция. Любая ошибка запроса —
// исключение (итог с неполными данными лучше не слать вовсе).
export async function loadSummaryData(sb: SupabaseClient, since: Date, until: Date): Promise<SummaryData> {
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();
  const fail = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };

  const { data: variantRows, error: variantsError } = await sb
    .from('product_variants_view')
    .select('id, product_name, color, size, print_type, stock_quantity, warehouse_type')
    .eq('warehouse_type', 'finished_goods')
    .limit(1000);
  fail('variants', variantsError);
  const variants = new Map<string, VariantRow>((variantRows ?? []).map((v: VariantRow) => [v.id, v]));

  // Пришло: «Приход» из веба + добавления через /add_product (не отменённые).
  const { data: receipts, error: receiptsError } = await sb
    .from('stock_receipts')
    .select('variant_id, total_quantity')
    .gte('created_at', sinceIso)
    .lt('created_at', untilIso)
    .limit(5000);
  fail('receipts', receiptsError);
  const { data: actions, error: actionsError } = await sb
    .from('telegram_actions')
    .select('variant_id, quantity')
    .eq('kind', 'product_added')
    .is('undone_at', null)
    .gte('created_at', sinceIso)
    .lt('created_at', untilIso)
    .limit(5000);
  fail('actions', actionsError);

  const arrivals = new Map<string, number>();
  let arrivedByReceipts = 0;
  let arrivedByBot = 0;
  for (const r of (receipts ?? []) as { variant_id: string; total_quantity: number | string }[]) {
    const v = variants.get(r.variant_id);
    if (!v) continue;
    addTo(arrivals, v.product_name, Number(r.total_quantity));
    arrivedByReceipts += Number(r.total_quantity);
  }
  for (const a of (actions ?? []) as { variant_id: string | null; quantity: number | string | null }[]) {
    const v = a.variant_id ? variants.get(a.variant_id) : undefined;
    if (!v) continue;
    addTo(arrivals, v.product_name, Number(a.quantity ?? 0));
    arrivedByBot += Number(a.quantity ?? 0);
  }

  // Выдано: заказы со статусом «Выдан» за период (веб и бот вместе).
  const { data: orders, error: ordersError } = await sb
    .from('orders')
    .select('id')
    .eq('status', 'issued')
    .gte('issued_at', sinceIso)
    .lt('issued_at', untilIso)
    .limit(5000);
  fail('orders', ordersError);
  const orderIds = ((orders ?? []) as { id: string }[]).map((o) => o.id);

  const issued = new Map<string, number>();
  for (let i = 0; i < orderIds.length; i += 200) {
    const { data: items, error: itemsError } = await sb
      .from('order_items')
      .select('variant_id, quantity')
      .in('order_id', orderIds.slice(i, i + 200));
    fail('order_items', itemsError);
    for (const it of (items ?? []) as { variant_id: string; quantity: number | string }[]) {
      const v = variants.get(it.variant_id);
      if (v) addTo(issued, v.product_name, Number(it.quantity));
    }
  }

  // Сейчас мало / нет в наличии — полными вариантами.
  const out: { label: string; qty: number }[] = [];
  const low: { label: string; qty: number }[] = [];
  for (const v of variants.values()) {
    const qty = Number(v.stock_quantity);
    const status = stockStatus(qty);
    if (status === 'ok') continue;
    const label = `${v.product_name}${variantLabel(v) ? ' — ' + variantLabel(v) : ''}: ${qty}`;
    (status === 'out' ? out : low).push({ label, qty });
  }
  const byLabel = (a: { label: string; qty: number }, b: { label: string; qty: number }) => a.qty - b.qty || a.label.localeCompare(b.label, 'ru');

  return {
    arrivals: toLines(arrivals),
    arrivedByReceipts,
    arrivedByBot,
    issued: toLines(issued),
    issuedOrders: orderIds.length,
    out: out.sort(byLabel).map((x) => x.label),
    low: low.sort(byLabel).map((x) => x.label),
  };
}

function capLines(lines: string[], max: number): string[] {
  return lines.length > max ? [...lines.slice(0, max), `…и ещё ${lines.length - max}`] : lines;
}

const fmt = (n: number) => String(Number(n.toFixed(2)));

export function formatSummary(data: SummaryData, dateLabel: string, untilLabel: string): string {
  const build = (cap: number) => {
    const total = (lines: SummaryLine[]) => lines.reduce((s, l) => s + l.qty, 0);
    const productLines = (lines: SummaryLine[]) => capLines(lines.map((l) => `• ${escapeHtml(l.name)} — ${fmt(l.qty)} шт`), cap);

    const blocks: string[] = [`<b>Итог дня — ${dateLabel}</b> (с 00:00 до ${untilLabel})`];

    blocks.push(
      data.arrivals.length === 0
        ? '<b>Пришло</b>\nНичего не приходило.'
        : [
            `<b>Пришло — ${fmt(total(data.arrivals))} шт</b>` +
              ` (через «Приход»: ${fmt(data.arrivedByReceipts)}, через бота: ${fmt(data.arrivedByBot)})`,
            ...productLines(data.arrivals),
          ].join('\n')
    );

    blocks.push(
      data.issued.length === 0
        ? `<b>Выдано</b>\nНичего не выдавалось${data.issuedOrders > 0 ? ` (заказов со статусом «Выдан»: ${data.issuedOrders}, без позиций готовой продукции)` : ''}.`
        : [`<b>Выдано — ${fmt(total(data.issued))} шт</b> (заказов: ${data.issuedOrders})`, ...productLines(data.issued)].join('\n')
    );

    const stockLines = [
      ...capLines(data.out.map((l) => `❌ ${escapeHtml(l)}`), cap),
      ...capLines(data.low.map((l) => `⚠️ ${escapeHtml(l)}`), cap),
    ];
    blocks.push(
      stockLines.length === 0
        ? '<b>Остатки</b>\nВсё в достатке: нет позиций «мало» или «нет в наличии».'
        : ['<b>Мало / нет в наличии</b>', ...stockLines].join('\n')
    );

    return blocks.join('\n\n');
  };

  const full = build(LINE_CAP);
  return full.length <= MESSAGE_LIMIT ? full : build(LINE_CAP_SHORT);
}

export type SummaryStatus = 'sent' | 'too_early' | 'already_sent' | 'send_failed' | 'error';

export interface SummaryOutcome {
  status: SummaryStatus;
  day: string;
  detail?: string;
}

// Отправляет итог, если пора и сегодня ещё не отправляли. Вызывается часто
// (каждые 15 минут): «пора» — это локальное время в поясе не раньше 20:00 (и
// до полуночи), а «один раз» гарантирует таблица daily_summaries: день
// занимается вставкой строки ДО отправки. Если отправка не удалась, день
// освобождается, и ближайший запуск повторит попытку.
export async function runDailySummary(
  sb: SupabaseClient,
  now: Date,
  timeZone: string,
  send: (text: string) => Promise<boolean>,
  options: { force?: boolean } = {}
): Promise<SummaryOutcome> {
  const parts = zonedParts(now, timeZone);
  const day = dayKey(parts);

  // Пробная отправка (?force=1): в любое время, день не занимается — настоящий
  // вечерний итог всё равно уйдёт в свой час.
  if (options.force) {
    try {
      const data = await loadSummaryData(sb, localDayStart(now, timeZone), now);
      const dateLabel = `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}.${parts.year}`;
      const untilLabel = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
      const ok = await send(formatSummary(data, dateLabel, untilLabel));
      return ok ? { status: 'sent', day, detail: 'forced' } : { status: 'send_failed', day, detail: 'forced' };
    } catch (err) {
      return { status: 'error', day, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  if (parts.hour < SUMMARY_HOUR) return { status: 'too_early', day };

  const { error: claimError } = await sb.from('daily_summaries').insert({ day });
  if (claimError) {
    if (claimError.code === '23505') return { status: 'already_sent', day };
    return { status: 'error', day, detail: claimError.message };
  }

  const release = async () => {
    try {
      await sb.from('daily_summaries').delete().eq('day', day);
    } catch (err) {
      console.error('daily summary: could not release the day', err);
    }
  };

  try {
    const since = localDayStart(now, timeZone);
    const data = await loadSummaryData(sb, since, now);
    const dateLabel = `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}.${parts.year}`;
    const untilLabel = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
    const ok = await send(formatSummary(data, dateLabel, untilLabel));
    if (!ok) {
      await release();
      return { status: 'send_failed', day };
    }
    await sb
      .from('daily_summaries')
      .update({
        stats: {
          arrived: data.arrivedByReceipts + data.arrivedByBot,
          issued_orders: data.issuedOrders,
          out: data.out.length,
          low: data.low.length,
        },
      })
      .eq('day', day);
    return { status: 'sent', day };
  } catch (err) {
    await release();
    return { status: 'error', day, detail: err instanceof Error ? err.message : String(err) };
  }
}
