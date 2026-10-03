'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { CLIENT_CATEGORY_LABELS, ClientDebt, FINANCE_MARKET_LABELS } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { fetchAll } from '@/lib/fetchAll';
import { downloadXlsx } from '@/lib/excelExport';
import { todayDate, formatDateOnly } from '@/lib/dates';
import RequireRole from '@/components/RequireRole';
import ExcelButton from '@/components/ExcelButton';
import { useFinanceFilters } from '@/components/FinanceFilters';

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card">
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900 sm:text-xl">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function DebtsContent() {
  const { market } = useFinanceFilters();
  const [debts, setDebts] = useState<ClientDebt[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const rows = await fetchAll<ClientDebt>((a, b) => {
          let q = supabase.from('client_debt_view').select('*').order('debt', { ascending: false });
          if (market !== 'all') q = q.eq('category', market);
          return q.range(a, b);
        });
        if (cancelled) return;
        setDebts(rows);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
      if (!cancelled) setLoaded(true);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [market]);

  const stats = useMemo(() => {
    const totalDebt = debts.reduce((sum, c) => sum + Math.max(0, c.debt), 0);
    const clientsInDebt = debts.filter((c) => c.debt > 0).length;
    const advances = debts.reduce((sum, c) => sum + Math.max(0, -c.debt), 0);
    return { totalDebt, clientsInDebt, advances };
  }, [debts]);

  async function exportExcel() {
    await downloadXlsx(`Долги_на_${todayDate()}_${FINANCE_MARKET_LABELS[market]}`, [
      {
        name: 'Долги',
        columns: [
          { header: 'Клиент', key: 'name', width: 30 },
          { header: 'Рынок', key: 'market', width: 18 },
          { header: 'Телефон', key: 'phone', width: 18 },
          { header: 'Выдано, сум', key: 'issued', money: true, width: 16 },
          { header: 'Оплачено, сум', key: 'paid', money: true, width: 16 },
          { header: 'Долг, сум', key: 'debt', money: true, width: 16 },
          { header: 'Аванс, сум', key: 'advance', money: true, width: 16 },
        ],
        rows: debts.map((c) => ({
          name: c.name,
          market: c.category ? CLIENT_CATEGORY_LABELS[c.category] : 'Без категории',
          phone: c.phone,
          issued: c.issued_total,
          paid: c.paid_total,
          debt: c.debt > 0 ? c.debt : null,
          advance: c.debt < 0 ? -c.debt : null,
        })),
        totals: { name: 'Итого', debt: stats.totalDebt, advance: stats.advances },
      },
    ]);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Долги</h1>
          <p className="mt-1 text-sm text-slate-500">Состояние на {formatDateOnly(todayDate())}, по убыванию долга</p>
        </div>
        <ExcelButton onExport={exportExcel} disabled={debts.length === 0} />
      </div>

      {error && <p className="text-sm text-danger-600">{error}</p>}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
        <StatCard label="Общий долг клиентов" value={formatMoney(stats.totalDebt)} />
        <StatCard label="Клиентов с долгом" value={String(stats.clientsInDebt)} />
        <StatCard label="Авансы клиентов" value={formatMoney(stats.advances)} hint="оплатили больше, чем выдано" />
      </div>

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Клиенты</h2>
        {!loaded && <p className="text-sm text-slate-400">Загрузка…</p>}
        {loaded && debts.length === 0 && <p className="text-sm text-slate-400">Клиентов нет</p>}
        <div className="divide-y divide-slate-100">
          {debts.map((c) => (
            <Link
              key={c.id}
              href={`/finance/clients/${c.id}`}
              className="flex items-center justify-between gap-3 py-3 hover:bg-slate-50"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-800">{c.name}</p>
                {c.category && <span className="text-xs text-slate-400">{CLIENT_CATEGORY_LABELS[c.category]}</span>}
              </div>
              <span
                className={`shrink-0 text-sm font-semibold ${
                  c.debt > 0 ? 'text-danger-600' : c.debt < 0 ? 'text-success-600' : 'text-slate-400'
                }`}
              >
                {c.debt < 0 ? `Аванс ${formatMoney(-c.debt)}` : formatMoney(c.debt)}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function FinancePage() {
  return (
    <RequireRole roles={['ceo']}>
      <DebtsContent />
    </RequireRole>
  );
}
