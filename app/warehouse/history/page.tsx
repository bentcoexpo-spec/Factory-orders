'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { OrderView } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

function HistoryContent() {
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data, error } = await supabase
        .from('orders_view')
        .select('*')
        .eq('status', 'issued')
        .order('issued_at', { ascending: false });
      if (error) setError(error.message);
      else setOrders((data as unknown as OrderView[]) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">История</h1>
        <p className="mt-1 text-sm text-slate-500">Заказы, которые уже выданы клиенту</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && orders.length === 0 && <p className="text-sm text-slate-400">Пока ничего не выдано</p>}

      {!loading && orders.length > 0 && (
        <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {orders.map((o) => (
            <Link
              key={o.id}
              href={`/orders/${o.id}`}
              className="flex items-center justify-between px-4 py-3.5 hover:bg-slate-50 active:bg-slate-100"
            >
              <span className="font-medium text-slate-800">{o.client_name}</span>
              <span className="text-sm text-slate-500">{o.issued_at ? formatDate(o.issued_at) : '—'}</span>
            </Link>
          ))}
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
