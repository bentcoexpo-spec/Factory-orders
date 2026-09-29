'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { CLIENT_CATEGORY_LABELS, ClientDebt, OrderView } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import RequireRole from '@/components/RequireRole';
import BarChart from '@/components/charts/BarChart';
import LineChart from '@/components/charts/LineChart';

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function monthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

function monthLabel(iso: string) {
  const [y, m] = iso.split('-');
  const names = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${names[Number(m) - 1]} ${y.slice(2)}`;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-700">{title}</h2>
      {children}
    </div>
  );
}

function FinanceContent() {
  const [debts, setDebts] = useState<ClientDebt[]>([]);
  const [issuedOrders, setIssuedOrders] = useState<OrderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [periodFrom, setPeriodFrom] = useState(monthStart());
  const [periodTo, setPeriodTo] = useState(todayDate());

  useEffect(() => {
    async function load() {
      setLoading(true);
      const [{ data: debtData, error: debtError }, { data: orderData, error: orderError }] = await Promise.all([
        supabase.from('client_debt_view').select('*').order('debt', { ascending: false }),
        supabase
          .from('orders_view')
          .select('*')
          .eq('status', 'issued')
          .order('issued_at', { ascending: false }),
      ]);
      if (debtError || orderError) setError((debtError ?? orderError)?.message ?? 'Ошибка загрузки');
      else {
        setDebts((debtData as unknown as ClientDebt[]) ?? []);
        setIssuedOrders((orderData as unknown as OrderView[]) ?? []);
      }
      setLoading(false);
    }
    load();
  }, []);

  const stats = useMemo(() => {
    const totalDebt = debts.reduce((sum, c) => sum + Math.max(0, c.debt), 0);
    const clientsInDebt = debts.filter((c) => c.debt > 0).length;

    const periodRevenue = issuedOrders
      .filter((o) => o.issued_at && o.issued_at.slice(0, 10) >= periodFrom && o.issued_at.slice(0, 10) <= periodTo)
      .reduce((sum, o) => sum + (o.total ?? 0), 0);

    const byMonthMap = new Map<string, number>();
    issuedOrders.forEach((o) => {
      if (!o.issued_at) return;
      const key = o.issued_at.slice(0, 7);
      byMonthMap.set(key, (byMonthMap.get(key) ?? 0) + (o.total ?? 0));
    });
    const revenueByMonth = Array.from(byMonthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([month, value]) => ({ label: monthLabel(month), value }));

    const topDebtors = debts
      .filter((c) => c.debt > 0)
      .slice(0, 8)
      .map((c) => ({ label: c.name, value: c.debt }));

    return { totalDebt, clientsInDebt, periodRevenue, revenueByMonth, topDebtors };
  }, [debts, issuedOrders, periodFrom, periodTo]);

  if (loading) return <p className="text-sm text-slate-400">Загрузка…</p>;

  return (
    <div className="space-y-6 sm:space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Финансы</h1>
        <p className="mt-1 text-sm text-slate-500">Долги клиентов, оплаты и выручка</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Общий долг клиентов" value={formatMoney(stats.totalDebt)} />
        <StatCard label="Клиентов с долгом" value={String(stats.clientsInDebt)} />
        <StatCard label="Выручка за период" value={formatMoney(stats.periodRevenue)} />
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">Период с</span>
          <input
            type="date"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={periodFrom}
            onChange={(e) => setPeriodFrom(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">по</span>
          <input
            type="date"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={periodTo}
            onChange={(e) => setPeriodTo(e.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setPeriodFrom(monthStart());
            setPeriodTo(todayDate());
          }}
          className="rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600"
        >
          Этот месяц
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Выручка по месяцам">
          <LineChart points={stats.revenueByMonth} formatValue={formatMoney} emptyHint="Нажмите на точку, чтобы увидеть месяц" />
        </Panel>
        <Panel title="Топ клиентов по долгу">
          <BarChart points={stats.topDebtors} formatValue={formatMoney} emptyHint="Нажмите на столбик, чтобы увидеть клиента" />
        </Panel>
      </div>

      <Panel title="Клиенты">
        {debts.length === 0 && <p className="text-sm text-slate-400">Клиентов пока нет</p>}
        {debts.length > 0 && (
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
                    c.debt > 0 ? 'text-red-600' : c.debt < 0 ? 'text-green-600' : 'text-slate-400'
                  }`}
                >
                  {formatMoney(c.debt)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

export default function FinancePage() {
  return (
    <RequireRole roles={['ceo']}>
      <FinanceContent />
    </RequireRole>
  );
}
