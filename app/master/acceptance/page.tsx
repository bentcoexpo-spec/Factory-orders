'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { CuttingBatch, CuttingBatchItemRow } from '@/lib/types';
import { formatDate } from '@/lib/format';
import { friendlyBatchStatusError } from '@/lib/errors';
import RequireRole from '@/components/RequireRole';

interface ProductGroup {
  id: string;
  product_name: string;
  items: CuttingBatchItemRow[];
}

function AcceptanceContent() {
  const [pending, setPending] = useState<CuttingBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedBatch, setSelectedBatch] = useState<CuttingBatch | null>(null);
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  async function loadPending() {
    setLoading(true);
    const { data, error } = await supabase
      .from('cutting_batches_view')
      .select('*')
      .eq('status', 'cut')
      .order('created_at', { ascending: false });
    if (error) setError(error.message);
    else setPending((data as unknown as CuttingBatch[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadPending();
  }, []);

  async function selectBatch(batch: CuttingBatch) {
    setSelectedBatch(batch);
    setSuccess(null);
    setError(null);
    setDetailLoading(true);

    const { data: products } = await supabase
      .from('cutting_batch_products')
      .select('id, product_name')
      .eq('batch_id', batch.id)
      .order('created_at');

    const productIds = (products ?? []).map((p) => p.id);
    const { data: items } = productIds.length
      ? await supabase.from('cutting_batch_items_view').select('*').in('batch_product_id', productIds)
      : { data: [] as CuttingBatchItemRow[] };

    const itemRows = (items as unknown as CuttingBatchItemRow[]) ?? [];
    const grouped: ProductGroup[] = (products ?? []).map((p) => ({
      id: p.id,
      product_name: p.product_name,
      items: itemRows.filter((it) => it.batch_product_id === p.id).sort((a, b) => a.size.localeCompare(b.size)),
    }));
    setGroups(grouped);

    const initialDraft: Record<string, string> = {};
    itemRows.forEach((it) => {
      initialDraft[it.id] = String(it.confirmed_quantity ?? it.quantity);
    });
    setDraft(initialDraft);
    setDetailLoading(false);
  }

  function backToPending() {
    setSelectedBatch(null);
    setGroups([]);
    setDraft({});
  }

  async function handleConfirm() {
    if (!selectedBatch) return;
    setError(null);
    setSuccess(null);

    const allItems = groups.flatMap((g) => g.items);
    for (const item of allItems) {
      const value = draft[item.id];
      if (value === undefined || value.trim() === '' || Number(value) < 0) {
        setError(`Укажите подтверждённое количество для размера «${item.size}»`);
        return;
      }
    }

    setSaving(true);
    try {
      for (const item of allItems) {
        const { error: itemError } = await supabase
          .from('cutting_batch_items_view')
          .update({ confirmed_quantity: Number(draft[item.id]) })
          .eq('id', item.id);
        if (itemError) throw new Error(itemError.message);
      }

      const { error: statusError } = await supabase
        .from('cutting_batches')
        .update({ status: 'in_sewing' })
        .eq('id', selectedBatch.id);
      if (statusError) throw new Error(friendlyBatchStatusError(statusError.message));

      setSuccess(`Партия №${selectedBatch.batch_number} принята в пошив`);
      backToPending();
      loadPending();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-slate-400">Загрузка…</p>;

  if (selectedBatch) {
    return (
      <div className="space-y-6">
        <button
          type="button"
          onClick={backToPending}
          className="flex items-center gap-1 text-sm font-medium text-indigo-600"
        >
          ← Все партии
        </button>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h1 className="text-lg font-semibold text-slate-900">
            Партия №{selectedBatch.batch_number}
            <span className="text-slate-400">
              {' '}
              · {selectedBatch.material_name} · {selectedBatch.color}
            </span>
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {selectedBatch.rolls_taken} рул. · взял: {selectedBatch.taken_by} · {formatDate(selectedBatch.created_at)}
          </p>
        </div>

        {detailLoading && <p className="text-sm text-slate-400">Загрузка…</p>}

        {!detailLoading &&
          groups.map((g) => (
            <div key={g.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <h2 className="mb-3 text-sm font-semibold text-slate-700">{g.product_name}</h2>
              <div className="space-y-2">
                {g.items.map((item) => (
                  <div key={item.id} className="flex items-center gap-3">
                    <span className="w-14 shrink-0 text-sm font-medium text-slate-700">{item.size}</span>
                    <span className="text-xs text-slate-400">Заявлено: {item.quantity}</span>
                    <input
                      type="number"
                      min={0}
                      step="1"
                      inputMode="numeric"
                      className="ml-auto w-24 rounded-md border border-slate-300 px-3 py-2 text-base"
                      value={draft[item.id] ?? ''}
                      onChange={(e) => setDraft((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="button"
          onClick={handleConfirm}
          disabled={saving || detailLoading}
          className="w-full rounded-md bg-indigo-600 px-5 py-3.5 text-base font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto sm:py-2.5 sm:text-sm"
        >
          {saving ? 'Сохранение…' : 'Подтвердить приёмку'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Приёмка кроя</h1>
        <p className="mt-1 text-sm text-slate-500">Партии, раскроенные закройщиком и ещё не принятые в цех</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {success && <p className="text-sm font-medium text-green-600">{success}</p>}

      {pending.length === 0 && <p className="text-sm text-slate-400">Нет партий, ожидающих приёмки</p>}

      <div className="space-y-2">
        {pending.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => selectBatch(b)}
            className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white p-4 text-left"
          >
            <div>
              <p className="font-medium text-slate-800">
                Партия №{b.batch_number}
                <span className="text-slate-400">
                  {' '}
                  · {b.material_name} · {b.color}
                </span>
              </p>
              <p className="text-xs text-slate-400">{formatDate(b.created_at)}</p>
            </div>
            <span className="text-sm font-medium text-slate-600">{b.total_quantity} дет.</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function MasterAcceptancePage() {
  return (
    <RequireRole roles={['master']}>
      <AcceptanceContent />
    </RequireRole>
  );
}
