'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { CuttingBatch, Employee, OperationType, WorkRecord } from '@/lib/types';
import { formatDate, formatMoney } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function BatchPicker({
  batches,
  onPick,
  onClose,
}: {
  batches: CuttingBatch[];
  onPick: (b: CuttingBatch) => void;
  onClose: () => void;
}) {
  return (
    <div className="mt-2 rounded-md border border-slate-200 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium text-slate-700">Выберите партию</p>
        <button type="button" onClick={onClose} className="text-sm font-medium text-slate-500">
          Отмена
        </button>
      </div>
      {batches.length === 0 && <p className="text-xs text-slate-400">Партий пока нет</p>}
      <div className="space-y-1.5">
        {batches.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onPick(b)}
            className="block w-full rounded-md border border-slate-200 bg-white px-3 py-2.5 text-left text-sm"
          >
            <span className="font-medium text-slate-800">Партия №{b.batch_number}</span>
            <span className="text-slate-400">
              {' '}
              · {b.material_name} · {b.color}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PieceworkContent() {
  const [date, setDate] = useState(todayDate());
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [operationTypes, setOperationTypes] = useState<OperationType[]>([]);
  const [records, setRecords] = useState<WorkRecord[]>([]);
  const [recentBatches, setRecentBatches] = useState<CuttingBatch[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [formEmployeeId, setFormEmployeeId] = useState('');
  const [formOperationId, setFormOperationId] = useState('');
  const [formQuantity, setFormQuantity] = useState('');
  const [formBatch, setFormBatch] = useState<CuttingBatch | null>(null);
  const [batchPickerOpen, setBatchPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [newOperationName, setNewOperationName] = useState('');
  const [newOperationRate, setNewOperationRate] = useState('');
  const [addingOperation, setAddingOperation] = useState(false);
  const [rateDrafts, setRateDrafts] = useState<Record<string, string>>({});

  async function loadStatic() {
    const [{ data: emp }, { data: ops }, { data: batches }] = await Promise.all([
      supabase.from('employees').select('*').order('name'),
      supabase.from('operation_types').select('*').order('name'),
      supabase.from('cutting_batches_view').select('*').order('created_at', { ascending: false }).limit(30),
    ]);
    setEmployees((emp as unknown as Employee[]) ?? []);
    setOperationTypes((ops as unknown as OperationType[]) ?? []);
    setRecentBatches((batches as unknown as CuttingBatch[]) ?? []);
    const drafts: Record<string, string> = {};
    (ops ?? []).forEach((o) => {
      drafts[o.id] = String(o.rate_per_piece);
    });
    setRateDrafts(drafts);
  }

  async function loadRecords(forDate: string) {
    setLoading(true);
    const { data, error } = await supabase
      .from('work_records_view')
      .select('*')
      .eq('date', forDate)
      .order('created_at');
    if (error) setError(error.message);
    else setRecords((data as unknown as WorkRecord[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadStatic();
  }, []);

  useEffect(() => {
    loadRecords(date);
  }, [date]);

  function resetForm() {
    setFormEmployeeId('');
    setFormOperationId('');
    setFormQuantity('');
    setFormBatch(null);
    setBatchPickerOpen(false);
  }

  async function handleAddRecord() {
    setError(null);
    setSuccess(null);

    if (!formEmployeeId) {
      setError('Выберите сотрудника');
      return;
    }
    if (!formOperationId) {
      setError('Выберите операцию');
      return;
    }
    const qty = Number(formQuantity);
    if (!qty || qty <= 0) {
      setError('Укажите количество штук');
      return;
    }

    setSaving(true);
    const { error } = await supabase.from('work_records').insert({
      employee_id: formEmployeeId,
      operation_type_id: formOperationId,
      quantity: qty,
      date,
      batch_id: formBatch?.id ?? null,
    });
    setSaving(false);

    if (error) {
      setError(error.message);
      return;
    }

    resetForm();
    loadRecords(date);
  }

  async function handleAddOperation() {
    const name = newOperationName.trim();
    if (!name) return;
    setAddingOperation(true);
    setError(null);
    const { data, error } = await supabase
      .from('operation_types')
      .insert({ name, rate_per_piece: Number(newOperationRate) || 0 })
      .select()
      .single();
    setAddingOperation(false);
    if (error) {
      setError(error.message);
      return;
    }
    const op = data as unknown as OperationType;
    setOperationTypes((prev) => [...prev, op].sort((a, b) => a.name.localeCompare(b.name)));
    setRateDrafts((prev) => ({ ...prev, [op.id]: String(op.rate_per_piece) }));
    setNewOperationName('');
    setNewOperationRate('');
  }

  async function saveRate(opId: string) {
    const value = Number(rateDrafts[opId]);
    if (Number.isNaN(value) || value < 0) return;
    const { error } = await supabase.from('operation_types').update({ rate_per_piece: value }).eq('id', opId);
    if (error) {
      setError(error.message);
      return;
    }
    setOperationTypes((prev) => prev.map((o) => (o.id === opId ? { ...o, rate_per_piece: value } : o)));
  }

  const dailyTotals = Array.from(
    records.reduce((map, r) => {
      map.set(r.employee_name, (map.get(r.employee_name) ?? 0) + r.line_total);
      return map;
    }, new Map<string, number>())
  ).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Сделка</h1>
        <p className="mt-1 text-sm text-slate-500">Журнал сдельной работы цеха</p>
      </div>

      <label className="block max-w-xs">
        <span className="mb-1 block text-xs font-medium text-slate-500">Дата</span>
        <input
          type="date"
          className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {success && <p className="text-sm font-medium text-green-600">{success}</p>}

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Добавить запись</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Сотрудник</span>
            <select
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
              value={formEmployeeId}
              onChange={(e) => setFormEmployeeId(e.target.value)}
            >
              <option value="">Выберите…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Операция</span>
            <select
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
              value={formOperationId}
              onChange={(e) => setFormOperationId(e.target.value)}
            >
              <option value="">Выберите…</option>
              {operationTypes.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({formatMoney(o.rate_per_piece)}/шт)
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Количество штук</span>
            <input
              type="number"
              min={1}
              step="1"
              inputMode="numeric"
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
              value={formQuantity}
              onChange={(e) => setFormQuantity(e.target.value)}
            />
          </label>
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-500">Партия (необязательно)</span>
            {formBatch ? (
              <div className="flex items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 py-2.5">
                <span className="text-sm text-slate-800">Партия №{formBatch.batch_number}</span>
                <button
                  type="button"
                  onClick={() => setFormBatch(null)}
                  className="text-sm font-medium text-indigo-600"
                >
                  Убрать
                </button>
              </div>
            ) : batchPickerOpen ? (
              <BatchPicker
                batches={recentBatches}
                onPick={(b) => {
                  setFormBatch(b);
                  setBatchPickerOpen(false);
                }}
                onClose={() => setBatchPickerOpen(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setBatchPickerOpen(true)}
                className="rounded-md border border-dashed border-slate-300 px-3 py-2.5 text-sm font-medium text-slate-600"
              >
                Указать партию
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={handleAddRecord}
          disabled={saving}
          className="mt-4 w-full rounded-md bg-indigo-600 px-5 py-3.5 text-base font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto sm:py-2.5 sm:text-sm"
        >
          {saving ? 'Сохранение…' : 'Добавить запись'}
        </button>
      </div>

      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}

      {!loading && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Записи за {formatDate(`${date}T00:00:00`)}</h2>
          {records.length === 0 && <p className="text-sm text-slate-400">Записей пока нет</p>}
          <div className="space-y-2">
            {records.map((r) => (
              <div key={r.id} className="flex items-center justify-between border-b border-slate-100 pb-2 text-sm last:border-0 last:pb-0">
                <div>
                  <p className="font-medium text-slate-800">
                    {r.employee_name} <span className="text-slate-400">· {r.operation_name}</span>
                  </p>
                  <p className="text-xs text-slate-400">
                    {r.quantity} шт × {formatMoney(r.rate_per_piece)}
                    {r.batch_number != null ? ` · Партия №${r.batch_number}` : ''}
                  </p>
                </div>
                <span className="font-medium text-green-600">{formatMoney(r.line_total)}</span>
              </div>
            ))}
          </div>

          {dailyTotals.length > 0 && (
            <div className="mt-4 border-t border-slate-200 pt-3">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Итого за день</h3>
              <div className="space-y-1">
                {dailyTotals.map(([name, total]) => (
                  <div key={name} className="flex items-center justify-between text-sm">
                    <span className="text-slate-700">{name}</span>
                    <span className="font-medium text-slate-900">{formatMoney(total)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Типы операций и ставки</h2>
        <div className="space-y-2">
          {operationTypes.map((op) => (
            <div key={op.id} className="flex items-center justify-between gap-2">
              <span className="text-sm text-slate-800">{op.name}</span>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  inputMode="decimal"
                  className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  value={rateDrafts[op.id] ?? ''}
                  onChange={(e) => setRateDrafts((prev) => ({ ...prev, [op.id]: e.target.value }))}
                  onBlur={() => saveRate(op.id)}
                />
                <span className="text-xs text-slate-400">сум/шт</span>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex gap-2 border-t border-slate-200 pt-3">
          <input
            className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2.5 text-base"
            placeholder="Новый тип операции"
            value={newOperationName}
            onChange={(e) => setNewOperationName(e.target.value)}
          />
          <input
            type="number"
            min={0}
            step="0.1"
            inputMode="decimal"
            className="w-24 shrink-0 rounded-md border border-slate-300 px-3 py-2.5 text-base"
            placeholder="сум/шт"
            value={newOperationRate}
            onChange={(e) => setNewOperationRate(e.target.value)}
          />
          <button
            type="button"
            onClick={handleAddOperation}
            disabled={addingOperation || !newOperationName.trim()}
            className="shrink-0 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {addingOperation ? '…' : 'Добавить'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PiecworkPage() {
  return (
    <RequireRole roles={['master']}>
      <PieceworkContent />
    </RequireRole>
  );
}
