'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatMoney } from '@/lib/format';
import { formatDateOnly } from '@/lib/dates';
import { SHOP_LABELS, Shop } from '@/lib/types';
import RequireRole from '@/components/RequireRole';

// Журнал правок сделки (046): правка и удаление ПОДТВЕРЖДЁННОЙ записи, а также
// «изменил количество при подтверждении» и «отклонил». Пишет база (триггер) —
// поэтому сюда попадает и сайт, и бот. Читает только CEO.
interface Snapshot {
  label?: string;
  quantity?: number;
  rate?: number;
  total?: number;
}

interface AuditRow {
  id: string;
  created_at: string;
  action: 'edit' | 'delete' | 'adjust' | 'reject';
  actor_name: string | null;
  via: 'site' | 'bot';
  employee_name: string | null;
  shop: Shop | null;
  record_date: string | null;
  before: Snapshot | null;
  after: Snapshot | null;
  reason: string | null;
}

const ACTIONS: Record<AuditRow['action'], { label: string; badge: string }> = {
  edit: { label: '✏️ Правка', badge: 'badge-warning' },
  delete: { label: '🗑 Удаление', badge: 'badge-danger' },
  adjust: { label: '✅ Количество изменено при подтверждении', badge: 'badge-neutral' },
  reject: { label: '🚫 Отклонена', badge: 'badge-danger' },
};

function when(ts: string): string {
  return new Date(ts).toLocaleString('ru-RU', {
    timeZone: 'Asia/Tashkent',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const line = (s: Snapshot | null) =>
  s ? `${s.label ?? '—'}: ${s.quantity ?? 0} шт × ${formatMoney(Number(s.rate ?? 0))} = ${formatMoney(Number(s.total ?? 0))}` : '—';

function JournalContent() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<'all' | AuditRow['action']>('all');
  const [shop, setShop] = useState<'all' | Shop>('all');

  useEffect(() => {
    supabase
      .from('work_record_audit')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(300)
      .then(({ data, error: e }) => {
        if (e) setError(e.message);
        setRows((data as unknown as AuditRow[]) ?? []);
        setLoading(false);
      });
  }, []);

  const visible = useMemo(
    () => rows.filter((r) => (action === 'all' || r.action === action) && (shop === 'all' || r.shop === shop)),
    [rows, action, shop]
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Журнал правок</h1>
        <p className="mt-1 text-sm text-slate-500">
          Кто, когда и что изменил в подтверждённых записях сделки: правки, удаления, изменение количества при подтверждении и
          отклонения. Журнал ведёт база, поэтому в нём и сайт, и бот. Время — по Ташкенту.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <select className="input w-auto" value={action} onChange={(e) => setAction(e.target.value as typeof action)}>
          <option value="all">Все действия</option>
          {Object.entries(ACTIONS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <select className="input w-auto" value={shop} onChange={(e) => setShop(e.target.value as typeof shop)}>
          <option value="all">Оба цеха</option>
          <option value="factory">{SHOP_LABELS.factory}</option>
          <option value="workshop">{SHOP_LABELS.workshop}</option>
        </select>
      </div>

      {error && <p className="text-sm text-danger-600">{error}</p>}
      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && visible.length === 0 && <p className="text-sm text-slate-400">Записей в журнале нет</p>}

      <div className="space-y-3">
        {visible.map((r) => (
          <div key={r.id} className="card space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={ACTIONS[r.action].badge}>{ACTIONS[r.action].label}</span>
              <span className="text-xs text-slate-500">{when(r.created_at)}</span>
            </div>
            <p className="text-sm text-slate-800">
              <span className="font-medium">👷 {r.employee_name ?? '—'}</span>
              {r.shop ? ` · 🏭 ${SHOP_LABELS[r.shop]}` : ''}
              {r.record_date ? ` · 📅 ${formatDateOnly(r.record_date)}` : ''}
            </p>
            <div className="space-y-1 text-sm">
              <p className="text-slate-500">
                Было: <span className="text-slate-800">{line(r.before)}</span>
              </p>
              {r.action !== 'delete' && (
                <p className="text-slate-500">
                  Стало: <span className="text-slate-800">{r.action === 'reject' ? 'отклонена' : line(r.after)}</span>
                </p>
              )}
              {r.reason && (
                <p className="text-slate-500">
                  Причина: <span className="text-slate-800">{r.reason}</span>
                </p>
              )}
            </div>
            <p className="text-xs text-slate-400">
              Кто: {r.actor_name ?? 'неизвестно'} · {r.via === 'bot' ? 'через бота' : 'с сайта'}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function JournalPage() {
  return (
    <RequireRole roles={['ceo']}>
      <JournalContent />
    </RequireRole>
  );
}
