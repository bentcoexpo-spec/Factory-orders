'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { ClientPayment, CLIENT_CATEGORY_LABELS } from '@/lib/types';
import { formatDate, formatMoney } from '@/lib/format';
import { formatDateOnly } from '@/lib/dates';
import { removeAllReceiptFiles } from '@/lib/receiptPhotos';
import { SavedPhotos } from '@/components/ReceiptPhotos';

// Одна оплата в списке: раскрывается в фото, правку и удаление. И
// правка, и удаление — с подтверждением; в журнал (finance_audit_log)
// их пишет база сама, кто и когда.
export default function PaymentRow({
  payment,
  showClient,
  onChanged,
}: {
  payment: ClientPayment;
  showClient: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(payment.amount));
  const [paidAt, setPaidAt] = useState(payment.paid_at);
  const [comment, setComment] = useState(payment.comment ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const value = Number(amount);
    if (!value || value <= 0) {
      setError('Сумма должна быть больше нуля');
      return;
    }
    if (!paidAt) {
      setError('Укажите дату');
      return;
    }
    if (
      !confirm(
        `Изменить оплату?\nБыло: ${formatMoney(payment.amount)}, ${formatDateOnly(payment.paid_at)}\nСтанет: ${formatMoney(value)}, ${formatDateOnly(paidAt)}\nИзменение запишется в журнал.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const { error: updateError } = await supabase
      .from('client_payments_view')
      .update({ amount: value, paid_at: paidAt, comment: comment.trim() || null, client_id: payment.client_id })
      .eq('id', payment.id);
    setBusy(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setEditing(false);
    onChanged();
  }

  async function handleDelete() {
    if (
      !confirm(
        `Удалить оплату ${formatMoney(payment.amount)} от ${formatDateOnly(payment.paid_at)} (${payment.client_name})?\nДолг клиента вырастет на эту сумму. Удаление запишется в журнал.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    await removeAllReceiptFiles('payment', payment.id);
    const { error: deleteError } = await supabase.from('client_payments_view').delete().eq('id', payment.id);
    setBusy(false);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    onChanged();
  }

  return (
    <div className="py-3">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-3 text-left">
        <div className="min-w-0">
          <p className="truncate font-medium text-slate-800">
            {showClient ? payment.client_name : formatDateOnly(payment.paid_at)}
            {payment.client_category && showClient && (
              <span className="ml-2 text-xs font-normal text-slate-400">{CLIENT_CATEGORY_LABELS[payment.client_category]}</span>
            )}
          </p>
          <p className="text-xs text-slate-400">
            {showClient && `${formatDateOnly(payment.paid_at)} · `}
            {payment.comment ?? 'без комментария'}
            {payment.photo_count > 0 && ` · фото: ${payment.photo_count}`}
          </p>
        </div>
        <span className="shrink-0 font-semibold text-green-700">{formatMoney(payment.amount)}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3 rounded-md bg-slate-50 p-3">
          {!editing ? (
            <>
              <p className="text-xs text-slate-500">
                Внесено {formatDate(payment.created_at)}
                {payment.created_by_email && ` · ${payment.created_by_email}`}
                {payment.updated_at && ` · изменено ${formatDate(payment.updated_at)}`}
              </p>
              <SavedPhotos kind="payment" ownerId={payment.id} onChanged={onChanged} />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="rounded-md bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-600"
                >
                  Изменить
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleDelete}
                  className="rounded-md bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-50"
                >
                  Удалить
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block text-sm">
                  <span className="mb-1 block text-xs font-medium text-slate-500">Сумма</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    inputMode="decimal"
                    className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-xs font-medium text-slate-500">Дата</span>
                  <input
                    type="date"
                    className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                    value={paidAt}
                    onChange={(e) => setPaidAt(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-xs font-medium text-slate-500">Комментарий</span>
                  <input
                    className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                  />
                </label>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleSave}
                  className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy ? 'Сохранение…' : 'Сохранить'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setAmount(String(payment.amount));
                    setPaidAt(payment.paid_at);
                    setComment(payment.comment ?? '');
                    setError(null);
                  }}
                  className="rounded-md px-3 py-2 text-sm font-medium text-slate-500"
                >
                  Отмена
                </button>
              </div>
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
