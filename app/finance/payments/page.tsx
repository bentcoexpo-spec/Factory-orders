'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { CLIENT_CATEGORY_LABELS, ClientPayment, FINANCE_MARKET_LABELS } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { fetchAll } from '@/lib/fetchAll';
import { downloadXlsx } from '@/lib/excelExport';
import { formatDateOnly } from '@/lib/dates';
import RequireRole from '@/components/RequireRole';
import PaymentForm from '@/components/PaymentForm';
import PaymentRow from '@/components/PaymentRow';
import ExcelButton from '@/components/ExcelButton';
import { useFinanceFilters } from '@/components/FinanceFilters';

function PaymentsContent() {
  const { market, from, to } = useFinanceFilters();
  const [payments, setPayments] = useState<ClientPayment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await fetchAll<ClientPayment>((a, b) => {
        let q = supabase
          .from('client_payments_view')
          .select('*')
          .gte('paid_at', from)
          .lte('paid_at', to)
          .order('paid_at', { ascending: false })
          .order('created_at', { ascending: false });
        if (market !== 'all') q = q.eq('client_category', market);
        return q.range(a, b);
      });
      setPayments(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoaded(true);
  }, [market, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const total = useMemo(() => payments.reduce((sum, p) => sum + p.amount, 0), [payments]);

  async function exportExcel() {
    await downloadXlsx(`Оплаты_${from}_${to}_${FINANCE_MARKET_LABELS[market]}`, [
      {
        name: 'Оплаты',
        columns: [
          { header: 'Дата оплаты', key: 'paid_at', date: true, width: 14 },
          { header: 'Клиент', key: 'client', width: 28 },
          { header: 'Рынок', key: 'market', width: 18 },
          { header: 'Сумма, сум', key: 'amount', money: true, width: 16 },
          { header: 'Комментарий', key: 'comment', width: 30 },
          { header: 'Внёс', key: 'by', width: 26 },
          { header: 'Фото чека', key: 'photos', width: 11 },
        ],
        rows: payments.map((p) => ({
          paid_at: p.paid_at,
          client: p.client_name,
          market: p.client_category ? CLIENT_CATEGORY_LABELS[p.client_category] : 'Без категории',
          amount: p.amount,
          comment: p.comment,
          by: p.created_by_email,
          photos: p.photo_count,
        })),
        totals: { client: 'Итого', amount: total },
      },
    ]);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Оплаты</h1>
          <p className="mt-1 text-sm text-slate-500">Деньги от клиентов. Оплата больше долга — это аванс</p>
        </div>
        <ExcelButton onExport={exportExcel} disabled={payments.length === 0} />
      </div>

      <PaymentForm onSaved={load} />

      {error && <p className="text-sm text-danger-600">{error}</p>}

      <div className="card">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-700">
            Оплаты за {formatDateOnly(from)} — {formatDateOnly(to)}
          </h2>
          <span className="text-sm font-semibold text-slate-900">{formatMoney(total)}</span>
        </div>
        {!loaded && <p className="text-sm text-slate-400">Загрузка…</p>}
        {loaded && payments.length === 0 && <p className="py-2 text-sm text-slate-400">За этот период оплат нет</p>}
        <div className="divide-y divide-slate-100">
          {payments.map((p) => (
            <PaymentRow key={p.id} payment={p} showClient onChanged={load} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function PaymentsPage() {
  return (
    <RequireRole roles={['ceo']}>
      <PaymentsContent />
    </RequireRole>
  );
}
