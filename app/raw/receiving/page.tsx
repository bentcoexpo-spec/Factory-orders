'use client';

import { useEffect, useRef, useState, FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { RawMaterialColor, RawMaterialReceipt } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

interface SelectedMaterial {
  id: string | null; // null — материал ещё не существует, будет создан при сохранении
  name: string;
}

function ReceivingForm() {
  const [materialQuery, setMaterialQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [materialResults, setMaterialResults] = useState<{ id: string; name: string }[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [material, setMaterial] = useState<SelectedMaterial | null>(null);
  const [existingColors, setExistingColors] = useState<RawMaterialColor[]>([]);

  const [color, setColor] = useState('');
  const [colorCode, setColorCode] = useState('');
  const [widthCm, setWidthCm] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [rolls, setRolls] = useState('');
  const [truckNumber, setTruckNumber] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [supplierName, setSupplierName] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [recent, setRecent] = useState<RawMaterialReceipt[]>([]);

  async function loadRecent() {
    const { data } = await supabase
      .from('raw_material_receipts_view')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);
    setRecent((data as unknown as RawMaterialReceipt[]) ?? []);
  }

  useEffect(() => {
    loadRecent();
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = materialQuery.trim();
    if (q.length < 2 || material) {
      setMaterialResults([]);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const { data, error } = await supabase
        .from('raw_materials')
        .select('id, name')
        .ilike('name', `%${q}%`)
        .order('name')
        .limit(20);
      if (!error) setMaterialResults((data as { id: string; name: string }[]) ?? []);
      setSearching(false);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [materialQuery, material]);

  async function selectMaterial(m: SelectedMaterial) {
    setMaterial(m);
    setMaterialQuery('');
    setMaterialResults([]);
    setColor('');
    setSuccess(null);
    if (m.id) {
      const { data } = await supabase
        .from('raw_material_colors_view')
        .select('*')
        .eq('material_id', m.id)
        .order('color');
      setExistingColors((data as unknown as RawMaterialColor[]) ?? []);
    } else {
      setExistingColors([]);
    }
  }

  function resetForm() {
    setMaterial(null);
    setExistingColors([]);
    setColor('');
    setColorCode('');
    setWidthCm('');
    setWeightKg('');
    setRolls('');
    setTruckNumber('');
    setInvoiceNumber('');
    setBatchNumber('');
    setSupplierName('');
  }

  async function ensureMaterialId(): Promise<string> {
    if (material?.id) return material.id;
    const name = material!.name.trim();
    const { data, error } = await supabase.from('raw_materials').insert({ name }).select('id').single();
    if (error) {
      if (error.code === '23505') {
        const { data: existing, error: findError } = await supabase
          .from('raw_materials')
          .select('id')
          .ilike('name', name)
          .single();
        if (findError) throw findError;
        return existing.id;
      }
      throw error;
    }
    return data.id;
  }

  async function ensureColorId(materialId: string): Promise<string> {
    const trimmed = color.trim();
    const inMemory = existingColors.find((c) => c.color.trim().toLowerCase() === trimmed.toLowerCase());
    if (inMemory) return inMemory.id;
    const { data, error } = await supabase
      .from('raw_material_colors')
      .insert({ material_id: materialId, color: trimmed })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        const { data: existing, error: findError } = await supabase
          .from('raw_material_colors')
          .select('id')
          .eq('material_id', materialId)
          .ilike('color', trimmed)
          .single();
        if (findError) throw findError;
        return existing.id;
      }
      throw error;
    }
    return data.id;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!material) {
      setError('Выберите или создайте тип материала');
      return;
    }
    if (!color.trim()) {
      setError('Укажите цвет');
      return;
    }
    const rollsNum = Number(rolls);
    if (!rollsNum || rollsNum <= 0) {
      setError('Укажите количество рулонов');
      return;
    }

    setSaving(true);
    try {
      const materialId = await ensureMaterialId();
      const colorId = await ensureColorId(materialId);

      const { error: receiptError } = await supabase.from('raw_material_receipts').insert({
        color_id: colorId,
        color_code: colorCode.trim() || null,
        width_cm: widthCm.trim() ? Number(widthCm) : null,
        weight_kg: weightKg.trim() ? Number(weightKg) : null,
        rolls: rollsNum,
        truck_number: truckNumber.trim() || null,
        supplier_invoice_number: invoiceNumber.trim() || null,
        supplier_batch_number: batchNumber.trim() || null,
        supplier_name: supplierName.trim() || null,
      });
      if (receiptError) throw receiptError;

      setSuccess(`Приход оформлен: +${rollsNum} рул. (${material.name}, ${color.trim()})`);
      resetForm();
      loadRecent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Приход сырья</h1>
        <p className="mt-1 text-sm text-slate-500">Поступление материала от поставщика</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Материал</h2>

          {material ? (
            <div className="flex items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 py-2.5">
              <p className="text-base font-medium text-slate-800">
                {material.name}
                {!material.id && <span className="ml-2 text-xs font-normal text-indigo-600">новый</span>}
              </p>
              <button
                type="button"
                onClick={resetForm}
                className="rounded-md px-2 py-1.5 text-sm font-medium text-indigo-600 active:bg-indigo-50"
              >
                Изменить
              </button>
            </div>
          ) : (
            <>
              <input
                className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                placeholder="Тип материала, например 30/1-PENYE-SUPREM 8% LYC"
                value={materialQuery}
                onChange={(e) => setMaterialQuery(e.target.value)}
              />

              {searching && <p className="mt-2 text-xs text-slate-400">Поиск…</p>}

              {materialResults.length > 0 && (
                <div className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
                  {materialResults.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => selectMaterial({ id: m.id, name: m.name })}
                      className="block w-full px-3 py-2.5 text-left text-sm hover:bg-slate-50 active:bg-slate-100"
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              )}

              {!searching && materialQuery.trim().length >= 2 && materialResults.length === 0 && (
                <button
                  type="button"
                  onClick={() => selectMaterial({ id: null, name: materialQuery.trim() })}
                  className="mt-2 w-full rounded-md border border-dashed border-indigo-300 px-3 py-2.5 text-sm font-medium text-indigo-600 active:bg-indigo-50"
                >
                  + Новый материал «{materialQuery.trim()}»
                </button>
              )}
            </>
          )}
        </div>

        {material && (
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">Цвет</h2>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Цвет *</span>
              <input
                className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                placeholder="например T/SINIY"
                value={color}
                onChange={(e) => setColor(e.target.value)}
              />
            </label>
            {existingColors.length > 0 && (
              <div className="mt-3">
                <p className="mb-1.5 text-xs font-medium text-slate-500">Уже есть у этого материала:</p>
                <div className="flex flex-wrap gap-2">
                  {existingColors.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setColor(c.color)}
                      className="rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600 active:bg-slate-100"
                    >
                      {c.color} · {c.stock_rolls} рул.
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {material && (
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">Детали поставки</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Код цвета</span>
                <input
                  className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                  placeholder="например 08-77"
                  value={colorCode}
                  onChange={(e) => setColorCode(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Ширина полотна, см</span>
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  inputMode="decimal"
                  className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                  value={widthCm}
                  onChange={(e) => setWidthCm(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Общий вес, кг</span>
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  inputMode="decimal"
                  className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                  value={weightKg}
                  onChange={(e) => setWeightKg(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Количество рулонов *</span>
                <input
                  type="number"
                  min={1}
                  step="1"
                  inputMode="numeric"
                  className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                  value={rolls}
                  onChange={(e) => setRolls(e.target.value)}
                />
              </label>
            </div>
          </div>
        )}

        {material && (
          <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="mb-1 text-sm font-semibold text-slate-700">Поставщик</h2>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Название поставщика</span>
              <input
                className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                placeholder="например AYA Global Tex"
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
              />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Номер авто</span>
                <input
                  className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                  value={truckNumber}
                  onChange={(e) => setTruckNumber(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Номер накладной</span>
                <input
                  className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Номер партии</span>
                <input
                  className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                  value={batchNumber}
                  onChange={(e) => setBatchNumber(e.target.value)}
                />
              </label>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
        {success && <p className="text-sm font-medium text-green-600">{success}</p>}

        {material && (
          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-md bg-indigo-600 px-5 py-3.5 text-base font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto sm:py-2.5 sm:text-sm"
          >
            {saving ? 'Сохранение…' : 'Оформить приход'}
          </button>
        )}
      </form>

      {recent.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Недавние приходы</h2>
          <div className="space-y-2">
            {recent.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between border-b border-slate-100 pb-2 text-sm last:border-0 last:pb-0"
              >
                <div>
                  <p className="font-medium text-slate-800">
                    {r.material_name}
                    <span className="text-slate-400"> · {r.color}</span>
                  </p>
                  <p className="text-xs text-slate-400">
                    {formatDate(r.created_at)}
                    {r.supplier_name ? ` · ${r.supplier_name}` : ''}
                  </p>
                </div>
                <span className="font-medium text-green-600">+{r.rolls} рул.</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function RawReceivingPage() {
  return (
    <RequireRole roles={['zakroyshik']}>
      <ReceivingForm />
    </RequireRole>
  );
}
