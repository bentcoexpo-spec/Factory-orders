'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { FinanceSummary } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { formatDateOnly, monthLabel } from '@/lib/dates';
import RequireRole from '@/components/RequireRole';
import BarChart from '@/components/charts/BarChart';
import LineChart from '@/components/charts/LineChart';
import { useFinanceFilters } from '@/components/FinanceFilters';

type Series = 'sold' | 'received' | 'spent';

const SERIES_LABELS: Record<Series, string> = {
  sold: 'Продали',
  received: 'Получили',
  spent: 'Потратили',
};

function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'good' | 'bad';
}) {
  const color = tone === 'good' ? 'text-success-700' : tone === 'bad' ? 'text-danger-600' : 'text-slate-900';
  return (
    <div className="card">
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold sm:text-xl ${color}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function Panel({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

function SummaryContent() {
  const { market, from, to } = useFinanceFilters();
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [series, setSeries] = useState<Series>('sold');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data, error } = await supabase.rpc('finance_summary', { p_from: from, p_to: to, p_market: market });
      if (cancelled) return;
      if (error) setError(error.message);
      else {
        setSummary(data as unknown as FinanceSummary);
        setError(null);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [market, from, to]);

  const monthPoints = useMemo(
    () => (summary?.months ?? []).map((m) => ({ label: monthLabel(m.month), value: m[series] })),
    [summary, series]
  );
  const debtorPoints = useMemo(
    () => (summary?.top_debtors ?? []).map((d) => ({ label: d.name, value: d.debt })),
    [summary]
  );

  return (
    <div className="space-y-6 sm:space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Сводка</h1>
        <p className="mt-1 text-sm text-slate-500">
          Деньги за {formatDateOnly(from)} — {formatDateOnly(to)}
        </p>
      </div>

      {error && <p className="text-sm text-danger-600">{error}</p>}
      {!summary && !error && <p className="text-sm text-slate-400">Загрузка…</p>}

      {summary && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
            <StatCard label="Продали" value={formatMoney(summary.sold)} hint="выдано клиентам" />
            <StatCard label="Получили" value={formatMoney(summary.received)} hint="оплаты клиентов" />
            <StatCard label="Потратили" value={formatMoney(summary.spent)} hint="реально выплачено" />
            <StatCard
              label="Осталось"
              value={formatMoney(summary.left)}
              hint="получили − потратили"
              tone={summary.left >= 0 ? 'good' : 'bad'}
            />
            <StatCard label="Нам должны" value={formatMoney(summary.owed_to_us)} hint="клиенты, на сегодня" />
            <StatCard
              label="Мы должны"
              value={formatMoney(summary.we_owe)}
              hint="по расходам в долг, на сегодня"
              tone={summary.we_owe > 0 ? 'bad' : 'neutral'}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel
              title="По месяцам (последние 12)"
              action={
                <div className="flex gap-1 rounded-md bg-slate-100 p-0.5">
                  {(Object.keys(SERIES_LABELS) as Series[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setSeries(s)}
                      className={`rounded px-2 py-1 text-xs font-medium ${
                        series === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                      }`}
                    >
                      {SERIES_LABELS[s]}
                    </button>
                  ))}
                </div>
              }
            >
              <LineChart points={monthPoints} formatValue={formatMoney} emptyHint="Нажмите на точку, чтобы увидеть месяц" />
            </Panel>
            <Panel title="Топ должников">
              <BarChart points={debtorPoints} formatValue={formatMoney} emptyHint="Нажмите на столбик, чтобы увидеть клиента" />
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

export default function SummaryPage() {
  return (
    <RequireRole roles={['ceo']}>
      <SummaryContent />
    </RequireRole>
  );
}
