'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { CLIENT_CATEGORY_LABELS, FINANCE_MARKET_LABELS, FinanceReceipt, FinanceReceiptItem } from '@/lib/types';
import { formatDate, formatMoney } from '@/lib/format';
import { fetchAll } from '@/lib/fetchAll';
import { downloadXlsx } from '@/lib/excelExport';
import { formatDateOnly, periodEndTs, periodStartTs } from '@/lib/dates';
import RequireRole from '@/components/RequireRole';
import ExcelButton from '@/components/ExcelButton';
import { useFinanceFilters } from '@/components/FinanceFilters';

function ReceiptsContent() {
  const { market, from, to } = useFinanceFilters();
  const [receipts, setReceipts] = useState<FinanceReceipt[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await fetchAll<FinanceReceipt>((a, b) => {
        let q = supabase
          .from('finance_receipts_view')
          .select('*')
          .gte('issued_at', periodStartTs(from))
          .lte('issued_at', periodEndTs(to))
          .order('issued_at', { ascending: false });
        if (market !== 'all') q = q.eq('client_category', market);
        return q.range(a, b);
      });
      setReceipts(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoaded(true);
  }, [market, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const unpricedCount = receipts.filter((r) => r.has_unpriced_item).length;
  const soldTotal = useMemo(
    () => receipts.filter((r) => r.status === 'issued').reduce((sum, r) => sum + (r.total ?? 0), 0),
    [receipts]
  );

  async function exportExcel() {
    const items = await fetchAll<FinanceReceiptItem>((a, b) => {
      let q = supabase
        .from('finance_receipt_items_view')
        .select('*')
        .gte('issued_at', periodStartTs(from))
        .lte('issued_at', periodEndTs(to))
        .order('issued_at', { ascending: false });
      if (market !== 'all') q = q.eq('client_category', market);
      return q.range(a, b);
    });
    const shortId = (id: string) => id.slice(0, 8);
    const marketLabel = (c: FinanceReceipt['client_category']) => (c ? CLIENT_CATEGORY_LABELS[c] : 'Без категории');
    const statusLabel = (s: FinanceReceipt['status']) => (s === 'returned' ? 'Возвращено' : 'Выдан');

    await downloadXlsx(`Чеки_${from}_${to}_${FINANCE_MARKET_LABELS[market]}`, [
      {
        name: 'Чеки',
        columns: [
          { header: '№ заказа', key: 'id', width: 12 },
          { header: 'Дата выдачи', key: 'date', width: 18 },
          { header: 'Клиент', key: 'client', width: 28 },
          { header: 'Рынок', key: 'market', width: 18 },
          { header: 'Статус', key: 'status', width: 13 },
          { header: 'Сумма, сум', key: 'total', money: true, width: 16 },
          { header: 'Без цены', key: 'unpriced', width: 11 },
        ],
        rows: receipts.map((r) => ({
          id: shortId(r.id),
          date: r.issued_at ? formatDate(r.issued_at) : '',
          client: r.client_name,
          market: marketLabel(r.client_category),
          status: statusLabel(r.status),
          total: r.total,
          unpriced: r.has_unpriced_item ? 'да' : '',
        })),
        totals: { client: 'Итого выдано', total: soldTotal },
      },
      {
        name: 'Позиции',
        columns: [
          { header: '№ заказа', key: 'id', width: 12 },
          { header: 'Дата выдачи', key: 'date', width: 18 },
          { header: 'Клиент', key: 'client', width: 28 },
          { header: 'Статус', key: 'status', width: 13 },
          { header: 'Товар', key: 'product', width: 28 },
          { header: 'Цвет', key: 'color', width: 14 },
          { header: 'Размер', key: 'size', width: 10 },
          { header: 'Кол-во', key: 'qty', width: 10 },
          { header: 'Цена за шт, сум', key: 'price', money: true, width: 16 },
          { header: 'Сумма по строке, сум', key: 'line', money: true, width: 20 },
        ],
        rows: items.map((i) => ({
          id: shortId(i.order_id),
          date: i.issued_at ? formatDate(i.issued_at) : '',
          client: i.client_name,
          status: statusLabel(i.status),
          product: i.product_name,
          color: i.color,
          size: i.size,
          qty: i.quantity,
          price: i.price,
          line: i.line_total,
        })),
      },
    ]);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Чеки</h1>
          <p className="mt-1 text-sm text-slate-500">Каждая выдача заказа — отдельный чек</p>
        </div>
        <ExcelButton onExport={exportExcel} disabled={receipts.length === 0} />
      </div>

      {error && <p className="text-sm text-danger-600">{error}</p>}
      {unpricedCount > 0 && (
        <p className="rounded-md bg-warning-50 px-3 py-2 text-sm font-medium text-warning-700">
          Чеков без цены по части позиций: {unpricedCount} — откройте чек, чтобы вписать цену.
        </p>
      )}

      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="flex items-baseline justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-700">
            Выдачи за {formatDateOnly(from)} — {formatDateOnly(to)}
          </h2>
          <span className="text-sm font-semibold text-slate-900">{formatMoney(soldTotal)}</span>
        </div>
        {!loaded && <p className="px-4 py-3 text-sm text-slate-400">Загрузка…</p>}
        {loaded && receipts.length === 0 && <p className="px-4 py-3 text-sm text-slate-400">За этот период чеков нет</p>}
        <div className="divide-y divide-slate-100">
          {receipts.map((r) => (
            <Link
              key={r.id}
              href={`/orders/${r.id}`}
              className="flex items-center justify-between gap-3 px-4 py-3.5 hover:bg-slate-50 active:bg-slate-100"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-800">
                  {r.client_name}
                  {r.status === 'returned' && (
                    <span className="ml-2 rounded-full bg-warning-100 px-2 py-0.5 text-xs font-medium text-warning-700">
                      Возвращено
                    </span>
                  )}
                  {r.has_unpriced_item && (
                    <span className="ml-2 rounded-full bg-warning-100 px-2 py-0.5 text-xs font-medium text-warning-700">
                      без цены
                    </span>
                  )}
                </p>
                <p className="text-xs text-slate-400">{r.issued_at ? formatDate(r.issued_at) : '—'}</p>
              </div>
              <span className={`shrink-0 font-semibold ${r.status === 'returned' ? 'text-slate-400 line-through' : 'text-slate-800'}`}>
                {r.total != null ? formatMoney(r.total) : '—'}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ReceiptsPage() {
  return (
    <RequireRole roles={['ceo']}>
      <ReceiptsContent />
    </RequireRole>
  );
}
