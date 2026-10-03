export type OrderStatus =
  | 'new'
  | 'confirmed'
  | 'in_production'
  | 'issued'
  | 'shipped'
  | 'paid'
  | 'cancelled'
  | 'closed_unfulfilled'
  | 'returned';

// Причина завершения заказа, у которого на момент выдачи не хватило
// остатка хотя бы по одной позиции (см. complete_order_with_shortage
// в supabase/009_order_shortage_handling.sql).
export type CompletionReason = 'partial_pickup' | 'no_stock';

export const COMPLETION_REASON_LABELS: Record<CompletionReason, string> = {
  partial_pickup: 'Клиент забрал, что было в наличии',
  no_stock: 'Не было на складе',
};

export type Role = 'ceo' | 'kladovshik' | 'zakroyshik' | 'master';

export interface Profile {
  id: string;
  email: string;
  role: Role;
}

// Цех — "Фабрика" и "Цех" физически разные площадки со своими
// сотрудниками/табелем/сделкой/партиями. NULL у мастера в профиле значит
// "ещё не выбрал", тогда интерфейс показывает экран выбора.
export type Shop = 'factory' | 'workshop';

export const SHOP_LABELS: Record<Shop, string> = {
  factory: 'Фабрика',
  workshop: 'Цех',
};

export type ClientCategory = 'expo' | 'local';

export const CLIENT_CATEGORY_LABELS: Record<ClientCategory, string> = {
  expo: 'Expo',
  local: 'Внутренний рынок',
};

export interface Client {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  category: ClientCategory | null;
  created_at: string;
}

// Ряд из client_debt_view — долг клиента одной строкой: сумма выданных
// заказов минус сумма оплат (034_client_finance.sql).
export interface ClientDebt {
  id: string;
  name: string;
  phone: string | null;
  category: ClientCategory | null;
  created_at: string;
  issued_total: number;
  paid_total: number;
  debt: number;
}

// Ряд из client_payments_view — одна оплата клиента на общий счёт, не
// привязанная к конкретному заказу. paid_at — дата оплаты (вводится
// вручную, 'YYYY-MM-DD'); created_at — настоящее время ввода записи.
export interface ClientPayment {
  id: string;
  client_id: string;
  amount: number;
  comment: string | null;
  created_by: string | null;
  created_by_email: string | null;
  created_at: string;
  paid_at: string;
  updated_at: string | null;
  client_name: string;
  client_category: ClientCategory | null;
  photo_count: number;
}

// Переключатель рынка на всех вкладках «Финансов». У клиента рынок —
// его category; у расхода — собственная метка market ('general' виден
// только при «Все»).
export type FinanceMarket = 'all' | 'local' | 'expo';

export const FINANCE_MARKET_LABELS: Record<FinanceMarket, string> = {
  all: 'Все',
  local: 'Внутренний рынок',
  expo: 'Экспорт',
};

export type ExpenseMarket = 'general' | 'local' | 'expo';

export const EXPENSE_MARKET_LABELS: Record<ExpenseMarket, string> = {
  general: 'Общий',
  local: 'Внутренний рынок',
  expo: 'Экспорт',
};

export type ExpensePaymentKind = 'paid' | 'credit';

export const EXPENSE_KIND_LABELS: Record<ExpensePaymentKind, string> = {
  paid: 'Оплатили',
  credit: 'Взяли в долг',
};

// Ряд из expenses_view. debt_left — остаток долга (0 у «Оплатили»).
export interface Expense {
  id: string;
  title: string;
  amount: number;
  spent_at: string;
  payment_kind: ExpensePaymentKind;
  supplier: string | null;
  market: ExpenseMarket;
  comment: string | null;
  repaid_total: number;
  debt_left: number;
  created_by: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string | null;
  photo_count: number;
}

export interface ExpenseRepayment {
  id: string;
  expense_id: string;
  amount: number;
  paid_at: string;
  comment: string | null;
  created_at: string;
}

// Ряд из finance_receipts_view / finance_receipt_items_view — чек
// (выданный/возвращённый заказ) с категорией клиента.
export interface FinanceReceipt {
  id: string;
  client_id: string;
  client_name: string;
  client_category: ClientCategory | null;
  status: 'issued' | 'returned';
  issued_at: string | null;
  returned_at: string | null;
  total: number | null;
  has_unpriced_item: boolean;
}

export interface FinanceReceiptItem {
  id: string;
  order_id: string;
  client_id: string;
  client_name: string;
  client_category: ClientCategory | null;
  status: 'issued' | 'returned';
  issued_at: string | null;
  product_name: string;
  color: string | null;
  size: string | null;
  unit: string | null;
  quantity: number;
  price: number | null;
  line_total: number | null;
}

