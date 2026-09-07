'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import {
  OrderView,
  OrderItemView,
  OrderStatus,
  ORDER_STATUSES,
  COMPLETION_REASON_LABELS,
  CompletionReason,
  variantLabel,
} from '@/lib/types';
import { formatDate, formatMoney } from '@/lib/format';
import StatusBadge from '@/components/StatusBadge';
import { useRole } from '@/components/RoleProvider';

const STATUS_BUTTONS = ORDER_STATUSES.filter((s) => s.value !== 'closed_unfulfilled');

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { role } = useRole();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [items, setItems] = useState<OrderItemView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showShortageDialog, setShowShortageDialog] = useState(false);
  const [resolvingShortage, setResolvingShortage] = useState(false);

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

  const hasShortage = items.some((it) => it.quantity > it.stock_quantity);

  function handleStatusButtonClick(status: OrderStatus) {
    if (status === 'issued' && order?.status === 'new' && hasShortage) {
      setShowShortageDialog(true);
      return;
    }
    handleStatusChange(status);
  }

  async function handleStatusChange(status: OrderStatus) {
    if (!order) return;
    setError(null);
    const { error } = await supabase.from('orders_view').update({ status }).eq('id', order.id);
    if (error) setError(error.message);
    else loadOrder();
  }

  async function handleShortageResolution(reason: CompletionReason) {
    if (!order) return;
    setResolvingShortage(true);
    setError(null);
    const { error } = await supabase.rpc('complete_order_with_shortage', {
      p_order_id: order.id,
      p_reason: reason,
    });
    setResolvingShortage(false);
    if (error) setError(error.message);
    else {
      setShowShortageDialog(false);
      loadOrder();
    }
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
      <div>
        <Link href="/orders" className="text-xs font-medium text-indigo-600 hover:underline">
          ← Все заказы
        </Link>
        <div className="mt-1 flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Заказ №{order.id.slice(0, 8)}</h1>
          <StatusBadge status={order.status} />
        </div>
        <p className="mt-1 text-sm text-slate-500">Создан {formatDate(order.created_at)}</p>
        {order.issued_at && <p className="text-sm text-slate-500">Выдан {formatDate(order.issued_at)}</p>}
        {order.closed_at && <p className="text-sm text-slate-500">Закрыт {formatDate(order.closed_at)}</p>}
        {order.completion_reason && (
          <p className="mt-1 text-sm font-medium text-amber-600">
            Причина: {COMPLETION_REASON_LABELS[order.completion_reason]}
          </p>
        )}
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
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {STATUS_BUTTONS.map((s) => (
              <button
                key={s.value}
                onClick={() => handleStatusButtonClick(s.value)}
                className={`rounded-md px-3 py-2.5 text-sm font-medium sm:rounded-full sm:py-1 sm:text-xs ${
                  order.status === s.value ? `${s.color} text-white` : 'bg-slate-100 text-slate-600 active:bg-slate-200'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {hasShortage && order.status === 'new' && (
            <p className="mt-3 text-sm font-semibold text-red-600">
              По части позиций не хватает остатка — при переходе в «Выдан» нужно будет указать причину.
            </p>
          )}
          {order.comment && <p className="mt-3 text-sm text-slate-500">Комментарий: {order.comment}</p>}
        </div>
      </div>

      {/* Мобильная версия — карточки товаров */}
      <div className="space-y-2 sm:hidden">
        <h2 className="text-sm font-semibold text-slate-700">Товары</h2>
        {items.map((item) => {
          const label = variantLabel(item);
          const short = item.quantity > item.stock_quantity;
          return (
            <div
              key={item.id}
              className={`rounded-lg border p-3 ${short ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white'}`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-800">
                    {item.product_name}
                    {label && <span className="text-slate-400"> · {label}</span>}
                  </p>
                  <p className="text-xs text-slate-500">
                    {item.quantity} {item.product_unit}
                    {showTotal && ` × ${formatMoney(item.price ?? 0)}`}
                  </p>
                </div>
                {showTotal && (
                  <p className="text-sm font-medium text-slate-700">{formatMoney((item.price ?? 0) * item.quantity)}</p>
                )}
              </div>
              {short && (
                <p className="mt-1 text-xs font-semibold text-red-600">
                  Не хватает на складе — доступно только {item.stock_quantity}
                </p>
              )}
            </div>
          );
        })}
        {showTotal && (
          <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="text-sm font-semibold text-slate-700">Итого</p>
            <p className="text-sm font-semibold text-slate-900">{formatMoney(order.total ?? 0)}</p>
          </div>
        )}
      </div>

      {/* Десктопная версия — таблица */}
      <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white sm:block">
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
            {items.map((item) => {
              const label = variantLabel(item);
              const short = item.quantity > item.stock_quantity;
              return (
                <tr key={item.id} className={short ? 'bg-red-50' : undefined}>
                  <td className="px-4 py-3 font-medium text-slate-800">
                    {item.product_name}
                    {label && <span className="text-slate-400"> · {label}</span>}
                    {short && (
                      <span className="ml-2 text-xs font-semibold text-red-600">
                        не хватает (доступно {item.stock_quantity})
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {item.quantity} {item.product_unit}
                  </td>
                  {showTotal && <td className="px-4 py-3 text-slate-600">{formatMoney(item.price ?? 0)}</td>}
                  {showTotal && (
                    <td className="px-4 py-3 text-slate-600">{formatMoney((item.price ?? 0) * item.quantity)}</td>
                  )}
                </tr>
              );
            })}
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
        <button
          onClick={handleDelete}
          className="rounded-md px-2 py-2 text-sm font-medium text-red-600 active:bg-red-50 sm:text-xs sm:hover:underline"
        >
          Удалить заказ
        </button>
      )}

      {showShortageDialog && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
          <div className="w-full max-w-sm space-y-4 rounded-lg bg-white p-5">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Не хватает товара на складе</h2>
              <p className="mt-1 text-sm text-slate-500">Выберите, что произошло с заказом.</p>
            </div>
            <div className="space-y-2">
              <button
                onClick={() => handleShortageResolution('partial_pickup')}
                disabled={resolvingShortage}
                className="w-full rounded-md bg-indigo-600 px-4 py-3 text-sm font-medium text-white active:bg-indigo-700 disabled:opacity-50"
              >
                Клиент срочно забрал, что было
              </button>
              <button
                onClick={() => handleShortageResolution('no_stock')}
                disabled={resolvingShortage}
                className="w-full rounded-md bg-slate-600 px-4 py-3 text-sm font-medium text-white active:bg-slate-700 disabled:opacity-50"
              >
                Не было на складе
              </button>
              <button
                onClick={() => setShowShortageDialog(false)}
                disabled={resolvingShortage}
                className="w-full rounded-md px-4 py-2.5 text-sm font-medium text-slate-500"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
