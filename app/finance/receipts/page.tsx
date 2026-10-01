'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { OrderView } from '@/lib/types';
import { formatDate, formatMoney } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

function ReceiptsContent() {
  const [receipts, setReceipts] = useState<OrderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data, error } = await supabase
        .from('orders_view')
        .select('*')
        .in('status', ['issued', 'returned'])
        .order('issued_at', { ascending: false });
      if (error) setError(error.message);
      else setReceipts((data as unknown as OrderView[]) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  const unpricedCount = receipts.filter((r) => r.has_unpriced_item).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Чеки</h1>
        <p className="mt-1 text-sm text-slate-500">Каждая выдача заказа — отдельный чек</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {unpricedCount > 0 && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700">
          Чеков без цены по части позиций: {unpricedCount} — откройте чек, чтобы вписать цену.
        </p>
      )}

      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && receipts.length === 0 && <p className="text-sm text-slate-400">Чеков пока нет</p>}

      {!loading && receipts.length > 0 && (
        <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {receipts.map((r) => (
            <Link
              key={r.id}
              href={`/orders/${r.id}`}
              className="flex items-center justify-between gap-3 px-4 py-3.5 hover:bg-slate-50 active:bg-slate-100"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-800">
                  {r.client_name}
                  {r.status === 'returned' && (
                    <span className="ml-2 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">
                      Возвращено
                    </span>
                  )}
                  {r.has_unpriced_item && (
                    <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                      без цены
                    </span>
                  )}
                </p>
                <p className="text-xs text-slate-400">{r.issued_at ? formatDate(r.issued_at) : '—'}</p>
              </div>
              <span className="shrink-0 font-semibold text-slate-800">{r.total != null ? formatMoney(r.total) : '—'}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ReceiptsPage() {
  return (
    <RequireRole roles={['ceo']}>
      <ReceiptsContent />
    </RequireRole>
  );
}
