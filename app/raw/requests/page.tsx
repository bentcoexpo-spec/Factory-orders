'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { CUTTING_REQUEST_STATUS_LABELS, CuttingRequest, CuttingRequestStatus, sizeRank } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

const STATUS_BADGE: Record<CuttingRequestStatus, string> = {
  new: 'bg-slate-100 text-slate-600',
  in_progress: 'bg-accent-100 text-accent-700',
  done: 'bg-success-100 text-success-700',
  cancelled: 'bg-danger-100 text-danger-600',
};

function RequestCard({ req }: { req: CuttingRequest }) {
  return (
    <div className="card">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-slate-800">
            {req.material_name}
            <span className="text-slate-400"> · {req.color}</span>
          </p>
          <p className="text-xs text-slate-400">
            {formatDate(req.created_at)}
            {req.rolls_hint != null && ` · ~${req.rolls_hint} рул.`}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[req.status]}`}>
          {CUTTING_REQUEST_STATUS_LABELS[req.status]}
        </span>
      </div>

      {req.comment && <p className="mt-2 text-sm text-slate-500">{req.comment}</p>}

      <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
        {req.products.map((p, i) => (
          <div key={i} className="text-xs text-slate-600">
            <span className="font-medium text-slate-700">{p.product_name}</span>
            {' — '}
            {p.sizes[0]?.size === null
              ? `${p.plan_total} шт.`
              : [...p.sizes]
                  .sort((a, b) => sizeRank(a.size) - sizeRank(b.size))
                  .map((s) => `${s.size} ${s.quantity}`)
                  .join(', ')}
            {p.fact_total > 0 && (
              <span className="text-slate-400"> (уже раскроено {p.fact_total})</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function RequestsList() {
  const [requests, setRequests] = useState<CuttingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data, error } = await supabase
        .from('cutting_requests_view')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) setError(error.message);
      else setRequests((data as unknown as CuttingRequest[]) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  const active = requests.filter((r) => r.status === 'new' || r.status === 'in_progress');
  const finished = requests.filter((r) => r.status === 'done' || r.status === 'cancelled').slice(0, 10);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Заявки</h1>
        <p className="mt-1 text-sm text-slate-500">Что просит раскроить CEO — новые сверху</p>
      </div>

      {error && <p className="text-sm text-danger-600">{error}</p>}
      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}

      {!loading && (
        <div className="space-y-6">
          <div className="space-y-2">
            {active.length === 0 && <p className="text-sm text-slate-400">Активных заявок нет</p>}
            {active.map((r) => (
              <RequestCard key={r.id} req={r} />
            ))}
          </div>

          {finished.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-slate-700">Недавние завершённые / отменённые</h2>
              {finished.map((r) => (
                <RequestCard key={r.id} req={r} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function RawRequestsPage() {
  return (
    <RequireRole roles={['zakroyshik']}>
      <RequestsList />
    </RequireRole>
  );
}