// Ответ finance_summary (038_finance_payments_expenses.sql).
export interface FinanceSummary {
  sold: number;
  received: number;
  spent: number;
  left: number;
  owed_to_us: number;
  we_owe: number;
  months: { month: string; sold: number; received: number; spent: number }[];
  top_debtors: { id: string; name: string; debt: number }[];
}

// Товар без разбивки по вариантам — ровно одна цена на товар
// (036_pricing_and_receipts.sql). price = null значит "цена не задана"
// (раньше были неразличимы с ценой 0).
export interface Product {
  id: string;
  name: string;
  price: number | null;
  warehouse_type: WarehouseType;
}

// Ряд из client_product_prices_view — особая цена конкретного клиента на
// конкретный товар, если обычная цена товара ему не подходит.
export interface ClientProductPrice {
  id: string;
  client_id: string;
  client_name: string;
  product_id: string;
  product_name: string;
  price: number;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export type WarehouseType = 'production' | 'finished_goods';

export const WAREHOUSE_TYPE_LABELS: Record<WarehouseType, string> = {
  finished_goods: 'Готовая продукция',
  production: 'Склад сырья',
};

// Ряд из product_variants_view: одна комбинация цвет+размер+печать
// конкретного товара. Цена и тип склада общие на весь товар (лежат в
// products), цена видна только CEO.
export interface ProductVariant {
  id: string;
  product_id: string;
  product_name: string;
  color: string | null;
  size: string | null;
  print_type: string;
  sku: string | null;
  unit: string;
  stock_quantity: number;
  price: number | null;
  created_at: string;
  warehouse_type: WarehouseType;
}

export const LOW_STOCK_THRESHOLD = 30;
export const NO_PRINT = 'без печати';

// Единый порядок размеров — везде в приложении, где список размеров
// показывается пользователю (раньше был localeCompare, который даёт
// алфавитный, а не размерный порядок: "L" < "M" < "S" < "XL"). Числовые
// размеры (42, 44…) сортируются по значению; буквенные — по "ширине"
// S < M < L < XL < XXL < XXXL и дальше; "2XL"/"3XL"/"4XL" — то же самое,
// что "XXL"/"XXXL"/"XXXXL", получают тот же ранг, чтобы порядок не
// зависел от того, как размер записан. Нераспознанное — в конец,
// по алфавиту.
const BASE_LETTER_SIZES = ['XXS', 'XS', 'S', 'M', 'L'];

function xlCount(token: string): number | null {
  const repeated = /^(X+)L$/.exec(token);
  if (repeated) return repeated[1].length;
  const numbered = /^(\d+)XL$/.exec(token);
  if (numbered) return Number(numbered[1]);
  return null;
}

export function sizeRank(size: string | null): number {
  if (!size) return 1e9;
  const trimmed = size.trim();
  if (trimmed === '') return 1e9;
  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric)) return numeric;
  const upper = trimmed.toUpperCase();
  const baseIdx = BASE_LETTER_SIZES.indexOf(upper);
  if (baseIdx >= 0) return 1000 + baseIdx;
  const xl = xlCount(upper);
  if (xl !== null) return 1000 + BASE_LETTER_SIZES.length - 1 + xl;
  return 5000;
}

export function sortSizes<T extends string | null>(sizes: T[]): T[] {
  return [...sizes].sort((a, b) => sizeRank(a) - sizeRank(b) || String(a ?? '').localeCompare(String(b ?? ''), 'ru'));
}

export function stockStatus(quantity: number): 'out' | 'low' | 'ok' {
  if (quantity <= 0) return 'out';
  if (quantity <= LOW_STOCK_THRESHOLD) return 'low';
  return 'ok';
}

export function variantLabel(variant: { color: string | null; size: string | null; print_type?: string | null }) {
  const parts = [variant.size, variant.color].filter(Boolean);
  if (variant.print_type && variant.print_type !== NO_PRINT) parts.push(variant.print_type);
  return parts.length > 0 ? parts.join(', ') : null;
}

export interface OrderItemView {
  id: string;
  order_id: string;
  variant_id: string;
  product_name: string;
  color: string | null;
  size: string | null;
  print_type: string;
  product_unit: string;
  quantity: number;
  price: number | null;
  created_at: string;
  stock_quantity: number;
}

export interface OrderView {
  id: string;
  client_id: string;
  client_name: string;
  client_address: string | null;
  client_phone: string | null;
  client_email: string | null;
  status: OrderStatus;
  total: number | null;
  comment: string | null;
  stock_deducted: boolean;
  created_at: string;
  issued_at: string | null;
  completion_reason: CompletionReason | null;
  closed_at: string | null;
  // Имя кладовщика, выдавшего заказ через Telegram-бота (у заказов, выданных
  // через сайт, и у прежних заказов — null).
  issued_by_name: string | null;
  // Когда/кем вернули уже выданный заказ (статус "returned") — видно
  // только CEO, у кладовщика оба поля всегда null (032_order_returns.sql).
  returned_at: string | null;
  returned_by_email: string | null;
  // Есть ли среди позиций заказа хоть одна без цены — видно только CEO
  // (036_pricing_and_receipts.sql).
  has_unpriced_item: boolean | null;
}

