'use client';

import { FormEvent, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Client } from '@/lib/types';
import { todayDate } from '@/lib/dates';
import { uploadReceiptPhotos } from '@/lib/receiptPhotos';
import ClientPicker from '@/components/ClientPicker';
import { PhotoPicker } from '@/components/ReceiptPhotos';

// Форма «Внести оплату» — одна и для вкладки «Оплаты» (клиента выбирают),
// и для карточки клиента в «Долгах» (клиент уже известен).
export default function PaymentForm({
  fixedClient,
  onSaved,
}: {
  fixedClient?: { id: string; name: string };
  onSaved: () => void;
}) {
  const [client, setClient] = useState<Client | null>(null);
  const [amount, setAmount] = useState('');
  const [paidAt, setPaidAt] = useState(todayDate());
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setWarning(null);
    const clientId = fixedClient?.id ?? client?.id;
    if (!clientId) {
      setError('Выберите клиента');
      return;
    }
    const value = Number(amount);
    if (!value || value <= 0) {
      setError('Укажите сумму оплаты больше нуля');
      return;
    }
    if (!paidAt) {
      setError('Укажите дату оплаты');
      return;
    }

    setSaving(true);
    const { data, error: insertError } = await supabase
      .from('client_payments_view')
      .insert({ client_id: clientId, amount: value, comment: comment.trim() || null, paid_at: paidAt })
      .select('id')
      .single();
    if (insertError || !data) {
      setSaving(false);
      setError(insertError?.message ?? 'Не удалось сохранить оплату');
      return;
    }

    if (files.length > 0) {
      const photoError = await uploadReceiptPhotos('payment', (data as { id: string }).id, files);
      if (photoError) {
        setWarning(`Оплата сохранена, но фото загрузились не все: ${photoError}. Добавьте их в карточке оплаты.`);
      }
    }
    setSaving(false);

    setAmount('');
    setComment('');
    setFiles([]);
    setPaidAt(todayDate());
    setClient(null);
    onSaved();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-700">Внести оплату</h2>

      {!fixedClient && (
        <div>
          <span className="mb-1 block text-xs font-medium text-slate-500">Клиент *</span>
          <ClientPicker value={client} onChange={setClient} />
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">Сумма, сум *</span>
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
          <span className="mb-1 block text-xs font-medium text-slate-500">Дата оплаты *</span>
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
            placeholder="наличные, перевод…"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </label>
      </div>

      <PhotoPicker files={files} onChange={setFiles} />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {warning && <p className="text-sm text-amber-700">{warning}</p>}

      <button
        type="submit"
        disabled={saving}
        className="w-full rounded-md bg-indigo-600 px-4 py-3 text-sm font-medium text-white disabled:opacity-50 sm:w-auto sm:py-2.5"
      >
        {saving ? 'Сохранение…' : 'Внести оплату'}
      </button>
    </form>
  );
}
