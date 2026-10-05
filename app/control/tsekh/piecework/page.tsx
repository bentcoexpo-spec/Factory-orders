'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Shop, WorkRecord } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { formatDateOnly } from '@/lib/dates';
import RequireRole from '@/components/RequireRole';
import ShopToggle from '@/components/ShopToggle';

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function PieceworkControlContent() {
  const [shop, setShop] = useState<Shop>('factory');
  const [date, setDate] = useState(todayDate());
  const [records, setRecords] = useState<WorkRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data: empData, error: empError } = await supabase.from('employees').select('id').eq('shop', shop);
      if (empError) {
        setError(empError.message);
        setLoading(false);
        return;
      }
      const ids = (empData ?? []).map((e) => e.id as string);
      if (ids.length === 0) {
        setRecords([]);
        setLoading(false);
        return;
      }
      const { data, error } = await supabase
        .from('work_records_view')
        .select('*')
        .eq('date', date)
        .in('employee_id', ids)
        .order('created_at');
      if (error) setError(error.message);
      else setRecords((data as unknown as WorkRecord[]) ?? []);
      setLoading(false);
    }
    load();
  }, [shop, date]);

  const dailyTotals = Array.from(
    records.reduce((map, r) => {
      map.set(r.employee_name, (map.get(r.employee_name) ?? 0) + r.line_total);
      return map;
    }, new Map<string, number>())
  ).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Сделка</h1>
        <p className="mt-1 text-sm text-slate-500">Журнал сдельной работы — только просмотр</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <ShopToggle shop={shop} onChange={setShop} />
        <label className="block max-w-xs">
          <span className="mb-1 block text-xs font-medium text-slate-500">Дата</span>
          <input
            type="date"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      </div>

      {error && <p className="text-sm text-danger-600">{error}</p>}
      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}

      {!loading && (
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Записи за {formatDateOnly(date)}</h2>
          {records.length === 0 && <p className="text-sm text-slate-400">Записей пока нет</p>}
          <div className="space-y-2">
            {records.map((r) => (
              <div key={r.id} className="flex items-center justify-between border-b border-slate-100 pb-2 text-sm last:border-0 last:pb-0">
                <div>
                  <p className="font-medium text-slate-800">
                    {r.employee_name} <span className="text-slate-400">· {r.operation_label}</span>
                  </p>
                  <p className="text-xs text-slate-400">
                    {r.quantity} шт × {formatMoney(r.rate_per_piece)}
                    {r.batch_number != null ? ` · Партия №${r.batch_number}` : ''}
                  </p>
                </div>
                <span className="font-medium text-success-600">{formatMoney(r.line_total)}</span>
              </div>
            ))}
          </div>

          {dailyTotals.length > 0 && (
            <div className="mt-4 border-t border-slate-200 pt-3">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Итого за день</h3>
              <div className="space-y-1">
                {dailyTotals.map(([name, total]) => (
                  <div key={name} className="flex items-center justify-between text-sm">
                    <span className="text-slate-700">{name}</span>
                    <span className="font-medium text-slate-900">{formatMoney(total)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TsekhPieceworkControlPage() {
  return (
    <RequireRole roles={['ceo']}>
      <PieceworkControlContent />
    </RequireRole>
  );
}
