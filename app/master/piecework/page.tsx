'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { CuttingBatch, Employee, WorkRecord } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { formatDateOnly, todayDate } from '@/lib/dates';
import { friendlyPieceworkError } from '@/lib/errors';
import RequireRole from '@/components/RequireRole';
import CatalogPicker from '@/components/CatalogPicker';
import { CatalogData, loadCatalog } from '@/lib/catalog';
import { Target, describeTarget, targetKey } from '@/lib/catalogTarget';
import Link from 'next/link';

interface EntryRow {
  key: number;
  target: Target | null;
  quantity: string;
  batch: CuttingBatch | null;
  batchPickerOpen: boolean;
}

let rowKeySeq = 1;
function emptyRow(): EntryRow {
  return { key: rowKeySeq++, target: null, quantity: '', batch: null, batchPickerOpen: false };
}

function recordTarget(r: WorkRecord): Target | null {
  if (r.catalog_operation_id) return { kind: 'op', id: r.catalog_operation_id };
  if (r.model_id) return { kind: 'whole', modelId: r.model_id };
  return null;
}

function targetPayload(t: Target) {
  return t.kind === 'op' ? { catalog_operation_id: t.id } : { model_id: t.modelId };
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 6);
}

function pluralRecords(n: number) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'запись';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'записи';
  return 'записей';
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
        <button type="button" onClick={onClose} className="btn-ghost-muted">
          Отмена
        </button>
      </div>
      {batches.length === 0 && <p className="text-xs text-slate-400">Партий пока нет</p>}
      <div className="max-h-56 space-y-1.5 overflow-y-auto">
        {batches.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onPick(b)}
            className="block min-h-[44px] w-full rounded-md border border-slate-200 bg-white px-3 py-2.5 text-left text-sm"
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

function BatchField({
  batch,
  pickerOpen,
  batches,
  onPick,
  onClear,
  onOpen,
  onClose,
}: {
  batch: CuttingBatch | null;
  pickerOpen: boolean;
  batches: CuttingBatch[];
  onPick: (b: CuttingBatch) => void;
  onClear: () => void;
  onOpen: () => void;
  onClose: () => void;
}) {
  if (batch) {
    return (
      <div className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-1.5 text-sm">
        <span className="text-slate-700">Партия №{batch.batch_number}</span>
        <button type="button" onClick={onClear} className="btn-ghost">
          Убрать
        </button>
      </div>
    );
  }
  if (pickerOpen) return <BatchPicker batches={batches} onPick={onPick} onClose={onClose} />;
  return (
    <button type="button" onClick={onOpen} className="btn-ghost -ml-3">
      + Партия (необязательно)
    </button>
  );
}

