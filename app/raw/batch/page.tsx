'use client';

import { useEffect, useState, FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { CuttingBatch, RawMaterialIssue } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

interface SizeRow {
  size: string;
  quantity: string;
}

function emptyRows(): SizeRow[] {
  return [{ size: '', quantity: '' }];
}

function BatchForm() {
  const [pending, setPending] = useState<RawMaterialIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<RawMaterialIssue | null>(null);
  const [rows, setRows] = useState<SizeRow[]>(emptyRows());
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const [recent, setRecent] = useState<CuttingBatch[]>([]);

  async function loadPending() {
    setLoading(true);
    const { data, error } = await supabase
      .from('raw_material_issues_pending_view')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) setError(error.message);
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

  useEffect(() => {
    loadPending();
    loadRecent();
  }, []);

  function selectIssue(issue: RawMaterialIssue) {
    setSelected(issue);
    setRows(emptyRows());
    setSuccess(null);
    setError(null);
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!selected) {
      setError('Выберите выдачу материала');
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

    setSaving(true);
    const { data: batch, error: batchError } = await supabase
      .from('cutting_batches')
      .insert({ issue_id: selected.id })
      .select('id, batch_number')
      .single();

    if (batchError || !batch) {
      setSaving(false);
      setError(batchError?.message ?? 'Не удалось создать партию');
      return;
    }

    const { error: itemsError } = await supabase
      .from('cutting_batch_items')
      .insert(filled.map((r) => ({ batch_id: batch.id, size: r.size, quantity: r.quantity })));

    setSaving(false);

    if (itemsError) {
      setError(itemsError.message);
      return;
    }

    const total = filled.reduce((sum, r) => sum + r.quantity, 0);
    setSuccess(`Партия №${batch.batch_number} создана: ${total} дет.`);
    setSelected(null);
    setRows(emptyRows());
    loadPending();
    loadRecent();
  }

  if (loading) return <p className="text-sm text-slate-400">Загрузка…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Партия</h1>
        <p className="mt-1 text-sm text-slate-500">Отчёт о результате раскроя</p>
      </div>

      {error && !selected && <p className="text-sm text-red-600">{error}</p>}
      {success && <p className="text-sm font-medium text-green-600">{success}</p>}

      {!selected && (
        <div className="space-y-2">
          {pending.length === 0 && (
            <p className="text-sm text-slate-400">
              Нет выдач, ожидающих отчёта — все, что взято через «Взять для цеха», уже раскроено.
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

      {selected && (
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-base font-medium text-slate-800">
                  {selected.material_name}
                  <span className="text-slate-400"> · {selected.color}</span>
                </p>
                <p className="text-sm text-slate-500">
                  {selected.rolls} рул. · взял: {selected.taken_by}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-md px-2 py-1.5 text-sm font-medium text-indigo-600 active:bg-indigo-50"
              >
                Назад
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">Результат по размерам</h2>
            <div className="space-y-2">
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
            <button
              type="button"
              onClick={addRow}
              className="mt-3 rounded-md border border-dashed border-indigo-300 px-3 py-2.5 text-sm font-medium text-indigo-600 active:bg-indigo-50"
            >
              + Добавить размер
            </button>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-md bg-indigo-600 px-5 py-3.5 text-base font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto sm:py-2.5 sm:text-sm"
          >
            {saving ? 'Сохранение…' : 'Сохранить партию'}
          </button>
        </form>
      )}

      {recent.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Недавние партии</h2>
          <div className="space-y-2">
            {recent.map((b) => (
              <div key={b.id} className="border-b border-slate-100 pb-2 text-sm last:border-0 last:pb-0">
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
                <p className="text-xs text-slate-400">
                  {formatDate(b.created_at)} ·{' '}
                  {b.sizes.map((s) => `${s.size} ${s.quantity}`).join(', ')}
                </p>
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
