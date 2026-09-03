'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { Order, OrderStatus, ORDER_STATUSES } from '@/lib/types';
import { formatDate, formatMoney } from '@/lib/format';
import StatusBadge from '@/components/StatusBadge';

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadOrder() {
    setLoading(true);
    const { data, error } = await supabase
      .from('orders')
      .select('*, client:clients(*), items:order_items(*, product:products(*))')
      .eq('id', params.id)
      .single();
    if (error) setError(error.message);
    else setOrder(data as unknown as Order);
    setLoading(false);
  }

  useEffect(() => {
    loadOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  async function handleStatusChange(status: OrderStatus) {
    if (!order) return;
    const { error } = await supabase.from('orders').update({ status }).eq('id', order.id);
    if (error) setError(error.message);
    else loadOrder();
  }

  async function handleDelete() {
    if (!order) return;
    if (!confirm('Удалить заказ?')) return;
    const { error } = await supabase.from('orders').delete().eq('id', order.id);
    if (error) setError(error.message);
    else router.push('/orders');
  }

  if (loading) return <p className="text-sm text-slate-400">Загрузка…</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!order) return <p className="text-sm text-slate-400">Заказ не найден</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/orders" className="text-xs font-medium text-blue-600 hover:underline">
            ← Все заказы
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">Заказ №{order.id.slice(0, 8)}</h1>
          <p className="mt-1 text-sm text-slate-500">Создан {formatDate(order.created_at)}</p>
        </div>
        <StatusBadge status={order.status} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Клиент</h2>
          <p className="text-sm text-slate-800">{order.client?.name}</p>
          <p className="text-sm text-slate-500">{order.client?.phone}</p>
          <p className="text-sm text-slate-500">{order.client?.email}</p>
          <p className="text-sm text-slate-500">{order.client?.address}</p>
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
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Товар</th>
              <th className="px-4 py-3">Кол-во</th>
              <th className="px-4 py-3">Цена</th>
              <th className="px-4 py-3">Сумма</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {order.items?.map((item) => (
              <tr key={item.id}>
                <td className="px-4 py-3 font-medium text-slate-800">{item.product?.name ?? '—'}</td>
                <td className="px-4 py-3 text-slate-600">
                  {item.quantity} {item.product?.unit}
                </td>
                <td className="px-4 py-3 text-slate-600">{formatMoney(item.price)}</td>
                <td className="px-4 py-3 text-slate-600">{formatMoney(item.quantity * item.price)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} className="px-4 py-3 text-right text-sm font-semibold text-slate-700">
                Итого
              </td>
              <td className="px-4 py-3 text-sm font-semibold text-slate-900">{formatMoney(order.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <button onClick={handleDelete} className="text-xs font-medium text-red-600 hover:underline">
        Удалить заказ
      </button>
    </div>
  );
}