// Ряд из stock_receipts_view — запись в истории поступлений.
export interface StockReceipt {
  id: string;
  variant_id: string;
  product_name: string;
  color: string | null;
  size: string | null;
  print_type: string;
  unit: string;
  packs: number;
  units_per_pack: number;
  loose_units: number;
  total_quantity: number;
  brought_by: string | null;
  comment: string | null;
  created_by: string | null;
  created_at: string;
}

// Полная (немаскированная) форма заказа для аналитики — доступна
// только CEO, т.к. таблицы orders/order_items/product_variants/products/
// clients напрямую разрешены только его роли (см. supabase/*.sql).
export interface AnalyticsOrderItem {
  id: string;
  variant_id: string;
  quantity: number;
  price: number;
  variant?: {
    id: string;
    color: string | null;
    size: string | null;
    print_type: string | null;
    unit: string;
    product?: { id: string; name: string } | null;
  } | null;
}

export interface AnalyticsOrder {
  id: string;
  client_id: string;
  status: OrderStatus;
  total: number;
  created_at: string;
  client?: { id: string; name: string } | null;
  items?: AnalyticsOrderItem[];
}

export const ORDER_STATUSES: { value: OrderStatus; label: string; color: string }[] = [
  { value: 'new', label: 'Новый', color: 'bg-slate-500' },
  { value: 'confirmed', label: 'Подтверждён', color: 'bg-blue-500' },
  { value: 'in_production', label: 'В производстве', color: 'bg-amber-500' },
  { value: 'issued', label: 'Выдан', color: 'bg-teal-600' },
  { value: 'shipped', label: 'Отгружен', color: 'bg-purple-500' },
  { value: 'paid', label: 'Оплачен', color: 'bg-green-600' },
  { value: 'cancelled', label: 'Отменён', color: 'bg-red-600' },
  { value: 'closed_unfulfilled', label: 'Закрыт без выдачи', color: 'bg-slate-400' },
  { value: 'returned', label: 'Возвращено', color: 'bg-orange-500' },
];

export const ROLE_LABELS: Record<Role, string> = {
  ceo: 'CEO',
  kladovshik: 'Кладовщик',
  zakroyshik: 'Закройщик',
  master: 'Мастер цеха',
};

// Ряд из raw_material_colors_view — материал+цвет, единица учёта
// остатка склада сырья (в рулонах). Ширина/вес/поставщик — не здесь,
// они у конкретной поставки в RawMaterialReceipt.
export interface RawMaterialColor {
  id: string;
  material_id: string;
  material_name: string;
  color: string;
  stock_rolls: number;
  created_at: string;
}

// Ряд из raw_material_receipts_view — одна поставка сырья.
export interface RawMaterialReceipt {
  id: string;
  color_id: string;
  material_name: string;
  color: string;
  color_code: string | null;
  width_cm: number | null;
  weight_kg: number | null;
  rolls: number;
  truck_number: string | null;
  supplier_invoice_number: string | null;
  supplier_batch_number: string | null;
  supplier_name: string | null;
  created_by: string | null;
  created_at: string;
}

// Ряд из raw_material_issues_view — одна выдача сырья в цех.
export interface RawMaterialIssue {
  id: string;
  color_id: string;
  material_name: string;
  color: string;
  rolls: number;
  taken_by: string;
  created_by: string | null;
  created_at: string;
}

export interface CuttingBatchSize {
  size: string;
  quantity: number;
  // Подтверждено мастером при приёмке кроя (null — ещё не подтверждено).
  // Заявленное закройщиком quantity выше не меняется никогда — это два
  // разных числа специально, чтобы видеть систематические расхождения.
  confirmed_quantity: number | null;
  // Сшито готово / брак при отчёте о готовом (null — ещё не сдано).
  sewn_quantity: number | null;
  sewn_defect_quantity: number | null;
}

// Товар внутри партии (cutting_batch_products) с его размерами — с
// одного раскроя может выйти сразу несколько разных изделий.
export interface CuttingBatchProduct {
  product_name: string;
  total_quantity: number;
  sizes: CuttingBatchSize[];
}

export type CuttingBatchStatus = 'cut' | 'in_sewing' | 'sewn';

