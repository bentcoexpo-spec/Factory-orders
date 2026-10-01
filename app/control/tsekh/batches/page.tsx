'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { CUTTING_BATCH_STATUS_LABELS, CuttingBatch, Shop, sizeRank } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';
import ShopToggle from '@/components/ShopToggle';

function BatchesControlContent() {
  const [shop, setShop] = useState<Shop>('factory');
  const [batches, setBatches] = useState<CuttingBatch[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data, error } = await supabase
        .from('cutting_batches_view')
        .select('*')
        .eq('shop', shop)
        .order('created_at', { ascending: false });
      if (error) setError(error.message);
      else setBatches((data as unknown as CuttingBatch[]) ?? []);
      setLoading(false);
    }
    load();
  }, [shop]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Партии в пошиве</h1>
        <p className="mt-1 text-sm text-slate-500">Только просмотр — приёмку кроя и отчёт о готовом ведёт мастер</p>
      </div>

      <ShopToggle shop={shop} onChange={setShop} />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && batches.length === 0 && <p className="text-sm text-slate-400">Партий в этом цехе пока нет</p>}

      <div className="space-y-3">
        {batches.map((b) => {
          const expanded = expandedId === b.id;
          return (
            <div key={b.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <button
                type="button"
                onClick={() => setExpandedId(expanded ? null : b.id)}
                className="flex w-full items-start justify-between gap-2 text-left"
              >
                <div>
                  <p className="font-medium text-slate-800">
                    Партия №{b.batch_number}
                    <span className="text-slate-400">
                      {' '}
                      · {b.material_name} · {b.color}
                    </span>
                  </p>
                  <p className="text-xs text-slate-400">{formatDate(b.created_at)} · {b.total_quantity} дет.</p>
                </div>
                <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                  {CUTTING_BATCH_STATUS_LABELS[b.status]}
                </span>
              </button>

              {expanded && (
                <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
                  {b.products.map((p, i) => (
                    <div key={i}>
                      <p className="mb-1 text-sm font-semibold text-slate-700">{p.product_name}</p>
                      <div className="overflow-x-auto">
                        <table className="min-w-full text-xs">
                          <thead className="text-slate-400">
                            <tr>
                              <th className="py-1 pr-3 text-left">Размер</th>
                              <th className="py-1 pr-3 text-left">Заявлено</th>
                              <th className="py-1 pr-3 text-left">Подтверждено</th>
                              <th className="py-1 pr-3 text-left">Сшито</th>
                              <th className="py-1 pr-3 text-left">Брак</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[...p.sizes]
                              .sort((a, b2) => sizeRank(a.size) - sizeRank(b2.size))
                              .map((sz) => (
                                <tr key={sz.size} className="border-t border-slate-50">
                                  <td className="py-1 pr-3 font-medium text-slate-700">{sz.size}</td>
                                  <td className="py-1 pr-3 text-slate-600">{sz.quantity}</td>
                                  <td className="py-1 pr-3 text-slate-600">{sz.confirmed_quantity ?? '—'}</td>
                                  <td className="py-1 pr-3 text-slate-600">{sz.sewn_quantity ?? '—'}</td>
                                  <td className="py-1 pr-3 text-slate-600">{sz.sewn_defect_quantity ?? '—'}</td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function TsekhBatchesControlPage() {
  return (
    <RequireRole roles={['ceo']}>
      <BatchesControlContent />
    </RequireRole>
  );
}
