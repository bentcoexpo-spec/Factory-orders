'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatMoney } from '@/lib/format';
import { formatDateOnly } from '@/lib/dates';
import { callStaff } from '@/lib/staffApi';

interface PendingRow {
  id: string;
  employee_id: string;
  employee_name: string;
  operation_label: string;
  quantity: number;
  rate_per_piece: number;
  line_total: number;
  date: string;
}

type Mode = { id: string; kind: 'qty' | 'reject' } | null;

// ⏳ Записи работников из бота, которые ждут подтверждения мастера. В оплату,
// «Продуктивность» и отчёты идут только подтверждённые.
export default function PendingRecords({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [text, setText] = useState('');

  const load = useCallback(async () => {
    const { data, error: e } = await supabase
      .from('work_records_all_view')
      .select('id, employee_id, employee_name, operation_label, quantity, rate_per_piece, line_total, date')
      .eq('status', 'pending')
      .order('date', { ascending: false })
      .order('employee_name');
    if (e) setError(e.message);
    setRows((data as unknown as PendingRow[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const days = useMemo(() => {
    const byDate = new Map<string, Map<string, { name: string; items: PendingRow[] }>>();
    rows.forEach((r) => {
      const day = byDate.get(r.date) ?? new Map();
      const g = day.get(r.employee_id) ?? { name: r.employee_name, items: [] };
      g.items.push(r);
      day.set(r.employee_id, g);
      byDate.set(r.date, day);
    });
    return Array.from(byDate.entries());
  }, [rows]);

  async function run(key: string, fn: string, args: Record<string, unknown>, done: (res: { notified: boolean }) => string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const res = await callStaff(fn, args);
      setNotice(done(res));
      setMode(null);
      setText('');
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить действие');
    } finally {
      setBusy(null);
    }
  }

  const confirm = (key: string, args: Record<string, unknown>) =>
    run(key, 'staff_confirm', args, () => 'Подтверждено');

  if (loading || rows.length === 0) {
    return error ? <p className="text-sm text-danger-600">{error}</p> : null;
  }

  return (
    <div className="card space-y-4 border-warning-300">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700">⏳ Ожидают подтверждения: {rows.length}</h2>
        <button type="button" disabled={busy === 'all'} onClick={() => confirm('all', {})} className="btn-primary">
          ✅ Подтвердить всё ({rows.length})
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Это записи работников из бота. Пока вы их не подтвердите, они не идут в оплату, «Продуктивность» и отчёты. Если запись
        изменить или отклонить, работнику придёт сообщение в Telegram.
      </p>
      {error && <p className="text-sm text-danger-600">{error}</p>}
      {notice && <p className="text-sm font-medium text-success-600">{notice}</p>}

      {days.map(([date, workers]) => (
        <div key={date} className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">📅 {formatDateOnly(date)}</p>
          {Array.from(workers.entries()).map(([empId, g]) => (
            <div key={empId} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold text-slate-900">👷 {g.name}</p>
                <p className="text-sm font-semibold text-success-700">💰 {formatMoney(g.items.reduce((s, r) => s + Number(r.line_total), 0))}</p>
              </div>
              <div className="mt-1 divide-y divide-slate-100">
                {g.items.map((r) => (
                  <div key={r.id} className="py-2">
                    <div className="flex items-start justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium text-slate-800">{r.operation_label}</p>
                        <p className="text-xs text-slate-500">
                          {r.quantity} шт × {formatMoney(r.rate_per_piece)}
                        </p>
                      </div>
                      <span className="num shrink-0 font-medium text-slate-900">{formatMoney(r.line_total)}</span>
                    </div>
                    {mode?.id !== r.id && (
                      <div className="mt-1 flex flex-wrap gap-2">
                        <button type="button" disabled={busy === r.id} onClick={() => confirm(r.id, { ids: [r.id] })} className="btn-tonal">
                          ✅ Подтвердить
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMode({ id: r.id, kind: 'qty' });
                            setText(String(r.quantity));
                          }}
                          className="btn-tonal"
                        >
                          ✏️ Количество
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMode({ id: r.id, kind: 'reject' });
                            setText('');
                          }}
                          className="btn-tonal-danger"
                        >
                          🚫 Отклонить
                        </button>
                      </div>
                    )}
                    {mode?.id === r.id && mode.kind === 'qty' && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-slate-50 p-2">
                        <input
                          inputMode="numeric"
                          autoComplete="off"
                          className="input w-24"
                          value={text}
                          onChange={(e) => setText(e.target.value.replace(/\D/g, '').slice(0, 5))}
                        />
                        <span className="text-xs text-slate-500">шт — запись будет подтверждена с этим числом</span>
                        <button
                          type="button"
                          disabled={busy === r.id || !(Number(text) > 0)}
                          onClick={() => run(r.id, 'staff_adjust', { id: r.id, quantity: Number(text) }, (res) => `Изменено и подтверждено${res.notified ? '. Работнику написали в Telegram' : ''}`)}
                          className="btn-primary btn-sm"
                        >
                          ✅ Сохранить
                        </button>
                        <button type="button" onClick={() => setMode(null)} className="btn-ghost-muted">
                          ❌ Отмена
                        </button>
                      </div>
                    )}
                    {mode?.id === r.id && mode.kind === 'reject' && (
                      <div className="mt-2 space-y-2 rounded-md bg-slate-50 p-2">
                        <input
                          className="input"
                          placeholder="Причина отклонения (работник её увидит)"
                          maxLength={200}
                          value={text}
                          onChange={(e) => setText(e.target.value)}
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={busy === r.id || text.trim().length === 0}
                            onClick={() => run(r.id, 'staff_reject', { id: r.id, reason: text.trim() }, (res) => `Запись отклонена${res.notified ? '. Работнику написали в Telegram' : ''}`)}
                            className="btn-danger btn-sm"
                          >
                            🚫 Отклонить
                          </button>
                          <button type="button" onClick={() => setMode(null)} className="btn-ghost-muted">
                            ❌ Отмена
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <button
                type="button"
                disabled={busy === `w:${empId}:${date}`}
                onClick={() => confirm(`w:${empId}:${date}`, { employee_id: empId, date })}
                className="btn-tonal mt-2"
              >
                ✅ Подтвердить всё у {g.name}
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
