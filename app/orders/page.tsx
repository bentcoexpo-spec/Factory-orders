'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { COMPLETION_REASON_LABELS, OrderView, OrderStatus, ORDER_STATUSES } from '@/lib/types';
import { formatDate, formatMoney } from '@/lib/format';
import StatusBadge from '@/components/StatusBadge';
import { useRole } from '@/components/RoleProvider';

// "returned" меняется только через кнопку «Вернуть на склад» на странице
// заказа (с подтверждением) — не через этот выпадающий список без единого
// диалога, как остальные статусы.
const STATUS_SELECT_OPTIONS = ORDER_STATUSES.filter((s) => s.value !== 'returned');

// Дата, которую показываем зависит от статуса — то же, чем раньше
// отдельно занималась «История» (вкладки «Ожидают»/«Выданы»/«Закрыты»
// с разными колонками дат); здесь это один список, поэтому колонка
// "умная" сама по себе, без отдельных вкладок.
function dateFor(o: OrderView): string {
  if ((o.status === 'issued' || o.status === 'returned') && o.issued_at) return o.issued_at;
  if (o.status === 'closed_unfulfilled' && o.closed_at) return o.closed_at;
  return o.created_at;
}

function OrderMeta({ o }: { o: OrderView }) {
  return (
    <>
      {o.status === 'returned' && (
        <span className="ml-2 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">
          Возвращено
        </span>
      )}
      {o.completion_reason && (
        <span className="ml-2 text-xs text-amber-600">{COMPLETION_REASON_LABELS[o.completion_reason]}</span>
      )}
      {o.status === 'issued' && o.issued_by_name && (
        <span className="ml-2 text-xs text-slate-500">выдал {o.issued_by_name}</span>
      )}
      {o.status === 'returned' && o.returned_by_email && (
        <span className="ml-2 text-xs text-slate-500">вернул {o.returned_by_email}</span>
      )}
    </>
  );
}

export default function OrdersPage() {
  const { role } = useRole();
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<OrderStatus | 'all'>('all');

  async function loadOrders() {
    setLoading(true);
    const { data, error } = await supabase
      .from('orders_view')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) setError(error.message);
    else setOrders((data as unknown as OrderView[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadOrders();
  }, []);

  async function handleStatusChange(id: string, status: OrderStatus) {
    setError(null);
    const { error } = await supabase.from('orders_view').update({ status }).eq('id', id);
    if (error) setError(error.message);
    else loadOrders();
  }

  const visibleOrders = (filter === 'all' ? orders : orders.filter((o) => o.status === filter))
    .slice()
    .sort((a, b) => dateFor(b).localeCompare(dateFor(a)));
  const showTotals = orders.some((o) => o.total !== null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Заказы</h1>
          <p className="mt-1 text-sm text-slate-500">Все заказы фабрики — ожидают, выданы, закрыты, возвращены</p>
        </div>
        {role && (
          <Link
            href="/warehouse/order"
            className="rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500"
          >
            + Новый заказ
          </Link>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFilter('all')}
          className={`rounded-full px-3 py-1.5 text-xs font-medium ${
            filter === 'all' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'
          }`}
        >
          Все ({orders.length})
        </button>
        {ORDER_STATUSES.map((s) => (
          <button
            key={s.value}
            onClick={() => setFilter(s.value)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${
              filter === s.value ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'
            }`}
          >
            {s.label} ({orders.filter((o) => o.status === s.value).length})
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && visibleOrders.length === 0 && <p className="text-sm text-slate-400">Заказов не найдено</p>}

      {!loading && visibleOrders.length > 0 && (
        <>
          {/* Мобильная версия — карточки */}
          <div className="space-y-3 sm:hidden">
            {visibleOrders.map((o) => (
              <div key={o.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-2">
                  <Link href={`/orders/${o.id}`} className="font-medium text-slate-800">
                    {o.client_name}
                  </Link>
                  <StatusBadge status={o.status} />
                </div>
                <p className="mt-0.5">
                  <OrderMeta o={o} />
                </p>
                <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
                  <span>{formatDate(dateFor(o))}</span>
                  {o.total !== null && (
                    <span className="text-sm font-medium text-slate-700">{formatMoney(o.total)}</span>
                  )}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <select
                    value={o.status}
                    onChange={(e) => handleStatusChange(o.id, e.target.value as OrderStatus)}
                    className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-700"
                  >
                    {STATUS_SELECT_OPTIONS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <Link
                    href={`/orders/${o.id}`}
                    className="shrink-0 rounded-md border border-slate-200 px-3 py-2.5 text-sm font-medium text-indigo-600"
                  >
                    Детали
                  </Link>
                </div>
              </div>
            ))}
          </div>

          {/* Десктопная версия — таблица */}
          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white sm:block">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-4 py-3">Клиент</th>
                  {showTotals && <th className="px-4 py-3">Сумма</th>}
                  <th className="px-4 py-3">Статус</th>
                  <th className="px-4 py-3">Дата</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleOrders.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-800">
                      <Link href={`/orders/${o.id}`} className="hover:underline">
                        {o.client_name}
                      </Link>
                      <OrderMeta o={o} />
                    </td>
                    {showTotals && (
                      <td className="px-4 py-3 text-slate-600">{o.total !== null ? formatMoney(o.total) : '—'}</td>
                    )}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={o.status} />
                        <select
                          value={o.status}
                          onChange={(e) => handleStatusChange(o.id, e.target.value as OrderStatus)}
                          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600"
                        >
                          {STATUS_SELECT_OPTIONS.map((s) => (
                            <option key={s.value} value={s.value}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{formatDate(dateFor(o))}</td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/orders/${o.id}`} className="text-xs font-medium text-indigo-600 hover:underline">
                        Детали
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