// Ряд из cutting_batches_view — партия раскроя: результат одного взятия
// материала (raw_material_issues) по всем вышедшим из него товарам.
// Статус идёт "cut" (заявлено закройщиком) -> "in_sewing" (мастер принял
// крой) -> "sewn" (мастер сдал готовое, ждёт склад). Пока без привязки к
// конкретному фасону из каталога — её добавит будущая роль "Мастер цеха"
// (эта роль уже есть, но каталог фасонов — нет).
export interface CuttingBatch {
  id: string;
  batch_number: number;
  status: CuttingBatchStatus;
  issue_id: string;
  material_name: string;
  color: string;
  color_id: string;
  rolls_taken: number;
  taken_by: string;
  total_quantity: number;
  products: CuttingBatchProduct[];
  created_by: string | null;
  created_at: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  sewn_by: string | null;
  sewn_at: string | null;
  shop: Shop;
  // Заявка, по которой кроили (этап 3 «Заявка закройщику») — null,
  // если партия раскроена без привязки к заявке, как и раньше.
  request_id: string | null;
}

export const CUTTING_BATCH_STATUS_LABELS: Record<CuttingBatchStatus, string> = {
  cut: 'Раскроено',
  in_sewing: 'В пошиве',
  sewn: 'Пошито, ожидает склад',
};

// Заявка закройщику (cutting_requests_view): что CEO просит раскроить —
// материал/цвет (как у выдачи "Взять для цеха"), план по товарам/
// размерам и факт — сумма того, что уже вышло из привязанных партий
// (по названию товара, без разбивки по размеру — закройщик не обязан
// кроить размеры ровно так, как запланировано).
export type CuttingRequestStatus = 'new' | 'in_progress' | 'done' | 'cancelled';

export const CUTTING_REQUEST_STATUS_LABELS: Record<CuttingRequestStatus, string> = {
  new: 'Новая',
  in_progress: 'В работе',
  done: 'Выполнена',
  cancelled: 'Отменена',
};

// size === null значит "без разбивки по размерам" — просто общее
// количество для этого товара.
export interface CuttingRequestSize {
  size: string | null;
  quantity: number;
}

export interface CuttingRequestProduct {
  product_name: string;
  plan_total: number;
  fact_total: number;
  sizes: CuttingRequestSize[];
}

export interface CuttingRequest {
  id: string;
  color_id: string;
  material_name: string;
  color: string;
  rolls_hint: number | null;
  comment: string | null;
  status: CuttingRequestStatus;
  products: CuttingRequestProduct[];
  plan_total: number;
  fact_total: number;
  created_by: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

// Ряд из cutting_batch_items_view — одна размерная строка партии.
// batch_product_id/size/quantity — заявка закройщика (не редактируется
// мастером, см. 022_cutting_batch_master_workflow.sql); остальное
// заполняет мастер по ходу приёмки/отчёта.
export interface CuttingBatchItemRow {
  id: string;
  batch_product_id: string;
  size: string;
  quantity: number;
  confirmed_quantity: number | null;
  sewn_quantity: number | null;
  sewn_defect_quantity: number | null;
}

// Ряд из defect_photos_view — фото/видео брака ткани, найденного во
// время кроя. Привязка к материалу+цвету и к партии независимы и обе
// необязательны (могут быть null по отдельности), см. README. Фото и
// видео тоже оба необязательны по отдельности, но хотя бы один из них
// обязан быть — это гарантирует CHECK в базе.
export interface DefectPhoto {
  id: string;
  color_id: string | null;
  material_name: string | null;
  color: string | null;
  photo_path: string | null;
  video_path: string | null;
  weight_kg: number | null;
  created_by: string | null;
  created_at: string;
  batch_id: string | null;
  batch_number: number | null;
}

// Сотрудник цеха (справочник для табеля и сдельной оплаты). Привязан к
// конкретному цеху — RLS уже отдаёт мастеру только сотрудников его
// текущего цеха, поле нужно в основном для инсерта нового сотрудника.
export interface Employee {
  id: string;
  name: string;
  shop: Shop;
  created_at: string;
}

// Ряд из attendance_view — отметка явки. Строка существует = сотрудник
// пришёл в этот день; "не пришёл" — просто отсутствие строки, а не
// отдельное значение поля.
export interface AttendanceRecord {
  id: string;
  employee_id: string;
  employee_name: string;
  date: string;
  marked_by: string | null;
  created_at: string;
}

// Тип операции/станции (например "Оверлок") со ставкой за штуку —
// мастер заводит и правит ставки прямо в интерфейсе.
export interface OperationType {
  id: string;
  name: string;
  rate_per_piece: number;
  created_at: string;
}

// Ряд из work_records_view — одна запись о выполненной работе. Один
// сотрудник может иметь за день сколько угодно записей с разными
// операциями, поэтому это журнал, а не "операция дня".
export interface WorkRecord {
  id: string;
  employee_id: string;
  employee_name: string;
  operation_type_id: string;
  operation_name: string;
  rate_per_piece: number;
  quantity: number;
  line_total: number;
  date: string;
  batch_id: string | null;
  batch_number: number | null;
  created_by: string | null;
  created_at: string;
}
