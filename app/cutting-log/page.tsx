'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { CUTTING_BATCH_STATUS_LABELS, CuttingBatch, SHOP_LABELS } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

function CuttingLogContent() {
  const [batches, setBatches] = useState<CuttingBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data, error } = await supabase
        .from('cutting_batches_view')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) setError(error.message);
      else setBatches((data as unknown as CuttingBatch[]) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Действия закройщика</h1>
        <p className="mt-1 text-sm text-slate-500">Все партии раскроя — материал, что вышло, когда</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && batches.length === 0 && <p className="text-sm text-slate-400">Партий пока нет</p>}

      <div className="space-y-3">
        {batches.map((b) => (
          <div key={b.id} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium text-slate-800">
                  Партия №{b.batch_number}
                  <span className="text-slate-400">
                    {' '}
                    · {b.material_name} · {b.color}
                  </span>
                </p>
                <p className="text-xs text-slate-400">
                  {formatDate(b.created_at)} · взял: {b.taken_by} · {b.rolls_taken} рул. · {SHOP_LABELS[b.shop]}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                {CUTTING_BATCH_STATUS_LABELS[b.status]}
              </span>
            </div>
            <div className="mt-2 space-y-0.5 border-t border-slate-100 pt-2">
              {b.products.length === 0 && <p className="text-xs text-slate-400">Товары ещё не добавлены</p>}
              {b.products.map((p, i) => (
                <p key={i} className="text-xs text-slate-500">
                  {p.product_name}: {p.sizes.map((s) => `${s.size} ${s.quantity}`).join(', ')}
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CuttingLogPage() {
  return (
    <RequireRole roles={['ceo']}>
      <CuttingLogContent />
    </RequireRole>
  );
}
