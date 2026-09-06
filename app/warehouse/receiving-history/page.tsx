'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { StockReceipt, variantLabel } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

function ReceivingHistoryContent() {
  const [receipts, setReceipts] = useState<StockReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data, error } = await supabase
        .from('stock_receipts_view')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) setError(error.message);
      else setReceipts((data as unknown as StockReceipt[]) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">История прихода</h1>
        <p className="mt-1 text-sm text-slate-500">Все поступления товара на склад</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && receipts.length === 0 && <p className="text-sm text-slate-400">Приходов пока не было</p>}

      {!loading && receipts.length > 0 && (
        <>
          {/* Мобильная версия — карточки */}
          <div className="space-y-3 sm:hidden">
            {receipts.map((r) => {
              const label = variantLabel(r);
              return (
                <div key={r.id} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium text-slate-800">
                      {r.product_name}
                      {label && <span className="text-slate-400"> · {label}</span>}
                    </p>
                    <span className="font-semibold text-green-600">+{r.total_quantity}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {r.packs > 0 && `${r.packs} пач. × ${r.units_per_pack}`}
                    {r.packs > 0 && r.loose_units > 0 && ' + '}
                    {r.loose_units > 0 && `${r.loose_units} шт. россыпью`}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    {formatDate(r.created_at)}
                    {r.brought_by ? ` · привёз: ${r.brought_by}` : ''}
                  </p>
                  {r.comment && <p className="mt-1 text-xs text-slate-500">{r.comment}</p>}
                </div>
              );
            })}
          </div>

          {/* Десктопная версия — таблица */}
          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white sm:block">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-4 py-3">Товар</th>
                  <th className="px-4 py-3">Количество</th>
                  <th className="px-4 py-3">Кто привёз</th>
                  <th className="px-4 py-3">Комментарий</th>
                  <th className="px-4 py-3">Дата</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {receipts.map((r) => {
                  const label = variantLabel(r);
                  return (
                    <tr key={r.id}>
                      <td className="px-4 py-3 font-medium text-slate-800">
                        {r.product_name}
                        {label && <span className="text-slate-400"> · {label}</span>}
                      </td>
                      <td className="px-4 py-3 font-medium text-green-600">+{r.total_quantity}</td>
                      <td className="px-4 py-3 text-slate-600">{r.brought_by || '—'}</td>
                      <td className="px-4 py-3 text-slate-500">{r.comment || '—'}</td>
                      <td className="px-4 py-3 text-slate-500">{formatDate(r.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export default function ReceivingHistoryPage() {
  return (
    <RequireRole roles={['ceo']}>
      <ReceivingHistoryContent />
    </RequireRole>
  );
}
