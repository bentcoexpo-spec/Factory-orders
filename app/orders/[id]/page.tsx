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
import { friendlyOrderReturnError } from '@/lib/errors';
import StatusBadge from '@/components/StatusBadge';
import { useRole } from '@/components/RoleProvider';

// "closed_unfulfilled" ставится только через complete_order_with_shortage
// (не прямой сменой статуса), "returned" — только через кнопку «Вернуть на
// склад» ниже, с подтверждением: оба статуса убраны из общей сетки кнопок.
const STATUS_BUTTONS = ORDER_STATUSES.filter((s) => s.value !== 'closed_unfulfilled' && s.value !== 'returned');

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
  const [returning, setReturning] = useState(false);
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});
  const [savingPriceId, setSavingPriceId] = useState<string | null>(null);

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

  async function handleReturnOrder() {
    if (!order) return;
    if (
      !confirm(
        `Вернуть заказ клиента «${order.client_name}» на склад? Остаток по всем товарам заказа увеличится, а сам заказ станет виден только CEO. Действие нельзя отменить.`
      )
    ) {
      return;
    }
    setReturning(true);
    setError(null);
    const { error } = await supabase.from('orders_view').update({ status: 'returned' }).eq('id', order.id);
    setReturning(false);
    if (error) setError(friendlyOrderReturnError(error.message));
    else loadOrder();
  }

  async function saveItemPrice(item: OrderItemView) {
    const draft = priceDrafts[item.id];
    if (draft === undefined || draft.trim() === '') return;
    const value = Number(draft);
    if (Number.isNaN(value) || value < 0) {
      setError('Цена должна быть неотрицательным числом');
      return;
    }
    setSavingPriceId(item.id);
    setError(null);
    const { error } = await supabase.from('order_items').update({ price: value }).eq('id', item.id);
    setSavingPriceId(null);
    if (error) {
      setError(error.message);
      return;
    }
    setPriceDrafts((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    loadOrder();
  }

  async function handleDelete() {
    if (!order) return;
    if (!confirm('Удалить заказ?')) return;
    const { error } = await supabase.from('orders_view').delete().eq('id', order.id);
    if (error) setError(error.message);
    else router.push('/orders');
  }

  if (loading) return <p className="text-sm text-slate-400">Загрузка…</p>;
  if (!order) return <p className="text-sm text-danger-600">{error ?? 'Заказ не найден'}</p>;

  const showTotal = order.total !== null;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/orders" className="text-xs font-medium text-accent-600 hover:underline">
          ← Все заказы
        </Link>
        <div className="mt-1 flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Заказ №{order.id.slice(0, 8)}</h1>
          <StatusBadge status={order.status} />
        </div>
        <p className="mt-1 text-sm text-slate-500">Создан {formatDate(order.created_at)}</p>
        {order.issued_at && (
          <p className="text-sm text-slate-500">
            Выдан {formatDate(order.issued_at)}
            {order.issued_by_name && <span className="font-medium text-slate-700"> · выдал {order.issued_by_name}</span>}
          </p>
        )}
        {order.closed_at && <p className="text-sm text-slate-500">Закрыт {formatDate(order.closed_at)}</p>}
        {order.returned_at && (
          <p className="text-sm font-medium text-warning-600">
            Возвращено {formatDate(order.returned_at)}
            {order.returned_by_email && <span> · вернул {order.returned_by_email}</span>}
          </p>
        )}
        {order.completion_reason && (
          <p className="mt-1 text-sm font-medium text-warning-600">
            Причина: {COMPLETION_REASON_LABELS[order.completion_reason]}
          </p>
        )}
      </div>

      {error && <p className="text-sm text-danger-600">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="card">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Клиент</h2>
          <p className="text-sm text-slate-800">{order.client_name}</p>
          {order.client_address && <p className="text-sm text-slate-500">{order.client_address}</p>}
          {order.client_phone && <p className="text-sm text-slate-500">{order.client_phone}</p>}
          {order.client_email && <p className="text-sm text-slate-500">{order.client_email}</p>}
        </div>
        <div className="card">
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
            <p className="mt-3 text-sm font-semibold text-danger-600">
              По части позиций не хватает остатка — при переходе в «Выдан» нужно будет указать причину.
            </p>
          )}
          {order.comment && <p className="mt-3 text-sm text-slate-500">Комментарий: {order.comment}</p>}
          {order.status === 'issued' && (role === 'ceo' || role === 'kladovshik') && (
            <button
              onClick={handleReturnOrder}
              disabled={returning}
              className="mt-3 w-full rounded-md border border-warning-300 px-3 py-2.5 text-sm font-medium text-warning-600 active:bg-warning-50 disabled:opacity-50 sm:w-auto"
            >
              {returning ? 'Возврат…' : 'Вернуть на склад'}
            </button>
          )}
        </div>
      </div>

      {/* Мобильная версия — карточки товаров */}
      <div className="space-y-2 sm:hidden">
        <h2 className="text-sm font-semibold text-slate-700">Товары</h2>
        {items.map((item) => {
          const label = variantLabel(item);
          const short = item.quantity > item.stock_quantity;
          const unpriced = showTotal && item.price === null;
          const draft = priceDrafts[item.id];
          return (
            <div
              key={item.id}
              className={`rounded-lg border p-3 ${
                short ? 'border-danger-300 bg-danger-50' : unpriced ? 'border-warning-300 bg-warning-50' : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">
                    {item.product_name}
                    {label && <span className="text-slate-400"> · {label}</span>}
                  </p>
                  <p className="text-xs text-slate-500">
                    {item.quantity} {item.product_unit}
                    {showTotal && item.price !== null && ` × ${formatMoney(item.price)}`}
                  </p>
                </div>
                {showTotal && item.price !== null && (
                  <p className="shrink-0 text-sm font-medium text-slate-700">{formatMoney(item.price * item.quantity)}</p>
                )}
              </div>
              {unpriced && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="shrink-0 text-xs font-semibold text-warning-700">без цены —</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    inputMode="decimal"
                    placeholder="цена за шт"
                    className="w-24 min-w-0 flex-1 rounded-md border border-warning-300 px-2 py-1.5 text-sm"
                    value={draft ?? ''}
                    onChange={(e) => setPriceDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  />
                  <button
                    onClick={() => saveItemPrice(item)}
                    disabled={savingPriceId === item.id || !draft || draft.trim() === ''}
                    className="shrink-0 rounded-md bg-warning-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    Сохранить
                  </button>
                </div>
              )}
              {short && (
                <p className="mt-1 text-xs font-semibold text-danger-600">
                  Не хватает на складе — доступно только {item.stock_quantity}
                </p>
              )}
            </div>
          );
        })}
        {showTotal && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-700">Итого</p>
              <p className="text-sm font-semibold text-slate-900">{formatMoney(order.total ?? 0)}</p>
            </div>
            {order.has_unpriced_item && (
              <p className="mt-1 text-xs font-medium text-warning-700">
                Есть позиции без цены — в итог они пока не входят, впишите цену выше.
              </p>
            )}
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
              {showTotal && <th className="num px-4 py-3">Цена</th>}
              {showTotal && <th className="num px-4 py-3">Сумма</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((item) => {
              const label = variantLabel(item);
              const short = item.quantity > item.stock_quantity;
              const unpriced = showTotal && item.price === null;
              const draft = priceDrafts[item.id];
              return (
                <tr key={item.id} className={short ? 'bg-danger-50' : unpriced ? 'bg-warning-50' : undefined}>
                  <td className="px-4 py-3 font-medium text-slate-800">
                    {item.product_name}
                    {label && <span className="text-slate-400"> · {label}</span>}
                    {short && (
                      <span className="ml-2 text-xs font-semibold text-danger-600">
                        не хватает (доступно {item.stock_quantity})
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {item.quantity} {item.product_unit}
                  </td>
                  {showTotal && (
                    <td className="num px-4 py-3 text-slate-600">
                      {item.price !== null ? (
                        formatMoney(item.price)
                      ) : (
                        <div className="flex items-center justify-end gap-2">
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            inputMode="decimal"
                            placeholder="без цены"
                            className="w-24 rounded-md border border-warning-300 px-2 py-1 text-sm"
                            value={draft ?? ''}
                            onChange={(e) => setPriceDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))}
                          />
                          <button
                            onClick={() => saveItemPrice(item)}
                            disabled={savingPriceId === item.id || !draft || draft.trim() === ''}
                            className="rounded-md bg-warning-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                          >
                            Сохранить
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                  {showTotal && (
                    <td className="num px-4 py-3 text-slate-600">
                      {item.price !== null ? formatMoney(item.price * item.quantity) : '—'}
                    </td>
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
                <td className="num px-4 py-3 text-sm font-semibold text-slate-900">
                  {formatMoney(order.total ?? 0)}
                  {order.has_unpriced_item && (
                    <span className="ml-2 text-xs font-medium text-warning-700">без цены не включено</span>
                  )}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {role === 'ceo' && (
        <button
          onClick={handleDelete}
          className="btn-ghost-danger"
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
                className="btn-primary w-full"
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
                className="btn-ghost-muted w-full"
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
