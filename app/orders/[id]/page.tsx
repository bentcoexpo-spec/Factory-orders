'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { OrderView, OrderItemView, OrderStatus, ORDER_STATUSES } from '@/lib/types';
import { formatDate, formatMoney } from '@/lib/format';
import StatusBadge from '@/components/StatusBadge';
import { useRole } from '@/components/RoleProvider';

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { role } = useRole();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [items, setItems] = useState<OrderItemView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadOrder() {
    setLoading(true);
    const [{ data: orderData, error: orderError }, { data: itemsData, error: itemsError }] = await Promise.all([
      supabase.from('orders_view').select('*').eq('id', params.id).single(),
      supabase.from('order_items_view').select('*').eq('order_id', params.id),
    ]);
    if (orderError) setError(orderError.message);
    else if (itemsError) setError(itemsError.message);
    else {
      setOrder(orderData as unknown as OrderView);
      setItems((itemsData as unknown as OrderItemView[]) ?? []);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  async function handleStatusChange(status: OrderStatus) {
    if (!order) return;
    setError(null);
    const { error } = await supabase.from('orders_view').update({ status }).eq('id', order.id);
    if (error) setError(error.message);
    else loadOrder();
  }

  async function handleDelete() {
    if (!order) return;
    if (!confirm('Удалить заказ?')) return;
    const { error } = await supabase.from('orders_view').delete().eq('id', order.id);
    if (error) setError(error.message);
    else router.push('/orders');
  }

  if (loading) return <p className="text-sm text-slate-400">Загрузка…</p>;
  if (!order) return <p className="text-sm text-red-600">{error ?? 'Заказ не найден'}</p>;

  const showTotal = order.total !== null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/orders" className="text-xs font-medium text-indigo-600 hover:underline">
            ← Все заказы
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">Заказ №{order.id.slice(0, 8)}</h1>
          <p className="mt-1 text-sm text-slate-500">Создан {formatDate(order.created_at)}</p>
        </div>
        <StatusBadge status={order.status} />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Клиент</h2>
          <p className="text-sm text-slate-800">{order.client_name}</p>
          {order.client_address && <p className="text-sm text-slate-500">{order.client_address}</p>}
          {order.client_phone && <p className="text-sm text-slate-500">{order.client_phone}</p>}
          {order.client_email && <p className="text-sm text-slate-500">{order.client_email}</p>}
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Статус заказа</h2>
          <div className="flex flex-wrap gap-2">
            {ORDER_STATUSES.map((s) => (
              <button
                key={s.value}
                onClick={() => handleStatusChange(s.value)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  order.status === s.value ? `${s.color} text-white` : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {order.comment && <p className="mt-3 text-sm text-slate-500">Комментарий: {order.comment}</p>}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3">Товар</th>
              <th className="px-4 py-3">Кол-во</th>
              {showTotal && <th className="px-4 py-3">Цена</th>}
              {showTotal && <th className="px-4 py-3">Сумма</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((item) => (
              <tr key={item.id}>
                <td className="px-4 py-3 font-medium text-slate-800">{item.product_name}</td>
                <td className="px-4 py-3 text-slate-600">
                  {item.quantity} {item.product_unit}
                </td>
                {showTotal && <td className="px-4 py-3 text-slate-600">{formatMoney(item.price ?? 0)}</td>}
                {showTotal && (
                  <td className="px-4 py-3 text-slate-600">{formatMoney((item.price ?? 0) * item.quantity)}</td>
                )}
              </tr>
            ))}
          </tbody>
          {showTotal && (
            <tfoot>
              <tr>
                <td colSpan={3} className="px-4 py-3 text-right text-sm font-semibold text-slate-700">
                  Итого
                </td>
                <td className="px-4 py-3 text-sm font-semibold text-slate-900">{formatMoney(order.total ?? 0)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {role === 'ceo' && (
        <button onClick={handleDelete} className="text-xs font-medium text-red-600 hover:underline">
          Удалить заказ
        </button>
      )}
    </div>
  );
}
