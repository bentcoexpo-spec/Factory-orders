'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { RawMaterialColor, RawMaterialReceipt } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

function IconChevronLeft() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
      <path d="M12.5 4.5 7 10l5.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ReceiptCard({ r }: { r: RawMaterialReceipt }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-slate-800">
          {formatDate(r.created_at)}
          {r.color_code && <span className="text-slate-400"> · код {r.color_code}</span>}
        </p>
        <span className="font-semibold text-green-600">+{r.rolls} рул.</span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-500">
        {r.weight_kg != null && (
          <div>
            <dt className="inline text-slate-400">Вес: </dt>
            <dd className="inline">{r.weight_kg} кг</dd>
          </div>
        )}
        {r.width_cm != null && (
          <div>
            <dt className="inline text-slate-400">Ширина: </dt>
            <dd className="inline">{r.width_cm} см</dd>
          </div>
        )}
        {r.supplier_name && (
          <div>
            <dt className="inline text-slate-400">Поставщик: </dt>
            <dd className="inline">{r.supplier_name}</dd>
          </div>
        )}
        {r.truck_number && (
          <div>
            <dt className="inline text-slate-400">Авто: </dt>
            <dd className="inline">{r.truck_number}</dd>
          </div>
        )}
        {r.supplier_invoice_number && (
          <div>
            <dt className="inline text-slate-400">Накладная: </dt>
            <dd className="inline">{r.supplier_invoice_number}</dd>
          </div>
        )}
        {r.supplier_batch_number && (
          <div>
            <dt className="inline text-slate-400">Партия: </dt>
            <dd className="inline">{r.supplier_batch_number}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function RawStockContent() {
  const [colors, setColors] = useState<RawMaterialColor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedMaterial, setSelectedMaterial] = useState<string | null>(null);
  const [selectedColor, setSelectedColor] = useState<RawMaterialColor | null>(null);
  const [receipts, setReceipts] = useState<RawMaterialReceipt[]>([]);
  const [receiptsLoading, setReceiptsLoading] = useState(false);

  async function loadColors() {
    setLoading(true);
    const { data, error } = await supabase
      .from('raw_material_colors_view')
      .select('*')
      .order('material_name')
      .order('color');
    if (error) setError(error.message);
    else setColors((data as unknown as RawMaterialColor[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadColors();
  }, []);

  useEffect(() => {
    if (!selectedColor) {
      setReceipts([]);
      return;
    }
    setReceiptsLoading(true);
    supabase
      .from('raw_material_receipts_view')
      .select('*')
      .eq('color_id', selectedColor.id)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!error) setReceipts((data as unknown as RawMaterialReceipt[]) ?? []);
        setReceiptsLoading(false);
      });
  }, [selectedColor]);

  const groupedMaterials = Array.from(
    colors.reduce((map, c) => {
      const list = map.get(c.material_name) ?? [];
      list.push(c);
      map.set(c.material_name, list);
      return map;
    }, new Map<string, RawMaterialColor[]>())
  ).sort(([a], [b]) => a.localeCompare(b));

  const materialColors = selectedMaterial ? colors.filter((c) => c.material_name === selectedMaterial) : [];

  if (loading) return <p className="text-sm text-slate-400">Загрузка…</p>;

  // Уровень 3: приходы конкретного цвета
  if (selectedColor) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setSelectedColor(null)}
          className="flex items-center gap-1 text-sm font-medium text-indigo-600"
        >
          <IconChevronLeft />
          {selectedMaterial}
        </button>
        <div>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{selectedColor.color}</h1>
          <p className="mt-1 text-sm text-slate-500">Остаток: {selectedColor.stock_rolls} рул.</p>
        </div>
        {receiptsLoading && <p className="text-sm text-slate-400">Загрузка…</p>}
        {!receiptsLoading && receipts.length === 0 && (
          <p className="text-sm text-slate-400">Поступлений пока не было</p>
        )}
        <div className="space-y-3">
          {receipts.map((r) => (
            <ReceiptCard key={r.id} r={r} />
          ))}
        </div>
      </div>
    );
  }

  // Уровень 2: цвета выбранного материала
  if (selectedMaterial) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setSelectedMaterial(null)}
          className="flex items-center gap-1 text-sm font-medium text-indigo-600"
        >
          <IconChevronLeft />
          Все материалы
        </button>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{selectedMaterial}</h1>
        {materialColors.length === 0 && <p className="text-sm text-slate-400">Цветов пока нет</p>}
        <div className="space-y-2">
          {materialColors.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelectedColor(c)}
              className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white p-4 text-left"
            >
              <span className="font-medium text-slate-800">{c.color}</span>
              <span
                className={`text-sm font-medium ${c.stock_rolls <= 0 ? 'text-red-600' : 'text-slate-600'}`}
              >
                {c.stock_rolls} рул.
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Уровень 1: список материалов
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Склад сырья</h1>
        <p className="mt-1 text-sm text-slate-500">Остатки материалов по цветам</p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {groupedMaterials.length === 0 && <p className="text-sm text-slate-400">Материалов пока нет</p>}
      <div className="space-y-2">
        {groupedMaterials.map(([name, list]) => {
          const total = list.reduce((sum, c) => sum + c.stock_rolls, 0);
          return (
            <button
              key={name}
              type="button"
              onClick={() => setSelectedMaterial(name)}
              className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white p-4 text-left"
            >
              <div>
                <p className="font-medium text-slate-800">{name}</p>
                <p className="text-xs text-slate-400">
                  {list.length} {list.length === 1 ? 'цвет' : 'цветов'}
                </p>
              </div>
              <span className="text-sm font-medium text-slate-600">{total} рул.</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function RawStockPage() {
  return (
    <RequireRole roles={['zakroyshik']}>
      <RawStockContent />
    </RequireRole>
  );
}
