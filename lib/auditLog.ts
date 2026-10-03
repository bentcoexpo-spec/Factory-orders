import { formatMoney } from '@/lib/format';
import { formatDateOnly } from '@/lib/dates';

// Ряд из finance_audit_log_view (040_finance_journal.sql).
export interface AuditEntry {
  id: string;
  created_at: string;
  actor: string | null;
  actor_email: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  detail: Record<string, unknown> | null;
  client_name: string | null;
  product_name: string | null;
  expense_title: string | null;
}

export type AuditGroup = 'prices' | 'payments' | 'expenses' | 'repayments' | 'photos';

export const AUDIT_GROUP_LABELS: Record<AuditGroup, string> = {
  prices: 'Цены',
  payments: 'Оплаты',
  expenses: 'Расходы',
  repayments: 'Погашения',
  photos: 'Фото чеков',
};

const GROUP_BY_ENTITY: Record<string, AuditGroup> = {
  product: 'prices',
  client_product_price: 'prices',
  order_items: 'prices',
  client_payments: 'payments',
  expenses: 'expenses',
  expense_repayments: 'repayments',
  payment_photos: 'photos',
  expense_photos: 'photos',
};

// Какие типы записей относятся к группе — для фильтра на сервере.
export function entityTypesOf(group: AuditGroup): string[] {
  return Object.entries(GROUP_BY_ENTITY)
    .filter(([, g]) => g === group)
    .map(([entity]) => entity);
}

export function groupOf(entry: AuditEntry): AuditGroup | null {
  return GROUP_BY_ENTITY[entry.entity_type] ?? null;
}

export type AuditTone = 'neutral' | 'danger' | 'success';

export interface AuditChange {
  label: string;
  from?: string;
  to: string;
}

export interface AuditDescription {
  text: string;
  tone: AuditTone;
  changes: AuditChange[];
}

const FIELD_LABELS: Record<string, string> = {
  amount: 'Сумма',
  paid_at: 'Дата',
  spent_at: 'Дата',
  comment: 'Комментарий',
  title: 'Что купили',
  payment_kind: 'Как платили',
  supplier: 'У кого',
  market: 'Рынок',
};

const MONEY_FIELDS = new Set(['amount']);
const DATE_FIELDS = new Set(['paid_at', 'spent_at']);
const KIND_LABELS: Record<string, string> = { paid: 'Оплатили сразу', credit: 'Взяли в долг' };
const MARKET_LABELS: Record<string, string> = { general: 'Общий', local: 'Внутренний рынок', expo: 'Экспорт' };

function fmtValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (MONEY_FIELDS.has(key)) return formatMoney(Number(value));
  if (DATE_FIELDS.has(key)) return formatDateOnly(String(value));
  if (key === 'payment_kind') return KIND_LABELS[String(value)] ?? String(value);
  if (key === 'market') return MARKET_LABELS[String(value)] ?? String(value);
  return String(value);
}

function money(value: unknown): string {
  return value === null || value === undefined ? 'не задана' : formatMoney(Number(value));
}

// Список изменённых полей у правки: {old, new} -> «Сумма: 4 000 → 4 500».
function diffChanges(detail: Record<string, unknown> | null): AuditChange[] {
  const oldRow = (detail?.old ?? {}) as Record<string, unknown>;
  const newRow = (detail?.new ?? {}) as Record<string, unknown>;
  const changes: AuditChange[] = [];
  for (const key of Object.keys(FIELD_LABELS)) {
    if (!(key in oldRow) && !(key in newRow)) continue;
    if (oldRow[key] === newRow[key]) continue;
    changes.push({ label: FIELD_LABELS[key], from: fmtValue(key, oldRow[key]), to: fmtValue(key, newRow[key]) });
  }
  return changes;
}

// Ключевые поля вставки/удаления одной строкой списка.
function snapshot(detail: Record<string, unknown> | null): AuditChange[] {
  const row = (detail ?? {}) as Record<string, unknown>;
  const out: AuditChange[] = [];
  for (const key of Object.keys(FIELD_LABELS)) {
    if (row[key] === undefined || row[key] === null || row[key] === '') continue;
    out.push({ label: FIELD_LABELS[key], to: fmtValue(key, row[key]) });
  }
  return out;
}

export function describeEntry(e: AuditEntry): AuditDescription {
  const d = e.detail;
  const client = e.client_name ? `«${e.client_name}»` : 'клиента (запись удалена)';
  const product = e.product_name ? `«${e.product_name}»` : 'товара';
  const expense = e.expense_title ? `«${e.expense_title}»` : 'расхода (запись удалена)';

  switch (`${e.entity_type}:${e.action}`) {
    case 'product:price_change':
      return {
        text: `изменил обычную цену товара ${product}: ${money(d?.old_price)} → ${money(d?.new_price)}`,
        tone: 'neutral',
        changes: [],
      };
    case 'client_product_price:client_price_set':
      return { text: `задал особую цену клиенту ${client} на ${product}: ${money(d?.price)}`, tone: 'neutral', changes: [] };
    case 'client_product_price:client_price_update':
      return {
        text: `изменил особую цену клиента ${client} на ${product}: ${money(d?.old_price)} → ${money(d?.new_price)}`,
        tone: 'neutral',
        changes: [],
      };
    case 'client_product_price:client_price_delete':
      return { text: `убрал особую цену клиента ${client} на ${product} (было ${money(d?.price)})`, tone: 'danger', changes: [] };

    case 'order_items:update': {
      const oldRow = (d?.old ?? {}) as Record<string, unknown>;
      const newRow = (d?.new ?? {}) as Record<string, unknown>;
      return {
        text: `изменил цену в чеке клиента ${client} (${product}): ${money(oldRow.price)} → ${money(newRow.price)}`,
        tone: 'neutral',
        changes: [],
      };
    }

    case 'client_payments:insert':
      return { text: `внёс оплату от ${client}: ${money(d?.amount)}`, tone: 'success', changes: snapshot(d) };
    case 'client_payments:update':
      return { text: `изменил оплату от ${client}`, tone: 'neutral', changes: diffChanges(d) };
    case 'client_payments:delete':
      return { text: `удалил оплату от ${client}: ${money(d?.amount)}`, tone: 'danger', changes: snapshot(d) };

    case 'expenses:insert':
      return { text: `записал расход ${expense}: ${money(d?.amount)}`, tone: 'neutral', changes: snapshot(d) };
    case 'expenses:update':
      return { text: `изменил расход ${expense}`, tone: 'neutral', changes: diffChanges(d) };
    case 'expenses:delete':
      return { text: `удалил расход ${expense}: ${money(d?.amount)}`, tone: 'danger', changes: snapshot(d) };

    case 'expense_repayments:insert':
      return { text: `погасил долг по ${expense}: ${money(d?.amount)}`, tone: 'success', changes: snapshot(d) };
    case 'expense_repayments:delete':
      return { text: `удалил погашение по ${expense}: ${money(d?.amount)}`, tone: 'danger', changes: snapshot(d) };

    case 'payment_photos:insert':
      return { text: `добавил фото к оплате от ${client}`, tone: 'neutral', changes: [] };
    case 'payment_photos:delete':
      return { text: `удалил фото у оплаты от ${client}`, tone: 'danger', changes: [] };
    case 'expense_photos:insert':
      return { text: `добавил фото к расходу ${expense}`, tone: 'neutral', changes: [] };
    case 'expense_photos:delete':
      return { text: `удалил фото у расхода ${expense}`, tone: 'danger', changes: [] };

    default:
      return { text: `${e.action} · ${e.entity_type}`, tone: 'neutral', changes: [] };
  }
}
