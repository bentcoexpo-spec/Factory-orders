export type OrderStatus =
  | 'new'
  | 'confirmed'
  | 'in_production'
  | 'issued'
  | 'shipped'
  | 'paid'
  | 'cancelled'
  | 'closed_unfulfilled';

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

export interface Client {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  created_at: string;
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
}

export const CUTTING_BATCH_STATUS_LABELS: Record<CuttingBatchStatus, string> = {
  cut: 'Раскроено',
  in_sewing: 'В пошиве',
  sewn: 'Пошито, ожидает склад',
};

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
