'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { CuttingBatch, RawMaterialIssue } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

interface SizeRow {
  size: string;
  quantity: string;
}

interface DraftProduct {
  name: string;
  rows: { size: string; quantity: number }[];
}

function emptyRows(): SizeRow[] {
  return [{ size: '', quantity: '' }];
}

function BatchForm() {
  const [pending, setPending] = useState<RawMaterialIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedIssue, setSelectedIssue] = useState<RawMaterialIssue | null>(null);
  const [products, setProducts] = useState<DraftProduct[]>([]);

  const [productName, setProductName] = useState('');
  const [rows, setRows] = useState<SizeRow[]>(emptyRows());
  const [productNameSuggestions, setProductNameSuggestions] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [recent, setRecent] = useState<CuttingBatch[]>([]);

  async function loadPending() {
    setLoading(true);
    const { data, error } = await supabase
      .from('raw_material_issues_pending_view')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) setLoadError(error.message);
    else setPending((data as unknown as RawMaterialIssue[]) ?? []);
    setLoading(false);
  }

  async function loadRecent() {
    const { data } = await supabase
      .from('cutting_batches_view')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);
    setRecent((data as unknown as CuttingBatch[]) ?? []);
  }

  async function loadProductNameSuggestions() {
    const { data } = await supabase.from('cutting_batch_products').select('product_name');
    const names = Array.from(new Set((data ?? []).map((r) => r.product_name as string)));
    setProductNameSuggestions(names.sort((a, b) => a.localeCompare(b)));
  }

  useEffect(() => {
    loadPending();
    loadRecent();
    loadProductNameSuggestions();
  }, []);

  function selectIssue(issue: RawMaterialIssue) {
    setSelectedIssue(issue);
    setProducts([]);
    setProductName('');
    setRows(emptyRows());
    setSuccess(null);
    setError(null);
  }

  function backToPending() {
    setSelectedIssue(null);
    setProducts([]);
    setProductName('');
    setRows(emptyRows());
  }

  function updateRow(index: number, patch: Partial<SizeRow>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, { size: '', quantity: '' }]);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function addProductToBatch() {
    setError(null);

    const name = productName.trim();
    if (!name) {
      setError('Укажите название товара');
      return;
    }
    if (products.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      setError('Такой товар уже добавлен в эту партию — дополните его размеры ниже');
      return;
    }

    const filled = rows
      .map((r) => ({ size: r.size.trim(), quantity: Number(r.quantity) }))
      .filter((r) => r.size && r.quantity > 0);

    if (filled.length === 0) {
      setError('Укажите хотя бы один размер и количество');
      return;
    }

    const sizesLower = filled.map((r) => r.size.toLowerCase());
    if (new Set(sizesLower).size !== sizesLower.length) {
      setError('Один размер указан дважды');
      return;
    }

    setProducts((prev) => [...prev, { name, rows: filled }]);
    setProductName('');
    setRows(emptyRows());
  }

  function removeProduct(index: number) {
    setProducts((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSaveBatch() {
    setError(null);
    setSuccess(null);

    if (!selectedIssue) return;
    if (products.length === 0) {
      setError('Добавьте хотя бы один товар в партию');
      return;
    }

    setSaving(true);
    try {
      const { data: batch, error: batchError } = await supabase
        .from('cutting_batches')
        .insert({ issue_id: selectedIssue.id })
        .select('id, batch_number')
        .single();
      if (batchError || !batch) throw new Error(batchError?.message ?? 'Не удалось создать партию');

      let totalQuantity = 0;
      for (const p of products) {
        const { data: productRow, error: productError } = await supabase
          .from('cutting_batch_products')
          .insert({ batch_id: batch.id, product_name: p.name })
          .select('id')
          .single();
        if (productError || !productRow) throw new Error(productError?.message ?? 'Не удалось сохранить товар');

        const { error: itemsError } = await supabase
          .from('cutting_batch_items')
          .insert(p.rows.map((r) => ({ batch_product_id: productRow.id, size: r.size, quantity: r.quantity })));
        if (itemsError) throw new Error(itemsError.message);

        totalQuantity += p.rows.reduce((sum, r) => sum + r.quantity, 0);
      }

      setSuccess(`Партия №${batch.batch_number} создана: ${products.length} тов., ${totalQuantity} дет.`);
      backToPending();
      loadPending();
      loadRecent();
      loadProductNameSuggestions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-slate-400">Загрузка…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Партия</h1>
        <p className="mt-1 text-sm text-slate-500">Отчёт о результате раскроя</p>
      </div>

      {loadError && !selectedIssue && <p className="text-sm text-red-600">{loadError}</p>}
      {success && <p className="text-sm font-medium text-green-600">{success}</p>}

      {!selectedIssue && (
        <div className="space-y-2">
          {pending.length === 0 && (
            <p className="text-sm text-slate-400">
              Нет выдач, ожидающих отчёта — всё, что взято через «Взять для цеха», уже раскроено.
            </p>
          )}
          {pending.map((issue) => (
            <button
              key={issue.id}
              type="button"
              onClick={() => selectIssue(issue)}
              className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white p-4 text-left"
            >
              <div>
                <p className="font-medium text-slate-800">
                  {issue.material_name}
                  <span className="text-slate-400"> · {issue.color}</span>
                </p>
                <p className="text-xs text-slate-400">
                  {formatDate(issue.created_at)} · взял: {issue.taken_by}
                </p>
              </div>
              <span className="text-sm font-medium text-slate-600">{issue.rolls} рул.</span>
            </button>
          ))}
        </div>
      )}

      {selectedIssue && (
        <div className="space-y-6">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-base font-medium text-slate-800">
                  {selectedIssue.material_name}
                  <span className="text-slate-400"> · {selectedIssue.color}</span>
                </p>
                <p className="text-sm text-slate-500">
                  {selectedIssue.rolls} рул. · взял: {selectedIssue.taken_by}
                </p>
              </div>
              <button
                type="button"
                onClick={backToPending}
                className="rounded-md px-2 py-1.5 text-sm font-medium text-indigo-600 active:bg-indigo-50"
              >
                Назад
              </button>
            </div>
          </div>

          {products.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-slate-700">Товары в этой партии</h2>
              {products.map((p, i) => (
                <div key={i} className="flex items-start justify-between rounded-lg border border-slate-200 bg-white p-4">
                  <div>
                    <p className="font-medium text-slate-800">{p.name}</p>
                    <p className="text-xs text-slate-400">{p.rows.map((r) => `${r.size} ${r.quantity}`).join(', ')}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeProduct(i)}
                    className="shrink-0 rounded-md px-2 py-1.5 text-sm font-medium text-red-500 active:bg-red-50"
                  >
                    Убрать
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">
              {products.length > 0 ? 'Добавить ещё товар' : 'Какой товар вышел из этого раскроя?'}
            </h2>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Название товара</span>
              <input
                list="product-name-suggestions"
                className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                placeholder="например Футболка"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
              />
              <datalist id="product-name-suggestions">
                {productNameSuggestions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>

            <div className="mt-3 space-y-2">
              {rows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2.5 text-base"
                    placeholder="Размер, например M"
                    value={row.size}
                    onChange={(e) => updateRow(i, { size: e.target.value })}
                  />
                  <input
                    type="number"
                    min={1}
                    step="1"
                    inputMode="numeric"
                    className="w-24 shrink-0 rounded-md border border-slate-300 px-3 py-2.5 text-base"
                    placeholder="Кол-во"
                    value={row.quantity}
                    onChange={(e) => updateRow(i, { quantity: e.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    disabled={rows.length === 1}
                    className="shrink-0 rounded-md px-2 py-2.5 text-sm font-medium text-red-500 disabled:opacity-30"
                    aria-label="Убрать строку"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={addRow}
                className="rounded-md border border-dashed border-slate-300 px-3 py-2.5 text-sm font-medium text-slate-600 active:bg-slate-50"
              >
                + Добавить размер
              </button>
              <button
                type="button"
                onClick={addProductToBatch}
                className="rounded-md border border-dashed border-indigo-300 px-3 py-2.5 text-sm font-medium text-indigo-600 active:bg-indigo-50"
              >
                + Добавить товар в партию
              </button>
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          {products.length > 0 && (
            <button
              type="button"
              onClick={handleSaveBatch}
              disabled={saving}
              className="w-full rounded-md bg-indigo-600 px-5 py-3.5 text-base font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto sm:py-2.5 sm:text-sm"
            >
              {saving ? 'Сохранение…' : 'Сохранить партию'}
            </button>
          )}
        </div>
      )}

      {recent.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Недавние партии</h2>
          <div className="space-y-3">
            {recent.map((b) => (
              <div key={b.id} className="border-b border-slate-100 pb-3 text-sm last:border-0 last:pb-0">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-slate-800">
                    Партия №{b.batch_number}
                    <span className="text-slate-400">
                      {' '}
                      · {b.material_name} · {b.color}
                    </span>
                  </p>
                  <span className="font-medium text-slate-600">{b.total_quantity} дет.</span>
                </div>
                <p className="text-xs text-slate-400">{formatDate(b.created_at)}</p>
                <div className="mt-1 space-y-0.5">
                  {b.products.map((p, i) => (
                    <p key={i} className="text-xs text-slate-500">
                      {p.product_name}: {p.sizes.map((s) => `${s.size} ${s.quantity}`).join(', ')}
                    </p>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function RawBatchPage() {
  return (
    <RequireRole roles={['zakroyshik']}>
      <BatchForm />
    </RequireRole>
  );
}
