'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  EXPENSE_KIND_LABELS,
  EXPENSE_MARKET_LABELS,
  Expense,
  ExpenseMarket,
  ExpensePaymentKind,
  FINANCE_MARKET_LABELS,
} from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { fetchAll } from '@/lib/fetchAll';
import { downloadXlsx } from '@/lib/excelExport';
import { formatDateOnly, todayDate } from '@/lib/dates';
import { uploadReceiptPhotos } from '@/lib/receiptPhotos';
import RequireRole from '@/components/RequireRole';
import ExcelButton from '@/components/ExcelButton';
import ExpenseCard, { KindToggle, MarketToggle } from '@/components/ExpenseCard';
import { PhotoPicker } from '@/components/ReceiptPhotos';
import { useFinanceFilters } from '@/components/FinanceFilters';

function ExpenseForm({ suppliers, onSaved }: { suppliers: string[]; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [spentAt, setSpentAt] = useState(todayDate());
  const [kind, setKind] = useState<ExpensePaymentKind>('paid');
  const [supplier, setSupplier] = useState('');
  const [market, setMarket] = useState<ExpenseMarket>('general');
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setWarning(null);
    const value = Number(amount);
    if (!title.trim()) {
      setError('Укажите, что купили');
      return;
    }
    if (!value || value <= 0) {
      setError('Укажите сумму больше нуля');
      return;
    }
    if (!spentAt) {
      setError('Укажите дату');
      return;
    }

    setSaving(true);
    const { data, error: insertError } = await supabase
      .from('expenses')
      .insert({
        title: title.trim(),
        amount: value,
        spent_at: spentAt,
        payment_kind: kind,
        supplier: supplier.trim() || null,
        market,
        comment: comment.trim() || null,
      })
      .select('id')
      .single();
    if (insertError || !data) {
      setSaving(false);
      setError(insertError?.message ?? 'Не удалось сохранить расход');
      return;
    }
    if (files.length > 0) {
      const photoError = await uploadReceiptPhotos('expense', (data as { id: string }).id, files);
      if (photoError) {
        setWarning(`Расход сохранён, но фото загрузились не все: ${photoError}. Добавьте их в карточке расхода.`);
      }
    }
    setSaving(false);

    setTitle('');
    setAmount('');
    setSupplier('');
    setComment('');
    setFiles([]);
    setSpentAt(todayDate());
    onSaved();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 card">
      <h2 className="text-sm font-semibold text-slate-700">Новый расход</h2>

      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-slate-500">Что купили *</span>
        <input
          className="input"
          placeholder="например Нитки, аренда, ремонт станка"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">Сумма, сум *</span>
          <input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            className="input"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">Дата *</span>
          <input
            type="date"
            className="input"
            value={spentAt}
            onChange={(e) => setSpentAt(e.target.value)}
          />
        </label>
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium text-slate-500">Как платили</span>
        <KindToggle value={kind} onChange={setKind} />
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium text-slate-500">К какому рынку относится</span>
        <MarketToggle value={market} onChange={setMarket} />
      </div>

      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-slate-500">У кого купили — по желанию</span>
        <input
          list="expense-suppliers"
          className="input"
          value={supplier}
          onChange={(e) => setSupplier(e.target.value)}
        />
        <datalist id="expense-suppliers">
          {suppliers.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>

      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-slate-500">Комментарий — по желанию</span>
        <input
          className="input"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </label>

      <PhotoPicker files={files} onChange={setFiles} />

      {error && <p className="text-sm text-danger-600">{error}</p>}
      {warning && <p className="text-sm text-warning-700">{warning}</p>}

      <button
        type="submit"
        disabled={saving}
        className="btn-primary w-full sm:w-auto"
      >
        {saving ? 'Сохранение…' : 'Записать расход'}
      </button>
    </form>
  );
}

interface RepaymentRow {
  id: string;
  amount: number;
  paid_at: string;
  comment: string | null;
  expenses: { title: string; supplier: string | null; market: ExpenseMarket };
}

function ExpensesContent() {
  const { market, from, to } = useFinanceFilters();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [unpaid, setUnpaid] = useState<Expense[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [period, debts] = await Promise.all([
        fetchAll<Expense>((a, b) => {
          let q = supabase
            .from('expenses_view')
            .select('*')
            .gte('spent_at', from)
            .lte('spent_at', to)
            .order('spent_at', { ascending: false })
            .order('created_at', { ascending: false });
          if (market !== 'all') q = q.eq('market', market);
          return q.range(a, b);
        }),
        fetchAll<Expense>((a, b) => {
          let q = supabase
            .from('expenses_view')
            .select('*')
            .gt('debt_left', 0)
            .order('spent_at', { ascending: true });
          if (market !== 'all') q = q.eq('market', market);
          return q.range(a, b);
        }),
      ]);
      setExpenses(period);
      setUnpaid(debts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoaded(true);
  }, [market, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const total = useMemo(() => expenses.reduce((sum, e) => sum + e.amount, 0), [expenses]);
  const weOwe = useMemo(() => unpaid.reduce((sum, e) => sum + e.debt_left, 0), [unpaid]);
  const suppliers = useMemo(
    () => Array.from(new Set([...expenses, ...unpaid].map((e) => e.supplier).filter((s): s is string => !!s))).sort(),
    [expenses, unpaid]
  );

  async function exportExcel() {
    const repayments = await fetchAll<RepaymentRow>((a, b) => {
      let q = supabase
        .from('expense_repayments')
        .select('id, amount, paid_at, comment, expenses!inner(title, supplier, market)')
        .gte('paid_at', from)
        .lte('paid_at', to)
        .order('paid_at', { ascending: true });
      if (market !== 'all') q = q.eq('expenses.market', market);
      return q.range(a, b);
    });
    const repaidTotal = repayments.reduce((sum, r) => sum + r.amount, 0);

    await downloadXlsx(`Расходы_${from}_${to}_${FINANCE_MARKET_LABELS[market]}`, [
      {
        name: 'Расходы',
        columns: [
          { header: 'Дата', key: 'date', date: true, width: 13 },
          { header: 'Что купили', key: 'title', width: 32 },
          { header: 'Сумма, сум', key: 'amount', money: true, width: 16 },
          { header: 'Как платили', key: 'kind', width: 14 },
          { header: 'У кого', key: 'supplier', width: 24 },
          { header: 'Рынок', key: 'market', width: 18 },
          { header: 'Погашено, сум', key: 'repaid', money: true, width: 16 },
          { header: 'Остаток долга, сум', key: 'left', money: true, width: 18 },
          { header: 'Комментарий', key: 'comment', width: 28 },
        ],
        rows: expenses.map((e) => ({
          date: e.spent_at,
          title: e.title,
          amount: e.amount,
          kind: EXPENSE_KIND_LABELS[e.payment_kind],
          supplier: e.supplier,
          market: EXPENSE_MARKET_LABELS[e.market],
          repaid: e.payment_kind === 'credit' ? e.repaid_total : null,
          left: e.payment_kind === 'credit' ? e.debt_left : null,
          comment: e.comment,
        })),
        totals: { title: 'Итого', amount: total },
      },
      {
        name: 'Погашения',
        columns: [
          { header: 'Дата погашения', key: 'date', date: true, width: 16 },
          { header: 'За что', key: 'title', width: 32 },
          { header: 'У кого', key: 'supplier', width: 24 },
          { header: 'Рынок', key: 'market', width: 18 },
          { header: 'Сумма, сум', key: 'amount', money: true, width: 16 },
          { header: 'Комментарий', key: 'comment', width: 28 },
        ],
        rows: repayments.map((r) => ({
          date: r.paid_at,
          title: r.expenses.title,
          supplier: r.expenses.supplier,
          market: EXPENSE_MARKET_LABELS[r.expenses.market],
          amount: r.amount,
          comment: r.comment,
        })),
        totals: { title: 'Итого', amount: repaidTotal },
      },
    ]);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Расходы</h1>
          <p className="mt-1 text-sm text-slate-500">Что купили, оплатили сразу или взяли в долг</p>
        </div>
        <ExcelButton onExport={exportExcel} disabled={expenses.length === 0} />
      </div>

      <ExpenseForm suppliers={suppliers} onSaved={load} />

      {error && <p className="text-sm text-danger-600">{error}</p>}

      {loaded && unpaid.length > 0 && (
        <div className="rounded-lg border border-danger-200 bg-white p-4">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-700">Мы должны (на сегодня)</h2>
            <span className="text-sm font-semibold text-danger-600">{formatMoney(weOwe)}</span>
          </div>
          <div className="divide-y divide-slate-100">
            {unpaid.map((e) => (
              <ExpenseCard key={e.id} expense={e} onChanged={load} />
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-700">
            Расходы за {formatDateOnly(from)} — {formatDateOnly(to)}
          </h2>
          <span className="text-sm font-semibold text-slate-900">{formatMoney(total)}</span>
        </div>
        {!loaded && <p className="text-sm text-slate-400">Загрузка…</p>}
        {loaded && expenses.length === 0 && <p className="py-2 text-sm text-slate-400">За этот период расходов нет</p>}
        <div className="divide-y divide-slate-100">
          {expenses.map((e) => (
            <ExpenseCard key={e.id} expense={e} onChanged={load} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ExpensesPage() {
  return (
    <RequireRole roles={['ceo']}>
      <ExpensesContent />
    </RequireRole>
  );
}
