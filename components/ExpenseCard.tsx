'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  EXPENSE_KIND_LABELS,
  EXPENSE_MARKET_LABELS,
  Expense,
  ExpenseMarket,
  ExpensePaymentKind,
  ExpenseRepayment,
} from '@/lib/types';
import { formatDate, formatMoney } from '@/lib/format';
import { formatDateOnly, todayDate } from '@/lib/dates';
import { removeAllReceiptFiles } from '@/lib/receiptPhotos';
import { SavedPhotos } from '@/components/ReceiptPhotos';
import MoneyInput from '@/components/MoneyInput';
import { moneyDigits } from '@/lib/money';
import { friendlyMoneyError } from '@/lib/errors';

const MARKETS: ExpenseMarket[] = ['general', 'local', 'expo'];
const KINDS: ExpensePaymentKind[] = ['paid', 'credit'];

export function KindToggle({ value, onChange }: { value: ExpensePaymentKind; onChange: (k: ExpensePaymentKind) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-md bg-slate-100 p-1">
      {KINDS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          className={`rounded px-2 py-2 text-sm font-medium ${
            value === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
          }`}
        >
          {EXPENSE_KIND_LABELS[k]}
        </button>
      ))}
    </div>
  );
}

export function MarketToggle({ value, onChange }: { value: ExpenseMarket; onChange: (m: ExpenseMarket) => void }) {
  return (
    <div className="grid grid-cols-3 gap-1 rounded-md bg-slate-100 p-1">
      {MARKETS.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={`rounded px-1 py-2 text-xs font-medium sm:text-sm ${
            value === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
          }`}
        >
          {EXPENSE_MARKET_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

// Один расход в списке: раскрывается в погашения (у «Взяли в долг»),
// фото, правку и удаление. Любая правка/удаление денег — с подтверждением,
// а в журнал (finance_audit_log) их пишет база сама.
export default function ExpenseCard({ expense, onChanged }: { expense: Expense; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [repayments, setRepayments] = useState<ExpenseRepayment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState(expense.title);
  const [amount, setAmount] = useState(moneyDigits(expense.amount));
  const [spentAt, setSpentAt] = useState(expense.spent_at);
  const [kind, setKind] = useState<ExpensePaymentKind>(expense.payment_kind);
  const [supplier, setSupplier] = useState(expense.supplier ?? '');
  const [market, setMarket] = useState<ExpenseMarket>(expense.market);
  const [comment, setComment] = useState(expense.comment ?? '');

  const [repayAmount, setRepayAmount] = useState('');
  const [repayDate, setRepayDate] = useState(todayDate());
  const [repayComment, setRepayComment] = useState('');

  async function loadRepayments() {
    const { data } = await supabase
      .from('expense_repayments')
      .select('*')
      .eq('expense_id', expense.id)
      .order('paid_at', { ascending: true })
      .order('created_at', { ascending: true });
    setRepayments((data as unknown as ExpenseRepayment[]) ?? []);
  }

  useEffect(() => {
    if (open && expense.payment_kind === 'credit') loadRepayments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expense.payment_kind, expense.repaid_total]);

  async function handleSave() {
    const value = Number(amount);
    if (!title.trim()) {
      setError('Укажите, что купили');
      return;
    }
    if (!value || value <= 0) {
      setError('Сумма должна быть больше нуля');
      return;
    }
    if (!spentAt) {
      setError('Укажите дату');
      return;
    }
    if (
      !confirm(
        `Изменить расход?\nБыло: ${expense.title}, ${formatMoney(expense.amount)}\nСтанет: ${title.trim()}, ${formatMoney(value)}\nИзменение запишется в журнал.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const { error: updateError } = await supabase
      .from('expenses')
      .update({
        title: title.trim(),
        amount: value,
        spent_at: spentAt,
        payment_kind: kind,
        supplier: supplier.trim() || null,
        market,
        comment: comment.trim() || null,
      })
      .eq('id', expense.id);
    setBusy(false);
    if (updateError) {
      setError(friendlyMoneyError(updateError.message));
      return;
    }
    setEditing(false);
    onChanged();
  }

  async function handleDelete() {
    const extra = expense.repaid_total > 0 ? ` Вместе с ним удалятся и погашения (${formatMoney(expense.repaid_total)}).` : '';
    if (
      !confirm(
        `Удалить расход «${expense.title}» на ${formatMoney(expense.amount)}?${extra}\nУдаление запишется в журнал.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    await removeAllReceiptFiles('expense', expense.id);
    const { error: deleteError } = await supabase.from('expenses').delete().eq('id', expense.id);
    setBusy(false);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    onChanged();
  }

  async function handleRepay() {
    const value = Number(repayAmount);
    if (!value || value <= 0) {
      setError('Укажите сумму погашения');
      return;
    }
    if (value > expense.debt_left) {
      setError(`Остаток долга — ${formatMoney(expense.debt_left)}, больше погасить нельзя`);
      return;
    }
    if (!repayDate) {
      setError('Укажите дату погашения');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: insertError } = await supabase.from('expense_repayments').insert({
      expense_id: expense.id,
      amount: value,
      paid_at: repayDate,
      comment: repayComment.trim() || null,
    });
    setBusy(false);
    if (insertError) {
      setError(friendlyMoneyError(insertError.message));
      return;
    }
    setRepayAmount('');
    setRepayComment('');
    setRepayDate(todayDate());
    onChanged();
  }

  async function handleDeleteRepayment(r: ExpenseRepayment) {
    if (!confirm(`Удалить погашение ${formatMoney(r.amount)} от ${formatDateOnly(r.paid_at)}?\nДолг вырастет. Удаление запишется в журнал.`)) {
      return;
    }
    setBusy(true);
    const { error: deleteError } = await supabase.from('expense_repayments').delete().eq('id', r.id);
    setBusy(false);
    if (deleteError) setError(deleteError.message);
    else onChanged();
  }

  const isCredit = expense.payment_kind === 'credit';

  return (
    <div className="py-3">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-start justify-between gap-3 text-left">
        <div className="min-w-0">
          <p className="truncate font-medium text-slate-800">{expense.title}</p>
          <p className="text-xs text-slate-400">
            {formatDateOnly(expense.spent_at)}
            {expense.supplier && ` · ${expense.supplier}`}
            {expense.market !== 'general' && ` · ${EXPENSE_MARKET_LABELS[expense.market]}`}
            {expense.photo_count > 0 && ` · фото: ${expense.photo_count}`}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {isCredit ? (
              expense.debt_left > 0 ? (
                <span className="rounded-full bg-danger-100 px-2 py-0.5 text-xs font-medium text-danger-700">
                  В долг · осталось {formatMoney(expense.debt_left)}
                </span>
              ) : (
                <span className="rounded-full bg-success-100 px-2 py-0.5 text-xs font-medium text-success-700">В долг · погашено</span>
              )
            ) : (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">Оплатили</span>
            )}
          </div>
        </div>
        <span className="shrink-0 font-semibold text-slate-800">{formatMoney(expense.amount)}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3 rounded-md bg-slate-50 p-3">
          {!editing ? (
            <>
              <p className="text-xs text-slate-500">
                Записано {formatDate(expense.created_at)}
                {expense.created_by_email && ` · ${expense.created_by_email}`}
                {expense.updated_at && ` · изменено ${formatDate(expense.updated_at)}`}
              </p>
              {expense.comment && <p className="text-sm text-slate-600">{expense.comment}</p>}

              {isCredit && (
                <div className="space-y-2 rounded-md border border-slate-200 bg-white p-3">
                  <p className="text-sm font-semibold text-slate-700">
                    Погашено {formatMoney(expense.repaid_total)} из {formatMoney(expense.amount)}
                  </p>
                  {repayments.map((r) => (
                    <div key={r.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-slate-600">
                        {formatDateOnly(r.paid_at)} · {formatMoney(r.amount)}
                        {r.comment && <span className="text-slate-400"> · {r.comment}</span>}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleDeleteRepayment(r)}
                        className="shrink-0 text-xs font-medium text-danger-600"
                      >
                        Удалить
                      </button>
                    </div>
                  ))}
                  {expense.debt_left > 0 && (
                    <div className="space-y-2 border-t border-slate-100 pt-2">
                      <p className="text-xs font-medium text-slate-500">Погасить (полностью или частью)</p>
                      <div className="flex items-center gap-2">
                        <MoneyInput placeholder="Сумма" className="input min-w-0 flex-1" value={repayAmount} onChange={setRepayAmount} />
                        <button
                          type="button"
                          onClick={() => setRepayAmount(moneyDigits(expense.debt_left))}
                          className="btn-secondary btn-sm shrink-0"
                        >
                          Весь остаток
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="date"
                          className="rounded-md border border-slate-300 px-3 py-2.5 text-base"
                          value={repayDate}
                          onChange={(e) => setRepayDate(e.target.value)}
                        />
                        <input
                          className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2.5 text-base"
                          placeholder="Комментарий"
                          value={repayComment}
                          onChange={(e) => setRepayComment(e.target.value)}
                        />
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={handleRepay}
                        className="rounded-md bg-success-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
                      >
                        {busy ? 'Сохранение…' : 'Погасить'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              <SavedPhotos kind="expense" ownerId={expense.id} onChanged={onChanged} />

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="btn-tonal"
                >
                  Изменить
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleDelete}
                  className="btn-tonal-danger"
                >
                  Удалить
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block text-xs font-medium text-slate-500">Что купили</span>
                <input
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="mb-1 block text-xs font-medium text-slate-500">Сумма, сум</span>
                  <MoneyInput className="input" value={amount} onChange={setAmount} />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-xs font-medium text-slate-500">Дата</span>
                  <input
                    type="date"
                    className="input"
                    value={spentAt}
                    onChange={(e) => setSpentAt(e.target.value)}
                  />
                </label>
              </div>
              <KindToggle value={kind} onChange={setKind} />
              <MarketToggle value={market} onChange={setMarket} />
              <label className="block text-sm">
                <span className="mb-1 block text-xs font-medium text-slate-500">У кого купили</span>
                <input
                  className="input"
                  value={supplier}
                  onChange={(e) => setSupplier(e.target.value)}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-xs font-medium text-slate-500">Комментарий</span>
                <input
                  className="input"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleSave}
                  className="btn-primary"
                >
                  {busy ? 'Сохранение…' : 'Сохранить'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setError(null);
                  }}
                  className="btn-ghost-muted"
                >
                  Отмена
                </button>
              </div>
            </div>
          )}
          {error && <p className="text-sm text-danger-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
