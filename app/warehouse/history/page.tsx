'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { OrderView, OrderStatus, COMPLETION_REASON_LABELS } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';
import { useRole } from '@/components/RoleProvider';

type Tab = 'pending' | 'issued' | 'closed';

const TABS: { key: Tab; label: string; status: OrderStatus }[] = [
  { key: 'pending', label: 'Ожидают', status: 'new' },
  { key: 'issued', label: 'Выданы', status: 'issued' },
  { key: 'closed', label: 'Закрыты без выдачи', status: 'closed_unfulfilled' },
];

const EMPTY_TEXT: Record<Tab, string> = {
  pending: 'Нет заказов, оставленных на потом',
  issued: 'Пока ничего не выдано',
  closed: 'Нет заказов, закрытых без выдачи',
};

function dateFor(tab: Tab, o: OrderView): string | null {
  if (tab === 'issued') return o.issued_at;
  if (tab === 'closed') return o.closed_at;
  return o.created_at;
}

function HistoryContent() {
  const { role } = useRole();
  const [tab, setTab] = useState<Tab>('pending');
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const current = TABS.find((t) => t.key === tab)!;
      const dateColumn = tab === 'issued' ? 'issued_at' : tab === 'closed' ? 'closed_at' : 'created_at';
      // CEO видит в "Выданы" и уже возвращённые заказы (со своей меткой
      // в карточке) — полная история, как и договаривались; у кладовщика
      // возвращённый заказ из этой вкладки просто пропадает.
      let query = supabase.from('orders_view').select('*');
      query = role === 'ceo' && tab === 'issued' ? query.in('status', ['issued', 'returned']) : query.eq('status', current.status);
      const { data, error } = await query.order(dateColumn, { ascending: false });
      if (error) setError(error.message);
      else setOrders((data as unknown as OrderView[]) ?? []);
      setLoading(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, role]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">История</h1>
        <p className="mt-1 text-sm text-slate-500">Заказы, оставленные на потом, выданные и закрытые без выдачи</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-full px-4 py-2 text-sm font-medium ${
              tab === t.key ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && orders.length === 0 && <p className="text-sm text-slate-400">{EMPTY_TEXT[tab]}</p>}

      {!loading && orders.length > 0 && (
        <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {orders.map((o) => {
            const date = dateFor(tab, o);
            return (
              <Link
                key={o.id}
                href={`/orders/${o.id}`}
                className="flex items-center justify-between px-4 py-3.5 hover:bg-slate-50 active:bg-slate-100"
              >
                <div>
                  <span className="font-medium text-slate-800">{o.client_name}</span>
                  {o.status === 'returned' && (
                    <span className="ml-2 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">
                      Возвращено
                    </span>
                  )}
                  {o.completion_reason && (
                    <span className="ml-2 text-xs text-amber-600">{COMPLETION_REASON_LABELS[o.completion_reason]}</span>
                  )}
                  {tab === 'issued' && o.status === 'issued' && o.issued_by_name && (
                    <span className="ml-2 text-xs text-slate-500">выдал {o.issued_by_name}</span>
                  )}
                  {tab === 'issued' && o.status === 'returned' && o.returned_by_email && (
                    <span className="ml-2 text-xs text-slate-500">вернул {o.returned_by_email}</span>
                  )}
                </div>
                <span className="text-sm text-slate-500">{date ? formatDate(date) : '—'}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function HistoryPage() {
  return (
    <RequireRole roles={['ceo', 'kladovshik']}>
      <HistoryContent />
    </RequireRole>
  );
}
