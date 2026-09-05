export type OrderStatus = 'new' | 'confirmed' | 'in_production' | 'shipped' | 'paid' | 'cancelled';

export type Role = 'ceo' | 'kladovshik';

export interface Profile {
  id: string;
  email: string;
  role: Role;
}

export interface Client {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  created_at: string;
}

export interface Product {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  stock_quantity: number;
  price: number | null;
  created_at: string;
}

export interface OrderItemView {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  product_unit: string;
  quantity: number;
  price: number | null;
  created_at: string;
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
}

// Полная (немаскированная) форма заказа для аналитики — доступна
// только CEO, т.к. таблицы orders/order_items/products/clients
// напрямую разрешены только его роли (см. supabase/003_roles_and_stock.sql).
export interface AnalyticsOrderItem {
  id: string;
  product_id: string;
  quantity: number;
  price: number;
  product?: { id: string; name: string; unit: string } | null;
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
  { value: 'shipped', label: 'Отгружен', color: 'bg-purple-500' },
  { value: 'paid', label: 'Оплачен', color: 'bg-green-600' },
  { value: 'cancelled', label: 'Отменён', color: 'bg-red-600' },
];

export const ROLE_LABELS: Record<Role, string> = {
  ceo: 'CEO',
  kladovshik: 'Кладовщик',
};