function PieceworkContent() {
  const [date, setDate] = useState(todayDate());
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [catalog, setCatalog] = useState<CatalogData>({ professions: [], models: [], operations: [] });
  const [records, setRecords] = useState<WorkRecord[]>([]);
  const [recentBatches, setRecentBatches] = useState<CuttingBatch[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [employeeId, setEmployeeId] = useState('');
  const [rows, setRows] = useState<EntryRow[]>(() => [emptyRow()]);
  const [invalidKeys, setInvalidKeys] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);

  const [editId, setEditId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<Target | null>(null);
  const [editQuantity, setEditQuantity] = useState('');
  const [editBatch, setEditBatch] = useState<CuttingBatch | null>(null);
  const [editBatchOpen, setEditBatchOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);


  async function loadStatic() {
    const [{ data: emp }, { data: batches }] = await Promise.all([
      supabase.from('employees').select('*').order('name'),
      supabase.from('cutting_batches_view').select('*').order('created_at', { ascending: false }).limit(30),
    ]);
    setEmployees((emp as unknown as Employee[]) ?? []);
    setRecentBatches((batches as unknown as CuttingBatch[]) ?? []);
    try {
      setCatalog(await loadCatalog());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить каталог');
    }
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

  const employee = employees.find((e) => e.id === employeeId);
  const employeeName = employee?.name ?? '';

  // Что у выбранного сотрудника уже записано за этот день (операция или целое изделие).
  const savedKeys = useMemo(
    () => new Set(records.filter((r) => r.employee_id === employeeId).map((r) => r.operation_key)),
    [records, employeeId]
  );

  function rowRate(row: EntryRow): number {
    return describeTarget(catalog, row.target)?.rate ?? 0;
  }
  function rowSum(row: EntryRow): number {
    const qty = Number(row.quantity);
    return qty > 0 ? qty * rowRate(row) : 0;
  }
  const entryTotal = rows.reduce((sum, r) => sum + rowSum(r), 0);

  // Предупреждение о возможном дубле: та же операция уже записана за день у
  // этого сотрудника или повторяется в самой форме. Не запрещает (утром и
  // вечером — допустимо), только напоминает.
  function duplicateNote(row: EntryRow): string | null {
    if (!row.target) return null;
    const key = targetKey(row.target);
    if (employeeId && savedKeys.has(key)) {
      return 'Эта операция у сотрудника за этот день уже записана — не вносите её дважды случайно.';
    }
    if (rows.filter((r) => r.target && targetKey(r.target) === key).length > 1) {
      return 'Эта операция уже есть в списке — убедитесь, что это не повтор.';
    }
    return null;
  }

  function updateRow(key: number, patch: Partial<EntryRow>) {
    setInvalidKeys((prev) => prev.filter((k) => k !== key));
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function removeRow(key: number) {
    setInvalidKeys((prev) => prev.filter((k) => k !== key));
    setRows((prev) => (prev.length <= 1 ? [emptyRow()] : prev.filter((r) => r.key !== key)));
  }

  async function handleSave() {
    setError(null);
    setSuccess(null);

    if (!employeeId) {
      setError('Выберите сотрудника');
      return;
    }
    const filled = rows.filter((r) => r.target || r.quantity);
    if (filled.length === 0) {
      setError('Добавьте хотя бы одну операцию');
      return;
    }
    const bad = filled.filter((r) => !r.target || !(Number(r.quantity) > 0));
    if (bad.length > 0) {
      setInvalidKeys(bad.map((r) => r.key));
      setError('В выделенных строках укажите и операцию, и количество');
      return;
    }

    const dupes = filled.filter((r) => r.target && savedKeys.has(targetKey(r.target)));
    if (dupes.length > 0) {
      const names = Array.from(new Set(dupes.map((r) => describeTarget(catalog, r.target)?.label ?? ''))).join(', ');
      if (!confirm(`У сотрудника «${employeeName}» за ${formatDateOnly(date)} уже есть: ${names}.\nСохранить ещё раз?`)) {
        return;
      }
    }

    setSaving(true);
    const { data, error: rpcError } = await supabase.rpc('create_work_records', {
      p_employee_id: employeeId,
      p_date: date,
      p_rows: filled.map((r) => ({
        ...targetPayload(r.target as Target),
        quantity: Number(r.quantity),
        batch_id: r.batch?.id ?? null,
      })),
    });
    setSaving(false);

    if (rpcError) {
      setError(friendlyPieceworkError(rpcError.message));
      return;
    }

    const saved = Number(data) || filled.length;
    setSuccess(
      `Сохранено: ${employeeName} — ${saved} ${pluralRecords(saved)}, ${formatMoney(
        filled.reduce((sum, r) => sum + rowSum(r), 0)
      )}`
    );
    // Форма очищается, дата остаётся — можно сразу вносить следующего сотрудника.
    setEmployeeId('');
    setRows([emptyRow()]);
    setInvalidKeys([]);
    loadRecords(date);
  }

  function startEdit(r: WorkRecord) {
    setError(null);
    setSuccess(null);
    setEditId(r.id);
    setEditTarget(recordTarget(r));
    setEditQuantity(String(r.quantity));
    setEditBatch(r.batch_id ? (recentBatches.find((b) => b.id === r.batch_id) ?? null) : null);
    setEditBatchOpen(false);
  }

  async function saveEdit(r: WorkRecord) {
    const qty = Number(editQuantity);
    if (!editTarget || !(qty > 0)) {
      setError('Укажите операцию и количество');
      return;
    }
    const orig = recordTarget(r);
    const targetChanged = !orig || targetKey(orig) !== targetKey(editTarget);
    const newInfo = describeTarget(catalog, editTarget);
    const newRate = targetChanged ? (newInfo?.rate ?? 0) : r.rate_per_piece;
    if (
      !confirm(
        `Изменить запись «${r.employee_name}»?\nБыло: ${r.operation_label}, ${r.quantity} шт × ${formatMoney(r.rate_per_piece)} = ${formatMoney(r.line_total)}\nСтанет: ${newInfo?.label ?? r.operation_label}, ${qty} шт × ${formatMoney(newRate)} = ${formatMoney(qty * newRate)}${targetChanged ? '\nСтавка берётся из каталога по новой операции.' : '\nСтавка записи остаётся прежней.'}`
      )
    ) {
      return;
    }
    setEditBusy(true);
    setError(null);
    const { error: updateError } = await supabase
      .from('work_records')
      .update({
        catalog_operation_id: editTarget.kind === 'op' ? editTarget.id : null,
        model_id: editTarget.kind === 'whole' ? editTarget.modelId : null,
        quantity: qty,
        batch_id: editBatch?.id ?? null,
      })
      .eq('id', r.id);
    setEditBusy(false);
    if (updateError) {
      setError(friendlyPieceworkError(updateError.message));
      return;
    }
    setEditId(null);
    loadRecords(date);
  }

  async function deleteRecord(r: WorkRecord) {
    if (
      !confirm(
        `Удалить запись?\n${r.employee_name}: ${r.operation_label}, ${r.quantity} шт × ${formatMoney(r.rate_per_piece)} = ${formatMoney(r.line_total)}`
      )
    ) {
      return;
    }
    setError(null);
    const { error: deleteError } = await supabase.from('work_records').delete().eq('id', r.id);
    if (deleteError) {
      setError(friendlyPieceworkError(deleteError.message));
      return;
    }
    if (editId === r.id) setEditId(null);
    loadRecords(date);
  }

  // Записи за день по сотрудникам: под именем — его операции, сумма и итог.
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; items: WorkRecord[]; total: number }>();
    records.forEach((r) => {
      const g = map.get(r.employee_id) ?? { name: r.employee_name, items: [], total: 0 };
      g.items.push(r);
      g.total += r.line_total;
      map.set(r.employee_id, g);
    });
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [records]);
  const grandTotal = groups.reduce((sum, g) => sum + g.total, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Сделка</h1>
        <p className="mt-1 text-sm text-slate-500">Журнал сдельной работы цеха</p>
      </div>

      {error && <p className="text-sm text-danger-600">{error}</p>}
      {success && <p className="text-sm font-medium text-success-600">{success}</p>}

      <div className="card space-y-4">
        <h2 className="text-sm font-semibold text-slate-700">Новая запись</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Дата</span>
            <input type="date" className="input" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Сотрудник</span>
            <select className="input" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Выберите…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="space-y-3">
          {rows.map((row, i) => {
            const note = duplicateNote(row);
            const rate = rowRate(row);
            const invalid = invalidKeys.includes(row.key);
            return (
              <div
                key={row.key}
                className={`rounded-lg border p-3 ${invalid ? 'border-danger-300 bg-danger-50' : 'border-slate-200 bg-slate-50'}`}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-500">Операция {i + 1}</span>
                  <button
                    type="button"
                    onClick={() => removeRow(row.key)}
                    aria-label={`Убрать операцию ${i + 1}`}
                    className="flex h-11 w-11 items-center justify-center rounded-md text-xl leading-none text-danger-600 active:bg-danger-50 sm:h-8 sm:w-8"
                  >
                    ×
                  </button>
                </div>
                <CatalogPicker
                  data={catalog}
                  value={row.target}
                  employeeProfessionId={employee?.profession_id ?? null}
                  invalid={invalid && !row.target}
                  onChange={(t) => updateRow(row.key, { target: t })}
                />
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <label className="flex items-center gap-2">
                    <span className="text-xs font-medium text-slate-500">Штук</span>
                    <input
                      inputMode="numeric"
                      autoComplete="off"
                      className="input w-24"
                      value={row.quantity}
                      onChange={(e) => updateRow(row.key, { quantity: digitsOnly(e.target.value) })}
                    />
                  </label>
                  <p className="ml-auto text-right text-sm">
                    {row.target ? (
                      <>
                        <span className="text-slate-500">× {formatMoney(rate)} = </span>
                        <span className="font-semibold text-slate-900">{formatMoney(rowSum(row))}</span>
                      </>
                    ) : (
                      <span className="text-slate-400">ставка и сумма — после выбора операции</span>
                    )}
                  </p>
                </div>
                {note && <p className="mt-2 rounded-md bg-warning-50 px-3 py-2 text-xs font-medium text-warning-700">{note}</p>}
                <div className="mt-1">
                  <BatchField
                    batch={row.batch}
                    pickerOpen={row.batchPickerOpen}
                    batches={recentBatches}
                    onPick={(b) => updateRow(row.key, { batch: b, batchPickerOpen: false })}
                    onClear={() => updateRow(row.key, { batch: null })}
                    onOpen={() => updateRow(row.key, { batchPickerOpen: true })}
                    onClose={() => updateRow(row.key, { batchPickerOpen: false })}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <button type="button" onClick={() => setRows((prev) => [...prev, emptyRow()])} className="btn-dashed-accent w-full sm:w-auto">
          + Ещё операция
        </button>

        <div className="flex items-center justify-between border-t border-slate-200 pt-3">
          <span className="text-sm font-semibold text-slate-700">
            Итого{employeeName ? `: ${employeeName}` : ' по сотруднику'}
          </span>
          <span className="text-lg font-semibold text-slate-900">{formatMoney(entryTotal)}</span>
        </div>

        <button type="button" onClick={handleSave} disabled={saving} className="btn-primary w-full sm:w-auto">
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>

      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}

      {!loading && (
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Записи за {formatDateOnly(date)}</h2>
          {groups.length === 0 && <p className="text-sm text-slate-400">Записей пока нет</p>}
          <div className="space-y-5">
            {groups.map((g) => (
              <div key={g.name}>
                <div className="mb-1 flex items-baseline justify-between gap-2 border-b border-slate-200 pb-1">
                  <p className="font-semibold text-slate-900">{g.name}</p>
                  <p className="text-sm font-semibold text-success-700">{formatMoney(g.total)}</p>
                </div>
                <div className="divide-y divide-slate-100">
                  {g.items.map((r) => (
                    <div key={r.id} className="py-2.5">
                      <div className="flex items-start justify-between gap-3 text-sm">
                        <div className="min-w-0">
                          <p className="font-medium text-slate-800">{r.operation_label}</p>
                          <p className="text-xs text-slate-500">
                            {r.quantity} шт × {formatMoney(r.rate_per_piece)}
                            {r.batch_number != null ? ` · Партия №${r.batch_number}` : ''}
                          </p>
                        </div>
                        <span className="num shrink-0 font-medium text-slate-900">{formatMoney(r.line_total)}</span>
                      </div>
                      {editId !== r.id && (
                        <div className="mt-1 flex gap-2">
                          <button type="button" onClick={() => startEdit(r)} className="btn-tonal">
                            Изменить
                          </button>
                          <button type="button" onClick={() => deleteRecord(r)} className="btn-tonal-danger">
                            Удалить
                          </button>
                        </div>
                      )}
                      {editId === r.id && (
                        <div className="mt-2 space-y-2 rounded-md bg-slate-50 p-3">
                          <CatalogPicker
                            data={catalog}
                            value={editTarget}
                            employeeProfessionId={employees.find((e) => e.id === r.employee_id)?.profession_id ?? null}
                            onChange={setEditTarget}
                          />
                          <label className="flex items-center gap-2">
                            <span className="text-xs font-medium text-slate-500">Штук</span>
                            <input
                              inputMode="numeric"
                              autoComplete="off"
                              className="input w-24"
                              value={editQuantity}
                              onChange={(e) => setEditQuantity(digitsOnly(e.target.value))}
                            />
                          </label>
                          <BatchField
                            batch={editBatch}
                            pickerOpen={editBatchOpen}
                            batches={recentBatches}
                            onPick={(b) => {
                              setEditBatch(b);
                              setEditBatchOpen(false);
                            }}
                            onClear={() => setEditBatch(null)}
                            onOpen={() => setEditBatchOpen(true)}
                            onClose={() => setEditBatchOpen(false)}
                          />
                          <div className="flex gap-2">
                            <button type="button" disabled={editBusy} onClick={() => saveEdit(r)} className="btn-primary btn-sm">
                              {editBusy ? 'Сохранение…' : 'Сохранить'}
                            </button>
                            <button type="button" onClick={() => setEditId(null)} className="btn-ghost-muted">
                              Отмена
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {groups.length > 0 && (
            <div className="mt-4 flex items-baseline justify-between gap-2 border-t border-slate-300 pt-3">
              <span className="text-sm font-semibold text-slate-700">Итого по цеху за день</span>
              <span className="text-lg font-semibold text-slate-900">{formatMoney(grandTotal)}</span>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2 className="mb-1 text-sm font-semibold text-slate-700">Ставки и операции</h2>
        <p className="mb-3 text-xs text-slate-500">
          Модели, операции и ставки ведутся в каталоге. Ставка фиксируется в записи в момент сохранения: если её потом
          поменять, старые записи не пересчитываются.
        </p>
        <Link href="/master/catalog" className="btn-tonal inline-flex">
          Открыть каталог
        </Link>
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
