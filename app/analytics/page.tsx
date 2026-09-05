'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { AnalyticsOrder, ORDER_STATUSES } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

function AnalyticsContent() {
  const [orders, setOrders] = useState<AnalyticsOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('orders')
        .select('*, client:clients(*), items:order_items(*, product:products(*))')
        .order('created_at', { ascending: false });
      setOrders((data as unknown as AnalyticsOrder[]) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  const stats = useMemo(() => {
    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((sum, o) => sum + o.total, 0);
    const paidRevenue = orders.filter((o) => o.status === 'paid').reduce((sum, o) => sum + o.total, 0);
    const avgOrder = totalOrders ? totalRevenue / totalOrders : 0;

    const byStatus = ORDER_STATUSES.map((s) => ({
      ...s,
      count: orders.filter((o) => o.status === s.value).length,
    }));

    const byMonthMap = new Map<string, number>();
    orders.forEach((o) => {
      const d = new Date(o.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      byMonthMap.set(key, (byMonthMap.get(key) ?? 0) + o.total);
    });
    const byMonth = Array.from(byMonthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6);

    const clientTotals = new Map<string, { name: string; total: number }>();
    orders.forEach((o) => {
      const prev = clientTotals.get(o.client_id) ?? { name: o.client?.name ?? '—', total: 0 };
      prev.total += o.total;
      clientTotals.set(o.client_id, prev);
    });
    const topClients = Array.from(clientTotals.values()).sort((a, b) => b.total - a.total).slice(0, 5);

    const productQty = new Map<string, { name: string; qty: number }>();
    orders.forEach((o) => {
      o.items?.forEach((it) => {
        const prev = productQty.get(it.product_id) ?? { name: it.product?.name ?? '—', qty: 0 };
        prev.qty += it.quantity;
        productQty.set(it.product_id, prev);
      });
    });
    const topProducts = Array.from(productQty.values()).sort((a, b) => b.qty - a.qty).slice(0, 5);

    return { totalOrders, totalRevenue, paidRevenue, avgOrder, byStatus, byMonth, topClients, topProducts };
  }, [orders]);

  if (loading) return <p className="text-sm text-slate-400">Загрузка…</p>;

  const maxStatusCount = Math.max(1, ...stats.byStatus.map((s) => s.count));
  const maxMonthRevenue = Math.max(1, ...stats.byMonth.map(([, v]) => v));
  const maxClientTotal = Math.max(1, ...stats.topClients.map((c) => c.total));
  const maxProductQty = Math.max(1, ...stats.topProducts.map((p) => p.qty));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Аналитика</h1>
        <p className="mt-1 text-sm text-slate-500">Сводка по заказам фабрики</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Всего заказов" value={String(stats.totalOrders)} />
        <StatCard label="Общая сумма заказов" value={formatMoney(stats.totalRevenue)} />
        <StatCard label="Оплачено" value={formatMoney(stats.paidRevenue)} />
        <StatCard label="Средний чек" value={formatMoney(stats.avgOrder)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Заказы по статусам">
          <div className="space-y-2">
            {stats.byStatus.map((s) => (
              <div key={s.value} className="flex items-center gap-3">
                <span className="w-32 shrink-0 text-xs text-slate-600">{s.label}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full ${s.color}`} style={{ width: `${(s.count / maxStatusCount) * 100}%` }} />
                </div>
                <span className="w-6 text-right text-xs text-slate-500">{s.count}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Выручка по месяцам">
          {stats.byMonth.length === 0 && <p className="text-sm text-slate-400">Нет данных</p>}
          <div className="space-y-2">
            {stats.byMonth.map(([month, value]) => (
              <div key={month} className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-xs text-slate-600">{month}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full bg-slate-900" style={{ width: `${(value / maxMonthRevenue) * 100}%` }} />
                </div>
                <span className="w-20 text-right text-xs text-slate-500">{formatMoney(value)}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Топ клиентов">
          {stats.topClients.length === 0 && <p className="text-sm text-slate-400">Нет данных</p>}
          <div className="space-y-2">
            {stats.topClients.map((c) => (
              <div key={c.name} className="flex items-center gap-3">
                <span className="w-32 shrink-0 truncate text-xs text-slate-600">{c.name}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full bg-blue-500" style={{ width: `${(c.total / maxClientTotal) * 100}%` }} />
                </div>
                <span className="w-20 text-right text-xs text-slate-500">{formatMoney(c.total)}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Топ товаров по количеству">
          {stats.topProducts.length === 0 && <p className="text-sm text-slate-400">Нет данных</p>}
          <div className="space-y-2">
            {stats.topProducts.map((p) => (
              <div key={p.name} className="flex items-center gap-3">
                <span className="w-32 shrink-0 truncate text-xs text-slate-600">{p.name}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full bg-amber-500" style={{ width: `${(p.qty / maxProductQty) * 100}%` }} />
                </div>
                <span className="w-16 text-right text-xs text-slate-500">{p.qty}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <RequireRole roles={['ceo']}>
      <AnalyticsContent />
    </RequireRole>
  );
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
